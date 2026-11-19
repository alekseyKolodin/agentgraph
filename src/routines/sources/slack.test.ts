import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { RoutineEvent } from '../types.js';
import { isUserMessage, resetSlackState, slackEvent, slackKind } from './slack.js';
import { writeProfile } from '../../settings.js';
import { fakeFetch, makeCtx } from './testkit.js';

let cfgDir = '';
beforeEach(() => {
  // профиль читается из настроек: тест не должен видеть настоящий ~/.agentgraph
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-slack-'));
  process.env.AGENTGRAPH_CONFIG_DIR = cfgDir;
  resetSlackState();
  process.env.AGENTGRAPH_SLACK_API = 'http://slack.test/api';
});
afterEach(() => {
  delete process.env.AGENTGRAPH_CONFIG_DIR;
  fs.rmSync(cfgDir, { recursive: true, force: true });
  delete process.env.AGENTGRAPH_SLACK_API;
});

const secrets = { SLACK_TOKEN: 'xoxb-secret-token' };

async function startWss(): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  return { wss, port: (wss.address() as AddressInfo).port };
}

/** Фейковый Slack: каналы, история, пользователи. */
function slackApi(history: Record<string, unknown[]>) {
  return fakeFetch(({ url, body }) => {
    const m = url.pathname.replace('/api/', '');
    if (m === 'auth.test') return { ok: true, user_id: 'UBOT', bot_id: 'BBOT', url: 'https://acme.slack.com/' };
    if (m === 'conversations.list') return { ok: true, channels: [{ id: 'C1', name: 'bugs' }, { id: 'C2', name: 'alerts' }] };
    if (m === 'users.conversations') return { ok: true, channels: [{ id: 'C1', name: 'bugs' }] };
    if (m === 'conversations.info') return { ok: true, channel: { id: url.searchParams.get('channel'), name: 'general' } };
    if (m === 'users.info') return { ok: true, user: { name: 'ann', profile: { display_name: 'Анна' } } };
    if (m === 'conversations.history') {
      const oldest = Number(url.searchParams.get('oldest') ?? 0);
      return { ok: true, messages: (history[url.searchParams.get('channel')!] ?? []).filter((x) => Number((x as { ts: string }).ts) > oldest).reverse() };
    }
    if (m === 'chat.postMessage') return { ok: true, ts: '1700000009.000100', channel: (body as { channel: string }).channel };
    return { ok: false, error: 'unknown_method' };
  });
}

test('сообщение Slack становится событием: поля, ссылка, адрес ответа в тред', () => {
  const e = slackEvent('slack-work', { id: 'C1', name: 'bugs' }, { ts: '1700000000.000200', user: 'U1', text: 'Падает оплата\nпосле обновления', files: [{ name: 'log.txt' }] }, { author: 'Анна', url: 'https://acme.slack.com/' });
  assert.equal(e.id, 'C1:1700000000.000200');
  assert.equal(e.title, 'Падает оплата');
  assert.equal(e.text, 'Падает оплата\nпосле обновления');
  assert.equal(e.at, '2023-11-14T22:13:20.000Z');
  assert.equal(e.link, 'https://acme.slack.com/archives/C1/p1700000000000200');
  assert.equal(e.author, 'Анна');
  assert.deepEqual(e.fields.files, ['log.txt']);
  assert.equal(e.fields.thread, false);
  assert.equal(e.fields.bot, false);
  assert.deepEqual(e.replyTo, { channel: 'C1', thread_ts: '1700000000.000200' });
});

test('ответ в треде помечается thread и отвечает в тот же тред', () => {
  const e = slackEvent('s', { id: 'C1', name: 'bugs' }, { ts: '1700000005.000100', thread_ts: '1700000000.000200', text: 'ещё' });
  assert.equal(e.fields.thread, true);
  assert.equal(e.replyTo?.thread_ts, '1700000000.000200');
});

test('нить события: у просьбы и у ответа в её треде — одна нить (продолжение того же разговора)', () => {
  const ch = { id: 'C1', name: 'review' };
  const ask = slackEvent('slack-work', ch, { ts: '1700000000.000200', text: 'глянь https://gitlab.com/g/app/-/merge_requests/3' });
  const reply = slackEvent('slack-work', ch, { ts: '1700000005.000100', thread_ts: '1700000000.000200', text: 'поправил, глянь' });
  assert.deepEqual(ask.thread, { source: 'slack-work', channel: 'C1', thread: '1700000000.000200' });
  assert.deepEqual(reply.thread, ask.thread);
  // другое сообщение вне треда — своя нить
  assert.notDeepEqual(slackEvent('slack-work', ch, { ts: '1700000009.000100', text: 'другое' }).thread, ask.thread);
});

