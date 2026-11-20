// Условия рутины на поля события без модели (MatchCondition в types.ts): список { field, op, value }, сочетание —
// match_mode (all — все, any — хоть одно). Старый формат — словарь, где суффикс ключа — оператор (без суффикса — равно,
// `~` — содержит, `!` — не равно, `>` `<` — числа); он приводится к списку (matchConditions). Строки — без учёта
// регистра; список значений у eq и contains — любое из, у ne — ни одно из. Поле-массив совпадает, если совпал хоть один элемент.
import type { EventField, MatchCondition, MatchMode, MatchOp, MatchRule, MatchValue, RoutineEvent } from './types.js';

const TOP = new Set(['source', 'id', 'at', 'title', 'text', 'link', 'author']);

/** Значение по пути: title, author… — поля события; остальное — путь через точку в fields (labels.0, user.name). */
export function fieldValue(e: RoutineEvent, key: string): unknown {
  if (TOP.has(key)) return (e as Record<string, unknown>)[key];
  if (key.startsWith('fields.')) key = key.slice(7);
  return pathGet(e.fields, key);
}

export function pathGet(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = /^\d+$/.test(part) ? cur[Number(part)] : undefined;
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

const BY_SUFFIX: Record<string, MatchOp> = { '~': 'contains', '!': 'ne', '>': 'gt', '<': 'lt' };

/** Ключ старого словаря → поле и оператор: «title~» — title, contains. */
function parseKey(raw: string): { field: string; op: MatchOp } {
  const k = raw.trim();
  const op = BY_SUFFIX[k.slice(-1)];
  return op ? { field: k.slice(0, -1).trim(), op } : { field: k, op: 'eq' };
}

/** Значение не дописано: '' или пустой список (из одних пустых строк). */
export const emptyValue = (v: MatchValue | undefined): boolean =>
  v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.some((x) => typeof x === 'number' || String(x).trim()));

/**
 * when.match любого формата → список условий по порядку. Условие без поля или с пустым значением не применяется: в
 * правиле его нет (недописанную строку редактор подсвечивает сам, см. web/src/lib/routines/match.ts → incompleteConds).
 * Это касается и старого словаря: ключ с пустым значением (`title: ''` — «поле пустое», `title!: ''` — «поле не пустое»)
 * раньше сравнивался с пустой строкой, теперь пропускается. Проверка «поле пустое / заполнено» условиями на поля не
 * выражается — только проверкой словами (when.check).
 */
export function matchConditions(rule: MatchRule | undefined): Array<MatchCondition & { op: MatchOp }> {
  if (!rule) return [];
  const list: MatchCondition[] = Array.isArray(rule) ? rule : Object.entries(rule).map(([k, value]) => ({ ...parseKey(k), value }));
  return list.filter((c) => c.field?.trim() && !emptyValue(c.value)).map((c) => ({ field: c.field.trim(), op: c.op ?? 'eq', value: c.value }));
}

const norm = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim().toLowerCase();
const show = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

function eq(a: unknown, b: string | number | boolean): boolean {
  if (typeof b === 'number') return a !== '' && a !== null && a !== undefined && Number(a) === b;
  return norm(a) === norm(b);
}

const OP_SHOW: Record<MatchOp, string> = { eq: '=', contains: 'содержит', ne: '≠', gt: '>', lt: '<' };
const OP_FAIL: Record<MatchOp, string> = { eq: 'не равно', contains: 'не содержит', ne: 'равно', gt: 'не больше', lt: 'не меньше' };

const wantsOf = (v: MatchValue): Array<string | number | boolean> => (Array.isArray(v) ? v.filter((x) => typeof x === 'number' || String(x).trim()) : [v]);

/** Одно условие; reason — человекочитаемо, почему не прошло. Старый вызов (ключ словаря и значение) тоже принимается. */
export function matchOne(e: RoutineEvent, c: MatchCondition | string, want?: MatchValue): { ok: boolean; reason?: string } {
  const { field, op } = typeof c === 'string' ? parseKey(c) : { field: c.field.trim(), op: c.op ?? 'eq' };
  const wants = wantsOf(typeof c === 'string' ? want ?? '' : c.value);
  const got = fieldValue(e, field);
  const vals = Array.isArray(got) ? got : got === undefined ? [] : [got];
  let ok: boolean;
  switch (op) {
    case 'eq':
      ok = vals.some((v) => wants.some((w) => eq(v, w)));
      break;
    case 'contains':
      ok = vals.some((v) => wants.some((w) => norm(v).includes(norm(w))));
      break;
    case 'ne':
      ok = !vals.some((v) => wants.some((w) => eq(v, w)));
      break;
    case 'gt':
    case 'lt': {
      const limit = Number(wants[0]);
      ok = vals.some((v) => {
        const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        return Number.isFinite(n) && (op === 'gt' ? n > limit : n < limit);
      });
      break;
    }
  }
  if (ok) return { ok };
  const shown = got === undefined ? 'нет поля' : `«${show(got)}»`;
  const list = op === 'gt' || op === 'lt' ? wants.slice(0, 1) : wants;
  return { ok, reason: `${field}: ${shown} ${OP_FAIL[op]} ${list.map((w) => `«${show(w)}»`).join(' / ')}` };
}

