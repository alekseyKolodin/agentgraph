// Контракт вида источника между движком рутин (src/routines/*, ядро) и видами (src/routines/sources/*).
// Движок не знает ни одного сервиса: он берёт список видов из sources/index.ts и зовёт poll/listen/reply.
import type { FieldMap, KindField, MatchField, RoutineEvent, SourceKindView, SourceSpec, SourceTestResult, DraftView } from './types.js';

export type FetchFn = typeof fetch;
/** Запуск команды без шелла-обёртки движка: argv или строка для `sh -c`, env с ключами источника. */
export type RunCommand = (cmd: string, opts: { env: Record<string, string>; cwd?: string; timeoutMs: number; signal?: AbortSignal }) => Promise<{ code: number; stdout: string; stderr: string }>;

export type SourceCtx = {
  slug: string;
  spec: SourceSpec;
  /** Значение ключа из ~/.agentgraph/secrets.json; нет — undefined. */
  secret: (name: string) => string | undefined;
  fetch: FetchFn;
  run: RunCommand;
  /** Состояние вида между проверками (курсор, offset Telegram, ts Slack): движок хранит его в routines-state/cursors. */
  cursor: { get: () => unknown; set: (v: unknown) => void };
  log: (msg: string) => void;
  signal: AbortSignal;
  /** Сколько стоила проверка ($): опрос моделью — движок суммирует в расход источника. У пробной проверки нет. */
  cost?: (usd: number) => void;
};

export type SourceKind = {
  kind: string;
  title: string;
  summary: string;
  delivery: SourceKindView['delivery'];
  /** Минимальный интервал опроса, мс. */
  minEveryMs: number;
  /** Свой минимум для конкретного источника (у «Сервиса через Claude» скрипт без модели можно проверять чаще). */
  minEveryFor?: (spec: SourceSpec) => number;
  setup: KindField[];
  match: MatchField[];
  /** Опрос: свежие записи (движок сам отсеет виденные id). Первый вызов после подключения задаёт «уже видено». */
  poll?: (ctx: SourceCtx) => Promise<RoutineEvent[]>;
  /** Постоянное соединение: emit на каждое новое событие; резолвится, когда signal прерван. Ошибка — движок переподключит с паузой. */
  listen?: (ctx: SourceCtx, emit: (events: RoutineEvent[]) => void) => Promise<void>;
  /** Ответ в источник: тред, чат, комментарий. target — event.replyTo или настройки источника (чат по умолчанию). */
  reply?: (ctx: SourceCtx, target: Record<string, unknown> | undefined, text: string) => Promise<{ link?: string }>;
  /** Умеет ли ответить источник с такими настройками (у «Сервиса через Claude» ответ настраивается в источнике). Нет — по наличию reply. */
  canReplyFor?: (spec: SourceSpec) => boolean;
  /** Защита от петли: сообщение своего бота / ответ в треде — не событие. */
  isSelf?: (ctx: SourceCtx, e: RoutineEvent) => boolean;
  /** Что будет выполняться — для «Что будет выполняться» и SourceTestResult.request (секреты замаскировать). */
  describe: (spec: SourceSpec) => string;
};

/** Рецепт — готовый источник файлом (без секретов): templates/sources/*.yaml и ~/.agentgraph/recipes/*.yaml. */
export type Recipe = { id: string; spec: SourceSpec; summary: string; file: string };

/**
 * Время события подставил agentgraph (у сервиса его нет): такое событие в первой пачке после старта — простой, а не новое.
 * Пометка живёт в памяти до обработки пачки движком; виды ставят её через stampAt.
 */
const stamped = new WeakSet<RoutineEvent>();
export function stampAt(e: RoutineEvent): RoutineEvent {
  stamped.add(e);
  return e;
}
export const isStampedAt = (e: RoutineEvent): boolean => stamped.has(e);

/** Поля, которые движок даёт видам «из коробки» для всех событий. */
export const BASE_MATCH: MatchField[] = [
  { key: 'title', label: 'Заголовок', type: 'text' },
  { key: 'text', label: 'Текст', type: 'text' },
  { key: 'author', label: 'Автор', type: 'text' },
];

/** Что ядро даёт подключению словами (sources/draft.ts): сохранение и проверка источника — функции ядра. */
export type DraftDeps = {
  saveSource: (slug: string, spec: SourceSpec, secrets?: Record<string, string>) => void;
  testSource: (spec: SourceSpec, secrets?: Record<string, string>) => Promise<SourceTestResult>;
  hasSecret: (name: string) => boolean;
  /** Положить ключ в ~/.agentgraph/secrets.json сразу, когда человек его ввёл («Ключ сохранён»). Нет — draft.ts держит его в памяти и отдаёт saveSource на последнем шаге. */
  saveSecret?: (name: string, value: string) => void;
  /** Слаг, свободный в ~/.agentgraph/sources. */
  freeSlug: (title: string) => string;
};

/** Маршруты подключения словами — их отдаёт sources/draft.ts, ядро только подключает к серверу. */
export type DraftRoutes = {
  start: (description: string) => DraftView;
  get: (id: string) => DraftView | undefined;
  secret: (id: string, name: string, value: string) => DraftView | undefined;
  /** Поправка словами («не те записи, нужны только мои встречи»). */
  refine: (id: string, note: string) => DraftView | undefined;
  cancel: (id: string) => void;
};

export type { FieldMap };
