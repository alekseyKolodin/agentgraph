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
  /** Вещи, о которых это событие (разбор ссылок, src/things/resolve.ts): MR, задача Jira… Нет — событие ни о чём известном. */
  things?: import('../things/types.js').Thing[];
  /** Нить разговора (тред Slack, ветка письма): по ней «продолжение того же разговора». */
  thread?: import('../things/types.js').ThreadRef;
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
  /** Нить разговора (ts треда Slack, id ветки письма) и канал — для чатов через коннектор. */
  thread?: string;
  channel?: string;
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
/** pick: 'mcp-tool' — не поле ввода, а выбор сервиса и его инструмента из MCP аккаунта (GET /api/routines/mcp-tools). */
export type KindField = { key: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean; hint?: string; pick?: 'mcp-tool' };

/** Инструмент, который источник «Подключение» может вызывать: только чтение. name — полное имя mcp__сервер__инструмент. */
export type McpToolView = { name: string; tool: string; description?: string };
/**
 * Сервис MCP для источника «Подключение»: title — имя без «claude.ai», origin — коннектор аккаунта claude.ai или сервер,
 * добавленный в Claude Code (claude mcp add). tools — подходящие инструменты, самые похожие на список — первыми; hidden —
 * сколько инструментов спрятано, потому что они меняют данные.
 */
export type McpServiceView = {
  server: string;
  title: string;
  origin: 'claudeai' | 'claude-code';
  status: string;
  tools: McpToolView[];
  hidden: number;
  /** Инструменты, которые меняют данные: из них (и только из них) выбирается один для ответа в источник. Читать ими нельзя. */
  writeTools: McpToolView[];
};
export type McpServicesView = { services: McpServiceView[]; at: string };

/** Разбор текстового ответа инструмента: split — регулярка-разделитель записей, поля — регулярки с одной группой. */
export type TextRule = { split: string; id?: string; title?: string; text?: string; link?: string; at?: string; author?: string; /** Нить и канал — для чатов, как в FieldMap. */ thread?: string; channel?: string };
/**
 * Шаг скрипта «Сервис через Claude»: вызов читающего инструмента с готовыми аргументами. В строках аргументов
 * {{since}} (ISO), {{since_unix}} (секунды), {{since_date}} (ГГГГ-ММ-ДД) — время прошлой проверки (в первый раз — сутки назад).
 * Записи из ответа: json — по полям, как у своей команды; text — регулярками.
 */
export type ConnectorStep = { tool: string; args: Record<string, unknown>; say: string; json?: FieldMap; text?: TextRule };
/**
 * Ответ в источник «Сервис через Claude» (config.reply): один пишущий инструмент, выбранный человеком, и шаблон его
 * аргументов. В строках {{channel}}, {{thread}} и {{text}} подставляются канал и тред события (event.replyTo) и текст ответа;
 * строка без подстановок уходит как есть (например, фиксированный канал). Читать этим инструментом источник не может.
 */
export type ConnectorReply = { tool: string; args: Record<string, unknown> };
/** Скрипт, который модель собрала один раз: дальше проверка ходит по нему без модели. */
export type ConnectorScript = { steps: ConnectorStep[] };

/** Сборка скрипта: модель смотрит сервисы, agentgraph прогоняет скрипт без модели и показывает, что нашлось. */
export type ConnectorBuildView =
  | { id: string; state: 'working'; step: string }
  | {
      id: string;
      state: 'ready';
      spec: SourceSpec;
      /** Прогон скрипта без модели; у mode: 'model' его нет. */
      test?: SourceTestResult;
      /** script — проверка без модели; model — разобрать ответ без модели не вышло, каждая проверка через модель. */
      mode: 'script' | 'model';
      problem?: string;
    }
  | { id: string; state: 'error'; error: string };

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
  /** Вид умеет ответить в источник (тред, чат, комментарий). Умеет ли конкретный источник — `SourceView.canReply`: у «Сервиса через Claude» ответ настраивается в источнике. */
  canReply: boolean;
  /** Рецепт из файла (~/.agentgraph/recipes или templates/sources), а не встроенный вид. */
  recipe?: boolean;
};

/**
 * ok — последняя проверка прошла; error — не прошла (статус переживает перезапуск); idle — источник не нужен ни одной
 * включённой рутине; needs_secret — не хватает ключа; unchecked — ни одной проверки ещё не было; empty — проверки идут,
 * но новых записей нет дольше обычного для этого источника (протухший токен, фильтр по дате, limit).
 */
export type SourceStatus = 'ok' | 'error' | 'idle' | 'needs_secret' | 'unchecked' | 'empty';

/**
 * Итог одной проверки источника (опрос или пачка live-соединения), хранится в routines-state/checks/<slug>.json.
 * at — когда проверка была (не время «рутина отработала» и не граница простоя из last-check.json); total — сколько записей
 * вернул сервис; fresh — сколько из них новых (ещё не виденных); emptySince — с какого времени новых записей нет.
 */
