import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TeamMember, TeamTaskWork } from '@server/api-types';
import { task } from './fixtures';
import {
  acceptanceText, assigneeChips, blockedLabel, blocking, boardColumns, dropMove, filterColumns, initials, keyboardMove, matchesFilter, memberLabel,
  noSprintText, openBlockers, parseFilter, prLabel, signalsText, sprintStrip, taskIndex, taskWorkState, toggleType, workBadge, workSignals, workState,
} from './board';

const members: TeamMember[] = [{ name: 'Алексей Колодин', email: 'alex@x.io' }, { name: 'Мария Серова', email: 'maria@x.io' }, { name: 'Иван', email: 'ivan@x.io' }];

test('доска: колонки по статусам из задач спринта, порядок по рангу и id', () => {
  const tasks = [
    task({ id: 'PAY-2', sprint: 2, rank: 'l' }), task({ id: 'PAY-1', sprint: 2, rank: 'V' }), task({ id: 'PAY-3', sprint: 2, rank: 'V', status: 'review' }),
    task({ id: 'PAY-9', sprint: 1, status: 'done' }), task({ id: 'PAY-10', rank: 'G' }),
  ];
  const cols = boardColumns(tasks, 2);
  assert.deepEqual(cols.todo.map((x) => x.id), ['PAY-1', 'PAY-2']);
  assert.deepEqual(cols.review.map((x) => x.id), ['PAY-3']);
  assert.deepEqual(cols.in_progress, []);
  assert.deepEqual(cols.done, []);
});

test('доска: фильтры «Мои», исполнитель, «без исполнителя», тип; разбор сохранённого', () => {
  const me = 'alex@x.io';
  const a = task({ id: 'PAY-1', assignee: me, type: 'bug' });
  const b = task({ id: 'PAY-2', assignee: 'maria@x.io' });
  const c = task({ id: 'PAY-3' });
  assert.equal(matchesFilter(a, { who: 'me', types: [] }, me), true);
  assert.equal(matchesFilter(b, { who: 'me', types: [] }, me), false);
  assert.equal(matchesFilter(a, { who: 'me', types: [] }, undefined), false, 'без моего email «Мои» пусто');
  assert.equal(matchesFilter(c, { who: 'none', types: [] }), true);
  assert.equal(matchesFilter(b, { who: { email: 'maria@x.io' }, types: [] }), true);
  assert.equal(matchesFilter(a, { who: 'all', types: ['feature'] }), false);
  assert.equal(matchesFilter(a, { who: 'all', types: ['feature', 'bug'] }), true);
  const cols = filterColumns(boardColumns([{ ...a, sprint: 1 }, { ...b, sprint: 1 }, { ...c, sprint: 1 }], 1), { who: 'none', types: [] }, me);
  assert.deepEqual(cols.todo.map((x) => x.id), ['PAY-3']);
  assert.deepEqual(toggleType({ who: 'all', types: [] }, 'bug').types, ['bug']);
  assert.deepEqual(toggleType({ who: 'all', types: ['bug'] }, 'bug').types, []);
  assert.deepEqual(parseFilter(null), { who: 'all', types: [] });
  assert.deepEqual(parseFilter({ who: { email: 'm@x' }, types: ['bug', 'nope'] }), { who: { email: 'm@x' }, types: ['bug'] });
  assert.deepEqual(parseFilter({ who: 'me' }), { who: 'me', types: [] });
});

test('доска: чипсы исполнителей со счётчиками — Все, Мои, участники с задачами, незнакомый email, без исполнителя', () => {
  const tasks = [
    task({ id: '1', assignee: 'alex@x.io' }), task({ id: '2', assignee: 'alex@x.io' }), task({ id: '3', assignee: 'maria@x.io' }), task({ id: '4' }), task({ id: '5', assignee: 'guest@y.io' }),
  ];
  const chips = assigneeChips(tasks, members, 'alex@x.io');
  assert.deepEqual(chips.map((c) => [c.label, c.count]), [['Все', 5], ['Мои', 2], ['Мария', 1], ['guest', 1], ['Без исполнителя', 1]]);
  assert.deepEqual(chips[2]!.who, { email: 'maria@x.io' });
  assert.deepEqual(assigneeChips([], members).map((c) => c.label), ['Все'], 'без меня нет «Мои», без задач нет остальных');
  assert.equal(memberLabel({ name: '', email: 'ivan@x.io' }), 'ivan');
  assert.equal(initials(members[0]), 'АК');
  assert.equal(initials(members[2]), 'ИВ');
  assert.equal(initials('guest@y.io'), 'GU');
  assert.equal(initials(undefined), '');
});

test('доска: полоска спринта готово → ревью → в работе → к работе, подпись и прогресс', () => {
  const tasks = [
    task({ id: '1', status: 'todo' }), task({ id: '2', status: 'done' }), task({ id: '3', status: 'in_progress' }), task({ id: '4', status: 'review' }), task({ id: '5', status: 'done' }),
  ];
  const s = sprintStrip(tasks);
  assert.deepEqual(s.cells, ['done', 'done', 'review', 'in_progress', 'todo']);
  assert.equal(s.label, '5 задач: 2 готово, 1 на ревью, 1 в работе, 1 к работе');
  assert.equal(s.progress, '2 из 5 готово');
  assert.equal(s.done, 2);
  assert.equal(sprintStrip([]).label, 'задач нет');
});

