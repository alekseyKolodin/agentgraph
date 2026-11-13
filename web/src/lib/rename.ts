// Переименование на месте (components/InlineRename.tsx) без React и DOM: что сохранять из набранного.

/**
 * Имя к сохранению или null — сохранять нечего. Как на сервере: пробелы и переводы строк — одним пробелом, по краям
 * обрезаны, не длиннее max символов. Пустое — отмена (а не «имя по умолчанию»); прежнее — тоже ничего не сохраняет.
 */
export function nameToSave(draft: string, current: string, max: number): string | null {
  const name = [...draft.replace(/\s+/g, ' ').trim()].slice(0, max).join('').trimEnd();
  return name && name !== current ? name : null;
}
