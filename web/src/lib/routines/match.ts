// Условия рутины на поля события (when.match, без модели): разбор правила в строки редактора и обратно, текст условия
// для фразы и слотов. Правило — список { field, op, value } (src/routines/types.ts → MatchCondition); старый словарь, где
// оператор живёт суффиксом ключа (без суффикса — равно, `~` — содержит, `!` — не равно, `>` `<` — числа), тоже читается,
// а пишется уже список: строки не схлопываются, два «≠» на одно поле остаются двумя условиями.
import type { MatchCondition, MatchField, MatchOp, MatchRule, MatchValue, SourceKindView } from '@server/routines/types';
import { t } from '../i18n';

export type { MatchOp };
/**
 * Строка редактора условий: значение всегда строкой, «a, b» у «равно», «содержит» и «≠» — список (любое из / ни одно
 * из). raw — значение из файла как было: пока строку не трогали (field, op и value те же), оно и пишется обратно —
 * «Ошибка, срочно» не станет массивом, а [100, 200] у числа — строкой.
 */
export type Condition = {
  field: string;
  op: MatchOp;
  value: string;
  /**
   * Значения явным списком (поле «Значения» токенами): есть — buildMatch берёт их как есть и не делит value по запятой,
   * так что «Ошибка, срочно» остаётся одним значением, а «1,5» у числа — числом 1.5. value при этом — они же через «, »
   * (для фразы и проверки «дописано ли»). Нет — value разбирается по-старому (фраза «Новой рутины»).
   */
  values?: string[];
  /** Набрано в поле «Значения», но ещё не стало токеном (без Enter): уже часть правила — его видят сохранение и проверка. */
  pending?: string;
  raw?: { field: string; op: MatchOp; value: string; v: MatchValue };
};

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

/** Правило (список или старый словарь) → строки редактора, в порядке файла. */
export function parseMatch(rule: MatchRule | undefined): Condition[] {
  if (!rule) return [];
  const rows: MatchCondition[] = Array.isArray(rule)
    ? rule
    : Object.entries(rule).map(([key, value]) => {
        const op = BY_SUFFIX[key.slice(-1)];
        return { field: op ? key.slice(0, -1) : key, op: op ?? 'eq', value };
      });
  return rows.map((c) => {
    const o = c.op ?? 'eq';
    const value = Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '');
    const values = (Array.isArray(c.value) ? c.value.map(String) : [value]).filter((x) => x.trim());
    return { field: c.field, op: o, value, values, raw: { field: c.field, op: o, value, v: c.value } };
  });
}

const splitList = (raw: string): string[] => raw.split(',').map((s) => s.trim()).filter(Boolean);
const untouched = (c: Condition): boolean => Boolean(c.raw && c.raw.field === c.field && c.raw.op === c.op && c.raw.value === c.value && !c.pending?.trim());
/** Список значений строки в силе, пока value — он же: строку правили по-старому (фразой) — value главнее. */
const synced = (c: Condition): boolean => Boolean(c.values && c.values.join(', ') === c.value);

/**
 * Значения строки так, как они уйдут в правило: нетронутая строка из файла — как в файле (raw), явный список (values),
 * иначе value по запятой; набранное без Enter (pending) — последним. Пустые и из одних пробелов не считаются — как
 * emptyValue в src/routines/match.ts: массив из одних пустых значений сервер не применяет.
 */
export function condValues(c: Condition): string[] {
  if (untouched(c)) {
    const v = c.raw!.v;
    return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined).map((x) => String(x).trim()).filter(Boolean);
  }
  const base = synced(c) ? c.values!.map((x) => x.trim()).filter(Boolean) : splitList(c.value);
  const more = c.pending?.trim();
  return more && !base.some((x) => x.toLowerCase() === more.toLowerCase()) ? [...base, more] : base;
}

/** Строка не дописана (нет поля или ни одного непустого значения) — в правило она не попадёт. */
export const conditionReady = (c: Condition): boolean => Boolean(c.field.trim()) && condValues(c).length > 0;

/**
 * Индексы строк, которые в правило не попадут, пока не дописаны: нет поля или значения. Редактор подсвечивает их
 * («не сохранится, пока пусто») — остальное правило при этом сохраняется.
 */
export function incompleteConds(conds: readonly Condition[]): number[] {
  return conds.flatMap((c, i) => (conditionReady(c) ? [] : [i]));
}

/**
 * Строки редактора → when.match (список, порядок строк). Недописанные строки пропускаются (см. incompleteConds), прочие
 * не схлопываются. Тип значения — по типу поля: число, да/нет; «a, b» у «равно», «содержит» и «≠» — список (у «≠» — ни
 * одно из). У «>» и «<» — одно число.
 */
export function buildMatch(conds: Condition[], fields: MatchField[]): MatchCondition[] | undefined {
  const out: MatchCondition[] = [];
  for (const c of conds) {
    if (!conditionReady(c)) continue;
    const field = c.field.trim();
    if (untouched(c)) {
      out.push({ field, op: c.op, value: c.raw!.v });
      continue;
    }
    const type = fields.find((f) => f.key === field)?.type ?? 'text';
    // явный список или набранное без Enter — значения строки списком; иначе value разбирается по-старому
    const list = synced(c) || c.pending?.trim() ? condValues(c) : undefined;
    const raw = list ? list.join(', ') : c.value.trim();
    let value: MatchValue;
    if (type === 'bool') value = raw === 'true' || raw === t('да');
    else if (list?.length && c.op !== 'gt' && c.op !== 'lt') {
      // явный список: по запятой не делится; у числа «1,5» — десятичная запятая
      if (type === 'number') {
        const nums = list.map((x) => Number(x.replace(',', '.')));
        value = nums.every(Number.isFinite) ? (nums.length > 1 ? nums : nums[0]!) : list.length > 1 ? list : list[0]!;
      } else value = list.length > 1 ? list : list[0]!;
    } else if (c.op === 'gt' || c.op === 'lt') {
      const n = Number(raw.replace(',', '.'));
      value = Number.isFinite(n) ? n : raw;
    } else if (type === 'number') {
      // число или список чисел у «равно» и «≠»: «100, 200»
      const nums = raw.includes(',') ? splitList(raw).map(Number) : [Number(raw)];
      value = nums.every(Number.isFinite) ? (nums.length > 1 ? nums : nums[0]!) : raw;
    } else if (raw.includes(',')) {
      const vals = splitList(raw);
      value = vals.length > 1 ? vals : (vals[0] ?? raw);
    } else value = raw;
    out.push({ field, op: c.op, value });
  }
  return out.length ? out : undefined;
}
