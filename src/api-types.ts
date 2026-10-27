// Типы ответов HTTP API, общие для сервера и нового UI (web/). Только типы, без рантайма и без импортов:
// web/ берёт их через `import type` из @server/api-types, и в бандл браузера отсюда ничего не попадает.

/** Тело ошибки любого маршрута. code — машинная причина (conflict, locked, not_paused, readonly, missing, unknown_key, too_big). */
export type ApiErrorBody = { error: string; code?: string };

/** GET /api/config. */
export type ConfigResponse = {
  defaultCwd: string;
  home: string;
  flowsDir: string;
  runsDir: string;
  tools: readonly string[];
  implicitTools: readonly string[];
  /** Что умеет этот сервер: UI новее сервера прячет то, чего здесь нет. */
  features: string[];
};

export type LimitWindow = {
  /** Сколько окна израсходовано, 0–100. */
  percent: number | null;
  /** Когда окно сбросится, ISO 8601. */
  resetsAt: string | null;
};

/** GET /api/limits: лимиты подписки Claude. */
export type Limits = {
  /** false — лимиты подписки не применяются (ключ API, Bedrock, Vertex): окон нет. */
  available: boolean;
  subscription: string | null;
  fiveHour: LimitWindow | null;
  weekly: LimitWindow | null;
  /** Когда данные получены, ISO 8601. */
  at: string;
};

// ---------- вопросы агента (AskUserQuestion)

export type AskOption = { label: string; description?: string };
export type AskQuestion = { question: string; header: string; multiSelect?: boolean; options: AskOption[] };
/** Ответы: ключ = текст вопроса, значение = label выбранного варианта, список через ", " или свободный текст. */
export type AskAnswers = Record<string, string>;

export type QuestionRecord = {
  id: string;
  block: string;
  iteration: number;
  phase: string;
  title: string;
  questions: AskQuestion[];
  /** Текст агента прямо перед вопросом (markdown): то, о чём спрашивают. Нет — агент ничего не написал. */
  preface?: string;
  askedAt: string;
  answers?: AskAnswers;
  answeredAt?: string;
};

// ---------- запуски

/** Сводка запуска и после какой итерации какого блока она написана. */
export type RunDigest = { text: string; block: string; iteration: number; at: string };

/** Задача Jira, MR или ветка, из которой запущен запуск. */
export type RunSource = {
  type: 'jira' | 'mr' | 'branch';
  /** KEY-123, !42 (ref MR) или имя ветки. */
  key: string;
  title: string;
  url?: string;
  /** Корень проекта (основной checkout). */
  project?: string;
};

export type RunWorktree = { path: string; branch?: string };

/** Элемент GET /api/runs. */
export type RunSummary = {
  id: string;
  flow: string;
  /** Имя запуска от модели; нет — заголовком в UI идёт flow. */
  title?: string;
  status: string;
  iterations: number;
  totalCostUsd: number;
  startedAt: string;
  finishedAt?: string;
  input: string;
  /** Рабочая директория агентов — по ней UI группирует запуски по проектам. */
  cwd?: string;
  hidden: boolean;
  /** Задача Jira, MR или ветка, из которой запущен: по ней главная показывает связанные запуски. */
  source?: RunSource;
  worktree?: RunWorktree;
  /** Доп. директории запуска: из них и из cwd собираются недавние пути формы запуска. */
  addDirs?: string[];
  /** Разовый запуск: пометка в списке, вместо «Открыть flow» — «Сохранить как flow». */
  adhoc?: true;
  /** Теги задачи: чипы в списке запусков. */
  tags?: string[];
  /** Теги знаний запуска: чипы рядом с тегами задачи. */
  knowledge?: string[];
};

/** Идущий этап: у параллельной группы их несколько. */
export type RunningPhase = { block: string; iteration: number; phase: string; title: string; group?: string };

/** Вердикт проверки для строки запуска на главной: text — начало замечаний, summary — итог итерации от модели. */
export type HomeCond = { iteration: number; type: string; done: boolean; text: string; summary?: string };

/** Идущий запуск на главной (GET /api/home), с открытыми вопросами. */
export type HomeRun = {
  id: string;
  flow: string;
  title?: string;
  cwd: string;
  input: string;
  status: string;
  /** requested — текущий шаг доигрывает, paused — запуск стоит. */
  pause: 'requested' | 'paused' | null;
  startedAt: string;
  totalCostUsd: number;
  iterations: number;
  maxIterations: number;
  blocks: { name: string; title?: string; status: string; iterations: number; maxIterations: number; looped: boolean }[];
  /** Идущий шаг: этап или проверка условия; между шагами null. */
  current: { block: string; iteration: number; title: string } | null;
  running: RunningPhase[];
  questions: QuestionRecord[];
  conds: HomeCond[];
  digest?: RunDigest;
  /** Пауза по просьбе агента. */
  pauseReason?: { phase: string; iteration: number; at?: string };
  /** У flow есть артефакт решений: ответ на паузу пишется на странице запуска. */
  decisions?: true;
};

export type HomeResponse = { runs: HomeRun[] };

/** Событие общего потока /api/events: что поменялось и в каком запуске. Вопрос и итог приходят целиком, чтобы UI мог показать уведомление. */
export type HomeEvent<T extends string = string> = {
  type: T;
  runId: string;
  flow: string;
  question?: QuestionRecord;
  /** Только у end. */
  status?: string;
  /** У end, title и digest: итог запуска. */
  costUsd?: number;
  /** Только у title: имя запуска от модели. */
  title?: string;
};

