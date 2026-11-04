// Сессии терминала: обычная интерактивная сессия Claude Code (настоящий TUI `claude`) внутри agentgraph, в пространстве
// и с тегами знаний. Здесь — чистая логика без pty и HTTP: поиск бинарника, аргументы claude, хуки и запреты записи в
// --settings, конфиг MCP-сервера agentgraph, окружение процесса, текст контекста (полный — на SessionStart, изменения —
// на UserPromptSubmit и PostToolBatch) с бюджетом, разбор хуков и решение «продолжить разговор или начать новый».
// Контекст заходит только штатными механизмами Claude Code: папка пространства — в --add-dir, и его CLAUDE.md claude
// грузит памятью сам; хуки из --settings отвечают additionalContext (шапка пространства, документы, состояние, строки
// тегов знаний); полный текст тега знаний отдаёт knowledge_read, документ пространства пишет space_write MCP-сервера
// agentgraph (sessions-mcp.ts). --append-system-prompt не используется: он замораживается на первом запросе. Процессы и
// экран — sessions-pty.ts, маршруты — sessions-server.ts.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { SessionPermissionMode, SessionStatus, Space, Tag } from './api-types.js';
import { isInside, WRITE_TOOLS } from './artifacts.js';
import { attachDir, existingTagPaths, knowledgeBlock, KNOWLEDGE_READ_TOOL, tagsDir } from './tags.js';
import { existingSpacePaths, META_FILE, spaceArtifactDirs, spaceContext, spacesDir, SPACE_WRITE_TOOL } from './spaces.js';

/** Имя MCP-сервера в конфиге claude: не knowledge, чтобы не столкнуться с сервером пользователя. */
export const SESSION_MCP_SERVER = 'agentgraph';
/** Инструмент «открыть новую сессию»: не в SESSION_ALLOWED_TOOLS, и хук PreToolUse велит claude спросить даже в auto. */
export const SESSION_NEW_TOOL = 'session_new';
export const SESSION_NEW_FULL = `mcp__${SESSION_MCP_SERVER}__${SESSION_NEW_TOOL}`;
/** Запись документа пространства: как session_new — не в SESSION_ALLOWED_TOOLS, PreToolUse велит спросить всегда. */
export const SPACE_WRITE_FULL = `mcp__${SESSION_MCP_SERVER}__${SPACE_WRITE_TOOL}`;
/** Инструменты, о каждом вызове которых claude спрашивает человека в любом режиме: хук PreToolUse отвечает ask. */
const ASK_TOOLS: Record<string, string> = {
  [SESSION_NEW_FULL]: 'agentgraph: новая сессия запустит claude с заданием от модели',
  [SPACE_WRITE_FULL]: 'agentgraph: документ пространства увидят все следующие сессии и запуски',
};
/** С этой версии claude у HTTP-хука есть onFailure: block — сбой хука блокирует вызов, а не пропускает его. */
export const HOOK_ON_FAILURE_SINCE = '2.1.295';
/** Инструменты записи файлов: у сессии в папке пространства хук PreToolUse сверяет путь в момент вызова. */
const WRITE_MATCHER = WRITE_TOOLS.join('|');

/** Версия claude не ниже нужной («2.1.317 (Claude Code)» и подобные); неизвестная — нет. */
export function versionAtLeast(version: string | undefined, min: string): boolean {
  const v = version?.match(/(\d+)\.(\d+)\.(\d+)/);
  const m = min.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!v || !m) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(v[i]) - Number(m[i]);
    if (d) return d > 0;
  }
  return true;
}

/** Разрешены без подтверждения: только чтение тегов знаний сессии. */
export const SESSION_ALLOWED_TOOLS = [KNOWLEDGE_READ_TOOL].map((t) => `mcp__${SESSION_MCP_SERVER}__${t}`);
/** Заголовок с токеном сессии у хуков и MCP: без него (или с чужим) — 404. */
export const SESSION_TOKEN_HEADER = 'X-Agentgraph-Session';
/** Живых сессий не больше: каждый claude занимает около 300 МБ. */
export const LIVE_SESSIONS_MAX = 6;
/** Claude Code режет additionalContext хука после 10 000 знаков (дальше — файл и превью на 2 КБ), держим запас. */
export const CONTEXT_BUDGET = 8500;
/** Режимы разрешений claude 2.1.311, которые предлагает форма. bypassPermissions и dontAsk не принимаем. */
export const PERMISSION_MODES: readonly SessionPermissionMode[] = ['acceptEdits', 'auto', 'manual', 'plan'];
export const SESSION_NAME_MAX = 80;
/** Модель — алиас или id: без пробелов и без дефиса в начале, чтобы не стать флагом claude. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
/** Первое сообщение новой сессии уходит в argv одним аргументом: Linux режет его на 128 КиБ (MAX_ARG_STRLEN), держим запас. */
export const SESSION_PROMPT_MAX = 100_000;
/** Диалог доверия к папке на экране claude: до его принятия ни хуки, ни MCP не запускаются. */
export const TRUST_PROMPT_RE = /Is this a project you created or one you trust|Do you trust the files in this folder/;

