// Вещи — то, о чём дело: MR, задача Jira, задача Teamwork, ветка, сессия, запуск, разговор, своё.
// Спецификация: docs/desk/SPEC.md, раздел 3.1 («сигнал → вещь → наблюдатель»). Только типы — файл читает и веб.
// Контракт этапа 2 (docs/desk/plan-2.md): менять только дописывая поля.

export type ThingType = 'mr' | 'jira' | 'teamwork' | 'branch' | 'session' | 'run' | 'thread' | 'own';

/**
 * Вещь с каноническим ключом. По ключу определяется «то же самое», откуда бы ни пришёл сигнал.
 * Ключи (собирает только src/things/keys.ts):
 *   mr:<host>/<путь проекта>/<номер>      host в нижнем регистре, путь без ведущих/хвостовых «/» и «.git», в нижнем
 *                                          регистре (GitLab и GitHub его не различают; путь для API — в ref.project)
 *   jira:<host>/<KEY-123>                  ключ задачи в верхнем регистре
 *   tw:<команда>/<проект>/<id>
 *   branch:<корень репо>#<ветка>          корень — основной checkout (worktree сворачивается)
 *   session:<id>   run:<id первого запуска цепочки>   thread:<источник>/<канал>/<нить>   own:<id>
 */
export type Thing = {
  type: ThingType;
  key: string;
  /** Что нужно наблюдателю, чтобы найти вещь: host/project/number у MR, host/key у Jira, root/branch у ветки. */
  ref: Record<string, unknown>;
  url?: string;
  title?: string;
};

/** Нить разговора, из которой пришёл сигнал: тред Slack, ветка письма, чат Telegram. */
export type ThreadRef = { source: string; channel?: string; thread: string };

/** Чей сейчас ход по вещи. */
export type Turn = 'me' | 'others' | 'none';

/** Снимок состояния вещи, который отдаёт наблюдатель. */
export type ThingState = {
  /** false — вещь пропала или к ней нет доступа (тогда error). */
  exists: boolean;
  closed?: 'merged' | 'closed' | 'done';
  turn: Turn;
  /** Почему такой ход — одной строкой для карточки: «автор ответил на 2 замечания», «CI упал», «3 файла не закоммичены». */
  why: string;
  title: string;
  updatedAt: string;
  /** Ветка, автор, статус CI, исполнитель — для условий и карточки. */
  facts: Record<string, unknown>;
  /** «нет доступа к gitlab.company.com: выполните glab auth login». */
  error?: string;
};

/** Наблюдатель — один на тип вещи. Снимает состояние только тех вещей, о которых его спросили. */
export type Watcher = {
  type: ThingType;
  /** Как часто есть смысл спрашивать, мс. */
  everyMs: number;
  /** Может ли наблюдатель следить за этой вещью; строка — почему нет («нет доступа к хосту»). */
  canWatch: (thing: Thing) => true | string;
  /** Состояния по ключу вещи. Вещь, которую не удалось снять, — в карте с exists: false и error. */
  state: (things: Thing[], signal: AbortSignal) => Promise<Map<string, ThingState>>;
};
