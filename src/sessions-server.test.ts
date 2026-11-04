// Сессии терминала через настоящий HTTP-сервер (startServer) с поддельным pty: настоящий claude не запускается.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { SessionView, SessionWsServer } from './api-types.js';
import { startServer, stopServer } from './server.js';
import { LEGACY_RECORD_FILE, SessionError, SessionManager, sessionManager, spaceWriteGuard } from './sessions-server.js';
import { createMirror, type PtyExit, type PtyProcess, type PtyKit } from './sessions-pty.js';
import { LIVE_SESSIONS_MAX } from './sessions.js';
import { createTag, tagDir, updateTag } from './tags.js';
import { createSpace, deleteSpace, migrateTaskTags, queueSpaceState, readSpace, spaceDir, writeSpaceState } from './spaces.js';
import type { SessionRequest, SessionResult } from './agent.js';

class FakePty implements PtyProcess {
  pid = 4242;
  written: string[] = [];
  killed: string[] = [];
  size: [number, number];
  private data: ((d: string) => void)[] = [];
  private exits: ((e: PtyExit) => void)[] = [];
  constructor(readonly file: string, readonly args: string[], readonly opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }) {
    this.size = [opts.cols, opts.rows];
  }
  onData(cb: (d: string) => void) {
    this.data.push(cb);
  }
  onExit(cb: (e: PtyExit) => void) {
    this.exits.push(cb);
  }
  emit(d: string) {
    for (const cb of this.data) cb(d);
  }
  exited = false;
  exit(code: number) {
    this.exited = true;
    for (const cb of this.exits) cb({ exitCode: code });
    this.exits = [];
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(cols: number, rows: number) {
    this.size = [cols, rows];
  }
  kill(signal?: string) {
    this.killed.push(signal ?? 'SIGHUP');
    setTimeout(() => this.exit(signal === 'SIGKILL' ? 137 : 129), 5);
  }
}

const spawned: FakePty[] = [];
/** Сессии состояния пространства: настоящий Agent SDK не вызывается, ответ — готовое состояние. */
const summaries: SessionRequest[] = [];
const fakeSummary = async (req: SessionRequest): Promise<SessionResult> => {
  summaries.push(req);
  return { ok: true, subtype: 'success', text: '', structured: { state: `состояние №${summaries.length}` }, costUsd: 0.01, turns: 1, durationMs: 1, errors: [] };
};
const kit: PtyKit = {
  spawn: (file, args, opts) => {
    const p = new FakePty(file, args, opts);
    spawned.push(p);
    return p;
  },
  mirror: createMirror,
};

let root = '';
let base = '';
let port = 0;
const prevConfig = process.env.AGENTGRAPH_CONFIG_DIR;

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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-ssrv-')));
  process.env.AGENTGRAPH_CONFIG_DIR = path.join(root, 'cfg');
  fs.mkdirSync(path.join(root, 'proj'));
  sessionManager({
    kit: async () => kit,
    findClaude: () => '/fake/bin/claude',
    version: async () => '2.1.311',
    agents: async () => '[]',
    dir: path.join(root, 'sessions'),
    runsDir: path.join(root, 'runs'),
    env: () => ({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_OAUTH_TOKEN: 'keep' }),
    deliveryAfterMs: 60_000,
    summarize: fakeSummary,
  });
  port = await freePort();
  await startServer({ port, host: '127.0.0.1', defaultCwd: path.join(root, 'proj'), notify: false });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  if (prevConfig === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
  else process.env.AGENTGRAPH_CONFIG_DIR = prevConfig;
  fs.rmSync(root, { recursive: true, force: true });
});

