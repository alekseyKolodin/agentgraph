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
import { SessionError, SessionManager, sessionManager } from './sessions-server.js';
import { createMirror, type PtyExit, type PtyProcess, type PtyKit } from './sessions-pty.js';
import { LIVE_SESSIONS_MAX } from './sessions.js';
import { createTag, queueTagSummary, readTag, updateTag } from './tags.js';
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
/** Сессии саммари тегов: настоящий Agent SDK не вызывается, ответ — готовое саммари. */
const summaries: SessionRequest[] = [];
const fakeSummary = async (req: SessionRequest): Promise<SessionResult> => {
  summaries.push(req);
  return { ok: true, subtype: 'success', text: '', structured: { summary: `саммари №${summaries.length}` }, costUsd: 0.01, turns: 1, durationMs: 1, errors: [] };
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

test('создание: claude без shell в папке проекта, окружение без маркеров хоста, теги ждут SessionStart', async () => {
  createTag('checkout', 'Корзина');
  updateTag('checkout', { notes: 'Пустая корзина падает' });
  const r = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), tags: ['checkout', 'new-one'], cols: 100, rows: 30 });
  assert.equal(r.status, 201);
  const p = spawned.at(-1)!;
  assert.equal(p.file, '/fake/bin/claude');
  assert.equal(p.args[0], `--session-id=${r.body.id}`);
  assert.equal(p.opts.cwd, path.join(root, 'proj'));
  assert.deepEqual([p.opts.cols, p.opts.rows], [100, 30]);
  assert.equal(p.opts.env.CLAUDECODE, undefined);
  assert.equal(p.opts.env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(p.opts.env.CLAUDE_CODE_OAUTH_TOKEN, 'keep');
  assert.deepEqual([r.body.status, r.body.live, r.body.name], ['starting', true, 'checkout · new-one']);
  assert.deepEqual(r.body.chips, [{ slug: 'checkout', kind: 'task', state: 'pending' }, { slug: 'new-one', kind: 'task', state: 'pending' }]);
  assert.ok(fs.existsSync(path.join(root, 'sessions', r.body.id, 'session.json')));
  // новый слаг завёлся тегом задачи
  assert.equal((await call<{ kind: string }>('GET', '/api/tags/new-one')).body.kind, 'task');
  await until(async () => (await view(r.body.id)).claudeVersion === '2.1.311');
});

test('ошибки создания: нет папки, лишний режим разрешений — 400, на диске ничего не остаётся', async () => {
  const before = spawned.length;
  assert.equal((await call('POST', '/api/sessions', { cwd: path.join(root, 'нет') })).status, 400);
  const bad = await call<{ error: string }>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), tags: ['zz-new'], permissionMode: 'bypassPermissions' });
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', '/api/tags/zz-new')).status, 404);
  assert.equal(spawned.length, before);
});

test('хуки: чужой токен и без токена — 404; SessionStart отдаёт контекст, тег на ходу ждёт следующего шага', async () => {
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), tags: ['checkout'] });
  const p = spawned.at(-1)!;
  const token = tokenOf(p);
  assert.equal((await hook(s.id, 'f'.repeat(64), { hook_event_name: 'SessionStart' })).status, 404);
  assert.equal((await call('POST', `/api/sessions/${s.id}/hook`, { hook_event_name: 'SessionStart' })).status, 404);
  assert.equal((await hook('00000000-0000-4000-8000-000000000000', token, { hook_event_name: 'SessionStart' })).status, 404);

  const start = await hook(s.id, token, { hook_event_name: 'SessionStart', source: 'startup', session_id: s.id, transcript_path: `/t/${s.id}.jsonl` });
  assert.equal(start.status, 200);
  assert.ok(JSON.stringify(start.body).includes('Пустая корзина падает'));
  let v = await view(s.id);
  assert.deepEqual([v.status, v.chips], ['waiting', [{ slug: 'checkout', kind: 'task', state: 'on' }]]);

  createTag('billing');
  v = (await call<SessionView>('PUT', `/api/sessions/${s.id}/tags`, { tags: ['billing'] })).body;
  assert.deepEqual(v.chips, [{ slug: 'billing', kind: 'task', state: 'pending' }, { slug: 'checkout', kind: 'task', state: 'removed' }]);

  const prompt = await hook(s.id, token, { hook_event_name: 'UserPromptSubmit', prompt: 'почини', session_id: s.id });
  const ctx = (prompt.body.hookSpecificOutput as { additionalContext: string }).additionalContext;
  assert.ok(ctx.includes('Тег задачи: billing') && ctx.includes('Тег checkout снят'));
  v = await view(s.id);
  assert.deepEqual([v.status, v.turns, v.chips], ['working', 1, [{ slug: 'billing', kind: 'task', state: 'on' }]]);

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

