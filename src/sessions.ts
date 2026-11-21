// Сессии терминала: обычная интерактивная сессия Claude Code (настоящий TUI `claude`) внутри agentgraph, в пространстве
// и с тегами знаний. Здесь — чистая логика без pty и HTTP: поиск бинарника, аргументы claude, хуки и запреты записи в
// --settings, конфиг MCP-сервера agentgraph, окружение процесса, текст контекста (полный — на SessionStart, изменения —
// на UserPromptSubmit и PostToolBatch) с бюджетом, разбор хуков и решение «продолжить разговор или начать новый».
// Контекст заходит только штатными механизмами Claude Code: папка пространства — в --add-dir, и его CLAUDE.md claude
// грузит памятью сам; хуки из --settings отвечают additionalContext (шапка пространства, документы, состояние, строки
// тегов знаний); полный текст тега знаний отдаёт knowledge_read MCP-сервера agentgraph (sessions-mcp.ts). Сессия с
// оркестрацией agentgraph ведёт карту, документы и состояние своего пространства инструментами без вопроса и получает
// раздел среды (agentgraphNote). Иначе своё
// пространство и flow сессия меняет только с вопросом пользователю — инструментами space_*/flow_write или правкой
// файлов, которую решает хук записи (session-edit.ts). --append-system-prompt не используется: он замораживается на
// первом запросе. Процессы и экран — sessions-pty.ts, маршруты — sessions-server.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { SessionAsk, SessionPermissionMode, SessionStatus, Space, Tag } from './api-types.js';
import { isInside, WRITE_TOOLS } from './artifacts.js';
import { configDir } from './settings.js';
import { attachDir, existingTagPaths, knowledgeBlock, KNOWLEDGE_NOTE_TOOL, KNOWLEDGE_READ_TOOL, tagsDir } from './tags.js';
import { DESK_LIST_TOOL, DESK_PUT_TOOL } from './desk/tools.js';
import { existingSpacePaths, spaceArtifactDirs, spaceContext, spacesDir, SPACE_WRITE_TOOL } from './spaces.js';
import { teamsDir } from './teamwork.js';

/** Имя MCP-сервера в конфиге claude: не knowledge, чтобы не столкнуться с сервером пользователя. */
export const SESSION_MCP_SERVER = 'agentgraph';
/** Инструмент «открыть новую сессию»: не в SESSION_ALLOWED_TOOLS, и хук PreToolUse велит claude спросить даже в auto. */
export const SESSION_NEW_TOOL = 'session_new';
export const SESSION_NEW_FULL = `mcp__${SESSION_MCP_SERVER}__${SESSION_NEW_TOOL}`;
/** Запись документа пространства: как session_new — не в SESSION_ALLOWED_TOOLS, PreToolUse велит спросить всегда. */
export const SPACE_WRITE_FULL = `mcp__${SESSION_MCP_SERVER}__${SPACE_WRITE_TOOL}`;
/** Карта, состояние и настройки пространства сессии, flow в папке flow: тоже всегда с вопросом. */
export const SPACE_MAP_WRITE_TOOL = 'space_map_write';
export const SPACE_STATE_WRITE_TOOL = 'space_state_write';
export const SPACE_SETTINGS_TOOL = 'space_settings';
export const FLOW_WRITE_TOOL = 'flow_write';
export const SPACE_MAP_WRITE_FULL = `mcp__${SESSION_MCP_SERVER}__${SPACE_MAP_WRITE_TOOL}`;
export const SPACE_STATE_WRITE_FULL = `mcp__${SESSION_MCP_SERVER}__${SPACE_STATE_WRITE_TOOL}`;
export const SPACE_SETTINGS_FULL = `mcp__${SESSION_MCP_SERVER}__${SPACE_SETTINGS_TOOL}`;
export const FLOW_WRITE_FULL = `mcp__${SESSION_MCP_SERVER}__${FLOW_WRITE_TOOL}`;
/** Инструменты сессии из задачи Teamwork (spec §9.5): статус, PR и комментарий задачи; документ проекта. Оба всегда с вопросом. */
export const TEAM_TASK_UPDATE_TOOL = 'team_task_update';
export const TEAM_DOC_WRITE_TOOL = 'team_doc_write';
export const TEAM_TASK_UPDATE_FULL = `mcp__${SESSION_MCP_SERVER}__${TEAM_TASK_UPDATE_TOOL}`;
export const TEAM_DOC_WRITE_FULL = `mcp__${SESSION_MCP_SERVER}__${TEAM_DOC_WRITE_TOOL}`;
/** Запись знания в тег (docs/desk/SPEC.md, 6.6): заметки тега уходят промптом следующим сессиям и запускам — с вопросом. */
export const KNOWLEDGE_NOTE_FULL = `mcp__${SESSION_MCP_SERVER}__${KNOWLEDGE_NOTE_TOOL}`;
/** Оркестрация: как писать flow, разовый запуск flow, его состояние, ответ на вопрос агента, остановка. */
export const FLOW_GUIDE_TOOL = 'flow_guide';
export const FLOW_RUN_TOOL = 'flow_run';
export const FLOW_STATUS_TOOL = 'flow_status';
export const FLOW_ANSWER_TOOL = 'flow_answer';
export const FLOW_STOP_TOOL = 'flow_stop';
/** Инструменты оркестрации: есть только у сессии с оркестрацией agentgraph. */
export const ORCHESTRATE_TOOLS = [FLOW_GUIDE_TOOL, FLOW_RUN_TOOL, FLOW_STATUS_TOOL, FLOW_ANSWER_TOOL, FLOW_STOP_TOOL] as const;
const full = (t: string) => `mcp__${SESSION_MCP_SERVER}__${t}`;
/**
 * Сессия с оркестрацией работает сама, без вопроса пользователю: ведёт своё пространство (документы, карта, состояние —
 * решение владельца 21.11: «сессия должна иметь права всё это менять»), заводит дело и работает с flow. Настройки
 * пространства (папки чтения открываются всем), flow в библиотеке, новая сессия, знание и задача Teamwork — с вопросом.
 * flow_run тоже без вопроса (решение владельца 21.11: оркестратор работает сам); от этапа с полными правами защищает
 * проверка разового flow и папки запуска (session-flows.ts). Проверка до записи остаётся в обработчиках MCP (sessions-server.ts).
 */