async function call<T = unknown>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** Токен сессии — из заголовка хуков в --settings, как его видит claude. */
const tokenOf = (p: FakePty) => JSON.parse(p.args[p.args.indexOf('--settings') + 1]).hooks.Stop[0].hooks[0].headers['X-Agentgraph-Session'] as string;
const hook = (id: string, token: string, input: Record<string, unknown>) => call<Record<string, unknown>>('POST', `/api/sessions/${id}/hook`, input, { 'X-Agentgraph-Session': token });
const view = async (id: string) => (await call<SessionView>('GET', `/api/sessions/${id}`)).body;
const until = async (cond: () => boolean | Promise<boolean>, ms = 2000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('не дождались');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('фича sessions есть в /api/config, когда pty загрузился', async () => {
  const r = await call<{ features: string[] }>('GET', '/api/config');
  assert.ok(r.body.features.includes('sessions'));
});

test('создание: claude без shell в папке проекта, окружение без маркеров хоста; новое пространство заводится, его папка — в --add-dir, контекст ждёт SessionStart', async () => {
  createTag('rules', 'Правила');
  updateTag('rules', { notes: 'Пиши тесты' });
  const r = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), space: 'checkout', tags: ['rules'], cols: 100, rows: 30 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const p = spawned.at(-1)!;
  assert.equal(p.file, '/fake/bin/claude');
  assert.equal(p.args[0], `--session-id=${r.body.id}`);
  assert.equal(p.opts.cwd, path.join(root, 'proj'));
  assert.deepEqual([p.opts.cols, p.opts.rows], [100, 30]);
  assert.equal(p.opts.env.CLAUDECODE, undefined);
  assert.equal(p.opts.env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(p.opts.env.CLAUDE_CODE_OAUTH_TOKEN, 'keep');
  // карта пространства — родным механизмом: его папка в --add-dir, CLAUDE.md из доп. папок включён
  const addDirs = p.args.flatMap((a, i) => (a === '--add-dir' ? [p.args[i + 1]] : []));
  assert.ok(addDirs.includes(spaceDir('checkout')), addDirs.join('\n'));
  assert.equal(p.opts.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, '1');
  // и закрыта для записи вместе со всей папкой пространств
  const deny: string[] = JSON.parse(p.args[p.args.indexOf('--settings') + 1]).permissions.deny;
  assert.ok(deny.includes(`Edit(/${path.dirname(spaceDir('checkout'))}/**)`), deny.join('\n'));
  assert.deepEqual([r.body.status, r.body.live, r.body.name, r.body.space, r.body.saveState], ['starting', true, 'checkout · rules', 'checkout', true]);
  assert.deepEqual(r.body.chips, [{ slug: 'rules', state: 'pending' }]);
  // запущен с этим пространством: карта — в памяти claude (memory), раздел ждёт SessionStart
  assert.deepEqual(r.body.spaceChip, { slug: 'checkout', state: 'pending', memory: true });
  assert.ok(fs.existsSync(path.join(root, 'sessions', r.body.id, 'session.json')));
  assert.equal((await call('GET', '/api/spaces/checkout')).status, 200);
  await until(async () => (await view(r.body.id)).claudeVersion === '2.1.311');
});

test('превью совпадает с отправленным: текст SessionStart — тот же, что /api/model-context с папкой сессии и вкладка «Контекст» пространства; папка пространства внутри рабочей — карта строкой «прочитай» и там, и там', async () => {
  createSpace('eq-space', { title: 'Равенство', gist: 'суть' });
  writeSpaceState('eq-space', 'Суть: равенство', { id: 'r0', at: '', kind: 'run' });
  createTag('eq-know');
  updateTag('eq-know', { description: 'правила', notes: 'гоняй тесты' });
  const startText = async (body: Record<string, unknown>) => {
    const { body: s } = await call<SessionView>('POST', '/api/sessions', body);
    const r = await hook(s.id, tokenOf(spawned.at(-1)!), { hook_event_name: 'SessionStart', source: 'startup', session_id: s.id });
    await call('POST', `/api/sessions/${s.id}/end`);
    return (r.body.hookSpecificOutput as { additionalContext: string }).additionalContext;
  };
  const preview = async (q: string) => (await call<{ session: string; space?: { map: { loaded: boolean } } }>('GET', `/api/model-context?${q}`)).body;
  const proj = path.join(root, 'proj');
  const withTag = await startText({ cwd: proj, space: 'eq-space', tags: ['eq-know'] });
  assert.equal(withTag, (await preview(`space=eq-space&tags=eq-know&cwd=${encodeURIComponent(proj)}`)).session);
  const bare = await startText({ cwd: proj, space: 'eq-space' });
  assert.equal(bare, (await call<{ session: string }>('GET', '/api/spaces/eq-space/context')).body.session);
  assert.match(bare, /уже в контексте как память/);
  // рабочая папка содержит папку настроек (как ~): папка пространства в --add-dir не идёт, карта — строкой «прочитай»
  const home = await startText({ cwd: root, space: 'eq-space' });
  const v = await preview(`space=eq-space&cwd=${encodeURIComponent(root)}`);
  assert.equal(home, v.session);
  assert.match(home, /прочитай её инструментом Read/);
  assert.equal(v.space?.map.loaded, false);
});

test('смена пространства на ходу: ходы до смены уходят в состояние прежнего пространства, после — нового; ходы без пространства — в следующее выбранное', async () => {
  createSpace('sw-a');
  createSpace('sw-b');
  const proj = path.join(root, 'proj');
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: proj, space: 'sw-a' });
  const token = tokenOf(spawned.at(-1)!);
  const say = (prompt: string) => hook(s.id, token, { hook_event_name: 'UserPromptSubmit', session_id: s.id, prompt });
  await hook(s.id, token, { hook_event_name: 'SessionStart', session_id: s.id });
  assert.equal((await view(s.id)).spaceChip?.memory, true);
  await say('ход-а-1');
  await hook(s.id, token, { hook_event_name: 'Stop', session_id: s.id, last_assistant_message: 'ответ-а-1' });
  await say('ход-а-2');
  await call('PUT', `/api/sessions/${s.id}/space`, { space: 'sw-b' });
  await say('ход-б-1');
  const sv = await view(s.id);
  assert.deepEqual(sv.stateSpaces, ['sw-a', 'sw-b']);
  // карта sw-b выбрана на ходу: в памяти идущего claude её нет — до «Перезапустить» она строкой «прочитай»
  assert.deepEqual([sv.spaceChip?.slug, sv.spaceChip?.memory], ['sw-b', undefined]);
  const before = summaries.length;
  await call('POST', `/api/sessions/${s.id}/end`);
  await until(async () => (await view(s.id)).newTurns === 0 && !(await view(s.id)).updatingState);
  const [a, b] = summaries.slice(before);
  assert.equal(summaries.length - before, 2);
  assert.ok(a.prompt.includes('Пространство: sw-a') && a.prompt.includes('ход-а-1') && a.prompt.includes('ход-а-2') && !a.prompt.includes('ход-б-1'), a.prompt);
  assert.ok(b.prompt.includes('Пространство: sw-b') && b.prompt.includes('ход-б-1') && !b.prompt.includes('ход-а-'), b.prompt);
  assert.match(readSpace('sw-a')!.state, /^состояние №/);
  assert.match(readSpace('sw-b')!.state, /^состояние №/);
  const v = await view(s.id);
  assert.deepEqual([v.stateUpdate?.space, v.stateUpdate?.ok, v.stateSpaces], ['sw-b', true, []]);

  // без пространства, потом выбрали — ходы уходят в выбранное (старое правило)
  const { body: n } = await call<SessionView>('POST', '/api/sessions', { cwd: proj });
  const t2 = tokenOf(spawned.at(-1)!);
  await hook(n.id, t2, { hook_event_name: 'SessionStart', session_id: n.id });
  await hook(n.id, t2, { hook_event_name: 'UserPromptSubmit', session_id: n.id, prompt: 'ход-без' });
  assert.deepEqual((await view(n.id)).stateSpaces, []);
  await call('PUT', `/api/sessions/${n.id}/space`, { space: 'sw-a' });
  assert.deepEqual((await view(n.id)).stateSpaces, ['sw-a']);
  await call('POST', `/api/sessions/${n.id}/end`);
});

test('удаление пространства: идущая сессия с ним — 409; завершённую отцепляет, и заведённое заново с тем же слагом её ходов не получит', async () => {
  createSpace('del-x');
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), space: 'del-x', saveState: false });
  const token = tokenOf(spawned.at(-1)!);
  await hook(s.id, token, { hook_event_name: 'SessionStart', session_id: s.id });
  await hook(s.id, token, { hook_event_name: 'UserPromptSubmit', session_id: s.id, prompt: 'ход в x' });
  const busy = await call<{ error: string }>('DELETE', '/api/spaces/del-x');
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /идущие сессии/);
  assert.ok(readSpace('del-x'));
  await call('POST', `/api/sessions/${s.id}/end`);
  await until(async () => !(await view(s.id)).live);
  assert.equal((await call('DELETE', '/api/spaces/del-x')).status, 200);
  let v = await view(s.id);
  assert.deepEqual([v.space, v.stateSpaces, v.newTurns], [undefined, [], 1]);
  createSpace('del-x');
  v = await view(s.id);
  assert.deepEqual(v.stateSpaces, []);
  assert.equal((await call('POST', `/api/sessions/${s.id}/state`)).status, 409);
  assert.equal((await call<{ sessions: unknown[] }>('GET', '/api/spaces/del-x')).body.sessions.length, 0);
});

