// Правки сессии терминала в своём пространстве и во flow — через настоящий HTTP-сервер с поддельным pty: правила в
// --settings, хуки PreToolUse и PostToolUse записи, инструменты MCP и события space и flows общего потока.
// Папка flow — временная: AGENTGRAPH_HOME задаётся до импорта (paths.ts читает его при загрузке); настоящий claude не запускается.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { HomeEvent, SessionView } from './api-types.js';
import type { PtyExit, PtyKit, PtyProcess } from './sessions-pty.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ssedit-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = root;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(root, 'cfg');
const { startServer, stopServer } = await import('./server.js');
const { sessionManager } = await import('./sessions-server.js');
const { createMirror } = await import('./sessions-pty.js');
const { createSpace, readSpace, spaceDir, spacesDir } = await import('./spaces.js');
const { saveFlowYaml } = await import('./flows.js');
const { FLOWS_DIR } = await import('./paths.js');

class FakePty implements PtyProcess {
  pid = 4243;
  private exits: ((e: PtyExit) => void)[] = [];
  constructor(readonly file: string, readonly args: string[], readonly opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }) {}
  onData() {}
  onExit(cb: (e: PtyExit) => void) {
    this.exits.push(cb);
  }
  write() {}
  resize() {}
  kill() {
    setTimeout(() => this.exits.splice(0).forEach((cb) => cb({ exitCode: 129 })), 5);
  }
}
const spawned: FakePty[] = [];
const kit: PtyKit = { spawn: (file, args, opts) => (spawned.push(new FakePty(file, args, opts)), spawned.at(-1)!), mirror: createMirror };
/**
 * Какой claude найдётся: путь и его версия (claude --version) — от неё onFailure: block и правила на чужие пространства.
 * Сервер кэширует версию по пути, поэтому старый claude — другой путь.
 */
let bin = '/fake/new/claude';
const VERSIONS: Record<string, string> = { '/fake/new/claude': '2.1.317', '/fake/old/claude': '2.1.200' };

let base = '';
const proj = path.join(root, 'proj');
const leaf = (name: string, prompt = 'x') => `name: ${name}\nphases:\n  - { name: a, tools: [], prompt: ${prompt} }\n`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

before(async () => {
  fs.mkdirSync(proj, { recursive: true });
  sessionManager({
    kit: async () => kit,
    findClaude: () => bin,
    version: async (b) => VERSIONS[b],
    agents: async () => '[]',
    dir: path.join(root, 'sessions'),
    runsDir: path.join(root, 'runs'),
    env: () => ({ PATH: '/bin' }),
    deliveryAfterMs: 60_000,
    summarize: async () => ({ ok: false, subtype: 'error_during_execution', text: '', costUsd: 0, turns: 0, durationMs: 0, errors: ['не нужна'] }),
    title: () => new Promise<never>(() => {}),
  });
  const port = await freePort();
  await startServer({ port, host: '127.0.0.1', defaultCwd: proj, notify: false });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await stopServer(2000);
  if (prevHome === undefined) delete process.env.AGENTGRAPH_HOME;
  else process.env.AGENTGRAPH_HOME = prevHome;
  if (prevCfg === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
  else process.env.AGENTGRAPH_CONFIG_DIR = prevCfg;
  fs.rmSync(root, { recursive: true, force: true });
});

async function call<T = unknown>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}
const settingsOf = (p: FakePty) => JSON.parse(p.args[p.args.indexOf('--settings') + 1]) as { permissions: { deny: string[]; ask: string[] }; hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> };
const tokenOf = (p: FakePty) => settingsOf(p).hooks.Stop[0].hooks[0].headers as Record<string, string>;
type Decision = { permissionDecision: string; permissionDecisionReason: string };

