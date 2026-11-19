// Наблюдатель MR/PR (src/things/forge.ts): чей ход, закрытые, CI и конфликты, ошибки доступа — на поддельных glab и gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Exec } from './git.js';
import { forgeError, forgeRefOf, forgeWatcher, judgeMr, mrKeyOf, mrLifecycle, mrState, type MrModel } from './things/forge.js';
import type { Thing } from './things/types.js';

const T = (h: number, m = 0) => Date.UTC(2026, 10, 18, h, m);
const model = (over: Partial<MrModel> = {}): MrModel => ({
  lifecycle: 'open', iid: 7, ref: 'g/app!7', url: 'https://gl.test/g/app/-/merge_requests/7', title: 'Выгрузка CSV', author: 'ivan', draft: false, branch: 'feat', targetBranch: 'dev', updatedAt: '2026-11-18T12:00:00Z',
  conflicts: false, threads: [], notes: [], reviewers: [], requests: [], depth: 'full', ...over,
});
const note = (at: number, author: string, system = false) => ({ at, author, system });
const me = new Set(['me']);

// ---------- чей ход: чужой MR (я ревьюер)

test('чужой MR: запрошено ревью, я ещё не отвечал — мой ход', () => {
  const s = judgeMr(model({ reviewers: ['me'] }), me);
  assert.deepEqual([s.turn, s.why], ['me', 'ревью запрошено']);
});

test('чужой MR: моя последняя реплика — ход автора', () => {
  const s = judgeMr(model({ reviewers: ['me'], notes: [note(T(10), 'me'), note(T(9), 'ivan')] }), me);
  assert.deepEqual([s.turn, s.why], ['others', 'ждёт автора']);
});

test('чужой MR: автор ответил и запушил после моей реплики — мой ход, причины перечислены', () => {
  const s = judgeMr(model({ notes: [note(T(10), 'me'), note(T(11), 'ivan'), note(T(11, 5), 'ivan'), note(T(11, 6), 'ivan', true)], commitAt: T(12) }), me);
  assert.equal(s.turn, 'me');
  assert.equal(s.why, 'автор ответил: 2 реплики, новые коммиты');
});

test('чужой MR: одни коммиты после моей реплики — мой ход; системные заметки репликой не считаются', () => {
  const s = judgeMr(model({ notes: [note(T(10), 'me'), note(T(11), 'ivan', true)], commitAt: T(11, 30) }), me);
  assert.deepEqual([s.turn, s.why], ['me', 'новые коммиты']);
  assert.equal(judgeMr(model({ notes: [note(T(10), 'me'), note(T(11), 'ivan', true)], commitAt: T(9) }), me).turn, 'others');
});

test('чужой MR: ревью запрошено заново после моей реплики — мой ход, даже без новых реплик', () => {
  const s = judgeMr(model({ notes: [note(T(10), 'me')], requests: [{ at: T(10), reviewer: 'me' }, { at: T(13), reviewer: 'me' }] }), me);
  assert.deepEqual([s.turn, s.why], ['me', 'ревью запрошено заново']);
  // запрос ревью у другого человека меня не касается
  assert.equal(judgeMr(model({ notes: [note(T(10), 'me')], requests: [{ at: T(13), reviewer: 'anna' }] }), me).turn, 'others');
});

test('чужой MR: не участвую — ход ничей; черновик без моих реплик — ничей', () => {
  assert.deepEqual([judgeMr(model({ notes: [note(T(9), 'anna')] }), me).turn, judgeMr(model({ notes: [note(T(9), 'anna')] }), me).why], ['none', 'вы не участвуете в ревью']);
  assert.equal(judgeMr(model({ draft: true, reviewers: ['me'] }), me).turn, 'none');
});

test('реплики других ревьюеров после моей — тоже мой ход, с подписью «от других»', () => {
  const s = judgeMr(model({ notes: [note(T(10), 'me'), note(T(11), 'anna')] }), me);
  assert.deepEqual([s.turn, s.why], ['me', '1 реплика от других']);
});

// ---------- чей ход: мой MR