// --- бинарник

const isExecutable = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** CLI из пакета Agent SDK под платформу; в упакованном приложении — из app.asar.unpacked (оттуда его можно запустить). */
function sdkClaude(): string | undefined {
  try {
    const bin = createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
    return bin.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  } catch {
    return undefined;
  }
}

export type FindClaudeDeps = { executable: (p: string) => boolean; sdk: () => string | undefined };

/**
 * Какой claude запускать: первый из PATH (у упакованного приложения PATH из login-shell, у desktop:dev и `agentgraph ui` —
 * из терминала), иначе CLI из пакета SDK. undefined — нет ни того, ни другого: форма покажет ошибку.
 */
export function findClaude(env: NodeJS.ProcessEnv = process.env, deps: FindClaudeDeps = { executable: isExecutable, sdk: sdkClaude }): string | undefined {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && path.isAbsolute(dir) && deps.executable(path.join(dir, 'claude'))) return path.join(dir, 'claude');
  }
  const sdk = deps.sdk();
  return sdk && deps.executable(sdk) ? sdk : undefined;
}

/** «2.1.311 (Claude Code)» → «2.1.311». */
export function parseClaudeVersion(out: string): string | undefined {
  return out.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];
}

// --- параметры из формы

/** Название сессии: из формы, иначе слаги (пространство и теги), иначе имя папки; одной строкой, не длиннее SESSION_NAME_MAX. */
export function sessionName(raw: unknown, tags: string[], cwd: string): string {
  const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return [...(s || tags.join(' · ') || path.basename(cwd) || cwd)].slice(0, SESSION_NAME_MAX).join('');
}

/** Модель и режим из тела запроса: пусто — флаг не передаётся, claude берёт своё из настроек пользователя. */
export function sessionFlags(body: { model?: unknown; permissionMode?: unknown }): { model?: string; permissionMode?: SessionPermissionMode } {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (body.model !== undefined && body.model !== null && typeof body.model !== 'string') throw new Error('model — строка');
  if (model && !MODEL_RE.test(model)) throw new Error(`Неверная модель: ${model}`);
  const mode = body.permissionMode;
  if (mode !== undefined && mode !== null && mode !== '' && !PERMISSION_MODES.includes(mode as SessionPermissionMode)) {
    throw new Error(`Режим разрешений — один из: ${PERMISSION_MODES.join(', ')}`);
  }
  return { ...(model ? { model } : {}), ...(mode ? { permissionMode: mode as SessionPermissionMode } : {}) };
}

/**
 * Режим новой сессии из session_new: текущий режим этой (из хуков — его меняют Shift+Tab), иначе режим запуска, иначе
 * manual. Передаётся всегда: без флага claude взял бы defaultMode из настроек папки, которую выбрала модель.
 * default — это manual; bypassPermissions, dontAsk и незнакомые — тоже manual.
 */
export function childPermissionMode(current: string | undefined, launch: SessionPermissionMode | undefined): SessionPermissionMode {
  const mode = current ?? launch;
  return PERMISSION_MODES.includes(mode as SessionPermissionMode) ? (mode as SessionPermissionMode) : 'manual';
}

/** Первое сообщение новой сессии: пусто — claude ждёт пользователя. */
export function sessionPrompt(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('prompt — строка');
  const text = raw.trim();
  if (Buffer.byteLength(text) > SESSION_PROMPT_MAX) throw new Error(`Первое сообщение больше ${SESSION_PROMPT_MAX} байт`);
  return text || undefined;
}

// --- запуск claude

/** Что сессия получает от agentgraph: пространство (может не быть) и теги знаний — существующие на момент чтения. */
export type SessionCtx = { space?: Space; knowledge: Tag[] };

/**
 * Папки чтения сессии (--add-dir): папка пространства, его пути-папки и артефакты прошлых запусков; пути-папки и вложения
 * тегов знаний. Путь-файл не открывает свою папку целиком (у ~/notes.md это был бы весь ~): его чтение пропускает хук
 * PermissionRequest по sessionReadTargets.
 */
export function sessionDirs(ctx: SessionCtx, runsDir: string): string[] {
  return [...new Set(sessionReadTargets(ctx, runsDir).dirs)];
}

/**
 * Что сессии разрешено читать точно: папки (папка пространства, его пути-папки, артефакты его прошлых запусков, пути
 * и вложения тегов знаний) и отдельные файлы (путь — файл: только он, а не вся его папка). По этому списку хук
 * PermissionRequest пропускает чтение без вопроса — нужно, когда пространство или тег выбрали на ходу.
 */
export type ReadTargets = { dirs: string[]; files: string[] };