test('session_new: новая сессия из терминала — папка, теги и модель как у этой, режим — всегда этой; экран этой получает ссылку', async () => {
  createTag('cart', 'Корзина');
  fs.mkdirSync(path.join(root, 'api'), { recursive: true });
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), tags: ['cart'], model: 'sonnet', permissionMode: 'plan', cols: 110, rows: 33 });
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
  // хуков ещё не было — режим запуска
  assert.equal(p.args[p.args.indexOf('--permission-mode') + 1], 'plan');
  await until(() => got.some((m) => m.t === 'opened'));
  const opened = got.find((m) => m.t === 'opened') as Extract<SessionWsServer, { t: 'opened' }>;
  assert.deepEqual([opened.session.cwd, opened.session.tags, opened.session.live], [path.join(root, 'api'), ['cart'], true]);
  assert.match(ok.content[0].text, new RegExp(`^Сессия «${opened.session.name}» открыта`));

  // теги — только существующие: опечатка не заводит пустой тег; [] — без тегов
  const typo = await tool({ tags: ['cart', 'no-such-tag'] });
  assert.deepEqual([typo.isError, typo.content[0].text], [true, 'Тегов no-such-tag в agentgraph нет: новой сессии можно дать только существующие']);
  assert.equal((await call('GET', '/api/tags/no-such-tag')).status, 404);
  assert.equal((await tool({ tags: ['../x'] })).isError, true);
  // режим переключили Shift+Tab (хук принёс default) — новая сессия получает текущий: manual
  await hook(s.id, token, { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: s.id, permission_mode: 'default' });
  assert.equal((await tool({ tags: [], model: 'haiku' })).isError, undefined);
  const last = spawned.at(-1)!.args;
  assert.deepEqual([last.includes('--'), last[last.indexOf('--model') + 1], last[last.indexOf('--permission-mode') + 1]], [false, 'haiku', 'manual']);
  // PreToolUse на session_new — «спросить» даже в auto
  const pre = await hook(s.id, token, { hook_event_name: 'PreToolUse', tool_name: 'mcp__agentgraph__session_new', permission_mode: 'auto' });
  assert.equal((pre.body.hookSpecificOutput as { permissionDecision: string }).permissionDecision, 'ask');
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

test('журнал ходов и саммари при выходе: сессия haiku на каждый тег задачи, запись в тег как сессия, ходы учтены', async () => {
  createTag('sum-task');
  createTag('sum-know', undefined, 'knowledge');
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), tags: ['sum-task', 'sum-know'], name: 'корзина' });
  const p = spawned.at(-1)!;
  const token = tokenOf(p);
  await hook(s.id, token, { hook_event_name: 'SessionStart', session_id: uuid(1), transcript_path: path.join(root, `${uuid(1)}.jsonl`) });
  await hook(s.id, token, { hook_event_name: 'UserPromptSubmit', session_id: uuid(1), prompt: 'почини пустую корзину' });
  await hook(s.id, token, { hook_event_name: 'Stop', session_id: uuid(1), last_assistant_message: 'Поправил validate.ts' });
  assert.equal((await view(s.id)).newTurns, 1);
  const before = summaries.length;
  p.exit(0);
  await until(async () => Boolean((await view(s.id)).summary));
  const v = await view(s.id);
  assert.deepEqual([v.summary?.tags, v.summary?.errors, v.newTurns, v.summarizing], [['sum-task'], undefined, 0, undefined]);
  // тег знаний саммари не получает; в промпте — ход сессии, без транскрипта
  assert.equal(summaries.length, before + 1);
  const req = summaries.at(-1)!;
  assert.ok(req.prompt.includes('почини пустую корзину') && req.prompt.includes('Поправил validate.ts') && !req.prompt.includes(`${uuid(1)}.jsonl`));
  assert.equal(req.model, 'haiku');
  const tag = readTag('sum-task')!;
  assert.equal(tag.summary.trim(), `саммари №${summaries.length}`);
  assert.deepEqual({ ...tag.runs[0], finishedAt: '' }, { id: s.id, flow: 'session', finishedAt: '', status: 'done', kind: 'session', title: 'корзина' });
  // новых ходов нет — кнопке нечего делать
  assert.equal((await call('POST', `/api/sessions/${s.id}/summary`)).status, 409);
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