export const ORCHESTRATE_ALLOWED_TOOLS: string[] = [SPACE_WRITE_TOOL, SPACE_MAP_WRITE_TOOL, SPACE_STATE_WRITE_TOOL, DESK_PUT_TOOL, ...ORCHESTRATE_TOOLS].map(full);
/** Инструменты, о каждом вызове которых спрашивают человека: хук PreToolUse отвечает ask (в dontAsk — отказ с причиной). */
const ASK_TOOLS: Record<string, string> = {
  [SESSION_NEW_FULL]: 'agentgraph: новая сессия запустит claude с заданием от модели',
  [SPACE_WRITE_FULL]: 'agentgraph: документ пространства увидят все следующие сессии и запуски',
  [SPACE_MAP_WRITE_FULL]: 'agentgraph: карту пространства получат памятью все следующие сессии и запуски',
  [SPACE_STATE_WRITE_FULL]: 'agentgraph: состояние пространства получат следующие сессии и запуски',
  [SPACE_SETTINGS_FULL]: 'agentgraph: настройки пространства (space.json) — его папки чтения откроются всем сессиям и запускам',
  [FLOW_WRITE_FULL]: 'agentgraph: flow запишется в папку flow — его возьмут следующие запуски',
  [TEAM_TASK_UPDATE_FULL]: 'agentgraph: изменение задачи Teamwork уйдёт коммитом в репо команды',
  [TEAM_DOC_WRITE_FULL]: 'agentgraph: документ проекта Teamwork уйдёт коммитом в репо команды',
  [KNOWLEDGE_NOTE_FULL]: 'agentgraph: запись в тег знаний получат промптом все следующие сессии и запуски с этим тегом',
};
/** С этой версии claude у HTTP-хука есть onFailure: block — сбой хука блокирует вызов, а не пропускает его. */
export const HOOK_ON_FAILURE_SINCE = '2.1.295';
/**
 * Режимы без вопросов: bypassPermissions пропускает проверки, dontAsk отклоняет всё, что не разрешено заранее. В dontAsk
 * preToolDecision отказывает раньше проверки версии (правило ask claude там превращает в отказ без вопроса).
 */
export const NO_ASK_MODES = ['bypassPermissions', 'dontAsk'];
/**
 * С этой версии claude показывает вопрос хука («ask») и в bypassPermissions — измерено сценарием ask-modes
 * scripts/check-sdk-hooks.mts на Claude Code из Agent SDK 0.3.285. claude старше или неизвестной версии там вместо
 * вопроса получает отказ: правка с разрешения человека не должна стать тихой.
 */
export const ASK_IN_ANY_MODE_SINCE = '2.1.285';
/**
 * Режимы, где хук сверяет команды Bash со своим пространством и папкой flow: в bypassPermissions claude пускает
 * файловую команду в папку под правилом ask без вопроса (check-sdk-hooks, session-edit). В default и acceptEdits он
 * спрашивает сам, в dontAsk отказывает; auto не измерен (на haiku недоступен) — хук там не ставим, чтобы не спрашивать
 * на каждую команду в режиме, который предлагает форма.
 */
export const BASH_GUARD_MODES = ['bypassPermissions'];
/** Инструменты записи файлов: хук PreToolUse сверяет путь в момент вызова, PostToolUse — проверяет записанное. */
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

/**
 * Разрешены без подтверждения: только чтение — тегов знаний сессии и дел (desk_list). desk_put и desk_close — не здесь и
 * не в ASK_TOOLS: личная доска, о вызове спрашивает сам claude по режиму разрешений сессии.
 */
export const SESSION_ALLOWED_TOOLS = [KNOWLEDGE_READ_TOOL, DESK_LIST_TOOL].map((t) => `mcp__${SESSION_MCP_SERVER}__${t}`);

/** --allowedTools сессии: с оркестрацией — ещё ведение пространства, desk_put и инструменты flow. */
export const sessionAllowedTools = (orchestrate?: boolean): string[] => (orchestrate ? [...SESSION_ALLOWED_TOOLS, ...ORCHESTRATE_ALLOWED_TOOLS] : SESSION_ALLOWED_TOOLS);

