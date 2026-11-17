// Главный процесс Electron: поднимает тот же сервер, что `npm run ui` (src/server.ts), на 127.0.0.1 и открывает окно
// на http://localhost:<порт>/. Не file://: server-guard.ts пускает только Host localhost/127.0.0.1 и Origin того же адреса.
// UI — сборка dist/web, общение с сервером только по HTTP и SSE; Node в окне нет (contextIsolation, sandbox).
// Три способа запуска: `npm run desktop:dev` (голый Electron из терминала), ярлык checkout'а из `npm run desktop:install`
// (тот же код и данные, но свой AgentGraph.app в Dock и запуск из Finder) и упакованное приложение (`desktop:build`).
import { app, BrowserWindow, dialog, Menu, Notification, shell, type MenuItemConstructorOptions } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { linkedElectronDrift } from '../desktop-link.js';
import { osNotify, type Notice } from '../notify.js';
import { askQuit, type UnsentTeam } from '../quit-dialog.js';

const HOST = '127.0.0.1';
/** Ярлык checkout'а (scripts/desktop-install.mts): приложение не упаковано, но и не `electron .` — код лежит в Resources/app. */
const linked = !app.isPackaged && !process.defaultApp;
/** Событие окна «открой экран» (web/src/components/shell/notifications.ts, NAVIGATE_EVENT). */
const NAVIGATE_EVENT = 'agentgraph:navigate';

/** Запомненное между запусками: порт (localStorage UI привязан к origin, с портом) и папка данных. */
type DesktopState = { port?: number; home?: string };
const stateFile = () => path.join(app.getPath('userData'), 'desktop.json');

function readState(): DesktopState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as DesktopState;
  } catch {
    return {};
  }
}

function writeState(patch: DesktopState): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }, null, 2));
}

/**
 * Окружение login-shell. Приложение из Finder получает урезанный PATH (/usr/bin:/bin:…), а агентам и интеграциям нужны
 * git, gh, glab, node из Homebrew и переменные вроде AGENTGRAPH_HOME из ~/.zshrc. Не вышло — остаётся как есть.
 */
function importShellEnv(): void {
  const shellPath = process.env.SHELL || '/bin/zsh';
  const mark = '__AGENTGRAPH_ENV__';
  const r = spawnSync(shellPath, ['-ilc', `printf '${mark}'; env -0`], { encoding: 'utf8', timeout: 5000 });
  const out = r.stdout?.split(mark)[1];
  if (r.status !== 0 || !out) return;
  // заданное при запуске (open --env, launchctl setenv) не перетираем; PATH — всегда из shell
  for (const line of out.split('\0')) {
    const i = line.indexOf('=');
    const key = line.slice(0, i);
    if (i > 0 && (key === 'PATH' || process.env[key] === undefined)) process.env[key] = line.slice(i + 1);
  }
}

/**
 * Agent SDK запускает CLI Claude Code — бинарник из пакета под платформу — и ищет его рядом с собой, то есть внутри
 * app.asar, откуда запустить процесс нельзя (spawn ENOTDIR). electron-builder.yml кладёт пакет в app.asar.unpacked,
 * путь туда SDK получает через AGENTGRAPH_CLAUDE_EXECUTABLE (claudeExecutable в src/agent.ts).
 */
function unpackedClaude(): void {
  if (process.env.AGENTGRAPH_CLAUDE_EXECUTABLE) return;
  let bin: string;
  try {
    bin = createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  } catch {
    return; // пакета под платформу нет: SDK сам скажет, чего не хватает
  }
  const unpacked = bin.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (unpacked !== bin) process.env.AGENTGRAPH_CLAUDE_EXECUTABLE = unpacked;
}

/** Папка с flows/ и runs/ (AGENTGRAPH_HOME). В dev — корень репозитория, как у `npm run ui`; упакованному нужна снаружи asar. */
async function dataHome(): Promise<string | undefined> {
  if (!app.isPackaged || process.env.AGENTGRAPH_HOME) return process.env.AGENTGRAPH_HOME;
  const saved = readState().home;
  if (saved && fs.existsSync(saved)) return saved;
  const dir = (await chooseHome()) ?? path.join(app.getPath('userData'), 'data');
  writeState({ home: dir });
  return dir;
}

