// «Мои задачи» на главной (spec §11): строки из ответа GET /api/teams/mine — порядок, значок работы агента и адрес его
// запуска или сессии. Без React и DOM: адрес задачи (/teamwork/<t>/<p>/board?task=ID) собирает экран из shell.ts.
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
};

/** Порядок на главной: сначала то, что в работе и на ревью, потом «К работе». */
const ORDER: Record<TeamTaskStatus, number> = { in_progress: 0, review: 1, todo: 2, done: 3 };
const BADGE_ORDER = { waiting: 0, failed: 1, working: 2, done: 3 } as const;

/**
 * Строки блока: незавершённые задачи, первыми — где агент ждёт ответа или запуск не дошёл до конца, дальше по статусу
 * («В работе», «Ревью», «К работе»), внутри — как пришли (команда, проект, ранг). done — сколько моих задач спринтов уже
 * в «Готово»: их не показываем, только число.
 */
export function myTaskRows(mine: TeamMine): { rows: MyTaskRow[]; done: number } {
  const teams = new Map(mine.teams.map((x) => [x.slug, x]));
  const projects = new Map(mine.projects.map((x) => [`${x.team}/${x.slug}`, x]));
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
    rows.push({ key: `${x.team}/${x.task.id}`, team, project, task: x.task, waiting: x.waiting, ...(badge ? { badge } : {}), i });
  });
  const urgency = (r: MyTaskRow) => (r.badge && r.badge.state !== 'working' ? BADGE_ORDER[r.badge.state] : 2);
  rows.sort((a, b) => urgency(a) - urgency(b) || ORDER[a.task.status] - ORDER[b.task.status] || a.i - b.i);
  return { rows: rows.map(({ i: _i, ...r }) => r), done };
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