test('удаление пространства: идущая сессия, у которой оно было раньше, не мешает — её прошлые ходы отцепляются; не удалилось — сессии как были', async () => {
  createSpace('del-past');
  createSpace('del-now');
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), space: 'del-past' });
  const token = tokenOf(spawned.at(-1)!);
  await hook(s.id, token, { hook_event_name: 'SessionStart', session_id: s.id });
  await hook(s.id, token, { hook_event_name: 'UserPromptSubmit', session_id: s.id, prompt: 'ход в past' });
  await call('PUT', `/api/sessions/${s.id}/space`, { space: 'del-now' });
  assert.deepEqual((await view(s.id)).stateSpaces, ['del-past']);
  // del-now выбрано у идущей сессии — 409; удаление не случилось, и сессию не тронули
  const busy = await call<{ error: string }>('DELETE', '/api/spaces/del-now');
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /заверши их или смени им пространство/);
  // папку не удалить (родитель только для чтения) — ошибка, а сессии как были: отцепляют только после удаления
  const spaces = path.dirname(spaceDir('del-past'));
  fs.chmodSync(spaces, 0o555);
  try {
    assert.notEqual((await call('DELETE', '/api/spaces/del-past')).status, 200);
  } finally {
    fs.chmodSync(spaces, 0o755);
  }
  assert.ok(readSpace('del-past'));
  assert.deepEqual((await view(s.id)).stateSpaces, ['del-past']);
  // del-past было раньше — удаляется при идущей сессии, её прошлые ходы отцеплены, текущее пространство осталось
  assert.equal((await call('DELETE', '/api/spaces/del-past')).status, 200);
  const v = await view(s.id);
  assert.deepEqual([v.live, v.space, v.stateSpaces], [true, 'del-now', []]);
  await call('POST', `/api/sessions/${s.id}/end`);
  await until(async () => !(await view(s.id)).live && !(await view(s.id)).updatingState);
});

test('сессия в папке пространства: запись в пространство, заведённое после её старта, в новую папку и в другом регистре — отказ хука; своё — решают правила', () => {
  createSpace('wg-alpha');
  const cwd = spaceDir('wg-alpha');
  createSpace('wg-gamma');
  const spaces = path.dirname(cwd);
  const w = (p: string) => spaceWriteGuard(cwd, 'Write', { file_path: p });
  assert.equal(w(path.join(cwd, 'CLAUDE.md')), undefined);
  assert.equal(w('docs/spec.md'), undefined);
  for (const p of [path.join(spaceDir('wg-gamma'), 'CLAUDE.md'), path.join(spaces, 'brand-new', 'CLAUDE.md'), path.join(spaces, 'x.md'), path.join(path.dirname(spaces), 'SPACES', 'wg-gamma', 'CLAUDE.md'), '../wg-gamma/STATE.md']) {
    assert.match(w(p) ?? '', /правит только его/, p);
  }
  assert.equal(spaceWriteGuard(cwd, 'Read', { file_path: path.join(spaceDir('wg-gamma'), 'CLAUDE.md') }), undefined);
  // сессия не в папке пространства — хук не мешает
  assert.equal(spaceWriteGuard(path.join(root, 'proj'), 'Write', { file_path: path.join(spaceDir('wg-gamma'), 'CLAUDE.md') }), undefined);
});

test('ошибки создания: нет папки, лишний режим, тег задачи и несуществующий тег, старые поля — 400, на диске ничего не остаётся', async () => {
  const before = spawned.length;
  assert.equal((await call('POST', '/api/sessions', { cwd: path.join(root, 'нет') })).status, 400);
  const bad = await call<{ error: string }>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), space: 'zz-new', permissionMode: 'bypassPermissions' });
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', '/api/spaces/zz-new')).status, 404);
  const missing = await call<{ error: string }>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), tags: ['zz-tag'] });
  assert.deepEqual([missing.status, /Тега знаний zz-tag нет/.test(missing.body.error)], [400, true]);
  fs.mkdirSync(tagDir('zz-task'), { recursive: true });
  fs.writeFileSync(path.join(tagDir('zz-task'), 'tag.json'), JSON.stringify({ slug: 'zz-task', kind: 'task', createdAt: '', updatedAt: '', runs: [] }));
  const task = await call<{ error: string }>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), tags: ['zz-task'] });
  assert.deepEqual([task.status, /выбери пространство zz-task/.test(task.body.error)], [400, true]);
  assert.equal((await call('POST', '/api/sessions', { cwd: path.join(root, 'proj'), saveTag: true })).status, 400);
  assert.equal((await call('POST', '/api/sessions', { cwd: path.join(root, 'proj'), space: '../x' })).status, 400);
  assert.equal(spawned.length, before);
});

test('хуки: чужой токен и без токена — 404; SessionStart отдаёт контекст, пространство и тег на ходу ждут следующего шага', async () => {
  createSpace('hk-space', { title: 'Корзина', gist: 'Пустая корзина падает' });
  writeSpaceState('hk-space', 'Суть: корзина', { id: 'r0', at: '', kind: 'run' });
  createTag('checkout');
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), space: 'hk-space', tags: ['checkout'] });
  const p = spawned.at(-1)!;
  const token = tokenOf(p);
  assert.equal((await hook(s.id, 'f'.repeat(64), { hook_event_name: 'SessionStart' })).status, 404);
  assert.equal((await call('POST', `/api/sessions/${s.id}/hook`, { hook_event_name: 'SessionStart' })).status, 404);
  assert.equal((await hook('00000000-0000-4000-8000-000000000000', token, { hook_event_name: 'SessionStart' })).status, 404);

  const start = await hook(s.id, token, { hook_event_name: 'SessionStart', source: 'startup', session_id: s.id, transcript_path: `/t/${s.id}.jsonl` });
  assert.equal(start.status, 200);
  const first = (start.body.hookSpecificOutput as { additionalContext: string }).additionalContext;
  assert.ok(first.includes('Пространство agentgraph «Корзина» (hk-space)') && first.includes('уже в контексте как память') && first.includes('Суть: корзина'));
  let v = await view(s.id);
  assert.deepEqual([v.status, v.chips, v.spaceChip], ['waiting', [{ slug: 'checkout', state: 'on' }], { slug: 'hk-space', state: 'on', memory: true }]);

  createTag('billing');
  v = (await call<SessionView>('PUT', `/api/sessions/${s.id}/tags`, { tags: ['billing'] })).body;
  assert.deepEqual(v.chips, [{ slug: 'billing', state: 'pending' }, { slug: 'checkout', state: 'removed' }]);
  // пространство на ходу: новое слаг — пустое пространство, чип ждёт следующего шага
  v = (await call<SessionView>('PUT', `/api/sessions/${s.id}/space`, { space: 'hk-other' })).body;
  assert.deepEqual([v.space, v.spaceChip], ['hk-other', { slug: 'hk-other', state: 'pending' }]);
  assert.equal((await call('PUT', `/api/sessions/${s.id}/space`, { space: '../x' })).status, 400);

  const prompt = await hook(s.id, token, { hook_event_name: 'UserPromptSubmit', prompt: 'почини', session_id: s.id });
  const ctx = (prompt.body.hookSpecificOutput as { additionalContext: string }).additionalContext;
  assert.ok(ctx.includes('- billing: описания нет') && ctx.includes('Тег checkout снят'), ctx);
  assert.ok(ctx.includes('Пространство hk-space снято') && ctx.includes('Пространство agentgraph hk-other') && ctx.includes('прочитай её инструментом Read') === false, ctx);
  v = await view(s.id);
  assert.deepEqual([v.status, v.turns, v.chips, v.spaceChip], ['working', 1, [{ slug: 'billing', state: 'on' }], { slug: 'hk-other', state: 'on' }]);
  // снять пространство: снятие ждёт следующего шага
  v = (await call<SessionView>('PUT', `/api/sessions/${s.id}/space`, { space: null })).body;
  assert.deepEqual([v.space, v.spaceChip], [undefined, { slug: 'hk-other', state: 'removed' }]);

  // /clear: SessionEnd с reason clear сессию не завершает
  await hook(s.id, token, { hook_event_name: 'SessionEnd', reason: 'clear', session_id: s.id });
  assert.equal((await view(s.id)).live, true);

  // MCP того же сервера: только POST и только с токеном
  const list = await call<{ result: { tools: unknown[] } }>('POST', `/api/sessions/${s.id}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'X-Agentgraph-Session': token });
  assert.equal(list.body.result.tools.length, 3);
  assert.equal((await call('POST', `/api/sessions/${s.id}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 404);
  assert.equal((await call('GET', `/api/sessions/${s.id}/mcp`, undefined, { 'X-Agentgraph-Session': token })).status, 405);

  await call('POST', `/api/sessions/${s.id}/end`);
  assert.deepEqual(p.killed, ['SIGHUP']);
  v = await view(s.id);
  assert.deepEqual([v.status, v.live, v.exitCode, v.outcome], ['ended', false, 129, undefined]);
});

