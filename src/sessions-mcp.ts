// MCP-сервер agentgraph для сессии терминала: POST /api/sessions/:id/mcp, транспорт streamable HTTP без состояния.
// Свой обработчик JSON-RPC: knowledgeToolsServer из knowledge-tools.ts построен на createSdkMcpServer и работает
// только внутри query() Agent SDK, а здесь клиент — отдельный процесс claude. Инструменты: knowledge_read — полный
// текст тега знаний (только чтение); пространство сессии — space_write (документ в docs/), space_map_write (карта),
// space_state_write (состояние), space_settings (заголовок, папки чтения, рабочая папка — space.json); flow_write —
// flow в папке flow (проверка схемой до записи); session_new — открыть рядом новую сессию agentgraph; у сессии из задачи
// Teamwork (spec §9.5) ещё team_task_update — статус, PR и комментарий её задачи, и team_doc_write — документ проекта
// команды; у сессии с оркестрацией agentgraph — flow_guide, flow_run, flow_status, flow_answer, flow_stop (session-flows.ts),
// а space_write, space_map_write, space_state_write и desk_put она зовёт без вопроса (ORCHESTRATE_ALLOWED_TOOLS);
// дела на доске «Мои дела» — desk_put, desk_close, desk_list (src/desk/tools.ts: сессия, проект и ветка
// подставляются сами, сигнал — от 'session'; ответ desk_close после работы по делу предлагает записать вывод) и
// knowledge_note — строка в заметки тега знаний вида работы (docs/desk/SPEC.md, 6.6). Кроме knowledge_read и desk_list
// ничего нет в allowedTools; о записи пространства, flow, знания, новой сессии и задачи Teamwork хук PreToolUse велит
// claude спрашивать пользователя при каждом
// вызове (не прошедший проверку — отклоняет без вопроса), о desk_put и desk_close спрашивает сам claude по режиму
// разрешений. Слаги и пространство берутся в момент вызова: выбранное на ходу доступно сразу.
import type { SessionView, TeamTaskStatus } from './api-types.js';
import { knowledgeReadText } from './knowledge-tools.js';
import { KNOWLEDGE_NOTE_TOOL, KNOWLEDGE_READ_TOOL, TAG_NOTE_MAX } from './tags.js';
import { DOCS_DIR, MAP_FILE, META_FILE, SPACE_DIRS_MAX, SPACE_DOC_TEXT_MAX, SPACE_MAP_MAX, SPACE_STATE_MAX, SPACE_WRITE_TOOL, STATE_FILE, WRITE_DOC_EXTS } from './spaces.js';
import {
  FLOW_ANSWER_TOOL, FLOW_GUIDE_TOOL, FLOW_RUN_TOOL, FLOW_STATUS_TOOL, FLOW_STOP_TOOL, ORCHESTRATE_TOOLS,
  FLOW_WRITE_TOOL, SESSION_NEW_TOOL, SPACE_MAP_WRITE_TOOL, SPACE_SETTINGS_TOOL, SPACE_STATE_WRITE_TOOL, TEAM_DOC_WRITE_TOOL, TEAM_TASK_UPDATE_TOOL,
} from './sessions.js';
import { TASK_STATUSES } from './teamwork.js';
import { FLOW_RUNS_NOTE } from './session-edit.js';
import { deskCall, deskInputSchemas, deskToolDescriptions, DESK_CLOSE_TOOL, DESK_LIST_TOOL, DESK_PUT_TOOL, DESK_TOOLS, type DeskCallCtx, type DeskHint } from './desk/tools.js';

/**
 * Что у сессии на момент вызова: пространство (слаг и папка), теги знаний, папка flow и задача Teamwork, если сессия
 * открыта из неё.
 */
export type McpScope = () => {
  space?: string;
  spaceDir?: string;
  knowledge: string[];
  flowsDir?: string;
  task?: { id: string; team: string; project: string };
  /** Сессия с оркестрацией agentgraph: пространство ведёт сама, без вопроса пользователю. */
  orchestrate?: boolean;
};