export function sessionReadTargets(ctx: SessionCtx, runsDir: string): ReadTargets {
  const dirs = new Set<string>();
  const files = new Set<string>();
  if (ctx.space) {
    dirs.add(ctx.space.dir);
    const paths = existingSpacePaths(ctx.space);
    for (const p of paths.listed) (paths.files.includes(p) ? files : dirs).add(p);
    for (const d of spaceArtifactDirs(ctx.space, runsDir)) dirs.add(d);
  }
  for (const t of ctx.knowledge) {
    for (const p of existingTagPaths(t).listed) (fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ? dirs : files).add(p);
    if (t.attachments.length) dirs.add(attachDir(t.slug));
  }
  return { dirs: [...dirs], files: [...files] };
}

/** Путь, с которым правило разрешений или --add-dir работает буквально: скобки, глоб-символы и перевод строки ломают правило. */
const plainPath = (d: string) => !/[()[\]*?{}\n]/.test(d);

/**
 * Придёт ли карта пространства памятью сессии с рабочей папкой cwd: папка пространства уйдёт в --add-dir (не внутри cwd,
 * не содержит его, без спецсимволов — как в launchDirs) или сессия открыта в самой папке пространства (CLAUDE.md
 * грузится от cwd вверх). Папка пространства внутри cwd (cwd — ~) — нет: карта придёт строкой «прочитай».
 */
export function mapLoadedAt(spaceDir: string, cwd: string): boolean {
  return isInside(cwd, spaceDir) || (!isInside(spaceDir, cwd) && plainPath(spaceDir));
}

/**
 * --add-dir и запрет записи. --add-dir открывает и запись, поэтому всё, что он открыл, вся папка тегов
 * (~/.agentgraph/tags), вся папка пространств (~/.agentgraph/spaces: карты, состояния, документы — документ пишется только
 * инструментом space_write с подтверждением) и артефакты прошлых запусков закрыты правилом Edit (оно же запрещает Write).
 * Пути внутри cwd или содержащие его не трогаем: это сам проект, запрет закрыл бы его; папки тегов, пространств и
 * артефакты закрываем и внутри проекта — не закрываем, только если в них лежит сам cwd. Сессия, открытая в папке
 * пространства, правит его карту и документы как обычный проект, но space.json (его пути станут --add-dir других сессий)
 * закрыт и тогда — denyFiles. Путь со спецсимволами правило не поймает — такой папки нет ни в --add-dir, ни в запретах.
 * filesDir — папка файлов, перетащенных в терминал.
 */
