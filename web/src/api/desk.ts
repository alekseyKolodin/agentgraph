// Запросы дел (docs/desk/SPEC.md 3.2, маршруты — src/desk/types.ts): список с итогом сверки, put/move/close с карточки.
// Ключи — под ['home']: событие desk общего потока /api/events (useHomeEvents) снимает keys.home, а с ним и дела.
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { DeskColumn, DeskItem, DeskListReply, DeskPatch } from '@server/desk/types';
import { api } from './client';
import { useFeature } from './queries';

export type DeskQuery = { column?: DeskColumn[]; project?: string; kind?: string; open?: boolean };

export const deskKeys = {
  all: ['home', 'desk'] as const,
  list: (q: DeskQuery) => ['home', 'desk', q] as const,
};

const qs = (q: DeskQuery): string => {
  const p = new URLSearchParams();
  if (q.column?.length) p.set('column', q.column.join(','));
  if (q.project) p.set('project', q.project);
  if (q.kind) p.set('kind', q.kind);
  if (q.open !== undefined) p.set('open', q.open ? '1' : '0');
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const fetchDesk = (q: DeskQuery = {}) => api<DeskListReply>('GET', `/api/desk${qs(q)}`);
/** Без key — своё дело (own:…); у нового нужен title. */
export const putDesk = (patch: DeskPatch, key?: string) => api<DeskItem>('POST', '/api/desk/put', { ...(key ? { key } : {}), patch });
export const moveDesk = (key: string, column: DeskColumn, why?: string) => api<DeskItem>('POST', '/api/desk/move', { key, column, ...(why ? { why } : {}) });
export const closeDesk = (key: string, reason?: string) => api<DeskItem>('POST', '/api/desk/close', { key, ...(reason ? { reason } : {}) });
/**
 * «Привязать вещь» у своего дела: адрес MR, PR или задачи Jira → дело по ключу вещи (вещь собирает сервер), своё
 * закрывается. Ответ — дело вещи. Адрес не узнан — 400, у дела уже есть вещь — 409.
 */
export const linkDesk = (key: string, url: string) => api<DeskItem>('POST', '/api/desk/link', { key, url });

/** Открытые дела (или по фильтру). Сервер без дел (старая версия) — запроса нет, data пустая. */
export function useDesk(q: DeskQuery = { open: true }) {
  const on = useFeature('desk');
  return useQuery({ queryKey: deskKeys.list(q), queryFn: () => fetchDesk(q), enabled: on });
}

/** После своей правки — перечитать дела сразу, не дожидаясь события потока. */
export const refreshDesk = (qc: QueryClient) => qc.invalidateQueries({ queryKey: deskKeys.all });