test('session_new: новая сессия из терминала — папка, пространство, теги и модель как у этой; режим этой — только в том же месте, другая папка — manual; папки данных agentgraph — нельзя; экран этой получает ссылку', async () => {
  createTag('cart', 'Корзина');
  createSpace('sn-space');
  fs.mkdirSync(path.join(root, 'api'), { recursive: true });
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), space: 'sn-space', tags: ['cart'], model: 'sonnet', permissionMode: 'plan', cols: 110, rows: 33 });
  const token = tokenOf(spawned.at(-1)!);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${s.id}/ws`, { origin: `http://127.0.0.1:${port}` });
  const got: SessionWsServer[] = [];
  ws.on('message', (m) => got.push(JSON.parse(String(m)) as SessionWsServer));
  await new Promise((r) => ws.once('open', r));
  const tool = async (args: Record<string, unknown>) =>
    (await call<{ result: { content: Array<{ text: string }>; isError?: boolean } }>('POST', `/api/sessions/${s.id}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_new', arguments: args } }, { 'X-Agentgraph-Session': token })).body.result;

  const r = await tool({ prompt: 'Почини корзину', cwd: '../api', permissionMode: 'auto' });
  // режим разрешений модель не задаёт: лишний параметр — ошибка, новой сессии нет
  assert.deepEqual([r.isError, /Лишние параметры: permissionMode/.test(r.content[0].text)], [true, true]);
  const ok = await tool({ prompt: 'Почини корзину', cwd: '../api' });
  assert.equal(ok.isError, undefined, ok.content[0].text);
  const p = spawned.at(-1)!;
  assert.equal(p.opts.cwd, path.join(root, 'api'));
  assert.deepEqual([p.opts.cols, p.opts.rows], [110, 33]);
  // текст модели — с пометкой: не slash-команда и не `!`, а модель новой сессии видит, чей он
  assert.deepEqual(p.args.slice(-2), ['--', `Задача из сессии agentgraph «${s.name}»: этот текст написал Claude по просьбе пользователя.\n\nПочини корзину`]);
  assert.equal(p.args[p.args.indexOf('--model') + 1], 'sonnet');
  // другая папка — без унаследованного режима: в новом месте правки подтверждает человек
  assert.equal(p.args[p.args.indexOf('--permission-mode') + 1], 'manual');
  // та же папка и то же пространство — режим этой сессии (хуков ещё не было — режим запуска)
  assert.equal((await tool({ prompt: 'Ещё одно' })).isError, undefined);
  assert.equal(spawned.at(-1)!.args[spawned.at(-1)!.args.indexOf('--permission-mode') + 1], 'plan');
  // папка данных agentgraph (пространства, запуски) — не рабочая папка новой сессии
  const inData = await tool({ cwd: spaceDir('sn-space') });
  assert.deepEqual([inData.isError, /данные agentgraph/.test(inData.content[0].text)], [true, true]);
  await until(() => got.some((m) => m.t === 'opened'));
  const opened = got.find((m) => m.t === 'opened') as Extract<SessionWsServer, { t: 'opened' }>;
  assert.deepEqual([opened.session.cwd, opened.session.space, opened.session.tags, opened.session.live], [path.join(root, 'api'), 'sn-space', ['cart'], true]);
  assert.match(ok.content[0].text, new RegExp(`^Сессия «${opened.session.name}» открыта`));

  // теги и пространство — только существующие: опечатка не заводит пустое; [] и null — без них
  const typo = await tool({ tags: ['cart', 'no-such-tag'] });
  assert.deepEqual([typo.isError, /Тега знаний no-such-tag нет/.test(typo.content[0].text)], [true, true]);
  assert.equal((await call('GET', '/api/tags/no-such-tag')).status, 404);
  assert.equal((await tool({ tags: ['../x'] })).isError, true);
  const noSpace = await tool({ space: 'no-such-space' });
  assert.deepEqual([noSpace.isError, /Пространства no-such-space в agentgraph нет/.test(noSpace.content[0].text)], [true, true]);
  assert.equal((await call('GET', '/api/spaces/no-such-space')).status, 404);
  assert.equal((await tool({ space: null, tags: [] })).isError, undefined);
  assert.equal(spawned.at(-1)!.args.some((a) => a === spaceDir('sn-space')), false);
  // режим переключили Shift+Tab (хук принёс default) — новая сессия получает текущий: manual
  await hook(s.id, token, { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: s.id, permission_mode: 'default' });
  assert.equal((await tool({ tags: [], model: 'haiku' })).isError, undefined);
  const last = spawned.at(-1)!.args;
  assert.deepEqual([last.includes('--'), last[last.indexOf('--model') + 1], last[last.indexOf('--permission-mode') + 1]], [false, 'haiku', 'manual']);
  // PreToolUse на session_new — «спросить» даже в auto, с тем, что сделает вызов: папка, пространство, режим, начало задачи
  const pre = await hook(s.id, token, { hook_event_name: 'PreToolUse', tool_name: 'mcp__agentgraph__session_new', permission_mode: 'auto', tool_input: { cwd: '../api', prompt: 'Почини корзину' } });
  const out = pre.body.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
  assert.equal(out.permissionDecision, 'ask');
  assert.ok(out.permissionDecisionReason.includes(`Папка: ${path.join(root, 'api')}`), out.permissionDecisionReason);
  assert.match(out.permissionDecisionReason, /пространство sn-space; режим: manual; первое сообщение: «Почини корзину»/);
  // space_write — какой файл и что с ним станет
  const pw = await hook(s.id, token, { hook_event_name: 'PreToolUse', tool_name: 'mcp__agentgraph__space_write', tool_input: { name: 'plan.md', text: 'x' } });
  assert.match((pw.body.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason, /docs\/plan\.md: новый документ, 1 Б/);
  ws.close();
  for (const v of (await call<{ sessions: SessionView[] }>('GET', '/api/sessions')).body.sessions.filter((x) => x.live)) await call('POST', `/api/sessions/${v.id}/end`);
});

test('выход без SessionStart с диалогом доверия на экране — «папка не доверена», а не просто «код 0»', async () => {
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj') });
  const p = spawned.at(-1)!;
  p.emit('Quick safety check: Is this a project you created or one you trust?\r\n');
  p.exit(0);
  await until(async () => !(await view(s.id)).live);
  const v = await view(s.id);
  assert.deepEqual([v.status, v.exitCode, v.outcome], ['ended', 0, 'untrusted']);
});

test('WebSocket: чужой Origin, без Origin и чужой Host — отказ; свой — состояние, снимок экрана, вывод и ввод', async () => {
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj') });
  const p = spawned.at(-1)!;
  p.emit('\x1b[1mпервый экран\x1b[0m\r\n');
  const url = `ws://127.0.0.1:${port}/api/sessions/${s.id}/ws`;
  const refused = (opts: ConstructorParameters<typeof WebSocket>[2]) =>
    new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, opts);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('открылся')));
      ws.on('error', () => {});
    });
  assert.equal(await refused({ origin: 'http://evil.example' }), 403);
  assert.equal(await refused({}), 403);
  assert.equal(await refused({ origin: `http://127.0.0.1:${port + 1}` }), 403);
  assert.equal(await refused({ origin: 'http://evil.example:1', headers: { host: 'evil.example:1' } }), 421);

  const ws = new WebSocket(url, { origin: `http://127.0.0.1:${port}` });
  const got: SessionWsServer[] = [];
  ws.on('message', (m) => got.push(JSON.parse(String(m)) as SessionWsServer));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'r', cols: 90, rows: 25 }));
  await until(() => got.some((m) => m.t === 'snap'));
  assert.equal(got[0].t, 's');
  const snap = got.find((m) => m.t === 'snap') as Extract<SessionWsServer, { t: 'snap' }>;
  assert.ok(snap.d.includes('первый экран'));
  assert.deepEqual([snap.cols, snap.rows, p.size], [90, 25, [90, 25]]);
  p.emit('второй');
  await until(() => got.some((m) => m.t === 'o' && m.d === 'второй'));
  // вывод до подключения в поток не повторяется
  assert.ok(!got.some((m) => m.t === 'o' && m.d.includes('первый экран')));
  ws.send(JSON.stringify({ t: 'i', d: 'привет\r' }));
  await until(() => p.written.includes('привет\r'));
  // кривые кадры не роняют сервер: обработчик ws вызывается синхронно из разбора кадра
  for (const bad of ['null', '"x"', '[1]', '{"t":"r","cols":"a"}', 'не json']) ws.send(bad);
  ws.send(JSON.stringify({ t: 'i', d: 'ещё\r' }));
  await until(() => p.written.includes('ещё\r'));
  assert.equal((await call('GET', `/api/sessions/${s.id}`)).status, 200);
  ws.close();

  // завершённая: зеркало отпущено, новое подключение получает снимок последнего экрана
  p.emit('последний экран');
  p.exit(0);
  await until(async () => !(await view(s.id)).live);
  const late = new WebSocket(url, { origin: `http://127.0.0.1:${port}` });
  const lateGot: SessionWsServer[] = [];
  late.on('message', (m) => lateGot.push(JSON.parse(String(m)) as SessionWsServer));
  await new Promise((r) => late.once('open', r));
  late.send(JSON.stringify({ t: 'r', cols: 90, rows: 25 }));
  await until(() => lateGot.some((m) => m.t === 'snap'));
  assert.ok((lateGot.find((m) => m.t === 'snap') as Extract<SessionWsServer, { t: 'snap' }>).d.includes('последний экран'));
  late.send(JSON.stringify({ t: 'i', d: 'в пустоту' }));
  late.close();
  assert.ok(!p.written.includes('в пустоту'));
});

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