/** Диалог выбора папки данных; отмена — undefined. Выбор запоминается. */
async function chooseHome(): Promise<string | undefined> {
  const r = await dialog.showOpenDialog({
    title: 'Папка AgentGraph',
    message: 'Папка с flows/ и runs/ — например, checkout agentgraph. Отмена — пустая папка внутри приложения.',
    // без проверки existsSync: заглянуть в ~/Documents самому — запрос доступа macOS, панели выбора он не нужен
    defaultPath: app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  const dir = r.canceled ? undefined : r.filePaths[0];
  if (dir) writeState({ home: dir });
  return dir;
}

/** Порт свободен на HOST. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, HOST, () => s.close(() => resolve(true)));
  });
}

/** Свободный порт от системы. */
function anyPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, HOST, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** Прошлый порт, если свободен (настройки UI в localStorage остаются), иначе новый; не 4747 — тот у `npm run ui`. */
async function pickPort(): Promise<number> {
  const saved = readState().port;
  if (saved && (await portFree(saved))) return saved;
  const port = await anyPort();
  writeState({ port });
  return port;
}

let win: BrowserWindow | null = null;
let origin = '';

function openWindow(route = '/'): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'AgentGraph',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const isOwn = (url: string) => url === origin || url.startsWith(`${origin}/`);
  // target=_blank: свои страницы (файл запуска) — новым окном приложения, чужие (Jira, MR) — в браузере по умолчанию
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOwn(url)) return { action: 'allow' };
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isOwn(url)) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  // beforeunload (несохранённый flow, черновик артефакта) в Electron молча отменяет закрытие: спрашиваем, как браузер
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'question',
      buttons: ['Уйти', 'Остаться'],
      defaultId: 1,
      cancelId: 1,
      message: 'Есть несохранённые изменения',
      detail: 'Если уйти, они пропадут.',
    });
    if (choice === 0) e.preventDefault();
    else {
      // «Остаться» отменило выход: следующий Cmd+Q снова спросит о сессиях и неотправленном
      quitConfirmed = false;
      if (pendingRestart) {
        // перезапуска после обновления не будет, UI скажет перезапустить вручную
        pendingRestart(false);
        pendingRestart = null;
      }
    }
  });
  win.on('closed', () => (win = null));
  // загрузку может перебить переход по клику уведомления (reveal): отказ первой — не ошибка
  void win.loadURL(origin + route).catch(() => undefined);
}

/**
 * Окно на передний план и, если задан, на нужный экран: клик по уведомлению, значок в Dock, повторный запуск.
 * Окна нет (его закрыли, запуски идут) — открываем сразу на этом экране. Экран в открытом окне меняет сам UI
 * (событие окна), а не loadURL: перезагрузка сбросила бы несохранённое.
 */
