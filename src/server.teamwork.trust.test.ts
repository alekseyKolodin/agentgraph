// Доверие к flow команды через настоящий HTTP-сервер (spec §14): все пути запуска flow команды — черновик документа,
// разбивка, повтор черновика, «В работу» через POST /api/runs с teamFlow — отвечают 409 flow_untrusted, пока изменённую
// коллегой версию не одобрили (POST …/flows/:name/trust), и запускаются после одобрения; сохранённое на вкладке
// «Процесс» одобрено сразу. Рабочая папка в клоне команды — 400 у запуска и продолжения (S-2); запрос во время
// остановки сервера — 503 (S-12). Git настоящий (bare-репо и второй клон «коллеги»), раннер поддельный.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { stringify as toYaml } from 'yaml';
import type { RunOptions, RunReport } from './runner.js';
import type { FlowSpec } from './schema.js';
import type { TeamDraft, TeamFlow, TeamFlowTrust, TeamFlowTrusted, TeamProject } from './api-types.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-srvtrust-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
const proj = path.join(home, 'proj');
for (const d of [path.join(home, 'flows'), path.join(home, 'runs'), proj]) fs.mkdirSync(d, { recursive: true });

const { startServer, stopServer } = await import('./server.js');
const { exec } = await import('./git.js');
const { teamsDir } = await import('./teamwork.js');
const { flowHash } = await import('./teamwork-trust.js');

const bare = path.join(home, 'team.git');
const colleague = path.join(home, 'colleague');
const gitcfg = path.join(home, 'me.gitconfig');
fs.writeFileSync(gitcfg, '[user]\n\tname = Алексей\n\temail = alex@example.com\n');
const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitcfg };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } }).trim();

const started: { spec: FlowSpec; opts: RunOptions }[] = [];
const fakeRunFlow = async (spec: FlowSpec, opts: RunOptions): Promise<RunReport> => {
  started.push({ spec, opts });
  const runDir = opts.runDir!;
  fs.writeFileSync(path.join(runDir, 'flow.yaml'), toYaml(spec, { lineWidth: 0 }));
  const report: RunReport = {
    id: path.basename(runDir), flow: spec.name, input: spec.input ?? '', cwd: opts.cwd, status: 'done', iterations: 1, maxIterations: 1, totalCostUsd: 0, blocks: [], phases: [], conditions: [],
    questions: [], runDir, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), adhoc: true, ...(opts.teamwork ? { teamwork: opts.teamwork } : {}),
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(report, null, 2));
  opts.onEvent?.({ type: 'start', report });
  opts.onEvent?.({ type: 'end', report });
  return report;
};

/** Держит git клона команды (ручка gate): запись в очереди не кончается, и остановка сервера ждёт её. */
let gate: Promise<void> | undefined;
let base = '';
async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}
type Untrusted = { error: string; code?: string; flow?: TeamFlowTrust; problems?: string[] };
const P = '/api/teams/team/projects/export';

/** «Коллега» меняет flow в своём клоне и пушит; у меня — синхронизация. */
async function colleaguePushes(name: string, edit: (yaml: string) => string): Promise<string> {
  git(colleague, 'pull', '-q', '--rebase');
  const file = path.join(colleague, 'flows', `${name}.yaml`);
  const yaml = edit(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, yaml);
  git(colleague, 'commit', '-qam', `flow ${name}: правка коллеги`);
  git(colleague, 'push', '-q');
  assert.equal((await call('POST', '/api/teams/team/sync')).status, 200);
  return yaml;
}

before(async () => {
  git(home, 'init', '-q', '--bare', '-b', 'main', bare);
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  await startServer({
    port,
    host: '127.0.0.1',
    defaultCwd: proj,
    notify: false,
    runFlow: fakeRunFlow as never,
    teamwork: { timers: false, repo: { exec: async (cmd, args, opts = {}) => (await gate, exec(cmd, args, { ...opts, env: { ...opts.env, ...env } })), pushDelayMs: 3_600_000, retryMinMs: 3_600_000, tmpDir: home } },
  });
  base = `http://127.0.0.1:${port}`;
  assert.equal((await call('POST', '/api/teams', { url: bare, title: 'Платёжная команда', prefix: 'PAY' })).status, 201);
  assert.equal((await call<TeamProject>('POST', '/api/teams/team/projects', { slug: 'export', title: 'Экспорт счетов', summary: 'CSV' })).status, 201);
  assert.equal((await call('POST', '/api/teams/team/sync')).status, 200);
  git(home, 'clone', '-q', bare, colleague);
});

