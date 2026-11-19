// Запросы дел (docs/desk/SPEC.md 3.2, маршруты — src/desk/types.ts): список с итогом сверки, put/move/close с карточки.
// Ключи — под ['home']: событие desk общего потока /api/events (useHomeEvents) снимает keys.home, а с ним и дела.
import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query';
import type { DeskCheckReply, DeskColumn, DeskItem, DeskListReply, DeskPatch, DeskWeekReply } from '@server/desk/types';
import { api } from './client';
import { useFeature } from './queries';
import { routineKeys } from './routines';

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

/** Открытые дела (или по фильтру). Сервер без дел (старая версия) — запроса нет, data пустая. */
export function useDesk(q: DeskQuery = { open: true }) {
  const on = useFeature('desk');
  return useQuery({ queryKey: deskKeys.list(q), queryFn: () => fetchDesk(q), enabled: on });
}

/**
 * Обзор недели и «висит дольше N дней» (GET /api/desk/week, SPEC 6.1). Ключ под deskKeys.all: событие desk снимает и его;
 * раз в час заново — «висит» растёт и без движений.
 */
export function useDeskWeek(staleDays: number) {
  const on = useFeature('desk-week');
  return useQuery({
    queryKey: [...deskKeys.all, 'week', staleDays] as const,
    queryFn: () => api<DeskWeekReply>('GET', `/api/desk/week?stale=${staleDays}`),
    enabled: on,
    refetchInterval: 3_600_000,
    // смена N — прежний обзор, пока не пришёл новый: панель и select не пропадают
    placeholderData: keepPreviousData,
  });
}

/** После своей правки — перечитать дела сразу, не дожидаясь события потока. */
export const refreshDesk = (qc: QueryClient) => qc.invalidateQueries({ queryKey: deskKeys.all });

/**
 * Сверка «N из N» над доской (GET /api/desk/check): итоги источников рутин и наблюдателей. Ключ — под ['routines']: статус
 * источника приходит событием routines (useHomeEvents снимает все его ключи); сверку наблюдателей событие не шлёт — раз в
 * минуту заново (и «проверено N мин назад» не стоит).
 */
export function useDeskCheck() {
  // сервер без сверки (старая версия) — запроса нет
  const on = useFeature('desk-check');
  return useQuery({ queryKey: [...routineKeys.all, 'desk-check'] as const, queryFn: () => api<DeskCheckReply>('GET', '/api/desk/check'), enabled: on, refetchInterval: 60_000 });
}
