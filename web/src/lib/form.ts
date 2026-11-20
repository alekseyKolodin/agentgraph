// Логика общей системы полей (components/form): поиск в списке Select, ход стрелками, токены TokenInput и число с
// префиксом/суффиксом. Без React и DOM — тесты рядом (form.test.ts).

/** Вариант списка: value — что уходит наружу, label — что видит человек, sub — вторая строка (тихая), keywords — ищется тоже. */
export type SelectOption<V extends string = string> = { value: V; label: string; sub?: string; keywords?: string; disabled?: boolean };

/** Варианты под поиск: без регистра, по подписи, значению, второй строке и keywords; пустой запрос — все. */
export function filterOptions<V extends string>(options: SelectOption<V>[], query: string): SelectOption<V>[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => [o.label, o.value, o.sub ?? '', o.keywords ?? ''].some((s) => s.toLowerCase().includes(q)));
}

/**
 * Следующая активная строка по стрелке: пропускает выключенные, по кругу. from = -1 — ничего не подсвечено (первая стрелка
 * вниз даёт первую доступную, вверх — последнюю). Доступных нет — -1.
 */
export function stepActive(options: Pick<SelectOption, 'disabled'>[], from: number, step: 1 | -1): number {
  const n = options.length;
  if (!n || options.every((o) => o.disabled)) return -1;
  let i = from < 0 ? (step > 0 ? -1 : n) : from;
  for (let k = 0; k < n; k++) {
    i = (i + step + n) % n;
    if (!options[i]!.disabled) return i;
  }
  return -1;
}

/**
 * Поиск по первым буквам в списке без поиска: следующая доступная строка, чья подпись начинается с prefix (без регистра).
 * Одна буква ищет после from (повтор той же буквы ходит по строкам на неё), несколько — с from. Нет — -1.
 */
export function typeahead(options: Pick<SelectOption, 'label' | 'disabled'>[], from: number, prefix: string): number {
  const n = options.length;
  const p = prefix.toLowerCase();
  if (!n || !p) return -1;
  const start = p.length === 1 ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    const o = options[i]!;
    if (!o.disabled && o.label.toLowerCase().startsWith(p)) return i;
  }
  return -1;
}

/**
 * Добавить в TokenInput вписанное: запятая делит на несколько значений, пробелы по краям срезаются, пустые и повторы
 * (без регистра) не добавляются. rest — что осталось в поле (хвост после последней запятой, если commit = false).
 */
export function addTokens(tokens: string[], text: string, commit: boolean): { tokens: string[]; rest: string } {
  const parts = text.split(',');
  const tail = commit ? '' : (parts.pop() ?? '');
  const out = [...tokens];
  for (const p of parts) {
    const v = p.trim();
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return { tokens: out, rest: commit ? '' : tail.replace(/^\s+/, '') };
}

/**
 * Текст числового поля → число. Пусто — null (поле «без лимита»); запятая как десятичная точка; не число, меньше min или
 * больше max — NaN (поле подсвечивается ошибкой, наружу уходит прошлое значение).
 */
export function parseNumber(text: string, o: { min?: number; max?: number; integer?: boolean } = {}): number | null {
  const s = text.trim().replace(',', '.');
  if (!s) return null;
  if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(s)) return NaN;
  const n = Number(s);
  if (o.integer && !Number.isInteger(n)) return NaN;
  if (o.min !== undefined && n < o.min) return NaN;
  if (o.max !== undefined && n > o.max) return NaN;
  return n;
}