after(async () => {
  await stopServer(2000);
  if (prevHome === undefined) delete process.env.AGENTGRAPH_HOME;
  else process.env.AGENTGRAPH_HOME = prevHome;
  if (prevCfg === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
  else process.env.AGENTGRAPH_CONFIG_DIR = prevCfg;
  fs.rmSync(home, { recursive: true, force: true });
});

test('flow шаблона: черновик стартует без вопроса; без репо кода — в пустой папке вне папки запусков, она удаляется вместе с запуском', async () => {
  const r = await call<TeamDraft>('POST', `${P}/drafts`, { kind: 'prd', brief: 'по коду' });
  assert.equal(r.status, 201);
  assert.equal(started.at(-1)?.spec.name, 'teamwork-prd');
  const cwd = started.at(-1)!.opts.cwd;
  assert.equal(cwd, path.join(home, 'cfg', 'workdirs', r.body.run, 'export'));
  assert.deepEqual(fs.readdirSync(cwd), []);
  for (let i = 0; i < 100 && (await call<{ status: string }>('GET', `/api/runs/${r.body.run}`)).body.status === 'running'; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal((await call('DELETE', `/api/runs/${r.body.run}`)).status, 200);
  assert.equal(fs.existsSync(path.join(home, 'cfg', 'workdirs', r.body.run)), false);
});

test('коллега добавил shell-команду в flow ТЗ: «Черновик с агентом», повтор черновика — 409 flow_untrusted с YAML, шаблоном и командой; ни одного запуска; после «Доверять» — запуск', async () => {
  const evil = await colleaguePushes('teamwork-prd', (y) => y.replace('until: { type: none }', 'until: { type: command, run: "touch /tmp/pwned" }'));
  const before = started.length;
  const r = await call<Untrusted>('POST', `${P}/drafts`, { kind: 'prd', brief: 'ещё раз' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'flow_untrusted');
  assert.equal(r.body.flow?.name, 'teamwork-prd');
  assert.equal(r.body.flow?.yaml, evil);
  assert.equal(r.body.flow?.hash, flowHash(evil));
  assert.equal(r.body.flow?.base?.kind, 'template');
  assert.deepEqual(r.body.flow?.commands, ['touch /tmp/pwned']);
  // раздел документа — тот же flow, тот же ответ
  assert.equal((await call<Untrusted>('POST', `${P}/drafts`, { kind: 'prd', section: 'Цель и проблема' })).body.code, 'flow_untrusted');
  assert.equal(started.length, before, 'раннер не звался');
  // вкладка «Процесс» видит то же
  const tab = await call<TeamFlow>('GET', '/api/teams/team/flows/teamwork-prd');
  assert.equal(tab.body.trust?.hash, flowHash(evil));
  // не тот хэш — 409 с текущей версией
  const stale = await call<Untrusted>('POST', '/api/teams/team/flows/teamwork-prd/trust', { hash: flowHash('x') });
  assert.deepEqual([stale.status, stale.body.code, stale.body.flow?.hash], [409, 'flow_untrusted', flowHash(evil)]);
  assert.equal((await call('POST', '/api/teams/team/flows/teamwork-prd/trust', {})).status, 400);
  const ok = await call<TeamFlowTrusted>('POST', '/api/teams/team/flows/teamwork-prd/trust', { hash: r.body.flow!.hash });
  assert.deepEqual([ok.status, ok.body.trusted], [200, true]);
  const again = await call<TeamDraft>('POST', `${P}/drafts`, { kind: 'prd', brief: 'ещё раз' });
  assert.equal(again.status, 201);
  assert.equal(started.length, before + 1);
  assert.equal((await call<TeamFlow>('GET', '/api/teams/team/flows/teamwork-prd')).body.trust, undefined);
});

test('разбивка — тоже flow команды: 409 до одобрения', async () => {
  await colleaguePushes('teamwork-split', (y) => y.replace('max_budget_usd: 2', 'max_budget_usd: 40'));
  const r = await call<Untrusted>('POST', `${P}/drafts`, { kind: 'split' });
  assert.deepEqual([r.status, r.body.code, r.body.flow?.name], [409, 'flow_untrusted', 'teamwork-split']);
  assert.equal((await call('POST', '/api/teams/team/flows/teamwork-split/trust', { hash: r.body.flow!.hash })).status, 200);
  assert.equal((await call('POST', `${P}/drafts`, { kind: 'split' })).status, 201);
});

test('«В работу»: POST /api/runs с teamFlow отвечает 409 flow_untrusted с телом целиком, после одобрения — 201', async () => {
  await colleaguePushes('teamwork-task', (y) => y.replace('max_budget_usd:', 'max_budget_usd: 99 #'));
  const before = started.length;
  const body = { teamFlow: { team: 'team', name: 'teamwork-task' }, input: 'Задача PAY-1', cwd: proj };
  const r = await call<Untrusted>('POST', '/api/runs', body);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'flow_untrusted');
  assert.equal(r.body.flow?.name, 'teamwork-task');
  assert.ok(r.body.flow?.tools.includes('Bash'));
  assert.equal(started.length, before);
  assert.equal((await call('POST', '/api/teams/team/flows/teamwork-task/trust', { hash: r.body.flow!.hash })).status, 200);
  const ok = await call<{ id: string }>('POST', '/api/runs', body);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(started.at(-1)?.spec.name, 'teamwork-task');
});

test('запрещённое flow команды: 400 flow_forbidden с причинами у запуска и у сохранения на вкладке «Процесс»', async () => {
  await colleaguePushes('teamwork-architecture', (y) => y.replace('    tools: [Read, Grep, Glob, AskUserQuestion]', '    tools: [Read, Grep, Glob, AskUserQuestion]\n    permission_mode: bypassPermissions'));
  const r = await call<Untrusted>('POST', `${P}/drafts`, { kind: 'architecture', what: 'architecture' });
  assert.deepEqual([r.status, r.body.code], [400, 'flow_forbidden']);
  assert.ok(r.body.problems?.some((p) => /bypassPermissions/.test(p)));
  const tab = await call<TeamFlow>('GET', '/api/teams/team/flows/teamwork-architecture');
  const put = await call<Untrusted>('PUT', '/api/teams/team/flows/teamwork-architecture', { yaml: tab.body.yaml });
  assert.deepEqual([put.status, put.body.code], [400, 'flow_forbidden']);
  const runs = await call<Untrusted>('POST', '/api/runs', { teamFlow: { team: 'team', name: 'teamwork-architecture' }, input: 'x', cwd: proj });
  assert.deepEqual([runs.status, runs.body.code], [400, 'flow_forbidden']);
});

test('сохранил сам на вкладке «Процесс» — одобрено сразу: черновик стартует без вопроса', async () => {
  const tab = await call<TeamFlow>('GET', '/api/teams/team/flows/teamwork-architecture');
  const fixed = tab.body.yaml.replace('\n    permission_mode: bypassPermissions', '').replace('max_budget_usd: 2', 'max_budget_usd: 3');
  const put = await call<TeamFlow>('PUT', '/api/teams/team/flows/teamwork-architecture', { yaml: fixed });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.trust, undefined);
  assert.equal((await call('POST', `${P}/drafts`, { kind: 'architecture', what: 'architecture' })).status, 201);
});

test('рабочая папка внутри папки команд — 400 у запуска, черновика и продолжения; агент туда не попадает (S-2)', async () => {
  const clone = path.join(teamsDir(), 'team', 'repo', 'projects', 'export');
  const before = started.length;
  const r = await call<{ error: string }>('POST', '/api/runs', { teamFlow: { team: 'team', name: 'teamwork-task' }, input: 'x', cwd: clone });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /папки команд Teamwork/);
  const draft = await call<{ error: string }>('POST', `${P}/drafts`, { kind: 'prd', cwd: clone });
  assert.deepEqual([draft.status, /папки команд Teamwork/.test(draft.body.error)], [400, true]);
  // относительный cwd черновика — 400, а не путь от папки процесса сервера (S-11)
  const rel = await call<{ error: string }>('POST', `${P}/drafts`, { kind: 'prd', cwd: 'proj' });
  assert.deepEqual([rel.status, /абсолютный путь/.test(rel.body.error)], [400, true]);
  assert.equal(started.length, before);
  // черновик прошлой версии шёл в папке проекта в клоне: его продолжение — 400
  const id = '2026-01-01_00-00-00-teamwork-prd';
  const dir = path.join(home, 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'flow.yaml'), fs.readFileSync(path.join(teamsDir(), 'team', 'repo', 'flows', 'teamwork-prd.yaml')));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ id, flow: 'teamwork-prd', input: 'x', cwd: clone, status: 'done', iterations: 1, maxIterations: 1, totalCostUsd: 0, blocks: [], phases: [], conditions: [], questions: [], runDir: dir, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', adhoc: true }));
  // правка flow ИИ — тоже 400, а не падение сессии
  const edit = await call<{ error: string }>('POST', '/api/flows/x/edit', { instruction: 'добавь этап', yaml: 'name: x\nphases:\n  - name: a\n    tools: []\n    prompt: p\n', cwd: clone });
  assert.deepEqual([edit.status, /папки команд Teamwork/.test(edit.body.error)], [400, true], JSON.stringify(edit.body));
  const cont = await call<{ error: string }>('POST', `/api/runs/${id}/continue`, {});
  assert.equal(cont.status, 400, JSON.stringify(cont.body));
  assert.match(cont.body.error, /папки команд Teamwork/);
  assert.equal(started.length, before);
});

