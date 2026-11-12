// Доска спринта (spec §8.7, макет Main.dc.html): колонки по статусам, фильтры, полоска спринта, значки работы агента,
// подпись «ждёт PAY-12». Чистая логика без React и DOM; типы — контракт API (src/api-types.ts, раздел Teamwork).
import type { TeamMember, TeamPr, TeamSprint, TeamTask, TeamTaskMove, TeamTaskStatus, TeamTaskType, TeamTaskWork } from '@server/api-types';
import { plural, t } from '../i18n';
import { statusLabel } from '../format';
import { byRank, rankForDrop } from './rank';

export const STATUSES: readonly TeamTaskStatus[] = ['todo', 'in_progress', 'review', 'done'];
export const TASK_TYPES: readonly TeamTaskType[] = ['feature', 'bug', 'chore'];

/** Подписи статусов на карточках и в списках; названия колонок доски команда задаёт сама (teamwork.yaml → columns). */
export const STATUS_LABEL: Record<TeamTaskStatus, string> = { todo: 'к работе', in_progress: 'в работе', review: 'ревью', done: 'готово' };
export const statusText = (s: TeamTaskStatus): string => t(STATUS_LABEL[s]);

export const activeSprint = (sprints: readonly TeamSprint[]): TeamSprint | undefined => sprints.find((s) => s.status === 'active');

/** Задачи спринта по рангу; при равном ранге — по id. */
export const sprintTasks = (tasks: readonly TeamTask[], sprint: number): TeamTask[] => byRank(tasks.filter((x) => x.sprint === sprint));

export type BoardColumns = Record<TeamTaskStatus, TeamTask[]>;

const emptyColumns = (): BoardColumns => ({ todo: [], in_progress: [], review: [], done: [] });

/** Четыре колонки доски из задач активного спринта. Нечитаемые задачи (error) остаются в своей колонке карточкой «не читается». */
export function boardColumns(tasks: readonly TeamTask[], sprint: number): BoardColumns {
  const cols = emptyColumns();
  for (const x of sprintTasks(tasks, sprint)) (cols[x.status] ?? cols.todo).push(x);
  return cols;
}

export const taskIndex = (tasks: readonly TeamTask[]): Map<string, TeamTask> => new Map(tasks.map((x) => [x.id, x]));

// ---------- фильтры

/** Кто: все, мои, без исполнителя или участник по email. Хранится в localStorage как JSON. */
export type BoardWho = 'all' | 'me' | 'none' | { email: string };
export type BoardFilter = { who: BoardWho; types: TeamTaskType[] };

export const DEFAULT_FILTER: BoardFilter = { who: 'all', types: [] };

export const sameWho = (a: BoardWho, b: BoardWho): boolean => (typeof a === 'string' || typeof b === 'string' ? a === b : a.email === b.email);

export function matchesFilter(task: TeamTask, f: BoardFilter, me?: string): boolean {
  if (f.types.length && !f.types.includes(task.type)) return false;
  const who = f.who;
  if (who === 'all') return true;
  if (who === 'me') return Boolean(me) && task.assignee === me;
  if (who === 'none') return !task.assignee;
  return task.assignee === who.email;
}

export const filterTasks = (tasks: readonly TeamTask[], f: BoardFilter, me?: string): TeamTask[] => tasks.filter((x) => matchesFilter(x, f, me));

export const filterColumns = (cols: BoardColumns, f: BoardFilter, me?: string): BoardColumns => ({
  todo: filterTasks(cols.todo, f, me), in_progress: filterTasks(cols.in_progress, f, me), review: filterTasks(cols.review, f, me), done: filterTasks(cols.done, f, me),
});

/** Тип включается и выключается; пустой список — все типы. */
export const toggleType = (f: BoardFilter, type: TeamTaskType): BoardFilter => ({
  ...f, types: f.types.includes(type) ? f.types.filter((x) => x !== type) : [...f.types, type],
});