test('служебные сообщения (вошёл в канал, правка) и пустые — не события', () => {
  assert.equal(isUserMessage({ ts: '1.1', subtype: 'channel_join', text: 'x' }), false);
  assert.equal(isUserMessage({ ts: '1.1', subtype: 'message_changed' }), false);
  assert.equal(isUserMessage({ ts: '1.1', text: '  ' }), false);
  assert.equal(isUserMessage({ ts: '1.1', subtype: 'bot_message', text: 'алерт' }), true);
  assert.equal(isUserMessage({ ts: '1.1', files: [{ name: 'a' }] }), true);
});

test('опрос: каналы по названию, первый заход берёт последние, курсор двигается, дальше — только новое', async () => {
  const history = { C1: [{ ts: '1700000001.000000', user: 'U1', text: 'раз' }, { ts: '1700000002.000000', user: 'U1', text: 'два' }] };
  const { fetch, calls } = slackApi(history);
  const ctx = makeCtx({ slug: 'slack-work', config: { channels: '#bugs' }, secrets, fetch });
  const first = await slackKind.poll!(ctx);
  assert.deepEqual(first.map((e) => e.title), ['раз', 'два']);
  assert.equal(first[0].author, 'Анна');
  assert.equal(first[0].link, 'https://acme.slack.com/archives/C1/p1700000001000000');
  assert.deepEqual(ctx.cursorValue(), { ts: { C1: '1700000002.000000' } });
  // токен идёт в заголовке, не в адресе
  assert.ok(calls.every((c) => c.headers.authorization === 'Bearer xoxb-secret-token' && !c.url.href.includes('xoxb')));
  assert.equal(calls.find((c) => c.url.pathname.endsWith('conversations.history'))?.url.searchParams.get('oldest'), null);

  history.C1.push({ ts: '1700000003.000000', user: 'U1', text: 'три' });
  const second = await slackKind.poll!(ctx);
  assert.deepEqual(second.map((e) => e.title), ['три']);
  const last = calls.filter((c) => c.url.pathname.endsWith('conversations.history')).at(-1)!;
  assert.equal(last.url.searchParams.get('oldest'), '1700000002.000000');
  assert.deepEqual(ctx.cursorValue(), { ts: { C1: '1700000003.000000' } });
});

test('опрос: служебные сообщения пропускаются, но курсор их проходит', async () => {
  const { fetch } = slackApi({ C1: [{ ts: '1700000001.000000', subtype: 'channel_join', text: 'вошёл' }] });
  const ctx = makeCtx({ config: { channels: 'C1' }, secrets, fetch });
  assert.deepEqual(await slackKind.poll!(ctx), []);
  assert.deepEqual(ctx.cursorValue(), { ts: { C1: '1700000001.000000' } });
});

test('опрос без списка каналов берёт все каналы токена', async () => {
  const { fetch, calls } = slackApi({ C1: [{ ts: '1700000001.000000', user: 'U1', text: 'привет' }] });
  const ctx = makeCtx({ secrets, fetch });
  assert.equal((await slackKind.poll!(ctx)).length, 1);
  assert.ok(calls.some((c) => c.url.pathname.endsWith('users.conversations')));
});

test('канал, которого нет, — понятная ошибка', async () => {
  const { fetch } = slackApi({});
  await assert.rejects(() => slackKind.poll!(makeCtx({ config: { channels: 'nope' }, secrets, fetch })), /«nope» не найдены/);
});

test('ошибка API Slack: текст понятный, токена в нём нет', async () => {
  const { fetch } = fakeFetch(() => ({ ok: false, error: 'invalid_auth' }));
  await assert.rejects(
    () => slackKind.poll!(makeCtx({ config: { channels: 'C0000000A' }, secrets, fetch })),
    (e: Error) => /токен не подошёл/.test(e.message) && !e.message.includes('xoxb-secret-token'),
  );
});

