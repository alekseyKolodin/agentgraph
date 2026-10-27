// Сессии терминала: обычная интерактивная сессия Claude Code (настоящий TUI `claude`) внутри agentgraph, с тегами.
// Здесь — чистая логика без pty и HTTP: поиск бинарника, аргументы claude, хуки и запреты записи в --settings, конфиг
// MCP-сервера agentgraph, окружение процесса, текст контекста тегов (полный — на SessionStart, изменения — на
// UserPromptSubmit и PostToolBatch) с бюджетом, разбор хуков и решение «продолжить разговор или начать новый».
// Теги заходят только штатными механизмами Claude Code: хуки из --settings отвечают additionalContext, полный текст
// тегов отдают инструменты knowledge_read и tag_read MCP-сервера agentgraph (sessions-mcp.ts). --append-system-prompt
// не используется: он замораживается на первом запросе. Процессы и экран — sessions-pty.ts, маршруты — sessions-server.ts.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { SessionPermissionMode, SessionStatus, Tag } from './api-types.js';
import { ARTIFACTS_DIR, isInside } from './artifacts.js';
import {
  attachDir, defuseMarkers, existingTagPaths, knowledgeBlock, knowledgeDirs, KNOWLEDGE_READ_TOOL, sessionTagBlock, summaryPreview, tagsDir, tagsRunDirs, titleSuffix,
} from './tags.js';

/** Имя MCP-сервера в конфиге claude: не knowledge, чтобы не столкнуться с сервером пользователя. */
export const SESSION_MCP_SERVER = 'agentgraph';
/** Инструмент полного текста тега задачи, когда теги задачи не влезли в бюджет хука и пришли строкой. */
export const TAG_READ_TOOL = 'tag_read';
/** Разрешены без подтверждения: только чтение тегов сессии. */
export const SESSION_ALLOWED_TOOLS = [KNOWLEDGE_READ_TOOL, TAG_READ_TOOL].map((t) => `mcp__${SESSION_MCP_SERVER}__${t}`);
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

/** Название сессии: из формы, иначе слаги тегов, иначе имя папки; одной строкой, не длиннее SESSION_NAME_MAX. */
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

// --- запуск claude

export type SessionTags = { task: Tag[]; knowledge: Tag[] };

/** Папки чтения тегов: пути и вложения тегов задач и знаний, артефакты прошлых запусков тегов задач. */
export function sessionTagDirs(tags: SessionTags, runsDir: string): string[] {
  return [...new Set([...tagsRunDirs(tags.task, runsDir), ...knowledgeDirs(tags.knowledge)])];
}

/**
 * Что теги сессии разрешают читать точно: папки (пути-папки тегов, их вложения, артефакты прошлых запусков тегов задач)
 * и отдельные файлы (путь тега — файл: только он, а не вся его папка). По этому списку хук PermissionRequest
 * пропускает чтение без вопроса.
 */
export type ReadTargets = { dirs: string[]; files: string[] };

export function sessionReadTargets(tags: SessionTags, runsDir: string): ReadTargets {
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const t of [...tags.task, ...tags.knowledge]) {
    for (const p of existingTagPaths(t).listed) (fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ? dirs : files).add(p);
    if (t.attachments.length) dirs.add(attachDir(t.slug));
  }
  for (const d of tagsRunDirs(tags.task, runsDir)) if (path.basename(d) === ARTIFACTS_DIR) dirs.add(d);
  return { dirs: [...dirs], files: [...files] };
}

/** Путь, с которым правило разрешений или --add-dir работает буквально: скобки, глоб-символы и перевод строки ломают правило. */
const plainPath = (d: string) => !/[()[\]*?{}\n]/.test(d);

/**
 * --add-dir и запрет записи. --add-dir открывает и запись, поэтому всё, что он открыл, вся папка тегов
 * (~/.agentgraph/tags: заметки, саммари, вложения) и артефакты прошлых запусков закрыты правилом Edit (оно же запрещает
 * Write). Пути тегов внутри cwd или содержащие его не трогаем: это сам проект, запрет закрыл бы его; папку тегов и
 * артефакты закрываем и внутри проекта — не закрываем, только если в них лежит сам cwd. Путь со спецсимволами правило
 * не поймает — такой папки нет ни в --add-dir, ни в запретах. filesDir — папка файлов, перетащенных в терминал.
 */
