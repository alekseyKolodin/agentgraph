// Запросы экранов документов, которых нет в api/teamwork.ts (его правит соседняя сессия волны 3): черновики агентов
// (POST/GET …/drafts, …/drafts/:run, …/drafts/:run/accept — docs/teamwork/notes/wave2-drafts.md) и версия документа до и
// после коммита для диффа в «Истории». Ключи — под teamKeys.all (['teams']): событие `team` сбрасывает и их.
import { useQuery } from '@tanstack/react-query';
import type { TeamDocName, TeamDocRevision, TeamDraft, TeamDraftAccept, TeamDraftAccepted, TeamDraftDetail, TeamDraftStart } from '@server/api-types';
import { api } from '../../../api';
import { teamKeys } from '../../../api/teamwork';
import { draftRunning } from '../../../lib/teamwork/doc-view';

const enc = encodeURIComponent;
const projectBase = (team: string, project: string) => `/api/teams/${enc(team)}/projects/${enc(project)}`;

export const draftKeys = {
  list: (team: string, project: string) => [...teamKeys.project(team, project), 'drafts'] as const,
  one: (team: string, project: string, run: string) => [...teamKeys.project(team, project), 'drafts', run] as const,
  revision: (team: string, project: string, doc: string, hash: string) => [...teamKeys.project(team, project), 'revision', doc, hash] as const,
};

export const fetchDrafts = (team: string, project: string) => api<TeamDraft[]>('GET', `${projectBase(team, project)}/drafts`);
export const fetchDraft = (team: string, project: string, run: string) => api<TeamDraftDetail>('GET', `${projectBase(team, project)}/drafts/${enc(run)}`);
/** Запустить черновик: 201 со status 'running'; 400 — нет локальной папки репо кода или раздела. */
export const startDraft = (team: string, project: string, body: TeamDraftStart) => api<TeamDraft>('POST', `${projectBase(team, project)}/drafts`, body);
/** Записать принятые правки: 409 conflict (data.current) — документ менялся; 409 running — черновик ещё идёт. */
export const acceptDraft = (team: string, project: string, run: string, body: TeamDraftAccept) =>
  api<TeamDraftAccepted>('POST', `${projectBase(team, project)}/drafts/${enc(run)}/accept`, body);
export const fetchRevision = (team: string, project: string, doc: TeamDocName, hash: string) =>
  api<TeamDocRevision>('GET', `${projectBase(team, project)}/history/${enc(hash)}?doc=${enc(doc)}`);

/** Пока черновик идёт, список перечитывается раз в 4 секунды: событие `end` запуска до экрана документа не доходит. */
const RUNNING_POLL_MS = 4_000;

export function useDrafts(team: string, project: string, enabled = true) {
  return useQuery({
    queryKey: draftKeys.list(team, project),
    queryFn: () => fetchDrafts(team, project),
    enabled,
    refetchInterval: (q) => ((q.state.data ?? []).some((d) => draftRunning(d.status)) ? RUNNING_POLL_MS : false),
  });
}

export function useDraft(team: string, project: string, run: string | undefined) {
  return useQuery({
    queryKey: draftKeys.one(team, project, run ?? ''),
    queryFn: () => fetchDraft(team, project, run!),
    enabled: Boolean(run),
    refetchInterval: (q) => (q.state.data && draftRunning(q.state.data.status) ? RUNNING_POLL_MS : false),
  });
}

export function useRevision(team: string, project: string, doc: TeamDocName, hash: string | undefined) {
  return useQuery({ queryKey: draftKeys.revision(team, project, doc, hash ?? ''), queryFn: () => fetchRevision(team, project, doc, hash!), enabled: Boolean(hash), staleTime: Infinity });
}
