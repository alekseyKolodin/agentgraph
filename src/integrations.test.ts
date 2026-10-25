import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { integrationsRoute, runLinks } from './integrations.js';
import { worktreesDir } from './settings.js';
import type { FetchFn } from './jira.js';
import { exec as realExec, type Exec } from './git.js';
import { resetAttentionState } from './attention.js';
import type { SessionRequest } from './agent.js';

async function withEnv(fn: (tmp: string) => Promise<void>) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-int-')));
  const prev = process.env.AGENTGRAPH_CONFIG_DIR;
  process.env.AGENTGRAPH_CONFIG_DIR = path.join(tmp, 'cfg');
  try {
    await fn(tmp);
  } finally {
    if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
    else process.env.AGENTGRAPH_CONFIG_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const call = (method: string, p: string, body: unknown = {}, deps: Partial<Parameters<typeof integrationsRoute>[3]> = {}) =>
  integrationsRoute(method, new URL(p, 'http://localhost'), async () => body, { runCwds: () => [], flowInput: () => 'Тикет: <KEY>', flows: () => [], ...deps });

test('runLinks: worktree только внутри папки worktree и равный cwd, источник обрезается', () =>
  withEnv(async (tmp) => {
    const inside = path.join(worktreesDir(), 'App', 'br');
    fs.mkdirSync(inside, { recursive: true });
    assert.deepEqual(runLinks({ worktree: { path: inside, branch: 'br' } }, inside).worktree, { path: inside, branch: 'br' });
    assert.equal(runLinks({ worktree: { path: tmp } }, tmp).worktree, undefined);
    assert.equal(runLinks({ worktree: { path: inside } }, tmp).worktree, undefined);
    assert.equal(runLinks({ source: { type: 'evil', key: 'x' } }, tmp).source, undefined);
    assert.equal(runLinks({ source: { type: 'jira', key: 'A-1', title: 'x'.repeat(1000) } }, tmp).source?.title.length, 300);
  }));

test('Jira: подключение проверяет токен до сохранения, токен не отдаётся', () =>
  withEnv(async () => {
    const fetchOk = (async () => new Response(JSON.stringify({ accountId: '1', displayName: 'Тест' }), { status: 200 })) as unknown as FetchFn;
    const fetch401 = (async () => new Response('{}', { status: 401 })) as unknown as FetchFn;
    const cfg = { baseUrl: 'https://example.atlassian.net', email: 'a@b', token: 'tok-1' };
    const fail = await call('PUT', '/api/integrations/jira', cfg, { fetch: fetch401 });
    assert.equal(fail?.status, 400);
    assert.equal(((await call('GET', '/api/integrations', {}, { exec: async () => '' }))?.body as { jira: unknown }).jira, null);
    const okr = await call('PUT', '/api/integrations/jira', cfg, { fetch: fetchOk });
    assert.deepEqual(okr?.body, { connected: true, user: 'Тест' });
    // сохранённый токен не уходит на другой адрес: без нового токена — отказ, до запроса в сеть
    let hits = 0;
    const counting = (async () => { hits++; return new Response('{}', { status: 200 }); }) as unknown as FetchFn;
    const moved = await call('PUT', '/api/integrations/jira', { baseUrl: 'https://evil.example', email: 'a@b' }, { fetch: counting });
    assert.equal(moved?.status, 400);
    assert.equal(hits, 0);
    const ov = await call('GET', '/api/integrations', {}, { exec: async () => '' });
    assert.ok(!JSON.stringify(ov?.body).includes('tok-1'));
    assert.equal((ov?.body as { jira: { hasToken: boolean } }).jira.hasToken, true);
  }));

test('вход из ветки через маршрут: только проекты из настроек', () =>
  withEnv(async (tmp) => {
    const repo = path.join(tmp, 'App');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: repo });
    execFileSync('git', ['branch', 'feature/ABC-5-x'], { cwd: repo });
    const denied = await call('POST', '/api/intake', { type: 'branch', key: 'feature/ABC-5-x', project: repo });
    assert.match(String((denied?.body as { error: string }).error), /Проект не найден/);
    assert.equal((await call('POST', '/api/projects', { path: repo }))?.status, 201);
    const r = await call('POST', '/api/intake', { flow: 'f', type: 'branch', key: 'feature/ABC-5-x', project: repo });
    const body = r?.body as { input: string; branch: string; source: { type: string } };
    assert.ok(body.input.startsWith('Тикет: ABC-5\n\nВетка: feature/ABC-5-x'));
    assert.equal(body.source.type, 'branch');
    assert.equal(await call('GET', '/api/unknown'), undefined);
  }));