test('журнал ходов и состояние при выходе: сессия haiku пишет STATE.md пространства как сессия, ходы учтены', async () => {
  createSpace('sum-space', { title: 'Корзина' });
  createTag('sum-know');
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), space: 'sum-space', tags: ['sum-know'], name: 'корзина' });
  const p = spawned.at(-1)!;
  const token = tokenOf(p);
  await hook(s.id, token, { hook_event_name: 'SessionStart', session_id: uuid(1), transcript_path: path.join(root, `${uuid(1)}.jsonl`) });
  await hook(s.id, token, { hook_event_name: 'UserPromptSubmit', session_id: uuid(1), prompt: 'почини пустую корзину' });
  await hook(s.id, token, { hook_event_name: 'Stop', session_id: uuid(1), last_assistant_message: 'Поправил validate.ts' });
  assert.equal((await view(s.id)).newTurns, 1);
  const before = summaries.length;
  p.exit(0);
  await until(async () => Boolean((await view(s.id)).stateUpdate));
  const v = await view(s.id);
  assert.deepEqual([v.stateUpdate?.space, v.stateUpdate?.ok, v.stateUpdate?.error, v.newTurns, v.updatingState], ['sum-space', true, undefined, 0, undefined]);
  // одна сессия состояния на пространство; в промпте — ход сессии и карта, без транскрипта
  assert.equal(summaries.length, before + 1);
  const req = summaries.at(-1)!;
  assert.ok(req.prompt.includes('почини пустую корзину') && req.prompt.includes('Поправил validate.ts') && !req.prompt.includes(`${uuid(1)}.jsonl`));
  assert.ok(req.prompt.includes(path.join(spaceDir('sum-space'), 'CLAUDE.md')));
  assert.equal(req.model, 'haiku');
  const space = readSpace('sum-space')!;
  assert.equal(space.state.trim(), `состояние №${summaries.length}`);
  assert.deepEqual({ ...space.history[0], at: '' }, { id: s.id, at: '', kind: 'session', title: 'корзина' });
  // новых ходов нет — кнопке нечего делать; без пространства — тоже 409
  assert.equal((await call('POST', `/api/sessions/${s.id}/state`)).status, 409);
  // страница пространства видит сессию
  const detail = (await call<{ sessions: { id: string }[] }>('GET', '/api/spaces/sum-space')).body;
  assert.ok(detail.sessions.some((x) => x.id === s.id));
});

