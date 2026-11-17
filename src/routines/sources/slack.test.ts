import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { RoutineEvent } from '../types.js';
import { isUserMessage, resetSlackState, slackEvent, slackKind } from './slack.js';
import { fakeFetch, makeCtx } from './testkit.js';

beforeEach(() => {
  resetSlackState();
  process.env.AGENTGRAPH_SLACK_API = 'http://slack.test/api';
});
afterEach(() => {
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
  await assert.rejects(() => slackKind.poll!(makeCtx({ config: { channels: 'nope' }, secrets, fetch })), /Канал #nope не найден/);
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
