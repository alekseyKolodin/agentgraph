// Запросы формы запуска и списка запусков: старт, теги, недавние папки, worktree, скрыть, переименовать и удалить запуск.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecentDir, RunRenamed, RunStarted, RunSummary, TagDetail, WorktreeResult } from '@server/api-types';
import { api } from './client';
import { keys } from './queries';

export const startRun = (body: Record<string, unknown>) => api<RunStarted>('POST', '/api/runs', body);
export const fetchTag = (slug: string) => api<TagDetail>('GET', `/api/tags/${encodeURIComponent(slug)}`);
export const prepareWorktree = (body: { project: string; branch?: string; name?: string; requireExisting: boolean }) =>
  api<WorktreeResult>('POST', '/api/worktrees', body);
export const setRunHidden = (id: string, hidden: boolean) => api<unknown>('PUT', `/api/runs/${encodeURIComponent(id)}/hidden`, { hidden });
/** Длина имени запуска от человека — как RUN_NAME_MAX в src/run-name.ts. */
export const RUN_NAME_MAX = 80;
/** Событие окна после переименования запуска (detail — ответ сервера): открытая страница этого запуска берёт новое имя. */
export const RUN_RENAMED = 'agentgraph:run-renamed';
/** PUT /api/runs/:id/title: только у завершённого запуска (идущий — 409); ответ — имя, как его сохранил сервер. */
export async function renameRun(id: string, title: string): Promise<RunRenamed> {
  const v = await api<RunRenamed>('PUT', `/api/runs/${encodeURIComponent(id)}/title`, { title });
  window.dispatchEvent(new CustomEvent<RunRenamed>(RUN_RENAMED, { detail: v }));
  return v;
}

/**
 * Переименование для InlineRename (шапка запуска; строка сайдбара — когда её подключат): новое имя — сразу в список
 * запусков; главная, лента и страницы пространств перечитываются. Опрос списка, начатый до правки, снимаем: он вернул бы
 * старое имя. Другие вкладки обновят списки по событию title общего потока /api/events (его шлёт сервер).
 */
export function useRenameRun(): (id: string, title: string) => Promise<void> {
  const qc = useQueryClient();
  return async (id, title) => {
    const v = await renameRun(id, title);
    await qc.cancelQueries({ queryKey: keys.runs, exact: true });
    qc.setQueryData<RunSummary[]>(keys.runs, (list) => list?.map((x) => (x.id === v.id ? { ...x, title: v.title } : x)));
    for (const queryKey of [keys.runs, keys.home, keys.feed, keys.spaces]) void qc.invalidateQueries({ queryKey });
  };
}

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
