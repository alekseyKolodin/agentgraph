// Правила движения дел (SPEC 3.2) — единственное место, где решается колонка. Чистые функции: (дело | нет, событие) →
// новое дело и строка журнала движений; без изменений — undefined. Хранилище (store.ts) только читает, применяет и пишет.
//
// Правила срабатывают на изменение, один раз на каждое: сигнал, который уже есть в деле, ничего не меняет; состояние
// вещи, отпечаток которого уже в seen, — тоже. Поэтому перенос руками держится до следующего изменения вещи: сверка
// снова и снова видит то же состояние и не трогает колонку.
//
// Инвариант: колонка «Готово» ⇔ у дела есть closed. Закрытое дело наблюдатели не обходят; новый сигнал о той же вещи
// открывает его снова («Готово» → «В плане»).
import type { ThingState } from '../things/types.js';
import type { DeskBy, DeskColumn, DeskItem, DeskLinks, DeskMove, DeskPatch, DeskSignal } from './types.js';

export type DeskEvent =
  | { type: 'put'; key: string; patch: DeskPatch; by: DeskBy }
  | { type: 'state'; state: ThingState }
  | { type: 'move'; column: DeskColumn; by: DeskBy; why?: string }
  | { type: 'close'; reason: string; by: DeskBy }
  | { type: 'run'; runIds: string[]; outcome: RunOutcome; summary?: string };

/** Чем кончился запуск: остановку руками или выключением сервера падением не называем. */
export type RunOutcome = 'ok' | 'failed' | 'stopped';

export type Step = { item: DeskItem; move?: DeskMove };

/** Время и id нового дела — снаружи: функция остаётся чистой. */
export type RuleCtx = { now: string; id: () => string };

export const COLUMNS: readonly DeskColumn[] = ['new', 'plan', 'work', 'waiting', 'done'];
export const isColumn = (v: unknown): v is DeskColumn => typeof v === 'string' && (COLUMNS as readonly string[]).includes(v);

/** Сигналов в деле: старые уходят, последние остаются. */
export const SIGNALS_MAX = 50;
const WHY_MAX = 300;

const KIND_OF: Record<string, string> = { mr: 'MR', jira: 'Jira', teamwork: 'Teamwork', branch: 'Ветка', session: 'Сессия', run: 'Запуск', thread: 'Разговор', own: 'Своё' };
const CLOSED_REASON: Record<NonNullable<ThingState['closed']>, string> = { merged: 'смержен', closed: 'закрыт', done: 'готово' };

const line = (s: string | undefined, max = WHY_MAX): string => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
};

/** Тип вещи по ключу (часть до «:»). */
const typeOfKey = (key: string): string => key.slice(0, Math.max(0, key.indexOf(':')));

/** Дело закрывается вместе с вещью: правило close не задано или 'thing'. */
export const closesWithThing = (i: Pick<DeskItem, 'close'>): boolean => i.close === undefined || i.close === 'thing';

/** Отпечаток состояния вещи: правило срабатывает, только когда он сменился. */
export function fingerprint(s: ThingState): string {
  return [s.closed ?? '', s.turn, s.updatedAt].join('|');
}

