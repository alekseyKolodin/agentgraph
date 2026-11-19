// Подробности дела (панель справа от доски): откуда взялось, о какой вещи, какие связи и вся история — сигналы и
// переносы из журнала. Чистая логика без React: панель только рисует то, что собрано здесь.
import type { DeskBy, DeskColumn, DeskItem, DeskMove, DeskSignal } from '@server/desk/types';
import { columnTitle, dueView, itemUrl, thingLabel } from './desk-board';
import { locale, t } from './i18n';

/** Куда ведёт строка: to — экран приложения, href — внешняя ссылка (только http(s)). */
export type DetailLink = { text: string; to?: string; href?: string };

/** Как назвать рутину, запуск и сессию по ключу: панель подставляет названия из своих списков. */
export type DetailCtx = {
  routineTitle?: (slug: string) => string | undefined;
  runTitle?: (id: string) => string | undefined;
  sessionName?: (id: string) => string | undefined;
  /** Название пространства по слагу. */
  projectTitle?: (slug: string) => string | undefined;
};

const web = (u: string | undefined): string | undefined => (u && /^https?:\/\//i.test(u) ? u : undefined);

/** Время события для панели: «сегодня, 14:05», «вчера, 09:12», «12 нояб., 18:40» (с годом, если не этого). Не дата — ''. */
export function whenText(at: string | undefined, now: number): string {
  const ms = Date.parse(at ?? '');
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const clock = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (diff === 0) return t('сегодня, {time}', { time: clock });
  if (diff === 1) return t('вчера, {time}', { time: clock });
  const date = d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) });
  return `${date}, ${clock}`;
}

// ---------------------------------------------------------------- кто и откуда

const BY: Record<DeskBy, string> = { me: 'ты', watcher: 'наблюдатель', routine: 'рутина', flow: 'запуск flow', session: 'сессия' };
/** Кто сделал: «ты», «наблюдатель», «рутина», «запуск flow», «сессия». */
export const byText = (by: DeskBy): string => t(BY[by] ?? by);

const CREATED: Record<DeskBy, string> = {
  me: 'Завёл ты',
  watcher: 'Завёл наблюдатель вещи',
  routine: 'Завела рутина',
  flow: 'Завёл запуск flow',
  session: 'Завела сессия Claude',
};

const SOURCE: Record<string, string> = {
  session: 'сессия Claude',
  flow: 'запуск flow',
  cli: 'командная строка',
  watcher: 'наблюдатель вещи',
  ui: 'руками на доске',
};
/** Источник сигнала: служебные слова — по-человечески, слаг источника рутины — как есть. */
export const sourceText = (source: string): string => (SOURCE[source] ? t(SOURCE[source]!) : source);

/** Сигнал дела строкой: «Slack · Иван Петров». */
export function signalWho(s: Pick<DeskSignal, 'source' | 'author'>): string {
  return [sourceText(s.source), s.author].filter(Boolean).join(' · ');
}

export type Origin = {
  /** «Завела рутина», «Завёл запуск flow», «Завёл ты». */
  headline: string;
  /** Куда пойти за первоисточником: рутина, запуск, сессия — в порядке «кто завёл». */
  links: DetailLink[];
  /** Исходный сигнал — самый первый; нет — у дела без сигналов (например, заведено руками с названием). */
  signal?: DeskSignal;
  /** Когда завели. */
  at: string;
};

