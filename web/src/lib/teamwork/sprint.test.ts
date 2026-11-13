import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TeamSprint } from '@server/api-types';
import { closePatches, closeResult, closeSummary, closedSprints, nextSprintNumber, openCountText, sprintDefaultTitle, sprintResultText, startPatches, startWarningText, startWarnings } from './sprint';
import { task } from './fixtures';

test('спринт: название и номер по умолчанию', () => {
  assert.equal(sprintDefaultTitle(3), 'Спринт 3');
  assert.equal(nextSprintNumber([]), 1);
  assert.equal(nextSprintNumber([{ number: 2, title: '', status: 'closed' }, { number: 5, title: '', status: 'active' }]), 6);
});

test('спринт: предупреждение при запуске — предшественник не готов и не в спринте; статус возвращается в «К работе»', () => {
  const all = [task({ id: 'PAY-1', status: 'done' }), task({ id: 'PAY-2', status: 'in_progress' }), task({ id: 'PAY-3' }), task({ id: 'PAY-4', blockedBy: ['PAY-1', 'PAY-2', 'PAY-3', 'PAY-77'] })];
  const sprint = [all[2]!, all[3]!];
  const w = startWarnings(sprint, all);
  assert.deepEqual(w, [{ id: 'PAY-4', blockers: [{ id: 'PAY-2', status: 'in_progress' }] }]);
  assert.equal(startWarningText(w[0]!), 'PAY-4 ждёт PAY-2 (в работе) — не в спринте');
  assert.deepEqual(startWarnings([all[0]!, all[2]!], all), []);
  assert.deepEqual(startPatches([task({ id: 'a', status: 'review', base: 'h1' }), task({ id: 'b' })]), [{ id: 'a', patch: { base: 'h1', status: 'todo' } }]);
});

test('спринт: итог закрытия — готово из всех, незавершённые по выбору в следующий или в бэклог, патчи', () => {
  const sprint = [task({ id: 'PAY-10', status: 'done' }), task({ id: 'PAY-12', status: 'done' }), task({ id: 'PAY-13', status: 'review' }), task({ id: 'PAY-14', status: 'todo' })];
  const s = closeSummary(sprint);
  assert.equal(s.text, '2 из 4 готово');
  assert.deepEqual(s.open.map((x) => x.id), ['PAY-13', 'PAY-14']);
  const r = closeResult(sprint, { 'PAY-14': 'backlog' });
  assert.deepEqual(r, { done: ['PAY-10', 'PAY-12'], carried: ['PAY-13'], returned: ['PAY-14'] });
  assert.deepEqual(closeResult(sprint, {}, 'backlog').carried, []);
  assert.deepEqual(closePatches(sprint, r, 3), [{ id: 'PAY-13', patch: { base: 'h', sprint: 3 } }, { id: 'PAY-14', patch: { base: 'h', sprint: null } }]);
  assert.equal(openCountText(2), '2 незавершённые задачи');
  assert.equal(openCountText(5), '5 незавершённых задач');
});

test('спринт: история закрытых — свежие сверху, строка итога', () => {
  const list: TeamSprint[] = [
    { number: 1, title: 'Спринт 1', status: 'closed', result: { done: ['a', 'b'], carried: ['c'], returned: [] } },
    { number: 2, title: 'Спринт 2', status: 'closed', result: { done: ['d'], carried: [], returned: ['e'] } },
    { number: 3, title: 'Спринт 3', status: 'active' },
  ];
  assert.deepEqual(closedSprints(list).map((s) => s.number), [2, 1]);
  assert.equal(sprintResultText(list[0]!), 'готово 2 из 3 · перенесено 1');
  assert.equal(sprintResultText(list[1]!), 'готово 1 из 2 · вернулось в бэклог 1');
  assert.equal(sprintResultText(list[2]!), '');
});