/** Разбор сохранённого фильтра: чужой формат — фильтр по умолчанию. */
export function parseFilter(raw: unknown): BoardFilter {
  if (!raw || typeof raw !== 'object') return DEFAULT_FILTER;
  const o = raw as { who?: unknown; types?: unknown };
  const who: BoardWho =
    o.who === 'me' || o.who === 'none' || o.who === 'all' ? o.who
    : o.who && typeof o.who === 'object' && typeof (o.who as { email?: unknown }).email === 'string' ? { email: (o.who as { email: string }).email }
    : 'all';
  const types = Array.isArray(o.types) ? (o.types.filter((x) => (TASK_TYPES as readonly unknown[]).includes(x)) as TeamTaskType[]) : [];
  return { who, types };
}

/** Имя участника коротко: первое слово имени, без имени — часть email до @. */
export const memberLabel = (m: Pick<TeamMember, 'name' | 'email'>): string => (m.name.trim().split(/\s+/)[0] || m.email.split('@')[0]) ?? m.email;

/** Инициалы для кружка: «Алексей Колодин» → «АК», без имени — две буквы email. */
export function initials(m: Pick<TeamMember, 'name' | 'email'> | string | undefined): string {
  if (!m) return '';
  const name = typeof m === 'string' ? '' : m.name.trim();
  const email = typeof m === 'string' ? m : m.email;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (email.split('@')[0] ?? '').slice(0, 2).toUpperCase();
}

/** Участник по email без учёта регистра: в teamwork.yaml email в нижнем регистре, у коммитов — как в git config. */
export const memberByEmail = (members: readonly TeamMember[], email: string | undefined): TeamMember | undefined =>
  email ? members.find((m) => m.email.toLowerCase() === email.toLowerCase()) : undefined;

export type AssigneeChip = { who: BoardWho; label: string; count: number };

/**
 * Чипсы «Кто» со счётчиками по задачам спринта: «Все», «Мои» (если известен мой email), участники с задачами
 * (в порядке teamwork.yaml, незнакомые email — после), «Без исполнителя», если такие есть.
 */
export function assigneeChips(tasks: readonly TeamTask[], members: readonly TeamMember[], me?: string): AssigneeChip[] {
  const counts = new Map<string, number>();
  let none = 0;
  for (const x of tasks) {
    if (x.assignee) counts.set(x.assignee, (counts.get(x.assignee) ?? 0) + 1);
    else none++;
  }
  const chips: AssigneeChip[] = [{ who: 'all', label: t('Все'), count: tasks.length }];
  if (me) chips.push({ who: 'me', label: t('Мои'), count: counts.get(me) ?? 0 });
  const seen = new Set<string>(me ? [me] : []);
  for (const m of members) {
    if (seen.has(m.email) || !counts.get(m.email)) continue;
    seen.add(m.email);
    chips.push({ who: { email: m.email }, label: memberLabel(m), count: counts.get(m.email)! });
  }
  for (const [email, count] of counts) {
    if (seen.has(email)) continue;
    chips.push({ who: { email }, label: memberLabel({ name: '', email }), count });
  }
  if (none) chips.push({ who: 'none', label: t('Без исполнителя'), count: none });
  return chips;
}

// ---------- полоска спринта

/** Порядок ячеек полоски: готово → ревью → в работе → к работе. */
export const STRIP_ORDER: readonly TeamTaskStatus[] = ['done', 'review', 'in_progress', 'todo'];

export type SprintStrip = {
  cells: TeamTaskStatus[];
  counts: Record<TeamTaskStatus, number>;
  total: number;
  done: number;
  /** «12 задач: 2 готово, 2 на ревью, 5 в работе, 3 к работе» — для aria-label. */
  label: string;
  /** «2 из 12 готово». */
  progress: string;
};

export const tasksWord = (n: number): string => `${n} ${plural(n, 'задача', 'задачи', 'задач')}`;

