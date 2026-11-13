// Имя сессии терминала по первому сообщению (sessions-server.ts + session-title.ts): поддельный pty и поддельный подбор
// имени — настоящий claude и Agent SDK не запускаются.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunTitleReport } from './run-title.js';
import { sessionTitlePrompt } from './session-title.js';
import { SessionManager, type SessionRecord } from './sessions-server.js';
import { createMirror, type PtyExit, type PtyKit, type PtyProcess } from './sessions-pty.js';

/** Процесс claude, который ничего не выводит и выходит по kill. */
class FakePty implements PtyProcess {
  pid = 4242;
  private exits: ((e: PtyExit) => void)[] = [];
  onData() {}
  onExit(cb: (e: PtyExit) => void) {
    this.exits.push(cb);
  }
  write() {}
  resize() {}
  kill() {
    setTimeout(() => {
      for (const cb of this.exits) cb({ exitCode: 129 });
      this.exits = [];
    }, 1);
  }
}

/** argv каждого запущенного claude по порядку. */
const spawnedArgs: string[][] = [];
const kit: PtyKit = {
  spawn: (_file, args) => {
    spawnedArgs.push(args);
    return new FakePty();
  },
  mirror: createMirror,
};

/** Вызов подбора имени: тест сам решает, когда и чем он ответит; остановка сервера отвечает ошибкой, как pickTitle. */
type Call = { text: string; signal: AbortSignal; reply: (r: RunTitleReport) => void };

let root = '';
let proj = '';
const prevConfig = process.env.AGENTGRAPH_CONFIG_DIR;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-sname-')));
  process.env.AGENTGRAPH_CONFIG_DIR = path.join(root, 'cfg');
  proj = path.join(root, 'shop');
  fs.mkdirSync(proj);
});