/** Текст сигнала и куда отвечать — с потолком: сообщения Slack приходят целиком, а items.json ограничен. */
export const SIGNAL_TEXT_MAX = 2000;
const REPLY_TO_MAX = 4096;
function clip(s: DeskSignal): DeskSignal {
  const out: DeskSignal = { ...s, source: line(s.source, 100) || 'unknown' };
  if (s.text !== undefined) out.text = s.text.length > SIGNAL_TEXT_MAX ? `${s.text.slice(0, SIGNAL_TEXT_MAX - 1)}…` : s.text;
  if (s.link !== undefined && (s.link.length > 1000 || !/^https?:\/\//i.test(s.link))) delete out.link;
  if (s.author !== undefined) out.author = line(s.author, 200);
  if (s.replyTo !== undefined && JSON.stringify(s.replyTo).length > REPLY_TO_MAX) delete out.replyTo;
  return out;
}

const sameSignal = (a: DeskSignal, b: DeskSignal): boolean => a.source === b.source && a.at === b.at && (a.link ?? '') === (b.link ?? '') && (a.text ?? '') === (b.text ?? '');

function mergeLinks(a: DeskLinks, b: Partial<DeskLinks> | undefined): DeskLinks {
  if (!b) return a;
  const uniq = (x: string[], y: string[] | undefined) => (y?.length ? [...new Set([...x, ...y.filter((v) => typeof v === 'string' && v)])] : x);
  return { runs: uniq(a.runs, b.runs), sessions: uniq(a.sessions, b.sessions), ...((b.branch ?? a.branch) ? { branch: b.branch ?? a.branch } : {}), ...((b.mr ?? a.mr) ? { mr: b.mr ?? a.mr } : {}) };
}

/** Дело в колонке to: время в колонке заново, «Готово» ⇔ closed. */
function moved(item: DeskItem, to: DeskColumn, by: DeskBy, now: string, why: string | undefined, reason?: string): Step {
  const next: DeskItem = { ...item, column: to, movedAt: now, movedBy: by, ...(why ? { why: line(why) } : {}) };
  if (to === 'done') next.closed = item.closed ?? { at: now, reason: line(reason ?? why ?? 'готово', 200) };
  else delete next.closed;
  return { item: next, move: { at: now, key: item.key, from: item.column, to, by, ...(why ? { why: line(why) } : {}) } };
}

const changed = (a: DeskItem, b: DeskItem): boolean => JSON.stringify(a) !== JSON.stringify(b);

/** Новое дело: колонка правила (по умолчанию «Новое»). */
function create(key: string, patch: DeskPatch, by: DeskBy, ctx: RuleCtx): Step {
  const column = patch.column ?? 'new';
  const signal = patch.signal && clip(patch.signal);
  const item: DeskItem = {
    id: ctx.id(),
    key,
    ...(patch.thing ? { thing: patch.thing } : {}),
    kind: line(patch.kind, 80) || KIND_OF[patch.thing?.type ?? typeOfKey(key)] || 'Своё',
    title: line(patch.title, 300) || line(signal?.text, 300) || key,
    ...(patch.project ? { project: patch.project } : {}),
    column,
    why: line(patch.why ?? signal?.text),
    signals: signal ? [signal] : [],
    ...(patch.due ? { due: patch.due } : {}),
    ...(patch.close ? { close: patch.close } : {}),
    links: mergeLinks({ runs: [], sessions: [] }, patch.links),
    createdAt: ctx.now,
    movedAt: ctx.now,
    movedBy: by,
  };
  if (column === 'done') item.closed = { at: ctx.now, reason: line(patch.why ?? 'заведено закрытым', 200) };
  return { item, move: { at: ctx.now, key, to: column, by, ...(item.why ? { why: item.why } : {}) } };
}

/**
 * Сигнал или правка полей. Дела нет — заводится. Есть — сигнал дописывается; новый сигнал (не тот же самый) из «Ждёт
 * других» и «Готово» переводит в «В плане», если onRepeat не 'keep'. Без сигнала колонка не меняется: put правит поля
 * (why, ссылки, срок), а двигает только move.
 */
function put(item: DeskItem | undefined, e: Extract<DeskEvent, { type: 'put' }>, ctx: RuleCtx): Step | undefined {
  if (!item) return create(e.key, e.patch, e.by, ctx);
  const p = e.patch;
  const incoming = p.signal && clip(p.signal);
  const fresh = incoming && !item.signals.some((s) => sameSignal(s, incoming)) ? incoming : undefined;
  if (p.signal && !fresh && !p.why && !p.links && !p.due && !p.thing && !p.project && !p.title && !p.close) return undefined;
  const next: DeskItem = {
    ...item,
    // первое имя и вид остаются: второй сигнал (сообщение в Slack) называет вещь хуже, чем первый (MR из GitLab)
    ...(item.title === item.key && p.title ? { title: line(p.title, 300) } : {}),
    ...(!item.project && p.project ? { project: p.project } : {}),
    ...(!item.thing && p.thing ? { thing: p.thing } : {}),
    ...(p.due ? { due: p.due } : {}),
    ...(p.close ? { close: p.close } : {}),
    ...(p.why ? { why: line(p.why) } : {}),
    signals: fresh ? [...item.signals, fresh].slice(-SIGNALS_MAX) : item.signals,
    links: mergeLinks(item.links, p.links),
  };
  if (fresh && (p.onRepeat ?? 'plan') === 'plan' && (item.column === 'waiting' || item.column === 'done')) {
    return moved(next, 'plan', e.by, ctx.now, p.why ?? (fresh.text ? `новое: ${fresh.text}` : `новое от ${fresh.author ?? fresh.source}`));
  }
  return changed(item, next) ? { item: next } : undefined;
}

/**
 * Состояние вещи от наблюдателя. Срабатывает один раз на изменение (seen). Вещь закрыта — «Готово» (если правило
 * close дела — 'thing'; иначе дело ждёт руки); ход мой — из «Ждёт
 * других» в «В плане»; ход чужой — из «В плане» и «В работе» в «Ждёт других». Нет доступа или вещь не снялась (exists:
 * false) — дело не трогается: seen остаётся прежним, и вернувшееся состояние сработает как изменение.
 */
function state(item: DeskItem, s: ThingState, ctx: RuleCtx): Step | undefined {
  if (!s.exists || item.closed) return undefined;
  const fp = fingerprint(s);
  if (item.seen === fp) {
    // вещь та же, а причина другая («3 файла не закоммичены» → «7»): карточка не врёт, колонка не трогается
    const why = line(s.why);
    return why && why !== item.why ? { item: { ...item, why } } : undefined;
  }
  const why = line(s.why) || item.why;
  const base: DeskItem = { ...item, seen: fp, turn: s.turn, why, ...(s.title && item.title === item.key ? { title: line(s.title, 300) } : {}) };
  // закрывает вещь только правило close: 'thing' (по умолчанию); 'never' и условие словами — руками
  if (s.closed && closesWithThing(item)) return moved(base, 'done', 'watcher', ctx.now, why, CLOSED_REASON[s.closed]);
  if (s.closed) return { item: base };
  if (s.turn === 'me' && item.column === 'waiting') return moved(base, 'plan', 'watcher', ctx.now, why);
  if (s.turn === 'others' && (item.column === 'plan' || item.column === 'work')) return moved(base, 'waiting', 'watcher', ctx.now, why);
  return { item: base };
}

/** Применить событие к делу. undefined — ничего не изменилось (и писать нечего). */
export function step(item: DeskItem | undefined, e: DeskEvent, ctx: RuleCtx): Step | undefined {
  if (e.type === 'put') return put(item, e, ctx);
  if (!item) return undefined;
  switch (e.type) {
    case 'state':
      return state(item, e.state, ctx);
    case 'move':
      // перенос руками или с карточки: seen не трогаем — следующее изменение вещи снова двинет дело
      return item.column === e.column ? undefined : moved(item, e.column, e.by, ctx.now, e.why, e.why ?? 'перенесено в «Готово»');
    case 'close':
      return item.closed ? undefined : moved(item, 'done', e.by, ctx.now, undefined, e.reason || 'закрыто');
    case 'run': {
      // запуск по делу закончился: колонка та же, why — итог
      if (!e.runIds.some((id) => item.links.runs.includes(id))) return undefined;
      const text = { ok: `агент закончил: ${e.summary || 'готово'}`, failed: `запуск упал: ${e.summary || 'ошибка'}`, stopped: `запуск остановлен${e.summary ? `: ${e.summary}` : ''}` }[e.outcome];
      const why = line(text);
      return why === item.why ? undefined : { item: { ...item, why } };
    }
  }
}