export function launchDirs(
  readDirs: string[],
  cwd: string,
  filesDir: string,
  protectedDirs: string[] = [],
): { addDirs: string[]; denyDirs: string[]; denyFiles: string[]; askDirs: string[] } {
  const add = readDirs.filter((d) => !isInside(cwd, d) && !isInside(d, cwd) && plainPath(d));
  const spaces = spacesDir();
  const guard = [tagsDir(), spaces, ...protectedDirs].filter((d) => !isInside(cwd, d) && plainPath(d));
  let denyFiles: string[] = [];
  let askDirs: string[] = [];
  const inSpace: string[] = [];
  if (isInside(cwd, spaces) && plainPath(spaces)) {
    // сессия в папке пространства («Сессия в папке»): своё пространство она правит как проект, но каждая правка — с
    // вопросом (permissions.ask держит его и в acceptEdits, и в auto), без .claude/ (настройки и скиллы грузятся во все
    // сессии пространства) и без space.json (его пути станут --add-dir других сессий); остальные пространства закрыты
    const cur = path.relative(spaces, cwd).split(path.sep)[0];
    const own = cur ? path.join(spaces, cur) : undefined;
    for (const name of readdirSafe(spaces)) {
      const d = path.join(spaces, name);
      if (d !== own && plainPath(d) && fs.lstatSync(d, { throwIfNoEntry: false })?.isDirectory()) inSpace.push(d);
    }
    if (own) {
      inSpace.push(path.join(own, '.claude'));
      askDirs = [own];
    }
    denyFiles = [path.join(spaces, '*', META_FILE), path.join(spaces, '.migrated.json')];
  }
  const all = [...guard, ...add, ...inSpace];
  const deny = all.filter((d, i) => all.indexOf(d) === i && !all.some((o) => o !== d && isInside(d, o) && guard.includes(o)));
  // ~/.agentgraph может быть ссылкой: правило с лексическим путём реальный путь не поймало бы — добавляем и его
  return { addDirs: [...add, filesDir], denyDirs: withRealpaths(deny), denyFiles: withRealpaths(denyFiles), askDirs: withRealpaths(askDirs) };
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Путь и его realpath (папки или шаблона с * — по realpath существующего начала), если они разные и годятся в правило. */
function withRealpaths(list: string[]): string[] {
  const out: string[] = [];
  for (const d of list) {
    out.push(d);
    const head = d.split(path.sep).findIndex((part) => part.includes('*'));
    const base = head < 0 ? d : d.split(path.sep).slice(0, head).join(path.sep);
    const real = safeRealpath(base);
    if (real === base) continue;
    const alt = head < 0 ? real : path.join(real, ...d.split(path.sep).slice(head));
    if (plainPath(alt.replace(/\*/g, '')) && !out.includes(alt)) out.push(alt);
  }
  return out;
}

export type SessionLaunch = {
  /** id сессии agentgraph: адрес /sessions/<id> и путь хуков. */
  id: string;
  token: string;
  /** Порт сервера agentgraph: туда ходят хуки и MCP. */
  port: number;
  /** --session-id нового разговора или id разговора для --resume. */
  claudeSessionId: string;
  resume: boolean;
  name: string;
  addDirs: string[];
  denyDirs: string[];
  /** Отдельные файлы (или шаблоны с *) под запретом Edit: space.json, когда сессия открыта в папке пространства. */
  denyFiles?: string[];
  /** Папки, правка в которых всегда с вопросом (permissions.ask): своё пространство сессии, открытой в его папке. */
  askDirs?: string[];
  /** Версия claude, если известна: от неё зависит onFailure у HTTP-хука PreToolUse. */
  claudeVersion?: string;
  model?: string;
  permissionMode?: SessionPermissionMode;
  /** Первое сообщение нового разговора: claude отправит его сам, как `claude "задача"`. */
  prompt?: string;
};

const base = (l: Pick<SessionLaunch, 'port' | 'id'>) => `http://127.0.0.1:${l.port}/api/sessions/${l.id}`;

/**
 * Хуки HTTP-эндпоинта сессии. SessionStart — командой curl: HTTP-хуки на SessionStart Claude Code молча пропускает.
 * -f: ответ 404/500 не уходит в stdout (Claude принял бы тело ошибки за вывод хука); || true — сбой не ломает старт.
 */
export const HTTP_HOOKS = ['UserPromptSubmit', 'PostToolBatch', 'Stop', 'StopFailure', 'Notification', 'SessionEnd', 'PermissionRequest'] as const;

export function sessionSettings(l: SessionLaunch): Record<string, unknown> {
  const url = `${base(l)}/hook`;
  const curl = `curl -sSf --max-time 5 -X POST -H 'Content-Type: application/json' -H '${SESSION_TOKEN_HEADER}: ${l.token}' --data-binary @- '${url}' || true`;
  const http = [{ hooks: [{ type: 'http', url, headers: { [SESSION_TOKEN_HEADER]: l.token }, timeout: 5 }] }];
  // PreToolUse отвечает ask с причиной; сбой этого хука (таймаут, прокси) claude считает неблокирующим и пустил бы вызов
  // дальше — с onFailure: block (claude 2.1.295+; старый ключа не знает, и ему его не шлём) вызов блокируется
  const askHook = { ...http[0].hooks[0], ...(versionAtLeast(l.claudeVersion, HOOK_ON_FAILURE_SINCE) ? { onFailure: 'block' } : {}) };
  const dirRules = (d: string) => [`Edit(/${d})`, `Edit(/${d}/**)`];
  // сессия в папке пространства: запреты на другие пространства — снимок на старте, а заведённые потом и новые папки в
  // spaces/ ловит хук записи в момент вызова (handleHook → writeGuard)
  const writeHook = l.askDirs?.length ? [{ matcher: WRITE_MATCHER, hooks: [askHook] }] : [];
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: curl, timeout: 10 }] }],
      ...Object.fromEntries(HTTP_HOOKS.map((e) => [e, http])),
      PreToolUse: [...Object.keys(ASK_TOOLS).map((matcher) => ({ matcher, hooks: [askHook] })), ...writeHook],
    },
    // //путь — абсолютный путь в правилах разрешений; Edit закрывает все инструменты записи файлов, правило Write(путь)
    // claude 2.1.311 не применяет и предупреждает о нём при старте. Сама папка — отдельным правилом: /** её не ловит.
    // ask — session_new и space_write спрашивают и без хука (явное правило ask держит вопрос и в auto), плюс своё
    // пространство сессии, открытой в его папке
    permissions: {
      deny: [...l.denyDirs.flatMap(dirRules), ...(l.denyFiles ?? []).map((f) => `Edit(/${f})`)],
      ask: [...Object.keys(ASK_TOOLS), ...(l.askDirs ?? []).flatMap(dirRules)],
    },
  };
}

/** HTTP MCP самого сервера agentgraph; alwaysLoad — инструменты сразу в контексте, без ToolSearch. */
export function sessionMcpConfig(l: SessionLaunch): Record<string, unknown> {
  return { mcpServers: { [SESSION_MCP_SERVER]: { type: 'http', url: `${base(l)}/mcp`, headers: { [SESSION_TOKEN_HEADER]: l.token }, alwaysLoad: true } } };
}