export function launchDirs(tagDirs: string[], cwd: string, filesDir: string, protectedDirs: string[] = []): { addDirs: string[]; denyDirs: string[] } {
  const add = tagDirs.filter((d) => !isInside(cwd, d) && !isInside(d, cwd) && plainPath(d));
  const root = tagsDir();
  const guard = [root, ...protectedDirs].filter((d) => !isInside(cwd, d) && plainPath(d));
  const deny = [...guard, ...add].filter((d, i, all) => all.indexOf(d) === i && !all.some((o) => o !== d && isInside(d, o) && guard.includes(o)));
  return { addDirs: [...add, filesDir], denyDirs: deny };
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
  model?: string;
  permissionMode?: SessionPermissionMode;
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
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: curl, timeout: 10 }] }],
      ...Object.fromEntries(HTTP_HOOKS.map((e) => [e, http])),
    },
    // //путь — абсолютный путь в правилах разрешений; Edit закрывает все инструменты записи файлов, правило Write(путь)
    // claude 2.1.311 не применяет и предупреждает о нём при старте. Сама папка — отдельным правилом: /** её не ловит
    permissions: { deny: l.denyDirs.flatMap((d) => [`Edit(/${d})`, `Edit(/${d}/**)`]) },
  };
}

/** HTTP MCP самого сервера agentgraph; alwaysLoad — инструменты сразу в контексте, без ToolSearch. */
export function sessionMcpConfig(l: SessionLaunch): Record<string, unknown> {
  return { mcpServers: { [SESSION_MCP_SERVER]: { type: 'http', url: `${base(l)}/mcp`, headers: { [SESSION_TOKEN_HEADER]: l.token }, alwaysLoad: true } } };
}

/**
 * argv для claude: запуск без shell, массивом, поэтому JSON не экранируется. Название — через `=`: начнись оно с дефиса,
 * claude принял бы его за флаг. Модель и режим разрешений — только если выбраны.
 */
export function sessionArgs(l: SessionLaunch): string[] {
  // id — через `=`: значение не может стать флагом, даже если бы пришло из хука кривым
  const args = [l.resume ? `--resume=${l.claudeSessionId}` : `--session-id=${l.claudeSessionId}`];
  args.push(`--name=${l.name}`, '--settings', JSON.stringify(sessionSettings(l)), '--mcp-config', JSON.stringify(sessionMcpConfig(l)));
  args.push('--allowedTools', SESSION_ALLOWED_TOOLS.join(','));
  for (const d of l.addDirs) args.push('--add-dir', d);
  if (l.model) args.push('--model', l.model);
  if (l.permissionMode) args.push('--permission-mode', l.permissionMode);
  return args;
}

/** Маркеры хоста и чужой сессии: унаследованные, они выключают транскрипт и хуки у дочернего claude. */
const ENV_DROP = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT',
]);
const ENV_DROP_PREFIX = ['CLAUDE_CODE_MESSAGING_', 'CLAUDE_AGENT_SDK_', 'CLAUDE_PREVIEW_'];
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

