import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Exec } from '../git.js';
import { branchWatcher } from './branch.js';
import type { Thing } from './types.js';

const signal = new AbortController().signal;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-branch-'));
const key = `branch:${root}#feat/x`;
const thing = (branch = 'feat/x'): Thing => ({ type: 'branch', key: `branch:${root}#${branch}`, ref: { root, branch } });

type Repo = {
  branches?: Record<string, { upstream?: string }>;
  /** Вывод `git status --porcelain` в папке, где открыта ветка. */
  status?: string;
  /** Сколько коммитов ветка опережает ref, и сколько отстаёт: «ref» → [ahead, behind]. */
  counts?: Record<string, [number, number]>;
  /** Ответ forge на список MR по ветке; ошибка — строка. */
  mrs?: unknown[] | string;
  remote?: string;
  worktree?: string;
};

/** Фейковые git и glab: ответы по аргументам, журнал вызовов. */
function fake(r: Repo): { x: Exec; calls: string[] } {
  const calls: string[] = [];
  const x: Exec = async (cmd, args, opts) => {
    const line = [cmd, ...args].join(' ');
    calls.push(`${opts?.cwd ?? ''}|${line}`);
    if (cmd === 'glab') {
      if (typeof r.mrs === 'string') throw new Error(`glab api: ${r.mrs}`);
      return JSON.stringify(r.mrs ?? []);
    }
    if (args[0] === 'for-each-ref') return Object.entries(r.branches ?? { 'feat/x': {} }).map(([n, b]) => [n, b.upstream ?? '', '2026-11-10T10:00:00+00:00', 'тема', ''].join('\0')).join('\n');
    if (args[0] === 'worktree') return `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n\n${r.worktree ? `worktree ${r.worktree}\nHEAD def\nbranch refs/heads/feat/x\n` : ''}`;
    if (args[0] === 'status') return r.status ?? '';
    if (args[0] === 'symbolic-ref') return 'origin/main\n';
    if (args[0] === 'remote') {
      if (r.remote === '') throw new Error('no remote');
      return `${r.remote ?? 'git@gitlab.example.com:team/app.git'}\n`;
    }
    if (args[0] === 'rev-list') {
      const ref = args.at(-1)!.split('...')[1];
      const c = r.counts?.[ref];
      if (!c) throw new Error('unknown revision');
      return `${c[0]}\t${c[1]}\n`;
    }
    throw new Error(`неожиданная команда: ${line}`);
  };
  return { x, calls };
}

const run = async (r: Repo, t: Thing = thing()) => {
  const f = fake(r);
  const st = (await branchWatcher({ exec: f.x, now: () => Date.parse('2026-11-18T12:00:00Z') }).state([t], signal)).get(t.key)!;
  return { st, calls: f.calls };
};

test('ветка: грязный checkout — мой ход, сколько файлов; MR не спрашиваем', async () => {
  const { st, calls } = await run({ worktree: '/wt/feat', status: ' M a.ts\n?? b.ts\nUU c.ts\n', counts: { 'origin/main': [2, 0] } });
  assert.equal(st.turn, 'me');
  assert.equal(st.closed, undefined);
  assert.equal(st.why, '3 файла не закоммичено, конфликтов: 1');
  assert.equal(st.facts.dirty, 3);
  assert.equal(st.facts.untracked, 1);
  assert.equal(st.facts.worktree, '/wt/feat');
  assert.ok(calls.some((c) => c.startsWith('/wt/feat|git status')));
  assert.ok(!calls.some((c) => c.startsWith('glab')));
});

test('ветка: не открыта ни в одном checkout — чистая, git status не зовём', async () => {
  const { st, calls } = await run({ status: ' M ignored\n', counts: { 'origin/main': [0, 3] } });
  assert.equal(st.facts.dirty, 0);
  assert.ok(!calls.some((c) => c.includes('git status')));
});

test('ветка: впереди upstream — мой ход «не отправлено», позади — в хвосте why', async () => {
  const { st } = await run({ branches: { 'feat/x': { upstream: 'origin/feat/x' } }, counts: { 'origin/feat/x': [2, 1], 'origin/main': [2, 0] }, mrs: [] });
  assert.equal(st.turn, 'me');
  assert.equal(st.why, '2 коммита не отправлено в origin/feat/x · позади upstream на 1 коммит');
  assert.equal(st.facts.ahead, 2);
  assert.equal(st.facts.behind, 1);
});

test('ветка: чистая, отправлена, MR нет — мой ход «без MR»', async () => {
  const { st, calls } = await run({ branches: { 'feat/x': { upstream: 'origin/feat/x' } }, counts: { 'origin/feat/x': [0, 0], 'origin/main': [3, 0] }, mrs: [] });
  assert.equal(st.turn, 'me');
  assert.equal(st.closed, undefined);
  assert.equal(st.why, 'в ветке 3 коммита без MR');
  const mrCall = calls.find((c) => c.startsWith('|glab'))!;
  assert.match(mrCall, /--hostname gitlab\.example\.com projects\/team%2Fapp\/merge_requests\?source_branch=feat%2Fx&state=all/);
});