export function sprintStrip(tasks: readonly TeamTask[]): SprintStrip {
  const counts: Record<TeamTaskStatus, number> = { todo: 0, in_progress: 0, review: 0, done: 0 };
  for (const x of tasks) counts[x.status in counts ? x.status : 'todo']++;
  const cells = STRIP_ORDER.flatMap((s) => Array<TeamTaskStatus>(counts[s]).fill(s));
  const parts = [
    t('{n} готово', { n: counts.done }), t('{n} на ревью', { n: counts.review }), t('{n} в работе', { n: counts.in_progress }), t('{n} к работе', { n: counts.todo }),
  ];
  return {
    cells, counts, total: tasks.length, done: counts.done,
    label: tasks.length ? `${tasksWord(tasks.length)}: ${parts.join(', ')}` : t('задач нет'),
    progress: t('{done} из {total} готово', { done: counts.done, total: tasks.length }),
  };
}

// ---------- работа агента по задаче (local.json → work)

export type WorkState = 'working' | 'waiting' | 'failed' | 'done';

const WAITING = new Set(['waiting', 'paused']);
const WORKING = new Set(['running', 'starting', 'working', 'pending']);
const DONE = new Set(['done', 'ended']);

/** Состояние запуска или сессии по статусу: без статуса — только что начато, то есть работает. */
export function workState(w: Pick<TeamTaskWork, 'status'>): WorkState {
  const s = w.status ?? '';
  if (!s || WORKING.has(s)) return 'working';
  if (WAITING.has(s)) return 'waiting';
  if (DONE.has(s)) return 'done';
  return 'failed';
}

/** Последняя запись работы по времени. */
export function latestWork(task: Pick<TeamTask, 'work'>): TeamTaskWork | undefined {
  let best: TeamTaskWork | undefined;
  for (const w of task.work ?? []) if (!best || w.at > best.at) best = w;
  return best;
}

/** Живое состояние задачи: ждёт человека, если ждёт хоть один запуск; иначе работает, если работает хоть один. */
export function taskWorkState(task: Pick<TeamTask, 'work'>): WorkState | undefined {
  const states = (task.work ?? []).map(workState);
  if (states.includes('waiting')) return 'waiting';
  if (states.includes('working')) return 'working';
  const last = latestWork(task);
  return last ? workState(last) : undefined;
}

/** Счётчики над доской: «агент работает · 2», «ждёт тебя · 1» — по задачам, а не по запускам. */
export function workSignals(tasks: readonly TeamTask[]): { working: number; waiting: number } {
  let working = 0;
  let waiting = 0;
  for (const x of tasks) {
    const s = taskWorkState(x);
    if (s === 'waiting') waiting++;
    else if (s === 'working') working++;
  }
  return { working, waiting };
}

export const signalsText = (s: { working: number; waiting: number }): string[] =>
  [s.working ? t('агент работает · {n}', { n: s.working }) : '', s.waiting ? t('ждёт тебя · {n}', { n: s.waiting }) : ''].filter(Boolean);

export type WorkBadge = { state: WorkState; text: string; work: TeamTaskWork };

/** Значок работы на карточке: ждёт ответа, идёт запуск или сессия, запуск не дошёл до конца. Готовое не показывается. */
export function workBadge(task: Pick<TeamTask, 'work'>): WorkBadge | undefined {
  const items = task.work ?? [];
  const pick = (st: WorkState) => items.filter((w) => workState(w) === st).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const w = pick('waiting') ?? pick('working') ?? pick('failed');
  if (!w) return undefined;
  const state = workState(w);
  const title = w.title ?? (w.kind === 'session' ? t('сессия Claude Code') : t('запуск'));
  const text =
    state === 'waiting' ? `${t('ждёт ответа')} · ${title}`
    : state === 'working' ? (w.kind === 'session' ? `${t('сессия Claude Code')} · ${t('работает')}` : `${t('идёт запуск')} · ${title}`)
    : t('запуск остановлен: {why}', { why: statusLabel(w.status ?? '') });
  return { state, text, work: w };
}