/** Событие ленты главной (GET /api/feed): вопрос агента, пауза по его просьбе, конец запуска. */
export type FeedItem = {
  /** Стабильный ключ события. */
  id: string;
  kind: 'question' | 'pause' | 'end';
  at: string;
  runId: string;
  flow: string;
  /** Вопрос: заголовок; пауза: этап, который её попросил. */
  title?: string;
  /** Вопрос: сами вопросы; пауза: что нужно от пользователя; конец: ошибка. */
  text?: string;
  /** Вопрос: когда ответили; пауза: когда запуск пошёл дальше. */
  doneAt?: string;
  /** Вопрос ждёт ответа или запуск стоит на этой паузе прямо сейчас. */
  open?: boolean;
  status?: string;
  costUsd?: number;
};

export type FeedResponse = { items: FeedItem[] };

// ---------- flow: список, сводка, коннекторы и теги для конструктора

export type PhaseSummary = { name: string; title?: string; tools: string[]; group?: string };

export type BlockSummary = {
  name: string;
  title?: string;
  /** Есть ли цикл; без него блок проходит один раз. */
  looped: boolean;
  maxIterations: number;
  condition: string;
  onFail: 'stop' | 'continue';
  phases: PhaseSummary[];
};

export type FlowSummary = {
  name: string;
  file: string;
  /** Папка внутри flows/ ('' — корень). */
  folder: string;
  valid: boolean;
  error?: string;
  description?: string;
  input?: string;
  /** Лимит итераций, если блок один; у многоблочного флоу лимиты в blocks. */
  maxIterations?: number;
  condition?: string;
  /** Все этапы по порядку, через все блоки. */
  phases?: PhaseSummary[];
  blocks?: BlockSummary[];
};

/** Элемент GET /api/flows: сводка flow (у невалидного — только имя, папка и ошибка). */
export type FlowListItem = FlowSummary;

/** Шаг ИИ-сессии над flow: генерация, сама правка или починка после неё (attempt из of), когда flow не прошёл валидацию. */
export type FlowAiStage = { kind: 'generate' } | { kind: 'edit' } | { kind: 'repair'; attempt: number; of: number };
/** Что done потока добавляет к обычному телу ответа: фактическая модель (нет — init не пришёл) и длительность всего запроса. */
export type FlowAiDone = { model?: string; durationMs: number };
/**
 * POST /api/flows/generate и /api/flows/:name/edit с Accept: application/x-ndjson — ход ИИ-сессии построчно.
 * progress — модель (как только её назвал system/init), повтор запроса к API, шаг; log — строка хода (текст агента,
 * вызов инструмента); done — тело, которое без заголовка пришло бы одним JSON, плюс FlowAiDone; error — ошибка, поток закрыт.
 * B — тело маршрута: в web/ — FlowGenerated или FlowEdited (spec типизирован там).
 */
export type FlowAiStreamEvent<B = Record<string, unknown>> =
  | { type: 'progress'; model?: string; retry?: { attempt: number; maxRetries: number; delayMs: number }; stage?: FlowAiStage }
  | { type: 'log'; line: string }
  | { type: 'done'; body: B & FlowAiDone }
  | { type: 'error'; error: string };

/** GET /api/connectors: коннекторы claude.ai аккаунта и их инструменты. read — только читает; write — меняет что-то снаружи. */
export type ConnectorToolView = { name: string; tool: string; description?: string; readOnly: boolean };
/** name — запись для tools этапа, которая разрешает весь коннектор: mcp__claude_ai_<Коннектор>. */
export type ConnectorView = { server: string; name: string; status: string; tools: ConnectorToolView[] };
export type ConnectorsView = { connectors: ConnectorView[]; at: string };

export type TagKind = 'task' | 'knowledge';
/** Элемент GET /api/tags. */
export type TagListItem = { slug: string; kind: TagKind; title?: string; updatedAt: string; runs: number; preview: string };

/** interrupted раннер не пишет: так сервер показывает running-запуск, чей процесс умер, не дописав run.json. */
export type RunStatus = 'running' | 'done' | 'max_iterations' | 'failed' | 'budget_exceeded' | 'aborted' | 'interrupted';

export type TagRun = { id: string; flow: string; finishedAt: string; status: RunStatus };

export type TagMeta = {
  slug: string;
  kind: TagKind;
  title?: string;
  /**
   * Заголовок придумала модель автотега по недоверенному тексту задачи: в блок тега для промптов он не попадает, пока
   * его не перепишут на странице «Теги».
   */
  autoTitle?: true;
  /**
   * Тег знаний: короткое «когда нужен этот тег», до TAG_DESCRIPTION_MAX знаков. Идёт одной строкой в промпт каждого
   * этапа блока; полный текст этап запрашивает инструментом knowledge_read.
   */
  description?: string;
  /**
   * Тег знаний: заметки всегда вставляются в промпт целиком (как до прогрессивного раскрытия) — для коротких правил,
   * которые должны действовать всегда. Без поля — режим по запросу: строка в промпте и инструмент knowledge_read.
   */
  inline?: true;
  createdAt: string;
  updatedAt: string;
  /** Абсолютные пути (папки или файлы), которые тег открывает этапам на чтение. */
  dirs?: string[];
  /** Последние запуски, свежие сверху, не больше TAG_RUNS_MAX. */
  runs: TagRun[];
};

export type Tag = TagMeta & { summary: string; notes: string; attachments: string[] };

/** GET /api/tags/:slug: тег и блок, который сервер вставит в запуск (input). */
export type TagDetail = Tag & { input: string };

// ---------- форма запуска: недавние папки, worktree, ответ POST /api/runs

/** Элемент GET /api/dirs/recent (и ответа DELETE): свежие сверху, без worktree. */
export type RecentDir = { path: string; label: string; lastUsed?: string; exists: boolean };

/** POST /api/worktrees: note — строка для задачи («Директория проекта — новый git worktree …»). */
export type WorktreeResult = { path: string; branch?: string; created: boolean; copied: string[]; note: string };