test('мой MR: ревьюер ответил после моего пуша — мой ход; мой ответ или пуш позже — ход ревьюера', () => {
  const mine = { author: 'me' };
  const asked = judgeMr(model({ ...mine, notes: [note(T(10), 'anna')], commitAt: T(9) }), me);
  assert.deepEqual([asked.turn, asked.why], ['me', '1 новая реплика']);
  assert.equal(judgeMr(model({ ...mine, notes: [note(T(10), 'anna')], commitAt: T(11) }), me).turn, 'others', 'пуш после замечания — ответ');
  assert.equal(judgeMr(model({ ...mine, notes: [note(T(10), 'anna'), note(T(11), 'me')] }), me).turn, 'others', 'мой ответ в обсуждении');
});

test('мой MR: упал CI или конфликты — мой ход, даже если ревьюер молчит', () => {
  const s = judgeMr(model({ author: 'me', ci: { status: 'failed', url: 'https://ci' }, conflicts: true }), me);
  assert.deepEqual([s.turn, s.why], ['me', 'CI упал, конфликты с dev']);
  assert.equal(s.facts.ci, 'failed');
  assert.equal(s.facts.ciUrl, 'https://ci');
  assert.equal(judgeMr(model({ author: 'me', ci: { status: 'running', url: '' } }), me).turn, 'others');
});

test('мой MR: никто не писал — ждёт ревью (с именами ревьюеров); черновик — ничей', () => {
  assert.deepEqual([judgeMr(model({ author: 'me', reviewers: ['anna', 'boris'] }), me).turn, judgeMr(model({ author: 'me', reviewers: ['anna', 'boris'] }), me).why], ['others', 'ждёт ревью: anna, boris']);
  assert.deepEqual([judgeMr(model({ author: 'me', draft: true }), me).turn, judgeMr(model({ author: 'me', draft: true }), me).why], ['none', 'черновик']);
});

test('закрытые: смёржен и закрыт без мёржа — ход ничей, closed выставлен', () => {
  const merged = judgeMr(model({ lifecycle: 'merged' }), me);
  assert.deepEqual([merged.exists, merged.closed, merged.turn, merged.why], [true, 'merged', 'none', 'смёржен']);
  assert.deepEqual([judgeMr(model({ lifecycle: 'closed' }), me).closed, judgeMr(model({ lifecycle: 'closed' }), me).why], ['closed', 'закрыт без мёржа']);
});

test('логины сравниваются без учёта регистра; «replies» — как в блоке «Мои MR»', () => {
  const threads = [
    { resolvable: true, resolved: false, last: 'Anna' },
    { resolvable: true, resolved: false, last: 'ME' }, // последний — я
    { resolvable: true, resolved: true, last: 'anna' },
    { resolvable: false, resolved: false, last: 'anna' },
    { resolvable: true, resolved: false, last: undefined }, // одни системные
  ];
  const s = judgeMr(model({ author: 'Me', threads }), me);
  assert.equal(s.facts.replies, 1);
  assert.equal(s.facts.role, 'author');
});

// ---------- поддельные glab и gh

type Answers = Record<string, unknown | Error | (() => unknown)>;
/** Ответ по хвосту пути API; calls — что спрашивали. Нет ответа — ошибка, чтобы лишний запрос заметил тест. */
function fake(answers: Answers) {
  const calls: string[] = [];
  const x: Exec = async (cmd, args) => {
    const i = args.indexOf('--hostname');
    const path = args.slice(i + 2).find((a) => !a.startsWith('query=') && !a.startsWith('-')) ?? '';
    const key = `${cmd} ${path.split('?')[0]}`;
    calls.push(key);
    const a = answers[key];
    if (a === undefined) throw new Error(`${cmd} api: нет ответа для ${key}`);
    if (a instanceof Error) throw a;
    return JSON.stringify(typeof a === 'function' ? (a as () => unknown)() : a);
  };
  return { x, calls };
}

const glMr = (over: Record<string, unknown> = {}) => ({ iid: 7, title: 'Выгрузка CSV', state: 'opened', source_branch: 'feat', target_branch: 'dev', author: { username: 'ivan' }, web_url: 'https://gl.test/g/app/-/merge_requests/7', references: { full: 'g/app!7' }, updated_at: '2026-11-18T12:00:00Z', reviewers: [{ username: 'me' }], ...over });
const profile = () => ({ names: [], emails: [], gitlab: 'me', github: 'me-gh' });
const GL = (n = 7) => `glab projects/g%2Fapp/merge_requests/${n}`;

