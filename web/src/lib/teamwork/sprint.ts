// Спринты (spec §8.6): запуск с предупреждениями о предшественниках вне спринта, итог закрытия и result для файла
// спринта, история. Чистая логика без React и DOM.
import type { TeamSprint, TeamTask, TeamTaskPatch, TeamTaskStatus } from '@server/api-types';
import { plural, t } from '../i18n';
import { statusText } from './board';

export const sprintDefaultTitle = (n: number): string => t('Спринт {n}', { n });

/** Номер нового спринта: максимум плюс один; спринтов нет — 1. */
export const nextSprintNumber = (sprints: readonly TeamSprint[]): number => sprints.reduce((m, s) => Math.max(m, s.number), 0) + 1;

export type StartWarning = { id: string; blockers: { id: string; status: TeamTaskStatus }[] };

/** Задачи спринта, у которых предшественник не готов и не входит в этот спринт. Неизвестные номера не считаются. */
export function startWarnings(sprint: readonly Pick<TeamTask, 'id' | 'blockedBy'>[], all: readonly Pick<TeamTask, 'id' | 'status'>[]): StartWarning[] {
  const inSprint = new Set(sprint.map((x) => x.id));
  const byId = new Map(all.map((x) => [x.id, x]));
  const out: StartWarning[] = [];
  for (const x of sprint) {
    const blockers = x.blockedBy
      .filter((b) => !inSprint.has(b))
      .map((b) => byId.get(b))
      .filter((b): b is Pick<TeamTask, 'id' | 'status'> => Boolean(b) && b!.status !== 'done')
      .map((b) => ({ id: b.id, status: b.status }));
    if (blockers.length) out.push({ id: x.id, blockers });
  }
  return out;
}

export const startWarningText = (w: StartWarning): string =>
  t('{id} ждёт {ids} — не в спринте', { id: w.id, ids: w.blockers.map((b) => `${b.id} (${statusText(b.status)})`).join(', ') });

/** Задачи, которым при запуске спринта вернётся статус «К работе» (spec §8.6). */
export const startPatches = (sprint: readonly Pick<TeamTask, 'id' | 'status' | 'base'>[]): { id: string; patch: TeamTaskPatch }[] =>
  sprint.filter((x) => x.status !== 'todo').map((x) => ({ id: x.id, patch: { base: x.base, status: 'todo' } }));

export type CarryChoice = 'next' | 'backlog';

export type CloseSummary = { done: TeamTask[]; open: TeamTask[]; text: string };

/** Итог закрытия: готовые, незавершённые и «2 из 12 готово». */
export function closeSummary(sprint: readonly TeamTask[]): CloseSummary {
  const done = sprint.filter((x) => x.status === 'done');
  const open = sprint.filter((x) => x.status !== 'done');
  return { done, open, text: t('{done} из {total} готово', { done: done.length, total: sprint.length }) };
}

/** result файла спринта по выбору для незавершённых: без выбора — «В следующий спринт». */
export function closeResult(sprint: readonly TeamTask[], choices: Record<string, CarryChoice>, fallback: CarryChoice = 'next'): NonNullable<TeamSprint['result']> {
  const { done, open } = closeSummary(sprint);
  return {
    done: done.map((x) => x.id),
    carried: open.filter((x) => (choices[x.id] ?? fallback) === 'next').map((x) => x.id),
    returned: open.filter((x) => (choices[x.id] ?? fallback) === 'backlog').map((x) => x.id),
  };
}

/** Патчи задач при закрытии: в следующий спринт — номер нового, в бэклог — sprint: null. */
export function closePatches(sprint: readonly TeamTask[], result: NonNullable<TeamSprint['result']>, nextNumber: number): { id: string; patch: TeamTaskPatch }[] {
  const byId = new Map(sprint.map((x) => [x.id, x]));
  const out: { id: string; patch: TeamTaskPatch }[] = [];
  for (const id of result.carried) out.push({ id, patch: { base: byId.get(id)?.base, sprint: nextNumber } });
  for (const id of result.returned) out.push({ id, patch: { base: byId.get(id)?.base, sprint: null } });
  return out;
}

/** Строка истории спринта: «готово 10 из 12 · перенесено 1 · в бэклог 1». */
export function sprintResultText(s: TeamSprint): string {
  const r = s.result;
  if (!r) return '';
  const total = r.done.length + r.carried.length + r.returned.length;
  const parts = [t('готово {done} из {total}', { done: r.done.length, total })];
  if (r.carried.length) parts.push(t('перенесено {n}', { n: r.carried.length }));
  if (r.returned.length) parts.push(t('в бэклог {n}', { n: r.returned.length }));
  return parts.join(' · ');
}

/** Закрытые спринты, свежие сверху. */
export const closedSprints = (sprints: readonly TeamSprint[]): TeamSprint[] => sprints.filter((s) => s.status === 'closed').sort((a, b) => b.number - a.number);

export const openCountText = (n: number): string => `${n} ${plural(n, 'незавершённая задача', 'незавершённые задачи', 'незавершённых задач')}`;