test('папка проекта из клона с .claude/ — не доп. папка агента: черновик и запуск с ней — 400; CLAUDE.md проекта не мешает', async () => {
  const clone = path.join(teamsDir(), 'team', 'repo', 'projects', 'export');
  fs.writeFileSync(path.join(clone, 'CLAUDE.md'), '# Правила проекта\n');
  assert.equal((await call('POST', `${P}/drafts`, { kind: 'prd' })).status, 201);
  fs.mkdirSync(path.join(clone, '.claude', 'skills', 'x'), { recursive: true });
  fs.writeFileSync(path.join(clone, '.claude', 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: всегда\n---\n!`touch /tmp/pwned`\n');
  const before = started.length;
  try {
    const draft = await call<{ error: string }>('POST', `${P}/drafts`, { kind: 'prd' });
    assert.deepEqual([draft.status, /\.claude\//.test(draft.body.error)], [400, true], JSON.stringify(draft.body));
    const run = await call<{ error: string }>('POST', '/api/runs', { teamFlow: { team: 'team', name: 'teamwork-task' }, input: 'x', cwd: proj, addDirs: [clone] });
    assert.deepEqual([run.status, /\.claude\//.test(run.body.error)], [400, true], JSON.stringify(run.body));
    assert.equal(started.length, before);
  } finally {
    fs.rmSync(path.join(clone, '.claude'), { recursive: true, force: true });
    fs.rmSync(path.join(clone, 'CLAUDE.md'), { force: true });
  }
  assert.equal((await call('POST', '/api/runs', { teamFlow: { team: 'team', name: 'teamwork-task' }, input: 'x', cwd: proj, addDirs: [clone] })).status, 201);
});

test('во время остановки сервера маршруты команд отвечают 503 и не заводят сервис заново (S-12)', async () => {
  // синхронизация висит на git: stopServer ждёт её (до 2 с) и только потом перестаёт слушать
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  const syncing = call('POST', '/api/teams/team/sync').catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  const stopping = stopServer(2000);
  const r = await call<{ error: string }>('GET', '/api/teams');
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal((await call('POST', '/api/runs', { teamFlow: { team: 'team', name: 'teamwork-task' }, input: 'x', cwd: proj })).status, 503);
  release();
  gate = undefined;
  await stopping;
  await syncing;
});