test('доска: состояние работы агента по статусам запуска и сессии, счётчики по задачам, значок карточки', () => {
  const w = (over: Partial<TeamTaskWork>): TeamTaskWork => ({ kind: 'run', id: 'r', at: '2026-11-12T10:00:00Z', ...over });
  assert.equal(workState(w({ status: 'running' })), 'working');
  assert.equal(workState(w({ status: 'working' })), 'working');
  assert.equal(workState(w({})), 'working');
  assert.equal(workState(w({ status: 'waiting' })), 'waiting');
  assert.equal(workState(w({ status: 'paused' })), 'waiting');
  assert.equal(workState(w({ status: 'budget_exceeded' })), 'failed');
  assert.equal(workState(w({ status: 'ended' })), 'done');
  const waiting = task({ id: '1', work: [w({ status: 'done', at: '2026-11-12T11:00:00Z' }), w({ status: 'waiting', title: 'teamwork-task' })] });
  const working = task({ id: '2', work: [w({ kind: 'session', status: 'working', title: 'PAY-2' })] });
  const failed = task({ id: '3', work: [w({ status: 'budget_exceeded' })] });
  const idle = task({ id: '4', work: [w({ status: 'done' })] });
  assert.equal(taskWorkState(waiting), 'waiting', 'ждёт, даже если другой запуск готов');
  assert.equal(taskWorkState(idle), 'done');
  assert.equal(taskWorkState(task({ id: '5' })), undefined);
  assert.deepEqual(workSignals([waiting, working, failed, idle]), { working: 1, waiting: 1 });
  assert.deepEqual(signalsText({ working: 2, waiting: 1 }), ['агент работает · 2', 'ждёт тебя · 1']);
  assert.deepEqual(signalsText({ working: 0, waiting: 0 }), []);
  assert.equal(workBadge(waiting)?.text, 'ждёт ответа · teamwork-task');
  assert.equal(workBadge(working)?.text, 'сессия Claude Code · работает');
  assert.equal(workBadge(failed)?.text, 'запуск остановлен: лимит стоимости');
  assert.equal(workBadge(idle), undefined);
});

test('доска: «ждёт PAY-12», пока предшественник не готов; неизвестный номер не блокирует; кто кого блокирует; PR', () => {
  const tasks = [task({ id: 'PAY-11', status: 'done' }), task({ id: 'PAY-12', status: 'in_progress' }), task({ id: 'PAY-17', blockedBy: ['PAY-11', 'PAY-12', 'PAY-99'] })];
  const byId = taskIndex(tasks);
  assert.deepEqual(openBlockers(tasks[2]!, byId), ['PAY-12']);
  assert.equal(blockedLabel(openBlockers(tasks[2]!, byId)), 'ждёт PAY-12');
  assert.equal(blockedLabel([]), '');
  assert.deepEqual(blocking(tasks[1]!, tasks).map((x) => x.id), ['PAY-17']);
  assert.equal(prLabel({ url: 'https://github.com/acme/billing/pull/41', state: 'open' }), 'PR #41 открыт');
  assert.equal(prLabel({ url: 'https://gitlab.com/acme/billing/-/merge_requests/7', state: 'merged' }), 'MR !7 смёржен');
  assert.equal(prLabel({ url: 'https://example.com/x', state: 'closed' }), 'PR закрыт');
  assert.equal(acceptanceText(task({ id: '1', acceptance: { done: 2, total: 5 } })), '2/5');
  assert.equal(acceptanceText(task({ id: '1' })), '');
});

test('доска: перенос — соседи для сервера и ранг между ними; с клавиатуры за край не уезжает', () => {
  const col = [task({ id: 'a', rank: 'G' }), task({ id: 'b', rank: 'V' }), task({ id: 'c', rank: 'l' })];
  const d = dropMove(col, 1, { status: 'review' });
  assert.deepEqual(d.move, { status: 'review', after: 'a', before: 'b' });
  assert.ok(d.rank > 'G' && d.rank < 'V');
  assert.deepEqual(dropMove(col, 0).move, { before: 'a' });
  assert.deepEqual(dropMove(col, 3).move, { after: 'c' });
  assert.deepEqual(dropMove([], 0, { sprint: null }).move, { sprint: null });
  const up = keyboardMove(col, 'c', -1)!;
  assert.deepEqual(up.move, { after: 'a', before: 'b' });
  const down = keyboardMove(col, 'a', 1)!;
  assert.deepEqual(down.move, { after: 'b', before: 'c' });
  assert.equal(keyboardMove(col, 'a', -1), undefined);
  assert.equal(keyboardMove(col, 'c', 1), undefined);
  assert.equal(keyboardMove(col, 'zzz', 1), undefined);
  assert.equal(noSprintText().title, 'Спринт не запущен');
  assert.match(noSprintText({ number: 3, title: 'Спринт 3', status: 'planned' }).hint, /«Спринт 3»/);
});
