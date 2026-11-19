// Хранилище дел: файлы на диске, очередь записи, журнал с обрезкой, битый items.json, фильтры.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, LOG_TRIM_BYTES, CLOSED_TTL_MS, DeskFullError, ITEMS_MAX, OPEN_MAX } from './store.js';
import { openDesk } from './index.js';
import type { DeskMove } from './types.js';

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-desk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'desk');
}

const KEY = 'mr:gitlab.example.com/grp/app/7';
const sig = (text: string, at: string, source = 'gitlab') => ({ source, at, text });

test('openDesk: put заводит дело, get и list читают его с диска', async (t) => {
  const dir = tmp(t);
  const d = openDesk(dir);
  const item = await d.put(KEY, { kind: 'Ревью', title: 'Починить вход', signal: sig('посмотри', '2026-11-19T09:00:00.000Z') }, 'routine');
  assert.equal(item.column, 'new');
  assert.ok(fs.existsSync(path.join(dir, 'items.json')));
  // другое хранилище на ту же папку (другой процесс) видит то же
  const again = openDesk(dir);
  assert.equal((await again.get(KEY))?.id, item.id);
  assert.equal((await again.list()).length, 1);
});

test('две рутины на один MR дают одно дело с двумя сигналами', async (t) => {
  const d = openDesk(tmp(t));
  await Promise.all([
    d.put(KEY, { kind: 'Ревью', title: 'MR', signal: sig('из GitLab', '2026-11-19T09:00:00.000Z') }, 'routine'),
    d.put(KEY, { kind: 'Ревью', title: 'Slack', signal: sig('из Slack', '2026-11-19T09:01:00.000Z', 'slack') }, 'routine'),
  ]);
  const all = await d.list();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].signals.map((s) => s.text), ['из GitLab', 'из Slack']);
});

test('очередь записи: сто put подряд без await не теряют друг друга', async (t) => {
  const d = openDesk(tmp(t));
  await Promise.all(Array.from({ length: 100 }, (_, n) => d.put(`own:${n}`, { title: `дело ${n}` }, 'session')));
  assert.equal((await d.list()).length, 100);
});

test('журнал движений: строка на заведение и на каждый перенос', async (t) => {
  const dir = tmp(t);
  const d = openDesk(dir);
  await d.put(KEY, { title: 'x' }, 'routine');
  await d.move(KEY, 'plan', 'me');
  await d.move(KEY, 'plan', 'me'); // та же колонка — строки нет
  await d.close(KEY, 'смержен', 'watcher');
  const moves = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as DeskMove);
  assert.deepEqual(moves.map((m) => [m.from, m.to, m.by]), [[undefined, 'new', 'routine'], ['new', 'plan', 'me'], ['plan', 'done', 'watcher']]);
});

test('журнал обрезается при записи: остаётся хвост не больше половины порога', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(dir, { recursive: true });
  const old = JSON.stringify({ at: '2026-01-01T00:00:00.000Z', key: 'own:old', to: 'new', by: 'me', why: 'x'.repeat(200) }) + '\n';
  fs.writeFileSync(path.join(dir, 'log.jsonl'), old.repeat(Math.ceil(LOG_TRIM_BYTES / old.length) + 10));
  const d = openDesk(dir);
  await d.put('own:new', { title: 'новое' }, 'me');
  const text = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8');
  assert.ok(Buffer.byteLength(text) <= LOG_TRIM_BYTES / 2);
  assert.match(text.trim().split('\n').at(-1)!, /own:new/);
});

test('битый items.json не затирается: откладывается рядом, доска пустая', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'items.json'), '{ битый');
  const err = console.error;
  console.error = () => {};
  t.after(() => (console.error = err));
  const d = openDesk(dir);
  assert.deepEqual(await d.list(), []);
  const bad = fs.readdirSync(dir).filter((f) => f.endsWith('.bad.json'));
  assert.equal(bad.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, bad[0]), 'utf8'), '{ битый');
});