/** Живая сессия и её хуки/MCP с токеном, как их зовёт claude. */
async function session(body: Record<string, unknown>) {
  const { body: v } = await call<SessionView>('POST', '/api/sessions', { cwd: proj, ...body });
  const p = spawned.at(-1)!;
  const headers = tokenOf(p);
  const hook = async (input: Record<string, unknown>) => (await call<Record<string, unknown>>('POST', `/api/sessions/${v.id}/hook`, input, headers)).body;
  const pre = async (tool: string, input: Record<string, unknown>, o: Record<string, unknown> = {}) =>
    (await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, permission_mode: 'acceptEdits', ...o })).hookSpecificOutput as Decision;
  const tool = async (name: string, args: Record<string, unknown>) =>
    (await call<{ result: { content: Array<{ text: string }>; isError?: boolean } }>('POST', `/api/sessions/${v.id}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers)).body.result;
  return { v, p, hook, pre, tool, end: () => call('POST', `/api/sessions/${v.id}/end`) };
}

/** События общего потока /api/events, пока идёт fn. */
async function events(fn: () => Promise<void>): Promise<HomeEvent[]> {
  const got: HomeEvent[] = [];
  const stream = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: stream.signal });
  const reader = res.body!.getReader();
  let buf = '';
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += Buffer.from(value!).toString();
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (line) got.push(JSON.parse(line.slice(6)) as HomeEvent);
      }
    }
  })();
  await fn();
  await new Promise((r) => setTimeout(r, 50));
  stream.abort();
  await reading;
  return got;
}

test('запуск: своё пространство и папка flow — в permissions.ask, чужие пространства — deny при любой версии claude, хук записи до и после — у каждой сессии; onFailure: block — с 2.1.295; вопрос в bypassPermissions — с 2.1.285, у старого — отказ', async () => {
  createSpace('cart');
  createSpace('else');
  for (const b of ['/fake/new/claude', '/fake/old/claude']) {
    bin = b;
    const s = await session({ space: 'cart' });
    const st = settingsOf(s.p);
    for (const d of [spaceDir('cart'), FLOWS_DIR]) assert.ok(st.permissions.ask.includes(`Edit(/${d}/**)`), `${b}: ${d}`);
    assert.ok(st.permissions.deny.includes(`Edit(/${spaceDir('else')}/**)`), b);
    assert.ok(!st.permissions.deny.some((r) => r.includes(spaceDir('cart'))), b);
    assert.deepEqual(st.hooks.PreToolUse.at(-1)!.matcher, 'Edit|Write|MultiEdit|NotebookEdit');
    assert.equal(st.hooks.PreToolUse.at(-1)!.hooks[0].onFailure, b.includes('new') ? 'block' : undefined);
    assert.deepEqual(st.hooks.PostToolUse.map((h) => h.matcher), ['Edit|Write|MultiEdit|NotebookEdit']);
    // версия — от claude --version этого бинарника: новый спрашивает и в bypassPermissions, старый там отказывает
    const doc = path.join(spaceDir('cart'), 'docs', 'a.md');
    assert.equal((await s.pre('Write', { file_path: doc, content: 'x' }, { permission_mode: 'bypassPermissions' })).permissionDecision, b.includes('new') ? 'ask' : 'deny', b);
    assert.equal((await s.pre('Write', { file_path: doc, content: 'x' }, { permission_mode: 'default' })).permissionDecision, 'ask', b);
    await s.end();
  }
  bin = '/fake/new/claude';
  // без пространства — закрыта вся папка пространств, как раньше
  const none = await session({});
  assert.ok(settingsOf(none.p).permissions.deny.includes(`Edit(/${spacesDir()}/**)`));
  await none.end();
});

test('правка файла своего пространства: вопрос с подробностями; после записи — событие space; сломанный space.json откатывается; пространство на ходу — инструментами сразу, файлами — после «Перезапустить»', async () => {
  createSpace('shop', { gist: 'магазин' });
  createSpace('blog');
  const s = await session({ space: 'shop' });
  const map = path.join(spaceDir('shop'), 'CLAUDE.md');
  const ask = await s.pre('Edit', { file_path: map, old_string: 'магазин', new_string: 'магазин и склад' });
  assert.equal(ask.permissionDecision, 'ask');
  assert.match(ask.permissionDecisionReason, /^agentgraph: пространство shop — карта \(CLAUDE\.md\)/);
  assert.equal((await s.pre('Write', { file_path: path.join(spaceDir('blog'), 'CLAUDE.md'), content: 'x' })).permissionDecision, 'deny');
  // bypassPermissions и dontAsk: claude показывает вопрос хука и там — тот же вопрос; чужое — отказ и там
  for (const permission_mode of ['bypassPermissions', 'dontAsk']) {
    assert.equal((await s.pre('Write', { file_path: map, content: 'x' }, { permission_mode })).permissionDecision, 'ask', permission_mode);
    assert.equal((await s.pre('Write', { file_path: path.join(spaceDir('blog'), 'CLAUDE.md'), content: 'x' }, { permission_mode })).permissionDecision, 'deny', permission_mode);
  }
  // человек ответил «да» — claude записал файл и прислал PostToolUse: UI получает событие
  const got = await events(async () => {
    fs.writeFileSync(map, '# магазин и склад\n');
    assert.deepEqual(await s.hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: map } }), {});
  });
  assert.ok(got.some((e) => e.type === 'space' && e.space === 'shop'), JSON.stringify(got));
  // space.json: снимок до записи у PreToolUse, сломанный после записи — откат и причина модели
  const meta = path.join(spaceDir('shop'), 'space.json');
  const good = fs.readFileSync(meta, 'utf8');
  const cur = JSON.parse(good) as Record<string, unknown>;
  const okMeta = await s.pre('Write', { file_path: meta, content: JSON.stringify({ ...cur, title: 'Магазин' }) }, { tool_use_id: 'tu-meta' });
  assert.equal(okMeta.permissionDecision, 'ask');
  assert.match(okMeta.permissionDecisionReason, /заголовок → «Магазин»/);
  fs.writeFileSync(meta, '{ "dirs": "/" }');
  const post = await s.hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: meta }, tool_use_id: 'tu-meta' });
  assert.equal(post.decision, 'block');
  assert.match(String(post.reason), /Возвращена версия до записи/);
  assert.equal(fs.readFileSync(meta, 'utf8'), good);
  assert.ok(readSpace('shop'));
  // лишнее поле — отказ ещё до вопроса; папка / — тоже, в любом режиме: проверка идёт раньше вопроса
  assert.match((await s.pre('Write', { file_path: meta, content: JSON.stringify({ ...cur, owner: 'x' }) })).permissionDecisionReason, /лишние поля: owner/);
  for (const permission_mode of ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk']) {
    const root = await s.pre('Write', { file_path: meta, content: JSON.stringify({ ...cur, dirs: ['/'] }) }, { permission_mode });
    assert.deepEqual([root.permissionDecision, /корень диска/.test(root.permissionDecisionReason)], ['deny', true], permission_mode);
  }
  // выбрали на ходу другое пространство: его папку правила этого процесса закрыли на старте — хук объясняет, что
  // писать инструментами space_* или после «Перезапустить»; прежнее — уже чужое
  await call('PUT', `/api/sessions/${s.v.id}/space`, { space: 'blog' });
  const fly = await s.pre('Write', { file_path: path.join(spaceDir('blog'), 'docs', 'a.md'), content: 'x' });
  assert.equal(fly.permissionDecision, 'deny');
  assert.match(fly.permissionDecisionReason, /выбрано на ходу.*space_map_write.*«Перезапустить»/s);
  assert.equal((await s.pre('Write', { file_path: map, content: 'x' })).permissionDecision, 'deny');
  // инструменты space_* пишут его сразу
  assert.equal((await s.tool('space_write', { name: 'a.md', text: 'x' })).isError, undefined);
  // «Перезапустить» пересчитывает правила: теперь его файлы — с вопросом
  await call('POST', `/api/sessions/${s.v.id}/restart`);
  const again = spawned.at(-1)!;
  assert.ok(settingsOf(again).permissions.ask.includes(`Edit(/${spaceDir('blog')}/**)`));
  const h = tokenOf(again);
  const after = (await call<Record<string, unknown>>('POST', `/api/sessions/${s.v.id}/hook`, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(spaceDir('blog'), 'docs', 'a.md'), content: 'y' }, permission_mode: 'default' }, h)).body;
  assert.equal((after.hookSpecificOutput as Decision).permissionDecision, 'ask');
  await call('POST', `/api/sessions/${s.v.id}/end`);
});

test('MCP: space_map_write, space_state_write и space_settings пишут пространство сессии с проверкой API и шлют событие space; не прошедшее проверку отклоняется до вопроса', async () => {
  createSpace('docs-space');
  const s = await session({ space: 'docs-space' });
  const preMcp = (name: string, input: Record<string, unknown>) => s.pre(`mcp__agentgraph__${name}`, input);
  assert.match((await preMcp('space_map_write', { text: '# Карта' })).permissionDecisionReason, /карту пространства получат памятью.*CLAUDE\.md: новый текст, 7 знаков/s);
  assert.equal((await preMcp('space_state_write', { text: 'x'.repeat(2501) })).permissionDecision, 'deny');
  assert.equal((await preMcp('space_settings', { dirs: ['/'] })).permissionDecision, 'deny');
  const specs = path.join(root, 'specs');
  fs.mkdirSync(specs, { recursive: true });
  assert.match((await preMcp('space_settings', { dirs: [specs] })).permissionDecisionReason, new RegExp(`откроет на чтение всем сессиям и запускам пространства: ${specs}`));
  const got = await events(async () => {
    assert.equal((await s.tool('space_map_write', { text: '# Карта\n\nДоговорённости' })).isError, undefined);
    assert.equal((await s.tool('space_state_write', { text: 'Суть: документы' })).isError, undefined);
    assert.match((await s.tool('space_settings', { title: 'Документы', dirs: [specs] })).content[0].text, /Настройки пространства docs-space записаны: заголовок → «Документы»/);
  });
  const sp = readSpace('docs-space')!;
  assert.deepEqual([sp.map, sp.state, sp.title, sp.dirs], ['# Карта\n\nДоговорённости\n', 'Суть: документы\n', 'Документы', [specs]]);
  // состояние, записанное сессией, — в истории пространства от её имени
  assert.deepEqual([sp.history[0].id, sp.history[0].kind], [s.v.id, 'session']);
  // событие говорит, что поменялось: форма с несохранённой картой не теряет её из-за правки документа
  assert.deepEqual(got.filter((e) => e.type === 'space' && e.space === 'docs-space').map((e) => e.spacePart), ['map', 'state', 'meta']);
  // ошибка проверки при вызове — текстом модели, без записи
  const bad = await s.tool('space_settings', { cwd: path.join(root, 'nope') });
  assert.deepEqual([bad.isError, /Рабочей папки .* нет/.test(bad.content[0].text)], [true, true]);
  await s.end();
});

test('flow: правка файла и flow_write проверяются схемой до вопроса, пишут в папку flow и шлют событие flows', async () => {
  saveFlowYaml('ship', leaf('ship'), 'lib');
  const s = await session({});
  const file = path.join(FLOWS_DIR, 'lib', 'ship.yaml');
  const ok = await s.pre('Edit', { file_path: file, old_string: 'prompt: x', new_string: 'prompt: y' });
  assert.equal(ok.permissionDecision, 'ask');
  assert.match(ok.permissionDecisionReason, /Изменит flow ship \(папка lib\), схема в порядке/);
  const bad = await s.pre('Write', { file_path: file, content: 'name: ship\nphases: 5\n' });
  assert.deepEqual([bad.permissionDecision, /Невалидный flow/.test(bad.permissionDecisionReason)], ['deny', true]);
  // flow_write: ошибка схемы — отказ до вопроса; верный — вопрос, запись, событие
  assert.equal((await s.pre('mcp__agentgraph__flow_write', { name: 'new-flow', yaml: 'name: new-flow\n' })).permissionDecision, 'deny');
  assert.match((await s.pre('mcp__agentgraph__flow_write', { name: 'new-flow', yaml: leaf('new-flow'), folder: 'lib' })).permissionDecisionReason, /Новый flow new-flow \(папка lib\)/);
  const got = await events(async () => {
    const r = await s.tool('flow_write', { name: 'new-flow', yaml: leaf('new-flow'), folder: 'lib' });
    assert.equal(r.isError, undefined, r.content[0].text);
    fs.writeFileSync(file, leaf('ship', 'y'));
    await s.hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
  });
  assert.equal(got.filter((e) => e.type === 'flows').length, 2);
  assert.ok(fs.existsSync(path.join(FLOWS_DIR, 'lib', 'new-flow.yaml')));
  const list = (await call<Array<{ name: string; valid: boolean }>>('GET', '/api/flows')).body;
  assert.deepEqual(list.filter((f) => ['ship', 'new-flow'].includes(f.name)).map((f) => [f.name, f.valid]), [['new-flow', true], ['ship', true]]);
  // папку flow сессия читает без вопроса
  const read = await s.hook({ hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: { file_path: file } });
  assert.deepEqual(read, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  // ошибка при вызове (схема сломалась между вопросом и вызовом) — текстом модели, файла нет
  const broken = await s.tool('flow_write', { name: 'other-flow', yaml: 'name: other-flow\n' });
  assert.equal(broken.isError, true);
  assert.ok(!fs.existsSync(path.join(FLOWS_DIR, 'other-flow.yaml')));
  await s.end();
});