/**
 * argv для claude: запуск без shell, массивом, поэтому JSON не экранируется. Название — через `=`: начнись оно с дефиса,
 * claude принял бы его за флаг. Модель и режим разрешений — только если выбраны, первое сообщение — последним.
 */
export function sessionArgs(l: SessionLaunch): string[] {
  // id — через `=`: значение не может стать флагом, даже если бы пришло из хука кривым
  const args = [l.resume ? `--resume=${l.claudeSessionId}` : `--session-id=${l.claudeSessionId}`];
  args.push(`--name=${l.name}`, '--settings', JSON.stringify(sessionSettings(l)), '--mcp-config', JSON.stringify(sessionMcpConfig(l)));
  args.push('--allowedTools', SESSION_ALLOWED_TOOLS.join(','));
  for (const d of l.addDirs) args.push('--add-dir', d);
  if (l.model) args.push('--model', l.model);
  if (l.permissionMode) args.push('--permission-mode', l.permissionMode);
  // после `--`: --add-dir и --allowedTools берут несколько значений и иначе забрали бы сообщение себе
  if (l.prompt) args.push('--', l.prompt);
  return args;
}

/**
 * Маркеры хоста и чужой сессии: их выставляет Claude Code или Claude desktop, из которого запущен сервер agentgraph.
 * Унаследованные, они выключают транскрипт, хуки, cron и заголовок терминала у дочернего claude, включают режим SDK
 * и т. п. Чёрный список, а не белый: пользовательские CLAUDE_CODE_* (Bedrock, Vertex, OAuth-токен, MAX_OUTPUT_TOKENS)
 * остаются как есть.
 */
const ENV_DROP = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_DISABLE_CRON', 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_TERMINAL_MCP_TOOLS', 'CLAUDE_CODE_REPORT_FINDINGS', 'CLAUDE_CODE_STARTUP_FAILURE_RESULTS', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL', 'CLAUDE_CODE_DESKTOP_APP_VERSION', 'CLAUDE_CODE_OAUTH_SCOPES',
  'MCP_CONNECTION_NONBLOCKING', 'MCP_SERVER_CONNECTION_BATCH_SIZE',
]);
const ENV_DROP_PREFIX = ['CLAUDE_CODE_MESSAGING_', 'CLAUDE_CODE_EMIT_', 'CLAUDE_AGENT_SDK_', 'CLAUDE_PREVIEW_'];
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

const withLocal = (list: string | undefined) => [...new Set([...(list ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...LOCAL_HOSTS])].join(',');

/**
 * Окружение claude: всё пользовательское (вход, провайдер, Bedrock, токены) остаётся, вычищаются только маркеры
 * хоста и сессии. Хуки и MCP идут на 127.0.0.1 мимо прокси (NO_PROXY), терминал — 256 цветов и truecolor, без
 * локали — C.UTF-8.
 */
export function sessionEnv(env: NodeJS.ProcessEnv, hasAddDirs: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !ENV_DROP.has(k) && !ENV_DROP_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  out.NO_PROXY = withLocal(env.NO_PROXY);
  if (env.no_proxy !== undefined) out.no_proxy = withLocal(env.no_proxy);
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  // локаль ставит терминал (Terminal.app, iTerm2), а у приложения из Finder её нет: claude копирует выделение ещё и
  // через pbcopy, и тот без UTF-8 превращает «привет» в «–њ—А–Є–≤–µ—В». Заданную пользователем локаль не трогаем
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) out.LANG = 'C.UTF-8';
  // CLAUDE.md из --add-dir — как у этапов запуска (agent.ts): так приходит карта пространства
  if (hasAddDirs) out.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1';
  return out;
}

// --- контекст: пространство и теги знаний

const CONTEXT_HEAD =
  'Контекст agentgraph для этой сессии: пространство и теги знаний. Их меняют в agentgraph: изменения придут со следующим шагом или сообщением пользователя.';
const DELTA_HEAD = 'Контекст agentgraph этой сессии изменился.';
const CUT_NOTE = '\n…(контекст agentgraph обрезан по лимиту хука)';

/** Что модель уже получила: пространство и набор тегов знаний. */
export type Delivered = { space?: string; tags: string[] };

/**
 * Части текста на уровне подробности: 0 — всё (документы списком до DOCS_LIST_MAX), 1 — пять документов, 2 — только
 * число документов, 3 — и теги знаний «целиком» строкой. mapLoaded — карта уже память (пространство было в --add-dir).
 */
function parts(space: Space | undefined, knowledge: Tag[], mapLoaded: boolean, level: number): string[] {
  const out: string[] = [];
  if (space) out.push(spaceContext(space, { where: 'session', mapLoaded, docsMax: level === 0 ? undefined : level === 1 ? 5 : 0 }));
  const k = knowledgeBlock(level < 3 ? knowledge : knowledge.map((t) => ({ ...t, inline: undefined })));
  return k ? [...out, k] : out;
}

