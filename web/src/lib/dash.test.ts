import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedItem, FlowListItem, RunSummary } from '@server/api-types';
import { dashCap, dashMore, mrSign, pickerFlows, pickerPosition, runsForBranch, runsForJira } from './dash';
import { feedTone, feedWhat, isUnread, unreadCount } from './feed';

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({
  id, flow: 'f', status: 'done', iterations: 1, totalCostUsd: 0, startedAt: '2026-10-24T10:00:00Z', input: '', hidden: false, ...over,
});

test('«Ещё N»: первые пять, остальное по кнопке', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(dashCap(xs, false), [1, 2, 3, 4, 5]);
  assert.deepEqual(dashCap(xs, true), xs);
  assert.equal(dashMore(xs, false), 2);
  assert.equal(dashMore(xs, true), 0);
  assert.equal(dashMore([1, 2], false), 0);
});

test('связанные запуски: по задаче Jira, MR, ветке проекта и ветке worktree; не больше шести', () => {
  const runs = [
    run('j1', { source: { type: 'jira', key: 'ABC-1', title: '' } }),
    run('mr', { source: { type: 'mr', key: 'g/p!4', title: '', project: '/p' } }),
    run('br', { source: { type: 'branch', key: 'feat', title: '', project: '/p' } }),
    run('br-other', { source: { type: 'branch', key: 'feat', title: '', project: '/q' } }),
    run('wt', { worktree: { path: '/w', branch: 'feat' } }),
    run('wt-other', { worktree: { path: '/w', branch: 'feat' }, source: { type: 'jira', key: 'X-1', title: '', project: '/q' } }),
  ];
  assert.deepEqual(runsForJira(runs, 'ABC-1').map((r) => r.id), ['j1']);
  assert.deepEqual(runsForBranch(runs, '/p', 'feat').map((r) => r.id), ['br', 'wt']);
  assert.deepEqual(runsForBranch(runs, '/p', 'feat', 'g/p!4').map((r) => r.id), ['mr', 'br', 'wt']);
  assert.equal(runsForJira(Array.from({ length: 9 }, (_, i) => run(String(i), { source: { type: 'jira', key: 'K', title: '' } })), 'K').length, 6);
});

test('выбор flow: только рабочие, фильтр по имени, папке и описанию; последний — первым, дальше по папке и имени', () => {
  const flows: FlowListItem[] = [
    { name: 'zeta', file: '', folder: '', valid: true },
    { name: 'alpha', file: '', folder: 'Б', valid: true, description: 'Ревью MR' },
    { name: 'beta', file: '', folder: 'А', valid: true },
    { name: 'broken', file: '', folder: '', valid: false },
  ];
  assert.deepEqual(pickerFlows(flows, '', null).map((f) => f.name), ['zeta', 'beta', 'alpha']);
  assert.deepEqual(pickerFlows(flows, '', 'alpha').map((f) => f.name), ['alpha', 'zeta', 'beta']);
  assert.deepEqual(pickerFlows(flows, ' ревью ', null).map((f) => f.name), ['alpha']);
  assert.deepEqual(pickerFlows(flows, 'а', null).map((f) => f.name), ['beta']);
  assert.deepEqual(pickerFlows(flows, 'broken', null), []);
});

test('выпадашка выбора flow: под кнопкой правым краем, у края окна — внутри, внизу — над кнопкой', () => {
  const size = { width: 340, height: 200 };
  const view = { width: 1280, height: 800 };
  assert.deepEqual(pickerPosition({ top: 100, bottom: 124, right: 900 }, size, view), { left: 560, top: 128 });
  assert.deepEqual(pickerPosition({ top: 100, bottom: 124, right: 200 }, size, view), { left: 8, top: 128 });
  assert.deepEqual(pickerPosition({ top: 700, bottom: 724, right: 900 }, size, view), { left: 560, top: 496 });
});

const item = (over: Partial<FeedItem>): FeedItem => ({ id: 'x', kind: 'question', at: '2026-10-24T10:00:00Z', runId: 'r', flow: 'f', ...over });

test('лента: новые после отметки, цвет точки и подписи событий', () => {
  const now = new Date(2026, 9, 24, 12, 0);
  const items = [item({ at: '2026-10-24T10:05:00Z' }), item({ at: '2026-10-24T09:00:00Z' })];
  assert.equal(unreadCount(items, '2026-10-24T10:00:00Z'), 1);
  assert.equal(isUnread(items[1]!, '2026-10-24T10:00:00Z'), false);
  assert.equal(feedTone(item({ open: true })), 'waiting');
  assert.equal(feedTone(item({ open: false })), 'closed');
  assert.equal(feedTone(item({ kind: 'end', status: 'failed' })), 'failed');
  assert.deepEqual(feedWhat(item({ title: 'План', open: true }), now), { head: 'Вопрос от «План»', state: { text: 'ждёт ответа', wait: true }, tip: 'Вопрос от «План» · ждёт ответа' });
  assert.deepEqual(feedWhat(item({ title: 'План', doneAt: new Date(2026, 9, 24, 11, 5).toISOString() }), now).state, { text: 'отвечен 11:05', wait: false });
  assert.equal(feedWhat(item({ title: 'План' }), now).tip, 'Вопрос от «План» · остался без ответа');
  assert.deepEqual(feedWhat(item({ kind: 'pause', title: 'ask', open: true }), now), { head: '«ask» просит решения', state: { text: 'запуск на паузе', wait: true }, tip: '«ask» просит решения · запуск на паузе' });
  assert.equal(feedWhat(item({ kind: 'pause', title: 'ask' }), now).state?.text, 'не возобновлён');
  assert.deepEqual(feedWhat(item({ kind: 'end', status: 'done' }), now), { head: 'Запуск завершён', state: null, tip: 'Запуск завершён' });
});

test('знак номера: PR GitHub — #, MR GitLab — !', () => {
  assert.equal(mrSign('octo/app#12'), '#');
  assert.equal(mrSign('tools/agentgraph!42'), '!');
});
