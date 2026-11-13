// MCP-сервер agentgraph для сессии терминала: POST /api/sessions/:id/mcp, транспорт streamable HTTP без состояния.
// Свой обработчик JSON-RPC: knowledgeToolsServer из knowledge-tools.ts построен на createSdkMcpServer и работает
// только внутри query() Agent SDK, а здесь клиент — отдельный процесс claude. Инструменты: knowledge_read — полный
// текст тега знаний (только чтение); пространство сессии — space_write (документ в docs/), space_map_write (карта),
// space_state_write (состояние), space_settings (заголовок, папки чтения, рабочая папка — space.json); flow_write —
// flow в папке flow (проверка схемой до записи); session_new — открыть рядом новую сессию agentgraph; у сессии из задачи
// Teamwork (spec §9.5) ещё team_task_update — статус, PR и комментарий её задачи, и team_doc_write — документ проекта
// команды. Кроме knowledge_read ничего нет в allowedTools, и хук PreToolUse велит claude спрашивать пользователя о
// каждом вызове (не прошедший проверку — отклоняет без вопроса). Слаги и пространство берутся в момент вызова:
// выбранное на ходу доступно сразу.
import type { SessionView, TeamTaskStatus } from './api-types.js';
import { knowledgeReadText } from './knowledge-tools.js';
import { KNOWLEDGE_READ_TOOL } from './tags.js';
import { DOCS_DIR, MAP_FILE, META_FILE, SPACE_DIRS_MAX, SPACE_DOC_TEXT_MAX, SPACE_MAP_MAX, SPACE_STATE_MAX, SPACE_WRITE_TOOL, STATE_FILE, WRITE_DOC_EXTS } from './spaces.js';
import {
  FLOW_WRITE_TOOL, SESSION_NEW_TOOL, SPACE_MAP_WRITE_TOOL, SPACE_SETTINGS_TOOL, SPACE_STATE_WRITE_TOOL, TEAM_DOC_WRITE_TOOL, TEAM_TASK_UPDATE_TOOL,
} from './sessions.js';
import { TASK_STATUSES } from './teamwork.js';
import { FLOW_RUNS_NOTE } from './session-edit.js';

/**
 * Что у сессии на момент вызова: пространство (слаг и папка), теги знаний, папка flow и задача Teamwork, если сессия
 * открыта из неё.
 */
export type McpScope = () => { space?: string; spaceDir?: string; knowledge: string[]; flowsDir?: string; task?: { id: string; team: string; project: string } };

/** Параметры session_new: чего нет — берётся у сессии, из которой вызвали; space: null — без пространства. */
export type SessionNewArgs = { prompt?: string; tags?: string[]; space?: string | null; cwd?: string; name?: string; model?: string };

/** Параметры team_task_update: статус, ссылка на PR и комментарий к задаче сессии — что задано, то и меняется. */
export type TeamTaskUpdateArgs = { status?: TeamTaskStatus; pr?: string; comment?: string };

/** Параметры space_settings: что задано — меняется (dirs — список целиком; cwd: null или "" — снять), что нет — остаётся. */
export type SpaceSettingsArgs = { title?: string; dirs?: string[]; cwd?: string | null };

/** Параметры flow_write: имя файла, YAML целиком и папка первого уровня для нового flow. */
export type FlowWriteArgs = { name: string; yaml: string; folder?: string };

