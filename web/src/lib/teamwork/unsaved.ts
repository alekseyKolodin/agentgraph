// Несохранённый ввод Teamwork вне компонентов, как правка раздела в screens/teamwork/docs/edits.ts: описание и комментарий в
// панели задачи, правки предложения разбивки, поля нового проекта. Переживает размонтирование — клик мимо панели, переход к
// другой задаче, смену вкладки — и пишется по ключу даже после него: ответ сервера, пришедший, когда компонента уже нет, всё
// равно снимает отправленный текст (у useMemoryState запись после размонтирования теряется, и отправленный комментарий
// всплыл бы снова). Только в памяти вкладки браузера. «Черновик» в Teamwork — черновик агента, поэтому здесь «несохранённое».
// Без React: хук — в screens/teamwork/unsaved.ts.

export type UnsavedUpdate<T> = T | undefined | ((prev: T | undefined) => T | undefined);

/** Ключ: части через \0 — slug, номер задачи и запуска его не содержат. */
export const unsavedKey = (...parts: string[]): string => parts.join('\u0000');

export function createUnsaved() {
  const values = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const get = <T>(key: string): T | undefined => values.get(key) as T | undefined;
  return {
    get,
    /** Записать значение (или функцию от прежнего); undefined — снять. Слушатели узнают о каждой записи. */
    set<T>(key: string, next: UnsavedUpdate<T>): void {
      const v = typeof next === 'function' ? (next as (p: T | undefined) => T | undefined)(get<T>(key)) : next;
      if (v === undefined) values.delete(key);
      else values.set(key, v);
      for (const l of listeners) l();
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /** Есть ли запись, которую pred считает несохранённым текстом: для вопроса браузера при перезагрузке. */
    some(pred: (key: string, value: unknown) => boolean): boolean {
      for (const [k, v] of values) if (pred(k, v)) return true;
      return false;
    },
  };
}

export type Unsaved = ReturnType<typeof createUnsaved>;

/** Хранилище вкладки браузера: одно на все экраны Teamwork. */
export const unsaved: Unsaved = createUnsaved();