/** Каждое условие правила по отдельности: поле, что хотели, что было в событии, прошло ли — «почему сработало» в журнале. */
export function explainMatch(rule: MatchRule | undefined, e: RoutineEvent): Array<{ key: string; op: string; want: string; got: string; ok: boolean }> {
  return matchConditions(rule).map((c) => {
    const got = fieldValue(e, c.field);
    return {
      key: c.field,
      op: OP_SHOW[c.op],
      want: (c.op === 'gt' || c.op === 'lt' ? wantsOf(c.value).slice(0, 1) : wantsOf(c.value)).map((w) => show(w)).join(' / '),
      got: got === undefined ? '' : show(got),
      ok: matchOne(e, c).ok,
    };
  });
}

/** Прошло ли событие каждое условие правила — по порядку matchConditions (воронка проверки на истории). */
export function matchSteps(rule: MatchRule | undefined, e: RoutineEvent): boolean[] {
  return matchConditions(rule).map((c) => matchOne(e, c).ok);
}

/**
 * Условия правила: all (по умолчанию) — все, первое не прошедшее — в reason; any — хоть одно, в reason — все не
 * прошедшие. Пустое правило — проходит.
 */
export function matchRule(rule: MatchRule | undefined, e: RoutineEvent, mode: MatchMode = 'all'): { ok: boolean; reason?: string } {
  const conds = matchConditions(rule);
  if (!conds.length) return { ok: true };
  if (mode === 'any') {
    const fails: string[] = [];
    for (const c of conds) {
      const r = matchOne(e, c);
      if (r.ok) return { ok: true };
      if (r.reason) fails.push(r.reason);
    }
    return { ok: false, reason: `ни одно условие не прошло: ${fails.join('; ')}` };
  }
  for (const c of conds) {
    const r = matchOne(e, c);
    if (!r.ok) return r;
  }
  return { ok: true };
}

const FIELDS_MAX = 60;
const FIELD_DEPTH = 4;
const VALUE_MAX = 200;

/**
 * Поля события списком для примера в редакторе: пути через точку в fields — те же ключи, что принимает matchRule.
 * Объекты разворачиваются (до FIELD_DEPTH уровней), список остаётся одним полем: условие сравнивает каждый его
 * элемент. Пустые значения (null, '', [], {}) не показываются — условие на них написать не о чем.
 */
export function eventFields(e: Pick<RoutineEvent, 'fields'>): EventField[] {
  const out: EventField[] = [];
  const clip = (s: string) => (s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX - 1)}…` : s);
  const walk = (v: unknown, key: string, depth: number): void => {
    if (out.length >= FIELDS_MAX || v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      const scalar = v.every((x) => x === null || typeof x !== 'object');
      out.push({ key, type: 'text', value: clip(scalar ? v.map((x) => String(x)).join(', ') : JSON.stringify(v)), list: true });
    } else if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (!entries.length) return;
      // глубже не разворачиваем: «содержит» по такому полю ищет в его JSON
      if (depth >= FIELD_DEPTH) out.push({ key, type: 'text', value: clip(JSON.stringify(v)) });
      // ключ с точкой путём не достать (pathGet делит по точкам): такое поле не показываем
      else for (const [k, x] of entries) if (k && !k.includes('.')) walk(x, key ? `${key}.${k}` : k, depth + 1);
    } else if (typeof v === 'number') out.push({ key, type: 'number', value: String(v) });
    else if (typeof v === 'boolean') out.push({ key, type: 'bool', value: String(v) });
    else out.push({ key, type: 'text', value: clip(String(v)) });
  };
  walk(e.fields ?? {}, '', 0);
  // имя верхнего поля события (title, text…) в условии значит его, а не fields.title: такому ключу нужен префикс
  return out.map((f) => (TOP.has(f.key) ? { ...f, key: `fields.${f.key}` } : f));
}
