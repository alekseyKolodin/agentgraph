// Список запусков в сайдбаре без React и DOM (ui/app.js renderRunList, runFilterHtml): скрытые, фильтр по статусу и по
// происхождению (вручную / от рутины), «готовое старше N дней» и работа закрытых дел — с глаз, поиск, группы по проекту
// (пространству — его считает сервер, RunSummary.projectRef) с «ещё N» и живыми счётчиками, подписи строк.
import type { RunSummary } from '@server/api-types';
import { clock, statusLabel, usd, when } from './format';
import { t } from './i18n';
import { LIVE_STATUSES } from './home';
import { iterWord } from './graph/text';
import { runMatches, searchWords } from './search';
import { projectHint, projectKeyOf, projectLabel, projectOrFolder } from './spaces';

/** Порядок чипов фильтра: сначала то, что требует внимания. */
export const STATUS_ORDER = ['waiting', 'running', 'paused', 'done', 'max_iterations', 'failed', 'budget_exceeded', 'interrupted', 'aborted'];
export const RUNS_FLAT_LIMIT = 40;
export const RUNS_GROUP_LIMIT = 10;

/** Ключ свёрнутости группы проекта в fold.ts: proj:<слаг>, proj: — без проекта. */
export const projKey = (r: Pick<RunSummary, 'projectRef'> | undefined): string => 'proj:' + projectKeyOf(r?.projectRef);

/** Скрывать и удалять можно только закончившийся запуск; оборвавшийся тоже закончился. live — у строк /api/home. */
export const runManageable = (r: RunSummary & { live?: boolean }, can: boolean): boolean => can && !r.live && !LIVE_STATUSES.includes(r.status);

/** Откуда запуск: от рутины (source.type routine) или вручную (всё остальное). all — оба. */
export type RunOrigin = 'all' | 'manual' | 'routine';

/** Дней по умолчанию для «скрыть готовое старше N дней»; 0 — не скрывать. */
export const RUNS_OLD_DAYS = 7;
/** Выбор N в настройке списка. */
export const RUNS_OLD_CHOICES = [1, 3, 7, 14, 30];

/** Сохранённое «откуда запуск» — только из известных; мусор в localStorage — «все». */
export const runOrigin = (v: unknown): RunOrigin => (v === 'manual' || v === 'routine' ? v : 'all');
/** Сохранённое N — только из выбора (или 0 — не убирать); иначе — по умолчанию. */
export const runsOldDays = (v: unknown): number => (v === 0 || RUNS_OLD_CHOICES.includes(v as number) ? (v as number) : RUNS_OLD_DAYS);

export const isRoutineRun = (r: Pick<RunSummary, 'source'>): boolean => r.source?.type === 'routine';

/** Закончился и старше days дней (по концу, без конца — по началу): такой уходит с глаз. Идущие и ждущие — никогда. */
export function runIsOld(r: Pick<RunSummary, 'status' | 'startedAt' | 'finishedAt'>, days: number, now: number): boolean {
  if (days <= 0 || LIVE_STATUSES.includes(r.status)) return false;
  const at = Date.parse(r.finishedAt || r.startedAt);
  return Number.isFinite(at) && now - at > days * 86_400_000;
}

export type RunListOpts = {
  activeId: string | null;
  showHidden: boolean;
  statuses: Set<string>;
  query: string;
  /** Вручную / от рутины; нет — все. */
  origin?: RunOrigin;
  /** Готовое старше стольких дней уходит с глаз; 0 или нет — не уходит. */
  oldDays?: number;
  /** Показать убранное с глаз: старое готовое и работу закрытых дел. */
  showOld?: boolean;
  /** Запуск закрытого дела (closed-work.ts): уходит с глаз, как старое. */
  closed?: (r: RunSummary) => boolean;
  now?: number;
};

export type StatusChip = { status: string; count: number; on: boolean };