/** Откуда взялось дело: кто завёл (createdBy → рутина, запуск, сессия) и с какого сигнала всё началось. */
export function originOf(item: DeskItem, moves: readonly DeskMove[], ctx: DetailCtx = {}): Origin {
  const by = item.createdBy;
  const links: DetailLink[] = [];
  if (by?.routine) links.push({ text: t('Рутина «{title}»', { title: ctx.routineTitle?.(by.routine) ?? by.routine }), to: `/routines/${encodeURIComponent(by.routine)}` });
  if (by?.run) links.push({ text: t('Запуск «{title}»', { title: ctx.runTitle?.(by.run) ?? by.run }), to: `/run/${encodeURIComponent(by.run)}` });
  if (by?.session) links.push({ text: t('Сессия «{title}»', { title: ctx.sessionName?.(by.session) ?? by.session }), to: `/sessions/${encodeURIComponent(by.session)}` });
  // рутина, запуск и сессия в createdBy не всегда — дело, заведённое сигналом рутины, знает её только по сигналу
  const first = item.signals[0];
  if (!by && first?.routine) links.push({ text: t('Рутина «{title}»', { title: ctx.routineTitle?.(first.routine) ?? first.routine }), to: `/routines/${encodeURIComponent(first.routine)}` });
  // кто завёл без createdBy: первая запись журнала (у дела, заведённого руками, это 'me'), иначе последний подвинувший
  // у дела, которое ни разу не двигали
  const created = moves.find((m) => m.from === undefined);
  const who: DeskBy = by ? (by.routine ? 'routine' : by.run ? 'flow' : 'session') : (created?.by ?? (first?.routine ? 'routine' : item.movedAt === item.createdAt ? item.movedBy : first?.source === 'ui' ? 'me' : 'watcher'));
  return { headline: t(CREATED[who] ?? CREATED.watcher!), links, ...(first ? { signal: first } : {}), at: item.createdAt };
}

// ---------------------------------------------------------------- вещь и поля

export type DetailRow = { label: string; text: string; /** Подсказка (title). */ title?: string; link?: DetailLink };

const THING_TYPE: Record<string, string> = {
  mr: 'MR или PR',
  jira: 'Задача Jira',
  teamwork: 'Задача Teamwork',
  branch: 'Ветка',
  session: 'Сессия',
  run: 'Запуск',
  thread: 'Разговор',
  own: 'Своё дело',
};
const TURN: Record<string, string> = { me: 'ход за тобой', others: 'ход за другими', none: 'ничьего хода нет' };

/** Как сверка закрывает дело: close из рутины. */
function closeRule(close: string): string {
  if (close === 'thing') return t('когда вещь закрыта');
  if (close === 'never') return t('только руками');
  return t('по условию: {rule}', { rule: close });
}