/** Инструменты agentgraph с вопросом человеку: с оркестрацией — без тех, что сессия делает сама. */
export const askTools = (orchestrate?: boolean): string[] => Object.keys(ASK_TOOLS).filter((t) => !orchestrate || !ORCHESTRATE_ALLOWED_TOOLS.includes(t));
/** Заголовок с токеном сессии у хуков и MCP: без него (или с чужим) — 404. */
export const SESSION_TOKEN_HEADER = 'X-Agentgraph-Session';
/** Живых сессий не больше: каждый claude занимает около 300 МБ. */
export const LIVE_SESSIONS_MAX = 6;
/** Claude Code режет additionalContext хука после 10 000 знаков (дальше — файл и превью на 2 КБ), держим запас. */
export const CONTEXT_BUDGET = 8500;
/** Предел additionalContext с запасом: контекст и новости о запусках вместе. */
const CONTEXT_LIMIT = 9800;
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

/**
 * Что сессия получает от agentgraph: пространство (может не быть) и теги знаний — существующие на момент чтения;
 * orchestrate — сессия с оркестрацией agentgraph (раздел среды и ведение пространства без вопроса).
 */
export type SessionCtx = { space?: Space; knowledge: Tag[]; orchestrate?: boolean };

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

/** Что launchDirs знает о сессии сверх папок: свои пространства и папка flow — их правка с вопросом. */
export type LaunchEdit = {
  /** Свои пространства (слаги): выбранное у сессии и то, в папке которого она открыта. */
  spaces?: string[];
  /** Папка flow (FLOWS_DIR). */
  flowsDir?: string;
};

/**
 * --add-dir, запреты и вопросы записи. --add-dir открывает и запись, поэтому всё, что он открыл (кроме своего
 * пространства и папки flow), вся папка тегов (~/.agentgraph/tags), вся папка команд Teamwork (~/.agentgraph/teams: клоны
 * репо команд), артефакты прошлых запусков, служебные файлы папки настроек (settings.json, jira-token…) и все
 * пространства, кроме своих, закрыты правилом Edit (оно же запрещает Write; что из этого Claude Code применяет к
 * файловым командам Bash — его дело, поэтому запрет не снимается и там, где хук записи отказал бы сам). Без своего
 * пространства закрыта вся папка пространств, как раньше.
 * Своё пространство и папка flow — вопросом (permissions.ask держит его и в acceptEdits, и в auto) на каждую правку:
 * их сессия правит с разрешения пользователя (решение владельца). Правила — снимок на старте: пространство, заведённое
 * потом, и выбранное на ходу закрыты хуком записи (session-edit.ts) — выбранное на ходу правится инструментами space_*
 * сразу, а файлами — после «Перезапустить» (правила пересчитываются).
 * Пути внутри cwd или содержащие его не трогаем: это сам проект, запрет закрыл бы его; папки тегов, команд, пространств и
 * артефакты закрываем и внутри проекта — не закрываем, только если в них лежит сам cwd. Путь со спецсимволами правило не
 * поймает — такой папки нет ни в --add-dir, ни в запретах (решает хук). filesDir — папка файлов, перетащенных в терминал.
 */
export function launchDirs(
  readDirs: string[],
  cwd: string,
  filesDir: string,
  protectedDirs: string[] = [],
  edit: LaunchEdit = {},
): { addDirs: string[]; denyDirs: string[]; denyFiles: string[]; askDirs: string[] } {
  const add = readDirs.filter((d) => !isInside(cwd, d) && !isInside(d, cwd) && plainPath(d));
  const spaces = spacesDir();
  const flows = edit.flowsDir;
  const own = new Set((edit.spaces ?? []).map((s) => path.join(spaces, s)));
  const cur = isInside(cwd, spaces) ? path.relative(spaces, cwd).split(path.sep)[0] : '';
  if (cur) own.add(path.join(spaces, cur));
  // папка команд Teamwork (клоны репо команд) закрыта так же, как теги: данные команды меняет только API; без своего
  // пространства — и вся папка пространств
  const guard = [tagsDir(), teamsDir(), ...(own.size ? [] : [spaces]), ...protectedDirs].filter((d) => !isInside(cwd, d) && plainPath(d));
  const others: string[] = [];
  const denyFiles = own.size ? [path.join(spaces, '.migrated.json')] : [];
  if (own.size) {
    for (const name of readdirSafe(spaces)) {
      const d = path.join(spaces, name);
      if (own.has(d) || !plainPath(d)) continue;
      const st = fs.lstatSync(d, { throwIfNoEntry: false });
      if (st?.isDirectory()) others.push(d);
      else if (st && !denyFiles.includes(d)) denyFiles.push(d);
    }
  }
  denyFiles.push(...configFiles(cwd));
  // папки чтения внутри своего пространства и папки flow запретом не закрываем: их правку решают вопрос и хук записи
  const open = add.filter((d) => ![...own].some((o) => isInside(d, o)) && !(flows && isInside(d, flows)));
  const all = [...guard, ...open, ...others];
  const deny = all.filter((d, i) => all.indexOf(d) === i && !all.some((o) => o !== d && isInside(d, o) && (guard.includes(o) || others.includes(o))));
  const askDirs = [...(own.size ? [...own] : []), ...(flows ? [flows] : [])].filter(plainPath);
  // ~/.agentgraph может быть ссылкой: правило с лексическим путём реальный путь не поймало бы — добавляем и его
  return { addDirs: [...add, filesDir], denyDirs: withRealpaths(deny), denyFiles: withRealpaths(denyFiles.filter(plainPath)), askDirs: withRealpaths(askDirs) };
}

