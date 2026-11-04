// Запросы страницы «Пространства»: список, пространство с его запусками и сессиями, создание, правка карты, состояния,
// заголовка и папок, удаление, документы, что пространство даёт модели. Список — общий запрос useSpaces (keys.spaces):
// им же пользуются форма запуска и форма сессии.
import { useQuery } from '@tanstack/react-query';
import type {
  ModelContextView, Space, SpaceContextView, SpaceDetail, SpaceDoc, SpaceDocText, SpaceDraftBody, SpaceDraftEstimate, SpaceDraftFailure, SpaceDraftModel, SpaceDraftReply, SpaceGroupsEstimate,
  SpaceGroupsReply, SpaceListItem,
} from '@server/api-types';
import { api } from './client';
import { aiStream, type FlowAiProgressEvent } from './flows';
import { keys } from './queries';

const enc = encodeURIComponent;

export const fetchSpaces = () => api<{ spaces: SpaceListItem[] }>('GET', '/api/spaces');
export const fetchSpace = (slug: string) => api<SpaceDetail>('GET', `/api/spaces/${enc(slug)}`);
/** map и state — из черновика модели, который человек просмотрел: сервер проверяет их до создания. */
export const createSpace = (body: { slug: string; title?: string; gist?: string; dirs?: string[]; cwd?: string; map?: string; state?: string }) => api<Space>('POST', '/api/spaces', body);
/**
 * mapBase и stateBase — mtimeMs файла, с которого начали правку (0 — файла не было): изменили снаружи — 409.
 * legacySummary — саммари тега, дописанное старой версией: взять в состояние или скрыть; keepTitle — оставить
 * заголовок, придуманный ИИ, как есть (он станет заголовком пользователя).
 */
export const saveSpace = (
  slug: string,
  patch: { title?: string; map?: string; state?: string; dirs?: string[]; cwd?: string; mapBase?: number; stateBase?: number; legacySummary?: 'import' | 'dismiss'; keepTitle?: true },
) => api<Space>('PUT', `/api/spaces/${enc(slug)}`, patch);
export const deleteSpace = (slug: string) => api<{ ok: true }>('DELETE', `/api/spaces/${enc(slug)}`);
export const fetchSpaceContext = (slug: string) => api<SpaceContextView>('GET', `/api/spaces/${enc(slug)}/context`);
/** Документ грузится сразу на сервер: типы и лимиты — как у вложений запуска. data — base64. */
export const addSpaceDoc = (slug: string, name: string, data: string) => api<{ name: string; docs: SpaceDoc[] }>('POST', `/api/spaces/${enc(slug)}/docs`, { name, data });
export const fetchSpaceDoc = (slug: string, name: string) => api<SpaceDocText>('GET', `/api/spaces/${enc(slug)}/docs/${enc(name)}`);
/** base — mtimeMs версии, с которой начали правку (0 — новый файл): изменили снаружи — 409. */
export const saveSpaceDoc = (slug: string, name: string, text: string, base: number) => api<SpaceDocText>('PUT', `/api/spaces/${enc(slug)}/docs/${enc(name)}`, { text, base });
export const deleteSpaceDoc = (slug: string, name: string) => api<{ docs: SpaceDoc[] }>('DELETE', `/api/spaces/${enc(slug)}/docs/${enc(name)}`);

/**
 * «Модель получит»: что пространство (слаг; пусто — без него) и теги знаний дадут модели — точный текст и разбор. cwd —
 * рабочая папка сессии: от неё зависит, придёт ли карта памятью.
 */
export const fetchModelContext = (space: string, tags: string[], cwd = '') =>
  api<ModelContextView>('GET', `/api/model-context?${new URLSearchParams({ ...(space ? { space } : {}), ...(tags.length ? { tags: tags.join(',') } : {}), ...(cwd ? { cwd } : {}) })}`);

/**
 * Превью «Модель получит» в формах и на экране сессии: перечитывается при смене пространства, тегов или папки. Ключ — под
 * keys.spaces: правка карты, состояния, документов и запись состояния снимают его вместе со списком пространств.
 */
export function useModelContext(space: string, tags: string[], cwd: string, enabled: boolean) {
  return useQuery({ queryKey: [...keys.spaces, 'model-context', space, tags.join(','), cwd], queryFn: () => fetchModelContext(space, tags, cwd), enabled, staleTime: 15_000 });
}

/** GET /api/spaces: список для страницы и выбора пространства в формах. */
export function useSpaces(enabled: boolean) {
  return useQuery({ queryKey: keys.spaces, queryFn: fetchSpaces, enabled });
}

/** Сбой модели черновика: что случилось и сколько успели потратить (SpaceDraftFailure). */
export class DraftError extends Error {
  constructor(readonly failure: SpaceDraftFailure) {
    super(failure.error);
  }
}

/** Ответ потока: сбой модели приходит телом done с error — это исключение с ценой. */
async function draftStream<B extends object>(url: string, body: unknown, onEvent: (e: FlowAiProgressEvent) => void, signal: AbortSignal): Promise<B> {
  const done = await aiStream<B | SpaceDraftFailure>(url, body, onEvent, signal);
  if ('error' in done && typeof done.error === 'string') throw new DraftError(done as SpaceDraftFailure);
  return done as B;
}

/** Оценка черновика до запуска: модель не зовётся. */
export const estimateDraft = (body: SpaceDraftBody) => api<SpaceDraftEstimate>('POST', '/api/space-drafts', { ...body, estimate: true });
/** Черновик пространства потоком: ход (что модель читает) — onEvent, результат — черновик; signal — «Отменить». Ничего не пишет. */
export const draftSpace = (body: SpaceDraftBody, onEvent: (e: FlowAiProgressEvent) => void, signal: AbortSignal) => draftStream<SpaceDraftReply>('/api/space-drafts', body, onEvent, signal);
export const estimateGroups = (model: SpaceDraftModel) => api<SpaceGroupsEstimate>('POST', '/api/space-groups', { model, estimate: true });
/** «Предложить пространства»: работа без пространства группами. Ничего не заводит. */
export const proposeSpaces = (model: SpaceDraftModel, onEvent: (e: FlowAiProgressEvent) => void, signal: AbortSignal) => draftStream<SpaceGroupsReply>('/api/space-groups', { model }, onEvent, signal);
