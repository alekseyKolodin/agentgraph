// Автоматика статусов Teamwork (spec §10): каждый переход таблицы, только вперёд, по смене pr.state; опрос PR через
// поддельный exec (gh и glab), сервис команды — задачи в памяти. Сети и git нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TeamTask, TeamTaskPatch, TeamTaskWork } from './api-types.js';
import type { Exec } from './git.js';
import { fetchPrState, parseTeamworkLink, prBelongsTo, prNumber, prPatch, runEndPatch, startPatch, TeamworkStatus, watched, type StatusService } from './teamwork-status.js';
import { TeamError } from './teamwork-repo.js';

function task(over: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'PAY-1', title: 'Выгрузка CSV', type: 'feature', status: 'todo', rank: 'V', blockedBy: [], covers: [], body: '', acceptance: { done: 0, total: 0 }, comments: 0,
    base: 'h', file: 'projects/export/tasks/PAY-1.md', ...over,
  };
}

type Fake = {
  svc: StatusService;
  patches: { id: string; patch: TeamTaskPatch }[];
  work: Record<string, TeamTaskWork[]>;
  tasks: Record<string, TeamTask[]>;
};

/** Сервис в памяти: одна команда team, проекты по ключам tasks; патч применяется к задаче, чтобы следующий опрос видел новое состояние. */
function fake(tasks: Record<string, TeamTask[]>, o: { me?: string; repos?: Record<string, { key: string; url: string }[]>; failUpdate?: string } = {}): Fake {
  const patches: Fake['patches'] = [];
  const work: Fake['work'] = {};
  const svc: StatusService = {
    teams: () => ['team'],
    projects: () => Object.keys(tasks),
    repos: (_t, p) => o.repos?.[p] ?? [{ key: 'billing', url: 'git@github.com:acme/billing.git' }],
    me: async () => o.me,
    tasks: (_t, p) => tasks[p] ?? [],
    task: (_t, p, id) => {
      const t = tasks[p]?.find((x) => x.id === id);
      if (!t) throw new TeamError(404, `Задачи ${id} нет в проекте ${p}`);
      return t;
    },
    updateTask: async (_t, p, id, patch) => {
      if (o.failUpdate === id) throw new TeamError(409, 'Задачу уже изменил кто-то другой', 'conflict');
      patches.push({ id, patch });
      const t = tasks[p].find((x) => x.id === id)!;
      if (patch.status) t.status = patch.status;
      if (patch.assignee) t.assignee = patch.assignee;
      if (patch.pr) t.pr = { url: patch.pr.url, state: patch.pr.state ?? 'open' };
      return t;
    },
    recordWork: (_t, id, w) => {
      work[id] = [...(work[id] ?? []).filter((x) => !(x.kind === w.kind && x.id === w.id)), w];
    },
  };
  return { svc, patches, work, tasks };
}

const ghList = (prs: { number: number; branch: string }[]) => JSON.stringify(prs.map((p) => ({ number: p.number, title: `PR ${p.number}`, head: { ref: p.branch }, base: { ref: 'main' }, html_url: `https://github.com/acme/billing/pull/${p.number}`, user: { login: 'alex' } })));