/**
 * Служебные файлы прямо в папке настроек agentgraph (settings.json, jira-token…): закрыты правилом. Папки внутри — не
 * здесь (пространства, теги, команды — выше; рабочие папки и worktree — проекты сессий). Папка настроек шире разумного
 * (домашняя, корень) — не трогаем: запрет закрыл бы чужие файлы; cwd в ней самой — тоже (это проект).
 */
function configFiles(cwd: string): string[] {
  const cfg = path.resolve(configDir());
  if (cfg === path.parse(cfg).root || cfg === os.homedir() || cwd === cfg || !plainPath(cfg)) return [];
  return readdirSafe(cfg).map((n) => path.join(cfg, n)).filter((f) => fs.lstatSync(f, { throwIfNoEntry: false })?.isFile());
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
  /** Отдельные файлы (или шаблоны с *) под запретом Edit: служебные файлы папок настроек и пространств. */
  denyFiles?: string[];
  /** Папки, правка в которых всегда с вопросом (permissions.ask): папка пространств и папка flow. */
  askDirs?: string[];
  /** Версия claude, если известна: от неё зависит onFailure у HTTP-хука PreToolUse. */
  claudeVersion?: string;
  model?: string;
  permissionMode?: SessionPermissionMode;
  /** Первое сообщение: claude отправит его сам, как `claude "задача"` (у --resume — следом за прошлым разговором). */
  prompt?: string;
  /** Оркестрация agentgraph: сессия сама ведёт пространство, заводит дело и запускает flow (ORCHESTRATE_ALLOWED_TOOLS). */
  orchestrate?: boolean;
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
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: curl, timeout: 10 }] }],
      ...Object.fromEntries(HTTP_HOOKS.map((e) => [e, http])),
      // хук записи — у каждой сессии: путь сверяется в момент вызова (handleHook → writeGuard, session-edit.ts) —
      // чужое пространство, теги, папка команд — отказ, своё пространство и flow — вопрос с проверкой до записи
      // Bash — без onFailure: block: эвристика для bypassPermissions (BASH_GUARD_MODES) не должна останавливать каждую
      // команду, когда сервер agentgraph недоступен
      PreToolUse: [...askTools(l.orchestrate).map((matcher) => ({ matcher, hooks: [askHook] })), { matcher: WRITE_MATCHER, hooks: [askHook] }, { matcher: 'Bash', hooks: http[0].hooks }],
      // после записи: проверенный файл (space.json, карта, состояние, flow) — ещё раз на диске, UI — обновить
      // и после любого инструмента без матчера: разрешённый вызов снимает «Ждёт разрешения» (handleHook → PostToolUse)
      PostToolUse: http,
    },
    // //путь — абсолютный путь в правилах разрешений; Edit закрывает все инструменты записи файлов, правило Write(путь)
    // claude 2.1.311 не применяет и предупреждает о нём при старте. Сама папка — отдельным правилом: /** её не ловит.
    // ask — инструменты agentgraph спрашивают и без хука (явное правило ask держит вопрос и в auto), плюс папка
    // пространств и папка flow: сбой хука или старый claude не делают правку там тихой
    permissions: {
      deny: [...l.denyDirs.flatMap(dirRules), ...(l.denyFiles ?? []).map((f) => `Edit(/${f})`)],
      ask: [...askTools(l.orchestrate), ...(l.askDirs ?? []).flatMap(dirRules)],
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
  args.push('--allowedTools', sessionAllowedTools(l.orchestrate).join(','));
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
function parts(space: Space | undefined, knowledge: Tag[], mapLoaded: boolean, level: number, steward = false): string[] {
  const out: string[] = [];
  if (space) out.push(spaceContext(space, { where: 'session', mapLoaded, docsMax: level === 0 ? undefined : level === 1 ? 5 : 0, ...(steward ? { steward } : {}) }));
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
  // раздел среды — первым и целиком: без него сессия не знает, что ведёт пространство и может запускать flow
  const env = ctx.orchestrate ? agentgraphNote({ space: ctx.space?.slug }) : '';
  if (!ctx.space && !ctx.knowledge.length) return env;
  const mapLoaded = Boolean(ctx.space && ctx.space.slug === launchSpace);
  const rest = fit(CONTEXT_HEAD, (level) => parts(ctx.space, ctx.knowledge, mapLoaded, level, ctx.orchestrate), budget - (env ? env.length + 2 : 0));
  return env ? `${env}\n\n${rest}` : rest;
}

/**
 * Раздел среды для сессии с оркестрацией: где она работает, как вести пространство (знание, а не журнал), когда заводить
 * дело и как решать большую задачу через flow. Приходит на SessionStart (и после /clear, compact) — целиком, до бюджета.
 */
export function agentgraphNote(o: { space?: string } = {}): string {
  const lines = [
    'Ты работаешь в agentgraph — среде, где сессии, пространства, дела и flow связаны в одну работу. Инструменты MCP-сервера agentgraph — твои рабочие инструменты: пользуйся ими сам, не дожидаясь просьбы.',
    '',
    o.space
      ? `Пространство ${o.space} — память этой работы для следующих сессий и запусков, и ведёшь его ты, по ходу работы, а не в конце:`
      : 'У сессии пока нет пространства — памяти для следующих сессий. Когда у работы появятся цель и решения, предложи пользователю выбрать или завести пространство в строке сессии. Как его вести:',
    `- карта (${SPACE_MAP_WRITE_TOOL}) — инструкция следующей сессии: цель пространства, какую задачу решаем, где что лежит (документы, код, индексы, команды проверки), договорённости;`,
    `- документы (${SPACE_WRITE_TOOL}) — решения (ADR), спеки, исследования: по файлу на тему, ссылки на них — в карте;`,
    `- состояние (${SPACE_STATE_WRITE_TOOL}) — где мы сейчас: что сделано, что в работе, что дальше, открытые вопросы.`,
    'Пиши знание, а не журнал. Плохо: «поправил файл X, потом собрал тесты, всё ок». Хорошо: «цель — оптимизация Y; решения — docs/adr-*.md; сейчас — шаг 2 из 3, дальше — Z». Обновляй, когда принято решение, сменился план или закончен заметный кусок; перед записью прочитай текущий текст.',
    '',
    `Дела (${DESK_PUT_TOOL}, desk_list, desk_close) — доска пользователя «Мои дела». Сессия — это работа по делу: когда работа оформилась в задачу (больше пары ходов, нужна передача, ревью, MR), заведи дело ${DESK_PUT_TOOL} с заголовком задачи, без вопроса пользователю; важное по ходу дописывай в него (text). Открыл MR или PR — ${DESK_PUT_TOOL} с thing = адрес MR: он привяжется к делу этой сессии, и события GitLab/GitHub лягут в его историю, а не новым делом.`,
    '',
    `Flow (${FLOW_GUIDE_TOOL}, ${FLOW_RUN_TOOL}, ${FLOW_STATUS_TOOL}, ${FLOW_ANSWER_TOOL}, ${FLOW_STOP_TOOL}) — запуски агентов по этапам. Маленькую задачу (несколько правок, ответ на вопрос) делай сам. Если задача не маленькая — независимые части, исследование + реализация + независимая проверка, долгий цикл «правка → тесты» — выступай оркестратором: разбей её, возьми готовый flow или собери разовый (${FLOW_GUIDE_TOOL} — правила и пример), запусти ${FLOW_RUN_TOOL} (без вопроса пользователю), следи за ним ${FLOW_STATUS_TOOL} (wait_seconds — подождать изменения), отвечай на вопросы его агентов ${FLOW_ANSWER_TOOL}, проверь результат сам и реши, что дальше. Запуски видны пользователю под этой сессией; что они дали — внеси в пространство.`,
  ];
  return lines.join('\n');
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
  return fit(DELTA_HEAD, (level) => [...(gone.length ? [gone.join('\n')] : []), ...parts(space, knowledge, mapLoaded, level, ctx.orchestrate)], budget);
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
  /** Рабочая папка claude в момент хука: от неё — относительные пути инструментов. */
  cwd?: string;
  /** id вызова инструмента: PreToolUse и PostToolUse одного вызова — по нему (снимок файла до записи). */
  tool_use_id?: string;
  /** Текст уведомления (Notification): «Claude needs your permission to use Bash». */
  message?: string;
};

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function parseHookInput(raw: unknown): HookInput | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const event = str(r.hook_event_name);
  if (!event) return undefined;
  const input = r.tool_input && typeof r.tool_input === 'object' && !Array.isArray(r.tool_input) ? (r.tool_input as Record<string, unknown>) : undefined;
  const out: HookInput = { hook_event_name: event };
  for (const k of ['session_id', 'transcript_path', 'source', 'reason', 'agent_id', 'prompt', 'last_assistant_message', 'notification_type', 'tool_name', 'permission_mode', 'cwd', 'tool_use_id', 'message'] as const) {
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
  /** Открытый вопрос человеку (вопрос в ответе, разрешение, форма MCP); в правке null — снят. */
  ask?: SessionAsk | null;
  /** Сессия с оркестрацией agentgraph: раздел среды в контексте, пространство — без вопроса. */
  orchestrate?: boolean;
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
  /**
   * Подробности к вопросу PreToolUse: что сделает этот вызов (папка, пространство, режим новой сессии; какой документ).
   * { deny } — вызов не пройдёт проверку (схема flow, папки пространства): отказ с причиной, без вопроса человеку.
   */
  askDetail?: (tool: string, input: Record<string, unknown>) => string | { deny: string } | undefined;
  /**
   * Запись файла: deny — отказ с объяснением, ask — вопрос человеку с подробностями (своё пространство, flow);
   * undefined — решают правила и режим. call — вход хука: рабочая папка claude и id вызова.
   */
  writeGuard?: (tool: string, input: Record<string, unknown>, call: WriteCall) => WriteVerdict | undefined;
  /** После записи (PostToolUse): строка — что сказать модели (проверка на диске не прошла, файл откачен). */
  afterWrite?: (tool: string, input: Record<string, unknown>, call: WriteCall) => string | undefined;
  /** Версия claude этой сессии (claude --version): от неё — вопрос или отказ в NO_ASK_MODES. Нет — неизвестна. */
  claudeVersion?: () => string | undefined;
  /**
   * Команда Bash в BASH_GUARD_MODES: ask — она трогает своё пространство или папку flow; deny — заодно и закрытое;
   * undefined — ни то, ни другое.
   */
  bashGuard?: (command: string, call: WriteCall) => WriteVerdict | undefined;
  /** Время для ask.at; по умолчанию — сейчас. */
  now?: () => string;
  /** Инструменты agentgraph, которые сессия вызывает без вопроса (оркестрация): хук их не спрашивает. */
  autoTools?: readonly string[];
  /**
   * Новости о запусках этой сессии (закончился, ждёт ответа) — забираются целиком: строка уходит модели со следующим
   * сообщением или шагом основного разговора. Пусто — новостей нет.
   */
  runNotes?: (room: number) => string;
};
/** Что нужно решению PreToolUse: сессия терминала и сценарий check-sdk-hooks решают одной функцией. */
export type PreToolDeps = Pick<HookDeps, 'askDetail' | 'writeGuard' | 'claudeVersion' | 'bashGuard' | 'autoTools'>;

/** Что хук записи знает о вызове из входа хука. */
export type WriteCall = { cwd?: string; toolUseId?: string };
export type WriteVerdict = { decision: 'deny' | 'ask'; reason: string };

/** Ожидание человека в TUI: запрос разрешения, простой, форма MCP. */
const WAIT_NOTIFICATIONS = ['permission_prompt', 'idle_prompt', 'elicitation_dialog'];
/** Уведомления, после которых сессия ждёт ответа (а не просто простаивает): вид вопроса. */
const ASK_NOTIFICATIONS: Record<string, SessionAsk['kind']> = { permission_prompt: 'permission', elicitation_dialog: 'elicitation' };
/** Текст вопроса в записи сессии не длиннее: начало длинного абзаца режется, вопрос — в конце. */
export const ASK_TEXT_MAX = 400;

/** Одной строкой и не длиннее ASK_TEXT_MAX: длинное режется с начала — вопрос обычно в конце абзаца. */
export function askText(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length <= ASK_TEXT_MAX ? text : `…${text.slice(text.length - ASK_TEXT_MAX + 1).trimStart()}`;
}

/** Строка — пункт списка: «- a», «* a», «1. a», «2) a». */
const LIST_ITEM_RE = /^\s*(?:[-*+•]|\d{1,2}[.)])\s+\S/;
/**
 * Хвост строки, который не меняет её конец: разметка выделения, закрывающие скобки и «(y/n)». Кавычки — нет: «…почему
 * падает?»» — цитата чужого вопроса, а не вопрос человеку.
 */