test('нет токена — просим ключ', async () => {
  await assert.rejects(() => slackKind.poll!(makeCtx({ config: { channels: 'C1' } })), /SLACK_TOKEN/);
});

test('isSelf: сообщения своего бота и пользователя токена — не события', async () => {
  const { fetch } = slackApi({ C1: [{ ts: '1700000001.000000', user: 'U1', text: 'чужое' }] });
  const ctx = makeCtx({ config: { channels: 'C1' }, secrets, fetch });
  await slackKind.poll!(ctx); // узнаём, кто мы (auth.test)
  const mk = (fields: Record<string, unknown>): RoutineEvent => ({ source: 's', id: '1', at: '', title: '', text: '', fields });
  assert.equal(slackKind.isSelf!(ctx, mk({ user: 'UBOT' })), true);
  assert.equal(slackKind.isSelf!(ctx, mk({ user: '', bot_id: 'BBOT' })), true);
  assert.equal(slackKind.isSelf!(ctx, mk({ user: 'U1', bot_id: '' })), false);
  assert.equal(slackKind.isSelf!(ctx, mk({ user: 'U1', bot_id: 'BOTHER' })), false);
});

test('reply: chat.postMessage в тред события, ссылка на ответ', async () => {
  const { fetch, calls } = slackApi({});
  const ctx = makeCtx({ config: { channels: 'bugs' }, secrets, fetch });
  const r = await slackKind.reply!(ctx, { channel: 'C1', thread_ts: '1700000000.000200' }, 'Взял в работу');
  const post = calls.find((c) => c.url.pathname.endsWith('chat.postMessage'))!;
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { channel: 'C1', text: 'Взял в работу', thread_ts: '1700000000.000200' });
  assert.equal(r.link, 'https://acme.slack.com/archives/C1/p1700000009000100');
});

test('reply без адресата идёт в первый канал источника, без канала — ошибка', async () => {
  const { fetch, calls } = slackApi({});
  await slackKind.reply!(makeCtx({ config: { channels: 'alerts' }, secrets, fetch }), undefined, 'привет');
  assert.equal((calls.find((c) => c.url.pathname.endsWith('chat.postMessage'))!.body as { channel: string }).channel, 'C2');
  const none = slackApi({});
  none.calls.length = 0;
  await assert.rejects(() => slackKind.reply!(makeCtx({ secrets, fetch: fakeFetch(({ url }) => (url.pathname.endsWith('users.conversations') ? { ok: true, channels: [] } : { ok: true })).fetch }), undefined, 'x'), /не знаю, в какой канал/);
});

test('Socket Mode: соединение, подтверждение конверта, событие в нужном канале, чужие каналы отфильтрованы', async () => {
  const { wss, port } = await startWss();
  const acks: unknown[] = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => acks.push(JSON.parse(String(raw))));
    ws.send(JSON.stringify({ type: 'hello' }));
    const msg = (envelope_id: string, channel: string, ts: string, text: string) => ws.send(JSON.stringify({ type: 'events_api', envelope_id, payload: { event: { type: 'message', channel, ts, user: 'U1', text } } }));
    msg('e1', 'C2', '1700000001.000000', 'не тот канал');
    msg('e2', 'C1', '1700000002.000000', 'баг в оплате');
  });
  const { fetch } = fakeFetch(({ url }) => {
    const m = url.pathname.replace('/api/', '');
    if (m === 'apps.connections.open') return { ok: true, url: `ws://127.0.0.1:${port}` };
    if (m === 'auth.test') return { ok: true, user_id: 'UBOT', url: 'https://acme.slack.com/' };
    if (m === 'conversations.list') return { ok: true, channels: [{ id: 'C1', name: 'bugs' }] };
    if (m === 'users.info') return { ok: true, user: { name: 'ann' } };
    return { ok: false, error: 'unknown' };
  });
  const ctx = makeCtx({ config: { channels: 'bugs' }, secrets: { ...secrets, SLACK_APP_TOKEN: 'xapp-1' }, fetch });
  const got: RoutineEvent[] = [];
  const done = slackKind.listen!(ctx, (events) => {
    got.push(...events);
    ctx.abort.abort();
  });
  await done;
  for (const c of wss.clients) c.terminate();
  wss.close();
  assert.deepEqual(got.map((e) => [e.id, e.text, e.fields.channel]), [['C1:1700000002.000000', 'баг в оплате', 'bugs']]);
  assert.deepEqual(acks.map((a) => (a as { envelope_id: string }).envelope_id).sort(), ['e1', 'e2']);
});

