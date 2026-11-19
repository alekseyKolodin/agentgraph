// Обзор недели и «висит дольше N дней» (SPEC 6.1): закрытые за период, зависшие по movedAt, пришедшие по рутинам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deskWeek } from './week.js';
import { openStore } from './store.js';
import { deskRoute } from './routes.js';
import type { DeskItem, DeskMove, DeskWeekReply } from './types.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const ago = (d: number) => new Date(NOW.getTime() - d * 24 * 3600_000).toISOString();

function item(key: string, o: Partial<DeskItem> = {}): DeskItem {
  return { id: key, key, kind: 'Ревью', title: key, column: 'plan', why: '', signals: [], links: { runs: [], sessions: [] }, createdAt: ago(20), movedAt: ago(1), movedBy: 'me', ...o };
}

test('висит дольше N дней: открытые в «В плане», «Ждёт других», «В работе» по movedAt, дольше всех сверху; «Новое» и закрытые — нет', () => {
  const items = [
    item('own:a', { column: 'plan', movedAt: ago(8) }),
    item('own:b', { column: 'waiting', movedAt: ago(12) }),
    item('own:c', { column: 'work', movedAt: ago(3) }),
    item('own:d', { column: 'new', movedAt: ago(30) }),
    item('own:e', { column: 'done', movedAt: ago(20), closed: { at: ago(20), reason: 'x' } }),
  ];
  const w = deskWeek(items, [], NOW);
  assert.deepEqual(w.stale.map((s) => [s.key, s.days]), [['own:b', 12], ['own:a', 8]]);
  assert.deepEqual(deskWeek(items, [], NOW, { staleDays: 2 }).stale.map((s) => s.key), ['own:b', 'own:a', 'own:c']);
});

test('списки обрезаны до 50, итоги — полные', () => {
  const many = Array.from({ length: 80 }, (_, k) => item(`own:${k}`, { column: 'waiting', movedAt: ago(10) }));
  const done = Array.from({ length: 60 }, (_, k) => item(`own:d${k}`, { column: 'done', closed: { at: ago(1), reason: 'x' } }));
  const w = deskWeek([...many, ...done], [], NOW);
  assert.deepEqual([w.stale.length, w.staleTotal, w.closed.length, w.closedTotal], [50, 80, 50, 60]);
});

test('закрыто за неделю: свежие сверху, кто закрыл — по журналу; закрытое раньше периода — нет', () => {
  const items = [
    item('own:a', { column: 'done', closed: { at: ago(1), reason: 'смержен' } }),
    item('own:b', { column: 'done', closed: { at: ago(3), reason: 'закрыто вручную' } }),
    item('own:old', { column: 'done', closed: { at: ago(9), reason: 'давно' } }),
  ];
  const log: DeskMove[] = [
    { at: ago(1), key: 'own:a', from: 'waiting', to: 'done', by: 'watcher' },
    { at: ago(3), key: 'own:b', from: 'plan', to: 'done', by: 'me' },
  ];
  const w = deskWeek(items, log, NOW);
  assert.deepEqual(w.closed.map((c) => [c.key, c.reason, c.by]), [['own:a', 'смержен', 'watcher'], ['own:b', 'закрыто вручную', 'me']]);
  assert.equal(w.moves, 2);
});

test('пришло за неделю: по строкам заведения журнала, рутина — из createdBy или сигнала; заведённые руками — other', () => {
  const items = [
    item('mr:1', { createdBy: { routine: 'review-slack' } }),
    item('mr:2', { signals: [{ source: 'gitlab', at: ago(2), routine: 'review-gitlab' }] }),
    item('mr:3', { signals: [{ source: 'slack', at: ago(2), routine: 'review-slack' }] }),
    item('own:me'),
  ];
  const log: DeskMove[] = [
    { at: ago(2), key: 'mr:1', to: 'new', by: 'routine' },
    { at: ago(2), key: 'mr:2', to: 'new', by: 'routine' },
    { at: ago(2), key: 'mr:3', to: 'new', by: 'routine' },
    { at: ago(1), key: 'own:me', to: 'plan', by: 'me' },
    { at: ago(1), key: 'mr:1', from: 'new', to: 'plan', by: 'me' },
    { at: ago(10), key: 'mr:old', to: 'new', by: 'routine' },
  ];
  const w = deskWeek(items, log, NOW);
  assert.deepEqual(w.arrived, { total: 4, routines: [{ routine: 'review-slack', count: 2 }, { routine: 'review-gitlab', count: 1 }], other: 1 });
});

test('GET /api/desk/week: из хранилища и журнала; кривые days и stale — по умолчанию', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-desk-week-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  await store.put('own:a', { title: 'a', column: 'plan' }, 'me');
  await store.close('own:a', 'сделал', 'me');
  const call = (q: string) => deskRoute('GET', new URL(`http://x/api/desk/week${q}`), async () => undefined, { store });
  const r = await call('?days=0&stale=abc');
  assert.equal(r?.status, 200);
  const w = r!.body as DeskWeekReply;
  assert.deepEqual([w.days, w.staleDays, w.closed.map((c) => [c.key, c.by]), w.arrived.total, w.moves], [7, 7, [['own:a', 'me']], 1, 2]);
  assert.equal(((await call('?days=3&stale=14'))!.body as DeskWeekReply).staleDays, 14);
  assert.deepEqual(store.readLog().map((m) => m.to), ['plan', 'done']);
  // битые строки и неизвестная колонка — мимо
  fs.appendFileSync(path.join(dir, 'log.jsonl'), '{"at":"x","key":"own:b","to":"later","by":"me"}\n{оборвано\n');
  assert.equal(store.readLog().length, 2);
});
