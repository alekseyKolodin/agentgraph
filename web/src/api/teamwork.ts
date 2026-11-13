// Запросы Teamwork (/api/teams*, spec §12, отчёт волны 1 docs/teamwork/notes/wave1-core.md): команды, проекты, документы,
// задачи, спринты, комментарии, история, конфликты, локальные настройки и flow команды. Все ключи React Query лежат под
// ['teams']: событие `team` общего потока (useHomeEvents) сбрасывает их разом — в клоне команды что-то поменялось.
// Ошибки — ApiError со status и code (409: not_empty, is_team, conflict, unpushed, busy, readonly, repo_state, rewritten,
// running). conflict — только «успели изменить» (с data.current); остальное показывается текстом сервера.
import { useQuery } from '@tanstack/react-query';
import type {
  TeamColumns, TeamComment, TeamConflict, TeamDetail, TeamDoc, TeamDocName, TeamFlow, TeamHistoryItem, TeamLocal, TeamMember, TeamMine, TeamProject, TeamProjectBrief,
  TeamProjectStatus, TeamRemoteCheck, TeamRepoInfo, TeamSprint, TeamSummary, TeamSync, TeamTask, TeamTaskMove, TeamTaskPatch, TeamTaskType,
} from '@server/api-types';
import type { FlowSpec } from '@server/schema';
import { mineWorkLive } from '../lib/teamwork/mine';
import { api } from './client';

const enc = encodeURIComponent;
const base = (team: string) => `/api/teams/${enc(team)}`;
const projectBase = (team: string, project: string) => `${base(team)}/projects/${enc(project)}`;
/** Имя документа в адресе: `docs/<файл>` — слэш остаётся, сегменты кодируются. */
const docPath = (name: TeamDocName) => name.split('/').map(enc).join('/');

/** Ключи запросов: всё под ['teams'], чтобы событие `team` сбрасывало кэш одним invalidateQueries. */
export const teamKeys = {
  all: ['teams'] as const,
  list: ['teams', 'list'] as const,
  mine: ['teams', 'mine'] as const,
  team: (team: string) => ['teams', 'one', team] as const,
  local: (team: string) => ['teams', 'one', team, 'local'] as const,
  conflicts: (team: string) => ['teams', 'one', team, 'conflicts'] as const,
  flow: (team: string, name: string) => ['teams', 'one', team, 'flows', name] as const,
  projects: (team: string) => ['teams', 'one', team, 'projects'] as const,
  project: (team: string, project: string) => ['teams', 'one', team, 'project', project] as const,
  doc: (team: string, project: string, name: string) => ['teams', 'one', team, 'project', project, 'docs', name] as const,
  history: (team: string, project: string, doc?: string, limit?: number) => ['teams', 'one', team, 'project', project, 'history', doc ?? '', limit ?? 0] as const,
  tasks: (team: string, project: string) => ['teams', 'one', team, 'project', project, 'tasks'] as const,
  comments: (team: string, project: string, id: string) => ['teams', 'one', team, 'project', project, 'tasks', id, 'comments'] as const,
  sprints: (team: string, project: string) => ['teams', 'one', team, 'project', project, 'sprints'] as const,
};

// ---------- команды

export const fetchTeams = () => api<TeamSummary[]>('GET', '/api/teams');
/** Мои задачи активных спринтов во всех командах — блок «Мои задачи» на главной (spec §11), одним запросом. */
export const fetchTeamMine = () => api<TeamMine>('GET', '/api/teams/mine');
export const fetchTeam = (team: string) => api<TeamDetail>('GET', base(team));
/** Проверка ссылки перед созданием или подключением: пустой репо, уже команда, не пустой или ошибка. */
export const checkTeamRemote = (url: string) => api<TeamRemoteCheck>('POST', '/api/teams/check', { url });
/** Создать команду на пустом репо; 409 is_team — там уже команда (в теле data.check), not_empty — есть чужие коммиты. */
export const createTeam = (body: { url: string; title: string; prefix: string }) => api<TeamDetail>('POST', '/api/teams', body);
/** Подключиться по ссылке; addMe (по умолчанию true) добавляет меня в участники отдельным коммитом. */
export const joinTeam = (body: { url: string; addMe?: boolean }) => api<TeamDetail>('POST', '/api/teams/join', body);
export type TeamPatch = { title?: string; columns?: Partial<TeamColumns>; members?: TeamMember[]; defaultFlow?: string | null };
export const updateTeam = (team: string, patch: TeamPatch) => api<TeamDetail>('PUT', base(team), patch);
/** «Добавить меня»: я по git config клона — в участники отдельным коммитом; список не перезаписывается, уже участник — без коммита. */
export const addTeamMe = (team: string) => api<TeamDetail>('POST', `${base(team)}/members/me`);
/**
 * Отключить команду (удалить клон). Без force при неотправленных коммитах или нерешённых конфликтах с моей версией — 409
 * unpushed с { unpushed, commits, conflicts } в data.
 */
