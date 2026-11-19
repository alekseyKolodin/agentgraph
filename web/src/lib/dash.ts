// «Задачи и код» (свой раздел /code) и «MR · нужно внимание» на главной (ui/dash.js, ui/attention.js): связанные запуски
// и выбор flow. Без React и DOM.
import type { FlowListItem, IntegrationsInfo, JiraIssueBrief, MergeRequestView, ProjectInfo, RunSummary, SessionView, Thing } from '@server/api-types';
import { branchKey, jiraKey, mrKey, normHost } from '../../../src/things/keys';
import { t } from './i18n';

/** Сколько строк списка видно сразу; остальные — по «Ещё N». */
export const DASH_SHOWN = 5;
/** Данные главной старше — подтягиваются при возврате на главную. */
export const DASH_STALE_MS = 5 * 60 * 1000;
/** Связанных запусков у строки — не больше. */
const RELATED_MAX = 6;

export const PRESET_LABEL = { sprint: t('Мой спринт'), mine: t('Все мои'), jql: t('Своя JQL') };
export type JiraPreset = keyof typeof PRESET_LABEL;

/** Первые DASH_SHOWN строк, или все, если раскрыли «Ещё». */
export const dashCap = <T>(arr: T[], all: boolean): T[] => (all ? arr : arr.slice(0, DASH_SHOWN));
/** Сколько строк спрятано за «Ещё N»; 0 — кнопки нет. */
export const dashMore = (arr: unknown[], all: boolean): number => (!all && arr.length > DASH_SHOWN ? arr.length - DASH_SHOWN : 0);

/** Подключено хоть что-то: Jira с токеном или хотя бы один проект (добавленный или из директорий запусков). */
export const hasConnections = (info: Pick<IntegrationsInfo, 'jira' | 'projects'>): boolean => Boolean(info.jira?.hasToken) || info.projects.length > 0;

/** Знак номера по ref: PR GitHub (owner/repo#N) — «#», MR GitLab (group/project!N) — «!». */
export const mrSign = (ref: string): '#' | '!' => (/#\d+$/.test(ref) ? '#' : '!');

// Ключи вещей — через src/things/keys.ts (общий с сервером модуль без Node, разрешён в web/vite.config.ts): регистр пути,
// www. и порт по умолчанию — как у ключей, которые пишет сервер.

/** Хост ссылки (с портом, если он не по умолчанию); не адрес — ''. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Ключ, а не исключение: keys.ts бросает на битых частях. */
const keyOr = (f: () => string): string | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

/** Вещь задачи Jira: jira:<host>/<KEY>; хост — из ссылки задачи. Ссылка или ключ не разобрались — undefined. */
export function jiraThing(i: Pick<JiraIssueBrief, 'key' | 'url' | 'title'>): Thing | undefined {
  const host = hostOf(i.url);
  const issue = i.key.trim().toUpperCase();
  const key = host ? keyOr(() => jiraKey(host, issue)) : undefined;
  return key ? { type: 'jira', key, ref: { host: normHost(host), key: issue }, url: i.url, title: i.title } : undefined;
}

/** Ключ вещи ветки проекта: branch:<корень репозитория>#<ветка>; пустая или битая — undefined. Дело о ветке находят по нему. */
export const branchThingKey = (projectPath: string, branch: string): string | undefined => keyOr(() => branchKey(projectPath, branch));

/**
 * Вещь MR/PR проекта: mr:<host>/<путь проекта>/<номер>. Хост — из адреса MR, как у сервера (адрес origin бывает ssh-алиасом),
 * нет адреса — из origin; у проекта без origin — undefined.
 */
export function mrThing(p: Pick<ProjectInfo, 'remote' | 'forge'>, m: Pick<MergeRequestView, 'iid' | 'url' | 'title' | 'sourceBranch'>): Thing | undefined {
  if (!p.remote) return undefined;
  const host = hostOf(m.url) || p.remote.host;
  const project = p.remote.path.replace(/^\/+|\/+$/g, '');
  const key = keyOr(() => mrKey(host, project, m.iid));
  if (!key) return undefined;
  return {
    type: 'mr',
    key,
    ref: { host: normHost(host), project, number: m.iid, branch: m.sourceBranch, ...(p.forge ? { forge: p.forge } : {}) },
    url: m.url,
    title: m.title,
  };
}

/** Запуск о вещи с этим ключом: запуск рутины по событию MR/задачи помнит вещь в source.thing. */
const aboutThing = (r: RunSummary, thingKey?: string): boolean => Boolean(thingKey) && r.source?.thing?.key === thingKey;

/** Запуски из задачи Jira: формой из «Кода» (source jira) или рутиной по этой задаче (вещь). */
export const runsForJira = (runs: RunSummary[], key: string, thingKey?: string): RunSummary[] =>
  runs.filter((r) => (r.source?.type === 'jira' && r.source.key === key) || aboutThing(r, thingKey)).slice(0, RELATED_MAX);

/** Запуски из MR, ветки, в worktree на этой ветке или рутиной по этому MR (вещь). */
export const runsForBranch = (runs: RunSummary[], project: string, branch: string, mrRef?: string, thingKey?: string): RunSummary[] =>
  runs
    .filter(
      (r) =>
        (mrRef && r.source?.type === 'mr' && r.source.key === mrRef)
        || aboutThing(r, thingKey)
        || (r.source?.type === 'branch' && r.source.key === branch && r.source.project === project)
        || (r.worktree?.branch === branch && (!r.source?.project || r.source.project === project)),
    )
    .slice(0, RELATED_MAX);

/** Сессии, начатые из этой вещи («Начать сессию»): свежие сверху. */
export const sessionsForThing = (sessions: SessionView[], thingKey: string | undefined): SessionView[] =>
  !thingKey ? [] : sessions.filter((s) => s.source?.thing?.key === thingKey).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, RELATED_MAX);