export type McpCtx = {
  scope: McpScope;
  /** Новая сессия рядом с этой; ошибка (лимит, нет папки) уходит модели текстом. */
  open: (args: SessionNewArgs) => Promise<SessionView>;
  /** Документ в docs/ пространства сессии; ответ — его путь. Ошибка (нет пространства, имя, размер) — текстом модели. */
  writeDoc: (name: string, text: string) => string;
  /** Карта пространства сессии целиком; ответ — путь CLAUDE.md. */
  writeMap: (text: string) => string;
  /** Состояние пространства сессии целиком (в очереди записи состояния); ответ — путь STATE.md. */
  writeState: (text: string) => Promise<string>;
  /** Заголовок, папки чтения и рабочая папка пространства сессии — проверка как у API; ответ — что изменилось. */
  spaceSettings: (args: SpaceSettingsArgs) => string;
  /** flow в папке flow (схема и вызовы — до записи); ответ — путь файла. */
  writeFlow: (args: FlowWriteArgs) => string;
  /** Задача Teamwork сессии: ответ — что изменилось. Нет у сессии без задачи. */
  teamTask?: (args: TeamTaskUpdateArgs) => Promise<string>;
  /** Документ проекта Teamwork (architecture, design, docs/<имя>.md); ответ — путь файла в клоне. Нет у сессии без задачи. */
  teamDoc?: (name: string, text: string) => Promise<string>;
};

export type McpReply = { status: number; body?: unknown };

const PROTOCOL_FALLBACK = '2025-06-18';

const str = (description: string) => ({ type: 'string', description });