export const removeTeam = (team: string, force = false) => api<{ ok: true }>('DELETE', `${base(team)}${force ? '?force=true' : ''}`);
/** Синхронизировать сейчас: pull и push; ошибка сети — в поле error ответа, не исключением. */
export const syncTeam = (team: string) => api<TeamSync>('POST', `${base(team)}/sync`);

export const fetchTeamLocal = (team: string) => api<TeamLocal>('GET', `${base(team)}/local`);
/** Мои папки репо кода (ссылка → папка) и привязанные пространства (проект → слаг); null снимает ключ. */
export const updateTeamLocal = (team: string, patch: { repoPaths?: Record<string, string | null>; projectSpaces?: Record<string, string | null> }) =>
  api<TeamLocal>('PUT', `${base(team)}/local`, patch);

export const fetchTeamConflicts = (team: string) => api<TeamConflict[]>('GET', `${base(team)}/conflicts`);
/** «Оставить версию команды»: запись конфликта снимается. Отвечает оставшимися. */
export const keepTheirs = (team: string, id: string) => api<TeamConflict[]>('DELETE', `${base(team)}/conflicts/${enc(id)}`);
/** «Взять мою»: моё значение записывается коммитом (для kind: 'sprint' — 400). Отвечает оставшимися. */
export const keepMine = (team: string, id: string) => api<TeamConflict[]>('POST', `${base(team)}/conflicts/${enc(id)}/mine`);

export type TeamFlowView = TeamFlow<FlowSpec>;
export const fetchTeamFlow = (team: string, name: string) => api<TeamFlowView>('GET', `${base(team)}/flows/${enc(name)}`);
/** Flow команды как YAML; невалидный по схеме — 400. */
export const saveTeamFlow = (team: string, name: string, yaml: string) => api<TeamFlowView>('PUT', `${base(team)}/flows/${enc(name)}`, { yaml });

// ---------- проекты и документы

/** Репо кода в create/update проекта: key, url, defaultBranch — в project.yaml; local — моя папка, только в local.json. */
export type ProjectRepoBody = { key: string; url: string; defaultBranch?: string; local?: string };
export type NewProject = { slug: string; title: string; summary?: string; repos?: ProjectRepoBody[] };
export const fetchProjects = (team: string) => api<TeamProjectBrief[]>('GET', `${base(team)}/projects`);
export const createProject = (team: string, body: NewProject) => api<TeamProject>('POST', `${base(team)}/projects`, body);
export const fetchProject = (team: string, project: string) => api<TeamProject>('GET', projectBase(team, project));
export type ProjectPatch = { title?: string; summary?: string; status?: TeamProjectStatus; repos?: ProjectRepoBody[] };
export const updateProject = (team: string, project: string, patch: ProjectPatch) => api<TeamProject>('PUT', projectBase(team, project), patch);
/** Что git знает о моей папке репо кода: корень, origin, ветка по умолчанию, ключ из имени папки; problem — not_git, no_origin, bad_origin. */
export const fetchRepoInfo = (team: string, path: string) => api<TeamRepoInfo>('POST', `${base(team)}/repo-info`, { path });

export const fetchDoc = (team: string, project: string, name: TeamDocName) => api<TeamDoc>('GET', `${projectBase(team, project)}/docs/${docPath(name)}`);
/**
 * Документ целиком ({ text, base }; новый docs/<имя>.md — без base) или один раздел ({ text — раздел со строкой «## »,
 * section, hash, message }). 409 conflict — раздел или файл менялись, текущая версия в data.current.
 */