const withLocal = (list: string | undefined) => [...new Set([...(list ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...LOCAL_HOSTS])].join(',');

/**
 * Окружение claude: всё пользовательское (вход, провайдер, Bedrock, токены) остаётся, вычищаются только маркеры
 * хоста и сессии. Хуки и MCP идут на 127.0.0.1 мимо прокси (NO_PROXY), терминал — 256 цветов и truecolor.
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
  // CLAUDE.md папок тегов — как у этапов запуска (agent.ts)
  if (hasAddDirs) out.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1';
  return out;
}

// --- контекст тегов

const CONTEXT_HEAD =
  'Контекст тегов agentgraph для этой сессии. Теги меняют в agentgraph: изменения придут со следующим шагом или сообщением пользователя.';
const DELTA_HEAD = 'Теги agentgraph этой сессии изменились.';
const TASK_LIST_HEAD = `Теги задачи (полный текст — заметки, саммари, пути — инструментом ${TAG_READ_TOOL} со слагом; открой тег, прежде чем браться за его задачу):`;
const CUT_NOTE = '\n…(контекст тегов обрезан по лимиту хука)';
const LINE_MAX = 120;

const firstLine = (text: string) => text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
const clip = (s: string) => ([...s].length > LINE_MAX ? [...s].slice(0, LINE_MAX - 1).join('') + '…' : s);

/** Строка тега задачи, когда полные блоки не влезли: суть и что есть; полный текст — tag_read. */
export function taskTagLine(tag: Tag): string {
  const summary = tag.summary.trim();
  const notes = tag.notes.trim();
  const brief = clip(firstLine(summaryPreview(summary)) || firstLine(notes)) || 'саммари и заметок ещё нет';
  const paths = existingTagPaths(tag).listed.length;
  const stats = [
    ...(summary ? [`знаков саммари: ${summary.length}`] : []),
    ...(notes ? [`знаков заметок: ${notes.length}`] : []),
    ...(tag.attachments.length ? [`вложений: ${tag.attachments.length}`] : []),
    ...(paths ? [`путей: ${paths}`] : []),
  ];
  // первая строка саммари — текст модели: только строкой списка, без инструкций вокруг
  return `- ${tag.slug}${titleSuffix(tag)}: ${defuseMarkers(brief)}${stats.length ? ` (${stats.join(', ')})` : ''}`;
}

/** Части текста на уровне подробности: 0 — блоки целиком, 1 — теги задач строкой, 2 — и теги знаний «целиком» строкой. */
function parts(task: Tag[], knowledge: Tag[], level: number): string[] {
  const out = level === 0 ? task.map(sessionTagBlock) : task.length ? [[TASK_LIST_HEAD, ...task.map(taskTagLine)].join('\n')] : [];
  const k = knowledgeBlock(level < 2 ? knowledge : knowledge.map((t) => ({ ...t, inline: undefined })));
  return k ? [...out, k] : out;
}

/** Самый подробный вариант, который влезает в бюджет; не влез и самый краткий — обрезка с пометкой. */
function fit(head: string, variant: (level: number) => string[], budget: number): string {
  let text = '';
  for (const level of [0, 1, 2]) {
    text = [head, ...variant(level)].join('\n\n');
    if (text.length <= budget) return text;
  }
  return text.slice(0, budget - CUT_NOTE.length) + CUT_NOTE;
}

/** Полный контекст для SessionStart (старт, /clear, /resume, compact): все теги сессии. Без тегов — пусто. */
export function sessionContext(tags: SessionTags, budget = CONTEXT_BUDGET): string {
  if (!tags.task.length && !tags.knowledge.length) return '';
  return fit(CONTEXT_HEAD, (level) => parts(tags.task, tags.knowledge, level), budget);
}

/** Слаги, которые модель получит этим текстом: существующие теги сессии. */
export const tagSlugs = (tags: SessionTags): string[] => [...tags.task, ...tags.knowledge].map((t) => t.slug);

/**
 * Изменения тегов с прошлой доставки для UserPromptSubmit и PostToolBatch: блоки добавленных и строки о снятых.
 * Изменений нет — пустая строка.
 */
export function tagDelta(tags: SessionTags, injected: string[], budget = CONTEXT_BUDGET): string {
  const task = tags.task.filter((t) => !injected.includes(t.slug));
  const knowledge = tags.knowledge.filter((t) => !injected.includes(t.slug));
  const current = new Set(tagSlugs(tags));
  const removed = injected.filter((s) => !current.has(s));
  if (!task.length && !knowledge.length && !removed.length) return '';
  const gone = removed.length ? [removed.map((s) => `Тег ${s} снят: его контекст выше больше не действует.`).join('\n')] : [];
  return fit(DELTA_HEAD, (level) => [...parts(task, knowledge, level), ...gone], budget);
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
};

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function parseHookInput(raw: unknown): HookInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const event = str(r.hook_event_name);
  if (!event) return undefined;
  const input = r.tool_input && typeof r.tool_input === 'object' && !Array.isArray(r.tool_input) ? (r.tool_input as Record<string, unknown>) : undefined;
  const out: HookInput = { hook_event_name: event };
  for (const k of ['session_id', 'transcript_path', 'source', 'reason', 'agent_id', 'prompt', 'last_assistant_message', 'notification_type', 'tool_name'] as const) {
    const v = str(r[k]);
    if (v !== undefined) out[k] = v;
  }
  if (input) out.tool_input = input;
  return out;
}