const TAIL_RE = /(?:\s*\((?:y\/n|да\/нет)\))?[\s*_`)\]]*$/iu;
const endsWithQ = (line: string) => /[?？]$/.test(line.replace(TAIL_RE, ''));
/** Заголовок или строка целиком жирным: «## Почему падало?» над списком — подпись сводки, а не вопрос. */
const isHeading = (line: string) => /^#+\s/.test(line) || /^(\*\*|__).*\1$/.test(line.trim());
/** Абзац — код с отступом: «?» в нём не вопрос. */
const isIndentedCode = (para: string) => para.split('\n').every((l) => /^( {4}|\t)/.test(l));
/** Текст вопроса без разметки заголовка, цитаты и выделения: его покажут простой строкой. */
const plain = (t: string) => t.replace(/^(?:#+|>)\s*/gm, '').replace(/\*\*|__/g, '');

/**
 * Вопрос в конце ответа Claude — без модели: последний абзац (после пустой строки; блок кода в конце — не вопрос)
 * кончается знаком вопроса, или последний абзац — список вариантов, а строка перед ним — вопрос («Как сделать?» и
 * варианты). Возвращает текст вопроса одной строкой; не вопрос — undefined.
 */
export function questionOf(answer: string): string | undefined {
  const text = answer.replace(/\r\n?/g, '\n').trim();
  if (!text || text.endsWith('```')) return undefined;
  const raw = text.split(/\n\s*\n/).filter((p) => p.trim());
  if (!raw.length || isIndentedCode(raw.at(-1)!)) return undefined;
  const paras = raw.map((p) => p.trim());
  const last = paras.at(-1)!;
  if (endsWithQ(last)) return askText(plain(last));
  const lines = last.split('\n');
  const items = lines.findIndex((l) => LIST_ITEM_RE.test(l));
  if (items < 0 || !lines.slice(items).every((l) => LIST_ITEM_RE.test(l) || /^\s+\S/.test(l))) return undefined;
  // строка вопроса — в том же абзаце над списком или абзацем выше
  const head = items > 0 ? lines.slice(0, items).join(' ') : paras.at(-2);
  if (!head || isHeading(head.trim()) || !endsWithQ(head.trim())) return undefined;
  return askText(plain(`${head.trim()} ${lines.slice(items).map((l) => l.trim()).join(' ')}`));
}