test('list: фильтры по колонке, проекту, виду, ключу и открытости; свежие сверху', async (t) => {
  let now = Date.parse('2026-11-19T09:00:00.000Z');
  const d = openStore(tmp(t), { now: () => new Date((now += 1000)) });
  await d.put('own:a', { title: 'a', project: 'app', kind: 'Своё' }, 'me');
  await d.put('own:b', { title: 'b', project: 'web', kind: 'Ревью', column: 'plan' }, 'me');
  await d.put('own:c', { title: 'c', project: 'app', kind: 'Ревью' }, 'me');
  await d.close('own:c', 'всё', 'me');
  assert.deepEqual((await d.list()).map((i) => i.key), ['own:c', 'own:b', 'own:a']);
  assert.deepEqual((await d.list({ open: true })).map((i) => i.key), ['own:b', 'own:a']);
  assert.deepEqual((await d.list({ open: false })).map((i) => i.key), ['own:c']);
  assert.deepEqual((await d.list({ column: ['new', 'plan'] })).map((i) => i.key), ['own:b', 'own:a']);
  assert.deepEqual((await d.list({ project: 'app', kind: 'Ревью' })).map((i) => i.key), ['own:c']);
  assert.deepEqual((await d.list({ key: 'own:b' })).map((i) => i.key), ['own:b']);
});

test('закрытые дела старше 30 дней уходят при записи, открытые остаются', async (t) => {
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const d = openStore(tmp(t), { now: () => new Date(now) });
  await d.put('own:old', { title: 'старое' }, 'me');
  await d.close('own:old', 'всё', 'me');
  await d.put('own:open', { title: 'открытое' }, 'me');
  now += CLOSED_TTL_MS + 1000;
  await d.put('own:new', { title: 'новое' }, 'me');
  assert.deepEqual((await d.list()).map((i) => i.key).sort(), ['own:new', 'own:open']);
});

test('onChange: зовётся на запись и не зовётся, когда ничего не изменилось', async (t) => {
  const d = openStore(tmp(t));
  let n = 0;
  const off = d.onChange(() => n++);
  await d.put('own:a', { title: 'a' }, 'me');
  await d.move('own:a', 'new', 'me');
  await d.close('own:missing', 'x', 'me');
  assert.equal(n, 1);
  off();
  await d.move('own:a', 'plan', 'me');
  assert.equal(n, 1);
});

test('observe: правила по состояниям только у открытых дел; число изменившихся', async (t) => {
  const d = openStore(tmp(t));
  await d.put('mr:h/g/a/1', { title: 'a', column: 'waiting' }, 'routine');
  await d.put('mr:h/g/a/2', { title: 'b', column: 'plan' }, 'routine');
  const st = { exists: true, turn: 'me' as const, why: 'автор ответил', title: 'a', updatedAt: '2026-11-19T09:00:00.000Z', facts: {} };
  const n = await d.observe(new Map([['mr:h/g/a/1', st], ['mr:h/g/a/3', st]]));
  assert.equal(n, 1);
  assert.equal((await d.get('mr:h/g/a/1'))?.column, 'plan');
  assert.equal(await d.observe(new Map([['mr:h/g/a/1', st]])), 0);
});

test('runEnded: why дел с этим запуском — итог, колонка та же', async (t) => {
  const d = openStore(tmp(t));
  await d.put('own:a', { title: 'a', links: { runs: ['r1'] } }, 'routine');
  await d.put('own:b', { title: 'b' }, 'flow');
  // дело, которое запуск r1 сам завёл через desk_put (by flow): ссылка есть, а итог чужого запуска его не трогает
  await d.put('own:c', { title: 'c', links: { runs: ['r1'] } }, 'flow');
  assert.equal(await d.runEnded(['r1'], 'failed', 'бюджет кончился'), 1);
  assert.equal((await d.get('own:c'))?.why, '');
  assert.equal((await d.get('own:a'))?.why, 'запуск упал: бюджет кончился');
  assert.equal((await d.get('own:a'))?.column, 'new');
});

test('итог сверки: writeCheck и readCheck; нет файла — undefined', (t) => {
  const d = openStore(tmp(t));
  assert.equal(d.readCheck(), undefined);
  d.writeCheck({ at: '2026-11-19T09:12:00.000Z', ok: true, total: 3, fresh: 1 });
  assert.deepEqual(d.readCheck(), { at: '2026-11-19T09:12:00.000Z', ok: true, total: 3, fresh: 1 });
});

test('записи, которых версия не понимает, переживают запись', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(dir, { recursive: true });
  const future = { id: 'z', key: 'own:z', column: 'someday', title: 'из будущего' };
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ version: 1, items: [future] }));
  const d = openDesk(dir);
  assert.deepEqual(await d.list(), []);
  await d.put('own:a', { title: 'a' }, 'me');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'items.json'), 'utf8')) as { items: unknown[] };
  assert.equal(onDisk.items.length, 2);
  assert.deepEqual(onDisk.items[1], future);
});

