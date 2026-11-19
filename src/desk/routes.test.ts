// Маршруты /api/desk: список с итогом сверки, put/move/close от 'me', проверка тела.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, type DeskStore } from './store.js';
import { deskRoute } from './routes.js';
import { LINKED_REASON } from './rules.js';
import type { DeskItem, DeskItemReply, DeskListReply } from './types.js';

function setup(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-desk-rt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store: DeskStore = openStore(dir);
  const call = (method: string, p: string, body?: unknown) => deskRoute(method, new URL(`http://x${p}`), async () => body, { store, hasProject: (slug) => slug === 'app', jiraHosts: () => [] });
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

test('POST /api/desk/put: ключ — канонический, адрес MR — вещь для наблюдателя; move находит дело по ключу в другом регистре', async (t) => {
  const { call } = setup(t);
  const a = (await call('POST', '/api/desk/put', { key: 'mr:GitLab.Example.com/Grp/App/7', patch: { title: 'MR' } }))!.body as DeskItem;
  assert.equal(a.key, 'mr:gitlab.example.com/grp/app/7');
  assert.equal(a.thing?.type, 'mr');
  const b = (await call('POST', '/api/desk/put', { key: 'https://gitlab.example.com/grp/app/-/merge_requests/7', patch: { why: 'ещё раз' } }))!.body as DeskItem;
  assert.equal(b.id, a.id);
  const m = await call('POST', '/api/desk/move', { key: 'mr:GITLAB.example.com/grp/APP/7', column: 'plan' });
  assert.equal((m!.body as DeskItem).column, 'plan');
});

test('POST /api/desk/put: пространства нет — 400', async (t) => {
  const { call } = setup(t);
  const r = await call('POST', '/api/desk/put', { patch: { title: 'x', project: 'nope' } });
  assert.deepEqual([r?.status, (r?.body as { error: string }).error], [400, 'patch.project: пространства nope нет']);
  assert.equal((await call('POST', '/api/desk/put', { patch: { title: 'x', project: 'app' } }))?.status, 200);
});

test('ключ, который канон не разбирает (своё дело рутины с пробелом), — как есть: карточку можно двигать и закрыть', async (t) => {
  const { store, call } = setup(t);
  await store.put('own:folder/a b.md@1', { title: 'файл' }, 'routine');
  assert.equal(((await call('POST', '/api/desk/move', { key: 'own:folder/a b.md@1', column: 'plan' }))!.body as DeskItem).column, 'plan');
  const put = await call('POST', '/api/desk/put', { key: 'own:folder/a b.md@1', patch: { why: 'посмотреть' } });
  assert.deepEqual([put?.status, (put!.body as DeskItem).why], [200, 'посмотреть']);
  assert.equal(((await call('POST', '/api/desk/close', { key: 'own:folder/a b.md@1' }))!.body as DeskItem).column, 'done');
  assert.equal((await call('POST', '/api/desk/put', { key: 'https://кривой адрес', patch: { title: 'x' } }))?.status, 400);
  // не своё и не заведённое — 400: кривой ключ MR завёл бы дубль без вещи
  assert.equal((await call('POST', '/api/desk/put', { key: 'mr:gitlab.com/a/b/7 x', patch: { title: 'x' } }))?.status, 400);
  assert.equal((await call('POST', '/api/desk/put', { key: 'own:новое с пробелом', patch: { title: 'x' } }))?.status, 200);
});

test('POST /api/desk/put: адрес в ключе не теряется — у MR в links.mr, у другого адреса — ссылкой сигнала', async (t) => {
  const { call } = setup(t);
  const mr = (await call('POST', '/api/desk/put', { key: 'https://gitlab.example.com/grp/app/-/merge_requests/7', patch: { title: 'MR' } }))!.body as DeskItem;
  assert.equal(mr.links.mr, 'https://gitlab.example.com/grp/app/-/merge_requests/7');
  const page = (await call('POST', '/api/desk/put', { key: 'https://wiki.example.com/page', patch: { title: 'Прочитать' } }))!.body as DeskItem;
  assert.match(page.key, /^own:url-/);
  // ключ MR без адреса: вещь есть, links.mr не выдумывается
  const byKey = (await call('POST', '/api/desk/put', { key: 'mr:gitlab.example.com/grp/app/8', patch: { title: 'MR 8' } }))!.body as DeskItem;
  assert.deepEqual([byKey.thing?.type, byKey.links.mr], ['mr', undefined]);
  assert.equal(page.signals[0]?.link, 'https://wiki.example.com/page');
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

test('POST /api/desk/link: у вещи уже есть дело (даже закрытое) — своё сливается в него: сигналы и ссылки, закрытое открывается; вид не «Своё» остаётся', async (t) => {
  const { store } = setup(t);
  const link = (body: unknown) => deskRoute('POST', new URL('http://x/api/desk/link'), async () => body, { store, jiraHosts: () => ['jira.example.com'] });
  const MR = 'mr:gitlab.example.com/g/app/12';
  await store.put(MR, { title: 'MR', column: 'plan', signal: { source: 'gitlab', at: '2026-11-17T10:00:00.000Z', text: 'ревью' } }, 'watcher');
  await store.close(MR, 'смержен', 'watcher');
  await store.put('own:a', { title: 'Доделать ретраи', due: '2026-11-30', links: { sessions: ['s1'] }, signal: { source: 'slack', at: '2026-11-18T10:00:00.000Z', text: 'сделаешь?' } }, 'me');
  const r = await link({ key: 'own:a', url: 'https://gitlab.example.com/g/app/-/merge_requests/12' });
  assert.equal(r?.status, 200);
  const merged = r!.body as DeskItem;
  assert.deepEqual(
    [merged.key, merged.title, merged.column, merged.closed, merged.due, merged.links.sessions, merged.signals.map((s) => s.text)],
    [MR, 'MR', 'plan', undefined, '2026-11-30', ['s1'], ['ревью', 'сделаешь?']],
  );
  assert.equal((await store.get('own:a'))?.closed?.reason, `${LINKED_REASON}MR g/app!12`);
  // в журнале: своё закрыто, дело вещи открыто из своего — это не новое дело
  const moves = store.readLog().slice(-2);
  assert.deepEqual(moves.map((m) => [m.key, m.from, m.to]), [['own:a', 'new', 'done'], [MR, 'done', 'plan']]);
  // «Готово» ⇔ closed у обоих
  for (const i of await store.list({})) assert.equal(i.column === 'done', Boolean(i.closed), i.key);
  // ключ вещи совпал со своим — не сливается само в себя
  await store.put('own:b', { title: 'b' }, 'me');
  assert.equal(await store.relink('own:b', { key: 'own:b', kind: 'Своё', type: 'mr', ref: {} }, 'x'), 'missing');
  assert.equal((await store.get('own:b'))?.closed, undefined);
  await store.put('own:m', { title: 'Созвон', kind: 'Встреча' }, 'me');
  const j = (await link({ key: 'own:m', url: 'https://jira.example.com/browse/pay-7' }))!.body as DeskItem;
  assert.deepEqual([j.key, j.kind, j.column], ['jira:jira.example.com/PAY-7', 'Встреча', 'new']);
});

test('GET /api/desk/item: дело и его движения из журнала, чужих движений нет; нет дела — 404, кривой ключ — 400', async (t) => {
  const { store, call } = setup(t);
  await store.put('own:a', { title: 'a', column: 'plan' }, 'routine');
  await store.put('own:b', { title: 'b' }, 'me');
  await store.move('own:a', 'work', 'me', 'начал');
  const r = await call('GET', '/api/desk/item?key=own:a');
  assert.equal(r?.status, 200);
  const reply = r!.body as DeskItemReply;
  assert.equal(reply.item.key, 'own:a');
  assert.deepEqual(reply.moves.map((m) => [m.key, m.from, m.to, m.by, m.why]), [['own:a', undefined, 'plan', 'routine', undefined], ['own:a', 'plan', 'work', 'me', 'начал']]);
  assert.equal((await call('GET', '/api/desk/item?key=own:none'))?.status, 404);
  assert.equal((await call('GET', '/api/desk/item?key=без-ключа'))?.status, 400);
  assert.equal((await call('GET', '/api/desk/item'))?.status, 400);
});

test('GET /api/desk/item: закрытое дело читается; у дела вещи, переехавшего со своего, есть и движения своего', async (t) => {
  const { store, call } = setup(t);
  await store.put('own:w', { title: 'Ретраи', column: 'plan' }, 'me');
  const linked = (await deskRoute('POST', new URL('http://x/api/desk/link'), async () => ({ key: 'own:w', url: 'https://gitlab.example.com/g/app/-/merge_requests/12' }), { store, jiraHosts: () => [] }))!.body as DeskItem;
  await store.close(linked.key, 'смержен', 'watcher');
  const r = await call('GET', `/api/desk/item?key=${encodeURIComponent(linked.key)}`);
  const reply = r!.body as DeskItemReply;
  assert.equal(reply.item.closed?.reason, 'смержен');
  assert.deepEqual(reply.moves.map((m) => [m.key, m.to]), [['own:w', 'plan'], ['own:w', 'done'], [linked.key, 'plan'], [linked.key, 'done']]);
  // у своего закрытого дела — только его движения
  const own = (await call('GET', '/api/desk/item?key=own:w'))!.body as DeskItemReply;
  assert.deepEqual(own.moves.map((m) => m.key), ['own:w', 'own:w']);
});

test('POST /api/desk/run-seen: закрывает дело «готов» по id запуска и первого запуска цепочки, упавшее не трогает', async (t) => {
  const { store, call } = setup(t);
  const ref = (runId: string, status: 'done' | 'failed') => ({ type: 'run' as const, ref: { runId, flow: 'f', status, costUsd: 0 } });
  await store.put('run:ok', { title: 'f готов', thing: ref('ok', 'done') }, 'flow');
  await store.put('run:bad', { title: 'f остановился с ошибкой', thing: ref('bad', 'failed') }, 'flow');
  let r = await call('POST', '/api/desk/run-seen', { runId: 'bad' });
  assert.deepEqual([r?.status, r?.body], [200, { closed: 0 }]);
  assert.equal((await store.get('run:bad'))?.column, 'new');
  r = await call('POST', '/api/desk/run-seen', { runId: 'next', root: 'ok' });
  assert.deepEqual(r?.body, { closed: 1 });
  assert.equal((await store.get('run:ok'))?.column, 'done');
  // id не из запуска — отказ
  assert.equal((await call('POST', '/api/desk/run-seen', { runId: '../x' }))?.status, 400);
  assert.equal((await call('POST', '/api/desk/run-seen', {}))?.status, 400);
});