/** POST /api/runs: id запуска; autoTag — заведённый тег или почему не завёлся (запуск идёт и без него). */
export type RunStarted = { id: string; autoTag?: { slug: string; title?: string } | { error?: string } };

// ---------- интеграции: Jira, проекты GitLab и GitHub, MR/PR, которым нужно внимание

export type JiraIssueBrief = {
  key: string;
  title: string;
  status: string;
  statusCategory: string;
  type: string;
  priority?: string;
  updated?: string;
  parent?: { key: string; title: string };
  url: string;
};

/** Проект «Подключений»: настройки и origin на GitLab или GitHub. */
export type ProjectInfo = {
  path: string;
  name: string;
  base?: string;
  copyFiles?: string[];
  manual?: boolean;
  remote?: { host: string; path: string };
  /** Где origin: gitlab — MR через glab, github — PR через gh. */
  forge?: 'gitlab' | 'github';
  webUrl?: string;
};

/** GET /api/integrations. */
export type IntegrationsInfo = {
  jira: { baseUrl: string; email: string; lastJql?: string; hasToken: boolean } | null;
  presets: Record<string, string>;
  projects: ProjectInfo[];
  worktreesDir: string;
  glab: boolean;
  gh: boolean;
};

/** MR проекта в списке главной (GET /api/projects/mrs). */
export type MergeRequestView = {
  iid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  draft: boolean;
  url: string;
  ref: string;
  hasConflicts: boolean;
};

/** Локальная ветка проекта (GET /api/projects/branches); worktree — путь, если ветка в нём. */
export type BranchView = { name: string; upstream?: string; updated: string; subject: string; current: boolean; worktree?: string };

export type AttentionReasons = {
  /** Последний пайплайн ветки упал. */
  ci?: { status: string; url: string };
  /** Неразрешённые обсуждения, где последнее слово не моё. */
  replies: number;
  conflicts: boolean;
};

export type AttentionItem = {
  ref: string;
  iid: number;
  title: string;
  url: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  updated?: string;
  /** Корень проекта (основной checkout) и его имя на главной. */
  project: string;
  projectName: string;
  reasons: AttentionReasons;
};

/** GET /api/attention. */
export type AttentionResult = { items: AttentionItem[]; errors: { project: string; name: string; error: string }[]; at: string };

/** Подсказка flow к MR; flow null — подходящего нет. */
export type Suggestion = { flow: string | null; why: string };

/** POST /api/intake: текст входа flow из задачи, MR или ветки. */
export type Intake = { input: string; source: RunSource; branch?: string };

// ---------- отчёт запуска (run.json, GET /api/runs/:id) и события потока /api/runs/:id/events

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Токены сессии этапа. Контекст запроса — input + чтение и запись кэша одного запроса главного цикла к модели:
 * contextStart — первый запрос (системный промпт, инструменты, промпт этапа), contextPeak — самый большой.
 * input/output/cacheRead/cacheCreation — итог по всем моделям сессии, включая сабагентов (modelUsage результата);
 * их нет, если сессия оборвалась без результата: частичные суммы занизили бы итог по запуску.
 * contextWindow — окно модели главного цикла из modelUsage результата (не окно автокомпакта, не сабагентов); нет —
 * результата не было, SDK прислал 0 или запись главной модели не опознана.
 * Разведка SDK 0.3.285 (haiku-4-5, sonnet-5-5, sonnet-5-5[1m]; строковый промпт): ключ modelUsage совпадает с model
 * из system/init (у `[1m]` — вместе с суффиксом, canonicalModel без него); contextWindow 200000 у haiku и 1000000
 * у sonnet; getContextUsage на потоке со строковым промптом работает сразу после init (десятки мс), его
 * maxTokens и rawMaxTokens равны contextWindow.
 */
export type SessionTokens = {
  contextStart: number;
  contextPeak: number;
  /** Запросов главного цикла к модели (не ходов: один ход может быть несколькими сообщениями). */
  requests: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  contextWindow?: number;
};

export type ArtifactAuthor =
  | { kind: 'phase' | 'unknown'; block: string; iteration: number; phase: string; at: string }
  | { kind: 'user'; via: 'ui' | 'skill' | 'chat'; at: string }
  | { kind: 'outside'; at: string }
  | { kind: 'condition'; block: string; iteration: number; at: string }
  | { kind: 'initial' }
  | { kind: 'empty' };

/** Версия артефакта после изменения. stored: false — копии содержимого нет (файл больше 1 МБ или история больше 200 МБ). */
export type ArtifactVersion = { n: number; at: string; author: ArtifactAuthor; size: number; stored: boolean; fromRun?: string };

/** Пункты markdown-чек-листа: open — «- [ ]», done — «- [x]»/«- [X]». */
export type ArtifactTasks = { open: number; done: number };

export type ArtifactMeta = {
  key: string;
  title: string;
  file: string;
  size: number;
  /** sha256 содержимого; у файла больше 8 МБ — размер и время изменения. */
  hash: string;
  mtimeMs: number;
  /** Содержимое взято из этого запуска при продолжении. */
  fromRun?: string;
  decisions?: true;
  /** Пункты чек-листа текущей версии (только .md); нет — чек-листа нет или файл больше 8 МБ. */
  tasks?: ArtifactTasks;
  /** Автор текущего состояния — versions.at(-1).author. */
  versions: ArtifactVersion[];
};

export type DenialReason = 'artifact-readonly' | 'not-artifact' | 'outside-artifacts' | 'runs-dir' | 'isolation';
export type Denial = { tool: string; reason: DenialReason; count: number };

/** report.artifacts: артефакты запуска, откуда взяты при продолжении, предупреждения уровня запуска. */
export type ArtifactsReport = { items: ArtifactMeta[]; from?: string; warnings: string[] };
/** Что шаг сделал с артефактами: у этапа и у проверки условия. */
export type StepArtifacts = { changed: string[]; warnings: string[] };