test('Socket Mode: обрыв соединения — ошибка (движок переподключится)', async () => {
  const { wss, port } = await startWss();
  wss.on('connection', (ws) => ws.close());
  const { fetch } = fakeFetch(({ url }) => {
    const m = url.pathname.replace('/api/', '');
    if (m === 'apps.connections.open') return { ok: true, url: `ws://127.0.0.1:${port}` };
    if (m === 'auth.test') return { ok: true, user_id: 'UBOT' };
    return { ok: true, channels: [] };
  });
  const ctx = makeCtx({ secrets: { ...secrets, SLACK_APP_TOKEN: 'xapp-1' }, fetch });
  await assert.rejects(() => slackKind.listen!(ctx, () => {}), /соединение закрыто/);
  for (const c of wss.clients) c.terminate();
  wss.close();
});

test('без app-токена listen опрашивает: первый заход только запоминает курсор', async () => {
  const history = { C1: [{ ts: '1700000001.000000', user: 'U1', text: 'старое' }] };
  const { fetch } = slackApi(history);
  const ctx = makeCtx({ config: { channels: 'C1' }, secrets, fetch });
  const got: string[] = [];
  const done = slackKind.listen!(ctx, (events) => {
    got.push(...events.map((e) => e.title));
    ctx.abort.abort();
  });
  // после первого захода курсор есть, события не ушли
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, []);
  assert.deepEqual(ctx.cursorValue(), { ts: { C1: '1700000001.000000' } });
  ctx.abort.abort();
  await done;
});

test('опрос: сообщений больше страницы — листаем по next_cursor, середина не теряется', async () => {
  const pages: Record<string, unknown> = {
    first: { ok: true, has_more: true, response_metadata: { next_cursor: 'p2' }, messages: [{ ts: '1700000005.000000', user: 'U1', text: 'e' }, { ts: '1700000004.000000', user: 'U1', text: 'd' }] },
    p2: { ok: true, has_more: false, messages: [{ ts: '1700000003.000000', user: 'U1', text: 'c' }, { ts: '1700000002.000000', user: 'U1', text: 'b' }] },
  };
  const { fetch, calls } = fakeFetch(({ url }) => {
    const m = url.pathname.replace('/api/', '');
    if (m === 'auth.test') return { ok: true, user_id: 'UBOT' };
    if (m === 'users.info') return { ok: true, user: { name: 'ann' } };
    if (m === 'conversations.history') return pages[url.searchParams.get('cursor') ?? 'first'];
    return { ok: false, error: 'unknown_method' };
  });
  const ctx = makeCtx({ config: { channels: 'C1' }, secrets, fetch, cursor: { ts: { C1: '1700000001.000000' } } });
  const events = await slackKind.poll!(ctx);
  assert.deepEqual(events.map((e) => e.title), ['b', 'c', 'd', 'e']);
  assert.deepEqual(ctx.cursorValue(), { ts: { C1: '1700000005.000000' } });
  assert.equal(calls.filter((c) => c.url.pathname.endsWith('conversations.history')).length, 2);
});

test('опрос: ответы в треде приходят через conversations.replies, родитель второй раз не выдаётся', async () => {
  const { fetch, calls } = fakeFetch(({ url }) => {
    const m = url.pathname.replace('/api/', '');
    if (m === 'auth.test') return { ok: true, user_id: 'UBOT' };
    if (m === 'users.info') return { ok: true, user: { name: 'ann' } };
    if (m === 'conversations.history') return { ok: true, messages: [{ ts: '1700000002.000000', user: 'U1', text: 'вопрос', reply_count: 2, latest_reply: '1700000004.000000', thread_ts: '1700000002.000000' }] };
    if (m === 'conversations.replies') return { ok: true, messages: [{ ts: '1700000002.000000', user: 'U1', text: 'вопрос', thread_ts: '1700000002.000000' }, { ts: '1700000003.000000', user: 'U2', text: 'ответ', thread_ts: '1700000002.000000' }, { ts: '1700000004.000000', user: 'U2', text: 'ещё', thread_ts: '1700000002.000000' }] };
    return { ok: false, error: 'unknown_method' };
  });
  const ctx = makeCtx({ config: { channels: 'C1' }, secrets, fetch, cursor: { ts: { C1: '1700000001.000000' } } });
  const events = await slackKind.poll!(ctx);
  assert.deepEqual(events.map((e) => e.title), ['вопрос', 'ответ', 'ещё']);
  assert.equal(events[1].fields.thread, true);
  assert.deepEqual(events[1].replyTo, { channel: 'C1', thread_ts: '1700000002.000000' });
  assert.equal(calls.find((c) => c.url.pathname.endsWith('conversations.replies'))!.url.searchParams.get('ts'), '1700000002.000000');
  assert.deepEqual(ctx.cursorValue(), { ts: { C1: '1700000004.000000' } });
});