test('space_write из терминала: документ в docs/ пространства сессии; без пространства, CLAUDE.md и путь наружу — ошибка текстом', async () => {
  createSpace('sw-space');
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), space: 'sw-space' });
  const token = tokenOf(spawned.at(-1)!);
  const write = async (args: Record<string, unknown>) =>
    (await call<{ result: { content: Array<{ text: string }>; isError?: boolean } }>('POST', `/api/sessions/${s.id}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'space_write', arguments: args } }, { 'X-Agentgraph-Session': token })).body.result;
  const ok = await write({ name: 'decisions.md', text: '# Решения\nвыбрали X' });
  assert.equal(ok.isError, undefined, ok.content[0].text);
  assert.equal(fs.readFileSync(path.join(spaceDir('sw-space'), 'docs', 'decisions.md'), 'utf8'), '# Решения\nвыбрали X');
  for (const bad of [{ name: 'CLAUDE.md', text: 'x' }, { name: '../space.json', text: '{}' }, { name: 'x.json', text: '{}' }]) {
    assert.equal((await write(bad)).isError, true, JSON.stringify(bad));
  }
  assert.ok(!fs.existsSync(path.join(spaceDir('sw-space'), 'docs', 'CLAUDE.md')));
  await call('PUT', `/api/sessions/${s.id}/space`, { space: null });
  const none = await write({ name: 'a.md', text: 'x' });
  assert.deepEqual([none.isError, /нет пространства/.test(none.content[0].text)], [true, true]);
  // PreToolUse на space_write — «спросить» даже в auto
  const pre = await hook(s.id, token, { hook_event_name: 'PreToolUse', tool_name: 'mcp__agentgraph__space_write', permission_mode: 'auto' });
  assert.equal((pre.body.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'ask');
  await call('POST', `/api/sessions/${s.id}/end`);
});

test('«Продолжить»: транскрипта нет — новый разговор, есть — --resume последнего; открытый экран переходит к новому процессу', async () => {
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj') });
  let p = spawned.at(-1)!;
  // ни одного сообщения: транскрипта нет
  await hook(s.id, tokenOf(p), { hook_event_name: 'SessionStart', session_id: s.id, transcript_path: path.join(root, `${s.id}.jsonl`) });
  p.exit(0);
  await until(async () => !(await view(s.id)).live);
  assert.equal((await view(s.id)).resumable, false);
  assert.equal((await call('POST', `/api/sessions/${s.id}/continue`, {})).status, 200);
  p = spawned.at(-1)!;
  assert.match(p.args[0], /^--session-id=/);
  assert.notEqual(p.args[0], `--session-id=${s.id}`);
  assert.equal((await call('POST', `/api/sessions/${s.id}/continue`, {})).status, 409);

  // разговор с сообщением: транскрипт есть — --resume, адрес тот же, экран переподключается сам
  const tp = path.join(root, `${uuid(2)}.jsonl`);
  fs.writeFileSync(tp, '{}\n');
  await hook(s.id, tokenOf(p), { hook_event_name: 'SessionStart', session_id: uuid(2), transcript_path: tp });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${s.id}/ws`, { origin: `http://127.0.0.1:${port}` });
  const got: SessionWsServer[] = [];
  ws.on('message', (m) => got.push(JSON.parse(String(m)) as SessionWsServer));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'r', cols: 80, rows: 24 }));
  await until(() => got.some((m) => m.t === 'snap'));
  p.exit(0);
  await until(async () => (await view(s.id)).resumable === true);
  const snaps = got.filter((m) => m.t === 'snap').length;
  assert.equal((await call('POST', `/api/sessions/${s.id}/continue`, {})).status, 200);
  p = spawned.at(-1)!;
  assert.equal(p.args[0], `--resume=${uuid(2)}`);
  p.emit('новый процесс');
  await until(() => got.filter((m) => m.t === 'snap').length > snaps && got.some((m) => m.t === 'o' && m.d === 'новый процесс'));
  ws.send(JSON.stringify({ t: 'i', d: 'дальше' }));
  await until(() => p.written.includes('дальше'));
  ws.close();
  await call('POST', `/api/sessions/${s.id}/end`);
});

test('«Перезапустить»: старый процесс — SIGHUP, новый — тот же разговор с пересчитанными папками (пространство на ходу — в --add-dir), состояние не пишется', async () => {
  createTag('rs-task');
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), tags: ['rs-task'] });
  const old = spawned.at(-1)!;
  const tp = path.join(root, `${uuid(3)}.jsonl`);
  fs.writeFileSync(tp, '{}\n');
  await hook(s.id, tokenOf(old), { hook_event_name: 'SessionStart', session_id: uuid(3), transcript_path: tp });
  await hook(s.id, tokenOf(old), { hook_event_name: 'UserPromptSubmit', session_id: uuid(3), prompt: 'шаг' });
  const specs = path.join(root, 'rs-specs');
  fs.mkdirSync(specs, { recursive: true });
  createTag('rs-know');
  updateTag('rs-know', { dirs: [specs] });
  await call('PUT', `/api/sessions/${s.id}/tags`, { tags: ['rs-task', 'rs-know'] });
  await call('PUT', `/api/sessions/${s.id}/space`, { space: 'rs-space' });
  const before = summaries.length;
  const r = await call<SessionView>('POST', `/api/sessions/${s.id}/restart`);
  assert.deepEqual([r.status, r.body.live], [200, true]);
  const fresh = spawned.at(-1)!;
  assert.deepEqual([old.killed, fresh.args[0]], [['SIGHUP'], `--resume=${uuid(3)}`]);
  assert.ok(fresh.args.includes(specs));
  assert.ok(fresh.args.includes(spaceDir('rs-space')));
  // после перезапуска карта нового пространства — уже память: SessionStart говорит «уже в контексте»
  const restarted = await hook(s.id, tokenOf(fresh), { hook_event_name: 'SessionStart', session_id: uuid(3), transcript_path: tp });
  assert.match((restarted.body.hookSpecificOutput as { additionalContext: string }).additionalContext, /Пространство agentgraph rs-space/);
  assert.notEqual(tokenOf(fresh), tokenOf(old));
  // старый токен больше не открывает хуки
  assert.equal((await hook(s.id, tokenOf(old), { hook_event_name: 'Stop' })).status, 404);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(summaries.length, before);
  assert.equal((await view(s.id)).newTurns, 1);
  await call('POST', `/api/sessions/${s.id}/end`);
  await until(async () => (await view(s.id)).stateUpdate !== undefined);
  assert.equal(summaries.length, before + 1);
});

