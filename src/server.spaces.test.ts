// Пространства через настоящий HTTP-сервер (startServer): ошибки POST /api/runs, запуски на странице пространства,
// продолжение старого запуска с тегом задачи. Раннер подменён: настоящий Agent SDK не зовётся. runs/ и flows/ — во
// временной папке: paths.ts читает AGENTGRAPH_HOME при загрузке модуля, поэтому сервер импортируется после env.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions } from './runner.js';
import type { FlowSpec } from './schema.js';
import type { SpaceDetail, SpaceListItem } from './api-types.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-srvspaces-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
const proj = path.join(home, 'proj');
const runs = path.join(home, 'runs');
for (const d of [path.join(home, 'flows'), runs, proj]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, 'flows', 'demo.yaml'), 'name: demo\nphases:\n  - name: work\n    tools: [Read]\n    prompt: "Задача: {{input}}"\n');

const { startServer, stopServer } = await import('./server.js');
const { MAIN_BLOCK } = await import('./schema.js');
const { spaceDir } = await import('./spaces.js');

/** Что получил раннер: задача и опции пространства. Запуск падает (сразу или по hold.release) — run.json пишет сервер. */
const started: { spec: FlowSpec; opts: RunOptions }[] = [];
/** Задача «hold» держит запуск идущим, пока тест не позовёт release. */
const hold = { release: () => {} };
const fakeRunFlow = async (spec: FlowSpec, opts: RunOptions): Promise<never> => {
  started.push({ spec: { ...spec }, opts });
  if (spec.input === 'hold') await new Promise<void>((resolve) => { hold.release = resolve; });
  throw new Error('поддельный раннер');
};

/** Старый тег задачи и запуски до пространств: блок тега в задаче, saveTag, дочерний запуск и запуск в worktree. */
const OLD = '2026-10-30_18-50-33-kai';
const CHILD = '2026-10-30_19-00-00-kai-child';
const WT = '2026-10-31_10-00-00-kai-wt';
const MULTI = '2026-10-29_10-00-00-two-tags';
const LOOSE = '0000000a-0000-4000-8000-000000000000';
function seed() {
  const tag = path.join(home, 'cfg', 'tags', 'kai');
  fs.mkdirSync(tag, { recursive: true });
  fs.writeFileSync(path.join(tag, 'tag.json'), JSON.stringify({ slug: 'kai', kind: 'task', title: 'Kai', createdAt: '2026-10-29T20:00:00.000Z', updatedAt: '2026-10-30T16:00:00.000Z', runs: [] }));
  fs.writeFileSync(path.join(tag, 'summary.md'), 'Суть: Kai MVP');
  const report = (id: string, extra: Record<string, unknown>) => {
    fs.mkdirSync(path.join(runs, id), { recursive: true });
    fs.writeFileSync(path.join(runs, id, 'run.json'), JSON.stringify({
      id, flow: 'demo', cwd: proj, status: 'max_iterations', iterations: 1, maxIterations: 1, totalCostUsd: 0,
      blocks: [{ name: MAIN_BLOCK, status: 'max_iterations' }], phases: [], conditions: [], questions: [], runDir: path.join(runs, id),
      startedAt: '2026-10-30T18:50:33.000Z', finishedAt: '2026-10-30T18:59:00.000Z', ...extra,
    }));
  };
  report(OLD, { input: 'Сделай пуш\n\n<!-- tag:kai -->\nСаммари тега на момент старта\n<!-- /tag -->\n\n<!-- tag:other -->\nчужой блок\n<!-- /tag -->', tags: ['kai'], saveTag: true });
  // старый запуск с двумя тегами задач: виден на странице обоих пространств
  const other = path.join(home, 'cfg', 'tags', 'two');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'tag.json'), JSON.stringify({ slug: 'two', kind: 'task', createdAt: '2026-10-29T20:00:00.000Z', updatedAt: '2026-10-30T16:00:00.000Z', runs: [] }));
  report(MULTI, { input: 'два тега', tags: ['kai', 'two'], startedAt: '2026-10-29T10:00:00.000Z' });
  // сессия без пространства в той же папке, что запуски kai
  fs.mkdirSync(path.join(home, 'sessions', LOOSE), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', LOOSE, 'session.json'), JSON.stringify({ id: LOOSE, name: 'без пространства', cwd: proj, tags: [], saveState: true, claudeSessionIds: [], createdAt: '2026-10-30T10:00:00.000Z', lastActivityAt: '2026-10-30T11:00:00.000Z', endedAt: '2026-10-30T11:00:00.000Z', turns: 1 }));
  report(CHILD, { input: 'дочерний', tags: ['kai'], parent: { runId: OLD, block: MAIN_BLOCK }, startedAt: '2026-10-30T19:00:00.000Z' });
  report(WT, { input: 'в worktree', tags: ['kai'], worktree: { path: path.join(home, 'wt'), branch: 'x' }, startedAt: '2026-10-31T10:00:00.000Z' });
}