test('опрос: канал, добавленный в работающий источник, только запоминается — старые сообщения не события', async () => {
  const history = { C1: [{ ts: '1700000009.000000', user: 'U1', text: 'старое' }], C2: [] as unknown[] };
  const { fetch } = slackApi(history);
  const ctx = makeCtx({ config: { channels: 'C1, C2' }, secrets, fetch, cursor: { ts: { C2: '1700000001.000000' } } });
  history.C2.push({ ts: '1700000002.000000', user: 'U1', text: 'новое в старом канале' });
  const events = await slackKind.poll!(ctx);
  assert.deepEqual(events.map((e) => e.title), ['новое в старом канале']);
  assert.deepEqual(ctx.cursorValue(), { ts: { C1: '1700000009.000000', C2: '1700000002.000000' } });
  // пустой новый канал получает точку отсчёта «сейчас»
  const empty = makeCtx({ config: { channels: 'C2' }, secrets, fetch: slackApi({ C2: [] }).fetch, cursor: { ts: { C1: '1700000001.000000' } } });
  assert.deepEqual(await slackKind.poll!(empty), []);
  assert.match((empty.cursorValue() as { ts: Record<string, string> }).ts.C2, /^\d+\.000000$/);
});

test('опрос: канал, пустой на первом заходе, — первое сообщение в нём уже событие', async () => {
  const history = { C1: [] as unknown[] };
  const { fetch } = slackApi(history);
  const ctx = makeCtx({ config: { channels: 'C1' }, secrets, fetch });
  assert.deepEqual(await slackKind.poll!(ctx), []);
  history.C1.push({ ts: `${Math.floor(Date.now() / 1000) + 1}.000100`, user: 'U1', text: 'первый баг в канале' });
  const events = await slackKind.poll!(ctx);
  assert.deepEqual(events.map((e) => e.title), ['первый баг в канале']);
});

test('reply без адресата и без каналов в настройках — ошибка, а не первый попавшийся канал бота', async () => {
  const { fetch, calls } = slackApi({});
  await assert.rejects(() => slackKind.reply!(makeCtx({ secrets, fetch }), undefined, 'x'), /не знаю, в какой канал/);
  assert.ok(!calls.some((c) => c.url.pathname.endsWith('chat.postMessage')));
});

test('Socket Mode: disconnect от Slack — тихое переподключение внутри listen, а не ошибка источника', async () => {
  const { wss, port } = await startWss();
  let connections = 0;
  wss.on('connection', (ws) => {
    connections++;
    if (connections === 1) ws.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }));
    else ws.send(JSON.stringify({ type: 'events_api', envelope_id: 'e1', payload: { event: { type: 'message', channel: 'C1', ts: '1700000002.000000', user: 'U1', text: 'после обновления' } } }));
  });
  const { fetch } = fakeFetch(({ url }) => {
    const m = url.pathname.replace('/api/', '');
    if (m === 'apps.connections.open') return { ok: true, url: `ws://127.0.0.1:${port}` };
    if (m === 'auth.test') return { ok: true, user_id: 'UBOT', url: 'https://acme.slack.com/' };
    if (m === 'conversations.info') return { ok: true, channel: { id: 'C1', name: 'bugs' } };
    if (m === 'users.info') return { ok: true, user: { name: 'ann' } };
    return { ok: false, error: 'unknown' };
  });
  const ctx = makeCtx({ secrets: { ...secrets, SLACK_APP_TOKEN: 'xapp-1' }, fetch });
  const got: string[] = [];
  await slackKind.listen!(ctx, (events) => {
    got.push(...events.map((e) => e.text));
    ctx.abort.abort();
  });
  for (const c of wss.clients) c.terminate();
  wss.close();
  assert.equal(connections, 2);
  assert.deepEqual(got, ['после обновления']);
});

