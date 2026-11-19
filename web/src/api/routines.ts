// Запросы раздела «Рутины» (docs/routines/SPEC.md §3): обзор со списком, источниками, видами, ожиданиями и «догнать»,
// рутина, журнал, проверка на истории, источники, подключение словами и рецепты. Изменения на сервере приходят событием
// `routines` общего потока /api/events (useHomeEvents): оно снимает все ключи под routineKeys.all.
import { useQuery } from '@tanstack/react-query';
import type {
  ConnectorBuildView, DraftView, Feedback, FlowTemplate, HistoryCheck, LogAsk, LogEntry, LogExplain, LogOutcome, LogRecheck, McpServicesView, RoutineSpec, RoutineView, RoutineWait, RoutinesOverview, SourceKindView, SourceSpec, SourceTestResult, SourceView, WaitAction,
} from '@server/routines/types';
import type { Recipe } from '@server/routines/kind';
import type { ProfileResponse } from '@server/api-types';
import { api } from './client';
import { t } from '../lib/i18n';

const enc = encodeURIComponent;
const BASE = '/api/routines';

/** Рецепт без пути к файлу: его сервер наружу не отдаёт. */
export type RecipeView = Omit<Recipe, 'file'>;

export const routineKeys = {
  all: ['routines'] as const,
  overview: ['routines', 'overview'] as const,
  one: (slug: string) => ['routines', 'one', slug] as const,
  log: (slug: string, outcomes: string) => ['routines', 'log', slug, outcomes] as const,
  recipes: ['routines', 'recipes'] as const,
  draft: (id: string) => ['routines', 'draft', id] as const,
  mcp: ['routines', 'mcp-tools'] as const,
  build: (id: string) => ['routines', 'connector-build', id] as const,
};

/** Тексты видов источников приходят с сервера по-русски: переводим на границе API (словарь i18n/en/kinds.ts). */
const trKind = (k: SourceKindView): SourceKindView => ({
  ...k,
  title: t(k.title),
  summary: t(k.summary),
  setup: k.setup.map((f) => ({ ...f, label: t(f.label), ...(f.placeholder ? { placeholder: t(f.placeholder) } : {}), ...(f.hint ? { hint: t(f.hint) } : {}) })),
  match: k.match.map((m) => ({ ...m, label: t(m.label) })),
});
export const fetchOverview = async () => {
  const o = await api<RoutinesOverview>('GET', BASE);
  return { ...o, kinds: o.kinds.map(trKind) };
};
export const fetchRoutine = (slug: string) => api<RoutineView>('GET', `${BASE}/${enc(slug)}`);
/** spec или yaml (YAML вручную); ошибка схемы — 400 с problems в теле (ApiError.data). */
export const saveRoutine = (slug: string, body: { spec: RoutineSpec } | { yaml: string }) => api<RoutineView>('PUT', `${BASE}/${enc(slug)}`, body);
export const deleteRoutine = (slug: string) => api<{ ok: true }>('DELETE', `${BASE}/${enc(slug)}`);
export const setRoutineEnabled = (slug: string, enabled: boolean) => api<RoutineView>('POST', `${BASE}/${enc(slug)}/enabled`, { enabled });
/** «Проверить на истории»: можно для несохранённого spec. */
/** Почему сработала строка журнала; recheck — проверка словами на этом событии заново (check — исправленное «Если» до сохранения). */
export const explainLog = (slug: string, id: string) => api<LogExplain>('GET', `${BASE}/${enc(slug)}/log/${enc(id)}/explain`);
/** Стартовый запрос сессии «Спросить Claude» по строке журнала; сессию создаёт createSession. */
export const askLog = (slug: string, id: string, question: string) => api<LogAsk>('POST', `${BASE}/${enc(slug)}/log/${enc(id)}/ask`, { question });
export const recheckLog = (slug: string, id: string, check: string) => api<LogRecheck>('POST', `${BASE}/${enc(slug)}/log/${enc(id)}/recheck`, { check });
export const checkHistory = (slug: string, spec?: RoutineSpec, limit?: number) => api<HistoryCheck>('POST', `${BASE}/${enc(slug)}/history`, { ...(spec ? { spec } : {}), ...(limit ? { limit } : {}) });
/** Готовый flow шаблона рутины (templates/flows) у пользователя: нет — сервер копирует его в flows/Мои дела. */
export const ensureTemplateFlow = (name: string) => api<{ flow: string; copied: boolean }>('POST', `${BASE}/flow-templates/${enc(name)}`, {});
/** Готовые flow шаблонов: описание карточки flow, которого у пользователя ещё нет. */
export const useFlowTemplates = () => useQuery({ queryKey: ['routine-flow-templates'], queryFn: () => api<FlowTemplate[]>('GET', `${BASE}/flow-templates`), staleTime: 10 * 60_000, retry: false });
/** Профиль «кто я» (GET /api/settings/profile) — шаблону встреч: какие пункты мои. */
export const useProfile = (on: boolean) => useQuery({ queryKey: ['settings-profile'], queryFn: () => api<ProfileResponse>('GET', '/api/settings/profile'), enabled: on, staleTime: 5 * 60_000, retry: false });
/** Ручной запуск: по событию журнала или (расписание) сейчас. */
export const runRoutine = (slug: string, eventId?: string) => api<{ runId?: string; wait?: RoutineWait }>('POST', `${BASE}/${enc(slug)}/run`, eventId ? { eventId } : {});
export const fetchLog = (slug: string, outcomes?: LogOutcome[], limit = 200) =>
  api<LogEntry[]>('GET', `${BASE}/${enc(slug)}/log?${new URLSearchParams({ ...(outcomes?.length ? { outcome: outcomes.join(',') } : {}), limit: String(limit) })}`);
