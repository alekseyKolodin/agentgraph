// Порядок задач: дробный индекс `rank` (spec §5.8). Алгоритм midpoint из rocicorp/fractional-indexing на алфавите
// 0-9A-Za-z без целой части и без зависимости. Тот же алгоритм на сервере (src/teamwork.ts rankBetween): общие примеры —
// в тестах, (∅,∅)→V, (V,∅)→l, (∅,V)→G, (V,W)→VV. Ранги сравниваются как строки: алфавит идёт по кодам символов.
// Чистые функции без React и DOM.

export const RANK_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const ZERO = RANK_DIGITS[0]!;

/** Годный ранг: не пустой, только символы алфавита и не оканчивается на «0» — иначе рядом с ним нет места. */
export const isRank = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && !s.endsWith(ZERO) && [...s].every((ch) => RANK_DIGITS.includes(ch));

function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined && a >= b) throw new Error(`rank: ${a || '∅'} >= ${b}`);
  if (a.endsWith(ZERO) || (b !== undefined && b.endsWith(ZERO))) throw new Error('rank: trailing zero');
  if (b !== undefined) {
    // общий префикс убираем, `a` при этом дополняется нулями
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? RANK_DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== undefined ? RANK_DIGITS.indexOf(b[0]!) : RANK_DIGITS.length;
  if (digitB - digitA > 1) return RANK_DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  // первые символы соседние
  if (b !== undefined && b.length > 1) return b.slice(0, 1);
  return RANK_DIGITS[digitA]! + midpoint(a.slice(1), undefined);
}

function check(s: string | undefined, name: string): string | undefined {
  if (s === undefined || s === '') return undefined;
  if (!isRank(s)) throw new Error(`rank: bad ${name} ${JSON.stringify(s)}`);
  return s;
}

/**
 * Ранг строго между соседями: нет соседа — с края. Бросает на a >= b и на негодном ранге
 * (пустая строка считается отсутствием соседа).
 */
export function rankBetween(a?: string, b?: string): string {
  return midpoint(check(a, 'a') ?? '', check(b, 'b'));
}

/** Сравнение рангов: по символам алфавита, равные — по id (одинаковые ранги бывают после одновременных переносов). */
export function compareRank(a: { rank: string; id: string }, b: { rank: string; id: string }): number {
  if (a.rank < b.rank) return -1;
  if (a.rank > b.rank) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Копия списка по рангу, затем по id. */
export const byRank = <T extends { rank: string; id: string }>(list: readonly T[]): T[] => [...list].sort(compareRank);

/**
 * Ранг для вставки на позицию index в список рангов (без переносимого элемента): между ranks[index-1] и ranks[index].
 * Негодные ранги пропускаются; если следующий сосед не больше предыдущего (дубли после одновременных переносов),
 * берётся первый следующий, который больше, — так элемент точно встанет после предыдущего.
 */
export function rankForDrop(ranks: readonly string[], index: number): string {
  const at = Math.max(0, Math.min(index, ranks.length));
  let prev: string | undefined;
  for (let i = at - 1; i >= 0; i--) {
    const r = ranks[i];
    if (isRank(r)) {
      prev = r;
      break;
    }
  }
  let next: string | undefined;
  for (let i = at; i < ranks.length; i++) {
    const r = ranks[i];
    if (isRank(r) && (prev === undefined || r > prev)) {
      next = r;
      break;
    }
  }
  return midpoint(prev ?? '', next);
}

/** Ранг для новой задачи в начале списка. */
export const rankAtStart = (ranks: readonly string[]): string => rankForDrop(ranks, 0);

/** Ранг для новой задачи в конце списка. */
export const rankAtEnd = (ranks: readonly string[]): string => rankForDrop(ranks, ranks.length);
