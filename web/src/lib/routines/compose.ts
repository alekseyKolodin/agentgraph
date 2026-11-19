// «Новая рутина» по описанию словами: что запомнить, пока человек уходит подключать недостающий источник, и как это
// вернуть. Черновик лежит в sessionStorage вкладки: после подключения форма открывается с ним и с новым источником.
import type { RoutineDraft } from './spec';

const KEY = 'agentgraph.routineCompose';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStore = (): Store | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

/** Запомнить черновик перед уходом на «Подключить сервис». Нет хранилища — просто не запоминаем. */
export function stashDraft(d: RoutineDraft, store: Store | undefined = defaultStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify(d));
  } catch {
    /* частное окно, переполнено — форма откроется пустой, как раньше */
  }
}

/** Прочитать запомненный черновик (возврат с подключения). Не удаляет: React в dev вызывает инициализатор состояния дважды. */
export function readStash(store: Store | undefined = defaultStore()): RoutineDraft | undefined {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as RoutineDraft;
    return v && typeof v === 'object' && typeof v.title === 'string' && Array.isArray(v.conds) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Забыть запомненный черновик: форма уже открылась с ним. */
export function dropStash(store: Store | undefined = defaultStore()): void {
  try {
    store?.removeItem(KEY);
  } catch {
    /* нечего забывать */
  }
}

/** Ссылка на «Подключить сервис» для недостающего источника: готовый вид — на «Готовые», иначе описание словами. */
export function connectNeedHref(need: { description: string; kind?: string }): string {
  const q = new URLSearchParams({ from: 'new' });
  if (need.kind) q.set('kind', need.kind);
  else q.set('q', need.description.slice(0, 500));
  return `/routines/connect?${q.toString()}`;
}