/**
 * Папка сессии из задачи Jira: у задачи нет репозитория, поэтому — папка прошлой работы по ней (сессия из этой задачи,
 * запуск по ней: основной checkout, а не worktree), иначе единственный проект «Подключений», иначе папка по умолчанию.
 */
export function jiraSessionCwd(o: { sessions: SessionView[]; runs: RunSummary[]; projects: Pick<ProjectInfo, 'path'>[]; fallback: string }): string {
  const s = o.sessions[0];
  if (s) return s.cwd;
  const r = o.runs.find((x) => x.project || x.source?.project || x.cwd);
  if (r) return r.project || r.source?.project || r.cwd || o.fallback;
  const only = o.projects.length === 1 ? o.projects[0] : undefined;
  return only?.path ?? o.fallback;
}

/** Первое сообщение сессии из вещи: просьба сверху, под ней — вход /api/intake (ключ, ссылка, текст в source-data). */
export const thingSessionPrompt = (intake: string): string =>
  ['Начинаем работу по этой задаче. Разберись в ней и предложи, с чего начать; ничего не меняй, пока я не скажу.', intake.trim()].join('\n\n');

/** Имя сессии из вещи: «PAY-7 Падает оплата», «!12 Фикс». */
export const thingSessionName = (label: string, title: string | undefined): string => [label, title].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

/** Список выбора flow для «Запустить…»: только рабочие flow, по фильтру; последний запущенный — первым. */
export function pickerFlows(flows: FlowListItem[], query: string, recent: string | null): FlowListItem[] {
  const q = query.trim().toLowerCase();
  return flows
    .filter((f) => f.valid && (!q || f.name.includes(q) || (f.folder || '').toLowerCase().includes(q) || (f.description || '').toLowerCase().includes(q)))
    .sort(
      (a, b) =>
        Number(b.name === recent) - Number(a.name === recent)
        || (a.folder || '').localeCompare(b.folder || '', 'ru')
        || a.name.localeCompare(b.name),
    );
}

/** Положение выпадашки выбора flow у кнопки: правым краем к кнопке, ниже неё, а если не влезает — выше. */
export function pickerPosition(
  btn: { top: number; bottom: number; right: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.max(8, Math.min(btn.right - size.width, view.width - size.width - 8));
  const below = btn.bottom + 4;
  const top = below + size.height > view.height ? Math.max(8, btn.top - size.height - 4) : below;
  return { left, top };
}
