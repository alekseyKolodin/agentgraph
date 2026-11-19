import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionRequest } from '../../agent.js';
import type { McpCaller, McpCallResult } from '../../mcp-call.js';
import { toResult } from '../../mcp-call.js';
import type { RoutineEvent, SourceSpec } from '../types.js';
import { connectorKind, fillReplyArgs, mcpServices, replyOf, withReplyTo } from './connector.js';
import { makeCtx } from './testkit.js';

const READ = 'mcp__claude_ai_Slack__slack_read_channel';
const SEND = 'mcp__claude_ai_Slack__slack_send_message';
const ARGS = { channel_id: '{{channel}}', thread_ts: '{{thread}}', message: '{{text}}' };
const spec = (reply?: unknown, extra: Record<string, unknown> = {}): SourceSpec => ({ title: 'Slack', kind: 'connector', config: { tools: [READ], request: 'баги', ...(reply === undefined ? {} : { reply }), ...extra } });

function fakeMcp(answer: unknown = { content: [{ type: 'text', text: '{"ok":true}' }] }) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let closed = 0;
  const mcp = (): McpCaller => ({
    call: async (tool, args): Promise<McpCallResult> => {
      calls.push({ tool, args });
      return toResult(answer);
    },
    close: () => void closed++,
  });
  return { mcp, calls, closed: () => closed };
}

test('ответ коннектора: канал, тред и текст подставляются в шаблон, вызывается один выбранный инструмент без модели', async () => {
  const f = fakeMcp({ structuredContent: { ok: true, permalink: 'https://x.slack.com/archives/C1/p1' } });
  const kind = connectorKind({ session: async () => assert.fail('модель не нужна'), mcp: f.mcp });
  const r = await kind.reply!(makeCtx({ config: spec({ tool: SEND, args: ARGS }).config }), { channel: 'C1', thread: '1700.01' }, 'Взял в работу');
  assert.deepEqual(f.calls, [{ tool: SEND, args: { channel_id: 'C1', thread_ts: '1700.01', message: 'Взял в работу' } }]);
  assert.deepEqual(r, { link: 'https://x.slack.com/archives/C1/p1' });
  assert.equal(f.closed(), 1);
});

test('ответ коннектора: без треда аргумент треда не передаётся, канал из шаблона заменяет канал события', () => {
  assert.deepEqual(fillReplyArgs(ARGS, { channel: 'C1', text: 'ok' }), { channel_id: 'C1', message: 'ok' });
  assert.deepEqual(fillReplyArgs({ channel: 'C9', body: [{ text: 'Ответ: {{text}}' }] }, { text: 'ok' }), { channel: 'C9', body: [{ text: 'Ответ: ok' }] });
});

test('ответ коннектора: нет канала ни у события, ни в шаблоне — понятная ошибка, инструмент не вызван', async () => {
  const f = fakeMcp();
  const kind = connectorKind({ session: async () => assert.fail('модель не нужна'), mcp: f.mcp });
  await assert.rejects(kind.reply!(makeCtx({ config: spec({ tool: SEND, args: ARGS }).config }), undefined, 'ок'), /в какой канал/);
  assert.equal(f.calls.length, 0);
});

test('ответ коннектора: текст ответа с «{{…}}» второй раз не разбирается', () => {
  assert.deepEqual(fillReplyArgs({ m: '{{text}}', c: '{{channel}}' }, { channel: 'C1', text: 'вставь {{channel}}' }), { m: 'вставь {{channel}}', c: 'C1' });
});

test('ответ коннектора: ошибка инструмента и «ok: false» в ответе — ошибка, а не отправленный ответ', async () => {
  const bad = connectorKind({ session: async () => assert.fail('нет'), mcp: fakeMcp({ isError: true, content: [{ type: 'text', text: 'channel_not_found' }] }).mcp });
  const ctx = () => makeCtx({ config: spec({ tool: SEND, args: ARGS }).config });
  await assert.rejects(bad.reply!(ctx(), { channel: 'C1' }, 'ок'), /slack_send_message: channel_not_found/);
  const soft = connectorKind({ session: async () => assert.fail('нет'), mcp: fakeMcp({ structuredContent: { ok: false, error: 'not_in_channel' } }).mcp });
  await assert.rejects(soft.reply!(ctx(), { channel: 'C1' }, 'ок'), /not_in_channel/);
});