test('удаление: живую — нельзя, завершённую — папка с журналом и файлами удаляется', async () => {
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj') });
  assert.equal((await call('DELETE', `/api/sessions/${s.id}`)).status, 409);
  await call('POST', `/api/sessions/${s.id}/end`);
  assert.equal((await call('DELETE', `/api/sessions/${s.id}`)).status, 200);
  assert.equal(fs.existsSync(path.join(root, 'sessions', s.id)), false);
  assert.equal((await call('GET', `/api/sessions/${s.id}`)).status, 404);
});

test(`лимит: живых сессий не больше ${LIVE_SESSIONS_MAX} — дальше 409`, async () => {
  const live = async () => (await call<{ sessions: SessionView[] }>('GET', '/api/sessions')).body.sessions.filter((x) => x.live).length;
  while ((await live()) < LIVE_SESSIONS_MAX) assert.equal((await call('POST', '/api/sessions', {})).status, 201);
  const r = await call<{ code: string }>('POST', '/api/sessions', {});
  assert.deepEqual([r.status, r.body.code], [409, 'limit']);
});

test('stopServer: открытый WebSocket и живые claude не держат остановку; claude получают SIGHUP', async () => {
  const list = (await call<{ sessions: SessionView[] }>('GET', '/api/sessions')).body.sessions;
  const s = list.find((x) => x.live)!;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${s.id}/ws`, { origin: `http://127.0.0.1:${port}` });
  await new Promise((r) => ws.once('open', r));
  const closed = new Promise((r) => ws.once('close', r));
  const t = Date.now();
  await stopServer(3000);
  assert.ok(Date.now() - t < 4000, `остановка заняла ${Date.now() - t} мс`);
  await closed;
  // все вышли; кого гасила остановка — сначала SIGHUP (SessionEnd успевает дойти), без SIGKILL
  assert.deepEqual(spawned.filter((p) => !p.exited), []);
  assert.ok(spawned.filter((p) => p.killed.includes('SIGHUP')).length >= LIVE_SESSIONS_MAX);
  assert.ok(spawned.every((p) => !p.killed.includes('SIGKILL')));
});

test('остановка сервера: новые сессии после stopAll не создаются — их claude никто бы не погасил', async () => {
  const mgr = new SessionManager({ ...sessionManager().deps, dir: path.join(root, 'sessions-stop') });
  await mgr.stopAll(100);
  await assert.rejects(mgr.create({ cwd: path.join(root, 'proj') }, port, root), (err: unknown) => err instanceof SessionError && err.status === 503);
});

test('выход приложения: состояние не пишется, у сессии пометка; после перезапуска сервера сессии с диска — завершённые, старая запись с тегом задачи — с пространством', async () => {
  const dir = path.join(root, 'sessions-restart');
  const deps = { ...sessionManager().deps, dir };
  const mgr = new SessionManager(deps);
  await mgr.available();
  createSpace('app-space');
  const v = await mgr.create({ cwd: path.join(root, 'proj'), space: 'app-space' }, port, root);
  const live = mgr.sessions.get(v.id)!;
  const res = { once: () => res } as unknown as Parameters<SessionManager['hook']>[2];
  mgr.hook(live, { hook_event_name: 'UserPromptSubmit', session_id: uuid(4), prompt: 'шаг' }, res);
  const before = summaries.length;
  await mgr.stopAll(1000);
  assert.equal(summaries.length, before);
  assert.equal(mgr.view(live).statePending, 'app-closed');
  // сервер упал, пока шла другая сессия — запись до пространств: тег задачи (перенесётся в пространство), тег знаний,
  // saveTag и итог саммари; в session.json нет endedAt
  fs.mkdirSync(tagDir('app-legacy'), { recursive: true });
  fs.writeFileSync(path.join(tagDir('app-legacy'), 'tag.json'), JSON.stringify({ slug: 'app-legacy', kind: 'task', createdAt: '', updatedAt: '', runs: [] }));
  // перенос идёт раз на процесс, а тег появился после него: как при следующем старте сервера
  migrateTaskTags({ force: true });
  createTag('app-know');
  const crashed = uuid(5);
  fs.mkdirSync(path.join(dir, crashed));
  fs.writeFileSync(path.join(dir, crashed, 'session.json'), JSON.stringify({
    id: crashed, name: 'упавшая', cwd: root, tags: ['app-know', 'app-legacy'], saveTag: true, claudeSessionIds: [], createdAt: '2026-10-27T10:00:00.000Z', lastActivityAt: '2026-10-27T11:00:00.000Z', turns: 2,
    summary: { at: '2026-10-27T10:30:00.000Z', tags: ['app-legacy'], costUsd: 0.01 }, summarizedTurns: 1,
  }));
  fs.mkdirSync(path.join(dir, 'not-a-session'));
  fs.writeFileSync(path.join(dir, uuid(6) + '.json'), '{}');

  const next = new SessionManager(deps);
  assert.equal(await next.available(), true);
  const list = next.list().sessions;
  assert.deepEqual(list.map((x) => [x.id, x.live, x.status, x.statePending]).sort(), [[crashed, false, 'ended', 'app-closed'], [v.id, false, 'ended', 'app-closed']].sort());
  const old = list.find((x) => x.id === crashed)!;
  assert.equal(old.endedAt, '2026-10-27T11:00:00.000Z');
  assert.deepEqual([old.space, old.tags, old.saveState, old.newTurns, old.stateUpdate?.ok], ['app-legacy', ['app-know'], true, 1, true]);
  assert.deepEqual(next.spaceSessions('app-legacy').map((x) => [x.id, x.legacy]), [[crashed, true]]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, crashed, 'session.json'), 'utf8'));
  assert.deepEqual([saved.space, saved.legacyTaskTags, saved.saveState, 'saveTag' in saved, 'summary' in saved], ['app-legacy', ['app-legacy'], true, false, false]);
  // прежний файл — рядом копией: его читает старая версия agentgraph
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, crashed, LEGACY_RECORD_FILE), 'utf8')).tags, ['app-know', 'app-legacy']);
  // «Обновить состояние» по завершённой — по журналу ходов
  next.startState(v.id);
  await until(() => next.view(next.get(v.id)).stateUpdate !== undefined);
  assert.equal(next.view(next.get(v.id)).statePending, undefined);
  assert.ok(summaries.at(-1)!.prompt.includes('шаг'));
});

