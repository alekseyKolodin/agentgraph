// Условия рутины на поля события (when.match, без модели): разбор MatchRule в строки редактора и обратно, текст условия
// для фразы и слотов. Оператор живёт суффиксом ключа (src/routines/types.ts → MatchRule): без суффикса — равно (массив —
// любое из), `~` — содержит, `!` — не равно, `>` `<` — числа.
import type { MatchField, MatchRule, SourceKindView } from '@server/routines/types';
import { t } from '../i18n';

export type MatchOp = 'eq' | 'contains' | 'ne' | 'gt' | 'lt';
/**
 * Строка редактора условий: значение всегда строкой, «a, b» у «равно» — любое из. raw — значение из файла как было:
 * пока строку не трогали (field, op и value те же), оно и пишется обратно — «Ошибка, срочно» не станет массивом, а
 * [100, 200] у числа — строкой.
 */
export type Condition = { field: string; op: MatchOp; value: string; raw?: { field: string; op: MatchOp; value: string; v: MatchRule[string] } };

const SUFFIX: Record<MatchOp, string> = { eq: '', contains: '~', ne: '!', gt: '>', lt: '<' };
const BY_SUFFIX: Record<string, MatchOp> = { '~': 'contains', '!': 'ne', '>': 'gt', '<': 'lt' };

/** Поля, которые движок даёт любому событию (BASE_MATCH в src/routines/kind.ts): веб не тянет рантайм из src. */
export const BASE_FIELDS: MatchField[] = [
  { key: 'title', label: t('Заголовок'), type: 'text' },
  { key: 'text', label: t('Текст'), type: 'text' },
  { key: 'author', label: t('Автор'), type: 'text' },
];

/** Поля для условий источника: свои поля вида, потом общие — без повторов по ключу. */
export function matchFields(kind?: Pick<SourceKindView, 'match'>): MatchField[] {
  const out: MatchField[] = [];
  for (const f of [...(kind?.match ?? []), ...BASE_FIELDS]) if (!out.some((o) => o.key === f.key)) out.push(f);
  return out;
}

/** Какие операторы есть у поля этого типа. */
export function opsFor(type: MatchField['type'] | undefined): MatchOp[] {
  if (type === 'number') return ['eq', 'gt', 'lt', 'ne'];
  if (type === 'bool') return ['eq'];
  if (type === 'enum') return ['eq', 'ne'];
  return ['eq', 'contains', 'ne'];
}

/** Подпись оператора в строке условия. */
export function opLabel(op: MatchOp): string {
  return { eq: '=', contains: t('содержит'), ne: '≠', gt: '>', lt: '<' }[op];
}

/** MatchRule → строки редактора, в порядке ключей файла. */
export function parseMatch(rule: MatchRule | undefined): Condition[] {
  if (!rule) return [];
  return Object.entries(rule).map(([key, v]) => {
    const last = key.slice(-1);
    const op = BY_SUFFIX[last];
    const field = op ? key.slice(0, -1) : key;
    const value = Array.isArray(v) ? v.join(', ') : String(v);
    const o = op ?? 'eq';
    return { field, op: o, value, raw: { field, op: o, value, v } };
  });
}

/**
 * Строки редактора → MatchRule. Пустые строки пропускаются. Тип значения — по типу поля: число, да/нет; «a, b» у «равно»
 * текстового поля — массив (любое из). Два условия на один ключ с одним оператором — последнее.
 */
export function buildMatch(conds: Condition[], fields: MatchField[]): MatchRule | undefined {
  const out: MatchRule = {};
  for (const c of conds) {
    const field = c.field.trim();
    const raw = c.value.trim();
    if (!field || !raw) continue;
    if (c.raw && c.raw.field === c.field && c.raw.op === c.op && c.raw.value === c.value) {
      out[field + SUFFIX[c.op]] = c.raw.v;
      continue;
    }
    const type = fields.find((f) => f.key === field)?.type ?? 'text';
    const key = field + SUFFIX[c.op];
    if (type === 'bool') out[key] = raw === 'true' || raw === t('да');
    else if (type === 'number' || c.op === 'gt' || c.op === 'lt') {
      // число или список чисел у «равно»: «100, 200»
      const nums = c.op === 'eq' && raw.includes(',') ? raw.split(',').map((x) => Number(x.trim())) : [Number(raw.replace(',', '.'))];
      out[key] = nums.every(Number.isFinite) ? (nums.length > 1 ? nums : nums[0]!) : raw;
    } else if (c.op === 'eq' && raw.includes(',')) out[key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    else out[key] = raw;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Условие одной строкой для фразы и слота: «Канал = bugs», «Тред: нет», «Длительность > 10». */
export function conditionText(c: Condition, fields: MatchField[]): string {
  const f = fields.find((x) => x.key === c.field);
  const label = f ? f.label : c.field;
  if (f?.type === 'bool') return `${label}: ${c.value === 'true' ? t('да') : t('нет')}`;
  return `${label} ${opLabel(c.op)} ${c.value}`;
}

/** Строка пуста или ещё не дописана — в правило она не попадёт. */
export const conditionReady = (c: Condition): boolean => Boolean(c.field.trim() && c.value.trim());