/** Артефакт в событии и списке: без текста и версий, с блокировкой. */
export type ArtifactLite = {
  key: string;
  title: string;
  file: string;
  size: number;
  hash: string;
  author: ArtifactAuthor;
  at?: string;
  versions: number;
  /** Этапы идущего шага, которые пишут этот артефакт: пока они идут, правка в UI закрыта. */
  lockedBy: string[];
  decisions?: true;
  fromRun?: string;
  tasks?: ArtifactTasks;
};

/** Состояние артефактов шага целиком (не приращение): UI заменяет им прежнее по блоку, итерации и этапу. */
export type StepDelta = {
  block?: string;
  iteration?: number;
  phases: { phase: string; changed: string[]; warnings: string[]; denials: Denial[] }[];
  condition?: StepArtifacts;
  /** Предупреждения уровня запуска, весь список. */
  run?: string[];
};

/**
 * Почему артефакт сейчас не правится в UI (artifactEditability):
 * writing — его пишет идущий шаг, asking — спросивший этап ждёт ответа и сам его пишет, cli — запуск идёт из CLI,
 * done — запуск завершён, not-continuable — не done, но продолжить нельзя, continuable — правка попадёт в продолжение,
 * too-big — файл больше 1 МБ.
 */
export type EditReason = 'writing' | 'asking' | 'cli' | 'done' | 'not-continuable' | 'continuable' | 'too-big';
export type Editability = { editable: boolean; reason?: EditReason; message?: string; phases?: string[] };

/** Элемент GET /api/runs/:id/artifacts: артефакт без текста, путь к файлу, пропал ли файл и можно ли править. */
export type ArtifactListItem = ArtifactLite & Editability & { path?: string; missing?: boolean };
export type ArtifactList = { items: ArtifactListItem[]; from?: string; warnings: string[]; live: boolean; continuable: boolean; continueReason?: string };

/**
 * GET /api/runs/:id/artifacts/:key[?version=N]: текст (null — файл больше 8 МБ или версия без копии, причина в textMessage),
 * хэш — база для записи, версии, можно ли править. С version — выбранная версия вместо текущей.
 */
export type ArtifactRead = Editability & {
  key: string;
  title: string;
  file: string;
  path: string;
  versions: ArtifactVersion[];
  lockedBy: string[];
  decisions?: boolean;
  fromRun?: string;
  text: string | null;
  textMessage?: string;
  hash?: string;
  size?: number;
  mtimeMs?: number;
  author?: ArtifactAuthor;
  at?: string;
  /** Файл изменён после последней записанной версии. */
  unrecorded?: boolean;
  tasks?: ArtifactTasks;
  version?: { n: number; at: string; author: ArtifactAuthor; size: number; stored: boolean };
};

/** PUT /api/runs/:id/artifacts/:key: записано; readers — этапы идущего шага, уже получившие прежнюю версию. */
export type ArtifactSaved = { ok: true; hash: string; author: ArtifactAuthor; readers: string[]; resumed: boolean };

/** Ответ пользователя на паузу, дописанный в артефакт decisions. */
export type PauseAnswer = { text: string; via: 'ui' | 'skill' | 'chat'; at: string };

/** Тип условия остановки блока (until.type во flow.yaml). */
export type UntilType = 'judge' | 'command' | 'marker' | 'none';

/** Этап попросил решения пользователя: закончил вывод маркером loop.pause_marker. */
export type PauseReason = {
  block: string;
  iteration: number;
  phase: string;
  /** Текст над маркером (хвост): вопросы и причина. */
  text: string;
  /** Вывод этапа целиком, путь относительно runDir. */
  output: string;
  /** Когда этап попросил паузу. В отчётах до появления ленты событий его нет. */
  at?: string;
  /** Когда запуск пошёл дальше. Только в истории report.pauses. */
  resumedAt?: string;
  /** Ответ пользователя, дописанный в артефакт decisions при продолжении. Только в истории report.pauses. */
  answer?: PauseAnswer;
};

export type PhaseFiles = { prompt: string; transcript: string; output: string };

export type PhaseReport = {
  block: string;
  iteration: number;
  index: number;
  phase: string;
  title: string;
  tools: string[];
  /** Параллельная группа этапа; у этапа вне группы поля нет. */
  group?: string;
  ok: boolean;
  subtype: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  chars: number;
  sessionId?: string;
  errors: string[];
  /** Пути относительно runDir. */
  files: PhaseFiles;
  /** Только у flow с артефактами: какие артефакты этап изменил и предупреждения о нём (дописываются после шага). */
  artifacts?: StepArtifacts;
  /** Отклонённые проверкой вызовы инструментов этапа (сейчас — защита артефактов и папки запусков). */
  denials?: Denial[];
  /** Модель этапа: фактическая из system/init, а без init — заданная; нет, если не известна ни та ни другая. */
  model?: string;
  /** Заданный effort этапа (этап → defaults); SDK фактический не отдаёт. Нет, если не задан. */
  effort?: EffortLevel;
  /** Токены сессии этапа: контекст первого и самого большого запроса, итог input/output/кэша, окно модели главного цикла (contextWindow, нет — неизвестно); нет — SDK не прислал usage. */
  tokens?: SessionTokens;
};

export type ConditionReport = {
  block: string;
  iteration: number;
  type: UntilType;
  done: boolean;
  feedback: string;
  detail?: string;
  costUsd: number;
  /** Путь относительно runDir (лог команды или промпт судьи). */
  logFile?: string;
  /** Только у flow с артефактами: что изменилось во время проверки и предупреждения о ней. */
  artifacts?: StepArtifacts;
  /**
   * Итог итерации от модели (run-digest.ts): что сделано, почему условие выполнено или нет, что дальше. Дописывается
   * позже события condition — событием digest. Нет — итога не было (опция выключена, сбой, таймаут): UI берёт feedback.
   */
  summary?: string;
};

