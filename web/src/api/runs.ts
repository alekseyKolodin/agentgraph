// Запросы формы запуска и списка запусков: старт, теги, недавние папки, worktree, скрыть и удалить запуск.
import { useQuery } from '@tanstack/react-query';
import type { RecentDir, RunStarted, TagDetail, WorktreeResult } from '@server/api-types';
import { api } from './client';

export const startRun = (body: Record<string, unknown>) => api<RunStarted>('POST', '/api/runs', body);
export const fetchTag = (slug: string) => api<TagDetail>('GET', `/api/tags/${encodeURIComponent(slug)}`);
export const prepareWorktree = (body: { project: string; branch?: string; name?: string; requireExisting: boolean }) =>
  api<WorktreeResult>('POST', '/api/worktrees', body);
export const setRunHidden = (id: string, hidden: boolean) => api<unknown>('PUT', `/api/runs/${encodeURIComponent(id)}/hidden`, { hidden });
/** Событие окна после удаления запуска (detail — id): страница запуска забывает его черновики и ответы на паузу. */
export const RUN_DELETED = 'agentgraph:run-deleted';
export async function deleteRun(id: string): Promise<void> {
  await api<unknown>('DELETE', `/api/runs/${encodeURIComponent(id)}`);
  window.dispatchEvent(new CustomEvent<string>(RUN_DELETED, { detail: id }));
}

export const recentDirsKey = ['dirs', 'recent'] as const;
/** «×» на чипе: ответ — новый список без скрытого пути. */
export const hideRecentDir = (path: string) => api<RecentDir[]>('DELETE', `/api/dirs/recent?path=${encodeURIComponent(path)}`);

/** GET /api/dirs/recent: чипы под директорией проекта и доп. директориями; перечитываются при каждом открытии flow. */
export function useRecentDirs(enabled: boolean) {
  return useQuery({ queryKey: recentDirsKey, queryFn: () => api<RecentDir[]>('GET', '/api/dirs/recent'), enabled });
}
