// Запросы страницы «Пространства»: список, пространство с его запусками и сессиями, создание, правка карты, состояния,
// заголовка и папок, удаление, документы, что пространство даёт модели. Список — общий запрос useSpaces (keys.spaces):
// им же пользуются форма запуска и форма сессии.
import { useQuery } from '@tanstack/react-query';
import type { ModelContextView, Space, SpaceContextView, SpaceDetail, SpaceDoc, SpaceDocText, SpaceListItem } from '@server/api-types';
import { api } from './client';
import { keys } from './queries';

const enc = encodeURIComponent;

export const fetchSpaces = () => api<{ spaces: SpaceListItem[] }>('GET', '/api/spaces');
export const fetchSpace = (slug: string) => api<SpaceDetail>('GET', `/api/spaces/${enc(slug)}`);
export const createSpace = (body: { slug: string; title?: string; gist?: string; dirs?: string[]; cwd?: string }) => api<Space>('POST', '/api/spaces', body);
/** mapBase и stateBase — mtimeMs файла, с которого начали правку (0 — файла не было): изменили снаружи — 409. */
export const saveSpace = (slug: string, patch: { title?: string; map?: string; state?: string; dirs?: string[]; cwd?: string; mapBase?: number; stateBase?: number }) =>
  api<Space>('PUT', `/api/spaces/${enc(slug)}`, patch);
export const deleteSpace = (slug: string) => api<{ ok: true }>('DELETE', `/api/spaces/${enc(slug)}`);
export const fetchSpaceContext = (slug: string) => api<SpaceContextView>('GET', `/api/spaces/${enc(slug)}/context`);
/** Документ грузится сразу на сервер: типы и лимиты — как у вложений запуска. data — base64. */
export const addSpaceDoc = (slug: string, name: string, data: string) => api<{ name: string; docs: SpaceDoc[] }>('POST', `/api/spaces/${enc(slug)}/docs`, { name, data });
export const fetchSpaceDoc = (slug: string, name: string) => api<SpaceDocText>('GET', `/api/spaces/${enc(slug)}/docs/${enc(name)}`);
/** base — mtimeMs версии, с которой начали правку (0 — новый файл): изменили снаружи — 409. */
export const saveSpaceDoc = (slug: string, name: string, text: string, base: number) => api<SpaceDocText>('PUT', `/api/spaces/${enc(slug)}/docs/${enc(name)}`, { text, base });
export const deleteSpaceDoc = (slug: string, name: string) => api<{ docs: SpaceDoc[] }>('DELETE', `/api/spaces/${enc(slug)}/docs/${enc(name)}`);

/** «Модель получит»: что пространство (слаг; пусто — без него) и теги знаний дадут модели — точный текст и разбор. */
export const fetchModelContext = (space: string, tags: string[]) =>
  api<ModelContextView>('GET', `/api/model-context?${new URLSearchParams({ ...(space ? { space } : {}), ...(tags.length ? { tags: tags.join(',') } : {}) })}`);

/** Превью «Модель получит» в формах и на экране сессии: перечитывается при смене пространства или тегов. */
export function useModelContext(space: string, tags: string[], enabled: boolean) {
  return useQuery({ queryKey: ['model-context', space, tags.join(',')], queryFn: () => fetchModelContext(space, tags), enabled, staleTime: 15_000 });
}

/** GET /api/spaces: список для страницы и выбора пространства в формах. */
export function useSpaces(enabled: boolean) {
  return useQuery({ queryKey: keys.spaces, queryFn: fetchSpaces, enabled });
}