test('старая завершённая сессия с тегами задач: пространство выводится один раз и не меняется от старта к старту; выбор пространства руками снимает её со страниц тегов задач', async () => {
  const dir = path.join(root, 'sessions-legacy');
  const deps = { ...sessionManager().deps, dir };
  for (const slug of ['lg-a', 'lg-b']) {
    fs.mkdirSync(tagDir(slug), { recursive: true });
    fs.writeFileSync(path.join(tagDir(slug), 'tag.json'), JSON.stringify({ slug, kind: 'task', createdAt: '', updatedAt: '', runs: [] }));
  }
  migrateTaskTags({ force: true });
  const id = uuid(11);
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  const legacy = { id, name: 'старая', cwd: root, tags: ['lg-a', 'lg-b'], saveTag: true, claudeSessionIds: [], createdAt: '2026-10-27T10:00:00.000Z', lastActivityAt: '2026-10-27T11:00:00.000Z', endedAt: '2026-10-27T11:00:00.000Z', turns: 3 };
  fs.writeFileSync(path.join(dir, id, 'session.json'), JSON.stringify(legacy));
  const first = new SessionManager(deps);
  await first.available();
  assert.equal(first.view(first.get(id)).space, 'lg-a');
  // завершённая запись тоже сохранена в новом виде, прежняя — рядом
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, id, 'session.json'), 'utf8')).space, 'lg-a');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, id, LEGACY_RECORD_FILE), 'utf8')), legacy);
  // пространство удалили: после перезапуска сессия не переезжает в следующий тег задачи
  deleteSpace('lg-a');
  const second = new SessionManager(deps);
  await second.available();
  assert.deepEqual([second.view(second.get(id)).space, second.view(second.get(id)).spaceChip?.missing], ['lg-a', true]);
  assert.deepEqual(second.spaceSessions('lg-b').map((x) => [x.id, x.legacy]), [[id, true]]);
  // выбрали пространство руками: со страниц тегов задач сессия уходит, её папка их рабочей папкой больше не считается
  second.setSpace(id, { space: 'lg-b' });
  assert.deepEqual(second.spaceSessions('lg-b').map((x) => [x.id, x.legacy]), [[id, undefined]]);
  second.setSpace(id, { space: null });
  assert.deepEqual([second.spaceSessions('lg-a'), second.spaceSessions('lg-b')], [[], []]);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, id, 'session.json'), 'utf8'));
  // теги задач для пометки на --resume остаются: контекст тега мог остаться в транскрипте
  assert.deepEqual(['legacyTaskTags' in rec, rec.preSpacesTags], [false, ['lg-a', 'lg-b']]);
});

test('остановка сервера прерывает идущее обновление состояния: сессия haiku гасится, ходы не учтены, пометка «приложение закрыли»', async () => {
  const seen: SessionRequest[] = [];
  // сессия саммари, которая кончается только прерыванием
  const slow = (req: SessionRequest) =>
    new Promise<SessionResult>((resolve) => {
      seen.push(req);
      req.abort!.signal.addEventListener('abort', () => resolve({ ok: false, subtype: 'error_during_execution', text: '', costUsd: 0.002, turns: 0, durationMs: 1, errors: ['aborted'] }));
    });
  const mgr = new SessionManager({ ...sessionManager().deps, dir: path.join(root, 'sessions-abort'), summarize: slow });
  await mgr.available();
  createSpace('abort-space');
  const v = await mgr.create({ cwd: path.join(root, 'proj'), space: 'abort-space' }, port, root);
  const live = mgr.sessions.get(v.id)!;
  const res = { once: () => res } as unknown as Parameters<SessionManager['hook']>[2];
  mgr.hook(live, { hook_event_name: 'UserPromptSubmit', session_id: uuid(7), prompt: 'шаг' }, res);
  await mgr.end(v.id);
  await until(() => seen.length === 1 && mgr.view(live).updatingState === true);
  await mgr.stopAll(1000);
  assert.equal(seen[0].abort?.signal.aborted, true);
  const after = mgr.view(live);
  assert.deepEqual([after.updatingState, after.statePending, after.newTurns, after.stateUpdate], [undefined, 'app-closed', 1, undefined]);
  assert.equal(readSpace('abort-space')!.history.length, 0);
  // очередь пространства свободна: запуск за этим состоянием не ждёт
  assert.equal(await Promise.race([queueSpaceState('abort-space', async () => 'дождался'), new Promise((r) => setTimeout(() => r('висит'), 500))]), 'дождался');
  // и новое обновление после остановки не начинается
  assert.throws(() => mgr.startState(v.id), (err: unknown) => err instanceof SessionError && err.status === 503);
});

test('WebSocket upgrade: кривой request-target — 400 без падения сервера; отклонённый сокет закрыт целиком и не держит server.close', async () => {
  const mgr = new SessionManager({ ...sessionManager().deps, dir: path.join(root, 'sessions-upgrade') });
  const srv = http.createServer((_q, r) => r.end());
  srv.on('upgrade', (req, socket, head) => mgr.upgrade(req, socket, head));
  const p = await new Promise<number>((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as net.AddressInfo).port)));
  // клиент полуоткрытый: сам соединение не закрывает, как зависшая страница
  const raw = (target: string, origin: string) =>
    new Promise<{ text: string; closed: boolean }>((resolve) => {
      const s = net.connect({ port: p, host: '127.0.0.1', allowHalfOpen: true });
      let text = '';
      s.on('data', (d) => (text += String(d)));
      s.on('error', () => {});
      s.on('end', () => setTimeout(() => resolve({ text, closed: s.destroyed || s.readyState === 'writeOnly' }), 50));
      s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
  const own = `http://127.0.0.1:${p}`;
  assert.match((await raw('//[', own)).text, /^HTTP\/1\.1 400 /);
  assert.match((await raw(`/api/sessions/${uuid(8)}/ws`, 'http://evil.example')).text, /^HTTP\/1\.1 403 /);
  assert.match((await raw(`/api/sessions/${uuid(8)}/ws`, own)).text, /^HTTP\/1\.1 404 /);
  // полуоткрытый отклонённый сокет держал бы close бесконечно: ждём не дольше 1,5 с, чтобы тест падал, а не висел
  const t = Date.now();
  const closed = await Promise.race([new Promise((r) => srv.close(() => r(true))), new Promise((r) => setTimeout(() => r(false), 1500))]);
  assert.ok(closed && Date.now() - t < 1000, `server.close ждал ${Date.now() - t} мс`);
});

test('сессии с диска: не записалась одна (нет прав) — остальные загружаются, фича есть', async () => {
  const dir = path.join(root, 'sessions-ro');
  const ok = uuid(9);
  const ro = uuid(10);
  for (const id of [ok, ro]) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'session.json'), JSON.stringify({ id, name: id.slice(0, 8), cwd: root, tags: [], saveTag: true, claudeSessionIds: [], createdAt: '2026-10-27T10:00:00.000Z', lastActivityAt: '2026-10-27T11:00:00.000Z', turns: 0 }));
  }
  // без endedAt загрузка дописывает session.json — в папку только для чтения не получится
  fs.chmodSync(path.join(dir, ro), 0o500);
  try {
    const mgr = new SessionManager({ ...sessionManager().deps, dir });
    assert.equal(await mgr.available(), true);
    assert.deepEqual(mgr.list().sessions.map((s) => s.id).sort(), [ok, ro].sort());
  } finally {
    fs.chmodSync(path.join(dir, ro), 0o700);
  }
});