/** Фейковый Slack с личкой D1 (собеседник U2 — Борис) и групповой личкой G1; типы беседы смотрим по запросу. */
function dmApi(history: Record<string, unknown[]>, wsPort?: number) {
  return fakeFetch(({ url, body }) => {
    const m = url.pathname.replace('/api/', '');
    const types = url.searchParams.get('types') ?? '';
    const boris = url.searchParams.get('user') === 'U2';
    if (m === 'apps.connections.open') return { ok: true, url: `ws://127.0.0.1:${wsPort}` };
    if (m === 'auth.test') return { ok: true, user_id: 'UBOT', bot_id: 'BBOT', url: 'https://acme.slack.com/' };
    if (m === 'users.conversations') {
      return { ok: true, channels: [...(types.includes('public_channel') ? [{ id: 'C1', name: 'bugs' }] : []), ...(types.includes('im') ? [{ id: 'D1', is_im: true, user: 'U2' }] : []), ...(types.includes('mpim') ? [{ id: 'G1', name: 'mpdm-a--b-1', is_mpim: true }] : [])] };
    }
    if (m === 'conversations.list') return { ok: true, channels: types.includes('im') ? [{ id: 'D1', is_im: true, user: 'U2' }] : [{ id: 'C1', name: 'bugs' }] };
    if (m === 'conversations.info') return { ok: true, channel: url.searchParams.get('channel') === 'D1' ? { id: 'D1', is_im: true, user: 'U2' } : { id: 'C1', name: 'bugs' } };
    if (m === 'users.info') return { ok: true, user: { name: boris ? 'boris' : 'ann', profile: { display_name: boris ? 'Борис' : 'Анна' } } };
    if (m === 'conversations.history') return { ok: true, messages: [...(history[url.searchParams.get('channel')!] ?? [])].reverse() };
    if (m === 'chat.postMessage') return { ok: true, ts: '1700000009.000100', channel: (body as { channel: string }).channel };
    return { ok: false, error: 'unknown_method' };
  });
}

test('опрос с «Лички: да» и пустым списком запрашивает и лички: имя лички — имя собеседника', async () => {
  const { fetch, calls } = dmApi({ D1: [{ ts: '1700000001.000000', user: 'U2', text: 'привет, глянь баг' }] });
  const ctx = makeCtx({ slug: 's', config: { dms: 'да' }, secrets, fetch });
  const events = await slackKind.poll!(ctx);
  assert.equal(calls.find((c) => c.url.pathname.endsWith('users.conversations'))?.url.searchParams.get('types'), 'public_channel,private_channel,im,mpim');
  const dm = events.find((e) => e.fields.channel_id === 'D1')!;
  assert.equal(dm.fields.channel, 'Борис');
  assert.equal(dm.link, 'https://acme.slack.com/archives/D1/p1700000001000000');
  assert.deepEqual(dm.replyTo, { channel: 'D1', thread_ts: '1700000001.000000' });
  assert.ok('G1' in (ctx.cursorValue() as { ts: Record<string, string> }).ts); // групповая личка опрашивается
});

test('опрос: личка указывается именем собеседника (с @ и без) или id', async () => {
  const history = { D1: [{ ts: '1700000001.000000', user: 'U2', text: 'привет' }] };
  for (const channels of ['@Борис', 'борис', 'D1']) {
    resetSlackState();
    const { fetch } = dmApi(history);
    const events = await slackKind.poll!(makeCtx({ slug: 's', config: { channels }, secrets, fetch }));
    assert.deepEqual(events.map((e) => [e.fields.channel, e.title]), [['Борис', 'привет']], channels);
  }
});

test('reply в личку: chat.postMessage в D-канал, как в обычный', async () => {
  const { fetch, calls } = dmApi({});
  const r = await slackKind.reply!(makeCtx({ config: {}, secrets, fetch }), { channel: 'D1', thread_ts: '1700000001.000000' }, 'ок');
  assert.deepEqual(calls.find((c) => c.url.pathname.endsWith('chat.postMessage'))?.body, { channel: 'D1', text: 'ок', thread_ts: '1700000001.000000' });
  assert.equal(r.link, 'https://acme.slack.com/archives/D1/p1700000009000100');
});