test('журнал больше любого лимита чтения всё равно обрезается; сбой журнала дело не отменяет', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ at: '2026-01-01T00:00:00.000Z', key: 'own:old', to: 'new', by: 'me', why: 'x'.repeat(500) }) + '\n';
  fs.writeFileSync(path.join(dir, 'log.jsonl'), line.repeat(Math.ceil((LOG_TRIM_BYTES * 5) / line.length)));
  const d = openDesk(dir);
  await d.put('own:new', { title: 'новое' }, 'me');
  assert.ok(fs.statSync(path.join(dir, 'log.jsonl')).size <= LOG_TRIM_BYTES / 2);
  // журнал — папка: append падает, а дело записано и событие ушло
  fs.rmSync(path.join(dir, 'log.jsonl'));
  fs.mkdirSync(path.join(dir, 'log.jsonl'));
  const err = console.error;
  console.error = () => {};
  t.after(() => (console.error = err));
  const s = openStore(dir);
  let n = 0;
  s.onChange(() => n++);
  await s.put('own:b', { title: 'b' }, 'me');
  assert.equal((await s.get('own:b'))?.title, 'b');
  assert.equal(n, 1);
});

test('замок записи: висящий от упавшего процесса снимается, после записи замка нет', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'items.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const d = openDesk(dir);
  await d.put('own:a', { title: 'a' }, 'me');
  assert.equal((await d.get('own:a'))?.title, 'a');
  assert.equal(fs.existsSync(lock), false);
});

const bulk = (n: number, o: { closed?: boolean; signals?: number; text?: number } = {}) =>
  Array.from({ length: n }, (_, k) => ({
    id: `b${k}`, key: `own:b${k}`, kind: 'Своё', title: `дело ${k}`, column: o.closed ? 'done' : 'new', why: '', createdAt: '2026-11-19T09:00:00.000Z', movedAt: '2026-11-19T09:00:00.000Z', movedBy: 'me',
    links: { runs: [], sessions: [] },
    signals: Array.from({ length: o.signals ?? 0 }, (_, j) => ({ source: 'slack', at: `2026-11-19T09:${String(j % 60).padStart(2, '0')}:00.000Z`, text: 'я'.repeat(o.text ?? 10) })),
    ...(o.closed ? { closed: { at: new Date().toISOString(), reason: 'x' } } : {}),
  }));

test('открытых дел не больше OPEN_MAX: новое — понятная ошибка, существующие правятся', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ version: 1, items: bulk(OPEN_MAX) }));
  const d = openDesk(dir);
  await assert.rejects(d.put('own:new', { title: 'лишнее' }, 'me'), (e: Error) => e instanceof DeskFullError && /Открытых дел уже 2000/.test(e.message));
  assert.equal((await d.move('own:b1', 'plan', 'me'))?.column, 'plan');
});

test('доска не влезает в ITEMS_MAX: у дел остаются последние сигналы, дела целы', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(dir, { recursive: true });
  // 120 дел по 50 сигналов по 2000 знаков — больше 8 МБ (файл от прошлой версии)
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ version: 1, items: bulk(120, { signals: 50, text: 2000 }) }));
  assert.ok(fs.statSync(path.join(dir, 'items.json')).size > ITEMS_MAX);
  const d = openDesk(dir);
  assert.equal((await d.list()).length, 120);
  await d.move('own:b0', 'plan', 'me');
  assert.ok(fs.statSync(path.join(dir, 'items.json')).size <= ITEMS_MAX);
  const all = await d.list();
  assert.equal(all.length, 120);
  assert.ok(all.every((i) => i.signals.length <= 5 && i.signals.length >= 1));
});

test('замок живого владельца не отнимается: ошибка «доска занята», чужой замок на месте', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'items.lock');
  fs.writeFileSync(lock, 'other:1');
  const d = openStore(dir, { lockWaitMs: 100 });
  await assert.rejects(d.put('own:a', { title: 'a' }, 'me'), /доска занята другим процессом/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other:1');
});

test('запись другого процесса (CLI) — событие подписчикам по mtime; своя запись — одно событие', async (t) => {
  const dir = tmp(t);
  const server = openStore(dir, { watchMs: 20 });
  let n = 0;
  const off = server.onChange(() => n++);
  t.after(off);
  await server.put('own:a', { title: 'своё' }, 'me');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(n, 1);
  // «agentgraph desk add» — другое хранилище (в жизни — другой процесс): своей подписки у сервера на него нет
  await new Promise((r) => setTimeout(r, 20));
  await openStore(dir).put('own:cli', { title: 'из CLI' }, 'me');
  const end = Date.now() + 2000;
  while (n < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.equal(n, 2);
});