// ---------- зависимости и PR на карточке

/** Предшественники, которые ещё не в «Готово». Неизвестный номер (задачу удалили) не блокирует. */
export function openBlockers(task: Pick<TeamTask, 'blockedBy'>, byId: Map<string, Pick<TeamTask, 'status'>>): string[] {
  return task.blockedBy.filter((id) => {
    const b = byId.get(id);
    return Boolean(b) && b!.status !== 'done';
  });
}

/** «ждёт PAY-12», «ждёт PAY-11, PAY-12»; пусто — ничего не ждёт. */
export const blockedLabel = (ids: readonly string[]): string => (ids.length ? t('ждёт {ids}', { ids: ids.join(', ') }) : '');

/** Задачи, которые ждут эту: для панели «Блокирует». */
export const blocking = (task: Pick<TeamTask, 'id'>, tasks: readonly TeamTask[]): TeamTask[] => tasks.filter((x) => x.blockedBy.includes(task.id));

/** «PR #41 открыт», «MR !7 смёржен»; номер — из ссылки GitHub или GitLab. */
export function prLabel(pr: TeamPr): string {
  const gh = pr.url.match(/\/pull\/(\d+)/);
  const gl = pr.url.match(/\/merge_requests\/(\d+)/);
  const name = gh ? `PR #${gh[1]}` : gl ? `MR !${gl[1]}` : 'PR';
  const state = pr.state === 'open' ? t('открыт') : pr.state === 'merged' ? t('смёржен') : t('закрыт');
  return `${name} ${state}`;
}

/** Критерии приёмки коротко: «2/5»; критериев нет — пусто. */
export const acceptanceText = (task: Pick<TeamTask, 'acceptance'>): string => (task.acceptance.total ? `${task.acceptance.done}/${task.acceptance.total}` : '');

// ---------- перенос

export type Drop = { move: TeamTaskMove; rank: string };

/**
 * Перенос задачи на позицию index в колонку (список без самой задачи, по рангу): соседи для сервера (before/after)
 * и ранг для мгновенной перерисовки. status и sprint передаются, когда меняются.
 */
export function dropMove(column: readonly Pick<TeamTask, 'id' | 'rank'>[], index: number, change: Pick<TeamTaskMove, 'status' | 'sprint'> = {}): Drop {
  const at = Math.max(0, Math.min(index, column.length));
  const prev = column[at - 1];
  const next = column[at];
  const move: TeamTaskMove = { ...change };
  if (prev) move.after = prev.id;
  if (next) move.before = next.id;
  return { move, rank: rankForDrop(column.map((x) => x.rank), at) };
}

/** Список без задачи: для dropMove при переносе внутри той же колонки. */
export const without = <T extends { id: string }>(list: readonly T[], id: string): T[] => list.filter((x) => x.id !== id);

/** Куда задача уедет по клавиатуре: ⌥↑ / ⌥↓ внутри колонки; за краем — undefined. */
export function keyboardMove(column: readonly Pick<TeamTask, 'id' | 'rank'>[], id: string, dir: -1 | 1): Drop | undefined {
  const i = column.findIndex((x) => x.id === id);
  if (i < 0) return undefined;
  const to = i + dir;
  if (to < 0 || to >= column.length) return undefined;
  return dropMove(without(column, id), to, {});
}

/** «Спринт не запущен» и подсказка, когда активного спринта нет. */
export const noSprintText = (planned?: TeamSprint): { title: string; hint: string } => ({
  title: t('Спринт не запущен'),
  hint: planned ? t('В бэклоге запланирован «{title}»: запустите его, и задачи появятся здесь', { title: planned.title }) : t('Соберите задачи в бэклоге и запустите спринт'),
});