/** Что известно о вещи дела: тип, имя, адрес, состояние от наблюдателя. Нет вещи (своё дело) — только тип. */
export function thingRows(item: DeskItem): DetailRow[] {
  const rows: DetailRow[] = [];
  const type = item.thing?.type ?? (item.key.startsWith('own:') ? 'own' : item.key.split(':')[0] ?? '');
  const label = thingLabel(item);
  const url = itemUrl(item);
  rows.push({ label: t('Вещь'), text: [t(THING_TYPE[type] ?? type), label].filter(Boolean).join(' · ') });
  if (url) rows.push({ label: t('Ссылка'), text: url.replace(/^https?:\/\//i, ''), title: url, link: { text: url, href: url } });
  // наблюдатель: чей ход по вещи и закрыта ли она; у своего дела вещи нет — наблюдать нечего
  if (item.turn) rows.push({ label: t('Ход по вещи'), text: t(TURN[item.turn] ?? item.turn), title: t('Так увидел вещь наблюдатель при последней сверке') });
  if (item.close) rows.push({ label: t('Закрывается'), text: closeRule(item.close) });
  return rows;
}

/** Поля дела: вид, колонка, проект, срок, возраст, когда завели, ключ. */
export function fieldRows(item: DeskItem, now: number, ctx: DetailCtx = {}): DetailRow[] {
  const rows: DetailRow[] = [];
  rows.push({ label: t('Вид'), text: item.kind });
  rows.push({ label: t('Колонка'), text: columnTitle(item.column), ...(item.column === 'done' && item.closed ? { title: item.closed.reason } : {}) });
  if (item.closed) rows.push({ label: t('Закрыто'), text: `${whenText(item.closed.at, now)} · ${item.closed.reason}` });
  if (item.project) rows.push({ label: t('Проект'), text: ctx.projectTitle?.(item.project) ?? item.project });
  const due = item.column === 'done' ? undefined : dueView(item.due, now);
  if (due) rows.push({ label: t('Срок'), text: `${due.date} · ${due.text}`, title: due.title });
  else if (item.due) rows.push({ label: t('Срок'), text: item.due });
  rows.push({ label: t('В колонке с'), text: `${whenText(item.movedAt, now)} · ${t(BY_MOVED[item.movedBy] ?? item.movedBy)}` });
  rows.push({ label: t('Заведено'), text: whenText(item.createdAt, now) });
  rows.push({ label: t('Ключ'), text: item.key, title: t('Ключ вещи: по нему сигналы находят это дело') });
  return rows;
}
const BY_MOVED: Record<DeskBy, string> = { me: 'подвинул ты', watcher: 'подвинул наблюдатель', routine: 'подвинула рутина', flow: 'подвинул запуск', session: 'подвинула сессия' };

export type RelatedLink = DetailLink & { kind: 'run' | 'session' | 'mention' | 'branch' | 'mr' };

/** Связи дела: запуски и сессии по нему, кто его упоминал (desk_put), ветка и MR. */
export function relatedOf(item: DeskItem, ctx: DetailCtx = {}): RelatedLink[] {
  const out: RelatedLink[] = [];
  for (const id of item.links.runs) out.push({ kind: 'run', text: ctx.runTitle?.(id) ?? id, to: `/run/${encodeURIComponent(id)}` });
  for (const id of item.links.sessions) out.push({ kind: 'session', text: ctx.sessionName?.(id) ?? id, to: `/sessions/${encodeURIComponent(id)}` });
  for (const id of item.links.mentionedBy ?? []) if (!item.links.runs.includes(id)) out.push({ kind: 'mention', text: ctx.runTitle?.(id) ?? id, to: `/run/${encodeURIComponent(id)}` });
  if (item.links.branch) out.push({ kind: 'branch', text: item.links.branch });
  const mr = web(item.links.mr);
  if (mr) out.push({ kind: 'mr', text: mr.replace(/^https?:\/\//i, ''), href: mr });
  return out;
}

// ---------------------------------------------------------------- история

export type TimelineEvent = {
  /** Порядок и ключ списка: время и номер. */
  id: string;
  at: string;
  kind: 'signal' | 'move' | 'created' | 'closed';
  /** Что случилось: «Сигнал · Slack», «Новое → В плане». */
  title: string;
  /** Кто: «ты», «рутина», … — у сигнала автор. */
  who?: string;
  /** Текст сигнала или «почему» переноса. */
  text?: string;
  link?: DetailLink;
};

/** Одна строка журнала словами: «Новое → В плане», «Заведено в «Новое»», «Слито со своим делом». */
export function moveTitle(m: Pick<DeskMove, 'from' | 'to'>): string {
  if (!m.from) return t('Заведено в «{column}»', { column: columnTitle(m.to) });
  if (m.from === m.to) return t('Дополнено в «{column}»', { column: columnTitle(m.to) });
  return `${columnTitle(m.from as DeskColumn)} → ${columnTitle(m.to)}`;
}

/**
 * История дела — сигналы (item.signals) и переносы по колонкам (журнал), новое сверху. Журнал обрезается, а сигналы
 * дела — тоже (последние): чего нет, того не покажем. Нет строки заведения в журнале — «Дело заведено» по createdAt;
 * закрытое дело без строки закрытия в журнале — «Закрыто» по closed.
 */
export function timeline(item: DeskItem, moves: readonly DeskMove[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  item.signals.forEach((s, n) => {
    const link = web(s.link);
    out.push({
      id: `s${n}`,
      at: s.at,
      kind: 'signal',
      title: t('Сигнал · {source}', { source: sourceText(s.source) }),
      ...(s.author ? { who: s.author } : {}),
      ...(s.text ? { text: s.text } : {}),
      ...(link ? { link: { text: link.replace(/^https?:\/\//i, ''), href: link } } : {}),
    });
  });
  moves.forEach((m, n) => out.push({ id: `m${n}`, at: m.at, kind: 'move', title: moveTitle(m), who: byText(m.by), ...(m.why ? { text: m.why } : {}) }));
  if (!moves.some((m) => m.from === undefined)) out.push({ id: 'c', at: item.createdAt, kind: 'created', title: t('Дело заведено') });
  if (item.closed && !moves.some((m) => m.to === 'done')) {
    out.push({ id: 'x', at: item.closed.at, kind: 'closed', title: t('Закрыто'), text: item.closed.reason });
  }
  // новое сверху; у одного момента — как записано (сигнал после переноса, который он вызвал, остаётся ниже)
  return out.map((e, i) => ({ e, i })).sort((a, b) => b.e.at.localeCompare(a.e.at) || b.i - a.i).map((x) => x.e);
}
