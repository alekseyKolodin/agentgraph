// Запросы экранов задач Teamwork сверх web/src/api/teamwork.ts (файл оболочки): черновики разбивки (заметка wave2-drafts),
// «В работу ▸» — intake и worktree задачи, сессия по задаче (заметка wave2-work). Ключи — под ['teams'], чтобы событие
// `team` общего потока сбрасывало и их.
import { useQuery } from '@tanstack/react-query';
import type {
  SessionView, TeamDraft, TeamDraftAccepted, TeamDraftDetail, TeamDraftStart, TeamProposedTask, TeamTaskIntake, TeamTaskWorktree,
} from '@server/api-types';
import { api } from '../../../api/client';
import { teamKeys } from '../../../api/teamwork';

const enc = encodeURIComponent;
const projectBase = (team: string, project: string) => `/api/teams/${enc(team)}/projects/${enc(project)}`;

export const taskKeys = {
  drafts: (team: string, project: string) => [...teamKeys.project(team, project), 'drafts'] as const,
  draft: (team: string, project: string, run: string) => [...teamKeys.project(team, project), 'drafts', run] as const,
};

export const fetchDrafts = (team: string, project: string) => api<TeamDraft[]>('GET', `${projectBase(team, project)}/drafts`);
export const fetchDraft = (team: string, project: string, run: string) => api<TeamDraftDetail>('GET', `${projectBase(team, project)}/drafts/${enc(run)}`);
/** Старт черновика: 201 с run; у split — brief (что разбить). */
export const startDraft = (team: string, project: string, body: TeamDraftStart) => api<TeamDraft>('POST', `${projectBase(team, project)}/drafts`, body);
/** Принять разбивку: отмеченные задачи после правок; 400 code: 'dependencies' — data.report с ошибками по ключам. */
export const acceptSplit = (team: string, project: string, run: string, tasks: TeamProposedTask[]) =>
  api<TeamDraftAccepted>('POST', `${projectBase(team, project)}/drafts/${enc(run)}/accept`, { tasks });

/** Черновик идёт: агент ещё пишет артефакты (принятие — 409 busy). */
export const draftRunning = (status: string): boolean => status === 'running' || status === 'waiting' || status === 'paused' || status === 'pending' || status === 'starting';

/** Черновики проекта; пока какой-то идёт — опрос раз в 3 с (событие `end` запуска сюда не доходит). */
export function useDrafts(team: string | undefined, project: string | undefined) {
  return useQuery({
    queryKey: taskKeys.drafts(team ?? '', project ?? ''),
    queryFn: () => fetchDrafts(team!, project!),
    enabled: Boolean(team && project),
    refetchInterval: (q) => ((q.state.data ?? []).some((d) => draftRunning(d.status)) ? 3_000 : false),
  });
}

export function useDraft(team: string | undefined, project: string | undefined, run: string | undefined) {
  return useQuery({ queryKey: taskKeys.draft(team ?? '', project ?? '', run ?? ''), queryFn: () => fetchDraft(team!, project!, run!), enabled: Boolean(team && project && run) });
}

const qs = (params: Record<string, string | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
};

/** Текст задачи и всё для формы запуска; flow — другой flow команды, repo — выбранное репо кода. */
export const fetchIntake = (team: string, project: string, id: string, o: { repo?: string; flow?: string } = {}) =>
  api<TeamTaskIntake>('GET', `${projectBase(team, project)}/tasks/${enc(id)}/intake${qs(o)}`);
/** Worktree репо кода на ветке задачи; 409 no_local — репо нет на этом компьютере. */
export const prepareTaskWorktree = (team: string, project: string, id: string, repo?: string) =>
  api<TeamTaskWorktree>('POST', `${projectBase(team, project)}/tasks/${enc(id)}/worktree`, repo ? { repo } : {});
/** Сессия Claude Code по задаче: тело — workSessionBody (lib/teamwork/task.ts). */
export const startTaskSession = (body: Record<string, unknown>) => api<SessionView>('POST', '/api/sessions', body);