function reveal(route?: string): void {
  // сервер ещё поднимается (повторный клик по ярлыку во время старта): окно откроет main()
  if (!origin) return;
  if (!win) return openWindow(route);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
  if (!route) return;
  // страница ещё грузится — слушателя события нет: грузим сразу нужный экран
  if (win.webContents.isLoadingMainFrame()) return void win.loadURL(origin + route).catch(() => undefined);
  void win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(NAVIGATE_EVENT)}, { detail: ${JSON.stringify(route)} }))`).catch(() => undefined);
}

/** Сколько показанных уведомлений держим: по клику в Центре уведомлений старое всё ещё должно открыть свой экран. */
const NOTES_MAX = 50;
/** Показанные уведомления по группе: без ссылки сборщик мусора снимает обработчик клика; новое той же группы заменяет старое. */
const notes = new Map<string, Notification>();

/**
 * Уведомление сервера (вопрос агента, пауза, конец запуска, сессия ждёт) — от имени приложения, клик открывает экран в окне.
 * Приложение на виду — молчим: вопрос покажет всплывашка в окне, остальное видно в «Сейчас» и на главной.
 */
function showNotice(n: Notice): void {
  if (BrowserWindow.getFocusedWindow()) return;
  if (!Notification.isSupported()) return osNotify(n, origin);
  const key = n.group ?? `${n.title}\n${n.body}`;
  notes.get(key)?.close();
  notes.delete(key);
  const note = new Notification({ title: n.title, body: n.body, silent: !n.sound });
  note.on('click', () => {
    notes.delete(key);
    reveal(n.path);
  });
  // macOS не дала показать: разрешение на уведомления ещё не выдано или выключено, либо приложение не подписано
  // (голый Electron у desktop:dev). Событие не теряем — показываем системным, как сервер без окна.
  note.on('failed', (_e, error) => {
    if (notes.get(key) === note) notes.delete(key);
    console.warn(`agentgraph desktop: уведомление не показано (${error}) — показываю системным`);
    osNotify(n, origin);
  });
  notes.set(key, note);
  // Map хранит порядок вставки: лишнее — самое старое
  for (const old of notes.keys()) {
    if (notes.size <= NOTES_MAX) break;
    notes.delete(old);
  }
  note.show();
}

function setMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'Файл',
      submenu: [
        {
          label: 'Папка данных…',
          enabled: app.isPackaged && !process.env.AGENTGRAPH_HOME,
          click: async () => {
            if (!(await chooseHome())) return;
            app.relaunch();
            app.quit();
          },
        },
        { label: 'Показать папку данных', click: () => void shell.openPath(home) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let home = '';
/** Есть, когда сервер поднят: выход сначала гасит его. */
let stopServer: (() => Promise<void>) | null = null;
let stopping: Promise<void> | null = null;
/** Названия живых сессий терминала (src/sessions-server.ts): выход при них спрашивает подтверждение. */
let liveSessions: () => string[] = () => [];
/** Неотправленные изменения команд Teamwork и их отправка (src/teamwork-server.ts): о них выход тоже спрашивает. */
let unsentTeams: () => Promise<UnsentTeam[]> = async () => [];
let pushTeams: (slugs: string[]) => Promise<void> = async () => undefined;
let quitConfirmed = false;
let quitAsking = false;
/** Перезапуск после автообновления ждёт выхода: relaunch — в will-quit, false — выход отменили в окне. */
let pendingRestart: ((ok: boolean) => void) | null = null;

/**
 * Вопрос перед выходом (src/quit-dialog.ts): живые сессии терминала завершатся, неотправленные изменения Teamwork
 * останутся в клоне, «Отправить и закрыть» сначала синхронизирует команды. true — выходить.
 */
const confirmQuit = (): Promise<boolean> =>
  askQuit({
    sessions: () => liveSessions(),
    unsent: () => unsentTeams(),
    push: (slugs) => pushTeams(slugs),
    show: async (p) => {
      const opts = { type: 'question' as const, buttons: p.buttons, defaultId: p.defaultId, cancelId: p.cancelId, message: p.message, detail: p.detail };
      return (win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)).response;
    },
  });

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    // второй экземпляр поднял бы второй сервер над теми же runs/: запуски одного не видны другому как свои
    app.quit();
    return;
  }
  // повторный запуск (ещё один клик по ярлыку) — показываем уже открытое приложение
  app.on('second-instance', () => reveal());

  await app.whenReady();
  // из Finder и Dock окружение урезано; у desktop:dev оно уже из терминала
  if (app.isPackaged || linked) importShellEnv();
  if (app.isPackaged) unpackedClaude();
  // desktop:dev запускает голый Electron.app: без этого в Dock его иконка; у ярлыка и упакованного она своя, из бандла
  else if (!linked) app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'));
  const dir = await dataHome();
  if (dir) process.env.AGENTGRAPH_HOME = dir;

  // после AGENTGRAPH_HOME: paths.ts читает его при загрузке модуля
  const server = await import('../server.js');
  const { ROOT, APP_DIR } = await import('../paths.js');
  home = ROOT;
  const port = await pickPort();
  // после автообновления (src/update.ts) — обычный выход и новый экземпляр приложения; про живые сессии UI уже
  // предупредил, Cmd+Q-вопрос не нужен. Окно с несохранёнными правками ещё может выход отменить (will-prevent-unload)
  const restart = () =>
    new Promise<boolean>((resolve) => {
      pendingRestart = resolve;
      quitConfirmed = true;
      app.quit();
    });
  // упакованное приложение не git checkout: проверка обновлений сама скажет, что обновляться не с чего
  origin = `http://localhost:${port}`;
  await server.startServer({ port, host: HOST, defaultCwd: os.homedir(), update: true, restart, notifier: showNotice });
  stopServer = () => server.stopServer();
  const sessions = await import('../sessions-server.js');
  liveSessions = () => sessions.liveSessionNames();
  const teamwork = await import('../teamwork-server.js');
  unsentTeams = () => teamwork.unsentTeams();
  pushTeams = (slugs) => teamwork.pushTeams(slugs);
  console.log(`agentgraph desktop: ${origin} (данные: ${ROOT})`);

  setMenu();
  if (linked) aboutLinked(APP_DIR);
  openWindow();
  // macOS: окно закрыли — запуски идут дальше, клик по иконке в Dock открывает окно снова
  app.on('activate', () => {
    if (!win) openWindow();
  });
  if (linked) warnElectronDrift();
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/** «О программе» у ярлыка: версия checkout'а, а не Electron из Info.plist. */
function aboutLinked(appDir: string): void {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')) as { version?: string };
    app.setAboutPanelOptions({ applicationName: 'AgentGraph', applicationVersion: version ?? '', version: `Electron ${process.versions.electron}` });
  } catch {
    // без версии «О программе» покажет то, что в Info.plist
  }
}