export type BlockStatus = 'pending' | RunStatus;

export type BlockReport = {
  index: number;
  name: string;
  title: string;
  status: BlockStatus;
  iterations: number;
  maxIterations: number;
  /** Тип условия; у блока без цикла — none. */
  condition: UntilType;
  /** Есть ли у блока цикл (без него — один проход). */
  looped: boolean;
  onFail: 'stop' | 'continue';
  /** Пройден в запуске, который этот продолжает (continuedFrom), и не повторялся. */
  skipped?: boolean;
};

/** reused — провал с теми же замечаниями, что и прошлый: итог взят у прошлой итерации, модель не звали. */
export type DigestSession = { calls: number; costUsd: number; failed: number; reused: number; error?: string };

export type TagSummaryReport = { tag: string; ok: boolean; costUsd: number; error?: string; skipped?: string; tokens?: SessionTokens };

/** Автотег: заведённый тег задачи (slug, title) или ошибка подбора. */
export type AutoTagReport = { slug?: string; title?: string; error?: string; costUsd: number; tokens?: SessionTokens };

/** Этап последнего шага запуска; output — путь вывода относительно runDir. */
export type FinalPhase = { block: string; iteration: number; phase: string; title: string; ok: boolean; output: string };

export type RunReport = {
  id: string;
  flow: string;
  description?: string;
  input: string;
  cwd: string;
  status: RunStatus;
  /** Итераций всего, по всем блокам. */
  iterations: number;
  /** Сумма лимитов итераций блоков. */
  maxIterations: number;
  totalCostUsd: number;
  blocks: BlockReport[];
  phases: PhaseReport[];
  conditions: ConditionReport[];
  questions: QuestionRecord[];
  runDir: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Пауза: requested — текущий шаг доигрывает, paused — запуск ждёт продолжения. Статус при этом running. */
  pause?: 'requested' | 'paused';
  /** Почему запуск на паузе, если её попросил агент. Снимается при продолжении. */
  pauseReason?: PauseReason;
  /** Все паузы по просьбе агента за запуск, с временем: по ним строится лента событий главной. */
  pauses?: PauseReason[];
  /** Процесс раннера: по нему сервер отличает идущий запуск от брошенного (сервер перезапущен или упал). */
  pid?: number;
  /** Скрыт из истории в UI. Пишет сервер у завершённого запуска, раннер не трогает. */
  hidden?: boolean;
  /** Id запуска, который этот продолжает: его done-блоки пропущены, их выводы подставлены. */
  continuedFrom?: string;
  /** Разовый запуск: flow берётся из снимка flow.yaml в папке запуска, а не из flows/ по имени. У обычных поля нет. */
  adhoc?: true;
  source?: RunSource;
  worktree?: RunWorktree;
  /** Доп. директории уровня запуска, абсолютными путями. */
  addDirs?: string[];
  /** Вложения к задаче, пути относительно runDir. */
  attachments?: string[];
  /** Итог: последний шаг запуска (см. finalPhases). Пишется в конце; у старых отчётов его досчитывает сервер. */
  final?: FinalPhase[];
  /** Артефакты запуска: метаданные, последний автор, версии, предупреждения уровня запуска. Только у flow с артефактами. */
  artifacts?: ArtifactsReport;
  /** Теги задачи (слаги). У запусков без тегов поля нет. */
  tags?: string[];
  /** Галочка «Обновить саммари тегов»: наследуется продолжением. Только при тегах. */
  saveTag?: boolean;
  /** Итог сессии саммари по каждому тегу, в порядке tags: обновлено (ok), пропущено (skipped — причина) или ошибка. */
  tagSummaries?: TagSummaryReport[];
  /** Теги области знаний запуска (слаги); наследуются продолжением. У запусков без них поля нет. */
  knowledge?: string[];
  /** Автотег: заведённый тег задачи (slug, title) или ошибка подбора. Только у запусков с галочкой; продолжение не наследует. */
  autoTag?: AutoTagReport;
  /** Имя запуска от модели или унаследованное продолжением. Нет — заголовком в UI остаётся flow. */
  title?: string;
  /** Сессия подбора имени: стоимость (входит в totalCostUsd) и ошибка. У продолжения с готовым именем поля нет. */
  titleSession?: { costUsd: number; tokens?: SessionTokens; error?: string };
  /** Сводка «где мы сейчас» от модели: обновляется после каждой проверки условия и каждого блока без цикла. */
  digest?: RunDigest;
  /** Сессии итогов: вызовы, стоимость (входит в totalCostUsd), сбои с последней ошибкой, повторы без вызова. */
  digestSession?: DigestSession;
  /** Указания пользователя по ходу запуска: ждущие и применённые (где — в applied). У запусков без указаний поля нет. */
  notes?: RunNote[];
  /** Правки flow этого запуска на паузе, по порядку; снимок flow.yaml — последняя версия. Есть — продолжение берёт снимок. */
  flowEdits?: RunFlowEdit[];
};

/** GET /api/runs/:id: отчёт, идёт ли запуск в этом сервере и можно ли его продолжить (canContinue). */
export type RunDetail = RunReport & { live: boolean; continuable?: boolean; continueReason?: string };

// ---------- «Починить и продолжить» (src/run-fix.ts): указания, правка flow идущего запуска, повтор итерации

/** Откуда пришли указание или правка: кнопки UI, хелпер скилла, чат запуска. */
export type RunFixVia = 'ui' | 'skill' | 'chat';

/**
 * Указание идущему запуску (POST /api/runs/:id/note): хвост «Указание пользователя» в промпте. next — только следующему
 * шагу (этапу, всем участникам группы или судье), run — каждому шагу до конца запуска. applied — где уже применено:
 * phase — имя этапа, у судьи — '#cond'.
 */