/** Что просят разрешить: инструмент и его главный аргумент (команда, файл, адрес). AskUserQuestion — его вопросы. */
function permissionAsk(input: HookInput): Pick<SessionAsk, 'kind' | 'text'> {
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};
  if (tool === 'AskUserQuestion' && Array.isArray(args.questions)) {
    const qs = args.questions.flatMap((q) => (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' ? [(q as { question: string }).question] : []));
    if (qs.length) return { kind: 'question', text: askText(qs.join(' · ')) };
  }
  const main = ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern', 'query', 'description'].map((k) => args[k]).find((v) => typeof v === 'string' && v.trim());
  return { kind: 'permission', text: askText(main ? `${tool}: ${main as string}` : tool || (input.message ?? '')) };
}
/** Чтение файлов: какой ключ tool_input несёт путь. */
const READ_TOOLS: Record<string, string> = { Read: 'file_path', Grep: 'path', Glob: 'path' };
/** id разговора Claude Code — UUID; другое в --resume не пойдёт. */
const CLAUDE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const withContext = (event: string, text: string) => (text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {});
const preToolReply = (decision: 'deny' | 'ask', reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });

/**
 * Ответ хука PreToolUse: вопрос человеку, отказ с причиной или {} (решают правила и режим claude).
 * - Вопрос в dontAsk не дойдёт до человека: правило ask из --settings claude там превращает в отказ без вопроса
 *   (check-sdk-hooks: space-session, session-edit), — отказываем сами, с причиной для модели.
 * - bypassPermissions: вопрос хука claude показывает с ASK_IN_ANY_MODE_SINCE (ask-modes); старше или неизвестной
 *   версии — отказ: правка с разрешения человека не должна стать тихой.
 */