/** Параметры flow_run: готовый flow по имени или разовый YAML, задача, папка, модель и бюджет. */
export type FlowRunArgs = { flow?: string; yaml?: string; input: string; cwd?: string; model?: string; budget?: number };
/** Параметры flow_status: запуск (нет — все запуски сессии) и сколько секунд ждать изменения. */
export type FlowStatusArgs = { run?: string; wait?: number };
/** Параметры flow_answer: запуск, вопрос и ответы — по тексту вопроса. */
export type FlowAnswerArgs = { run: string; question: string; answers: Record<string, string> };

/** Запуски flow от сессии (server.ts → setSessionFlows): ответы — текст модели, ошибки — исключением. */
export type SessionFlowsCtx = {
  /** Как собрать flow: правила оркестратора, пример YAML, готовые flow. */
  guide: () => string;
  run: (a: FlowRunArgs) => Promise<string>;
  status: (a: FlowStatusArgs) => Promise<string>;
  answer: (a: FlowAnswerArgs) => string;
  stop: (run: string) => string;
};

/** Дольше flow_status не ждёт: вызов MCP не должен висеть дольше, чем терпит клиент. */
export const FLOW_WAIT_MAX = 300;

/** Параметры session_new: чего нет — берётся у сессии, из которой вызвали; space: null — без пространства. */
export type SessionNewArgs = { prompt?: string; tags?: string[]; space?: string | null; cwd?: string; name?: string; model?: string };

/** Параметры team_task_update: статус, ссылка на PR и комментарий к задаче сессии — что задано, то и меняется. */
export type TeamTaskUpdateArgs = { status?: TeamTaskStatus; pr?: string; comment?: string };

/** Параметры space_settings: что задано — меняется (dirs — список целиком; cwd: null или "" — снять), что нет — остаётся. */
export type SpaceSettingsArgs = { title?: string; dirs?: string[]; cwd?: string | null };

/** Параметры knowledge_note: слаг тега знаний, строка вывода и заголовок нового тега. */
export type KnowledgeNoteArgs = { tag: string; text: string; title?: string };

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
  /**
   * Дела: что подставляется само (хранилище, сессия, проект, ветка) — в момент вызова инструмента; хранилище открывается
   * только при вызове. Нет — инструментов дел у сессии нет.
   */
  desk?: () => DeskCallCtx;
  /** Вещь и проект сессии для описаний desk_*: на момент tools/list. */
  deskHint?: () => DeskHint;
  /** Запуски flow (оркестрация): нет — инструментов flow_run и соседей у сессии нет. */
  flows?: SessionFlowsCtx;
  /**
   * Запись знания в тег (knowledge_note, всегда с вопросом человеку): строка в конец заметок тега знаний, тега нет —
   * заводится; ответ — что записано. Нет — инструмента у сессии нет.
   */
  writeNote?: (args: KnowledgeNoteArgs) => string;
};

export type McpReply = { status: number; body?: unknown };

const PROTOCOL_FALLBACK = '2025-06-18';

const str = (description: string) => ({ type: 'string', description });

