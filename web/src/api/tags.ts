// Запросы страницы «Знания»: список тегов знаний, тег, создание, сохранение изменённых полей, удаление, вложения тега.
// Список тегов — общий запрос useTags (keys.tags): после правок страница его сбрасывает, им же пользуются форма запуска,
// форма сессии и конструктор.
import type { TagDetail, TagListItem } from '@server/api-types';
import { api } from './client';

const enc = encodeURIComponent;

export const fetchTags = () => api<{ tags: TagListItem[] }>('GET', '/api/tags');
export const createTag = (body: { slug: string; title?: string }) => api<TagDetail>('POST', '/api/tags', body);
/** description — «когда нужен» тег, inline — «заметки всегда в промпте целиком». */
export const saveTag = (slug: string, patch: { title?: string; notes?: string; dirs?: string[]; description?: string; inline?: boolean }) =>
  api<TagDetail>('PUT', `/api/tags/${enc(slug)}`, patch);
export const deleteTag = (slug: string) => api<{ ok: true }>('DELETE', `/api/tags/${enc(slug)}`);
/** Вложение грузится сразу на сервер: лимиты и типы проверяет он же, что и у вложений запуска. data — base64. */
export const addTagAttachment = (slug: string, name: string, data: string) =>
  api<{ name: string; attachments: string[] }>('POST', `/api/tags/${enc(slug)}/attachments`, { name, data });
export const deleteTagAttachment = (slug: string, name: string) =>
  api<{ attachments: string[] }>('DELETE', `/api/tags/${enc(slug)}/attachments/${enc(name)}`);
