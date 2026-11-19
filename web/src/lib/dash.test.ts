import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedItem, FlowListItem, RunSummary, SessionView, Thing } from '@server/api-types';
import {
  dashCap, dashMore, hasConnections, jiraSessionCwd, jiraThing, mrSign, mrThing, pickerFlows, pickerPosition, runsForBranch, runsForJira, sessionsForThing, thingSessionName,
  thingSessionPrompt,
} from './dash';
import { feedTone, feedWhat } from './feed';

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

test('вещи «Кода»: ключи задачи Jira и MR по формату src/things/types.ts', () => {
  assert.deepEqual(jiraThing({ key: 'pay-7', url: 'https://Jira.Example.com/browse/PAY-7', title: 'Падает оплата' }), {
    type: 'jira', key: 'jira:jira.example.com/PAY-7', ref: { host: 'jira.example.com', key: 'PAY-7' }, url: 'https://Jira.Example.com/browse/PAY-7', title: 'Падает оплата',
  });
  assert.equal(jiraThing({ key: 'PAY-7', url: 'не адрес', title: '' }), undefined);
  const mr = { iid: 12, url: 'https://gitlab.example.com/grp/app/-/merge_requests/12', title: 'Фикс', sourceBranch: 'feature/PAY-7' };
  assert.deepEqual(mrThing({ remote: { host: 'GitLab.example.com', path: '/grp/app/' }, forge: 'gitlab' }, mr), {
    type: 'mr', key: 'mr:gitlab.example.com/grp/app/12', ref: { host: 'gitlab.example.com', project: 'grp/app', number: 12, branch: 'feature/PAY-7', forge: 'gitlab' }, url: mr.url, title: 'Фикс',
  });
  assert.equal(mrThing({}, mr), undefined);
});

test('ключи «Кода» — те же, что у сервера (keys.ts): регистр пути, www., порт по умолчанию, хост из адреса MR', () => {
  // проект Group/App: сервер пишет запуск рутины с ключом в нижнем регистре — строка MR должна его найти
  const t = mrThing({ remote: { host: 'gitlab-ssh.example.com', path: 'Group/App' } }, { iid: 3, url: 'https://www.GitLab.example.com:443/Group/App/-/merge_requests/3', title: '', sourceBranch: 'b' });
  assert.equal(t?.key, 'mr:gitlab.example.com/group/app/3');
  assert.equal(t?.ref.project, 'Group/App');
  // адреса нет — хост origin
  assert.equal(mrThing({ remote: { host: 'GitLab.example.com', path: 'G/A' } }, { iid: 3, url: '', title: '', sourceBranch: 'b' })?.key, 'mr:gitlab.example.com/g/a/3');
  assert.equal(jiraThing({ key: 'pay-7', url: 'https://www.Jira.example.com:443/browse/PAY-7', title: '' })?.key, 'jira:jira.example.com/PAY-7');
  assert.equal(jiraThing({ key: 'не ключ', url: 'https://jira.example.com/browse/x', title: '' }), undefined);
  const runs = [run('rt', { source: { type: 'routine', key: 'review', title: '', thing: { type: 'mr', key: 'mr:gitlab.example.com/group/app/3', ref: {} } } })];
  assert.deepEqual(runsForBranch(runs, '/p', 'b', 'Group/App!3', t?.key).map((r) => r.id), ['rt']);
});

test('связанные запуски по вещи: запуск рутины у своего MR и задачи, чужая вещь — нет', () => {
  const thing = (key: string): Thing => ({ type: key.startsWith('mr:') ? 'mr' : 'jira', key, ref: {} });
  const runs = [
    run('rt-mr', { source: { type: 'routine', key: 'review', title: 'Ревью', thing: thing('mr:h/g/p/4') } }),
    run('rt-jira', { source: { type: 'routine', key: 'bugs', title: 'Баг', thing: thing('jira:j/ABC-1') } }),
    run('rt-other', { source: { type: 'routine', key: 'review', title: 'Ревью', thing: thing('mr:h/g/p/5') } }),
    run('j1', { source: { type: 'jira', key: 'ABC-1', title: '' } }),
  ];
  assert.deepEqual(runsForBranch(runs, '/p', 'feat', 'g/p!4', 'mr:h/g/p/4').map((r) => r.id), ['rt-mr']);
  assert.deepEqual(runsForJira(runs, 'ABC-1', 'jira:j/ABC-1').map((r) => r.id), ['rt-jira', 'j1']);
  // без ключа вещи — как раньше
  assert.deepEqual(runsForJira(runs, 'ABC-1').map((r) => r.id), ['j1']);
});

const session = (id: string, over: Partial<SessionView> = {}): SessionView =>
  ({ id, name: id, cwd: '/s', status: 'ended', live: false, tags: [], chips: [], saveState: true, createdAt: '', lastActivityAt: '2026-11-19T10:00:00Z', turns: 0, newTurns: 0, stateSpaces: [], ...over }) as SessionView;

test('сессия из задачи Jira: папка прошлой сессии, иначе запуска по задаче, иначе единственного проекта, иначе по умолчанию', () => {
  const k = 'jira:j/ABC-1';
  const s1 = session('a', { cwd: '/old', source: { thing: { type: 'jira', key: k, ref: {} } }, lastActivityAt: '2026-11-18T10:00:00Z' });
  const s2 = session('b', { cwd: '/new', source: { thing: { type: 'jira', key: k, ref: {} } } });
  const mine = sessionsForThing([s1, session('c'), s2], k);
  assert.deepEqual(mine.map((s) => s.id), ['b', 'a']);
  assert.deepEqual(sessionsForThing([s1], undefined), []);
  assert.equal(jiraSessionCwd({ sessions: mine, runs: [], projects: [], fallback: '/d' }), '/new');
  assert.equal(jiraSessionCwd({ sessions: [], runs: [run('r', { cwd: '/wt', project: '/repo' })], projects: [], fallback: '/d' }), '/repo');
  assert.equal(jiraSessionCwd({ sessions: [], runs: [], projects: [{ path: '/only' }], fallback: '/d' }), '/only');
  assert.equal(jiraSessionCwd({ sessions: [], runs: [], projects: [{ path: '/a' }, { path: '/b' }], fallback: '/d' }), '/d');
});

test('первое сообщение и имя сессии из вещи: просьба сверху, вход intake как есть', () => {
  const input = 'Задача Jira ABC-1\nСсылка: https://j/browse/ABC-1\n\n<source-data>\nЗаголовок: x\n</source-data>';
  const p = thingSessionPrompt(`${input}\n`);
  assert.ok(p.endsWith(input));
  assert.match(p, /^Начинаем работу по этой задаче\./);
  assert.equal(thingSessionName('!12', ' Фикс\n оплаты '), '!12 Фикс оплаты');
  assert.equal(thingSessionName('ABC-1', undefined), 'ABC-1');
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

test('журнал: цвет точки и подписи событий', () => {
  const now = new Date(2026, 9, 24, 12, 0);
  assert.equal(feedTone(item({ open: true })), 'closed');
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

test('подключения есть: Jira с токеном или хотя бы один проект; Jira без токена не в счёт', () => {
  const proj = { path: '/p', name: 'p' };
  assert.equal(hasConnections({ jira: null, projects: [] }), false);
  assert.equal(hasConnections({ jira: { baseUrl: 'u', email: 'e', hasToken: false }, projects: [] }), false);
  assert.equal(hasConnections({ jira: { baseUrl: 'u', email: 'e', hasToken: true }, projects: [] }), true);
  assert.equal(hasConnections({ jira: null, projects: [proj] }), true);
});