test('hint токена называет права для личек, а настройки — что можно указать личку', () => {
  const hint = slackKind.setup!.find((f) => f.key === 'SLACK_TOKEN')!.hint!;
  for (const scope of ['im:history', 'mpim:history', 'im:read', 'mpim:read']) assert.ok(hint.includes(scope), scope);
  assert.match(slackKind.setup!.find((f) => f.key === 'channels')!.hint!, /собеседника/);
});

test('Socket Mode: сообщение в личке приходит событием с именем собеседника', async () => {
  const { wss, port } = await startWss();
  wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'events_api', envelope_id: 'e1', payload: { event: { type: 'message', channel_type: 'im', channel: 'D1', ts: '1700000001.000000', user: 'U2', text: 'привет' } } })));
  const { fetch } = dmApi({}, port);
  const ctx = makeCtx({ slug: 's', config: { dms: 'да' }, secrets: { ...secrets, SLACK_APP_TOKEN: 'xapp-x' }, fetch });
  const got: RoutineEvent[] = [];
  await slackKind.listen!(ctx, (events) => {
    got.push(...events);
    ctx.abort.abort();
  });
  for (const c of wss.clients) c.terminate();
  wss.close();
  assert.equal(got[0].fields.channel, 'Борис');
  assert.equal(got[0].fields.channel_id, 'D1');
});

test('isSelf: при токене бота «я» — slackUserId из профиля, бот тоже свой', async () => {
  const { fetch } = slackApi({ C1: [{ ts: '1700000001.000000', user: 'UME', text: 'моё' }, { ts: '1700000002.000000', user: 'UBOT', text: 'бот' }, { ts: '1700000003.000000', user: 'UOTHER', text: 'чужое' }] });
  const ctx = makeCtx({ config: { channels: 'C1' }, secrets, fetch });
  writeProfile({ slackUserId: 'UME' });
  const events = await slackKind.poll!(makeCtx({ config: { channels: 'C1' }, secrets, fetch, cursor: { ts: { C1: '1700000000.000000' } } }));
  assert.deepEqual(events.map((e) => slackKind.isSelf!(ctx, e)), [true, true, false]);
});

test('to_me: упоминание id из профиля и личка — обращено ко мне, своё сообщение — нет', async () => {
  writeProfile({ slackUserId: 'UME' });
  const ch = { id: 'C1', name: 'bugs' };
  const me = 'UME';
  const f = (c: { id: string; name: string }, m: { user?: string; text: string; parent_user_id?: string; thread_ts?: string }) => slackEvent('s', c, { ts: '1700000000.000100', ...m }, { me }).fields.to_me;
  assert.equal(f(ch, { user: 'U1', text: 'глянь <@UME>' }), true);
  assert.equal(f(ch, { user: 'U1', text: 'глянь <@UOTHER>' }), false);
  assert.equal(f({ id: 'D9', name: 'Анна' }, { user: 'U1', text: 'привет' }), true);
  assert.equal(f(ch, { user: 'UME', text: 'я же <@UME>' }), false);
  assert.equal(slackEvent('s', ch, { ts: '1700000000.000100', user: 'U1', text: '<@UME>' }).fields.to_me, false, 'без id профиля и токена сказать нечего');
});

test('опрос без «Лички: да» и с пустым списком читает только каналы', async () => {
  const { fetch, calls } = dmApi({ D1: [{ ts: '1700000001.000000', user: 'U2', text: 'личное' }] });
  const events = await slackKind.poll!(makeCtx({ slug: 's', config: {}, secrets, fetch }));
  assert.equal(calls.find((c) => c.url.pathname.endsWith('users.conversations'))?.url.searchParams.get('types'), 'public_channel,private_channel');
  assert.ok(!events.some((e) => e.fields.channel_id === 'D1'));
});

