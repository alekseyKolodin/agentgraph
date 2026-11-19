// Условия рутины на поля события без модели (MatchRule в types.ts): ключ — поле события или путь в fields, суффикс —
// оператор: без суффикса — равно (строки без учёта регистра, массив значений — любое из), `~` — содержит, `!` — не равно,
// `>` `<` — числа. Поле-массив совпадает, если совпал хоть один элемент.
import type { EventField, MatchRule, RoutineEvent } from './types.js';

type Op = '=' | '~' | '!' | '>' | '<';

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

function parseKey(raw: string): { key: string; op: Op } {
  const last = raw.trim().slice(-1);
  if (last === '~' || last === '!' || last === '>' || last === '<') return { key: raw.trim().slice(0, -1).trim(), op: last };
  return { key: raw.trim(), op: '=' };
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

/** Одно условие; reason — человекочитаемо, почему не прошло. */
export function matchOne(e: RoutineEvent, rawKey: string, want: MatchRule[string]): { ok: boolean; reason?: string } {
  const { key, op } = parseKey(rawKey);
  const got = fieldValue(e, key);
  const vals = Array.isArray(got) ? got : got === undefined ? [] : [got];
  const wants = Array.isArray(want) ? want : [want];
  let ok: boolean;
  switch (op) {
    case '=':
      ok = vals.some((v) => wants.some((w) => eq(v, w)));
      break;
    case '~':
      ok = vals.some((v) => wants.some((w) => norm(v).includes(norm(w))));
      break;
    case '!':
      ok = !vals.some((v) => wants.some((w) => eq(v, w)));
      break;
    case '>':
    case '<': {
      const limit = Number(wants[0]);
      ok = vals.some((v) => {
        const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        return Number.isFinite(n) && (op === '>' ? n > limit : n < limit);
      });
      break;
    }
  }
  if (ok) return { ok };
  const shown = got === undefined ? 'нет поля' : `«${show(got)}»`;
  const what = { '=': 'не равно', '~': 'не содержит', '!': 'равно', '>': 'не больше', '<': 'не меньше' }[op];
  return { ok, reason: `${key}: ${shown} ${what} ${wants.map((w) => `«${show(w)}»`).join(' / ')}` };
}

/** Каждое условие правила по отдельности: поле, что хотели, что было в событии, прошло ли — «почему сработало» в журнале. */
export function explainMatch(rule: MatchRule | undefined, e: RoutineEvent): Array<{ key: string; op: string; want: string; got: string; ok: boolean }> {
  return Object.entries(rule ?? {}).map(([raw, want]) => {
    const { key, op } = parseKey(raw);
    const got = fieldValue(e, key);
    return {
      key,
      op: { '=': '=', '~': 'содержит', '!': '≠', '>': '>', '<': '<' }[op],
      want: (Array.isArray(want) ? want : [want]).map((w) => show(w)).join(' / '),
      got: got === undefined ? '' : show(got),
      ok: matchOne(e, raw, want).ok,
    };
  });
}

/** Все условия правила (И): первое не прошедшее — в reason. Пустое правило — проходит. */
export function matchRule(rule: MatchRule | undefined, e: RoutineEvent): { ok: boolean; reason?: string } {
  for (const [k, v] of Object.entries(rule ?? {})) {
    const r = matchOne(e, k, v);
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
