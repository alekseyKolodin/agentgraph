// Запросы страницы «Контекст»: листинг контекста сессии этапа и файлы CLAUDE.md и правил из него.
import type { ContextFile, ContextFileSaved, ContextView } from '@server/api-types';
import { api } from './client';

/** GET /api/context?<query>: query — из ctxQuery (lib/context.ts). Сервер кэширует листинг на минуту, force=1 — мимо кэша. */
export const fetchContext = (query: string) => api<ContextView>('GET', `/api/context?${query}`);
export const fetchContextFile = (path: string) => api<ContextFile>('GET', `/api/context/file?path=${encodeURIComponent(path)}`);
/** Запись с проверкой mtimeMs: файл изменили снаружи — 409. */
export const saveContextFile = (path: string, text: string, mtimeMs: number) => api<ContextFileSaved>('PUT', '/api/context/file', { path, text, mtimeMs });