test('«Лички: да», но у токена нет im:read (missing_scope): повтор только по каналам, источник не ломается', async () => {
  const types: string[] = [];
  const { fetch } = fakeFetch(({ url }) => {
    const m = url.pathname.replace('/api/', '');
    if (m === 'auth.test') return { ok: true, user_id: 'UBOT', bot_id: 'BBOT', url: 'https://acme.slack.com/' };
    if (m === 'users.conversations') {
      types.push(url.searchParams.get('types') ?? '');
      return url.searchParams.get('types')!.includes('im') ? { ok: false, error: 'missing_scope' } : { ok: true, channels: [{ id: 'C1', name: 'bugs' }] };
    }
    if (m === 'conversations.history') return { ok: true, messages: [{ ts: '1700000001.000000', user: 'U1', text: 'привет' }] };
    if (m === 'users.info') return { ok: true, user: { name: 'ann', profile: { display_name: 'Анна' } } };
    return { ok: false, error: 'unknown_method' };
  });
  const ctx = makeCtx({ slug: 's', config: { dms: 'да' }, secrets, fetch });
  const events = await slackKind.poll!(ctx);
  assert.deepEqual(types, ['public_channel,private_channel,im,mpim', 'public_channel,private_channel']);
  assert.equal(events.length, 1);
  assert.ok(ctx.logs.some((l) => /im:read/.test(l)));
});

test('to_me: упоминание с именем, ответ в моём треде, личка только при моём токене', () => {
  const ch = { id: 'C1', name: 'bugs' };
  const ev = (c: { id: string; name: string }, m: object, extra: object = { me: 'UME' }) => slackEvent('s', c, { ts: '1700000005.000100', thread_ts: '1700000000.000200', user: 'U1', text: 'ок', ...m }, extra).fields.to_me;
  assert.equal(ev(ch, { text: 'глянь <@UME|алексей>' }), true);
  assert.equal(ev(ch, { parent_user_id: 'UME' }), true, 'ответ в моём треде');
  assert.equal(ev(ch, { parent_user_id: 'UOTHER' }), false, 'чужой тред без упоминания');
  assert.equal(ev(ch, { user: 'UME', parent_user_id: 'UME' }), false, 'я сам в своём треде');
  assert.equal(ev({ id: 'D1', name: 'Борис' }, {}), true, 'личка с моим токеном');
  assert.equal(ev({ id: 'D1', name: 'Борис' }, {}, { me: 'UME', ownToken: false }), false, 'личка с ботом — не моя');
  assert.equal(ev({ id: 'D1', name: 'Борис' }, { text: '<@UME> глянь' }, { me: 'UME', ownToken: false }), true, 'но упоминание — моё');
});

test('to_me при токене бота: me — id из профиля, лички бота мне не адресованы', async () => {
  writeProfile({ slackUserId: 'UME' });
  const { fetch } = dmApi({ C1: [{ ts: '1700000001.000000', user: 'U1', text: 'эй <@UME>' }], D1: [{ ts: '1700000002.000000', user: 'U2', text: 'привет' }] });
  const events = await slackKind.poll!(makeCtx({ slug: 's', config: { dms: 'да' }, secrets, fetch, cursor: { ts: { C1: '1700000000.000000', D1: '1700000000.000000', G1: '1700000000.000000' } } }));
  assert.deepEqual(events.map((e) => [e.fields.channel_id, e.fields.to_me]), [['C1', true], ['D1', false]]);
});

test('Socket Mode: без списка каналов и без «Лички: да» события личек отбрасываются, с «да» — приходят', async () => {
  for (const dms of [undefined, 'да']) {
    const { wss, port } = await startWss();
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello' }));
      const msg = (id: string, channel: string, channel_type: string) => ws.send(JSON.stringify({ type: 'events_api', envelope_id: id, payload: { event: { type: 'message', channel, channel_type, ts: `17000000${id}.000000`, user: 'U2', text: `в ${channel}` } } }));
      msg('01', 'D1', 'im');
      msg('02', 'G1', 'mpim');
      msg('03', 'C1', 'channel');
    });
    const { fetch } = dmApi({}, port);
    const ctx = makeCtx({ slug: 's', config: { ...(dms ? { dms } : {}) }, secrets: { ...secrets, SLACK_APP_TOKEN: 'xapp-1' }, fetch });
    const got: string[] = [];
    const done = slackKind.listen!(ctx, (events) => {
      got.push(...events.map((e) => String(e.fields.channel_id)));
      if (got.length >= (dms ? 3 : 1)) ctx.abort.abort();
    });
    await done.catch(() => {});
    for (const c of wss.clients) c.terminate();
    wss.close();
    assert.deepEqual([...got].sort(), dms ? ['C1', 'D1', 'G1'] : ['C1'], `dms=${dms}`);
  }
});