test('мои MR с причинами, подбор flow и вход с причинами через маршруты', () =>
  withEnv(async (tmp) => {
    resetAttentionState();
    const repo = path.join(tmp, 'App');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['remote', 'add', 'origin', 'git@h:g/app.git'], { cwd: repo });
    // git — настоящий, glab — фейковый
    const glab: string[] = [];
    const x: Exec = async (cmd, args, opts) => {
      if (cmd !== 'glab') return realExec(cmd, args, opts);
      const p = args.at(-1)!;
      glab.push(p);
      if (p === 'user') return JSON.stringify({ username: 'me' });
      const base = { title: 'ABC-1 кнопка', source_branch: 'feature/ABC-1', target_branch: 'dev', references: { full: 'g/app!5' }, web_url: 'https://h/g/app/-/merge_requests/5' };
      if (p.endsWith('/discussions?per_page=100')) return JSON.stringify([{ resolvable: true, resolved: false, notes: [{ author: { username: 'rev' } }] }]);
      if (p.includes('/merge_requests/5')) return JSON.stringify({ ...base, iid: 5, user_notes_count: 1, has_conflicts: true, head_pipeline: { status: 'failed', web_url: 'https://h/p/7' } });
      return JSON.stringify([{ ...base, iid: 5, user_notes_count: 1 }]);
    };
    assert.equal((await call('POST', '/api/projects', { path: repo }))?.status, 201);

    const r = (await call('GET', '/api/attention', {}, { exec: x }))?.body as { items: { ref: string; project: string; reasons: unknown }[]; errors: unknown[] };
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.items.map((i) => [i.ref, i.project]), [['g/app!5', repo]]);
    assert.deepEqual(r.items[0].reasons, { ci: { status: 'failed', url: 'https://h/p/7' }, replies: 1, conflicts: true });

    const reqs: SessionRequest[] = [];
    const session = async (req: SessionRequest) => {
      reqs.push(req);
      return { ok: true, subtype: 'success', text: '', structured: { suggestions: [{ ref: 'g/app!5', flow: 'fix-mr', why: 'чинит MR' }] }, costUsd: 0, turns: 1, durationMs: 0, errors: [] };
    };
    const flows = () => [{ name: 'fix-mr', file: 'fix-mr.yaml', folder: '', valid: true, description: 'отработать MR' }];
    const s = await call('POST', '/api/attention/suggest', { refs: ['g/app!5', 'чужой!1'] }, { session, flows });
    assert.deepEqual(s?.body, { suggestions: { 'g/app!5': { flow: 'fix-mr', why: 'чинит MR' } } });
    // ref, которого не было в выдаче, модели не уходит
    assert.ok(!reqs[0].prompt.includes('чужой'));

    const intake = (await call('POST', '/api/intake', { flow: 'fix-mr', type: 'mr', key: 'g/app!5', project: repo, attention: true }, { exec: x }))?.body as { input: string };
    assert.match(intake.input, /Ссылка: https:\/\/h\/g\/app\/-\/merge_requests\/5\nТребует внимания: упал CI \(https:\/\/h\/p\/7\) · 1 обсуждение ждёт ответа · конфликты с dev\n/);
    const plain = (await call('POST', '/api/intake', { flow: 'fix-mr', type: 'mr', key: 'g/app!5', project: repo }, { exec: x }))?.body as { input: string };
    assert.ok(!plain.input.includes('Требует внимания'));
  }));

test('вход из PR GitHub через маршрут: gh, ключ owner/repo#N, «Pull request», проект и ветка для worktree', () =>
  withEnv(async (tmp) => {
    const repo = path.join(tmp, 'App');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:o/app.git'], { cwd: repo });
    const gh: string[] = [];
    const x: Exec = async (cmd, args, opts) => {
      if (cmd === 'glab') throw new Error('glab не должен вызываться для GitHub');
      if (cmd !== 'gh') return realExec(cmd, args, opts);
      const p = args.at(-1)!;
      gh.push(p);
      if (p === 'repos/o/app/pulls/5') return JSON.stringify({ number: 5, title: 'ABC-3 кнопка', body: 'Тело PR', head: { ref: 'feature/ABC-3' }, base: { ref: 'main' }, user: { login: 'me' }, draft: false, html_url: 'https://github.com/o/app/pull/5' });
      throw new Error(`неожиданный вызов gh ${p}`);
    };
    assert.equal((await call('POST', '/api/projects', { path: repo }))?.status, 201);
    const r = await call('POST', '/api/intake', { flow: 'f', type: 'mr', key: 'o/app#5', project: repo }, { exec: x });
    assert.equal(r?.status, 200);
    const intake = r?.body as { input: string; source: { type: string; key: string; project?: string }; branch?: string };
    assert.deepEqual(gh, ['repos/o/app/pulls/5']);
    assert.ok(intake.input.startsWith('Тикет: ABC-3\n\nPull request o/app#5\nСсылка: https://github.com/o/app/pull/5\n'));
    assert.match(intake.input, /Описание PR:\nТело PR/);
    assert.deepEqual([intake.source.type, intake.source.key, intake.source.project, intake.branch], ['mr', 'o/app#5', repo, 'feature/ABC-3']);
  }));