/** Самый подробный вариант, который влезает в бюджет; не влез и самый краткий — обрезка с пометкой. */
function fit(head: string, variant: (level: number) => string[], budget: number): string {
  let text = '';
  for (const level of [0, 1, 2, 3]) {
    text = [head, ...variant(level)].join('\n\n');
    if (text.length <= budget) return text;
  }
  return text.slice(0, budget - CUT_NOTE.length) + CUT_NOTE;
}

/**
 * Полный контекст для SessionStart (старт, /clear, /resume, compact): пространство и все теги знаний. launchSpace —
 * пространство, с которым запущен процесс claude: только его карта уже в памяти. Без пространства и тегов — пусто.
 */
export function sessionContext(ctx: SessionCtx, launchSpace?: string, budget = CONTEXT_BUDGET): string {
  if (!ctx.space && !ctx.knowledge.length) return '';
  const mapLoaded = Boolean(ctx.space && ctx.space.slug === launchSpace);
  return fit(CONTEXT_HEAD, (level) => parts(ctx.space, ctx.knowledge, mapLoaded, level), budget);
}

/** Что модель получит этим текстом: пространство и существующие теги знаний сессии. */
export const delivered = (ctx: SessionCtx): Delivered => ({ ...(ctx.space ? { space: ctx.space.slug } : {}), tags: ctx.knowledge.map((t) => t.slug) });

/**
 * Изменения с прошлой доставки для UserPromptSubmit и PostToolBatch: раздел нового пространства (его карта — строкой
 * «прочитай»: в память она грузится только при старте процесса), строка о снятом, строки добавленных тегов знаний и о
 * снятых. Изменений нет — пустая строка.
 */
export function contextDelta(ctx: SessionCtx, injected: Delivered, launchSpace?: string, budget = CONTEXT_BUDGET): string {
  const space = ctx.space && ctx.space.slug !== injected.space ? ctx.space : undefined;
  const spaceGone = injected.space && injected.space !== ctx.space?.slug ? injected.space : undefined;
  const knowledge = ctx.knowledge.filter((t) => !injected.tags.includes(t.slug));
  const current = new Set(ctx.knowledge.map((t) => t.slug));
  const removed = injected.tags.filter((s) => !current.has(s));
  if (!space && !spaceGone && !knowledge.length && !removed.length) return '';
  const gone = [
    ...(spaceGone ? [`Пространство ${spaceGone} снято: его карта, документы и состояние выше больше не действуют.`] : []),
    ...removed.map((s) => `Тег ${s} снят: его контекст выше больше не действует.`),
  ];
  const mapLoaded = Boolean(space && space.slug === launchSpace);
  return fit(DELTA_HEAD, (level) => [...(gone.length ? [gone.join('\n')] : []), ...parts(space, knowledge, mapLoaded, level)], budget);
}

// --- хуки

/** Вход хука Claude Code: только поля, которые нужны сессии. */
export type HookInput = {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  source?: string;
  reason?: string;
  /** Есть, только когда хук сработал внутри сабагента. */
  agent_id?: string;
  prompt?: string;
  last_assistant_message?: string;
  notification_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Режим разрешений в момент хука: default, plan, acceptEdits, auto… */
  permission_mode?: string;
};

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function parseHookInput(raw: unknown): HookInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const event = str(r.hook_event_name);
  if (!event) return undefined;
  const input = r.tool_input && typeof r.tool_input === 'object' && !Array.isArray(r.tool_input) ? (r.tool_input as Record<string, unknown>) : undefined;
  const out: HookInput = { hook_event_name: event };
  for (const k of ['session_id', 'transcript_path', 'source', 'reason', 'agent_id', 'prompt', 'last_assistant_message', 'notification_type', 'tool_name', 'permission_mode'] as const) {
    const v = str(r[k]);
    if (v !== undefined) out[k] = v;
  }
  if (input) out.tool_input = input;
  return out;
}

/** Состояние сессии, которое читают и меняют хуки. */
export type HookState = {
  /** Пространство сессии сейчас (слаг) и теги знаний. */
  space?: string;
  tags: string[];
  /** Пространство, с которым запущен процесс claude: его папка в --add-dir, карта — в памяти. */
  launchSpace?: string;
  /** Что модель уже получила; null — ещё ничего (SessionStart не приходил). */
  injected: Delivered | null;
  status: SessionStatus;
  claudeSessionIds: string[];
  transcriptPath?: string;
  /** SessionStart приходил у этого процесса claude. */
  started: boolean;
  turns: number;
  /** Текущий режим разрешений по последнему хуку основного разговора. */
  permissionMode?: string;
  /** Сессия до пространств: её теги задач. В её транскрипте мог остаться их контекст от прошлой версии agentgraph. */
  preSpacesTags?: string[];
};