test('«Перезапустить с тегами»: старый процесс — SIGHUP, новый — тот же разговор с пересчитанными папками, саммари не пишется', async () => {
  createTag('rs-task');
  const { body: s } = await call<SessionView>('POST', '/api/sessions', { cwd: path.join(root, 'proj'), tags: ['rs-task'] });
  const old = spawned.at(-1)!;
  const tp = path.join(root, `${uuid(3)}.jsonl`);
  fs.writeFileSync(tp, '{}\n');
  await hook(s.id, tokenOf(old), { hook_event_name: 'SessionStart', session_id: uuid(3), transcript_path: tp });
  await hook(s.id, tokenOf(old), { hook_event_name: 'UserPromptSubmit', session_id: uuid(3), prompt: 'шаг' });
  const specs = path.join(root, 'rs-specs');
  fs.mkdirSync(specs, { recursive: true });
  createTag('rs-know', undefined, 'knowledge');
  updateTag('rs-know', { dirs: [specs] });
  await call('PUT', `/api/sessions/${s.id}/tags`, { tags: ['rs-task', 'rs-know'] });
  const before = summaries.length;
  const r = await call<SessionView>('POST', `/api/sessions/${s.id}/restart`);
  assert.deepEqual([r.status, r.body.live], [200, true]);
  const fresh = spawned.at(-1)!;
  assert.deepEqual([old.killed, fresh.args[0]], [['SIGHUP'], `--resume=${uuid(3)}`]);
  assert.ok(fresh.args.includes(specs));
  assert.notEqual(tokenOf(fresh), tokenOf(old));
  // старый токен больше не открывает хуки
  assert.equal((await hook(s.id, tokenOf(old), { hook_event_name: 'Stop' })).status, 404);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(summaries.length, before);
  assert.equal((await view(s.id)).newTurns, 1);
  await call('POST', `/api/sessions/${s.id}/end`);
  await until(async () => (await view(s.id)).summary !== undefined);
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

test('выход приложения: саммари не пишется, у сессии пометка; после перезапуска сервера сессии с диска — завершённые', async () => {
  const dir = path.join(root, 'sessions-restart');
  const deps = { ...sessionManager().deps, dir };
  const mgr = new SessionManager(deps);
  await mgr.available();
  createTag('app-task');
  const v = await mgr.create({ cwd: path.join(root, 'proj'), tags: ['app-task'] }, port, root);
  const live = mgr.sessions.get(v.id)!;
  const res = { once: () => res } as unknown as Parameters<SessionManager['hook']>[2];
  mgr.hook(live, { hook_event_name: 'UserPromptSubmit', session_id: uuid(4), prompt: 'шаг' }, res);
  const before = summaries.length;
  await mgr.stopAll(1000);
  assert.equal(summaries.length, before);
  assert.equal(mgr.view(live).summaryPending, 'app-closed');
  // сервер упал, пока шла другая сессия: в session.json нет endedAt
  const crashed = uuid(5);
  fs.mkdirSync(path.join(dir, crashed));
  fs.writeFileSync(path.join(dir, crashed, 'session.json'), JSON.stringify({ id: crashed, name: 'упавшая', cwd: root, tags: ['app-task'], saveTag: true, claudeSessionIds: [], createdAt: '2026-10-27T10:00:00.000Z', lastActivityAt: '2026-10-27T11:00:00.000Z', turns: 2 }));
  fs.mkdirSync(path.join(dir, 'not-a-session'));
  fs.writeFileSync(path.join(dir, uuid(6) + '.json'), '{}');

  const next = new SessionManager(deps);
  assert.equal(await next.available(), true);
  const list = next.list().sessions;
  assert.deepEqual(list.map((x) => [x.id, x.live, x.status, x.summaryPending]).sort(), [[crashed, false, 'ended', 'app-closed'], [v.id, false, 'ended', 'app-closed']].sort());
  assert.equal(list.find((x) => x.id === crashed)?.endedAt, '2026-10-27T11:00:00.000Z');
  // «Обновить саммари» по завершённой — по журналу ходов
  next.startSummary(v.id);
  await until(() => next.view(next.get(v.id)).summary !== undefined);
  assert.equal(next.view(next.get(v.id)).summaryPending, undefined);
  assert.ok(summaries.at(-1)!.prompt.includes('шаг'));
});

test('остановка сервера прерывает идущее саммари сессии: сессия haiku гасится, ходы не учтены, пометка «приложение закрыли»', async () => {
  const seen: SessionRequest[] = [];
  // сессия саммари, которая кончается только прерыванием
  const slow = (req: SessionRequest) =>
    new Promise<SessionResult>((resolve) => {
      seen.push(req);
      req.abort!.signal.addEventListener('abort', () => resolve({ ok: false, subtype: 'error_during_execution', text: '', costUsd: 0.002, turns: 0, durationMs: 1, errors: ['aborted'] }));
    });
  const mgr = new SessionManager({ ...sessionManager().deps, dir: path.join(root, 'sessions-abort'), summarize: slow });
  await mgr.available();
  createTag('abort-task');
  const v = await mgr.create({ cwd: path.join(root, 'proj'), tags: ['abort-task'] }, port, root);
  const live = mgr.sessions.get(v.id)!;
  const res = { once: () => res } as unknown as Parameters<SessionManager['hook']>[2];
  mgr.hook(live, { hook_event_name: 'UserPromptSubmit', session_id: uuid(7), prompt: 'шаг' }, res);
  await mgr.end(v.id);
  await until(() => seen.length === 1 && mgr.view(live).summarizing === true);
  await mgr.stopAll(1000);
  assert.equal(seen[0].abort?.signal.aborted, true);
  const after = mgr.view(live);
  assert.deepEqual([after.summarizing, after.summaryPending, after.newTurns, after.summary], [undefined, 'app-closed', 1, undefined]);
  assert.equal(readTag('abort-task')!.runs.length, 0);
  // очередь тега свободна: запуск за этим саммари не ждёт
  assert.equal(await Promise.race([queueTagSummary('abort-task', async () => 'дождался'), new Promise((r) => setTimeout(() => r('висит'), 500))]), 'дождался');
  // и новое саммари после остановки не начинается
  assert.throws(() => mgr.startSummary(v.id), (err: unknown) => err instanceof SessionError && err.status === 503);
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