after(() => {
  if (prevConfig === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
  else process.env.AGENTGRAPH_CONFIG_DIR = prevConfig;
  fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;

/** Менеджер со своей папкой сессий; calls — вызовы подбора имени по порядку. */
async function setup(dir = path.join(root, `sessions-${++seq}`)) {
  const calls: Call[] = [];
  const mgr = new SessionManager({
    kit: async () => kit,
    findClaude: () => '/fake/bin/claude',
    version: async () => '2.1.311',
    agents: async () => '[]',
    dir,
    runsDir: path.join(root, 'runs'),
    env: () => ({ PATH: '/bin' }),
    deliveryAfterMs: 60_000,
    summarize: async () => {
      throw new Error('саммари в этих тестах не нужно');
    },
    title: (text, signal) =>
      new Promise<RunTitleReport>((reply) => {
        calls.push({ text, signal, reply });
        signal.addEventListener('abort', () => reply({ error: 'сервер останавливается', costUsd: 0 }), { once: true });
      }),
  });
  assert.equal(await mgr.available(), true);
  return { mgr, calls, dir };
}

/** Ответ хуку: его once нужен только для «доставлено». */
const res = { once: () => res } as unknown as Parameters<SessionManager['hook']>[2];
const prompt = (mgr: SessionManager, id: string, text: string, extra: Record<string, unknown> = {}) =>
  mgr.hook(mgr.get(id), { hook_event_name: 'UserPromptSubmit', session_id: id, prompt: text, ...extra }, res);
const record = (dir: string, id: string) => JSON.parse(fs.readFileSync(path.join(dir, id, 'session.json'), 'utf8')) as SessionRecord;
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('не дождались');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('сессия без имени: после первого сообщения — короткое имя по его тексту, поле имени по умолчанию снято, на диске имя и стоимость', async () => {
  const { mgr, calls, dir } = await setup();
  const v = await mgr.create({ cwd: proj }, 4747, root);
  assert.equal(v.name, 'shop');
  assert.equal(record(dir, v.id).defaultName, 'shop');

  prompt(mgr, v.id, 'почини пустую корзину в checkout');
  assert.deepEqual(calls.map((c) => c.text), ['почини пустую корзину в checkout']);
  // второе сообщение, пока идёт подбор, второй подбор не начинает
  prompt(mgr, v.id, 'и добавь тест');
  assert.equal(calls.length, 1);
  calls[0].reply({ title: 'Починка пустой корзины', costUsd: 0.006 });
  await until(() => mgr.view(mgr.get(v.id)).name === 'Починка пустой корзины');
  const rec = record(dir, v.id);
  assert.deepEqual([rec.name, rec.defaultName, rec.nameSession], ['Починка пустой корзины', undefined, { costUsd: 0.006 }]);

  // имя уже подобрано: дальше сообщения его не трогают
  prompt(mgr, v.id, 'теперь займись оплатой');
  assert.equal(calls.length, 1);
  await mgr.stopAll(1000);
});

test('имя, заданное при старте или переименованием, не перезаписывается: модель не вызывается', async () => {
  const { mgr, calls, dir } = await setup();
  const named = await mgr.create({ cwd: proj, name: 'Моя корзина' }, 4747, root);
  assert.equal(record(dir, named.id).defaultName, undefined);
  prompt(mgr, named.id, 'почини корзину');

  const renamed = await mgr.create({ cwd: proj, name: '   ' }, 4747, root);
  assert.equal(renamed.name, 'shop');
  mgr.rename(renamed.id, { name: 'Своё имя' });
  assert.equal(record(dir, renamed.id).defaultName, undefined);
  prompt(mgr, renamed.id, 'почини корзину');

  // вернули руками то же имя, что дали по умолчанию: оно всё равно ручное
  const back = await mgr.create({ cwd: proj }, 4747, root);
  mgr.rename(back.id, { name: 'Корзина' });
  mgr.rename(back.id, { name: 'shop' });
  prompt(mgr, back.id, 'почини корзину');

  assert.equal(calls.length, 0);
  assert.deepEqual([named.id, renamed.id, back.id].map((id) => mgr.view(mgr.get(id)).name), ['Моя корзина', 'Своё имя', 'shop']);
  await mgr.stopAll(1000);
});

test('переименование, пока идёт подбор, побеждает: имя модели отброшено, стоимость записана', async () => {
  const { mgr, calls, dir } = await setup();
  const v = await mgr.create({ cwd: proj }, 4747, root);
  prompt(mgr, v.id, 'почини корзину');
  mgr.rename(v.id, { name: 'Ручное' });
  calls[0].reply({ title: 'Починка корзины', costUsd: 0.005 });
  await until(() => record(dir, v.id).nameSession !== undefined);
  assert.deepEqual([record(dir, v.id).name, mgr.view(mgr.get(v.id)).name], ['Ручное', 'Ручное']);

  // и когда руками поставили то же имя, что было по умолчанию
  const same = await mgr.create({ cwd: proj }, 4747, root);
  prompt(mgr, same.id, 'почини корзину');
  mgr.rename(same.id, { name: 'shop' });
  calls[1].reply({ title: 'Починка корзины', costUsd: 0.005 });
  await until(() => record(dir, same.id).nameSession !== undefined);
  assert.equal(record(dir, same.id).name, 'shop');
  await mgr.stopAll(1000);
});

test('называть нечего — ждём следующего сообщения; сбой подбора — имя по умолчанию и без второй попытки', async () => {
  const { mgr, calls, dir } = await setup();
  const v = await mgr.create({ cwd: proj }, 4747, root);
  for (const text of ['', '[Image #1]', '/clear']) prompt(mgr, v.id, text);
  // сообщение сабагента — не первое сообщение человека
  prompt(mgr, v.id, 'проверь тесты', { agent_id: 'a1' });
  assert.equal(calls.length, 0);
  assert.equal(record(dir, v.id).defaultName, 'shop');

  prompt(mgr, v.id, 'добавь экспорт CSV');
  assert.equal(calls.length, 1);
  calls[0].reply({ error: 'таймаут: подбор имени не уложился в 30 с', costUsd: 0 });
  await until(() => record(dir, v.id).nameSession !== undefined);
  const rec = record(dir, v.id);
  assert.deepEqual([rec.name, rec.defaultName, rec.nameSession], ['shop', undefined, { costUsd: 0, error: 'таймаут: подбор имени не уложился в 30 с' }]);
  prompt(mgr, v.id, 'ещё раз');
  assert.equal(calls.length, 1);
  await mgr.stopAll(1000);
});

test('остановка сервера прерывает подбор: поле остаётся, имя подберётся после «Продолжить»; старые записи не трогаем', async () => {
  const first = await setup();
  const v = await first.mgr.create({ cwd: proj }, 4747, root);
  prompt(first.mgr, v.id, 'почини корзину');
  await first.mgr.stopAll(1000);
  assert.equal(first.calls[0].signal.aborted, true);
  let rec = record(first.dir, v.id);
  assert.deepEqual([rec.name, rec.defaultName, rec.nameSession], ['shop', 'shop', undefined]);

  // запись старше автоимени (поля нет): имя похоже на имя по умолчанию, но его могли задать руками; испорченное поле;
  // имя, поправленное в файле руками, — ни одну не называем
  const old = '00000000-0000-4000-8000-0000000000a1';
  const bad = '00000000-0000-4000-8000-0000000000a2';
  const hand = '00000000-0000-4000-8000-0000000000a3';
  const files: [string, Record<string, unknown>][] = [[old, {}], [bad, { defaultName: 7 }], [hand, { name: 'Своё', defaultName: 'shop' }]];
  for (const [id, extra] of files) {
    fs.mkdirSync(path.join(first.dir, id));
    fs.writeFileSync(path.join(first.dir, id, 'session.json'), JSON.stringify({ id, name: 'shop', cwd: proj, tags: [], saveTag: true, claudeSessionIds: [], createdAt: '2026-10-27T10:00:00.000Z', lastActivityAt: '2026-10-27T10:00:00.000Z', turns: 0, ...extra }));
  }

  const next = await setup(first.dir);
  for (const id of [v.id, old, bad, hand]) {
    await next.mgr.resume(id, 4747);
    prompt(next.mgr, id, 'почини корзину');
  }
  assert.equal(next.calls.length, 1);
  next.calls[0].reply({ title: 'Починка корзины', costUsd: 0.006 });
  await until(() => record(first.dir, v.id).name === 'Починка корзины');
  assert.deepEqual([old, bad, hand].map((id) => next.mgr.view(next.mgr.get(id)).name), ['shop', 'shop', 'Своё']);
  assert.deepEqual([bad, hand].map((id) => record(first.dir, id).defaultName), [undefined, undefined]);
  rec = record(first.dir, v.id);
  assert.deepEqual([rec.defaultName, rec.nameSession], [undefined, { costUsd: 0.006 }]);
  await next.mgr.stopAll(1000);
});

test('сессия из session_new: имя — по самой задаче, без пометки о сессии-источнике, которую дописал openFrom', async () => {
  const { mgr, calls } = await setup();
  const parent = await mgr.create({ cwd: proj, name: 'Родитель' }, 4747, root);
  const r = await mgr.mcp(mgr.get(parent.id), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_new', arguments: { prompt: 'Add CSV export for orders' } } }, 4747);
  assert.equal(r.status, 200);
  const child = mgr.list().sessions.find((x) => x.id !== parent.id)!;
  // claude дочерней сессии отправит последний аргумент argv сам — это и будет первое сообщение в хуке
  prompt(mgr, child.id, spawnedArgs.at(-1)!.at(-1)!);
  assert.equal(calls.length, 1);
  const p = sessionTitlePrompt(calls[0].text);
  assert.ok(p.includes('<source-data>\nAdd CSV export for orders\n</source-data>'), p);
  assert.ok(!p.includes('написал Claude'));
  assert.match(p, /имя сессии по-английски/);
  await mgr.stopAll(1000);
});

test('сессию удалили, пока шёл подбор: её папка не появляется снова', async () => {
  const { mgr, calls, dir } = await setup();
  const v = await mgr.create({ cwd: proj }, 4747, root);
  prompt(mgr, v.id, 'почини корзину');
  await mgr.end(v.id);
  mgr.remove(v.id);
  calls[0].reply({ title: 'Починка корзины', costUsd: 0.006 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.existsSync(path.join(dir, v.id)), false);
  await mgr.stopAll(1000);
});
