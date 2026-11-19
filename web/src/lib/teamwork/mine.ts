// «Мои задачи» на главной (spec §11, docs/desk/SPEC.md 4.3): задачи из ответа GET /api/teams/mine — все мои незакрытые,
// в спринтах и в бэклоге, — а колонка, «почему» и «новое» — из дел (GET /api/desk): задача Teamwork и дело — одно и то же,
// их отдаёт поставщик дел src/desk/providers/teamwork.ts. Плюс значок работы агента и адрес его запуска или сессии. Без
// React и DOM: адрес задачи (/teamwork/<t>/<p>/board?task=ID) собирает экран из shell.ts.
import type { DeskColumn, DeskItem } from '@server/desk/types';
import type { TeamMine, TeamMineProject, TeamMineTeam, TeamTask, TeamTaskStatus, TeamTaskWork } from '@server/api-types';
import { workBadge, workState, type WorkBadge } from './board';

export type MyTaskRow = {
  /** Уникален во всех командах: номер задачи сквозной только внутри команды. */
  key: string;
  team: TeamMineTeam;
  project: TeamMineProject;
  task: TeamTask;
  /** Предшественники не в «Готово». */
  waiting: string[];
  /** Ждёт ответа, идёт или не дошёл до конца — мой запуск или сессия по задаче (TeamTask.work). */
  badge?: WorkBadge;
  /** Дело этой задачи на доске (поставщик Teamwork); дел ещё нет (запрос не пришёл) — строка без него. */
  item?: DeskItem;
};

/** Колонка дела, пока дела нет: так же, как её считает поставщик (без «Нового» — он знает, что я видел). */
const COLUMN_OF: Record<TeamTaskStatus, DeskColumn> = { todo: 'plan', in_progress: 'work', review: 'waiting', done: 'done' };
/** Порядок на главной: «Новое», потом то, что в работе, ждёт других и в плане. */
const ORDER: Record<DeskColumn, number> = { new: 0, work: 1, waiting: 2, plan: 3, done: 4 };
const BADGE_ORDER = { waiting: 0, failed: 1, working: 2, done: 3 } as const;

/** Дело задачи Teamwork по вещи (thing.ref), а не по строке ключа: ключ кодирует части — его собирает сервер. */
const taskOf = (i: DeskItem): string | undefined => {
  const r = i.thing?.type === 'teamwork' ? i.thing.ref : undefined;
  return r && typeof r.team === 'string' && typeof r.project === 'string' && typeof r.id === 'string' ? `${r.team}/${r.project}/${r.id}` : undefined;
};

/** Колонка строки: из дела, без него — из статуса. */
export const rowColumn = (r: Pick<MyTaskRow, 'task' | 'waiting' | 'item'>): DeskColumn =>
  r.item?.column ?? (r.task.status === 'todo' && r.waiting.length ? 'waiting' : COLUMN_OF[r.task.status]);

/**
 * Строки блока: незавершённые задачи, первыми — где агент ждёт ответа или запуск не дошёл до конца, дальше по колонке
 * дела («Новое», «В работе», «Ждёт других», «В плане»), внутри — как пришли (команда, проект, ранг). done — сколько моих
 * задач активного спринта уже в «Готово»: их не показываем, только число. items — дела доски (любые: берутся задачи Teamwork).
 */
export function myTaskRows(mine: TeamMine, items?: readonly DeskItem[]): { rows: MyTaskRow[]; done: number } {
  const teams = new Map(mine.teams.map((x) => [x.slug, x]));
  const projects = new Map(mine.projects.map((x) => [`${x.team}/${x.slug}`, x]));
  const desk = new Map((items ?? []).flatMap((i) => {
    const k = taskOf(i);
    return k ? [[k, i] as const] : [];
  }));
  let done = 0;
  const rows: (MyTaskRow & { i: number })[] = [];
  mine.tasks.forEach((x, i) => {
    const team = teams.get(x.team);
    const project = projects.get(`${x.team}/${x.project}`);
    if (!team || !project) return;
    if (x.task.status === 'done') {
      done++;
      return;
    }
    const badge = workBadge(x.task);
    const item = desk.get(`${x.team}/${x.project}/${x.task.id}`);
    rows.push({ key: `${x.team}/${x.task.id}`, team, project, task: x.task, waiting: x.waiting, ...(badge ? { badge } : {}), ...(item ? { item } : {}), i });
  });
  const urgency = (r: MyTaskRow) => (r.badge && r.badge.state !== 'working' ? BADGE_ORDER[r.badge.state] : 2);
  rows.sort((a, b) => urgency(a) - urgency(b) || ORDER[rowColumn(a)] - ORDER[rowColumn(b)] || a.i - b.i);
  return { rows: rows.map(({ i: _i, ...r }) => r), done };
}

/** Где задача: команда · проект · спринт («бэклог» — без спринта; не активный спринт — номером). */
export function rowWhere(r: Pick<MyTaskRow, 'team' | 'project' | 'task'>, backlog: string, sprintN: (n: number) => string): string {
  const s = r.task.sprint;
  const sprint = s === undefined ? backlog : r.project.sprint?.number === s ? r.project.sprint.title : sprintN(s);
  return `${r.team.title} · ${r.project.title} · ${sprint}`;
}

/**
 * Идёт или ждёт ответа хоть один мой запуск или сессия по задаче — пока да, главная перечитывает «Мои задачи» по таймеру.
 * Записи work в local.json не чистятся, поэтому закончившиеся и упавшие не в счёт.
 */
export const mineWorkLive = (mine: TeamMine | undefined): boolean =>
  (mine?.tasks ?? []).some((x) => (x.task.work ?? []).some((w) => {
    const s = workState(w);
    return s === 'working' || s === 'waiting';
  }));

/** Есть ли команды, где git не знает мой email: задачи там не найти, на главной — подсказка. */
export const unknownMe = (mine: TeamMine): TeamMineTeam[] => mine.teams.filter((x) => !x.me && !x.error);

/** Адрес запуска или сессии по задаче. */
export const workHref = (w: Pick<TeamTaskWork, 'kind' | 'id'>): string => (w.kind === 'run' ? `/run/${encodeURIComponent(w.id)}` : `/sessions/${encodeURIComponent(w.id)}`);

/** «В работу ▸» на строке: задача ещё не на ревью, агент по ней сейчас не работает и не ждёт, репо команды не только для чтения (как на доске). */
export const canSendToWork = (r: Pick<MyTaskRow, 'task' | 'badge'> & { team?: Pick<TeamMineTeam, 'readonly'> }): boolean =>
  !r.team?.readonly && !r.task.error && (r.task.status === 'todo' || r.task.status === 'in_progress') && !(r.badge && r.badge.state !== 'failed');