/** Обратная связь на событие: «Надо было запустить» / «Зря запустилась» / «Не повтор»; «Учесть» в проверке на истории — verdict = прошлый ответ. */
export const sendFeedback = (slug: string, eventId: string, verdict: Feedback['verdict']) => api<{ ok: true }>('POST', `${BASE}/${enc(slug)}/feedback`, { eventId, verdict });
/** keepalive — отправка при закрытии вкладки: запрос не обрывается вместе со страницей. */
export const answerWait = (id: string, action: WaitAction, keepalive = false) => api<{ ok: true; runId?: string }>('POST', `${BASE}/waits/${enc(id)}`, action, undefined, keepalive);
export const answerCatchUp = (id: string, action: 'run' | 'skip') => api<{ ok: true }>('POST', `${BASE}/catchup/${enc(id)}`, { action });

export const fetchSources = () => api<SourceView[]>('GET', `${BASE}/sources`);
export const saveSource = (slug: string, spec: SourceSpec, secrets?: Record<string, string>) => api<SourceView>('PUT', `${BASE}/sources/${enc(slug)}`, { spec, ...(secrets && Object.keys(secrets).length ? { secrets } : {}) });
/** 409 — источник используют рутины. */
export const deleteSource = (slug: string) => api<{ ok: true }>('DELETE', `${BASE}/sources/${enc(slug)}`);
export const testSource = (spec: SourceSpec, secrets?: Record<string, string>) => api<SourceTestResult>('POST', `${BASE}/sources/test`, { spec, ...(secrets && Object.keys(secrets).length ? { secrets } : {}) });

export const startDraft = (description: string) => api<DraftView>('POST', `${BASE}/sources/draft`, { description });
export const fetchDraft = (id: string) => api<DraftView>('GET', `${BASE}/sources/draft/${enc(id)}`);
export const draftSecret = (id: string, name: string, value: string) => api<DraftView>('POST', `${BASE}/sources/draft/${enc(id)}/secret`, { name, value });
export const refineDraft = (id: string, note: string) => api<DraftView>('POST', `${BASE}/sources/draft/${enc(id)}/refine`, { note });
export const cancelDraft = (id: string) => api<{ ok: true }>('DELETE', `${BASE}/sources/draft/${enc(id)}`);

export const fetchRecipes = async () => (await api<RecipeView[]>('GET', `${BASE}/recipes`)).map((r) => ({ ...r, summary: t(r.summary) }));
export const importRecipe = (yaml: string) => api<RecipeView>('POST', `${BASE}/recipes/import`, { yaml });

/** GET /api/routines: список, источники, виды, ожидания и «догнать» — для списка, создания, редактора и главной. */
export function useRoutines(enabled = true) {
  return useQuery({ queryKey: routineKeys.overview, queryFn: fetchOverview, enabled });
}

export function useRoutine(slug: string | undefined) {
  return useQuery({ queryKey: routineKeys.one(slug ?? ''), queryFn: () => fetchRoutine(slug!), enabled: Boolean(slug) });
}

/** Журнал целиком (до 200 строк): фильтры-чипы считаются на месте, без запроса на каждый. */
export function useRoutineLog(slug: string | undefined) {
  return useQuery({ queryKey: routineKeys.log(slug ?? '', ''), queryFn: () => fetchLog(slug!), enabled: Boolean(slug) });
}

export function useRecipes(enabled = true) {
  return useQuery({ queryKey: routineKeys.recipes, queryFn: fetchRecipes, enabled, staleTime: 60_000 });
}

/** Сервисы MCP для «Сервис через Claude»: сервер поднимает Claude Code без модели (несколько секунд) и держит список 5 минут. */
export const fetchMcpTools = (force = false) => api<McpServicesView>('GET', `${BASE}/mcp-tools${force ? '?force=1' : ''}`);
export function useMcpTools(enabled = true) {
  return useQuery({ queryKey: routineKeys.mcp, queryFn: () => fetchMcpTools(false), enabled, staleTime: 5 * 60_000 });
}

/** Сборка скрипта «Сервиса через Claude»: модель один раз, потом прогон без модели. note и from — поправка прошлой сборки. */
export const startConnectorBuild = (body: { tools: string[]; request: string; title?: string; note?: string; from?: string }) => api<ConnectorBuildView>('POST', `${BASE}/sources/connector-build`, body);
export function useConnectorBuild(id: string | null) {
  return useQuery({
    queryKey: routineKeys.build(id ?? ''),
    queryFn: () => api<ConnectorBuildView>('GET', `${BASE}/sources/connector-build/${enc(id!)}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.state === 'working' ? 1500 : false),
  });
}

/** Черновик подключения словами: пока агент работает, опрос раз в 1.5 с. */
export function useDraft(id: string | null) {
  return useQuery({
    queryKey: routineKeys.draft(id ?? ''),
    queryFn: () => fetchDraft(id!),
    enabled: Boolean(id),
    refetchInterval: (q) => (q.state.data?.state === 'working' ? 1500 : false),
  });
}