/** Состояние сессии, которое читают и меняют хуки. */
export type HookState = {
  tags: string[];
  /** Теги, чей контекст модель уже получила; null — ещё ничего (SessionStart не приходил). */
  injected: string[] | null;
  status: SessionStatus;
  claudeSessionIds: string[];
  transcriptPath?: string;
  /** SessionStart приходил у этого процесса claude. */
  started: boolean;
  turns: number;
};

export type HookResult = {
  /** Тело ответа хуку. */
  reply: Record<string, unknown>;
  patch: Partial<HookState>;
  /** Набор тегов, который модель получит этим ответом: injected := delivered — только после того, как ответ ушёл. */
  delivered?: string[];
  /** Запись в журнал ходов: сообщение пользователя или итоговый ответ модели. */
  turn?: { prompt: string } | { answer: string };
};

export type HookDeps = {
  /** Существующие теги по слагам, по виду. */
  readTags: (slugs: string[]) => SessionTags;
  /** Что эти теги разрешают читать (sessionReadTargets). */
  readTargets: (tags: SessionTags) => ReadTargets;
  realpath: (p: string) => string;
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
  const event = input.hook_event_name;
  const tags = () => deps.readTags(s.tags);

  switch (event) {
    case 'SessionStart': {
      // любой source: после /clear, /resume и compact прежний контекст тегов модели уже не виден
      const t = tags();
      return { reply: withContext(event, sessionContext(t)), patch: { ...patch, started: true, status: 'waiting' }, delivered: tagSlugs(t) };
    }
    case 'UserPromptSubmit':
    case 'PostToolBatch': {
      // пачка инструментов сабагента: его контекст живёт отдельно, основной разговор изменения тегов не увидел бы
      if (input.agent_id) return { reply: {}, patch: { ...patch, status: 'working' } };
      const t = tags();
      const text = s.injected === null ? sessionContext(t) : tagDelta(t, s.injected);
      const working = { ...patch, status: 'working' as const };
      const turn = event === 'UserPromptSubmit' ? { prompt: input.prompt ?? '' } : undefined;
      if (event === 'UserPromptSubmit') working.turns = s.turns + 1;
      return { reply: withContext(event, text), patch: working, ...(text || s.injected === null ? { delivered: tagSlugs(t) } : {}), ...(turn ? { turn } : {}) };
    }
    case 'Stop':
      return { reply: {}, patch: { ...patch, status: 'waiting' }, turn: { answer: input.last_assistant_message ?? '' } };
    case 'StopFailure':
      return { reply: {}, patch: { ...patch, status: 'waiting' } };
    case 'Notification':
      return { reply: {}, patch: WAIT_NOTIFICATIONS.includes(input.notification_type ?? '') ? { ...patch, status: 'waiting' } : patch };
    case 'PermissionRequest':
      return { reply: permissionReply(input, deps.readTargets(tags()), deps.realpath), patch };
    default:
      return { reply: {}, patch };
  }
}

/**
 * Пути тега, добавленного на ходу: --add-dir в живом claude не меняется, и чтение из них спросило бы разрешение.
 * Чтение внутри папок и файлов текущих тегов разрешается — этот вызов и только он: папка в сессию не добавляется
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
    if (typeof pattern !== 'string' || path.isAbsolute(pattern) || pattern.startsWith('~') || pattern.split(/[\\/]/).includes('..')) return {};
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

/** Существующие теги сессии по виду; удалённый или испорченный тег пропускается. */
export function readSessionTags(slugs: string[], read: (slug: string) => Tag | undefined): SessionTags {
  const out: SessionTags = { task: [], knowledge: [] };
  for (const slug of slugs) {
    try {
      const t = read(slug);
      if (t) out[t.kind].push(t);
    } catch {
      /* битый tag.json: тег в сессию не идёт */
    }
  }
  return out;
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