/**
 * Пометка для --resume сессии до пространств: в транскрипте выше лежит контекст её тегов задач от прошлой версии
 * agentgraph (саммари на тот момент), а теперь это пространства — чтобы модель не держалась за устаревшее.
 */
export function preSpacesNote(tags: string[]): string {
  return `В разговоре выше может быть контекст тегов задач (${tags.join(', ')}) от прошлой версии agentgraph: он устарел — теги задач перенесены в пространства, актуальны карта и состояние ниже.`;
}

export type HookResult = {
  /** Тело ответа хуку. */
  reply: Record<string, unknown>;
  patch: Partial<HookState>;
  /** Что модель получит этим ответом: injected := delivered — только после того, как ответ ушёл. */
  delivered?: Delivered;
  /** Запись в журнал ходов: сообщение пользователя или итоговый ответ модели. */
  turn?: { prompt: string } | { answer: string };
};

export type HookDeps = {
  /** Пространство и существующие теги знаний сессии на момент хука. */
  readCtx: (space: string | undefined, tags: string[]) => SessionCtx;
  /** Что они разрешают читать (sessionReadTargets). */
  readTargets: (ctx: SessionCtx) => ReadTargets;
  realpath: (p: string) => string;
  /** Подробности к вопросу PreToolUse: что сделает этот вызов (папка, пространство, режим новой сессии; какой документ). */
  askDetail?: (tool: string, input: Record<string, unknown>) => string | undefined;
  /** Запись файла (сессия в папке пространства): строка — отказ с этим объяснением; undefined — решают правила и режим. */
  writeGuard?: (tool: string, input: Record<string, unknown>) => string | undefined;
};

/** Ожидание человека в TUI: запрос разрешения, простой, форма MCP. */
const WAIT_NOTIFICATIONS = ['permission_prompt', 'idle_prompt', 'elicitation_dialog'];
/** Чтение файлов: какой ключ tool_input несёт путь. */
const READ_TOOLS: Record<string, string> = { Read: 'file_path', Grep: 'path', Glob: 'path' };
/** id разговора Claude Code — UUID; другое в --resume не пойдёт. */
const CLAUDE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const withContext = (event: string, text: string) => (text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {});

/**
 * Ответ на хук и правка состояния. «Завершена» отсюда не ставится: только по выходу процесса — SessionEnd с reason
 * clear или resume означает лишь смену разговора, за ним придёт SessionStart.
 */
export function handleHook(s: HookState, input: HookInput, deps: HookDeps): HookResult {
  const patch: Partial<HookState> = {};
  // новый разговор (/clear, /resume) или пропущенный SessionStart: «Продолжить» возьмёт последний
  const sid = input.session_id && CLAUDE_ID_RE.test(input.session_id) ? input.session_id : undefined;
  if (sid && s.claudeSessionIds.at(-1) !== sid) patch.claudeSessionIds = [...s.claudeSessionIds.filter((x) => x !== sid), sid];
  if (sid && input.transcript_path) patch.transcriptPath = input.transcript_path;
  if (input.permission_mode && !input.agent_id && input.permission_mode !== s.permissionMode) patch.permissionMode = input.permission_mode;
  const event = input.hook_event_name;
  const ctx = () => deps.readCtx(s.space, s.tags);

  switch (event) {
    case 'SessionStart': {
      // любой source: после /clear, /resume и compact прежний контекст модели уже не виден (карта — память, её claude
      // загрузит сам)
      const c = ctx();
      const text = sessionContext(c, s.launchSpace);
      const note = input.source === 'resume' && s.preSpacesTags?.length ? preSpacesNote(s.preSpacesTags) : '';
      return { reply: withContext(event, [note, text].filter(Boolean).join('\n\n')), patch: { ...patch, started: true, status: 'waiting' }, delivered: delivered(c) };
    }
    case 'UserPromptSubmit':
    case 'PostToolBatch': {
      // пачка инструментов сабагента: его контекст живёт отдельно, основной разговор изменения не увидел бы
      if (input.agent_id) return { reply: {}, patch: { ...patch, status: 'working' } };
      const c = ctx();
      const text = s.injected === null ? sessionContext(c, s.launchSpace) : contextDelta(c, s.injected, s.launchSpace);
      const working = { ...patch, status: 'working' as const };
      const turn = event === 'UserPromptSubmit' ? { prompt: input.prompt ?? '' } : undefined;
      if (event === 'UserPromptSubmit') working.turns = s.turns + 1;
      return { reply: withContext(event, text), patch: working, ...(text || s.injected === null ? { delivered: delivered(c) } : {}), ...(turn ? { turn } : {}) };
    }
    case 'Stop':
      return { reply: {}, patch: { ...patch, status: 'waiting' }, turn: { answer: input.last_assistant_message ?? '' } };
    case 'StopFailure':
      return { reply: {}, patch: { ...patch, status: 'waiting' } };
    case 'Notification':
      return { reply: {}, patch: WAIT_NOTIFICATIONS.includes(input.notification_type ?? '') ? { ...patch, status: 'waiting' } : patch };
    case 'PermissionRequest':
      return { reply: permissionReply(input, deps.readTargets(ctx()), deps.realpath), patch };
    case 'PreToolUse': {
      if (WRITE_TOOLS.includes(input.tool_name ?? '') && deps.writeGuard) {
        let deny: string | undefined;
        try {
          deny = deps.writeGuard(input.tool_name!, input.tool_input ?? {});
        } catch (err) {
          // упавшая проверка не пропускает запись
          deny = `Проверка записи не удалась (${err instanceof Error ? err.message : String(err)}): вызов отклонён.`;
        }
        return { reply: deny ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny } } : {}, patch };
      }
      // session_new запускает claude с текстом модели, space_write пишет документ для всех следующих сессий:
      // спрашиваем человека в любом режиме, auto тоже
      const why = ASK_TOOLS[input.tool_name ?? ''];
      if (!why) return { reply: {}, patch };
      let detail: string | undefined;
      try {
        detail = deps.askDetail?.(input.tool_name!, input.tool_input ?? {});
      } catch {
        detail = undefined;
      }
      return { reply: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: detail ? `${why}. ${detail}` : why } }, patch };
    }
    default:
      return { reply: {}, patch };
  }
}

