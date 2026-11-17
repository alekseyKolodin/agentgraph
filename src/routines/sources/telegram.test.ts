import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { RoutineEvent } from '../types.js';
import { telegramEvent, telegramKind } from './telegram.js';
import { fakeFetch, makeCtx } from './testkit.js';

beforeEach(() => {
  process.env.AGENTGRAPH_TELEGRAM_API = 'http://tg.test';
});
afterEach(() => {
  delete process.env.AGENTGRAPH_TELEGRAM_API;
});

const secrets = { TELEGRAM_BOT_TOKEN: '123:SECRET' };
const msg = (update_id: number, text: string, extra: Record<string, unknown> = {}) => ({
  update_id,
  message: { message_id: update_id * 10, date: 1700000000, chat: { id: 555, type: 'private', first_name: 'Анна' }, from: { id: 1, username: 'ann', first_name: 'Анна' }, text, ...extra },
});

test('сообщение Telegram → событие: id, автор, чат, команда, адрес ответа', () => {
  const e = telegramEvent('tg', msg(7, '/start привет'))!;
  assert.equal(e.id, '7');
  assert.equal(e.at, '2023-11-14T22:13:20.000Z');
  assert.equal(e.author, 'ann');
  assert.equal(e.fields.chat, 'Анна');
  assert.equal(e.fields.chat_id, '555');
  assert.equal(e.fields.is_command, true);
  assert.deepEqual(e.replyTo, { chat_id: 555, message_id: 70 });
});

test('сообщение без текста и обновление другого типа событий не дают', () => {
  assert.equal(telegramEvent('tg', { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 1 } } }), undefined);
  assert.equal(telegramEvent('tg', { update_id: 2 }), undefined);
});

test('у публичной группы ссылка на сообщение ведёт на t.me', () => {
  const e = telegramEvent('tg', msg(3, 'hi', { chat: { id: -100, type: 'supergroup', title: 'Команда', username: 'team' } }))!;
  assert.equal(e.link, 'https://t.me/team/30');
  assert.equal(e.fields.chat, 'Команда');
});

test('опрос: getUpdates с offset из курсора, курсор = последний update_id + 1, токен только в пути', async () => {
  const { fetch, calls } = fakeFetch(() => ({ ok: true, result: [msg(10, 'раз'), msg(11, 'два')] }));
  const ctx = makeCtx({ slug: 'tg', secrets, fetch, cursor: { offset: 10 } });
  const events = await telegramKind.poll!(ctx);
  assert.deepEqual(events.map((e) => e.title), ['раз', 'два']);
  assert.deepEqual(ctx.cursorValue(), { offset: 12 });
  assert.equal(calls[0].url.href, 'http://tg.test/bot123:SECRET/getUpdates');
  assert.equal((calls[0].body as { offset: number }).offset, 10);
  assert.equal((calls[0].body as { timeout: number }).timeout, 0);
});

test('пустой ответ курсор не трогает', async () => {
  const { fetch } = fakeFetch(() => ({ ok: true, result: [] }));
  const ctx = makeCtx({ secrets, fetch, cursor: { offset: 5 } });
  assert.deepEqual(await telegramKind.poll!(ctx), []);
  assert.deepEqual(ctx.cursorValue(), { offset: 5 });
});

test('/start запоминает чат по умолчанию, ответ без адресата идёт туда', async () => {
  const { fetch, calls } = fakeFetch(({ url }) => (url.pathname.endsWith('getUpdates') ? { ok: true, result: [msg(20, '/start')] } : { ok: true, result: { message_id: 99, chat: { id: 555 } } }));
  const ctx = makeCtx({ secrets, fetch });
  await telegramKind.poll!(ctx);
  assert.deepEqual(ctx.cursorValue(), { offset: 21, defaultChat: 555 });
  await telegramKind.reply!(ctx, undefined, 'Готово');
  const send = calls.find((c) => c.url.pathname.endsWith('sendMessage'))!;
  assert.deepEqual(send.body, { chat_id: 555, text: 'Готово' });
});

test('reply в чат события: в личном — без цитаты, в группе — ответом на сообщение', async () => {
  const { fetch, calls } = fakeFetch(() => ({ ok: true, result: { message_id: 1, chat: { id: 1, username: 'team' } } }));
  const ctx = makeCtx({ secrets, fetch });
  await telegramKind.reply!(ctx, { chat_id: 555, message_id: 70 }, 'личное');
  const r = await telegramKind.reply!(ctx, { chat_id: -100, message_id: 71 }, 'в группу');
  assert.deepEqual(calls[0].body, { chat_id: 555, text: 'личное' });
  assert.deepEqual(calls[1].body, { chat_id: -100, text: 'в группу', reply_to_message_id: 71 });
  assert.equal(r.link, 'https://t.me/team/1');
});

