import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyUntracked, ensureWorktree, forgeOf, forgeUser, getMergeRequest, glabMrPath, listMergeRequests, localBranches, mrDiscussions, parseRemote, repoRoot, slugify, type Exec } from './git.js';

test('remote: https, scp, ssh с портом, вложенные группы', () => {
  assert.deepEqual(parseRemote('https://gitlab.example.com/cafe/App.git'), { host: 'gitlab.example.com', path: 'cafe/App' });
  assert.deepEqual(parseRemote('git@gitlab.example.com:a/b/c/App.git'), { host: 'gitlab.example.com', path: 'a/b/c/App' });
  assert.deepEqual(parseRemote('ssh://git@gitlab.example.com:2222/a/b.git'), { host: 'gitlab.example.com', path: 'a/b' });
  assert.deepEqual(parseRemote('https://user@GitLab.Example.com/g/sub/app/'), { host: 'gitlab.example.com', path: 'g/sub/app' });
  assert.equal(parseRemote('/local/path/repo.git'), undefined);
  assert.equal(parseRemote('https://host/onlyname'), undefined);
});

test('slug и путь запроса MR', () => {
  assert.equal(slugify('feature/ABC-1 кнопка'), 'feature-ABC-1');
  assert.equal(slugify('../..'), 'wt');
  assert.equal(glabMrPath('a/b/c'), 'projects/a%2Fb%2Fc/merge_requests?state=opened&per_page=100&order_by=updated_at');
  assert.match(glabMrPath('a/b', { author: 'me' }), /&author_username=me$/);
});

test('MR через glab: «только мои» берёт пользователя из glab api user', async () => {
  const calls: string[][] = [];
  const x: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.at(-1) === 'user') return JSON.stringify({ username: 'me' });
    return JSON.stringify([{ iid: 3, title: 'T', description: null, source_branch: 's', target_branch: 'dev', author: { username: 'me' }, draft: false, web_url: 'https://h/g/a/-/merge_requests/3', references: { full: 'g/a!3' } }]);
  };
  const list = await listMergeRequests({ host: 'h', path: 'g/a' }, { mine: true }, x);
  assert.deepEqual(calls[0], ['glab', 'api', '--hostname', 'h', 'user']);
  assert.match(calls[1].at(-1)!, /author_username=me/);
  assert.equal(list[0].description, '');
  assert.equal(list[0].ref, 'g/a!3');
});

test('MR по iid: точный запрос, неверный номер отклоняется', async () => {
  const calls: string[][] = [];
  const x: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return JSON.stringify({ iid: 9, title: 'T', source_branch: 's', target_branch: 'dev', web_url: 'u' });
  };
  assert.equal((await getMergeRequest({ host: 'h', path: 'g/a' }, 9, x)).iid, 9);
  assert.deepEqual(calls[0], ['glab', 'api', '--hostname', 'h', 'projects/g%2Fa/merge_requests/9']);
  await assert.rejects(getMergeRequest({ host: 'h', path: 'g/a' }, NaN, x), /Неверный номер/);
});

test('MR: пайплайн, статус слияния и число заметок; обсуждения первой страницей на 100', async () => {
  const calls: string[][] = [];
  const x: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const p = args.at(-1)!;
    if (p.endsWith('/discussions?per_page=100')) {
      return JSON.stringify([
        { resolvable: true, resolved: false, notes: [{ author: { username: 'rev' }, system: false }, { author: { username: 'me' }, system: true }] },
        // старый GitLab: флаги только на заметках
        { notes: [{ author: { username: 'rev' }, resolvable: true, resolved: true }] },
      ]);
    }
    const one = { iid: 9, title: 'T', source_branch: 's', target_branch: 'dev', web_url: 'u', user_notes_count: 2, detailed_merge_status: 'conflict' };
    if (p.includes('/merge_requests/9')) return JSON.stringify({ ...one, head_pipeline: { status: 'failed', web_url: 'https://h/p/5' } });
    return JSON.stringify([one]);
  };
  const r = { host: 'h', path: 'g/a' };
  const full = await getMergeRequest(r, 9, x);
  assert.deepEqual(full.pipeline, { status: 'failed', url: 'https://h/p/5' });
  const [listed] = await listMergeRequests(r, {}, x);
  assert.deepEqual([listed.notesCount, listed.mergeStatus, listed.pipeline], [2, 'conflict', undefined]);
  const d = await mrDiscussions(r, 9, x);
  assert.deepEqual(calls.at(-1), ['glab', 'api', '--hostname', 'h', 'projects/g%2Fa/merge_requests/9/discussions?per_page=100']);
  assert.deepEqual(d[0], { resolvable: true, resolved: false, notes: [{ author: 'rev', system: false }, { author: 'me', system: true }] });
  assert.deepEqual([d[1].resolvable, d[1].resolved], [true, true]);
});

