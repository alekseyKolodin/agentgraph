// Главный процесс Electron: поднимает тот же сервер, что `npm run ui` (src/server.ts), на 127.0.0.1 и открывает окно
// на http://localhost:<порт>/. Не file://: server-guard.ts пускает только Host localhost/127.0.0.1 и Origin того же адреса.
// UI — сборка dist/web, общение с сервером только по HTTP и SSE; Node в окне нет (contextIsolation, sandbox).
import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { quitPrompt, type UnsentTeam } from '../quit-dialog.js';

const HOST = '127.0.0.1';

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

function openWindow(): void {
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
    else if (pendingRestart) {
      // «Остаться» отменило выход: перезапуска после обновления не будет, UI скажет перезапустить вручную
      pendingRestart(false);
      pendingRestart = null;
      quitConfirmed = false;
    }
  });
  win.on('closed', () => (win = null));
  void win.loadURL(`${origin}/`);
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
let unsentTeams: () => Promise<(UnsentTeam & { slug: string })[]> = async () => [];
let pushTeams: (slugs: string[]) => Promise<void> = async () => undefined;
let quitConfirmed = false;
let quitAsking = false;
/** Перезапуск после автообновления ждёт выхода: relaunch — в will-quit, false — выход отменили в окне. */
let pendingRestart: ((ok: boolean) => void) | null = null;

/** Сколько ждать git перед вопросом (подсчёт коммитов) и отправки по «Отправить и закрыть». */
const UNSENT_WAIT_MS = 3_000;
const PUSH_WAIT_MS = 20_000;

/** Ответ или запасное значение, если не успел за ms: выход не должен зависать на git. */
const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

/**
 * Что спросить перед выходом (макет QuitDialog, spec §7.5): живые сессии терминала завершатся, неотправленные изменения
 * Teamwork останутся в клоне. «Отправить и закрыть» синхронизирует команды и выходит, если всё ушло; не ушло — спрашивает
 * ещё раз с причиной. true — выходить.
 */
async function askQuit(): Promise<boolean> {
  const sessions = liveSessions();
  let teams = await within(unsentTeams(), UNSENT_WAIT_MS, []);
  let pushFailed = false;
  for (;;) {
    const p = quitPrompt({ sessions, teams, pushFailed });
    if (!p) return true;
    const opts = { type: 'question' as const, buttons: p.buttons, defaultId: p.defaultId, cancelId: p.cancelId, message: p.message, detail: p.detail };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    const choice = p.choices[r.response] ?? 'cancel';
    if (choice !== 'push') return choice === 'quit';
    await within(pushTeams(teams.map((x) => x.slug)), PUSH_WAIT_MS, undefined);
    teams = await within(unsentTeams(), UNSENT_WAIT_MS, teams);
    // всё ушло: про сессии человек уже ответил той же кнопкой
    if (!teams.length) return true;
    pushFailed = true;
  }
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    // второй экземпляр поднял бы второй сервер над теми же runs/: запуски одного не видны другому как свои
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (!win) return openWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  await app.whenReady();
  if (app.isPackaged) {
    importShellEnv();
    unpackedClaude();
  } else {
    // desktop:dev запускает голый Electron.app: без этого в Dock его иконка, у упакованного — build/icon.icns
    app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'));
  }
  const dir = await dataHome();
  if (dir) process.env.AGENTGRAPH_HOME = dir;

  // после AGENTGRAPH_HOME: paths.ts читает его при загрузке модуля
  const server = await import('../server.js');
  const { ROOT } = await import('../paths.js');
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
  await server.startServer({ port, host: HOST, defaultCwd: os.homedir(), update: true, restart });
  stopServer = () => server.stopServer();
  const sessions = await import('../sessions-server.js');
  liveSessions = () => sessions.liveSessionNames();
  const teamwork = await import('../teamwork-server.js');
  unsentTeams = () => teamwork.unsentTeams();
  pushTeams = (slugs) => teamwork.pushTeams(slugs);
  origin = `http://localhost:${port}`;
  console.log(`agentgraph desktop: ${origin} (данные: ${ROOT})`);

  setMenu();
  openWindow();
  // macOS: окно закрыли — запуски идут дальше, клик по иконке в Dock открывает окно снова
  app.on('activate', () => {
    if (!win) openWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// Cmd+Q при живых сессиях терминала (claude завершатся вместе с приложением) или неотправленных изменениях Teamwork —
// сначала спрашиваем. Коммиты считает git, поэтому выход всегда откладывается до ответа askQuit; спрашивать не о чем —
// выходим сразу. Сигналы (kill, Ctrl-C у desktop:dev) выходят без вопроса: отвечать на диалог некому.
app.on('before-quit', (e) => {
  if (quitConfirmed || stopping) return;
  e.preventDefault();
  if (quitAsking) return;
  quitAsking = true;
  void askQuit()
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
