// «Новая рутина»: черновик формы, который лежит на сервере (docs/ASSISTANTS.md §3 — уход с экрана ничего не стирает), и
// ссылка на подключение недостающего источника. Здесь — что именно сохраняется, как это читается обратно (в том числе
// черновик, сохранённый прошлой версией формы) и как по возврате со сборки flow находится только что собранный flow.
import { emptyDraft, type RoutineDraft } from './spec';

/**
 * Что уходит на сервер (PUT /api/routines/form-draft, поле data): состояние шагов, правил ли человек название и какие
 * flow были, когда он ушёл собирать новый, — по возврате единственный новый подставится сам.
 */
export type FormDraftData = { v: 1; d: RoutineDraft; titleEdited: boolean; flowsBefore?: string[]; chat?: FormChat };

/**
 * Разговор с помощником, открытый на форме: id (по возврате лента открывается с сервера) и номер результата, который
 * форма уже приняла, — принятый черновик помощника не ложится поверх правок человека второй раз.
 */
export type FormChat = { id: string; rev: number };

export function packDraft(d: RoutineDraft, titleEdited: boolean, flowsBefore?: string[], chat?: FormChat): FormDraftData {
  return { v: 1, d, titleEdited, ...(flowsBefore ? { flowsBefore } : {}), ...(chat ? { chat } : {}) };
}

/** Черновик с сервера → состояние формы. Не наш формат — undefined; поля, которых не было в старой форме, — из пустой. */
export function unpackDraft(data: unknown): FormDraftData | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const x = data as Partial<FormDraftData>;
  const d = x.d as Partial<RoutineDraft> | undefined;
  if (x.v !== 1 || !d || typeof d !== 'object' || typeof d.title !== 'string' || !Array.isArray(d.conds)) return undefined;
  const before = Array.isArray(x.flowsBefore) ? x.flowsBefore.filter((f): f is string => typeof f === 'string') : undefined;
  const c = x.chat as Partial<FormChat> | undefined;
  const chat = c && typeof c === 'object' && typeof c.id === 'string' && c.id ? { id: c.id, rev: typeof c.rev === 'number' && c.rev > 0 ? c.rev : 0 } : undefined;
  return { v: 1, d: { ...emptyDraft(), ...d }, titleEdited: x.titleEdited === true, ...(before ? { flowsBefore: before } : {}), ...(chat ? { chat } : {}) };
}

/** В форме уже что-то выбрано или написано: пустую форму на сервер не пишем (и чужой черновик ею не затираем). */
export function draftTouched(d: RoutineDraft): boolean {
  const { title: _t, ...rest } = d;
  const { title: _e, ...empty } = emptyDraft();
  return Boolean(d.title.trim()) || JSON.stringify(rest) !== JSON.stringify(empty);
}

/** Flow, собранный, пока человек уходил с формы: единственный, которого не было до ухода. Несколько или ни одного — не угадываем. */
export function pickNewFlow(before: string[] | undefined, now: string[]): string | undefined {
  if (!before) return undefined;
  const known = new Set(before);
  const fresh = now.filter((f) => !known.has(f));
  return fresh.length === 1 ? fresh[0] : undefined;
}

/** Ссылка на «Подключить сервис» для недостающего источника: готовый вид — на «Готовые», иначе описание словами. */
export function connectNeedHref(need: { description: string; kind?: string }): string {
  const q = new URLSearchParams({ from: 'new' });
  if (need.kind) q.set('kind', need.kind);
  else q.set('q', need.description.slice(0, 500));
  return `/routines/connect?${q.toString()}`;
}