// --- настоящие временные репо: origin (bare) → клон

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();

function setup() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-git-')));
  const origin = path.join(tmp, 'origin.git');
  g(tmp, 'init', '--bare', '-b', 'dev', origin);
  const seed = path.join(tmp, 'seed');
  g(tmp, 'clone', '-q', origin, seed);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) g(seed, 'config', k, v);
  fs.writeFileSync(path.join(seed, 'a.txt'), '1');
  g(seed, 'add', '.');
  g(seed, 'commit', '-qm', 'init');
  g(seed, 'push', '-q', 'origin', 'HEAD:dev');
  g(seed, 'push', '-q', 'origin', 'HEAD:remote-only');
  const repo = path.join(tmp, 'App');
  g(tmp, 'clone', '-q', origin, repo);
  g(repo, 'branch', 'local-br');
  fs.writeFileSync(path.join(repo, 'local.properties'), 'sdk.dir=/x');
  return { tmp, repo, base: path.join(tmp, 'wt') };
}

test('worktree: локальная ветка, ветка из origin, новая от base, detached, переиспользование', async () => {
  const { tmp, repo, base } = setup();
  try {
    const a = await ensureWorktree({ root: repo, baseDir: base, branch: 'local-br', copyFiles: ['local.properties', '../escape', '/abs'] });
    assert.equal(a.path, path.join(base, 'App', 'local-br'));
    assert.equal(g(a.path, 'branch', '--show-current'), 'local-br');
    assert.deepEqual(a.copied, ['local.properties']);
    assert.equal(await repoRoot(a.path), repo);

    const b = await ensureWorktree({ root: repo, baseDir: base, branch: 'remote-only' });
    assert.equal(g(b.path, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/remote-only');

    const c = await ensureWorktree({ root: repo, baseDir: base, branch: 'feature/ABC-1-new' });
    assert.equal(c.path, path.join(base, 'App', 'feature-ABC-1-new'));
    assert.match(c.note, /новая ветка feature\/ABC-1-new от origin\/dev/);

    const d = await ensureWorktree({ root: repo, baseDir: base, name: 'scratch' });
    assert.equal(g(d.path, 'branch', '--show-current'), '');

    const again = await ensureWorktree({ root: repo, baseDir: base, branch: 'local-br' });
    assert.equal(again.created, false);
    assert.equal(again.path, a.path);

    const names = (await localBranches(repo)).map((b) => b.name);
    assert.ok(names.includes('feature/ABC-1-new'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worktree: ветка основного checkout, плохое имя, чужая папка — понятные ошибки', async () => {
  const { tmp, repo, base } = setup();
  try {
    await assert.rejects(ensureWorktree({ root: repo, baseDir: base, branch: 'dev' }), /уже выгружена в основном checkout/);
    await assert.rejects(ensureWorktree({ root: repo, baseDir: base, branch: 'gone', requireExisting: true }), /нет ни локально, ни в origin/);
    await assert.rejects(ensureWorktree({ root: repo, baseDir: base, branch: '-x' }), /Недопустимое имя ветки/);
    await assert.rejects(ensureWorktree({ root: repo, baseDir: base, branch: 'a..b' }), /Недопустимое имя ветки/);
    fs.mkdirSync(path.join(base, 'App', 'busy'), { recursive: true });
    await assert.rejects(ensureWorktree({ root: repo, baseDir: base, branch: 'busy' }), /не worktree проекта/);
    const w = await ensureWorktree({ root: repo, baseDir: base, branch: 'local-br' });
    await assert.rejects(ensureWorktree({ root: repo, baseDir: base, branch: 'other', name: 'local-br' }), /на ветке local-br/);
    assert.ok(fs.existsSync(w.path));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worktree: отставание локальной ветки от origin и сбой fetch видны в заметке', async () => {
  const { tmp, repo, base } = setup();
  try {
    // remote-only ушла вперёд в origin, а локальная копия осталась на старом коммите
    g(repo, 'branch', 'remote-only', 'origin/remote-only');
    const seed = path.join(tmp, 'seed');
    g(seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'new');
    g(seed, 'push', '-q', 'origin', 'HEAD:remote-only');
    const a = await ensureWorktree({ root: repo, baseDir: base, branch: 'remote-only' });
    assert.match(a.note, /отстаёт от origin\/remote-only на 1/);
    g(repo, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
    const b = await ensureWorktree({ root: repo, baseDir: base, branch: 'local-br' });
    assert.match(b.note, /fetch origin не удался/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('repoRoot: не репо — undefined; копирование не выходит за корень', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-norepo-')));
  try {
    assert.equal(await repoRoot(tmp), undefined);
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.mkdirSync(path.join(tmp, 'dst'));
    fs.writeFileSync(path.join(tmp, 'secret'), 'x');
    assert.deepEqual(copyUntracked(path.join(tmp, 'src'), path.join(tmp, 'dst'), ['../secret', 'missing']), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- GitHub через gh

test('forge по хосту: github.com и github.<компания> — GitHub, остальное — GitLab', () => {
  assert.equal(forgeOf('github.com'), 'github');
  assert.equal(forgeOf('github.acme.com'), 'github');
  assert.equal(forgeOf('gitlab.example.com'), 'gitlab');
  assert.equal(forgeOf('git.acme.com'), 'gitlab');
});

const pull = (n: number, login: string, extra: object = {}) => ({ number: n, title: `T${n}`, body: null, head: { ref: `f${n}`, sha: `sha${n}` }, base: { ref: 'main' }, user: { login }, draft: false, html_url: `https://github.com/o/r/pull/${n}`, ...extra });

test('PR через gh: «только мои» фильтруются по логину, ref вида owner/repo#N', async () => {
  const calls: string[][] = [];
  const x: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.at(-1) === 'user') return JSON.stringify({ login: 'gh-me' });
    return JSON.stringify([pull(1, 'gh-me'), pull(2, 'other')]);
  };
  const list = await listMergeRequests({ host: 'github.com', path: 'o/r' }, { mine: true }, x);
  assert.deepEqual(calls[0], ['gh', 'api', '--hostname', 'github.com', 'user']);
  assert.match(calls[1].at(-1)!, /^repos\/o\/r\/pulls\?state=open&per_page=100/);
  assert.deepEqual(list.map((m) => [m.ref, m.forge, m.description, m.notesCount]), [['o/r#1', 'github', '', undefined]]);
  assert.equal(await forgeUser('github.com', x), 'gh-me');
});

test('PR по номеру: конфликты, упавшая проверка и число review-комментариев', async () => {
  const x: Exec = async (_cmd, args) => {
    const p = args.at(-1)!;
    if (p === 'repos/o/r/pulls/5') return JSON.stringify(pull(5, 'me', { mergeable: false, mergeable_state: 'dirty', review_comments: 2 }));
    if (p.includes('/check-runs')) return JSON.stringify({ check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure', html_url: 'https://ci/run' }] });
    if (p.endsWith('/status')) return JSON.stringify({ statuses: [] });
    throw new Error(p);
  };
  const mr = await getMergeRequest({ host: 'github.com', path: 'o/r' }, 5, x);
  assert.equal(mr.hasConflicts, true);
  assert.equal(mr.mergeStatus, 'conflict');
  assert.equal(mr.notesCount, 2);
  assert.deepEqual(mr.pipeline, { status: 'failed', url: 'https://ci/run' });
});

test('PR: без проверок пайплайна нет, идущие проверки — running', async () => {
  const mk = (runs: object[]): Exec => async (_cmd, args) => {
    const p = args.at(-1)!;
    if (p.startsWith('repos/o/r/pulls/')) return JSON.stringify(pull(7, 'me', { mergeable: true, mergeable_state: 'clean' }));
    if (p.includes('/check-runs')) return JSON.stringify({ check_runs: runs });
    return JSON.stringify({ statuses: [] });
  };
  const r = { host: 'github.com', path: 'o/r' };
  assert.equal((await getMergeRequest(r, 7, mk([]))).pipeline, undefined);
  assert.deepEqual((await getMergeRequest(r, 7, mk([{ status: 'in_progress', conclusion: null }]))).pipeline, { status: 'running', url: 'https://github.com/o/r/pull/7/checks' });
});

test('review-треды PR через GraphQL: resolved и автор последнего комментария', async () => {
  const calls: string[][] = [];
  const x: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
      { isResolved: false, comments: { nodes: [{ author: { login: 'rev' } }] } },
      { isResolved: true, comments: { nodes: [{ author: null }] } },
    ] } } } } });
  };
  const d = await mrDiscussions({ host: 'github.com', path: 'o/r' }, 4, x);
  assert.deepEqual(calls[0].slice(0, 5), ['gh', 'api', '--hostname', 'github.com', 'graphql']);
  assert.ok(calls[0].includes('number=4') && calls[0].includes('owner=o') && calls[0].includes('name=r'));
  // имя и владелец — строками (-f): -F превратил бы репозиторий 2048 в Int, и GraphQL отказал бы (String!)
  const arg = (v: string) => calls[0][calls[0].indexOf(v) - 1];
  assert.deepEqual([arg('owner=o'), arg('name=r'), arg('number=4')], ['-f', '-f', '-F']);
  assert.deepEqual(d, [
    { resolvable: true, resolved: false, notes: [{ author: 'rev', system: false }] },
    { resolvable: true, resolved: true, notes: [{ author: '', system: false }] },
  ]);
});