test('GitLab: ревью запрошено, автор ответил на моё замечание — мой ход; считаются обсуждения, коммиты и запрос ревью', async () => {
  const { x, calls } = fake({
    'glab user': { username: 'me' },
    [GL()]: glMr({ head_pipeline: { status: 'success', web_url: 'https://ci' } }),
    [`${GL()}/discussions`]: [
      { resolvable: true, resolved: false, notes: [{ author: { username: 'me' }, created_at: '2026-11-18T10:00:00Z' }, { author: { username: 'ivan' }, created_at: '2026-11-18T11:00:00Z' }] },
      { resolvable: false, notes: [{ author: { username: 'ivan' }, system: true, body: 'requested review from @me', created_at: '2026-11-18T11:30:00Z' }] },
    ],
    [`${GL()}/commits`]: [{ committed_date: '2026-11-18T11:45:00Z' }],
  });
  const s = await mrState({ host: 'gl.test', project: 'g/app', number: 7 }, { exec: x, profile });
  assert.deepEqual([s.exists, s.turn, s.why], [true, 'me', 'ревью запрошено заново, автор ответил: 1 реплика, новые коммиты']);
  assert.equal(s.title, 'Выгрузка CSV');
  assert.deepEqual([s.facts.branch, s.facts.author, s.facts.ci], ['feat', 'ivan', 'success']);
  assert.deepEqual(calls.filter((c) => c.startsWith('glab projects')), [GL(), `${GL()}/discussions`, `${GL()}/commits`]);
});

test('GitLab: смёржен — один запрос, без обсуждений', async () => {
  const { x, calls } = fake({ 'glab user': { username: 'me' }, [GL()]: glMr({ state: 'merged' }) });
  const s = await mrState({ host: 'gl.test', project: 'g/app', number: 7 }, { exec: x, profile });
  assert.deepEqual([s.closed, s.turn], ['merged', 'none']);
  assert.deepEqual(calls.filter((c) => c.startsWith('glab projects')), [GL()]);
});

test('GitLab: режим «Мои MR» — без коммитов; число заметок 0 — без обсуждений; me из подсказки, без запроса пользователя', async () => {
  const { x, calls } = fake({ [GL()]: glMr({ author: { username: 'me' }, has_conflicts: true }) });
  const s = await mrState({ host: 'gl.test', project: 'g/app', number: 7, me: 'me', notesCount: 0 }, { exec: x, depth: 'attention' });
  assert.deepEqual([s.exists, s.facts.conflicts, s.turn], [true, true, 'me']);
  assert.deepEqual(calls, [GL()]);
});

test('GitLab: нет доступа к хосту — exists: false и понятная ошибка, без исключений', async () => {
  const { x } = fake({ 'glab user': new Error('glab api: 401 Unauthorized'), [GL()]: new Error('glab api: 401 Unauthorized') });
  const s = await mrState({ host: 'gitlab.company.com', project: 'g/app', number: 7 }, { exec: x, profile: () => ({ names: [], emails: [] }) });
  assert.equal(s.exists, false);
  assert.equal(s.error, 'нет доступа к gitlab.company.com: выполните glab auth login');
  assert.deepEqual([s.turn, s.facts], ['none', {}]);
});

test('ошибки: нет утилиты, 404, прочее', () => {
  assert.equal(forgeError('github.com', 'github', new Error('gh api: gh не установлен')), 'gh не установлен: поставьте его и выполните gh auth login');
  assert.match(forgeError('gl.test', 'gitlab', new Error('glab api: 404 Not Found')), /MR не найден на gl\.test или нет доступа к нему/);
  assert.equal(forgeError('gl.test', 'gitlab', new Error('glab api: таймаут')), 'glab api: таймаут');
  assert.match(forgeError('github.com', 'github', new Error('gh api: HTTP 403: Resource not accessible')), /нет доступа к github\.com: выполните gh auth login/);
});

const GH = (suffix = '') => `gh repos/acme/billing/${suffix}`;
const ghPull = (over: Record<string, unknown> = {}) => ({ number: 42, title: 'Платежи', state: 'open', head: { ref: 'pay', sha: 'abc' }, base: { ref: 'main' }, user: { login: 'ivan' }, html_url: 'https://github.com/acme/billing/pull/42', updated_at: '2026-11-18T12:00:00Z', requested_reviewers: [], ...over });
const ghThreads = (nodes: unknown[]) => ({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });

test('GitHub: я автор, review-тред ждёт моего ответа, CI упал — мой ход; все источники нужны только в полном режиме', async () => {
  const { x, calls } = fake({
    'gh user': { login: 'me-gh' },
    [GH('pulls/42')]: ghPull({ user: { login: 'me-gh' }, mergeable_state: 'dirty' }),
    [GH('commits/abc/check-runs')]: { check_runs: [{ status: 'completed', conclusion: 'failure', html_url: 'https://run' }] },
    [GH('commits/abc/status')]: { statuses: [] },
    'gh graphql': ghThreads([{ isResolved: false, comments: { nodes: [{ author: { login: 'anna' }, createdAt: '2026-11-18T10:00:00Z' }] } }]),
    [GH('issues/42/comments')]: [],
    [GH('pulls/42/reviews')]: [],
    [GH('issues/42/events')]: [],
    [GH('git/commits/abc')]: { committer: { date: '2026-11-18T09:00:00Z' } },
  });
  const s = await mrState({ host: 'github.com', project: 'acme/billing', number: 42 }, { exec: x, profile });
  assert.deepEqual([s.turn, s.why], ['me', 'CI упал, конфликты с main, 1 новая реплика']);
  assert.deepEqual([s.facts.ci, s.facts.ciUrl, s.facts.replies, s.facts.ref], ['failed', 'https://run', 1, 'acme/billing#42']);
  const light = fake({
    [GH('pulls/42')]: ghPull(),
    [GH('commits/abc/check-runs')]: { check_runs: [] },
    [GH('commits/abc/status')]: { statuses: [{ state: 'success' }] },
    'gh graphql': ghThreads([]),
  });
  const l = await mrState({ host: 'github.com', project: 'acme/billing', number: 42, me: 'me-gh' }, { exec: light.x, depth: 'attention' });
  assert.deepEqual([l.exists, l.facts.ci, l.facts.depth], [true, 'success', 'attention']);
  assert.ok(!light.calls.some((c) => /issues|reviews|git\/commits/.test(c)));
  assert.ok(calls.length > light.calls.length);
});

test('GitHub: чужой PR — ревью запрошено заново событием, после моего approve', async () => {
  const { x } = fake({
    'gh user': { login: 'me-gh' },
    [GH('pulls/42')]: ghPull(),
    [GH('commits/abc/check-runs')]: { check_runs: [] },
    [GH('commits/abc/status')]: { statuses: [] },
    'gh graphql': ghThreads([]),
    [GH('issues/42/comments')]: [{ user: { login: 'ivan' }, created_at: '2026-11-18T09:00:00Z' }],
    [GH('pulls/42/reviews')]: [{ user: { login: 'me-gh' }, submitted_at: '2026-11-18T10:00:00Z', state: 'CHANGES_REQUESTED' }],
    [GH('issues/42/events')]: [{ event: 'review_requested', created_at: '2026-11-18T08:00:00Z', requested_reviewer: { login: 'me-gh' } }, { event: 'review_requested', created_at: '2026-11-18T12:00:00Z', requested_reviewer: { login: 'me-gh' } }, { event: 'labeled', created_at: '2026-11-18T13:00:00Z' }],
    [GH('git/commits/abc')]: { committer: { date: '2026-11-18T09:30:00Z' } },
  });
  const s = await mrState({ host: 'github.com', project: 'acme/billing', number: 42 }, { exec: x, profile });
  assert.deepEqual([s.turn, s.why], ['me', 'ревью запрошено заново']);
});

test('GitHub: смёржен (merged_at) и закрыт без мёржа', async () => {
  const merged = fake({ 'gh user': { login: 'me-gh' }, [GH('pulls/42')]: ghPull({ state: 'closed', merged_at: '2026-11-18T12:00:00Z' }) });
  assert.equal((await mrState({ host: 'github.com', project: 'acme/billing', number: 42 }, { exec: merged.x, profile })).closed, 'merged');
  const closed = fake({ 'gh user': { login: 'me-gh' }, [GH('pulls/42')]: ghPull({ state: 'closed', merged_at: null }) });
  assert.equal((await mrState({ host: 'github.com', project: 'acme/billing', number: 42 }, { exec: closed.x, profile })).closed, 'closed');
});