export type RunNote = {
  id: string;
  text: string;
  scope: 'next' | 'run';
  at: string;
  via: RunFixVia;
  applied?: { block: string; iteration: number; phase: string; at: string }[];
};

/**
 * Правка flow идущего запуска на паузе: PUT /api/runs/:id/flow (source edit) или POST …/flow/reload (reload — из flows/).
 * version — номер нового снимка flow.yaml (исходный — 0; прошлые версии лежат рядом как flow.N.yaml). changed — что
 * поменялось, по-человечески. savedToFlows — правку записали и в flows/<имя>.yaml; saveError — записать не вышло
 * (правка запуска при этом действует).
 */
export type RunFlowEdit = { version: number; at: string; source: 'edit' | 'reload'; via: RunFixVia; changed: string[]; savedToFlows?: boolean; saveError?: string };

export type RunEvent =
  | { type: 'start'; report: RunReport }
  | { type: 'block_start'; block: BlockReport; total: number }
  | { type: 'block_end'; block: BlockReport }
  | { type: 'iteration'; block: string; iteration: number; max: number }
  /** files — пути промпта и транскрипта (от runDir): промпт уже записан, их можно открыть до конца этапа. */
  | { type: 'phase_start'; block: string; iteration: number; index: number; phase: string; title: string; tools: string[]; files: PhaseFiles; group?: string; model?: string; effort?: EffortLevel }
  /** Фактическая модель этапа из system/init: приходит после phase_start, один раз, и только если init был. */
  | { type: 'phase_model'; block: string; iteration: number; phase: string; model: string }
  /**
   * Занятость контекста идущего этапа: после каждого запроса главного цикла к модели. Пик, число запросов и окно
   * модели (нет, пока неизвестно). Сервер хранит только последний снимок этапа и ни в ленту событий, ни на главную не шлёт.
   */
  | { type: 'phase_context'; block: string; iteration: number; phase: string; contextPeak: number; requests: number; contextWindow?: number }
  | { type: 'log'; block: string; iteration: number; phase: string; line: string }
  | { type: 'phase_end'; report: PhaseReport }
  /** file — промпт судьи (от runDir), уже записан к моменту события. */
  | { type: 'condition_start'; block: string; iteration: number; kind: UntilType; detail: string; file?: string }
  | { type: 'condition'; report: ConditionReport }
  | { type: 'question'; question: QuestionRecord }
  | { type: 'answer'; question: QuestionRecord }
  | { type: 'pause'; state: 'requested' | 'paused' | 'resumed'; reason?: PauseReason }
  /** Лимит итераций блока изменён на ходу; total — новая сумма лимитов. */
  | { type: 'limit'; block: string; max: number; total: number }
  /**
   * Артефакты изменились или сменилась блокировка: снимок списка и итог шага (step), если шаг закончился.
   * steps — только при переигрывании живого запуска сервером: итоги всех шагов вместо ленты событий.
   */
  | { type: 'artifacts'; items: ArtifactLite[]; step?: StepDelta; steps?: StepDelta[] }
  /** Запуск закончен done, идёт сессия саммари тега tag; file — её промпт (от runDir), уже записан. */
  | { type: 'tag_summary_start'; tag: string; file: string }
  | { type: 'tag_summary'; tag: string; report: TagSummaryReport }
  /** Подбор имени закончен: имя или ошибка; totalCostUsd — итог запуска уже со стоимостью подбора. */
  | { type: 'title'; title?: string; error?: string; totalCostUsd: number }
  /**
   * Итог готов: summary — итог итерации (дописан в её ConditionReport), digest — новая сводка запуска; нет поля —
   * его не обновили. totalCostUsd — итог запуска уже со стоимостью вызова.
   */
  | { type: 'digest'; block: string; iteration: number; summary?: string; digest?: RunDigest; totalCostUsd: number }
  /** Указание добавлено (applied нет) или применено к шагу: в applied — только новые записи, клиент дописывает их к прежним. */
  | { type: 'note'; note: RunNote }
  /**
   * Flow запуска поправили на паузе: снимок flow.yaml уже новый (граф его перечитывает), blocks и maxIterations — отчёты
   * блоков и лимит после правки. Событие самодостаточно: при переигрывании оно идёт по порядку с остальными.
   */
  | { type: 'flow'; edit: RunFlowEdit; blocks: BlockReport[]; maxIterations: number }
  | { type: 'end'; report: RunReport };

/** Что сервер шлёт в поток запуска: события раннера и ошибка «запуск не найден» (запуска нет ни живого, ни на диске). */
export type RunStreamEvent = RunEvent | { type: 'error'; message: string };

// ---------- чат запуска (src/chat.ts)

export type ChatMessage = {
  role: 'user' | 'assistant' | 'note';
  text: string;
  at: string;
  /** Стоимость ответа (у assistant). */
  costUsd?: number;
  error?: boolean;
  /** Чат продолжил запуск: id нового, UI покажет ссылку. Так было до кнопок propose_actions — в старых историях. */
  openRun?: string;
  /** Что агент делал за ход (у assistant): вызовы инструментов по порядку. В старых историях нет. */
  steps?: ChatStep[];
  /** Виджеты под ответом (у assistant) в порядке вызова: таблицы, ссылки, кнопки, варианты ответа. */
  widgets?: ChatWidget[];
};

export type ChatLog = {
  /** Сессия Claude, которую продолжает следующее сообщение. Нет — следующее начнёт новую. */
  sessionId?: string;
  /** cwd сессии: сохранённая сессия лежит в папке проекта и продолжается только из той же директории. */
  cwd?: string;
  /** Накопленная стоимость сессии по данным SDK: при resume он отдаёт сумму с начала сессии, а не за ход. */
  sessionCostUsd?: number;
  messages: ChatMessage[];
  /** Всего потрачено чатом этого запуска, очистка контекста не сбрасывает. */
  totalCostUsd: number;
};

