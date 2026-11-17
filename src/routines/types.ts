// Рутины: общий контракт ядра (src/routines/*), источников (src/routines/sources/*) и UI (web/src/screens/routines/*).
// Здесь только типы — без импортов node: файл читает и веб через @server/routines/types.
// Спецификация: docs/routines/SPEC.md. Менять контракт — только дописывая поля; переименования согласовать в SPEC.md.

// ---------------------------------------------------------------- событие

/** Событие одного вида: что бы ни прислал источник, рутина видит эти поля. */
export type RoutineEvent = {
  /** Слаг источника (имя файла в ~/.agentgraph/sources без .yaml) или 'schedule'. */
  source: string;
  /** Уникален в пределах источника; уже виденные id не запускаются повторно. */
  id: string;
  /** ISO-время события по данным сервиса (нет — время, когда agentgraph его увидел). */
  at: string;
  /** Что показать в журнале: одна строка. */
  title: string;
  /** Текст события (сообщение, краткое содержание). Уходит агенту в обёртке данных (wrapData). */
  text: string;
  link?: string;
  /** Автор, если у источника он есть (Slack, Telegram, MR): по нему условия и защита от петли. */
  author?: string;
  /** Ответ сервиса целиком (или его часть): по полям работают условия, flow может их читать. */
  fields: Record<string, unknown>;
  /** Куда отвечать «в источник»: тред Slack, чат Telegram, MR. Заполняет вид источника, читает его reply(). */
  replyTo?: Record<string, unknown>;
};

// ---------------------------------------------------------------- источник (файл ~/.agentgraph/sources/<slug>.yaml)

/** Какие поля ответа команды/запроса считать идентификатором, заголовком и т.д. Пути через точку: `data.items`, `meta.id`. */
export type FieldMap = {
  /** Путь к массиву записей в ответе; пусто — ответ сам массив. */
  items?: string;
  id: string;
  title?: string;
  text?: string;
  link?: string;
  at?: string;
  author?: string;
};

export type SourceSpec = {
  title: string;
  /** Вид: command | schedule-less сервисы из готовых (slack, telegram, gitlab, github, jira, rss, folder, email, connector) | рецепты. */
  kind: string;
  /** Настройки вида: команда, канал, JQL, адрес ленты… Без секретов. */
  config: Record<string, unknown>;
  /** Интервал опроса: '30s', '5m', '1h'. У вида есть минимум (connector — 30m). Live-виды (slack с app-токеном, telegram) его не используют. */
  every?: string;
  map?: FieldMap;
  /** Что человек описал словами при подключении — для повторной сборки и показа. */
  description?: string;
  /** Имена нужных ключей. Значения — в ~/.agentgraph/secrets.json (0600), в файл источника не попадают; команде — переменными окружения. */
  secrets?: string[];
};

/** Поле формы настройки вида (шаг «Готовые» и «Своя команда»). */
export type KindField = { key: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean; hint?: string };

/** Поле события, на которое можно поставить условие в редакторе. */
export type MatchField = { key: string; label: string; type: 'text' | 'number' | 'bool' | 'enum'; options?: string[] };

/** Вид источника в UI. */
export type SourceKindView = {
  kind: string;
  title: string;
  /** Одной фразой: что приходит событием. */
  summary: string;
  /** Как приходят события: live — держит соединение, poll — опрос с интервалом, model — через сессию модели (тратит лимит). */
  delivery: 'live' | 'poll' | 'model';
  minEvery: string;
  setup: KindField[];
  match: MatchField[];
  /** Умеет ответить в источник (тред, чат, комментарий). */
  canReply: boolean;
  /** Рецепт из файла (~/.agentgraph/recipes или templates/sources), а не встроенный вид. */
  recipe?: boolean;
};

export type SourceStatus = 'ok' | 'error' | 'idle' | 'needs_secret';

export type SourceView = {
  slug: string;
  spec: SourceSpec;
  status: SourceStatus;
  error?: string;
  lastCheckAt?: string;
  /** Каких ключей не хватает. */
  missingSecrets: string[];
  /** Какие рутины его используют (слаги). */
  usedBy: string[];
};

/** Итог пробной проверки источника: показывается до сохранения («Сервис отвечает, нашёл 3 записи»). */
export type SourceTestResult = {
  ok: boolean;
  /** Что будет выполняться при каждой проверке — человекочитаемо, секреты замаскированы. */
  request: string;
  /** До трёх свежих записей. */
  sample: RoutineEvent[];
  /** Сколько записей вернул сервис. */
  total: number;
  error?: string;
};

