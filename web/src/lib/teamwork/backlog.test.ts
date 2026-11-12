import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TeamSprint } from '@server/api-types';
import { backlogTasks, nextSprintNote, nextSprintTasks, orderWarningText, orderWarnings, plannedSprint, points, rankForNew, selectedText, tasksAndPoints } from './backlog';
import { task } from './fixtures';

const sprints: TeamSprint[] = [{ number: 1, title: 'Спринт 1', status: 'closed' }, { number: 2, title: 'Спринт 2', status: 'active' }, { number: 3, title: 'Спринт 3', status: 'planned' }];

test('бэклог: задачи без спринта по рангу, следующий спринт — запланированный', () => {
  const tasks = [task({ id: 'PAY-1', rank: 'l' }), task({ id: 'PAY-2', rank: 'G' }), task({ id: 'PAY-3', sprint: 3, rank: 'V' }), task({ id: 'PAY-4', sprint: 2 })];
  assert.deepEqual(backlogTasks(tasks).map((x) => x.id), ['PAY-2', 'PAY-1']);
  assert.equal(plannedSprint(sprints)?.number, 3);
  assert.deepEqual(nextSprintTasks(tasks, plannedSprint(sprints)).map((x) => x.id), ['PAY-3']);
  assert.deepEqual(nextSprintTasks(tasks, undefined), []);
  assert.equal(nextSprintNote(sprints[1]), 'запустится после завершения спринта 2');
  assert.equal(nextSprintNote(undefined), 'запланирован');
});

test('бэклог: подписи — задачи и очки, выбрано', () => {
  const tasks = [task({ id: '1', estimate: 2 }), task({ id: '2', estimate: 1 })];
  assert.equal(points(tasks), 3);
  assert.equal(tasksAndPoints(tasks), '2 задачи · 3 очка');
  assert.equal(tasksAndPoints([task({ id: '1' })]), '1 задача');
  assert.equal(tasksAndPoints([]), '0 задач');
  assert.equal(selectedText(2), 'Выбрано 2');
});

test('бэклог: предупреждение, когда задача стоит выше той, от которой зависит', () => {
  const ordered = [task({ id: 'PAY-26', blockedBy: ['PAY-23', 'PAY-7', 'PAY-99'] }), task({ id: 'PAY-23' }), task({ id: 'PAY-7', blockedBy: ['PAY-23'] })];
  const w = orderWarnings(ordered);
  assert.deepEqual(w, [{ id: 'PAY-26', above: ['PAY-23', 'PAY-7'] }]);
  assert.equal(orderWarningText(w[0]!), 'PAY-26 стоит выше PAY-23, PAY-7, от которых зависит');
  assert.equal(orderWarningText({ id: 'A', above: ['B'] }), 'A стоит выше B, от которой зависит');
  assert.deepEqual(orderWarnings([ordered[1]!, ordered[2]!]), []);
});

test('бэклог: новая задача встаёт сверху', () => {
  const r = rankForNew([task({ id: '1', rank: 'V' }), task({ id: '2', rank: 'l' })]);
  assert.ok(r < 'V');
  assert.equal(rankForNew([]), 'V');
});