export function preToolDecision(input: HookInput, deps: PreToolDeps): Record<string, unknown> {
  const call: WriteCall = { cwd: input.cwd, toolUseId: input.tool_use_id };
  const mode = input.permission_mode;
  const ask = (reason: string) => {
    if (mode === 'dontAsk') return preToolReply('deny', `${reason}. В режиме dontAsk claude не показывает вопрос, а это действие — только с разрешения пользователя: отклонено. Попроси пользователя переключить режим (Shift+Tab).`);
    const version = deps.claudeVersion?.();
    if (!mode || !NO_ASK_MODES.includes(mode) || versionAtLeast(version, ASK_IN_ANY_MODE_SINCE)) return preToolReply('ask', reason);
    const v = version?.match(/\d+\.\d+\.\d+/)?.[0];
    return preToolReply('deny', `В режиме ${mode} claude ${v ?? 'неизвестной версии'} может не показать вопрос (он проверен с ${ASK_IN_ANY_MODE_SINCE}), а это действие — только с разрешения пользователя: отклонено. Попроси пользователя переключить режим (Shift+Tab) или обновить claude.`);
  };
  const tool = input.tool_name ?? '';
  if (WRITE_TOOLS.includes(tool) && deps.writeGuard) {
    let v: WriteVerdict | undefined;
    try {
      v = deps.writeGuard(tool, input.tool_input ?? {}, call);
    } catch (err) {
      // упавшая проверка не пропускает запись
      v = { decision: 'deny', reason: `Проверка записи не удалась (${err instanceof Error ? err.message : String(err)}): вызов отклонён.` };
    }
    return !v ? {} : v.decision === 'ask' ? ask(v.reason) : preToolReply('deny', v.reason);
  }
  if (tool === 'Bash') {
    if (!deps.bashGuard || !BASH_GUARD_MODES.includes(mode ?? '')) return {};
    const command = input.tool_input?.command;
    let v: WriteVerdict | undefined;
    try {
      v = typeof command === 'string' ? deps.bashGuard(command, call) : undefined;
    } catch (err) {
      // эвристика, а не граница: упала — спрашиваем, а не отказываем
      v = { decision: 'ask', reason: `Проверка команды не удалась (${err instanceof Error ? err.message : String(err)})` };
    }
    return !v ? {} : v.decision === 'ask' ? ask(v.reason) : preToolReply('deny', v.reason);
  }
  // session_new запускает claude с текстом модели, space_* и flow_write пишут то, что получат все следующие сессии и
  // запуски: спрашиваем человека в любом режиме (в dontAsk и у старого claude в bypassPermissions — отказ, см. выше)
  const why = ASK_TOOLS[tool];
  if (!why || deps.autoTools?.includes(tool)) return {};
  let detail: string | { deny: string } | undefined;
  try {
    detail = deps.askDetail?.(tool, input.tool_input ?? {});
  } catch {
    detail = undefined;
  }
  if (detail && typeof detail === 'object') return preToolReply('deny', detail.deny);
  return ask(detail ? `${why}. ${detail}` : why);
}

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
  const ctx = (): SessionCtx => ({ ...deps.readCtx(s.space, s.tags), ...(s.orchestrate ? { orchestrate: true } : {}) });
  const now = deps.now ?? (() => new Date().toISOString());

  switch (event) {
    case 'SessionStart': {
      // любой source: после /clear, /resume и compact прежний контекст модели уже не виден (карта — память, её claude
      // загрузит сам)
      const c = ctx();
      const text = sessionContext(c, s.launchSpace);
      const note = input.source === 'resume' && s.preSpacesTags?.length ? preSpacesNote(s.preSpacesTags) : '';
      // /clear — новый разговор: вопрос прошлого больше не ждёт ответа; «Продолжить» и /resume его сохраняют
      const cleared = input.source === 'clear' && s.ask ? { ask: null } : {};
      return { reply: withContext(event, [note, text].filter(Boolean).join('\n\n')), patch: { ...patch, ...cleared, started: true, status: 'waiting' }, delivered: delivered(c) };
    }
    case 'UserPromptSubmit':
    case 'PostToolBatch': {
      // пачка инструментов сабагента: его контекст живёт отдельно, основной разговор изменения не увидел бы. Разрешения
      // ждёт другой сабагент (или основной разговор) — его вопрос и «ждёт» остаются: диалог в TUI ещё висит
      if (input.agent_id) {
        if (s.ask && s.ask.agent !== input.agent_id) return { reply: {}, patch };
        return { reply: {}, patch: { ...patch, ...(s.ask ? { ask: null } : {}), status: 'working' } };
      }
      // ответили или модель пошла дальше (разрешение дали): вопроса больше нет
      if (s.ask) patch.ask = null;
      const c = ctx();
      const ctxText = s.injected === null ? sessionContext(c, s.launchSpace) : contextDelta(c, s.injected, s.launchSpace);
      // новости — в то, что осталось до предела additionalContext у Claude Code (10 000 знаков)
      const news = deps.runNotes?.(CONTEXT_LIMIT - ctxText.length) ?? '';
      const text = [ctxText, news].filter(Boolean).join('\n\n');
      const working = { ...patch, status: 'working' as const };
      const turn = event === 'UserPromptSubmit' ? { prompt: input.prompt ?? '' } : undefined;
      if (event === 'UserPromptSubmit') working.turns = s.turns + 1;
      return { reply: withContext(event, text), patch: working, ...(ctxText || s.injected === null ? { delivered: delivered(c) } : {}), ...(turn ? { turn } : {}) };
    }
    case 'Stop': {
      // ждёт ответа, только если ответ кончился вопросом; иначе — просто закончил ход
      const answer = input.last_assistant_message ?? '';
      const q = questionOf(answer);
      const ask = q ? { kind: 'question' as const, text: q, at: now() } : s.ask ? null : undefined;
      return { reply: {}, patch: { ...patch, status: 'waiting', ...(ask !== undefined ? { ask } : {}) }, turn: { answer } };
    }
    case 'StopFailure':
      return { reply: {}, patch: { ...patch, status: 'waiting', ...(s.ask ? { ask: null } : {}) } };
    case 'Notification': {
      const type = input.notification_type ?? '';
      if (!WAIT_NOTIFICATIONS.includes(type)) return { reply: {}, patch };
      const kind = ASK_NOTIFICATIONS[type];
      // запрос разрешения уже записал PermissionRequest с инструментом — уведомление его не затирает
      const ask = kind && !(kind === 'permission' && s.ask) ? { ask: { kind, text: askText(input.message ?? ''), at: now() } } : {};
      return { reply: {}, patch: { ...patch, status: 'waiting', ...ask } };
    }
    case 'PermissionRequest': {
      const reply = permissionReply(input, deps.readTargets(ctx()), deps.realpath);
      // чтение из папок сессии пропущено без вопроса; остальное решает человек в TUI — сессия ждёт его ответа. Снимает
      // вопрос шаг того, кто спросил (agent — сабагент), сообщение пользователя или конец хода. Отказ в TUI (Esc) хода
      // не продолжает: вопрос держится до следующего сообщения, а у закрытой так сессии — «закончилась на запросе»
      if (Object.keys(reply).length) return { reply, patch };
      const ask: SessionAsk = { ...permissionAsk(input), at: now(), ...(input.agent_id ? { agent: input.agent_id } : {}), ...(input.tool_name ? { tool: input.tool_name } : {}), ...(input.tool_use_id ? { toolUseId: input.tool_use_id } : {}) };
      return { reply, patch: { ...patch, status: 'waiting', ask } };
    }
    case 'PreToolUse':
      return { reply: preToolDecision(input, deps), patch };
    case 'PostToolUse': {
      // разрешённый инструмент отработал — вопрос о нём снят, не дожидаясь конца пачки (долгая команда не «ждёт разрешения»)
      const a = s.ask;
      if (a?.kind === 'permission' && a.agent === input.agent_id && (a.toolUseId ? a.toolUseId === input.tool_use_id : a.tool === input.tool_name)) {
        patch.ask = null;
        patch.status = 'working';
      }
      if (!WRITE_TOOLS.includes(input.tool_name ?? '') || !deps.afterWrite) return { reply: {}, patch };
      let note: string | undefined;
      try {
        note = deps.afterWrite(input.tool_name!, input.tool_input ?? {}, { cwd: input.cwd, toolUseId: input.tool_use_id });
      } catch (err) {
        note = `Проверка после записи не удалась: ${err instanceof Error ? err.message : String(err)}`;
      }
      // decision: block у PostToolUse не отменяет записанное (это делает afterWrite), а отдаёт причину модели
      return { reply: note ? { decision: 'block', reason: note } : {}, patch };
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