/** Ярлык — копия Electron на момент установки: checkout обновил Electron (npm install) — просим пересобрать ярлык. */
function warnElectronDrift(): void {
  const drift = linkedElectronDrift(process.versions.electron, (id) => createRequire(import.meta.url)(id) as { version?: string });
  if (!drift || !win) return;
  void dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Понятно'],
    message: 'Ярлык AgentGraph пора обновить',
    detail: `Ярлык собран на Electron ${drift.running}, в checkout — ${drift.installed}. Закрой приложение и выполни в папке agentgraph: npm run desktop:install`,
  });
}

// Cmd+Q при живых сессиях терминала (claude завершатся вместе с приложением) или неотправленных изменениях Teamwork —
// сначала спрашиваем. Коммиты считает git, поэтому выход всегда откладывается до ответа confirmQuit; спрашивать не о чем —
// выходим сразу. Сигналы (kill, Ctrl-C у desktop:dev) выходят без вопроса: отвечать на диалог некому.
app.on('before-quit', (e) => {
  if (quitConfirmed || stopping) return;
  e.preventDefault();
  if (quitAsking) return;
  quitAsking = true;
  void confirmQuit()
    // диалог не открылся — выходим, как выходили без вопроса: застрять с неработающим Cmd+Q хуже
    .catch(() => true)
    .then((ok) => {
      if (!ok) return;
      quitConfirmed = true;
      app.quit();
    })
    .finally(() => (quitAsking = false));
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    quitConfirmed = true;
    app.quit();
  });
}

// Выход (Cmd+Q, SIGTERM, SIGINT — их Electron сам превращает в quit): окна уже закрыты, их beforeunload отработал.
// Гасим идущие запуски и сервер, потом выходим. app.quit() после preventDefault в will-quit выход не повторяет — app.exit.
app.on('will-quit', (e) => {
  if (!stopServer || stopping) return;
  e.preventDefault();
  stopping = stopServer()
    .catch((err) => console.error('agentgraph desktop: остановка сервера —', err))
    .finally(() => {
      if (pendingRestart) app.relaunch();
      app.exit(0);
    });
});

main().catch((err) => {
  dialog.showErrorBox('AgentGraph не запустился', err instanceof Error ? (err.stack ?? err.message) : String(err));
  app.exit(1);
});
