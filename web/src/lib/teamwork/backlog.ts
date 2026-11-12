// Бэклог (spec §8.5, макет Backlog.dc.html): задачи без спринта по рангу, «Следующий спринт», предупреждение о задаче
// выше той, от которой она зависит, подписи выбора. Чистая логика без React и DOM.
import type { TeamSprint, TeamTask } from '@server/api-types';
import { plural, t } from '../i18n';
import { byRank, rankForDrop } from './rank';
import { tasksWord } from './board';

export const plannedSprint = (sprints: readonly TeamSprint[]): TeamSprint | undefined => sprints.find((s) => s.status === 'planned');

/** Задачи без спринта по рангу: сверху важнее. */
export const backlogTasks = (tasks: readonly TeamTask[]): TeamTask[] => byRank(tasks.filter((x) => x.sprint == null));

/** Задачи запланированного спринта по рангу; спринта нет — пусто. */
export const nextSprintTasks = (tasks: readonly TeamTask[], planned: TeamSprint | undefined): TeamTask[] =>
  planned ? byRank(tasks.filter((x) => x.sprint === planned.number)) : [];

export const points = (tasks: readonly Pick<TeamTask, 'estimate'>[]): number => tasks.reduce((s, x) => s + (x.estimate ?? 0), 0);

export const pointsWord = (n: number): string => `${n} ${plural(n, 'очко', 'очка', 'очков')}`;

/** «2 задачи · 3 очка»; без оценок — только задачи. */
export function tasksAndPoints(tasks: readonly Pick<TeamTask, 'estimate'>[]): string {
  const p = points(tasks);
  return p ? `${tasksWord(tasks.length)} · ${pointsWord(p)}` : tasksWord(tasks.length);
}

/** Строка «Следующего спринта»: «запланирован», «запустится после завершения спринта 2». */
export function nextSprintNote(active: TeamSprint | undefined): string {
  return active ? t('запустится после завершения спринта {n}', { n: active.number }) : t('запланирован');
}

export type OrderWarning = { id: string; above: string[] };

/** Задачи, которые стоят выше тех, от которых зависят, в том же списке. */
export function orderWarnings(ordered: readonly Pick<TeamTask, 'id' | 'blockedBy'>[]): OrderWarning[] {
  const pos = new Map(ordered.map((x, i) => [x.id, i]));
  const out: OrderWarning[] = [];
  ordered.forEach((x, i) => {
    const above = x.blockedBy.filter((b) => (pos.get(b) ?? -1) > i);
    if (above.length) out.push({ id: x.id, above });
  });
  return out;
}

export const orderWarningText = (w: OrderWarning): string =>
  t('{id} стоит выше {ids}, от {which} зависит', { id: w.id, ids: w.above.join(', '), which: plural(w.above.length, 'которой', 'которых', 'которых') });

/** «Выбрано 2». */
export const selectedText = (n: number): string => t('Выбрано {n}', { n });

/** Ранг для новой задачи из строки «Новая задача» — сверху бэклога, сразу под строкой ввода. */
export const rankForNew = (backlog: readonly Pick<TeamTask, 'rank'>[]): string => rankForDrop(backlog.map((x) => x.rank), 0);

/** Подсказка над бэклогом. */
export const backlogHint = (): string => t('сверху важнее · перетаскивайте или ⌥↑ ⌥↓');