export type RunGroup = {
  key: string;
  /** Слаг пространства проекта; '' — без проекта. */
  space: string;
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
  /** Убрано с глаз (старое готовое и закрытые дела) — без поиска; столько вернёт «показать убранные». */
  oldCount: number;
  /** Сколько запусков от рутин среди видимых: 0 — переключателя «вручную / от рутины» нет. */
  routineCount: number;
  manualCount: number;
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

/**
 * Всё, что рисует список: фильтр и поиск — до лимитов «ещё N», иначе подходящие запуски за первыми 40 не покажутся.
 * Поиск ищет и среди убранного с глаз (старое готовое, закрытые дела): «тот запуск с прошлого месяца» должен найтись.
 */
export function runListView(all: RunSummary[], o: RunListOpts, grouped: boolean, showAll: Set<string>): RunListView {
  const hiddenCount = all.filter((r) => r.hidden).length;
  // открытый скрытый запуск остаётся в списке, чтобы было видно, где ты
  const visible = o.showHidden ? all : all.filter((r) => !r.hidden || r.id === o.activeId);
  const words = searchWords(o.query);
  const searching = words.length > 0;
  const now = o.now ?? Date.now();
  // закрытое дело не прячет идущий и ждущий запуск: он ещё требует внимания
  const away = (r: RunSummary) => r.id !== o.activeId && (runIsOld(r, o.oldDays ?? 0, now) || (Boolean(o.closed?.(r)) && !LIVE_STATUSES.includes(r.status)));
  const origin = o.origin ?? 'all';
  // дочерний запуск блока-вызова source не получает: откуда он — по корню цепочки вызовов
  const byId = new Map(all.map((r) => [r.id, r]));
  const fromRoutine = (r: RunSummary) => {
    let top = r;
    for (let d = 0, p = r.parent && byId.get(r.parent.runId); p && d < 10; p = p.parent && byId.get(p.parent.runId), d++) top = p;
    return isRoutineRun(top);
  };
  const byOrigin = (r: RunSummary) => origin === 'all' || (origin === 'routine') === fromRoutine(r);
  // «убрано N» — столько вернёт «показать» при выбранном происхождении
  const oldCount = visible.filter((r) => away(r) && byOrigin(r)).length;
  // убранное с глаз не показывается и не считается в чипах, пока не попросили или не ищут
  const pool = o.showOld || searching ? visible : visible.filter((r) => !away(r));
  // числа «вручную / от рутин» — по тому, что найдётся при поиске
  const counted = searching ? pool.filter((r) => runMatches(r, words)) : pool;
  const routineCount = counted.filter(fromRoutine).length;
  const manualCount = counted.length - routineCount;
  const scoped = pool.filter((r) => r.id === o.activeId || byOrigin(r));
  const runs = nestRuns(scoped.filter((r) => r.id === o.activeId || ((!o.statuses.size || o.statuses.has(r.status)) && (!searching || runMatches(r, words)))));
  const chips = statusChips(scoped, searching ? scoped.filter((r) => runMatches(r, words)) : scoped, o.statuses);
  const empty = runs.length
    ? ''
    : !visible.length
      ? hiddenCount ? t('все запуски скрыты') : t('запусков ещё не было')
      : searching
        ? t('Ничего не нашлось')
        : !pool.length
          ? t('новых запусков нет: старое готовое убрано с глаз')
          : !scoped.length
            ? origin === 'routine' ? t('запусков от рутин нет') : t('запусков вручную нет')
            : t('нет запусков с таким статусом');
  const counts = { searching, hiddenCount, oldCount, routineCount, manualCount, empty };
  if (!grouped) return { chips, runs: runs.slice(0, RUNS_FLAT_LIMIT), groups: [], ...counts };
  // запуски отсортированы от новых, поэтому и проекты идут по свежести последнего запуска; проект — как у сессий
  const byProject = new Map<string, RunSummary[]>();
  for (const r of runs) {
    const k = projectKeyOf(r.projectRef);
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k)!.push(r);
  }
  const groups = [...byProject].map(([space, list]): RunGroup => {
    const key = projKey(list[0]);
    const activeIdx = list.findIndex((r) => r.id === o.activeId);
    const shown = showAll.has(key) || activeIdx >= RUNS_GROUP_LIMIT ? list : list.slice(0, RUNS_GROUP_LIMIT);
    const n = (s: string) => list.filter((r) => r.status === s).length;
    return {
      key,
      space,
      label: projectLabel(list[0]!.projectRef),
      title: projectHint(list[0]!.projectRef),
      count: list.length,
      live: { waiting: n('waiting'), paused: n('paused'), running: n('running') },
      runs: shown,
      more: list.length - shown.length,
    };
  });
  return { chips, runs, groups, ...counts };
}

/**
 * Дочерние запуски блоков-вызовов — сразу под родителем, в порядке вызова (от старых); вложенные — под своим дочерним.
 * Дочерний без родителя в списке (скрыт фильтром или за лимитом) остаётся на своём месте.
 */