/** GET и DELETE /api/runs/:id/chat: история и идущий ход ответа (busy; live — его шаги, текст и виджеты). */
export type ChatPayload = { messages: ChatMessage[]; totalCostUsd: number; sessionId?: string; busy: boolean; live?: ChatLive };

/**
 * Строка NDJSON-ответа POST /api/runs/:id/chat. step — новый шаг или тот же с ошибкой (по index), text — текст агента
 * по ходу ответа, widget — виджет под ответом, effect — ход что-то поменял: UI перечитывает артефакты, flow или список запусков.
 */
export type ChatStreamEvent =
  | { type: 'saved'; chat: ChatPayload }
  | { type: 'step'; index: number; step: ChatStep }
  | { type: 'text'; text: string }
  | { type: 'widget'; widget: ChatWidget }
  | ({ type: 'effect' } & ChatEffect)
  | { type: 'done'; chat: ChatPayload }
  | { type: 'error'; error: string };

/** Шаг хода чата — вызов инструмента. Подпись («Читает …», «Поставил на паузу») строит UI по tool и target. */
export type ChatStep = {
  /** Инструмент как вызван: Read, Bash, mcp__run__pause_run… */
  tool: string;
  /** Главный аргумент коротко: путь, команда, шаблон поиска, ключ артефакта, «блок → лимит». */
  target?: string;
  /** Файл папки запуска, путь от неё: UI откроет его в окне файла. */
  runFile?: string;
  /** Файл вне папки запуска, абсолютный путь: ссылка «показать в Finder». */
  path?: string;
  /** Инструмент вернул ошибку: её начало. */
  error?: string;
  /** Вызов сабагента. */
  sub?: true;
};

/** Идущий ход: шаги, последний текст агента, показанные виджеты. */
export type ChatLive = { steps: ChatStep[]; text?: string; widgets: ChatWidget[] };

/** Ссылка show_links: run_file — файл папки запуска (путь от неё), artifact — ключ, phase — этап (карточка в «Обзоре»), path — путь в проекте. */
export type ChatLink = { kind: 'run_file' | 'artifact' | 'phase' | 'path'; ref: string; block?: string; label?: string };

/**
 * Действие кнопки propose_actions — опасное или общее, выполняется только кликом с подтверждением и один раз.
 * apply_flow, reload_flow, restart_iteration — правка flow идущего запуска (на паузе), есть, только когда сервер их умеет.
 */
export type ChatActionKind = 'abort' | 'write_artifact' | 'answer_pause' | 'save_flow' | 'continue' | 'rerun' | 'apply_flow' | 'reload_flow' | 'restart_iteration';

export type ChatAction = {
  /** Номер в сообщении: a1, a2… */
  id: string;
  kind: ChatActionKind;
  /** Текст кнопки от агента. */
  label: string;
  /** Что именно будет сделано, словами сервера: артефакт «План» (plan.md), flows/x.yaml. */
  target?: string;
  /** write_artifact — ключ артефакта. */
  key?: string;
  /** write_artifact — весь новый текст; answer_pause — ответ; save_flow, apply_flow — YAML flow; restart_iteration — указание этапу. */
  text?: string;
  /** continue, rerun — модель и лимит стоимости нового запуска. */
  model?: string;
  maxBudgetUsd?: number;
  /** Состояние, при котором действие предложено (хэш артефакта или файла flow, пауза): другое при клике — expired. */
  base?: string;
  /** Итог клика; нет — ещё не нажимали. */
  state?: 'done' | 'failed' | 'expired';
  /** Что вышло или почему нет. */
  result?: string;
  at?: string;
  /** continue, rerun — id нового запуска. */
  openRun?: string;
};

export type ChatWidget =
  | { type: 'table'; title?: string; columns: string[]; rows: string[][] }
  | { type: 'links'; title?: string; items: ChatLink[] }
  | { type: 'actions'; title?: string; items: ChatAction[] }
  | { type: 'replies'; items: string[] };

/** Что поменялось: artifacts — артефакты запуска, flow — flow (снимок запуска или файл в flows/), run — запуск (runId — новый). */
export type ChatEffect = { kind: 'artifacts' | 'flow' | 'run'; runId?: string };

/**
 * POST /api/runs/:id/chat/action { msgIndex, actionId, saveToFlows? } → действие после клика (state done | failed | expired),
 * история и что поменялось. 409 busy — идёт ход чата, 409 used — уже нажимали, 404 not_found, 423 locked — артефакт пишет этап (кнопка остаётся).
 */
export type ChatActionReply = { action: ChatAction; chat: ChatPayload; effects: ChatEffect[] };

// ---------- страница «Контекст»: GET /api/context, GET|PUT /api/context/file (src/context.ts)

/**
 * Тег знаний блока этапа: exists — тег есть на диске, kind — его вид (тег задачи в knowledge — тоже ошибка запуска).
 * У существующего тега знаний: mode — как он попадает в промпт («inline» — заметки целиком, «on-demand» — строка и
 * инструмент knowledge_read), notesChars/attachments/dirs — объём заметок, число вложений и путей.
 */
export type ContextKnowledge = {
  slug: string;
  exists: boolean;
  kind?: TagKind;
  title?: string;
  description?: string;
  mode?: 'inline' | 'on-demand';
  notesChars?: number;
  attachments?: number;
  dirs?: number;
};

export type MemoryFile = { path: string; type: string; tokens: number; editable: boolean };

/**
 * Часть промпта этапа по источнику: шаблон промпта, handoff, список доп. директорий, строки тегов знаний по запросу,
 * тег знаний целиком (inline). chars — знаков в шаблоне до подстановок: {{input}}, {{prev}} и артефакты известны только в запуске.
 */