/**
 * Папки пространства и тега, выбранных на ходу: --add-dir в живом claude не меняется, и чтение из них спросило бы
 * разрешение. Чтение внутри папок и файлов текущих пространства и тегов разрешается — этот вызов и только он: папка в сессию не добавляется
 * (addDirectories сделал бы её рабочей, а в acceptEdits — открытой на запись), следующее чтение снова спросит хук.
 * Остальное — {}: решает человек в TUI. Путь сверяется по realpath: ссылка из папки тега наружу не проходит; у Glob
 * шаблон — только относительный и без «..», иначе он искал бы вне папки.
 */
export function permissionReply(input: HookInput, targets: ReadTargets, realpath: (p: string) => string): Record<string, unknown> {
  const key = READ_TOOLS[input.tool_name ?? ''];
  const raw = key ? input.tool_input?.[key] : undefined;
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) return {};
  if (input.tool_name === 'Glob') {
    const pattern = input.tool_input?.pattern;
    // фигурные скобки раскрываются ({..,x}/*, {/,}etc/*): шаблон с ними пропускается к человеку
    if (typeof pattern !== 'string' || path.isAbsolute(pattern) || pattern.startsWith('~') || /[{}]/.test(pattern) || pattern.split(/[\\/]/).includes('..')) return {};
  }
  const target = realpath(path.resolve(raw));
  const ok = targets.dirs.some((d) => isInside(target, realpath(d))) || (input.tool_name === 'Read' && targets.files.some((f) => target === realpath(f)));
  return ok ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } : {};
}

/** realpath с запасным вариантом: пути ещё может не быть (Glob по шаблону) — тогда как есть. */
export function safeRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * «Продолжить»: --resume последнего разговора, если его транскрипт есть. Без единого промпта транскрипта нет, и
 * --resume упал бы — тогда undefined: новый разговор с новым --session-id в том же cwd.
 */
export function resumeTarget(s: Pick<HookState, 'claudeSessionIds' | 'transcriptPath'>, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const last = s.claudeSessionIds.at(-1);
  return last && s.transcriptPath && path.basename(s.transcriptPath) === `${last}.jsonl` && exists(s.transcriptPath) ? last : undefined;
}

/**
 * Пространство и существующие теги знаний сессии; удалённые и испорченные пропускаются (сессия идёт без них), старый
 * тег задачи среди тегов — тоже: он перенесён в пространство.
 */
export function readSessionCtx(
  space: string | undefined,
  slugs: string[],
  deps: { space: (slug: string) => Space | undefined; tag: (slug: string) => Tag | undefined },
): SessionCtx {
  let s: Space | undefined;
  try {
    s = space ? deps.space(space) : undefined;
  } catch {
    s = undefined;
  }
  const knowledge: Tag[] = [];
  for (const slug of slugs) {
    try {
      const t = deps.tag(slug);
      if (t?.kind === 'knowledge') knowledge.push(t);
    } catch {
      /* битый tag.json: тег в сессию не идёт */
    }
  }
  return { ...(s ? { space: s } : {}), knowledge };
}

/** Запасной источник статуса без хуков (Esc не шлёт Stop): из `claude agents --json` — разговоры, которые простаивают. */
export function idleAgents(out: string): Set<string> {
  try {
    const list = JSON.parse(out) as unknown;
    if (!Array.isArray(list)) return new Set();
    return new Set(list.flatMap((a) => (a && typeof a === 'object' && a.status === 'idle' && typeof a.sessionId === 'string' ? [a.sessionId as string] : [])));
  } catch {
    return new Set();
  }
}
