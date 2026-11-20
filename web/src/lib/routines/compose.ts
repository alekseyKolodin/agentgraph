// «Новая рутина»: черновик формы, который лежит на сервере (docs/ASSISTANTS.md §3 — уход с экрана ничего не стирает), и
// ссылка на подключение недостающего источника. Здесь — что именно сохраняется, как это читается обратно (в том числе
// черновик, сохранённый прошлой версией формы), с чем открывается форма (черновик или шаблон), когда её можно писать
// на сервер и как по возврате со сборки flow находится только что собранный flow.
import type { SectionNo } from './editor';
import { emptyDraft, type RoutineDraft } from './spec';

/**
 * Что уходит на сервер (PUT /api/routines/form-draft, поле data): состояние разделов, правил ли человек название, какие
 * flow были, когда он ушёл собирать новый (по возврате единственный новый подставится сам), разговор с помощником,
 * разделы с меткой «заполнил помощник» и шаблон, с которого начали (?tpl=): по нему форма узнаёт свой черновик.
 */
export type FormDraftData = {
  v: 1;
  d: RoutineDraft;
  titleEdited: boolean;
  flowsBefore?: string[];
  chat?: FormChat;
  /** Разделы, которые заполнил помощник и человек ещё не правил (метка у заголовка). */
  filled?: SectionNo[];
  /** Шаблон, с которого начата форма. */
  tpl?: string;
};

/**
 * Разговор с помощником, открытый на форме: id (по возврате лента открывается с сервера), номер результата, который
 * форма уже приняла (принятый черновик помощника не ложится второй раз), и base — форма, как она ушла помощнику с
 * последним сообщением: его результат применяется только там, где он что-то поменял относительно неё.
 */
export type FormChat = { id: string; rev: number; base?: RoutineDraft };

/** Что ещё, кроме формы и признака «название правил человек», лежит в черновике. */
export type DraftExtras = Omit<FormDraftData, 'v' | 'd' | 'titleEdited'>;

export function packDraft(d: RoutineDraft, titleEdited: boolean, more: DraftExtras = {}): FormDraftData {
  const { flowsBefore, chat, filled, tpl } = more;
  return { v: 1, d, titleEdited, ...(flowsBefore ? { flowsBefore } : {}), ...(chat ? { chat } : {}), ...(filled?.length ? { filled: [...filled] } : {}), ...(tpl ? { tpl } : {}) };
}

/** Черновик с сервера → состояние формы. Не наш формат — undefined; поля, которых не было в старой форме, — из пустой. */
export function unpackDraft(data: unknown): FormDraftData | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const x = data as Partial<FormDraftData>;
  const d = x.d as Partial<RoutineDraft> | undefined;
  if (x.v !== 1 || !d || typeof d !== 'object' || typeof d.title !== 'string' || !Array.isArray(d.conds)) return undefined;
  const before = Array.isArray(x.flowsBefore) ? x.flowsBefore.filter((f): f is string => typeof f === 'string') : undefined;
  const c = x.chat as Partial<FormChat> | undefined;
  const base = c && typeof c === 'object' && c.base && typeof c.base === 'object' && Array.isArray(c.base.conds) ? { ...emptyDraft(), ...c.base } : undefined;
  const chat = c && typeof c === 'object' && typeof c.id === 'string' && c.id ? { id: c.id, rev: typeof c.rev === 'number' && c.rev > 0 ? c.rev : 0, ...(base ? { base } : {}) } : undefined;
  const filled = Array.isArray(x.filled) ? x.filled.filter((n): n is SectionNo => n === 1 || n === 2 || n === 3) : [];
  const tpl = typeof x.tpl === 'string' && /^[a-z-]{1,32}$/.test(x.tpl) ? x.tpl : undefined;
  return { v: 1, d: { ...emptyDraft(), ...d }, titleEdited: x.titleEdited === true, ...(before ? { flowsBefore: before } : {}), ...(chat ? { chat } : {}), ...(filled.length ? { filled } : {}), ...(tpl ? { tpl } : {}) };
}

/**
 * С чем открыть форму: черновик с сервера — если адрес не просит шаблон или просит тот же, с которого черновик начат
 * (перезагрузка, возврат с «Подключить сервис»). Другой шаблон — явное «начать с него»: черновик не берётся.
 */
export function draftToOpen(saved: FormDraftData | undefined, tpl: string | null): FormDraftData | undefined {
  if (!saved) return undefined;
  return !tpl || saved.tpl === tpl ? saved : undefined;
}

/**
 * Писать ли форму на сервер сейчас. Только то, что тронул человек (правка, помощник, уход собирать flow): форма, открытая
 * с шаблона или черновика и поправленная лишь автоподстановками (ответ по источнику, «кто я»), чужой черновик не
 * перезаписывает. closed — форма уже не черновик (рутина сохранена, «Начать заново»); noSave — черновик не прочитался.
 */
export function shouldSaveDraft(o: { human: boolean; noSave: boolean; closed: boolean; payload: string; last: string }): boolean {
  return o.human && !o.noSave && !o.closed && o.payload !== o.last;
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