export type ContextPromptPart = { name: string; kind: 'prompt' | 'handoff' | 'dirs' | 'knowledge-lines' | 'knowledge-inline'; chars: number };

/** Промпт этапа по источникам: части, переменные шаблона и общий размер в знаках. */
export type ContextPrompt = { parts: ContextPromptPart[]; vars: string[]; chars: number };

/** GET /api/context: что получит сессия этапа до первого сообщения. */
export type ContextView = {
  cwd: string;
  flow?: string;
  phase?: string;
  model: string;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories: { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[];
  memoryFiles: MemoryFile[];
  skills: { name: string; source: string; tokens: number }[];
  agents: { name: string; source: string; tokens: number }[];
  mcpTools: { name: string; server: string; tokens: number }[];
  /** Инструменты сессии; null — все инструменты Claude Code. */
  tools: string[] | null;
  systemPrompt: 'preset' | 'custom';
  /** Текст custom-промпта (system этапа). */
  systemPromptText?: string;
  addDirs: { path: string; exists: boolean }[];
  /** Теги знаний блока этапа (из knowledge в flow.yaml). */
  knowledge: ContextKnowledge[];
  /** Промпт этапа по источникам; только у запроса с этапом. */
  prompt?: ContextPrompt;
  warnings: string[];
  /** Когда данные получены, ISO 8601. */
  at: string;
};

/** GET /api/context/file: CLAUDE.md или правило из листинга; editable — можно сохранить через PUT. */
export type ContextFile = { path: string; text: string; mtimeMs: number; editable: boolean };

/** PUT /api/context/file: новое mtimeMs файла — с ним идёт следующее сохранение. */
export type ContextFileSaved = { mtimeMs: number };

// ---------- анализ flow по завершённому запуску (src/run-analysis.ts): GET|POST /api/runs/:id/analysis

/** Итерация блока глазами условия: stale — замечания повторяют прошлую итерацию (feedbackKey), агент буксует. */
export type AnalysisIteration = {
  iteration: number;
  done: boolean;
  detail?: string;
  /** Начало замечаний, не больше 300 знаков. */
  feedback: string;
  stale: boolean;
  costUsd: number;
};

export type AnalysisBlock = {
  name: string;
  title: string;
  status: BlockStatus;
  looped: boolean;
  condition: UntilType;
  maxIterations: number;
  iterations: number;
  /** Теги знаний блока из flow. */
  knowledge: string[];
  /** Этапы блока по порядку объявления во flow. */
  phases: string[];
  /** Застой: сколько итераций подряд (включая первую из серии) провалились с теми же замечаниями, максимум по блоку. */
  stuck: number;
  log: AnalysisIteration[];
};

/** Что этап берёт из шаблона промпта: по регэкспам по тексту flow. */
export type AnalysisPromptUses = { prev: boolean; feedback: boolean; phases: string[]; artifacts: string[] };

/** Последний запуск этапа (последняя итерация). */
export type AnalysisPhaseRun = {
  iteration: number;
  ok: boolean;
  subtype: string;
  turns: number;
  costUsd: number;
  durationMs: number;
  chars: number;
  contextPeak?: number;
  /** Доля окна модели в процентах, если окно известно. */
  contextPct?: number;
};

/** Этап flow: сводка по всем запускам (итерациям) и последний запуск. */
export type AnalysisPhase = {
  name: string;
  title: string;
  block: string;
  tools: string[];
  /** Пишущий этап: Edit или Write в tools либо непустой writes. */
  writer: boolean;
  model?: string;
  effort?: EffortLevel;
  group?: string;
  /** Запусков этапа за весь запуск (по итерациям); 0 — этап не выполнялся. */
  runs: number;
  failed: number;
  turnsAvg: number;
  turnsMax: number;
  /** Лимит ходов из flow (этап → defaults); нет — без лимита. */
  maxTurns?: number;
  /** Сколько запусков упёрлось в лимит ходов (subtype error_max_turns). */
  maxTurnsHits: number;
  costUsd: number;
  durationMs: number;
  chars: number;
  /** Максимум пика контекста по запускам и окно модели (последнее известное). */
  contextPeak?: number;
  contextWindow?: number;
  contextPct?: number;
  denials: number;
  /** Длина шаблона промпта во flow (без подстановок). */
  promptChars: number;
  handoff: boolean;
  uses: AnalysisPromptUses;
  reads: string[];
  writes: string[];
  last?: AnalysisPhaseRun;
};

/** Детерминированный дайджест запуска для анализа: без модели, из run.json и flow. */
export type AnalysisFacts = {
  flow: string;
  status: RunStatus;
  totalCostUsd: number;
  durationMs: number;
  phaseCount: number;
  blockCount: number;
  /** Объявленные артефакты flow (ключи). */
  artifacts: string[];
  blocks: AnalysisBlock[];
  phases: AnalysisPhase[];
};

export type AnalysisVerdict = 'keep' | 'improve' | 'rework';
export type AnalysisKind = 'merge' | 'split' | 'remove' | 'tools' | 'condition' | 'prompt' | 'context' | 'parallel' | 'other';
export type AnalysisSeverity = 'high' | 'medium' | 'low';

export type AnalysisSuggestion = {
  kind: AnalysisKind;
  severity: AnalysisSeverity;
  /** Имена этапов, о которых речь. */
  phases: string[];
  title: string;
  why: string;
  how: string;
};

/** runs/<id>/analysis.json: вердикт модели по flow и факты. Сбой модели — error, verdict и summary пустые, факты на месте. */
export type RunAnalysis = {
  at: string;
  model?: string;
  costUsd: number;
  tokens?: SessionTokens;
  verdict?: AnalysisVerdict;
  summary: string;
  suggestions: AnalysisSuggestion[];
  facts: AnalysisFacts;
  error?: string;
};