test('ответ коннектора: не настроен — ошибка, canReplyFor ложно; настроен и проходит проверку — истинно', () => {
  const k = connectorKind();
  assert.equal(k.canReplyFor!(spec()), false);
  assert.equal(k.canReplyFor!(spec({ tool: SEND, args: ARGS })), true);
  assert.equal(k.canReplyFor!(spec({ tool: SEND, args: { channel_id: '{{channel}}' } })), false);
  return assert.rejects(k.reply!(makeCtx({ config: spec().config }), { channel: 'C1' }, 'ок'), /ответ не настроен/);
});

test('ответ коннектора: проверка настройки — инструмент, шаблон с {{text}}, не читающий инструмент', () => {
  assert.equal(replyOf(spec()), undefined);
  assert.deepEqual(replyOf(spec({ tool: SEND, args: ARGS })), { tool: SEND, args: ARGS });
  assert.throws(() => replyOf(spec({ tool: 'slack_send_message', args: ARGS })), /выберите сервис и инструмент/);
  assert.throws(() => replyOf(spec({ tool: SEND, args: { message: 'без текста' } })), /нет \{\{text\}\}/);
  assert.throws(() => replyOf(spec({ tool: SEND, args: 'x' })), /аргументы — объект/);
  // тот же инструмент среди читающих — это не «единственный пишущий»
  assert.throws(() => replyOf(spec({ tool: READ, args: ARGS })), /среди читающих/);
});

test('ответ коннектора: пишущий инструмент ответа не попадает в скрипт и опрос — чтение по-прежнему только читающими', async () => {
  const k = connectorKind({ session: async () => assert.fail('нет'), mcp: fakeMcp().mcp });
  const withSend: SourceSpec = { title: 's', kind: 'connector', config: { tools: [READ], reply: { tool: SEND, args: ARGS }, script: { steps: [{ tool: SEND, args: {}, say: 'Пишет', json: { id: 'ts' } }] } } };
  await assert.rejects(k.poll!(makeCtx({ config: withSend.config })), /похож на запись/);
});

test('описание источника показывает инструмент ответа и шаблон', () => {
  const k = connectorKind();
  assert.match(k.describe(spec({ tool: SEND, args: ARGS })), /ОТПРАВЛЯЕТ сообщения .*единственный пишущий инструмент.*: slack_send_message .*\{\{text\}\}/);
  assert.match(k.describe(spec({ tool: SEND, args: {} })), /нет \{\{text\}\}/);
});

test('выбор инструмента ответа: пишущие инструменты отдельным списком, «отправить» раньше остальных; читающие не смешиваются', () => {
  const t = (name: string, readOnly = false, annotated = false) => ({ name: `mcp__claude_ai_Slack__${name}`, tool: name, readOnly, annotated });
  const [s] = mcpServices([
    { server: 'claude.ai Slack', name: 'mcp__claude_ai_Slack', status: 'connected', scope: 'claudeai', tools: [t('slack_read_channel', true, true), t('slack_create_canvas'), t('slack_send_message'), { name: 'без-префикса', tool: 'x', readOnly: false, annotated: false }] },
  ]);
  assert.deepEqual(s.tools.map((x) => x.tool), ['slack_read_channel']);
  assert.deepEqual(s.writeTools.map((x) => x.tool), ['slack_send_message', 'slack_create_canvas']);
  assert.equal(s.hidden, 3);
});

test('replyTo события берётся из нити, если вид его не положил', () => {
  const ev = (o: Partial<RoutineEvent>): RoutineEvent => ({ source: 's', id: 'a', at: '2026-11-19T10:00:00Z', title: 't', text: '', fields: {}, ...o });
  const [a, b, c] = withReplyTo([ev({ thread: { source: 's', channel: 'C1', thread: '17.1' } }), ev({ thread: { source: 's', thread: '17.2' } }), ev({ replyTo: { chat: 1 }, thread: { source: 's', thread: '9' } })]);
  assert.deepEqual(a.replyTo, { channel: 'C1', thread: '17.1' });
  assert.deepEqual(b.replyTo, { thread: '17.2' });
  assert.deepEqual(c.replyTo, { chat: 1 });
});