// ---------------------------------------------------------------- подключение словами (src/routines/sources/draft.ts)

export type DraftState =
  | { state: 'working'; step: string }
  | { state: 'needs_secret'; secret: string; howTo: string; spec: SourceSpec }
  | { state: 'ready'; spec: SourceSpec; test: SourceTestResult; slug: string }
  | { state: 'error'; error: string; spec?: SourceSpec };

export type DraftView = { id: string; description: string } & DraftState;

// ---------------------------------------------------------------- правило (файл ~/.agentgraph/routines/<slug>.yaml)

/**
 * Условие на поле без модели. Ключ — поле события (title, text, author, link) или путь в fields (channel, labels.0, duration).
 * Суффикс ключа — оператор: без суффикса — равно (строки без учёта регистра; массив значений — любое из), `~` — содержит,
 * `!` — не равно, `>` `<` — числа. Поле-массив совпадает, если совпал хоть один элемент.
 */
export type MatchRule = Record<string, string | number | boolean | Array<string | number>>;

export type WhenSource = {
  source: string;
  match?: MatchRule;
  /** Проверка словами: haiku читает текст события по этому условию. Необязательно. */
  check?: string;
};
export type WhenSchedule = {
  /** cron из 5 полей, локальное время. */
  schedule: string;
  /** Пропущенное, пока приложение было закрыто: спросить один раз на главной или пропустить. */
  missed?: 'ask' | 'skip';
};

/** suggest — событие ждёт «Запустить?» на главной; until_pause — запуск сам, стоит перед pause_before; auto — без остановок. */
export type RoutineMode = 'suggest' | 'until_pause' | 'auto';

/**
 * Ответ наружу. UI шага 4: «После моей проверки» = { to: 'source', on: ['pause','end'], draft: true },
 * «Сразу» = draft: false, «Не сообщать» = { to: 'none' }.
 * to: 'source' — туда, откуда событие; слаг источника с canReply (например telegram-бот) — в его чат.
 */
export type ReplySpec = { to: 'none' | 'source' | string; on?: Array<'start' | 'pause' | 'end'>; draft?: boolean };

export type RoutineSpec = {
  title: string;
  /** false — рутина на паузе (переключатель в списке). По умолчанию true. */
  enabled?: boolean;
  /** Черновик: сохранён с «Новой рутины» и ещё ни разу не включался (enabled: false). Включение снимает признак. */
  draft?: boolean;
  when: WhenSource | WhenSchedule;
  run: {
    flow: string;
    /** Задача flow; событие дописывается к ней в обёртке данных. */
    input?: string;
    space?: string;
    /** Рабочая папка (проект); нет — папка пространства или папка по умолчанию сервера. */
    cwd?: string;
    worktree?: 'new' | 'none';
    /** Блоки flow, перед которыми запуск ждёт человека (опция раннера pauseBefore). */
    pause_before?: string[];
    knowledge?: string[];
    model?: string;
  };
  mode: RoutineMode;
  reply?: ReplySpec;
  limits?: { usd?: number; per_day?: number; parallel?: number };
};

// ---------------------------------------------------------------- журнал и ожидания

export type LogOutcome =
  | 'started' // запуск начат
  | 'waiting' // ждёт человека (suggest или pause_before)
  | 'filtered' // не прошло условия на поля
  | 'check_no' // проверка словами ответила «нет»
  | 'duplicate' // проверка словами нашла дубль
  | 'limit' // упёрлось в per_day / parallel / usd
  | 'rejected' // человек ответил «не то» («Это не баг»)
  | 'missed' // пришло, пока приложение было закрыто
  | 'error';

export type LogEntry = {
  id: string;
  at: string;
  routine: string;
  event: Pick<RoutineEvent, 'source' | 'id' | 'title' | 'link' | 'at'>;
  outcome: LogOutcome;
  /** Почему: какое условие не прошло, ответ проверки словами, текст ошибки. */
  reason?: string;
  runId?: string;
  costUsd?: number;
  /** Отправленный наружу ответ (ссылка), если был. */
  replied?: { at: string; link?: string; text: string };
  /** Когда начался запуск по этой строке (per_day и «сегодня» считаются по нему, каким бы ни стал исход). */
  startedAt?: string;
  /** Обратная связь человека на это событие (кнопки журнала «Это баг» / «Не повтор»). */
  feedback?: Feedback['verdict'];
};

