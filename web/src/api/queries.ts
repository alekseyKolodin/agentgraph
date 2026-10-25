// Запросы к API для экранов: ключи React Query и типы ответов из src/api-types.ts.
import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AttentionResult, BranchView, ConfigResponse, FeedResponse, FlowListItem, HomeResponse, IntegrationsInfo, Intake, JiraIssueBrief, Limits,
  MergeRequestView, RunSource, RunSummary, Suggestion,
} from '@server/api-types';
import { api } from './client';

export const keys = {
  config: ['config'] as const,
  limits: ['limits'] as const,
  home: ['home'] as const,
  runs: ['runs'] as const,
  feed: ['feed'] as const,
  flows: ['flows'] as const,
  /** GET /api/tags: страница «Теги», подсказки тегов формы запуска и конструктора. */
  tags: ['tags'] as const,
  integrations: ['integrations'] as const,
  jira: (preset: string, jql: string) => ['jira', preset, jql] as const,
  mrs: (path: string, mine: boolean) => ['project', path, 'mr', mine] as const,
  branches: (path: string) => ['project', path, 'branches'] as const,
  attention: ['attention'] as const,
  suggest: (refs: string[]) => ['attention', 'suggest', ...refs] as const,
};

/** GET /api/config: читается один раз на загрузку страницы — сервер за время жизни вкладки не меняется. */
export function useConfig() {
  return useQuery({ queryKey: keys.config, queryFn: () => api<ConfigResponse>('GET', '/api/config'), staleTime: Infinity });
}

/** Умеет ли сервер фичу. UI бывает новее сервера: чего сервер не умеет, то не показываем. Пока конфига нет — false. */
export function useFeature(feature: string): boolean {
  return useConfig().data?.features.includes(feature) ?? false;
}

/** GET /api/limits; force — мимо минутного кэша сервера. */
export const fetchLimits = (force = false) => api<Limits>('GET', `/api/limits${force ? '?force=1' : ''}`);

/**
 * GET /api/home: идущие запуски с открытыми вопросами. Ошибка — сервер запущен до появления главной («Главная заработает
 * после перезапуска…»); прошлые данные React Query оставляет, как и старый UI.
 */
export function useHome() {
  return useQuery({ queryKey: keys.home, queryFn: () => api<HomeResponse>('GET', '/api/home') });
}

/** Пока не открыт поток запуска, список запусков обновляется раз в 10 секунд (ui/app.js init: `if (!state.es)`). */
const RUNS_POLL_MS = 10_000;

// открыт ли поток /api/runs/:id/events: его ставит страница запуска, пока подписана
let runStream = false;
const runStreamSubs = new Set<() => void>();

export function setRunStreamOpen(open: boolean): void {
  if (open === runStream) return;
  runStream = open;
  runStreamSubs.forEach((f) => f());
}

const useRunStreamOpen = () =>
  useSyncExternalStore((f) => {
    runStreamSubs.add(f);
    return () => runStreamSubs.delete(f);
  }, () => runStream);

/** GET /api/runs: список запусков в сайдбаре, связанные запуски на главной и «Сейчас», если /api/home не отвечает. */
export function useRuns() {
  const streaming = useRunStreamOpen();
  return useQuery({ queryKey: keys.runs, queryFn: () => api<RunSummary[]>('GET', '/api/runs'), refetchInterval: streaming ? false : RUNS_POLL_MS });
}

/** GET /api/feed: лента событий главной. */
export function useFeed(enabled: boolean) {
  return useQuery({ queryKey: keys.feed, queryFn: () => api<FeedResponse>('GET', '/api/feed'), enabled });
}

/** GET /api/flows: список flow (выбор flow для «Запустить…»). */
export function useFlows() {
  return useQuery({ queryKey: keys.flows, queryFn: () => api<FlowListItem[]>('GET', '/api/flows') });
}

export const fetchIntegrations = () => api<IntegrationsInfo>('GET', '/api/integrations');

export const fetchJiraIssues = (preset: string, jql: string) =>
  api<{ jql: string; issues: JiraIssueBrief[] }>('GET', `/api/jira/issues?${preset === 'jql' ? `preset=jql&jql=${encodeURIComponent(jql.trim())}` : `preset=${preset}`}`);

export const fetchMrs = (path: string, mine: boolean) =>
  api<{ mrs: MergeRequestView[] }>('GET', `/api/projects/mrs?path=${encodeURIComponent(path)}${mine ? '&mine=1' : ''}`);

export const fetchBranches = (path: string) => api<{ branches: BranchView[] }>('GET', `/api/projects/branches?path=${encodeURIComponent(path)}`);

export const fetchAttention = (force: boolean) => api<AttentionResult>('GET', `/api/attention${force ? '?force=1' : ''}`);

export const fetchSuggestions = (refs: string[]) =>
  api<{ suggestions?: Record<string, Suggestion> }>('POST', '/api/attention/suggest', { refs });

/** Источник «Запустить…»: задача, MR или ветка; attention — MR из «нужно внимание», вход соберётся с причинами. */
export type IntakeTarget = { type: RunSource['type']; key: string; project?: string; attention?: true };

export const postIntake = (flow: string, target: IntakeTarget) => api<Intake>('POST', '/api/intake', { flow, ...target });