test('шаблон ответа: {{text}} только в значении, «$&» и {{thread}} внутри строки обрабатываются как данные', () => {
  assert.throws(() => replyOf(spec({ tool: SEND, args: { '{{text}}': 1 } })), /нет \{\{text\}\}/);
  assert.deepEqual(replyOf(spec({ tool: SEND, args: { blocks: [{ text: '{{text}}' }] } }))?.args, { blocks: [{ text: '{{text}}' }] });
  assert.deepEqual(fillReplyArgs({ m: '{{text}}' }, { text: 'цена $& и $1' }), { m: 'цена $& и $1' });
  // тред внутри составной строки без треда — пустая подстановка, целиком «{{thread}}» — аргумент не передаётся
  assert.deepEqual(fillReplyArgs({ k: '{{channel}}:{{thread}}', t: '{{thread}}', m: '{{text}}' }, { channel: 'C1', text: 'ok' }), { k: 'C1:', m: 'ok' });
});

test('ответ коннектора: тред берётся и из thread_ts, и числом', async () => {
  const f = fakeMcp();
  const kind = connectorKind({ session: async () => assert.fail('нет'), mcp: f.mcp });
  const config = spec({ tool: SEND, args: ARGS }).config;
  await kind.reply!(makeCtx({ config }), { channel: 'C1', thread_ts: '17.5' }, 'a');
  await kind.reply!(makeCtx({ config }), { channel: 'C1', thread: 42 }, 'b');
  assert.deepEqual(f.calls.map((c) => c.args.thread_ts), ['17.5', '42']);
});

test('ответ коннектора: завис инструмент — ошибка по таймауту, вызов закрыт', async () => {
  let closed = 0;
  const hung = (): McpCaller => ({ call: () => new Promise(() => {}), close: () => void closed++ });
  const kind = connectorKind({ session: async () => assert.fail('нет'), mcp: hung, replyTimeoutMs: 20 });
  await assert.rejects(kind.reply!(makeCtx({ config: spec({ tool: SEND, args: ARGS }).config }), { channel: 'C1' }, 'ок'), /не ответил/);
  assert.equal(closed, 1);
});

test('isSelf коннектора: отправленный рутиной ответ при следующем опросе — не событие, даже без профиля', async () => {
  const f = fakeMcp({ structuredContent: { ok: true, permalink: 'https://x.slack.com/archives/C1/p9' } });
  const kind = connectorKind({ session: async () => assert.fail('нет'), mcp: f.mcp, profile: () => ({ names: [], emails: [] }) as never });
  const ctx = makeCtx({ config: spec({ tool: SEND, args: ARGS }).config });
  const ev = (o: Partial<RoutineEvent>): RoutineEvent => ({ source: 's', id: 'a', at: '2026-11-19T10:00:00Z', title: 't', text: 'x', fields: {}, ...o });
  assert.equal(kind.isSelf!(ctx, ev({ text: 'Взял  в работу' })), false);
  await kind.reply!(ctx, { channel: 'C1' }, 'Взял в работу');
  assert.equal(kind.isSelf!(ctx, ev({ text: ' взял в  РАБОТУ ' })), true);
  assert.equal(kind.isSelf!(ctx, ev({ text: 'другое', link: 'https://x.slack.com/archives/C1/p9' })), true);
  assert.equal(kind.isSelf!(ctx, ev({ text: 'другое' })), false);
});

test('опрос моделью не получает инструмент ответа: allow и хук — только читающие', async () => {
  const reqs: SessionRequest[] = [];
  const kind = connectorKind({
    session: async (req) => {
      reqs.push(req);
      return { ok: true, subtype: 'success', text: '', structured: { records: [] }, costUsd: 0, turns: 1, durationMs: 1, errors: [] };
    },
  });
  await kind.poll!(makeCtx({ config: spec({ tool: SEND, args: ARGS }).config }));
  assert.deepEqual(reqs[0].allow, [READ]);
  assert.match(reqs[0].guard!(SEND, {}, { cwd: '/' })!, /Разрешены только/);
});
