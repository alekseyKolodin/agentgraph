// Поиск в сайдбаре по flow и по запускам (порт ui/search.js): идёт на клиенте по уже загруженным спискам, API не меняется.

/** Запрос → слова в нижнем регистре; пустой запрос — пустой список (находит всё). */
export const searchWords = (q: string | null | undefined): string[] => String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);

/** Каждое слово — подстрока хоть одного из полей. */
export function textMatches(fields: (string | null | undefined)[], words: string[]): boolean {
  if (!words.length) return true;
  const hay = fields.filter((x) => x !== undefined && x !== null && x !== '').join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

type RunLike = { id: string; flow: string; title?: string; input?: string; tags?: string[]; knowledge?: string[]; cwd?: string; source?: { key: string } };

/** Запуск: имя, flow, задача, теги задачи и знаний, папка проекта (последний сегмент cwd), id и ключ источника. */
export function runMatches(run: RunLike, words: string[]): boolean {
  const folder = String(run.cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return textMatches([run.title, run.flow, run.input, ...(run.tags ?? []), ...(run.knowledge ?? []), folder, run.id, run.source?.key], words);
}

/** Flow: имя, папка и описание. */
export const flowMatches = (flow: { name: string; folder?: string; description?: string }, words: string[]): boolean =>
  textMatches([flow.name, flow.folder, flow.description], words);