test('ветка: чистая и есть открытый MR — закрыта (done), MR в facts', async () => {
  const { st } = await run({ branches: { 'feat/x': { upstream: 'origin/feat/x' } }, counts: { 'origin/feat/x': [0, 0], 'origin/main': [3, 0] }, mrs: [{ iid: 12, title: 'T', web_url: 'https://gitlab.example.com/team/app/-/merge_requests/12', state: 'opened' }] });
  assert.equal(st.closed, 'done');
  assert.equal(st.turn, 'none');
  assert.equal(st.why, 'ветка чистая, MR 12 открыт');
  assert.deepEqual(st.facts.mr, { iid: 12, url: 'https://gitlab.example.com/team/app/-/merge_requests/12', title: 'T', state: 'opened' });
});

test('ветка: MR смержен (squash: коммитов сверх базы много, upstream удалён) — закрыта как merged', async () => {
  const { st } = await run({ counts: { 'origin/main': [4, 9] }, mrs: [{ iid: 7, web_url: 'u', state: 'merged' }] });
  assert.equal(st.closed, 'merged');
  assert.equal(st.turn, 'none');
  assert.match(st.why, /^MR 7 смержен, ветка чистая/);
});

test('ветка: открытый MR важнее закрытого, закрытый без слияния — снова мой ход', async () => {
  const both = await run({ counts: { 'origin/main': [1, 0] }, mrs: [{ iid: 1, web_url: 'u1', state: 'closed' }, { iid: 2, web_url: 'u2', state: 'opened' }] });
  assert.equal(both.st.closed, 'done');
  assert.equal((both.st.facts.mr as { iid: number }).iid, 2);
  const closedOnly = await run({ counts: { 'origin/main': [1, 0] }, mrs: [{ iid: 1, web_url: 'u1', state: 'closed' }] });
  assert.equal(closedOnly.st.turn, 'me');
  assert.equal(closedOnly.st.closed, undefined);
  assert.equal(closedOnly.st.why, 'MR 1 закрыт без слияния, в ветке 1 коммит');
});

test('ветка: чистая и без новых коммитов — закрыта без обращения к forge', async () => {
  const { st, calls } = await run({ counts: { 'origin/main': [0, 5] } });
  assert.equal(st.closed, 'done');
  assert.equal(st.why, 'ветка чистая, нового в ней нет');
  assert.ok(!calls.some((c) => c.includes('glab')));
});

test('ветка: forge недоступен — не закрываем, причина в why и в facts', async () => {
  const { st } = await run({ branches: { 'feat/x': { upstream: 'origin/feat/x' } }, counts: { 'origin/feat/x': [0, 0], 'origin/main': [2, 0] }, mrs: 'не авторизован: выполните glab auth login' });
  assert.equal(st.exists, true);
  assert.equal(st.closed, undefined);
  assert.equal(st.turn, 'none');
  assert.match(st.why, /в ветке 2 коммита; MR проверить не удалось: glab api: не авторизован/);
  assert.match(String(st.facts.mrError), /glab auth login/);
  const noOrigin = await run({ branches: { 'feat/x': { upstream: 'origin/feat/x' } }, counts: { 'origin/feat/x': [0, 0], 'origin/main': [2, 0] }, remote: '' });
  assert.match(noOrigin.st.why, /у репозитория нет origin/);
});

test('ветка: GitHub — PR по head owner:ветка, merged_at значит «смержен»', async () => {
  const f = fake({ counts: { 'origin/main': [2, 0] }, remote: 'git@github.com:acme/app.git', mrs: [{ number: 5, html_url: 'https://github.com/acme/app/pull/5', title: 'T', state: 'closed', merged_at: '2026-11-10T00:00:00Z' }] });
  const x: Exec = (cmd, args, o) => f.x(cmd === 'gh' ? 'glab' : cmd, args, o);
  const st = (await branchWatcher({ exec: x }).state([thing()], signal)).get(key)!;
  assert.equal(st.closed, 'merged');
  assert.ok(f.calls.some((c) => c.includes('repos/acme/app/pulls?state=all') && c.includes('head=acme%3Afeat%2Fx')));
});

test('ветка: нет ветки, нет папки, git упал — exists: false с понятной error, без исключений', async () => {
  const missing = await run({ branches: { other: {} } });
  assert.equal(missing.st.exists, false);
  assert.match(missing.st.error!, /ветки feat\/x нет в /);

  const w = branchWatcher({ exec: fake({}).x });
  const nodir: Thing = { type: 'branch', key: 'branch:/нет/такой#b', ref: { root: '/нет/такой', branch: 'b' } };
  assert.match(String(w.canWatch(nodir)), /папки репозитория нет на диске/);
  const m = await w.state([nodir], signal);
  assert.equal(m.get(nodir.key)!.exists, false);
  assert.match(m.get(nodir.key)!.error!, /папки репозитория нет/);

  const broken = branchWatcher({
    exec: async () => {
      throw new Error('git for-each-ref: not a git repository');
    },
  });
  const st = (await broken.state([thing()], signal)).get(key)!;
  assert.equal(st.exists, false);
  assert.match(st.error!, /не прочитался: git for-each-ref: not a git repository/);
});

test('ветка: canWatch — тип и поля', () => {
  const w = branchWatcher({ exec: fake({}).x });
  assert.equal(w.canWatch(thing()), true);
  assert.equal(w.canWatch({ type: 'mr', key: 'k', ref: {} }), 'не ветка');
  assert.match(String(w.canWatch({ type: 'branch', key: 'k', ref: { root } })), /нет корня репозитория или имени ветки/);
});
