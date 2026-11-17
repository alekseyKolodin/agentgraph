import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import type { SessionRequest, SessionResult } from '../../agent.js';
import { CONNECTOR_MODEL, checkToolName, connectorKind } from './connector.js';
import { makeCtx } from './testkit.js';

const TOOL = 'mcp__claude_ai_Fireflies__fireflies_get_transcripts';
const ok = (structured: unknown): SessionResult => ({ ok: true, subtype: 'success', text: '', structured, costUsd: 0.01, turns: 2, durationMs: 1, errors: [] });

test('connector: сессия haiku с одним разрешённым read-only инструментом, записи → события', async () => {
  const reqs: SessionRequest[] = [];
  const kind = connectorKind({
    session: async (req) => {
      reqs.push(req);
      return ok({ records: [{ id: 'm1', title: 'Планёрка', text: 'Обсудили релиз', link: 'https://f.test/m1', at: '2026-11-17T09:00:00Z', author: 'Анна' }, { id: '', title: 'Без id', link: 'https://f.test/m2' }, { title: '', id: '' }] });
    },
  });
  const events = await kind.poll!(makeCtx({ slug: 'ff', config: { tool: TOOL, request: 'Встречи за сутки' } }));
  assert.deepEqual(events.map((e) => [e.id, e.title, e.author, e.link]), [['m1', 'Планёрка', 'Анна', 'https://f.test/m1'], ['https://f.test/m2', 'Без id', undefined, 'https://f.test/m2']]);
  const r = reqs[0];
  assert.equal(r.model, CONNECTOR_MODEL);
  assert.deepEqual([r.tools, r.implicitTools, r.allow, r.persist], [[], [], [TOOL], false]);
  assert.match(r.prompt, /<source-data>\nВстречи за сутки\n<\/source-data>/);
  // хук пропускает только свой инструмент
  assert.equal(r.guard!(TOOL, {}, { cwd: '/' }), undefined);
  assert.match(r.guard!('Bash', {}, { cwd: '/' })!, /Разрешён только/);
  assert.match(r.guard!('mcp__claude_ai_Fireflies__delete_meeting', {}, { cwd: '/' })!, /Разрешён только/);
});

test('connector: интервал не меньше 30 минут, delivery model, подписи есть', () => {
  const k = connectorKind();
  assert.equal(k.minEveryMs, 30 * 60_000);
  assert.equal(k.delivery, 'model');
  assert.ok(k.setup.every((f) => /[а-я]/i.test(f.label)));
});

test('connector: инструмент записи не принимается, пустое имя и чужой формат — тоже', () => {
  assert.equal(checkToolName(TOOL), TOOL);
  assert.equal(checkToolName('mcp__claude_ai_Notion__notion-search'), 'mcp__claude_ai_Notion__notion-search');
  assert.equal(checkToolName('mcp__claude_ai_X__list_assets'), 'mcp__claude_ai_X__list_assets');
  assert.throws(() => checkToolName('mcp__claude_ai_Slack__slack_send_message'), /похож на запись/);
  assert.throws(() => checkToolName('mcp__claude_ai_Notion__createPage'), /похож на запись/);
  assert.throws(() => checkToolName('Bash'), /mcp__/);
  assert.throws(() => checkToolName(undefined), /mcp__/);
});

test('connector: сессия упала или ответ не список — понятная ошибка', async () => {
  const failed = connectorKind({ session: async () => ({ ...ok(undefined), ok: false, subtype: 'error_max_turns', errors: ['слишком долго'] }) });
  await assert.rejects(() => failed.poll!(makeCtx({ config: { tool: TOOL } })), /слишком долго/);
  const bad = connectorKind({ session: async () => ok({ nope: 1 }) });
  await assert.rejects(() => bad.poll!(makeCtx({ config: { tool: TOOL } })), /не вернула список/);
});

test('connector: обработчик на сигнале опроса снимается после каждого опроса (и при ошибке), слушатели не копятся', async () => {
  const ok1 = connectorKind({ session: async () => ok({ records: [] }) });
  const failing = connectorKind({ session: async () => { throw new Error('сеть'); } });
  const ctx = makeCtx({ config: { tool: TOOL } });
  for (let i = 0; i < 30; i++) await ok1.poll!(ctx);
  for (let i = 0; i < 30; i++) await assert.rejects(() => failing.poll!(ctx), /сеть/);
  assert.equal(getEventListeners(ctx.signal, 'abort').length, 0);
  // остановка источника по-прежнему доходит до сессии
  let aborted = false;
  const slow = connectorKind({ session: async (req) => { ctx.abort.abort(); aborted = req.abort!.signal.aborted; return ok({ records: [] }); } });
  await slow.poll!(ctx);
  assert.equal(aborted, true);
});
