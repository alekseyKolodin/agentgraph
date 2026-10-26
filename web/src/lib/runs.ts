// Список запусков в сайдбаре без React и DOM (ui/app.js renderRunList, runFilterHtml): скрытые, фильтр по статусу, поиск,
// группы по проектам с «ещё N» и живыми счётчиками, подписи строк.
import type { RunSummary } from '@server/api-types';
import { baseName, projectLabels, usd, when } from './format';
import { t } from './i18n';
import { LIVE_STATUSES } from './home';
import { iterWord } from './graph/text';
import { runMatches, searchWords } from './search';

/** Порядок чипов фильтра: сначала то, что требует внимания. */
export const STATUS_ORDER = ['waiting', 'running', 'paused', 'done', 'max_iterations', 'failed', 'budget_exceeded', 'interrupted', 'aborted'];
export const RUNS_FLAT_LIMIT = 40;
export const RUNS_GROUP_LIMIT = 10;

export const projKey = (cwd: string | undefined): string => 'proj:' + (cwd || '');

/** Скрывать и удалять можно только закончившийся запуск; оборвавшийся тоже закончился. live — у строк /api/home. */
export const runManageable = (r: RunSummary & { live?: boolean }, can: boolean): boolean => can && !r.live && !LIVE_STATUSES.includes(r.status);

export type RunListOpts = {
  activeId: string | null;
  showHidden: boolean;
  statuses: Set<string>;
  query: string;
};

export type StatusChip = { status: string; count: number; on: boolean };

export type RunGroup = {
  key: string;
  cwd: string;
  label: string;
  title: string;
  count: number;
  live: { waiting: number; paused: number; running: number };
  /** Видимые строки (первые 10, все — если раскрыт хвост или открытый запуск дальше 10). */
  runs: RunSummary[];
  more: number;
};

export type RunListView = {
  /** Чипы фильтра; пусто — ряда нет. */
  chips: StatusChip[];
  /** Строки после фильтра и поиска (плоский список — первые 40). */
  runs: RunSummary[];
  groups: RunGroup[];
  searching: boolean;
  hiddenCount: number;
  /** Почему пусто: «запусков ещё не было», «Ничего не нашлось»…; '' — есть что показать. */
  empty: string;
};

const countBy = (runs: RunSummary[]) => {
  const m = new Map<string, number>();
  for (const r of runs) m.set(r.status, (m.get(r.status) ?? 0) + 1);
  return m;
};

/**
 * Чипы фильтра: статусы, что есть в списке (с числом запусков), плюс выбранные, даже если таких запусков сейчас нет, —
 * иначе выбор было бы не снять. Набор — по всем видимым запускам, числа — по counted (при поиске — только найденные).
 */
export function statusChips(runs: RunSummary[], counted: RunSummary[], selected: Set<string>): StatusChip[] {
  const counts = countBy(counted);
  const statuses = [...new Set([...runs.map((r) => r.status), ...selected])]
    .sort((a, b) => (STATUS_ORDER.indexOf(a) + 1 || 99) - (STATUS_ORDER.indexOf(b) + 1 || 99));
  if (statuses.length < 2 && !selected.size) return [];
  return statuses.map((s) => ({ status: s, count: counts.get(s) ?? 0, on: selected.has(s) }));
}

/** Всё, что рисует список: фильтр и поиск — до лимитов «ещё N», иначе подходящие запуски за первыми 40 не покажутся. */
export function runListView(all: RunSummary[], o: RunListOpts, grouped: boolean, showAll: Set<string>): RunListView {
  const hiddenCount = all.filter((r) => r.hidden).length;
  // открытый скрытый запуск остаётся в списке, чтобы было видно, где ты
  const visible = o.showHidden ? all : all.filter((r) => !r.hidden || r.id === o.activeId);
  const words = searchWords(o.query);
  const searching = words.length > 0;
  const runs = visible.filter((r) => r.id === o.activeId || ((!o.statuses.size || o.statuses.has(r.status)) && (!searching || runMatches(r, words))));
  const chips = statusChips(visible, searching ? visible.filter((r) => runMatches(r, words)) : visible, o.statuses);
  const empty = runs.length ? '' : !visible.length ? (hiddenCount ? t('все запуски скрыты') : t('запусков ещё не было')) : searching ? t('Ничего не нашлось') : t('нет запусков с таким статусом');
  if (!grouped) return { chips, runs: runs.slice(0, RUNS_FLAT_LIMIT), groups: [], searching, hiddenCount, empty };
  // запуски отсортированы от новых, поэтому и проекты идут по свежести последнего запуска
  const byProject = new Map<string, RunSummary[]>();
  for (const r of runs) {
    const k = r.cwd || '';
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k)!.push(r);
  }
  const labels = projectLabels([...byProject.keys()]);
  const groups = [...byProject].map(([cwd, list]): RunGroup => {
    const key = projKey(cwd);
    const activeIdx = list.findIndex((r) => r.id === o.activeId);
    const shown = showAll.has(key) || activeIdx >= RUNS_GROUP_LIMIT ? list : list.slice(0, RUNS_GROUP_LIMIT);
    const n = (s: string) => list.filter((r) => r.status === s).length;
    return {
      key,
      cwd,
      label: labels.get(cwd)!,
      title: cwd || t('директория проекта не записана в run.json'),
      count: list.length,
      live: { waiting: n('waiting'), paused: n('paused'), running: n('running') },
      runs: shown,
      more: list.length - shown.length,
    };
  });
  return { chips, runs, groups, searching, hiddenCount, empty };
}

/** Подсказка строки: имя запуска и flow; без имени — flow. */
export const runRowTitle = (r: RunSummary): string => (r.title ? `${r.title}\nflow ${r.flow}` : r.flow);

/** Подстрока: flow (если есть имя, первым — чтобы многоточие его не съело), проект (в плоском списке), дата, итерации, цена. */
export const runRowSub = (r: RunSummary, withProject: boolean): { flow: string; rest: string } => ({
  flow: r.title ? r.flow : '',
  rest: `${withProject && r.cwd ? `${baseName(r.cwd)} · ` : ''}${when(r.startedAt)} · ${iterWord(r.iterations)} · ≈${usd(r.totalCostUsd)}`,
});

/** Текст подтверждения удаления: «flow» от даты, если запуск известен. */
export const deleteRunText = (id: string, r: Pick<RunSummary, 'flow' | 'startedAt'> | undefined): string =>
  t('Удалить запуск {what}?', { what: r ? t('«{flow}» от {date}', { flow: r.flow, date: when(r.startedAt) }) : id }) +
  '\n' +
  t('Папка runs/{id} с промптами, транскриптами и выводами этапов будет удалена насовсем.', { id });