export type DocWrite = { text: string; base?: string } | { text: string; section: string; hash?: string; message?: string };
export const saveDoc = (team: string, project: string, name: TeamDocName, body: DocWrite) => api<TeamDoc>('PUT', `${projectBase(team, project)}/docs/${docPath(name)}`, body);

/** Лента проекта по git log; doc — история одного документа. */
export const fetchHistory = (team: string, project: string, o: { doc?: TeamDocName; limit?: number } = {}) =>
  api<TeamHistoryItem[]>('GET', `${projectBase(team, project)}/history${qs({ doc: o.doc, limit: o.limit })}`);

// ---------- задачи, комментарии, спринты

/** Новая задача: описание и критерии собираются в тело, либо body целиком; dependsOn — ключи пачки или номера существующих. */
export type NewTask = {
  key?: string;
  title: string;
  type?: TeamTaskType;
  description?: string;
  acceptance?: string[];
  body?: string;
  estimate?: number;
  repo?: string;
  assignee?: string;
  sprint?: number;
  covers?: string[];
  dependsOn?: string[];
  blockedBy?: string[];
  after?: string;
  before?: string;
};
export const fetchTasks = (team: string, project: string) => api<TeamTask[]>('GET', `${projectBase(team, project)}/tasks`);
export const fetchTask = (team: string, project: string, id: string) => api<TeamTask>('GET', `${projectBase(team, project)}/tasks/${enc(id)}`);
export const createTask = (team: string, project: string, task: NewTask) => api<TeamTask>('POST', `${projectBase(team, project)}/tasks`, task);
/** Пачка одним коммитом (принятие разбивки). */
export const createTasks = (team: string, project: string, tasks: NewTask[]) => api<{ tasks: TeamTask[] }>('POST', `${projectBase(team, project)}/tasks`, { tasks });
/** Только изменённые поля; base — хэш задачи на момент правки, 409 conflict с data.current, если её успели поменять. */
export const updateTask = (team: string, project: string, id: string, patch: TeamTaskPatch) => api<TeamTask>('PATCH', `${projectBase(team, project)}/tasks/${enc(id)}`, patch);
export const deleteTask = (team: string, project: string, id: string) => api<{ ok: true }>('DELETE', `${projectBase(team, project)}/tasks/${enc(id)}`);
/** Статус, спринт и место между соседями одной операцией: after — после кого встать, before — перед кем. */
export const moveTask = (team: string, project: string, id: string, move: TeamTaskMove) => api<TeamTask>('POST', `${projectBase(team, project)}/tasks/${enc(id)}/move`, move);
export const fetchComments = (team: string, project: string, id: string) => api<TeamComment[]>('GET', `${projectBase(team, project)}/tasks/${enc(id)}/comments`);
export const addComment = (team: string, project: string, id: string, text: string) => api<TeamComment>('POST', `${projectBase(team, project)}/tasks/${enc(id)}/comments`, { text });

export type NewSprint = { title?: string; goal?: string; start?: boolean; tasks?: string[] };
export const fetchSprints = (team: string, project: string) => api<TeamSprint[]>('GET', `${projectBase(team, project)}/sprints`);
/** Запланировать спринт (start: true — сразу запустить); 409 busy — запланированный или активный уже есть. */
export const createSprint = (team: string, project: string, body: NewSprint) => api<TeamSprint>('POST', `${projectBase(team, project)}/sprints`, body);
export const startSprint = (team: string, project: string, n: number, body: { title?: string; goal?: string; tasks?: string[] } = {}) =>
  api<TeamSprint>('POST', `${projectBase(team, project)}/sprints/${n}/start`, body);
/** Завершить: next — задачи в следующий спринт, остальные незавершённые — в бэклог. */
export const closeSprint = (team: string, project: string, n: number, body: { next?: string[] } = {}) =>
  api<TeamSprint>('POST', `${projectBase(team, project)}/sprints/${n}/close`, body);

// ---------- хуки

/**
 * Как часто перечитывать команду: об отправке (через 3 секунды после записи) и о новой ошибке сети сервер сообщает событием
 * `team`, поэтому, пока есть неотправленное, опрос — лишь запасной на случай потерянного события, раз в 15 секунд; иначе раз
 * в 30 секунд, как фоновый pull сервера (spec §7.3), чтобы строка «синхронизировано N с назад» не отставала.
 */
