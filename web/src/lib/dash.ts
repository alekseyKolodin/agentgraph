// «Задачи и код» и «MR · нужно внимание» на главной (ui/dash.js, ui/attention.js): связанные запуски и выбор flow. Без React и DOM.
import type { FlowListItem, RunSummary } from '@server/api-types';

/** Сколько строк списка видно сразу; остальные — по «Ещё N». */
export const DASH_SHOWN = 5;
/** Данные главной старше — подтягиваются при возврате на главную. */
export const DASH_STALE_MS = 5 * 60 * 1000;
/** Связанных запусков у строки — не больше. */
const RELATED_MAX = 6;

export const PRESET_LABEL = { sprint: 'Мой спринт', mine: 'Все мои', jql: 'Своя JQL' } as const;
export type JiraPreset = keyof typeof PRESET_LABEL;

/** Первые DASH_SHOWN строк, или все, если раскрыли «Ещё». */
export const dashCap = <T>(arr: T[], all: boolean): T[] => (all ? arr : arr.slice(0, DASH_SHOWN));
/** Сколько строк спрятано за «Ещё N»; 0 — кнопки нет. */
export const dashMore = (arr: unknown[], all: boolean): number => (!all && arr.length > DASH_SHOWN ? arr.length - DASH_SHOWN : 0);

/** Знак номера по ref: PR GitHub (owner/repo#N) — «#», MR GitLab (group/project!N) — «!». */
export const mrSign = (ref: string): '#' | '!' => (/#\d+$/.test(ref) ? '#' : '!');

/** Запуски из задачи Jira. */
export const runsForJira = (runs: RunSummary[], key: string): RunSummary[] =>
  runs.filter((r) => r.source?.type === 'jira' && r.source.key === key).slice(0, RELATED_MAX);

/** Запуски из MR, ветки или в worktree на этой ветке. */
export const runsForBranch = (runs: RunSummary[], project: string, branch: string, mrRef?: string): RunSummary[] =>
  runs
    .filter(
      (r) =>
        (mrRef && r.source?.type === 'mr' && r.source.key === mrRef)
        || (r.source?.type === 'branch' && r.source.key === branch && r.source.project === project)
        || (r.worktree?.branch === branch && (!r.source?.project || r.source.project === project)),
    )
    .slice(0, RELATED_MAX);

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