let base = '';
before(async () => {
  seed();
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  await startServer({ port, host: '127.0.0.1', defaultCwd: proj, notify: false, runFlow: fakeRunFlow as never });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await stopServer(2000);
  if (prevHome === undefined) delete process.env.AGENTGRAPH_HOME;
  else process.env.AGENTGRAPH_HOME = prevHome;
  if (prevCfg === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
  else process.env.AGENTGRAPH_CONFIG_DIR = prevCfg;
  fs.rmSync(home, { recursive: true, force: true });
});

async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

const slugs = async () => (await call<{ spaces: SpaceListItem[] }>('GET', '/api/spaces')).body.spaces.map((s) => s.slug).sort();

test('POST /api/runs: старые поля и тег задачи — 400, неверный слаг и flow — 400; после 400 пустого пространства на диске нет', async () => {
  // перенос тега задачи — при первом обращении к пространствам
  assert.deepEqual(await slugs(), ['kai', 'two']);
  const bad = async (body: Record<string, unknown>, re: RegExp) => {
    const r = await call<{ error: string }>('POST', '/api/runs', { flow: 'demo', input: 'x', cwd: proj, ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re, JSON.stringify(body));
  };
  await bad({ saveTag: true, space: 'fresh-a' }, /Теги задач заменены пространствами/);
  await bad({ autoTag: true, space: 'fresh-b' }, /Теги задач заменены пространствами/);
  await bad({ tags: ['kai'], space: 'fresh-c' }, /пространство kai/);
  await bad({ space: '../x' }, /Неверное пространство/);
  await bad({ flow: 'nope', space: 'fresh-d' }, /./);
  await bad({ autoSpace: 'yes', space: 'fresh-e' }, /autoSpace/);
  assert.deepEqual(await slugs(), ['kai', 'two']);
  // папка без space.json с чужими файлами — 409, пространство не заводится поверх
  fs.mkdirSync(path.join(home, 'cfg', 'spaces', 'planted'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cfg', 'spaces', 'planted', 'CLAUDE.md'), 'чужая карта');
  const planted = await call<{ error: string }>('POST', '/api/runs', { flow: 'demo', input: 'x', cwd: proj, space: 'planted' });
  assert.equal(planted.status, 409);
  assert.equal((await call('POST', '/api/spaces', { slug: 'planted' })).status, 409);
  assert.deepEqual(await slugs(), ['kai', 'two']);
  assert.equal(started.length, 0);
});

test('страница пространства: старые запуски тега задачи — с пометкой legacy, без дочерних; папка — только у запуска не в worktree', async () => {
  const r = await call<SpaceDetail>('GET', '/api/spaces/kai');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.runs.map((x) => [x.id, x.legacy, x.cwd]), [[WT, true, undefined], [OLD, true, proj], [MULTI, true, proj]]);
  // рабочая папка для форм — папка последнего запуска не в worktree
  assert.deepEqual(r.body.workdir, { path: proj, from: 'run' });
  // сессия без пространства в той же папке — её предложат добавить
  assert.deepEqual(r.body.looseSessions?.map((x) => x.id), [LOOSE]);
  const list = (await call<{ spaces: SpaceListItem[] }>('GET', '/api/spaces')).body.spaces;
  const kai = list.find((s) => s.slug === 'kai')!;
  assert.deepEqual([kai.workdir, kai.runs, kai.sessions, kai.live], [{ path: proj, from: 'run' }, 3, 0, 0]);
  // запуск с двумя тегами задач — и у второго пространства, но его папка — только первого: страница и список согласны
  const two = (await call<SpaceDetail>('GET', '/api/spaces/two')).body;
  assert.deepEqual(two.runs.map((x) => [x.id, x.legacy, x.cwd]), [[MULTI, true, undefined]]);
  assert.equal(two.workdir, undefined);
  assert.deepEqual([list.find((s) => s.slug === 'two')?.runs, list.find((s) => s.slug === 'two')?.workdir], [1, undefined]);
});

test('продолжение старого запуска с тегом задачи: пространство — перенесённый тег, saveTag — галочка состояния, из задачи снят блок только этого тега', async () => {
  const before = started.length;
  const r = await call<{ id: string }>('POST', `/api/runs/${OLD}/continue`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(started.length, before + 1);
  const { spec, opts } = started.at(-1)!;
  assert.equal(spec.input, 'Сделай пуш\n\n<!-- tag:other -->\nчужой блок\n<!-- /tag -->');
  assert.deepEqual([opts.space, opts.saveState], ['kai', true]);
  assert.ok(opts.spaceDirs?.includes(spaceDir('kai')), String(opts.spaceDirs));
  // упавший запуск записан с пространством: он виден на странице пространства уже не как legacy
  const page = (await call<SpaceDetail>('GET', '/api/spaces/kai')).body;
  const fresh = page.runs.find((x) => x.id === r.body.id);
  assert.ok(fresh && !fresh.legacy, JSON.stringify(page.runs));
});

test('продолжение старого запуска, чьё пространство удалили: без пространства, задача как была (блок тега — единственный контекст)', async () => {
  assert.equal((await call('DELETE', '/api/spaces/kai')).status, 200);
  const before = started.length;
  const r = await call<{ id: string }>('POST', `/api/runs/${OLD}/continue`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const { spec, opts } = started[before];
  assert.match(spec.input ?? '', /<!-- tag:kai -->/);
  assert.equal(opts.space, undefined);
  // удалённое пространство не воскресает: тег перенесён раньше
  assert.deepEqual(await slugs(), ['two']);
});

test('удаление пространства, пока его запуск идёт: 409 и пространство на месте; запуск кончился — удаляется', async () => {
  assert.equal((await call('POST', '/api/spaces', { slug: 'busy' })).status, 201);
  const r = await call<{ id: string }>('POST', '/api/runs', { flow: 'demo', input: 'hold', cwd: proj, space: 'busy' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // run.json поддельный раннер не пишет: идущий запуск сервер знает сам
  const busy = await call<{ error: string }>('DELETE', '/api/spaces/busy');
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, new RegExp(`идущего запуска: ${r.body.id}`));
  assert.ok((await slugs()).includes('busy'));
  hold.release();
  for (let i = 0; i < 100 && (await call<{ status: string }>('GET', `/api/runs/${r.body.id}`)).body.status === 'running'; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal((await call('DELETE', '/api/spaces/busy')).status, 200);
  assert.ok(!(await slugs()).includes('busy'));
});