function tools(scope: ReturnType<McpScope>) {
  const space = scope.space ? ` (${scope.space})` : ' (у сессии сейчас нет пространства — вызов вернёт ошибку)';
  const file = (name: string) => (scope.spaceDir ? `${scope.spaceDir}/${name}` : name);
  const ask = 'Пользователь подтверждает вызов.';
  return [
    {
      name: KNOWLEDGE_READ_TOOL,
      description: 'Полный текст области знаний из контекста agentgraph: заметки пользователя, пути только для чтения и вложения. Открывай, когда эта область нужна для текущего шага.',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string', description: `Слаг области знаний: ${scope.knowledge.join(', ') || 'нет доступных'}` } },
        required: ['slug'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: SPACE_WRITE_TOOL,
      description:
        `Записать документ в ${DOCS_DIR}/ пространства agentgraph этой сессии${space}: спеку, решение, заметку по фиче. ` +
        'Файл пишется целиком (новый или поверх старого: сначала прочитай его инструментом Read). Его увидят все следующие сессии и запуски пространства. ' +
        `Вызывай, когда пользователь просит записать что-то в документы фичи или проекта. Карту пишет ${SPACE_MAP_WRITE_TOOL}, состояние — ${SPACE_STATE_WRITE_TOOL}, заголовок и папки — ${SPACE_SETTINGS_TOOL}. ${ask}`,
      inputSchema: {
        type: 'object',
        properties: {
          name: str(`Имя файла в ${DOCS_DIR}/, без папок: ${WRITE_DOC_EXTS.map((e) => `.${e}`).join(' или ')} — например decisions.md`),
          text: str(`Текст документа целиком, до ${SPACE_DOC_TEXT_MAX / 1024} КБ.`),
        },
        required: ['name', 'text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: SPACE_MAP_WRITE_TOOL,
      description:
        `Переписать карту (${MAP_FILE}) пространства agentgraph этой сессии${space}: суть, где что, куда за чем ходить, договорённости. ` +
        `Карту получают памятью все следующие сессии и запуски пространства — пиши её как инструкции для них, до ${SPACE_MAP_MAX} знаков; справочное — в документы (${SPACE_WRITE_TOOL}). ` +
        `Пишется целиком: сначала прочитай текущую инструментом Read (${file(MAP_FILE)}). Вызывай, когда пользователь просит поправить карту. ${ask}`,
      inputSchema: { type: 'object', properties: { text: str(`Карта целиком (Markdown), до ${SPACE_MAP_MAX} знаков; пусто — карты не будет.`) }, required: ['text'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: SPACE_STATE_WRITE_TOOL,
      description:
        `Переписать состояние (${STATE_FILE}) пространства agentgraph этой сессии${space} — «где мы сейчас»: что сделано, что в работе, что дальше, открытые вопросы. ` +
        `Не журнал: текущее состояние целиком, до ${SPACE_STATE_MAX} знаков (сначала прочитай текущее: ${file(STATE_FILE)}). Его получат следующие сессии и запуски. ` +
        `Вызывай, когда пользователь просит обновить состояние. ${ask}`,
      inputSchema: { type: 'object', properties: { text: str(`Состояние целиком, до ${SPACE_STATE_MAX} знаков.`) }, required: ['text'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: SPACE_SETTINGS_TOOL,
      description:
        `Изменить настройки пространства agentgraph этой сессии${space} (${META_FILE}): заголовок, папки чтения, рабочую папку. Что задано — меняется, что нет — остаётся. ` +
        'Папки чтения откроются на чтение всем сессиям и запускам пространства — добавляй только те, что пользователь назвал. Проверка — как на странице пространства. ' +
        `Вызывай, когда пользователь просит поменять заголовок или папки пространства. ${ask}`,
      inputSchema: {
        type: 'object',
        properties: {
          title: str('Заголовок одной строкой; "" — без заголовка.'),
          dirs: { type: 'array', items: { type: 'string' }, description: `Папки и файлы только для чтения — абсолютные пути, список целиком (до ${SPACE_DIRS_MAX}); [] — без папок.` },
          cwd: { type: ['string', 'null'], description: 'Рабочая папка (проект) — абсолютный путь к существующей папке; её подставят формы сессии и запуска. null или "" — снять.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: FLOW_WRITE_TOOL,
      description:
        `Создать или переписать flow agentgraph — YAML в папке flow${scope.flowsDir ? ` ${scope.flowsDir}` : ''}. До записи agentgraph проверяет схему и вызовы flow: ошибки вернутся текстом — исправь и вызови снова. ` +
        'Существующий flow перезаписывается на месте (сначала прочитай его файл инструментом Read), новый ложится в folder. Начатый запуск идёт по своему снимку; новый запуск, продолжение и вызов из другого flow возьмут эту версию. ' +
        `Вызывай, когда пользователь просит создать или поправить flow. ${ask}`,
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Имя flow — оно же имя файла: латиница, цифры, дефис (например fix-bug).'),
          yaml: str('Текст flow целиком (YAML по схеме agentgraph).'),
          folder: str('Папка первого уровня для нового flow (например example); не задано — корень. Существующий flow остаётся в своей папке.'),
        },
        required: ['name', 'yaml'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: SESSION_NEW_TOOL,
      description:
        'Открыть новую сессию Claude Code в agentgraph — отдельный терминал рядом с этим, вкладка «Сессии». Вызывай, когда пользователь просит открыть или начать новую сессию либо вынести задачу в отдельную. ' +
        'Чего не задал — как у этой сессии: папка, пространство, теги знаний, модель. Режим разрешений не задаётся: в той же папке и пространстве — как у этой сейчас (bypassPermissions и dontAsk — обычный, с вопросами), в другой — обычный. Новая сессия этот разговор не видит: всё нужное для задачи пиши в prompt. Пользователь подтверждает вызов.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: str('Первое сообщение новой сессии — задача целиком, с контекстом. Не задано — сессия откроется пустой и будет ждать пользователя.'),
          space: {
            type: ['string', 'null'],
            description: `Слаг существующего пространства agentgraph (фича или проект: карта, документы, состояние). Не задано — как у этой сессии: ${scope.space ?? 'нет'}; null — без пространства.`,
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: `Слаги тегов знаний agentgraph, только существующих. Не задано — теги этой сессии: ${scope.knowledge.join(', ') || 'нет'}; [] — без тегов.`,
          },
          cwd: str('Папка проекта: абсолютный путь или относительно папки этой сессии. Не задано — та же папка.'),
          name: str('Название в списке сессий. Не задано — по пространству или имени папки.'),
          model: str('Модель claude: sonnet, opus, haiku или полный id. Не задано — как у этой сессии.'),
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    // инструменты задачи Teamwork — только у сессии, открытой из задачи: остальным они ни к чему
    ...(scope.task
      ? [
          {
            name: TEAM_TASK_UPDATE_TOOL,
            description:
              `Изменить задачу Teamwork ${scope.task.id} (команда ${scope.task.team}, проект ${scope.task.project}), из которой открыта эта сессия: статус на доске, ссылка на PR или MR, комментарий. ` +
              'Задано — меняется, не задано — остаётся. Изменение уходит коммитом в репо команды и видно всем участникам. Вызывай, когда пользователь просит отметить задачу или когда PR открыт; пользователь подтверждает вызов.',
            inputSchema: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: [...TASK_STATUSES], description: 'Новый статус: todo — к работе, in_progress — в работе, review — ревью, done — готово.' },
                pr: str('Ссылка на открытый PR или MR по ветке задачи (https://…).'),
                comment: str('Комментарий к задаче от имени пользователя: что сделано, что открыто.'),
              },
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
          {
            name: TEAM_DOC_WRITE_TOOL,
            description:
              `Записать новую версию документа проекта Teamwork ${scope.task.project} (команда ${scope.task.team}): architecture, design или файл в docs/ проекта. ` +
              'Файл пишется целиком (сначала прочитай текущий инструментом Read из папки проекта во входе). ТЗ (prd) так не меняется — только через черновик и принятие. ' +
              'Документ уходит коммитом в репо команды и виден всем участникам; пользователь подтверждает вызов.',
            inputSchema: {
              type: 'object',
              properties: {
                name: str('architecture, design или docs/<имя>.md.'),
                text: str(`Текст документа целиком, до ${SPACE_DOC_TEXT_MAX / 1024} КБ.`),
              },
              required: ['name', 'text'],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ]
      : []),
  ];
}

const NEW_KEYS = ['prompt', 'space', 'tags', 'cwd', 'name', 'model'];
const TASK_KEYS = ['status', 'pr', 'comment'];
/** Управляющие символы, кроме \t и \n: ESC и BEL из текста модели дошли бы до экрана (OSC 52, заголовок окна). */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Аргументы session_new: лишний параметр или тип — ошибка модели, а не молча «как у этой сессии». Пустая строка —
 * как не заданная (модели шлют "" в необязательных полях), управляющие символы вычищаются.
 */
export function parseSessionNewArgs(args: Record<string, unknown>): SessionNewArgs {
  const extra = Object.keys(args).filter((k) => !NEW_KEYS.includes(k));
  if (extra.length) throw new Error(`Лишние параметры: ${extra.join(', ')}. Есть только ${NEW_KEYS.join(', ')}; режим разрешений выбирает agentgraph`);
  const out: SessionNewArgs = {};
  for (const k of ['prompt', 'cwd', 'name', 'model'] as const) {
    const v = args[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') throw new Error(`${k} — строка`);
    const clean = v.replace(CONTROL_RE, '');
    if (clean.trim()) out[k] = clean;
  }
  if (args.tags !== undefined) {
    if (!Array.isArray(args.tags) || args.tags.some((t) => typeof t !== 'string')) throw new Error('tags — массив слагов');
    out.tags = args.tags as string[];
  }
  if (args.space === null) out.space = null;
  else if (args.space !== undefined) {
    if (typeof args.space !== 'string') throw new Error('space — слаг пространства или null');
    if (args.space.trim()) out.space = args.space.trim();
  }
  return out;
}

/** Аргументы team_task_update: лишнее и не строки — ошибка; пустая строка — как не задано; статус — из четырёх. */
export function parseTeamTaskArgs(args: Record<string, unknown>): TeamTaskUpdateArgs {
  const extra = Object.keys(args).filter((k) => !TASK_KEYS.includes(k));
  if (extra.length) throw new Error(`Лишние параметры: ${extra.join(', ')}. Есть только ${TASK_KEYS.join(', ')}`);
  const out: TeamTaskUpdateArgs = {};
  for (const k of TASK_KEYS as (keyof TeamTaskUpdateArgs)[]) {
    const v = args[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') throw new Error(`${k} — строка`);
    const clean = v.replace(CONTROL_RE, '').trim();
    if (!clean) continue;
    if (k === 'status') {
      if (!TASK_STATUSES.includes(clean as TeamTaskStatus)) throw new Error(`status: ${TASK_STATUSES.join(' | ')}`);
      out.status = clean as TeamTaskStatus;
    } else out[k] = k === 'comment' ? v.replace(CONTROL_RE, '') : clean;
  }
  if (!Object.keys(out).length) throw new Error('Нечего менять: укажи status, pr или comment');
  return out;
}

/** Лишние параметры — ошибка модели (опечатка), а не молча «не задано». */
function onlyKeys(args: Record<string, unknown>, keys: string[]): void {
  const extra = Object.keys(args).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`Лишние параметры: ${extra.join(', ')}. Есть только ${keys.join(', ')}`);
}

/** Аргумент text у space_map_write и space_state_write: строка, больше ничего. */
export function parseTextArg(args: Record<string, unknown>): string {
  onlyKeys(args, ['text']);
  if (typeof args.text !== 'string') throw new Error('Нужен параметр text — строка');
  return args.text;
}

/** Аргументы space_settings: типы и хоть одно поле; пути и заголовок проверит updateSpace (как у API). */
export function parseSpaceSettingsArgs(args: Record<string, unknown>): SpaceSettingsArgs {
  onlyKeys(args, ['title', 'dirs', 'cwd']);
  const out: SpaceSettingsArgs = {};
  if (args.title !== undefined) {
    if (typeof args.title !== 'string') throw new Error('title — строка');
    out.title = args.title.replace(CONTROL_RE, ' ');
  }
  if (args.dirs !== undefined) {
    if (!Array.isArray(args.dirs) || args.dirs.some((d) => typeof d !== 'string')) throw new Error('dirs — список абсолютных путей');
    out.dirs = args.dirs as string[];
  }
  if (args.cwd !== undefined) {
    if (args.cwd !== null && typeof args.cwd !== 'string') throw new Error('cwd — путь строкой или null');
    out.cwd = args.cwd;
  }
  if (!Object.keys(out).length) throw new Error('Нечего менять: укажи title, dirs или cwd');
  return out;
}

/** Аргументы flow_write: имя, YAML, папка — строки; имя и папку проверит flows.ts. */
export function parseFlowWriteArgs(args: Record<string, unknown>): FlowWriteArgs {
  onlyKeys(args, ['name', 'yaml', 'folder']);
  if (typeof args.name !== 'string' || typeof args.yaml !== 'string') throw new Error('Нужны параметры name и yaml — строки');
  if (args.folder !== undefined && typeof args.folder !== 'string') throw new Error('folder — строка');
  const folder = typeof args.folder === 'string' ? args.folder.trim() : '';
  return { name: args.name.trim(), yaml: args.yaml, ...(folder ? { folder } : {}) };
}

/** Ответ модели об открытой сессии: где она и что дальше — сюда её ответы не придут. */
function openedText(v: SessionView, prompt: boolean): string {
  const what = [`папка ${v.cwd}`, `пространство: ${v.space ?? 'нет'}`, `теги знаний: ${v.tags.join(', ') || 'нет'}`, ...(v.model ? [`модель ${v.model}`] : [])].join('; ');
  return [
    `Сессия «${v.name}» открыта (${what}).`,
    prompt
      ? 'Первое сообщение она получит, когда claude запустится, — в недоверенной папке после того, как пользователь подтвердит доверие на её экране.'
      : 'Она ждёт первого сообщения пользователя.',
    'Пользователь откроет её в agentgraph — вкладка «Сессии» или подсказка на экране этой сессии. Это отдельный разговор: её ответы сюда не придут.',
  ].join(' ');
}

async function call(name: unknown, raw: unknown, ctx: McpCtx) {
  const args = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  try {
    if (name === SESSION_NEW_TOOL) {
      const a = parseSessionNewArgs(args);
      return { content: [{ type: 'text', text: openedText(await ctx.open(a), a.prompt !== undefined) }] };
    }
    if (name === SPACE_WRITE_TOOL) {
      const extra = Object.keys(args).filter((k) => k !== 'name' && k !== 'text');
      if (extra.length) throw new Error(`Лишние параметры: ${extra.join(', ')}. Есть только name и text`);
      if (typeof args.name !== 'string' || typeof args.text !== 'string') throw new Error('Нужны параметры name и text — строки');
      const file = ctx.writeDoc(args.name.replace(CONTROL_RE, ''), args.text);
      return { content: [{ type: 'text', text: `Документ записан: ${file}. Его увидят следующие сессии и запуски пространства.` }] };
    }
    if (name === SPACE_MAP_WRITE_TOOL) {
      const file = ctx.writeMap(parseTextArg(args));
      return { content: [{ type: 'text', text: `Карта записана: ${file}. Памятью её получат следующие сессии и запуски пространства; в этой сессии память не перезагрузится — дальше опирайся на записанный текст.` }] };
    }
    if (name === SPACE_STATE_WRITE_TOOL) {
      const file = await ctx.writeState(parseTextArg(args));
      return { content: [{ type: 'text', text: `Состояние записано: ${file}. Его получат следующие сессии и запуски пространства.` }] };
    }
    if (name === SPACE_SETTINGS_TOOL) return { content: [{ type: 'text', text: ctx.spaceSettings(parseSpaceSettingsArgs(args)) }] };
    if (name === FLOW_WRITE_TOOL) {
      const file = ctx.writeFlow(parseFlowWriteArgs(args));
      return { content: [{ type: 'text', text: `Flow записан: ${file}. ${FLOW_RUNS_NOTE}.` }] };
    }
    if (name === KNOWLEDGE_READ_TOOL) {
      const slug = args.slug;
      if (typeof slug !== 'string') throw new Error('Нужен параметр slug — строка');
      return { content: [{ type: 'text', text: knowledgeReadText(ctx.scope().knowledge, slug, 'session') }] };
    }
    if (name === TEAM_TASK_UPDATE_TOOL || name === TEAM_DOC_WRITE_TOOL) {
      if (!ctx.scope().task || !ctx.teamTask || !ctx.teamDoc) throw new Error('Эта сессия не открыта из задачи Teamwork: инструмент недоступен');
      if (name === TEAM_TASK_UPDATE_TOOL) return { content: [{ type: 'text', text: await ctx.teamTask(parseTeamTaskArgs(args)) }] };
      const extra = Object.keys(args).filter((k) => k !== 'name' && k !== 'text');
      if (extra.length) throw new Error(`Лишние параметры: ${extra.join(', ')}. Есть только name и text`);
      if (typeof args.name !== 'string' || typeof args.text !== 'string') throw new Error('Нужны параметры name и text — строки');
      const file = await ctx.teamDoc(args.name.replace(CONTROL_RE, '').trim(), args.text);
      return { content: [{ type: 'text', text: `Документ записан: ${file}. Коммит в репо команды уйдёт участникам.` }] };
    }
    throw new Error(`Нет инструмента ${String(name)}`);
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

type RpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

/** Ответ на одно сообщение; undefined — уведомление или ответ клиента (без ответа). */
async function one(msg: RpcMessage, ctx: McpCtx): Promise<unknown> {
  const hasId = msg.id !== undefined && msg.id !== null;
  if (!hasId || typeof msg.method !== 'string') return undefined;
  const result = (r: unknown) => ({ jsonrpc: '2.0', id: msg.id, result: r });
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
  switch (msg.method) {
    case 'initialize':
      return result({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: 'agentgraph', version: '0.1.0' },
      });
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: tools(ctx.scope()) });
    case 'tools/call':
      return result(await call(params.name, params.arguments, ctx));
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Метод ${msg.method} не поддерживается` } };
  }
}

/** POST-тело JSON-RPC (сообщение или пакет) → HTTP-ответ: 202 без тела, если отвечать не на что. */
export async function mcpReply(body: unknown, ctx: McpCtx): Promise<McpReply> {
  const list = Array.isArray(body) ? body : [body];
  if (!list.length || list.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Неверный запрос JSON-RPC' } } };
  }
  const out = (await Promise.all(list.map((m) => one(m as RpcMessage, ctx)))).filter((r) => r !== undefined);
  if (!out.length) return { status: 202 };
  return { status: 200, body: Array.isArray(body) ? out : out[0] };
}