test('профиль без логина GitLab — «я» берётся из glab', async () => {
  // другой хост: логин пользователя на хосте кэшируется в git.ts
  const { x } = fake({ 'glab user': { username: 'me-server' }, [GL()]: glMr({ reviewers: [] }), [`${GL()}/discussions`]: [{ resolvable: true, notes: [{ author: { username: 'me-server' }, created_at: '2026-11-18T10:00:00Z' }] }], [`${GL()}/commits`]: [] });
  const s = await mrState({ host: 'gl-other.test', project: 'g/app', number: 7 }, { exec: x, profile: () => ({ names: [], emails: [] }) });
  assert.deepEqual([s.turn, s.why], ['others', 'ждёт автора']);
});

// ---------- наблюдатель целиком

const thing = (over: Partial<Thing> = {}): Thing => ({ type: 'mr', key: mrKeyOf('GL.test', 'g/app/', 7), ref: { host: 'gl.test', project: 'g/app', number: 7 }, ...over });

test('ключ MR: хост в нижнем регистре, путь без «/» по краям; ссылка берётся из ref или разбирается из ключа', () => {
  assert.equal(mrKeyOf('GL.test', '/g/app/', 7), 'mr:gl.test/g/app/7');
  assert.deepEqual(forgeRefOf({ type: 'mr', key: 'mr:gl.test/g/sub/app/7', ref: {} }), { host: 'gl.test', project: 'g/sub/app', number: 7 });
  assert.equal(typeof forgeRefOf({ type: 'mr', key: 'mr:oops', ref: {} }), 'string');
  assert.equal(forgeRefOf({ type: 'jira', key: 'jira:h/A-1', ref: {} }), 'не MR');
});

test('forgeWatcher: тип mr, canWatch, состояния по ключам; недоступная вещь — в карте с error; прерванная проверка не ходит в сеть', async () => {
  const { x, calls } = fake({
    'glab user': { username: 'me' },
    [GL()]: glMr(),
    [`${GL()}/discussions`]: [],
    [`${GL()}/commits`]: [],
    [GL(8)]: new Error('glab api: 404 Not Found'),
  });
  const w = forgeWatcher({ exec: x, profile });
  assert.equal(w.type, 'mr');
  assert.equal(w.canWatch(thing()), true);
  assert.equal(w.canWatch({ type: 'mr', key: 'bad', ref: {} }), 'у MR нет host, project и number');
  const missing = thing({ key: 'mr:gl.test/g/app/8', ref: { host: 'gl.test', project: 'g/app', number: 8 } });
  const states = await w.state([thing(), missing], new AbortController().signal);
  assert.deepEqual([...states.keys()], [thing().key, missing.key]);
  assert.equal(states.get(thing().key)!.turn, 'me');
  assert.equal(states.get(missing.key)!.exists, false);
  assert.match(states.get(missing.key)!.error!, /не найден на gl\.test/);
  const before = calls.length;
  const ac = new AbortController();
  ac.abort();
  const stopped = await w.state([thing()], ac.signal);
  assert.equal(stopped.get(thing().key)!.error, 'проверка прервана');
  assert.equal(calls.length, before);
});

test('mrLifecycle: один запрос; merged_at у GitHub, state у GitLab', async () => {
  const gh = fake({ [GH('pulls/1')]: { state: 'closed', merged_at: '2026-11-18T12:00:00Z' }, [GH('pulls/2')]: { state: 'closed', merged_at: null }, [GH('pulls/3')]: { state: 'open' } });
  assert.deepEqual(await Promise.all([1, 2, 3].map((n) => mrLifecycle({ host: 'github.com', project: 'acme/billing', number: n }, gh.x))), ['merged', 'closed', 'open']);
  const gl = fake({ [GL(1)]: { state: 'merged' }, [GL(2)]: { state: 'opened' } });
  assert.deepEqual(await Promise.all([1, 2].map((n) => mrLifecycle({ host: 'gl.test', project: 'g/app', number: n }, gl.x))), ['merged', 'open']);
});
