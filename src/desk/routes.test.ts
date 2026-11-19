// Маршруты /api/desk: список с итогом сверки, put/move/close от 'me', проверка тела.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, type DeskStore } from './store.js';
import { deskRoute } from './routes.js';
import type { DeskItem, DeskListReply } from './types.js';

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-desk-rt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store: DeskStore = openStore(dir);
  const call = (method: string, p: string, body?: unknown) => deskRoute(method, new URL(`http://x${p}`), async () => body, { store });
  return { store, call };
}

test('GET /api/desk: дела по фильтру и итог сверки, если он есть', async (t) => {
  const { store, call } = setup(t);
  await store.put('own:a', { title: 'a', column: 'plan' }, 'me');
  await store.put('own:b', { title: 'b' }, 'me');
  let r = await call('GET', '/api/desk?column=plan,bogus&open=1');
  assert.equal(r?.status, 200);
  assert.deepEqual((r!.body as DeskListReply).items.map((i) => i.key), ['own:a']);
  assert.equal((r!.body as DeskListReply).check, undefined);
  store.writeCheck({ at: '2026-11-19T09:12:00.000Z', ok: true, total: 2, fresh: 0 });
  r = await call('GET', '/api/desk');
  assert.equal((r!.body as DeskListReply).items.length, 2);
  assert.equal((r!.body as DeskListReply).check?.total, 2);
});

test('POST /api/desk/put: своё дело без ключа, от me; лишние поля не проходят', async (t) => {
  const { call } = setup(t);
  const r = await call('POST', '/api/desk/put', { patch: { title: 'Позвонить', column: 'plan', thing: { type: 'mr' }, links: { runs: ['x'] }, signal: { text: 'просил Петя', link: 'javascript:alert(1)' } } });
  assert.equal(r?.status, 200);
  const item = r!.body as DeskItem;
  assert.match(item.key, /^own:[0-9a-f]{12}$/);
  assert.deepEqual([item.title, item.column, item.movedBy, item.thing, item.links.runs], ['Позвонить', 'plan', 'me', undefined, []]);
  assert.equal(item.signals[0].source, 'ui');
  assert.equal(item.signals[0].link, undefined);
});

test('POST /api/desk/put: новое дело без имени — 400, кривой ключ — 400', async (t) => {
  const { call } = setup(t);
  assert.equal((await call('POST', '/api/desk/put', { key: 'own:x', patch: {} }))?.status, 400);
  assert.equal((await call('POST', '/api/desk/put', { key: 'нет ключа', patch: { title: 'x' } }))?.status, 400);
});

test('POST /api/desk/move и /close: от me; нет дела — 404; кривая колонка — 400', async (t) => {
  const { store, call } = setup(t);
  await store.put('own:a', { title: 'a' }, 'routine');
  const m = await call('POST', '/api/desk/move', { key: 'own:a', column: 'work' });
  assert.deepEqual([(m!.body as DeskItem).column, (m!.body as DeskItem).movedBy], ['work', 'me']);
  assert.equal((await call('POST', '/api/desk/move', { key: 'own:a', column: 'later' }))?.status, 400);
  assert.equal((await call('POST', '/api/desk/move', { key: 'own:none', column: 'plan' }))?.status, 404);
  const c = await call('POST', '/api/desk/close', { key: 'own:a' });
  assert.equal((c!.body as DeskItem).closed?.reason, 'закрыто вручную');
  assert.equal((await call('POST', '/api/desk/close', { key: 'own:none' }))?.status, 404);
});

test('чужие пути не забирает, неизвестный метод — 405', async (t) => {
  const { call } = setup(t);
  assert.equal(await call('GET', '/api/desks'), undefined);
  assert.equal((await call('DELETE', '/api/desk'))?.status, 405);
  assert.equal((await call('POST', '/api/desk/nope'))?.status, 404);
});