export function nestRuns(runs: RunSummary[]): RunSummary[] {
  const ids = new Set(runs.map((r) => r.id));
  const kids = new Map<string, RunSummary[]>();
  for (const r of runs) {
    if (!r.parent || !ids.has(r.parent.runId)) continue;
    if (!kids.has(r.parent.runId)) kids.set(r.parent.runId, []);
    kids.get(r.parent.runId)!.push(r);
  }
  if (!kids.size) return runs;
  const out: RunSummary[] = [];
  const put = (r: RunSummary) => {
    out.push(r);
    for (const k of [...(kids.get(r.id) ?? [])].reverse()) put(k);
  };
  for (const r of runs) if (!r.parent || !ids.has(r.parent.runId)) put(r);
  return out;
}

/** Глубина строки под родителями из того же списка: 0 — запуск верхнего уровня. */
export function runDepths(runs: RunSummary[]): Map<string, number> {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const depth = new Map<string, number>();
  for (const r of runs) {
    let d = 0;
    for (let p = r.parent && byId.get(r.parent.runId); p && d < 10; p = p.parent && byId.get(p.parent.runId)) d++;
    depth.set(r.id, d);
  }
  return depth;
}

/** Сигнал слова статуса в строке истории — по «Пульту»: идёт, готово, ждёт тебя (вопрос, пауза, лимит), сбой. */
export type StatusTone = 'live' | 'ok' | 'wait' | 'fail' | '';

export function statusTone(status: string): StatusTone {
  if (status === 'running') return 'live';
  if (status === 'done') return 'ok';
  if (['waiting', 'paused', 'max_iterations'].includes(status)) return 'wait';
  if (['failed', 'budget_exceeded', 'aborted', 'interrupted'].includes(status)) return 'fail';
  return '';
}

/**
 * Подсказка строки — всё, что не влезло в две строки: имя и flow, статус, дата целиком, итерации, цена, пространство,
 * теги знаний, папка проекта; у дочернего — откуда вызван.
 */
export const runRowTitle = (r: RunSummary): string =>
  [
    r.title ? `${r.title}\nflow ${r.flow}` : r.flow,
    [statusLabel(r.status), when(r.startedAt), iterWord(r.iterations), `≈${usd(r.totalCostUsd)}`].join(' · '),
    projectLabel(r.projectRef),
    ...(r.space && r.space !== r.projectRef?.space ? [`◇ ${r.space}`] : []),
    ...(r.knowledge?.length ? [r.knowledge.map((k) => `#${k}`).join(' ')] : []),
    ...(r.cwd ? [r.cwd] : []),
    ...(r.parent ? [t('вызван блоком {block} запуска {id}', { block: r.parent.block, id: r.parent.runId })] : []),
  ].join('\n');

/** space — слаг явного пространства (ссылка), spaceText — его подпись: проектом, как у групп и на Главной. */
export type RunRowMeta = { status: string; tone: StatusTone; when: string; space: string; spaceText: string; tail: string };

/**
 * Строка меты под именем (одна, с многоточием): статус словом (у истории пять конечных статусов — точкой их не
 * различить), когда, пространство (ссылкой), затем flow (если у запуска своё имя), проект (в плоском списке), цена,
 * теги знаний и «разовый». Порядок — по важности: хвост съедает многоточие.
 */
export const runRowMeta = (r: RunSummary, withProject: boolean, now: Date = new Date()): RunRowMeta => ({
  status: statusLabel(r.status),
  tone: statusTone(r.status),
  when: clock(r.startedAt, now),
  space: r.space ?? '',
  spaceText: !r.space ? '' : r.projectRef?.space === r.space ? projectLabel(r.projectRef) : `◇ ${r.space}`,
  tail: [
    ...(r.title ? [r.flow] : []),
    // проект без явного пространства (оно ссылкой выше) — подписью проекта, без проекта — папкой
    ...(withProject && !r.space && (r.projectRef?.space || r.cwd) ? [projectOrFolder(r.projectRef, r.cwd)] : []),
    `≈${usd(r.totalCostUsd)}`,
    ...(r.knowledge ?? []).map((k) => `#${k}`),
    ...(r.adhoc ? [t('разовый')] : []),
  ].join(' · '),
});

/** Текст подтверждения удаления: «flow» от даты, если запуск известен. */
export const deleteRunText = (id: string, r: Pick<RunSummary, 'flow' | 'startedAt'> | undefined): string =>
  t('Удалить запуск {what}?', { what: r ? t('«{flow}» от {date}', { flow: r.flow, date: when(r.startedAt) }) : id }) +
  '\n' +
  t('Папка runs/{id} с промптами, транскриптами и выводами этапов будет удалена насовсем.', { id });