const SYNC_POLL_MS = 15_000;
const IDLE_POLL_MS = 30_000;
const pollBySync = (sync: TeamSync | undefined): number => (sync && (sync.state === 'pushing' || sync.state === 'pending') ? SYNC_POLL_MS : IDLE_POLL_MS);

/** GET /api/teams: список команд со строкой синхронизации — экран «Teamwork» и «Мои задачи» главной. */
export function useTeams(enabled = true) {
  return useQuery({
    queryKey: teamKeys.list, queryFn: fetchTeams, enabled,
    refetchInterval: (q) => Math.min(...(q.state.data ?? []).map((x) => pollBySync(x.sync)), IDLE_POLL_MS),
  });
}

/**
 * GET /api/teams/mine для главной. Событие `team` сбрасывает и его (ключ под ['teams']); пока по моей задаче идёт запуск
 * или сессия, раз в 30 с — переход «идёт → ждёт ответа» события `team` не даёт.
 */
export function useTeamMine(enabled = true) {
  return useQuery({
    queryKey: teamKeys.mine, queryFn: fetchTeamMine, enabled,
    refetchInterval: (q) => (mineWorkLive(q.state.data) ? IDLE_POLL_MS : false),
  });
}

/** GET /api/teams/:t: команда с участниками, проектами кратко, синхронизацией и «кто я». Открытие экрана тянет фоновый pull. */
export function useTeam(team: string | undefined) {
  return useQuery({
    queryKey: teamKeys.team(team ?? ''), queryFn: () => fetchTeam(team!), enabled: Boolean(team),
    refetchInterval: (q) => pollBySync(q.state.data?.sync),
  });
}

export function useTeamLocal(team: string | undefined) {
  return useQuery({ queryKey: teamKeys.local(team ?? ''), queryFn: () => fetchTeamLocal(team!), enabled: Boolean(team) });
}

/** Нерешённые конфликты синхронизации; enabled — пока sync.conflicts > 0 или открыт диалог. */
export function useTeamConflicts(team: string | undefined, enabled = true) {
  return useQuery({ queryKey: teamKeys.conflicts(team ?? ''), queryFn: () => fetchTeamConflicts(team!), enabled: Boolean(team) && enabled });
}

export function useTeamFlow(team: string | undefined, name: string | undefined) {
  return useQuery({ queryKey: teamKeys.flow(team ?? '', name ?? ''), queryFn: () => fetchTeamFlow(team!, name!), enabled: Boolean(team && name) });
}

export function useProjects(team: string | undefined) {
  return useQuery({ queryKey: teamKeys.projects(team ?? ''), queryFn: () => fetchProjects(team!), enabled: Boolean(team) });
}

export function useProject(team: string | undefined, project: string | undefined) {
  return useQuery({ queryKey: teamKeys.project(team ?? '', project ?? ''), queryFn: () => fetchProject(team!, project!), enabled: Boolean(team && project) });
}

export function useDoc(team: string | undefined, project: string | undefined, name: TeamDocName | undefined) {
  return useQuery({ queryKey: teamKeys.doc(team ?? '', project ?? '', name ?? ''), queryFn: () => fetchDoc(team!, project!, name!), enabled: Boolean(team && project && name) });
}

export function useHistory(team: string | undefined, project: string | undefined, o: { doc?: TeamDocName; limit?: number } = {}) {
  return useQuery({ queryKey: teamKeys.history(team ?? '', project ?? '', o.doc, o.limit), queryFn: () => fetchHistory(team!, project!, o), enabled: Boolean(team && project) });
}

export function useTasks(team: string | undefined, project: string | undefined) {
  return useQuery({ queryKey: teamKeys.tasks(team ?? '', project ?? ''), queryFn: () => fetchTasks(team!, project!), enabled: Boolean(team && project) });
}

export function useComments(team: string | undefined, project: string | undefined, id: string | undefined) {
  return useQuery({ queryKey: teamKeys.comments(team ?? '', project ?? '', id ?? ''), queryFn: () => fetchComments(team!, project!, id!), enabled: Boolean(team && project && id) });
}

export function useSprints(team: string | undefined, project: string | undefined) {
  return useQuery({ queryKey: teamKeys.sprints(team ?? '', project ?? ''), queryFn: () => fetchSprints(team!, project!), enabled: Boolean(team && project) });
}

/** Строка запроса из непустых значений. */
function qs(params: Record<string, string | number | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}