/** Карточка ожидания на главной. */
export type RoutineWait = {
  id: string;
  routine: string;
  routineTitle: string;
  event: RoutineEvent;
  /** suggest — запуска ещё нет; pause — запуск стоит перед блоком; reply — запуск кончился, ответ-черновик ждёт «Отправить» (reply.draft на end). */
  kind: 'suggest' | 'pause' | 'reply';
  /** Вопрос карточки: «Чинить: …?». */
  question: string;
  runId?: string;
  /** Блок, перед которым стоит запуск. */
  block?: string;
  /** Черновик ответа наружу (reply.draft): уйдёт вместе с решением, если галочка стоит. */
  replyDraft?: { text: string; where: string };
  /**
   * Что агент уже сделал до остановки (kind 'pause'/'reply'): итог последнего блока / сводка запуска (markdown, до ~1500
   * символов) — тикет, критерии приёмки, найденная причина. Карточка на главной показывает его над кнопками.
   */
  context?: string;
  /** «Не сейчас»: ожидание отложено (сервер помнит). Главная и счётчик рельса его не показывают; в /routines — в полосе ожиданий с пометкой. */
  snoozedAt?: string;
  at: string;
};

/** Ответ на карточку: run — «Чинить»/«Запустить»/«Продолжить», later — «Не сейчас», reject — «Это не баг»/«Не то». */
export type WaitAction = { action: 'run' | 'later' | 'reject'; reply?: { send: boolean; text?: string } };

/** Строка «догнать» на главной: события за время простоя и пропущенное расписание. */
export type CatchUp = {
  id: string;
  routine: string;
  routineTitle: string;
  /** Сколько событий пришло и сколько из них подходят под условия (без проверки словами). */
  events: number;
  matching: number;
  /** Пропущенный запуск по расписанию. */
  missedAt?: string;
};

export type RoutineView = {
  slug: string;
  spec: RoutineSpec;
  /** Текст файла как есть — для «Открыть YAML». */
  yaml: string;
  /** Проблемы проверки: flow не найден, нет блока из pause_before, источник не подключён. */
  problems: string[];
  stats: { today: number; started: number; waiting: number; lastAt?: string; costUsd: number };
  /** Последние строки журнала для полоски в списке. */
  recent: LogEntry[];
  nextAt?: string;
};

export type RoutinesOverview = {
  routines: RoutineView[];
  sources: SourceView[];
  kinds: SourceKindView[];
  waits: RoutineWait[];
  catchUp: CatchUp[];
  /** Имена уже сохранённых ключей (без значений): формы не требуют ввести их заново. */
  secretNames?: string[];
};

/** Проверка правила на истории: что из последних событий источника запустилось бы. */
export type HistoryCheck = {
  events: Array<{
    event: RoutineEvent;
    outcome: Extract<LogOutcome, 'started' | 'waiting' | 'filtered' | 'check_no' | 'duplicate'>;
    reason?: string;
    /** Как человек раньше ответил на это событие (журнал + обратная связь); есть и расходится с outcome — строка «расходится». */
    past?: Feedback['verdict'];
    disagrees?: boolean;
  }>;
  /** Человек раньше ответил на событие иначе, чем правило решило бы сейчас («Это не баг», а правило запустило бы). */
  disagreements: number;
  /** Оценка по истории: сколько запусков в неделю и во сколько обойдётся (средняя стоимость прошлых запусков рутины или flow). */
  /** usdPerWeek нет — стоимость неизвестна: ни у рутины, ни у flow ещё не было запусков с расходом. */
  estimate?: { runsPerWeek: number; usdPerWeek?: number };
};

/**
 * Обратная связь на событие из журнала или проверки на истории: «Это баг» / «Не баг» / «Не повтор».
 * POST /api/routines/:slug/feedback { eventId, verdict } → { ok: true }. Хранится в routines-state/feedback/<routine>.json;
 * match/no_match — положительные/отрицательные примеры проверки словами, not_duplicate — исключение из дублей.
 * «Учесть» в проверке на истории шлёт verdict = past этого события.
 */
export type Feedback = { eventId: string; verdict: 'match' | 'no_match' | 'not_duplicate'; at?: string };

/** Событие home-SSE (/api/events): UI перечитывает /api/routines. */
export type RoutinesChange = { type: 'routines'; runId: ''; flow: '' };
