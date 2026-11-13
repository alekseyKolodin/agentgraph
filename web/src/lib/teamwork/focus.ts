// Ловушка фокуса панели поверх экрана (панель задачи — aria-modal без <dialog>): Tab и Shift+Tab ходят по кругу внутри неё.
// Обработчик клавиш — screens/teamwork/focus.ts; здесь только шаг.

/**
 * Куда перевести фокус по Tab: индекс элемента, -1 — на саму панель (фокусироваться в ней не на чем), undefined — шаг
 * внутри, пусть ходит браузер. index — элемент с фокусом среди count, -1 — фокус вне них.
 */
export function trapStep(count: number, index: number, back: boolean): number | undefined {
  if (count === 0) return -1;
  if (index < 0) return back ? count - 1 : 0;
  if (back && index === 0) return count - 1;
  if (!back && index === count - 1) return 0;
  return undefined;
}
