// MCP-сервер agentgraph для сессии терминала: POST /api/sessions/:id/mcp, транспорт streamable HTTP без состояния.
// Свой обработчик JSON-RPC: knowledgeToolsServer из knowledge-tools.ts построен на createSdkMcpServer и работает
// только внутри query() Agent SDK, а здесь клиент — отдельный процесс claude. Инструменты: knowledge_read — полный
// текст тега знаний (только чтение); space_write — записать документ в docs/ пространства сессии; session_new — открыть
// рядом новую сессию agentgraph; у сессии из задачи Teamwork (spec §9.5) ещё team_task_update — статус, PR и комментарий
// её задачи, и team_doc_write — документ проекта команды. Кроме knowledge_read ничего нет в allowedTools, и хук PreToolUse
// велит claude спрашивать пользователя о каждом вызове. Слаги и пространство берутся в момент вызова: выбранное на ходу доступно сразу.
import type { SessionView, TeamTaskStatus } from './api-types.js';
import { knowledgeReadText } from './knowledge-tools.js';
import { KNOWLEDGE_READ_TOOL } from './tags.js';
import { DOCS_DIR, SPACE_DOC_TEXT_MAX, SPACE_WRITE_TOOL, WRITE_DOC_EXTS } from './spaces.js';
import { SESSION_NEW_TOOL, TEAM_DOC_WRITE_TOOL, TEAM_TASK_UPDATE_TOOL } from './sessions.js';

/** Что у сессии на момент вызова: пространство (слаг), теги знаний и задача Teamwork, если сессия открыта из неё. */
export type McpScope = () => { space?: string; knowledge: string[]; task?: { id: string; team: string; project: string } };

/** Параметры session_new: чего нет — берётся у сессии, из которой вызвали; space: null — без пространства. */
export type SessionNewArgs = { prompt?: string; tags?: string[]; space?: string | null; cwd?: string; name?: string; model?: string };

/** Параметры team_task_update: статус, ссылка на PR и комментарий к задаче сессии — что задано, то и меняется. */
export type TeamTaskUpdateArgs = { status?: TeamTaskStatus; pr?: string; comment?: string };

export type McpCtx = {
  scope: McpScope;
  /** Новая сессия рядом с этой; ошибка (лимит, нет папки) уходит модели текстом. */
  open: (args: SessionNewArgs) => Promise<SessionView>;
  /** Документ в docs/ пространства сессии; ответ — его путь. Ошибка (нет пространства, имя, размер) — текстом модели. */
  writeDoc: (name: string, text: string) => string;
  /** Задача Teamwork сессии: ответ — что изменилось. Нет у сессии без задачи. */
  teamTask?: (args: TeamTaskUpdateArgs) => Promise<string>;
  /** Документ проекта Teamwork (architecture, design, docs/<имя>.md); ответ — путь файла в клоне. Нет у сессии без задачи. */
  teamDoc?: (name: string, text: string) => Promise<string>;
};

const TASK_STATUSES: readonly TeamTaskStatus[] = ['todo', 'in_progress', 'review', 'done'];

export type McpReply = { status: number; body?: unknown };

const PROTOCOL_FALLBACK = '2025-06-18';

const str = (description: string) => ({ type: 'string', description });

function tools(scope: ReturnType<McpScope>) {
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
        `Записать документ в ${DOCS_DIR}/ пространства agentgraph этой сессии${scope.space ? ` (${scope.space})` : ' (у сессии сейчас нет пространства — вызов вернёт ошибку)'}: спеку, решение, заметку по фиче. ` +
        'Файл пишется целиком (новый или поверх старого: сначала прочитай его инструментом Read). Его увидят все следующие сессии и запуски пространства. ' +
        'Вызывай, когда пользователь просит записать что-то в документы фичи или проекта. Карту (CLAUDE.md) и состояние правит пользователь в agentgraph. Пользователь подтверждает вызов.',
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
      name: SESSION_NEW_TOOL,
      description:
        'Открыть новую сессию Claude Code в agentgraph — отдельный терминал рядом с этим, вкладка «Сессии». Вызывай, когда пользователь просит открыть или начать новую сессию либо вынести задачу в отдельную. ' +
        'Чего не задал — как у этой сессии: папка, пространство, теги знаний, модель; режим разрешений — всегда как у этой. Новая сессия этот разговор не видит: всё нужное для задачи пиши в prompt. Пользователь подтверждает вызов.',
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
  if (extra.length) throw new Error(`Лишние параметры: ${extra.join(', ')}. Есть только ${NEW_KEYS.join(', ')}; режим разрешений — всегда как у этой сессии`);
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