function tools(scope: ReturnType<McpScope>, desk?: DeskHint, note = false, flows = false) {
  const space = scope.space ? ` (${scope.space})` : ' (у сессии сейчас нет пространства — вызов вернёт ошибку)';
  const file = (name: string) => (scope.spaceDir ? `${scope.spaceDir}/${name}` : name);
  const ask = 'Пользователь подтверждает вызов.';
  // с оркестрацией пространство ведёт сама сессия: когда звать — по правилам ведения из контекста agentgraph
  const own = (when: string) => (scope.orchestrate ? 'Вызывай сам по ходу работы, по правилам ведения пространства из контекста agentgraph; без вопроса пользователю.' : `${when} ${ask}`);
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
        `Карту пишет ${SPACE_MAP_WRITE_TOOL}, состояние — ${SPACE_STATE_WRITE_TOOL}, заголовок и папки — ${SPACE_SETTINGS_TOOL}. ${own('Вызывай, когда пользователь просит записать что-то в документы фичи или проекта.')}`,
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
        `Пишется целиком: сначала прочитай текущую инструментом Read (${file(MAP_FILE)}). ${own('Вызывай, когда пользователь просит поправить карту.')}`,
      inputSchema: { type: 'object', properties: { text: str(`Карта целиком (Markdown), до ${SPACE_MAP_MAX} знаков; пусто — карты не будет.`) }, required: ['text'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: SPACE_STATE_WRITE_TOOL,
      description:
        `Переписать состояние (${STATE_FILE}) пространства agentgraph этой сессии${space} — «где мы сейчас»: что сделано, что в работе, что дальше, открытые вопросы. ` +
        `Не журнал: текущее состояние целиком, до ${SPACE_STATE_MAX} знаков (сначала прочитай текущее: ${file(STATE_FILE)}). Его получат следующие сессии и запуски. ` +
        own('Вызывай, когда пользователь просит обновить состояние.'),
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
    // дела — личная доска пользователя: в конце списка, после инструментов задачи
    ...(desk ? deskTools(desk) : []),
    ...(note ? [knowledgeNoteTool()] : []),
    ...(flows ? flowTools(scope) : []),
  ];
}

/** Инструменты оркестрации: есть только у сессии с оркестрацией agentgraph. */
function flowTools(scope: ReturnType<McpScope>) {
  const runId = str('Id запуска — из ответа flow_run или flow_status.');
  return [
    {
      name: FLOW_GUIDE_TOOL,
      description: 'Как собрать flow agentgraph: как оркестратор исполняет этапы и блоки, правила проектирования, пример YAML и список готовых flow. Открывай перед первым flow_run с разовым flow.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: FLOW_RUN_TOOL,
      description:
        'Запустить flow agentgraph: готовый по имени (flow) или разовый — YAML целиком (yaml), он не попадает в библиотеку flow. Запуск идёт в фоне, в пространстве и с тегами знаний этой сессии ' +
        `(${scope.space ?? 'без пространства'}), пользователь видит его под этой сессией; подтверждать его не нужно — запускай сам, когда задача того стоит. Этапы работают со своими инструментами без вопросов. ` +
        'Разовый flow не задаёт permission_mode, add_dirs и plugins. Ответ — id запуска: дальше flow_status. Схема и вызовы flow проверяются до старта — ошибки вернутся текстом.',
      inputSchema: {
        type: 'object',
        properties: {
          flow: str('Имя готового flow из библиотеки (см. flow_guide). Задай flow или yaml.'),
          yaml: str('Разовый flow целиком — YAML по схеме agentgraph (см. flow_guide).'),
          input: str('Задача запуска целиком, с контекстом: агенты этапов не видят этот разговор.'),
          cwd: str('Папка проекта для агентов: абсолютный путь или относительно папки этой сессии. Не задано — папка этой сессии.'),
          model: str('Модель этапов по умолчанию: sonnet, opus, haiku или id. Не задано — как в flow.'),
          max_budget_usd: { type: 'number', description: 'Предел расхода запуска в долларах. Не задано — без предела.' },
        },
        required: ['input'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: FLOW_STATUS_TOOL,
      description:
        'Состояние запусков flow этой сессии: статус, текущий этап, расход, вопросы агентов, ждущие ответа, последние этапы и проверки, артефакты (файлы — читай Read). ' +
        `Без run — коротко все запуски сессии. wait_seconds (до ${FLOW_WAIT_MAX}) — подождать, пока запуск закончится, остановится или задаст вопрос.`,
      inputSchema: {
        type: 'object',
        properties: {
          run: runId,
          wait_seconds: { type: 'number', description: `Сколько секунд ждать изменения (0–${FLOW_WAIT_MAX}); только с run.` },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: FLOW_ANSWER_TOOL,
      description: 'Ответить на вопрос агента запуска (pendingQuestions в flow_status). Отвечай сам, когда ответ следует из задачи и разговора; решение, которое должен принять пользователь, — спроси у него.',
      inputSchema: {
        type: 'object',
        properties: {
          run: runId,
          question_id: str('Id вопроса из pendingQuestions.'),
          answers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Ответы: ключ — текст вопроса (question), значение — ответ.' },
        },
        required: ['run', 'question_id', 'answers'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: FLOW_STOP_TOOL,
      description: 'Остановить запуск этой сессии: он пошёл не туда или больше не нужен. Остановленный не продолжается сам.',
      inputSchema: { type: 'object', properties: { run: runId }, required: ['run'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  ];
}

const RUN_RE = /^[A-Za-z0-9_-]{1,200}$/;

function runArg(args: Record<string, unknown>): string {
  if (typeof args.run !== 'string' || !RUN_RE.test(args.run.trim())) throw new Error('run — id запуска: латиница, цифры, _ и -');
  return args.run.trim();
}

/** Аргументы flow_run: flow или yaml (ровно одно), input обязателен; бюджет — положительное число. */
export function parseFlowRunArgs(args: Record<string, unknown>): FlowRunArgs {
  onlyKeys(args, ['flow', 'yaml', 'input', 'cwd', 'model', 'max_budget_usd']);
  const opt = (k: string): string | undefined => {
    const v = args[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new Error(`${k} — строка`);
    return v.trim() || undefined;
  };
  const flow = opt('flow');
  const yaml = typeof args.yaml === 'string' && args.yaml.trim() ? args.yaml : undefined;
  if (args.yaml !== undefined && args.yaml !== null && typeof args.yaml !== 'string') throw new Error('yaml — строка');
  if (Boolean(flow) === Boolean(yaml)) throw new Error('Задай ровно одно: flow (имя готового) или yaml (разовый flow)');
  const input = opt('input');
  if (!input) throw new Error('Нужен input — задача запуска');
  const b = args.max_budget_usd;
  if (b !== undefined && b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0)) throw new Error('max_budget_usd — положительное число');
  const cwd = opt('cwd');
  const model = opt('model');
  return { ...(flow ? { flow } : {}), ...(yaml ? { yaml } : {}), input, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(typeof b === 'number' ? { budget: b } : {}) };
}

export function parseFlowStatusArgs(args: Record<string, unknown>): FlowStatusArgs {
  onlyKeys(args, ['run', 'wait_seconds']);
  const run = args.run === undefined || args.run === null || args.run === '' ? undefined : runArg(args);
  const w = args.wait_seconds;
  if (w !== undefined && w !== null && (typeof w !== 'number' || !Number.isFinite(w) || w < 0)) throw new Error('wait_seconds — число секунд, не меньше 0');
  if (typeof w === 'number' && w > 0 && !run) throw new Error('wait_seconds — только вместе с run');
  return { ...(run ? { run } : {}), ...(typeof w === 'number' && w > 0 ? { wait: Math.min(w, FLOW_WAIT_MAX) } : {}) };
}

export function parseFlowAnswerArgs(args: Record<string, unknown>): FlowAnswerArgs {
  onlyKeys(args, ['run', 'question_id', 'answers']);
  const run = runArg(args);
  if (typeof args.question_id !== 'string' || !args.question_id.trim()) throw new Error('question_id — id вопроса из flow_status');
  const a = args.answers;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('answers — объект: текст вопроса → ответ');
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) {
    if (typeof v !== 'string') throw new Error(`Ответ на «${k}» — строка`);
    answers[k] = v;
  }
  if (!Object.keys(answers).length) throw new Error('answers пуст: нужен хотя бы один ответ');
  return { run, question: args.question_id.trim(), answers };
}

/** knowledge_note: вывод после дела — в заметки тега вида работы (desk_close подскажет тег). */
function knowledgeNoteTool() {
  return {
    name: KNOWLEDGE_NOTE_TOOL,
    description:
      'Записать знание одной строкой в конец заметок тега знаний agentgraph: вывод после дела, который пригодится в следующий раз в такой же работе. ' +
      'Заметки тега получат промптом все следующие сессии и запуски с этим тегом. Тег по виду работы подскажет ответ desk_close; тега нет — заведётся (дай title). ' +
      'Вызывай, только когда человек согласился записать: текст — его вывод, а не пересказ дела. Пользователь подтверждает вызов.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: str('Слаг тега знаний: строчные латинские буквы, цифры и дефис'),
        text: str(`Одна мысль, не длиннее ${TAG_NOTE_MAX} знаков; перенос строк станет пробелом`),
        title: str('Заголовок нового тега (вид работы). У существующего тега не меняется'),
      },
      required: ['tag', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  };
}

/** Аргументы knowledge_note: tag и text — строки, title — по желанию; лишнего нет. */
export function parseKnowledgeNoteArgs(args: Record<string, unknown>): KnowledgeNoteArgs {
  const extra = Object.keys(args).filter((k) => k !== 'tag' && k !== 'text' && k !== 'title');
  if (extra.length) throw new Error(`Лишние параметры: ${extra.join(', ')}. Есть только tag, text и title`);
  if (typeof args.tag !== 'string' || typeof args.text !== 'string') throw new Error('Нужны параметры tag и text — строки');
  if (args.title !== undefined && typeof args.title !== 'string') throw new Error('title — строка');
  const title = typeof args.title === 'string' ? args.title.replace(CONTROL_RE, ' ').trim().slice(0, 80) : '';
  return { tag: args.tag.trim(), text: args.text, ...(title ? { title } : {}) };
}

const DESK_ANNOTATIONS: Record<(typeof DESK_TOOLS)[number], Record<string, boolean>> = {
  [DESK_PUT_TOOL]: { readOnlyHint: false, destructiveHint: false },
  [DESK_CLOSE_TOOL]: { readOnlyHint: false, destructiveHint: false },
  [DESK_LIST_TOOL]: { readOnlyHint: true },
};

function deskTools(hint: DeskHint) {
  const d = deskToolDescriptions('session', hint);
  const schemas = deskInputSchemas();
  return DESK_TOOLS.map((name) => ({ name, description: d[name], inputSchema: schemas[name], annotations: DESK_ANNOTATIONS[name] }));
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
    if (name === KNOWLEDGE_NOTE_TOOL && ctx.writeNote) {
      return { content: [{ type: 'text', text: ctx.writeNote(parseKnowledgeNoteArgs(args)) }] };
    }
    if ((ORCHESTRATE_TOOLS as readonly unknown[]).includes(name)) {
      const f = ctx.flows;
      if (!f) throw new Error('У этой сессии не включена оркестрация agentgraph: инструменты flow недоступны');
      if (name === FLOW_GUIDE_TOOL) {
        onlyKeys(args, []);
        return { content: [{ type: 'text', text: f.guide() }] };
      }
      if (name === FLOW_RUN_TOOL) return { content: [{ type: 'text', text: await f.run(parseFlowRunArgs(args)) }] };
      if (name === FLOW_STATUS_TOOL) return { content: [{ type: 'text', text: await f.status(parseFlowStatusArgs(args)) }] };
      if (name === FLOW_ANSWER_TOOL) return { content: [{ type: 'text', text: f.answer(parseFlowAnswerArgs(args)) }] };
      onlyKeys(args, ['run']);
      return { content: [{ type: 'text', text: f.stop(runArg(args)) }] };
    }
    if (ctx.desk && (DESK_TOOLS as readonly unknown[]).includes(name)) {
      return { content: [{ type: 'text', text: (await deskCall(name, args, ctx.desk()))! }] };
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
      return result({ tools: tools(ctx.scope(), ctx.desk ? (ctx.deskHint?.() ?? {}) : undefined, Boolean(ctx.writeNote), Boolean(ctx.flows)) });
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