test('reply без чата — понятная ошибка; чат из настроек подходит', async () => {
  const { fetch, calls } = fakeFetch(() => ({ ok: true, result: { message_id: 1 } }));
  await assert.rejects(() => telegramKind.reply!(makeCtx({ secrets, fetch }), undefined, 'x'), /отправьте боту \/start/);
  await telegramKind.reply!(makeCtx({ secrets, fetch, config: { chat_id: '777' } }), undefined, 'x');
  assert.equal((calls[0].body as { chat_id: string }).chat_id, '777');
});

test('ошибка API: описание Telegram и подсказка, токена в тексте нет', async () => {
  const { fetch } = fakeFetch(() => ({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }));
  await assert.rejects(
    () => telegramKind.poll!(makeCtx({ secrets, fetch })),
    (e: Error) => /Conflict/.test(e.message) && /webhook/.test(e.message) && !e.message.includes('SECRET'),
  );
  const net = async () => {
    throw new Error('connect ECONNREFUSED http://tg.test/bot123:SECRET/getUpdates');
  };
  await assert.rejects(
    () => telegramKind.poll!(makeCtx({ secrets, fetch: net as unknown as typeof fetch })),
    (e: Error) => /недоступен/.test(e.message) && !e.message.includes('SECRET'),
  );
});

test('isSelf: сообщения ботов не события', () => {
  const mk = (is_bot: boolean): RoutineEvent => ({ source: 'tg', id: '1', at: '', title: '', text: '', fields: { is_bot } });
  assert.equal(telegramKind.isSelf!(makeCtx(), mk(true)), true);
  assert.equal(telegramKind.isSelf!(makeCtx(), mk(false)), false);
});

test('listen: накопленное до подключения не запускает рутины, новые сообщения уходят в emit', async () => {
  let call = 0;
  const { fetch, calls } = fakeFetch(() => {
    call++;
    if (call === 1) return { ok: true, result: [msg(1, 'старое')] };
    if (call === 2) return { ok: true, result: [] };
    return { ok: true, result: [msg(2, 'новое')] };
  });
  const ctx = makeCtx({ slug: 'tg', secrets, fetch });
  const got: string[] = [];
  await telegramKind.listen!(ctx, (events) => {
    got.push(...events.map((e) => e.title));
    ctx.abort.abort();
  });
  assert.deepEqual(got, ['новое']);
  assert.equal((calls[0].body as { timeout: number }).timeout, 0);
  assert.equal((calls[1].body as { timeout: number }).timeout, 0);
  assert.equal((calls[2].body as { timeout: number }).timeout, 25);
  assert.equal((calls[2].body as { offset: number }).offset, 2);
});

test('poll при живом listen того же бота не ходит в сеть: второй getUpdates вытеснил бы long poll', async () => {
  const { fetch, calls } = fakeFetch(({ body }) => ({ ok: true, result: (body as { timeout: number }).timeout === 0 ? [] : [msg(5, 'живое')] }));
  const ctx = makeCtx({ slug: 'tg', secrets, fetch });
  let polled: unknown[] | undefined;
  let callsAtPoll = -1;
  await telegramKind.listen!(ctx, (events) => {
    // listen сейчас внутри emit: проверяем «проверку на истории» именно в это время
    void telegramKind.poll!(makeCtx({ slug: 'tg', secrets, fetch })).then((r) => (polled = r));
    callsAtPoll = calls.length;
    ctx.abort.abort();
    assert.equal(events.length, 1);
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(polled, []);
  assert.equal(calls.length, callsAtPoll, 'poll не сделал ни одного запроса');
  // после остановки listen poll снова работает
  const after = await telegramKind.poll!(makeCtx({ slug: 'tg', secrets, fetch }));
  assert.deepEqual(after, []);
  assert.equal(calls.length, callsAtPoll + 1);
});

test('listen: накопилось больше 100 обновлений — первый заход листает до пустого ответа, старые не становятся событиями', async () => {
  let call = 0;
  const { fetch, calls } = fakeFetch(({ body }) => {
    call++;
    const off = (body as { offset?: number }).offset ?? 0;
    if (call <= 2) return { ok: true, result: Array.from({ length: 100 }, (_, i) => msg(off + i + 1, `старое ${call}-${i}`)) };
    if (call === 3) return { ok: true, result: [] };
    return { ok: true, result: [msg(1000, 'новое')] };
  });
  const ctx = makeCtx({ slug: 'tg', secrets: { TELEGRAM_BOT_TOKEN: 'tok-2' }, fetch });
  const got: string[] = [];
  await telegramKind.listen!(ctx, (events) => {
    got.push(...events.map((e) => e.title));
    ctx.abort.abort();
  });
  assert.deepEqual(got, ['новое']);
  assert.equal((calls[1].body as { offset: number }).offset, 101, 'второй заход идёт с offset после первой сотни');
  assert.equal((calls[3].body as { timeout: number }).timeout, 25);
});