/** Поддельные gh и glab: ответы по хвосту пути API; calls — что спрашивали. */
function fakeExec(answers: Record<string, string | Error>): { x: Exec; calls: string[] } {
  const calls: string[] = [];
  const x: Exec = async (cmd, args) => {
    const key = `${cmd} ${args.at(-1)}`;
    calls.push(key);
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`${cmd}: неожиданный вызов ${key}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
  return { x, calls };
}

const link = { team: 'team', project: 'export', task: 'PAY-1' };

test('startPatch: «К работе» → «В работе» и исполнитель, если пусто; из других статусов — только исполнитель; нечего менять — undefined', () => {
  assert.deepEqual(startPatch(task(), 'me@x'), { status: 'in_progress', assignee: 'me@x' });
  assert.deepEqual(startPatch(task({ assignee: 'bob@x' }), 'me@x'), { status: 'in_progress' });
  assert.deepEqual(startPatch(task({ status: 'review' }), 'me@x'), { assignee: 'me@x' });
  assert.equal(startPatch(task({ status: 'in_progress', assignee: 'bob@x' }), 'me@x'), undefined);
  // git не знает email — исполнитель не ставится
  assert.deepEqual(startPatch(task()), { status: 'in_progress' });
});

test('runEndPatch: done из «В работе» — «Ревью»; упал, остановлен, или задача уже в ревью/готово — без перехода', () => {
  assert.deepEqual(runEndPatch(task({ status: 'in_progress' }), 'done'), { status: 'review' });
  for (const s of ['failed', 'stopped', 'aborted', 'interrupted']) assert.equal(runEndPatch(task({ status: 'in_progress' }), s), undefined, s);
  assert.equal(runEndPatch(task({ status: 'review' }), 'done'), undefined);
  assert.equal(runEndPatch(task({ status: 'done' }), 'done'), undefined);
  // запуск кончился, а задачу вернули в «К работе» руками: автоматика не двигает её вперёд через колонку
  assert.equal(runEndPatch(task({ status: 'todo' }), 'done'), undefined);
});

test('prPatch: открыт — «Ревью» из «К работе» и «В работе»; смёржен — «Готово» из любого; закрыт — только состояние; то же наблюдение — ничего', () => {
  const open = { url: 'https://github.com/acme/billing/pull/42', state: 'open' as const };
  assert.deepEqual(prPatch(task(), open), { pr: open, status: 'review' });
  assert.deepEqual(prPatch(task({ status: 'in_progress' }), open), { pr: open, status: 'review' });
  assert.deepEqual(prPatch(task({ status: 'review' }), open), { pr: open });
  assert.deepEqual(prPatch(task({ status: 'done' }), open), { pr: open });
  const merged = { ...open, state: 'merged' as const };
  for (const s of ['todo', 'in_progress', 'review'] as const) assert.deepEqual(prPatch(task({ status: s, pr: open }), merged), { pr: merged, status: 'done' }, s);
  assert.deepEqual(prPatch(task({ status: 'done', pr: open }), merged), { pr: merged });
  const closed = { ...open, state: 'closed' as const };
  assert.deepEqual(prPatch(task({ status: 'review', pr: open }), closed), { pr: closed });
  // повторное наблюдение того же PR в том же состоянии ничего не пишет — и после ручного возврата назад
  assert.equal(prPatch(task({ status: 'review', pr: open }), open), undefined);
  assert.equal(prPatch(task({ status: 'in_progress', pr: open }), open), undefined);
  assert.equal(prPatch(task({ status: 'review', pr: merged }), merged), undefined);
  // другой PR по той же ветке — новое наблюдение
  assert.deepEqual(prPatch(task({ status: 'in_progress', pr: closed }), { url: 'https://github.com/acme/billing/pull/43', state: 'open' }), { pr: { url: 'https://github.com/acme/billing/pull/43', state: 'open' }, status: 'review' });
});

test('watched: опрашиваются «В работе» и «Ревью» с веткой; без ветки, в бэклоге, готовые, со смёрженным PR и битые — нет', () => {
  assert.equal(watched(task({ status: 'in_progress', branch: 'tw/PAY-1' })), true);
  assert.equal(watched(task({ status: 'review', branch: 'tw/PAY-1' })), true);
  assert.equal(watched(task({ status: 'in_progress' })), false);
  assert.equal(watched(task({ status: 'todo', branch: 'tw/PAY-1' })), false);
  assert.equal(watched(task({ status: 'done', branch: 'tw/PAY-1' })), false);
  assert.equal(watched(task({ status: 'review', branch: 'tw/PAY-1', pr: { url: 'u', state: 'merged' } })), false);
  assert.equal(watched(task({ status: 'review', branch: 'tw/PAY-1', error: 'нет frontmatter' })), false);
});

test('prNumber: pull, pulls и merge_requests с хвостом; без номера — undefined', () => {
  assert.equal(prNumber('https://github.com/acme/billing/pull/42'), 42);
  assert.equal(prNumber('https://github.com/acme/billing/pulls/42/files'), 42);
  assert.equal(prNumber('https://gitlab.example.com/g/app/-/merge_requests/7#note_1'), 7);
  assert.equal(prNumber('https://github.com/acme/billing'), undefined);
  assert.equal(prNumber('https://github.com/acme/billing/pull/abc'), undefined);
});

test('fetchPrState: gh — merged_at даёт merged, closed без него — closed; glab — по state; ссылка без номера — undefined', async () => {
  const gh = fakeExec({ 'gh repos/acme/billing/pulls/42': JSON.stringify({ state: 'closed', merged_at: '2026-11-12T10:00:00Z' }), 'gh repos/acme/billing/pulls/43': JSON.stringify({ state: 'closed', merged_at: null }), 'gh repos/acme/billing/pulls/44': JSON.stringify({ state: 'open' }) });
  const remote = { host: 'github.com', path: 'acme/billing' };
  assert.equal(await fetchPrState(remote, 'https://github.com/acme/billing/pull/42', gh.x), 'merged');
  assert.equal(await fetchPrState(remote, 'https://github.com/acme/billing/pull/43', gh.x), 'closed');
  assert.equal(await fetchPrState(remote, 'https://github.com/acme/billing/pull/44', gh.x), 'open');
  assert.equal(await fetchPrState(remote, 'https://github.com/acme/billing', gh.x), undefined);
  assert.deepEqual(gh.calls, ['gh repos/acme/billing/pulls/42', 'gh repos/acme/billing/pulls/43', 'gh repos/acme/billing/pulls/44']);
  const gl = fakeExec({ 'glab projects/g%2Fapp/merge_requests/7': JSON.stringify({ state: 'merged' }), 'glab projects/g%2Fapp/merge_requests/8': JSON.stringify({ state: 'opened' }) });
  const glRemote = { host: 'gitlab.example.com', path: 'g/app' };
  assert.equal(await fetchPrState(glRemote, 'https://gitlab.example.com/g/app/-/merge_requests/7', gl.x), 'merged');
  assert.equal(await fetchPrState(glRemote, 'https://gitlab.example.com/g/app/-/merge_requests/8', gl.x), 'open');
});

test('parseTeamworkLink: нет поля — undefined; слаги и номер проверяются; draft только из трёх видов; лишнее не копируется', () => {
  assert.equal(parseTeamworkLink(undefined), undefined);
  assert.equal(parseTeamworkLink(null), undefined);
  assert.deepEqual(parseTeamworkLink({ team: 'team', project: 'export', task: ' PAY-12 ', extra: 1 }), { team: 'team', project: 'export', task: 'PAY-12' });
  assert.deepEqual(parseTeamworkLink({ team: 'team', project: 'export', draft: 'prd', section: 'Требования' }), { team: 'team', project: 'export', draft: 'prd', section: 'Требования' });
  for (const bad of ['x', { team: '../x', project: 'p' }, { team: 't', project: 'P P' }, { team: 't', project: 'p', task: 'pay-1' }, { team: 't', project: 'p', task: 7 }, { team: 't', project: 'p', draft: 'tasks' }, { team: 't' }]) {
    assert.throws(() => parseTeamworkLink(bad), Error, JSON.stringify(bad));
  }
});

test('started: запись в work, «К работе» → «В работе» и исполнитель; повтор с той же задачей в работе — только work; без task — ничего; сбой записи не бросает', async () => {
  const f = fake({ export: [task()] }, { me: 'me@x' });
  const logs: string[] = [];
  const st = new TeamworkStatus({ service: f.svc, timers: false, now: () => new Date('2026-11-12T10:00:00Z'), log: (l) => logs.push(l) });
  await st.started(link, { kind: 'run', id: 'r1', status: 'running' });
  assert.deepEqual(f.patches, [{ id: 'PAY-1', patch: { status: 'in_progress', assignee: 'me@x' } }]);
  assert.deepEqual(f.work['PAY-1'], [{ kind: 'run', id: 'r1', status: 'running', at: '2026-11-12T10:00:00.000Z' }]);
  await st.started(link, { kind: 'session', id: 's1', status: 'starting', title: 'Сессия', at: '2026-11-12T10:01:00.000Z' });
  assert.equal(f.patches.length, 1);
  assert.deepEqual(f.work['PAY-1'].map((w) => w.id), ['r1', 's1']);
  await st.started({ team: 'team', project: 'export', draft: 'prd' }, { kind: 'run', id: 'r2' });
  assert.equal(Object.keys(f.work).length, 1);
  // задачи нет — в лог, не исключение
  await st.started({ ...link, task: 'PAY-9' }, { kind: 'run', id: 'r3' });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /PAY-9: старт работы не записан — Задачи PAY-9 нет/);
  assert.deepEqual(logs, logs.filter((l) => l.startsWith('teamwork: ')));
});

test('ended: done — «В работе» → «Ревью» и статус в work; упавший — только work; конец сессии — только work; задача в ревью — ничего', async () => {
  const f = fake({ export: [task({ status: 'in_progress', assignee: 'me@x' })] });
  const st = new TeamworkStatus({ service: f.svc, timers: false });
  await st.ended(link, { kind: 'run', id: 'r1', status: 'failed' });
  assert.deepEqual(f.patches, []);
  assert.equal(f.work['PAY-1'][0].status, 'failed');
  await st.ended(link, { kind: 'run', id: 'r2', status: 'done', title: 'Выгрузка' });
  assert.deepEqual(f.patches, [{ id: 'PAY-1', patch: { status: 'review' } }]);
  assert.deepEqual(f.work['PAY-1'].map((w) => [w.id, w.status]), [['r1', 'failed'], ['r2', 'done']]);
  await st.ended(link, { kind: 'run', id: 'r3', status: 'done' });
  assert.equal(f.patches.length, 1);
  await st.ended(link, { kind: 'session', id: 's1', status: 'ended' });
  assert.equal(f.patches.length, 1);
  assert.equal(f.work['PAY-1'].at(-1)!.kind, 'session');
  // check: задача есть — она же; нет — 404; битая — 400
  assert.equal(st.check(link)!.id, 'PAY-1');
  assert.throws(() => st.check({ ...link, task: 'PAY-9' }), (e: TeamError) => e.status === 404);
  f.tasks.export.push(task({ id: 'PAY-2', error: 'нет frontmatter' }));
  assert.throws(() => st.check({ ...link, task: 'PAY-2' }), (e: TeamError) => e.status === 400);
  assert.equal(st.check({ team: 'team', project: 'export' }), undefined);
});

test('опрос PR (gh): без задач в работе gh не зовётся; открытый PR по ветке — ссылка и «Ревью»; то же наблюдение — без записи; пропавший из открытых — точный запрос: смёржен → «Готово»', async () => {
  const branch = 'tw/PAY-1-csv';
  const f = fake({ export: [task({ status: 'todo', branch }), task({ id: 'PAY-2', status: 'in_progress' })] });
  const x = fakeExec({ 'gh repos/acme/billing/pulls?state=open': ghList([{ number: 42, branch }]), 'gh repos/acme/billing/pulls/42': JSON.stringify({ state: 'closed', merged_at: '2026-11-12T12:00:00Z' }) });
  const st = new TeamworkStatus({ service: f.svc, exec: x.x, timers: false, log: () => {} });
  // в работе никого с веткой: сети нет
  assert.deepEqual(await st.poll(), { tasks: 0, requests: 0, changed: [], errors: [] });
  assert.deepEqual(x.calls, []);
  f.tasks.export[0].status = 'in_progress';
  const r1 = await st.poll();
  assert.deepEqual([r1.tasks, r1.requests, r1.changed, r1.errors], [1, 1, ['PAY-1'], []]);
  assert.deepEqual(f.patches, [{ id: 'PAY-1', patch: { pr: { url: 'https://github.com/acme/billing/pull/42', state: 'open' }, status: 'review' } }]);
  // тот же PR открыт: ничего не пишется, даже если задачу вернули в «В работе» руками
  f.tasks.export[0].status = 'in_progress';
  const r2 = await st.poll();
  assert.deepEqual([r2.changed, r2.requests], [[], 1]);
  assert.equal(f.patches.length, 1);
  assert.equal(f.tasks.export[0].status, 'in_progress');
  // PR смёржили: в списке открытых его нет, точный запрос — merged, задача «Готово» из любого статуса
  x.calls.length = 0;
  const merged = fakeExec({ 'gh repos/acme/billing/pulls?state=open': ghList([]), 'gh repos/acme/billing/pulls/42': JSON.stringify({ state: 'closed', merged_at: '2026-11-12T12:00:00Z' }) });
  const st2 = new TeamworkStatus({ service: f.svc, exec: merged.x, timers: false, log: () => {} });
  const r3 = await st2.poll();
  assert.deepEqual([r3.requests, r3.changed], [2, ['PAY-1']]);
  assert.deepEqual(f.patches.at(-1), { id: 'PAY-1', patch: { pr: { url: 'https://github.com/acme/billing/pull/42', state: 'merged' }, status: 'done' } });
  assert.deepEqual(merged.calls, ['gh repos/acme/billing/pulls?state=open&per_page=100&sort=updated&direction=desc', 'gh repos/acme/billing/pulls/42']);
  // готовую со смёрженным PR больше не смотрим
  assert.deepEqual(await st2.poll(), { tasks: 0, requests: 0, changed: [], errors: [] });
});

test('опрос PR (glab): закрытый без мёржа — только pr.state, статус остаётся; один запрос списка на remote для двух проектов; задача без repo при двух репо пропускается', async () => {
  const repos = [{ key: 'app', url: 'https://gitlab.example.com/g/app.git' }, { key: 'docs', url: 'https://gitlab.example.com/g/docs.git' }];
  const f = fake(
    {
      export: [task({ status: 'review', branch: 'tw/PAY-1-x', repo: 'app', pr: { url: 'https://gitlab.example.com/g/app/-/merge_requests/7', state: 'open' } }), task({ id: 'PAY-2', status: 'in_progress', branch: 'tw/PAY-2-y' })],
      other: [task({ id: 'PAY-3', status: 'in_progress', branch: 'tw/PAY-3-z', repo: 'app' })],
    },
    { repos: { export: repos, other: repos } },
  );
  const gl = JSON.stringify([{ iid: 9, title: 'z', source_branch: 'tw/PAY-3-z', target_branch: 'main', web_url: 'https://gitlab.example.com/g/app/-/merge_requests/9', references: { full: 'g/app!9' } }]);
  const x = fakeExec({ 'glab projects/g%2Fapp/merge_requests?state=opened': gl, 'glab projects/g%2Fapp/merge_requests/7': JSON.stringify({ state: 'closed' }) });
  const st = new TeamworkStatus({ service: f.svc, exec: x.x, timers: false, log: () => {} });
  const r = await st.poll();
  assert.deepEqual([r.tasks, r.requests, r.changed.sort(), r.errors], [3, 2, ['PAY-1', 'PAY-3'], []]);
  assert.deepEqual(f.patches.find((p) => p.id === 'PAY-1')!.patch, { pr: { url: 'https://gitlab.example.com/g/app/-/merge_requests/7', state: 'closed' } });
  assert.equal(f.tasks.export[0].status, 'review');
  assert.deepEqual(f.patches.find((p) => p.id === 'PAY-3')!.patch, { pr: { url: 'https://gitlab.example.com/g/app/-/merge_requests/9', state: 'open' }, status: 'review' });
  // список открытых спрашивали один раз, точный запрос — один
  assert.equal(x.calls.filter((c) => c.includes('state=opened')).length, 1);
  assert.equal(x.calls.filter((c) => c.endsWith('merge_requests/7')).length, 1);
});

test('опрос PR: gh не установлен — ошибка в отчёте и в лог один раз, задачи не трогаются, poll не бросает; сбой записи задачи — в ошибки', async () => {
  const f = fake({ export: [task({ status: 'in_progress', branch: 'tw/PAY-1-x' })] });
  const logs: string[] = [];
  const x = fakeExec({ 'gh repos/acme/billing/pulls?state=open': new Error('gh api: gh не установлен') });
  const st = new TeamworkStatus({ service: f.svc, exec: x.x, timers: false, log: (l) => logs.push(l) });
  const r = await st.poll();
  assert.deepEqual([r.tasks, r.changed, r.errors], [1, [], ['github.com/acme/billing: gh api: gh не установлен']]);
  await st.poll();
  assert.deepEqual(logs, ['teamwork: опрос PR github.com/acme/billing: gh api: gh не установлен']);
  assert.deepEqual(f.patches, []);
  const busy = fake({ export: [task({ status: 'in_progress', branch: 'tw/PAY-1-x' })] }, { failUpdate: 'PAY-1' });
  const ok = fakeExec({ 'gh repos/acme/billing/pulls?state=open': ghList([{ number: 1, branch: 'tw/PAY-1-x' }]) });
  const r2 = await new TeamworkStatus({ service: busy.svc, exec: ok.x, timers: false, log: () => {} }).poll();
  assert.deepEqual([r2.changed, r2.errors], [[], ['PAY-1: Задачу уже изменил кто-то другой']]);
});

test('опрос по таймеру: start с интервалом зовёт poll, stop снимает таймер; с timers: false таймера нет; параллельный poll не дублируется', async () => {
  const f = fake({ export: [task({ status: 'in_progress', branch: 'tw/PAY-1-x' })] });
  let calls = 0;
  let release: (() => void) | undefined;
  const x: Exec = async () => {
    calls++;
    await new Promise<void>((r) => {
      release = r;
    });
    return ghList([]);
  };
  const st = new TeamworkStatus({ service: f.svc, exec: x, timers: false, intervalMs: 5 });
  const a = st.poll();
  const b = st.poll();
  assert.equal(a, b);
  release!();
  await a;
  assert.equal(calls, 1);
  let ticks = 0;
  const timed = new TeamworkStatus({ service: f.svc, exec: async () => (ticks++, ghList([])), intervalMs: 5 });
  timed.start();
  // Под нагрузкой (полный npm test) таймер на 5 мс может не успеть дважды за фиксированную паузу — ждём условие, до 2 с.
  for (let waited = 0; ticks < 2 && waited < 2000; waited += 10) await new Promise((r) => setTimeout(r, 10));
  await timed.stop();
  assert.ok(ticks >= 2, `опросов по таймеру: ${ticks}`);
  const stopped = ticks;
  const after = f.patches.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ticks, stopped);
  assert.equal(f.patches.length, after);
  const off = new TeamworkStatus({ service: f.svc, exec: async () => ghList([{ number: 5, branch: 'tw/PAY-1-x' }]), timers: false, intervalMs: 5 });
  off.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.patches.length, after);
  await off.stop();
});

test('конец запуска, пришедший раньше записи старта, ждёт её: done после мгновенного запуска всё равно даёт «Ревью»', async () => {
  const f = fake({ export: [task()] }, { me: 'me@x' });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // me() держится: старт ещё пишется, когда приходит конец
  const slow: StatusService = { ...f.svc, me: () => gate.then(() => 'me@x') };
  const st = new TeamworkStatus({ service: slow, timers: false });
  const begun = st.started(link, { kind: 'run', id: 'r1', status: 'running' });
  const finished = st.ended(link, { kind: 'run', id: 'r1', status: 'done' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.patches.length, 0);
  release();
  await Promise.all([begun, finished]);
  assert.deepEqual(f.patches.map((p) => p.patch), [{ status: 'in_progress', assignee: 'me@x' }, { status: 'review' }]);
  assert.deepEqual(f.work['PAY-1'].map((w) => w.status), ['done']);
});

test('prBelongsTo: ссылка ведёт в remote репо — тот же хост и путь с хвостом PR; другой репо, другой хост или путь без хоста — нет', () => {
  const gh = { host: 'github.com', path: 'acme/billing' };
  assert.equal(prBelongsTo(gh, 'https://github.com/acme/billing/pull/42'), true);
  assert.equal(prBelongsTo(gh, 'https://GitHub.com/acme/billing/pulls/42/files'), true);
  assert.equal(prBelongsTo(gh, 'https://github.com/acme/billing-next/pull/42'), false);
  assert.equal(prBelongsTo(gh, 'https://github.com/other/repo/pull/3'), false);
  assert.equal(prBelongsTo(gh, 'https://gitlab.com/acme/billing/-/merge_requests/3'), false);
  assert.equal(prBelongsTo(gh, '/acme/billing/pull/42'), false);
  assert.equal(prBelongsTo({ host: 'gitlab.example.com', path: 'g/app' }, 'https://gitlab.example.com/g/app/-/merge_requests/7'), true);
});

test('опрос PR: ссылка в задаче ведёт в другой репозиторий — точного запроса нет, задача не меняется, причина в ошибках', async () => {
  const f = fake({ export: [task({ status: 'review', branch: 'tw/PAY-1-x', pr: { url: 'https://github.com/other/repo/pull/3', state: 'open' } })] });
  const x = fakeExec({ 'gh repos/acme/billing/pulls?state=open': ghList([]) });
  const r = await new TeamworkStatus({ service: f.svc, exec: x.x, timers: false, log: () => {} }).poll();
  assert.deepEqual([r.requests, r.changed], [1, []]);
  assert.deepEqual(r.errors, ['PAY-1 https://github.com/other/repo/pull/3: ссылка на PR ведёт не в репо github.com/acme/billing']);
  assert.deepEqual(x.calls, ['gh repos/acme/billing/pulls?state=open&per_page=100&sort=updated&direction=desc']);
  assert.deepEqual(f.patches, []);
});

test('stop дожидается идущих записей старта и конца: переход записан до остановки сервиса команды', async () => {
  const f = fake({ export: [task()] }, { me: 'me@x' });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const slow: StatusService = { ...f.svc, me: () => gate.then(() => 'me@x') };
  const st = new TeamworkStatus({ service: slow, timers: false });
  void st.started(link, { kind: 'run', id: 'r1', status: 'running' });
  void st.ended(link, { kind: 'run', id: 'r1', status: 'done' });
  const stopped = st.stop();
  let done = false;
  void stopped.then(() => {
    done = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false);
  release();
  await stopped;
  assert.deepEqual(f.patches.map((p) => p.patch), [{ status: 'in_progress', assignee: 'me@x' }, { status: 'review' }]);
});

test('D-14: запуск переименованной задачи кончился — переход у задачи, на которую переехала его работа, а не у старого номера', async () => {
  const f = fake({ export: [task({ id: 'PAY-1', status: 'in_progress', title: 'чужая' }), task({ id: 'PAY-7', status: 'in_progress', title: 'моя' })] });
  f.work['PAY-7'] = [{ kind: 'run', id: 'r1', status: 'running', at: 'x' }];
  const svc: StatusService = { ...f.svc, workTask: (_t, w) => Object.keys(f.work).find((id) => f.work[id].some((x) => x.kind === w.kind && x.id === w.id)) };
  await new TeamworkStatus({ service: svc, timers: false }).ended(link, { kind: 'run', id: 'r1', status: 'done' });
  assert.deepEqual(f.patches, [{ id: 'PAY-7', patch: { status: 'review' } }]);
  assert.equal(f.work['PAY-1'], undefined);
  assert.deepEqual(f.work['PAY-7'].map((w) => w.status), ['done']);
  // работа нигде не записана (задачу удалили, номер мог достаться чужой) — задачу по номеру из связи не трогаем
  const g = fake({ export: [task({ status: 'in_progress' })] });
  const logs: string[] = [];
  await new TeamworkStatus({ service: { ...g.svc, workTask: () => undefined }, timers: false, log: (l) => logs.push(l) }).ended(link, { kind: 'run', id: 'r2', status: 'done' });
  assert.deepEqual([g.patches, g.work], [[], {}]);
  assert.match(logs[0] ?? '', /запуска r2 нет в работе задач/);
});

test('D-16: stop не ждёт зависший опрос PR дольше срока; после stop опрос дальше по задачам не идёт', async () => {
  const f = fake({ export: [task({ status: 'in_progress', branch: 'tw/PAY-1-x' }), task({ id: 'PAY-2', status: 'in_progress', branch: 'tw/PAY-2-x', file: 'projects/export/tasks/PAY-2.md' })] });
  let calls = 0;
  const st = new TeamworkStatus({ service: f.svc, exec: () => (calls++, new Promise<string>(() => {})), timers: false });
  void st.poll();
  await new Promise((r) => setTimeout(r, 10));
  const started = Date.now();
  await st.stop(50);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(calls, 1);
});

test('D-14: вторая сессия по задаче записывается в work сразу, не дожидаясь, пока допишется старт первой', async () => {
  const f = fake({ export: [task()] }, { me: 'alex@example.com' });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const update = f.svc.updateTask;
  // старт первой сессии ждёт очередь клона (сетевой pull)
  f.svc.updateTask = async (...a) => {
    await gate;
    return update(...a);
  };
  const st = new TeamworkStatus({ service: f.svc, timers: false, log: () => {} });
  const link = { team: 'team', project: 'export', task: 'PAY-1' };
  const first = st.started(link, { kind: 'session', id: 's-1', status: 'running' });
  const second = st.started(link, { kind: 'session', id: 's-2', status: 'running' });
  // инструменты второй сессии ищут задачу по work — запись уже есть
  assert.deepEqual(f.work['PAY-1']?.map((w) => w.id), ['s-1', 's-2']);
  release();
  await Promise.all([first, second]);
  assert.equal(f.tasks.export[0].status, 'in_progress');
});