export type CheckResult = { at: string; ok: boolean; total: number; fresh: number; error?: string; emptySince?: string };

export type SourceView = {
  slug: string;
  spec: SourceSpec;
  status: SourceStatus;
  error?: string;
  /** Время последней проверки (check.at; для старых данных — last-check.json). */
  lastCheckAt?: string;
  /** Итог последней проверки; нет — источник ещё ни разу не проверялся. */
  check?: CheckResult;
  /** Расход опроса моделью (вид connector без скрипта): сегодня и за 7 дней, $. Нет — опрос ничего не тратит. */
  pollCostUsd?: { today: number; week: number };
  /** Каких ключей не хватает. */
  missingSecrets: string[];
  /** Какие рутины его используют (слаги). */
  usedBy: string[];
  /** Умеет ли ЭТОТ источник ответить: у «Сервиса через Claude» — только если настроен инструмент ответа. */
  canReply: boolean;
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
  /** Рутина заводит дела (SPEC этап 3, блок task). С task поле run становится необязательным — правку делает этап 3.3. */
  task?: TaskRule;
};

/**
 * Блок task правила рутины. from: event — событие и есть дело; flow — дела заводит flow инструментом desk_put.
 * same: что считать тем же (по умолчанию thing, если вещь распознана, иначе thread, иначе event).
 * close: thing — когда вещь закрыта; never — только руками; иная строка — условие словами.
 */
export type TaskRule = {
  kind: string;
  column?: 'new' | 'plan';
  from?: 'event' | 'flow';
  same?: 'thing' | 'thread' | 'event';
  on_repeat?: 'plan' | 'keep';
  close?: 'thing' | 'never' | string;
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
  /** Почему событие подошло — ответ проверки словами; остаётся у строки ожидания, очереди и запуска. */
  why?: string;
  runId?: string;
  /** Всё, что потрачено на строку: проверка словами + запуск. */
  costUsd?: number;
  /** Из costUsd — проверка словами (у запущенных событий её не затирает стоимость запуска). */
  checkCostUsd?: number;
  /** Отправленный наружу ответ (ссылка), если был. */
  replied?: { at: string; link?: string; text: string };
  /** Когда начался запуск по этой строке (per_day и «сегодня» считаются по нему, каким бы ни стал исход). */
  startedAt?: string;
  /** Обратная связь человека на это событие (кнопки журнала «Это баг» / «Не повтор»). */
  feedback?: Feedback['verdict'];
  /** Ключи вещей события (src/things/keys.ts); первый — главная вещь, по ней «то же срабатывание». */
  things?: string[];
  /** Версия главной вещи в этом событии: id события, которое само о ней (новый комментарий, ревью снова). Нет — только упоминание. */
  thingVersion?: string;
  /** Повтор по вещи: строка срабатывания, которое уже было по той же вещи (эта или другая рутина с тем же flow и задачей). */
  sameAs?: { routine: string; logId: string };
  /** Чем кончился запуск строки (статус запуска): упавший запуск повтор по вещи не держит. */
  runStatus?: string;
};

/**
 * GET /api/routines/:slug/log/:id/explain — почему сработало: событие целиком, условия на поля по текущему правилу,
 * проверка словами и её ответ. POST …/recheck { check? } — та же проверка словами на этом событии заново (по тексту
 * из body или правила): исправленное «Если» видно сразу, до сохранения.
 */
export type LogExplain = {
  entry: LogEntry;
  /** Событие целиком (журнал событий рутины, ожидания, история источника); нет — только строка журнала. */
  event?: RoutineEvent;
  schedule: boolean;
  /** Условия на поля по текущему правилу: got — что было в событии ('' — поля нет). */
  conditions: Array<{ key: string; op: string; want: string; got: string; ok: boolean }>;
  /** «Если» текущего правила; нет — запускается всё, что прошло условия. */
  check?: string;
  /** Ответ проверки словами при срабатывании (why или reason строки). */
  answer?: string;
};

/** Стартовый запрос сессии «Спросить Claude» по строке журнала. */
export type LogAsk = { prompt: string; cwd?: string; name: string };

export type LogRecheck = { match: boolean; duplicate: boolean; reason: string; costUsd: number };

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
  /** Ожидание рутины с task — это дело: ключ дела (карточка «Новое» с кнопкой «Запустить»). */
  deskKey?: string;
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
  /** Рутины в фоне ведёт другой процесс agentgraph на той же папке настроек (ui — agentgraph ui, desktop — приложение). */
  engineOwner?: { pid: number; who: string };
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
  /** Что получит flow на одном настоящем событии (первом, которое запустило бы рутину, иначе самом свежем). task нет — задача возьмётся из input flow. */
  preview?: { eventId: string; task?: string; event: string };
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
