// Маршруты /api/desk: список с итогом сверки, put/move/close от 'me', проверка тела.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, type DeskStore } from './store.js';
import { deskRoute, LINKED_REASON } from './routes.js';
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

test('POST /api/desk/link: своё дело переезжает на вещь по адресу MR одной записью — сигналы, срок, колонка и возраст те же, своё закрыто ссылкой', async (t) => {
  const { store } = setup(t);
  const link = (body: unknown) => deskRoute('POST', new URL('http://x/api/desk/link'), async () => body, { store, jiraHosts: () => ['jira.example.com'] });
  const own = await store.put('own:w', { title: 'Ретраи вебхуков', column: 'plan', project: 'pay', due: '2026-11-27', why: 'обещал на дейлике', signal: { source: 'slack', at: '2026-11-18T10:00:00.000Z', text: 'сделаешь?', replyTo: { channel: 'C1' } } }, 'me');
  assert.equal((await link({ key: 'own:w', url: 'https://example.com/x' }))?.status, 400);
  assert.equal((await link({ key: 'own:nope', url: 'https://gitlab.example.com/g/app/-/merge_requests/12' }))?.status, 409);
  const r = await link({ key: 'own:w', url: 'https://GitLab.example.com/g/App/-/merge_requests/12/diffs' });
  assert.equal(r?.status, 200);
  const item = r!.body as DeskItem;
  assert.deepEqual(
    [item.key, item.thing?.type, item.title, item.kind, item.column, item.project, item.due, item.why, item.createdAt, item.movedAt, item.signals],
    ['mr:gitlab.example.com/g/app/12', 'mr', 'Ретраи вебхуков', 'MR', 'plan', 'pay', '2026-11-27', 'обещал на дейлике', own.createdAt, own.movedAt, own.signals],
  );
  assert.notEqual(item.id, own.id);
  const closed = (await store.get('own:w'))!;
  assert.deepEqual([closed.column, closed.closed?.reason], ['done', `${LINKED_REASON}MR g/App!12`]);
  // закрытое своё и дело с вещью — не привязываются
  assert.equal((await link({ key: 'own:w', url: 'https://jira.example.com/browse/PAY-1' }))?.status, 409);
  assert.equal((await link({ key: item.key, url: 'https://jira.example.com/browse/PAY-1' }))?.status, 409);
});

test('POST /api/desk/link: у вещи уже есть дело (даже закрытое) — 409, своё не трогается; вид не «Своё» остаётся', async (t) => {
  const { store } = setup(t);
  const link = (body: unknown) => deskRoute('POST', new URL('http://x/api/desk/link'), async () => body, { store, jiraHosts: () => ['jira.example.com'] });
  await store.put('mr:gitlab.example.com/g/app/12', { title: 'MR', column: 'plan' }, 'watcher');
  await store.close('mr:gitlab.example.com/g/app/12', 'смержен', 'watcher');
  await store.put('own:a', { title: 'a' }, 'me');
  assert.equal((await link({ key: 'own:a', url: 'https://gitlab.example.com/g/app/-/merge_requests/12' }))?.status, 409);
  assert.equal((await store.get('own:a'))?.closed, undefined);
  await store.put('own:m', { title: 'Созвон', kind: 'Встреча' }, 'me');
  const j = (await link({ key: 'own:m', url: 'https://jira.example.com/browse/pay-7' }))!.body as DeskItem;
  assert.deepEqual([j.key, j.kind, j.column], ['jira:jira.example.com/PAY-7', 'Встреча', 'new']);
});
