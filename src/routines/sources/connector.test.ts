import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import type { SessionRequest, SessionResult } from '../../agent.js';
import { CONNECTOR_MODEL, checkToolName, connectorKind, mcpServices } from './connector.js';
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
  assert.throws(() => checkToolName('mcp__claude_ai_Claude_Docs__batch'), /похож на запись/);
  assert.throws(() => checkToolName('mcp__claude_ai_Slack__slack_schedule_message'), /похож на запись/);
  assert.throws(() => checkToolName('Bash'), /Выберите сервис/);
  assert.throws(() => checkToolName(undefined), /Выберите сервис/);
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

test('connector: в выбор попадают только читающие инструменты, похожий на список — первым', () => {
  const tool = (t: string, o: { readOnly?: boolean; annotated?: boolean; description?: string } = {}) => ({
    name: `mcp__claude_ai_Slack__${t}`, tool: t, readOnly: o.readOnly ?? false, annotated: o.annotated ?? false, ...(o.description ? { description: o.description } : {}),
  });
  const [slack, local] = mcpServices([
    {
      server: 'claude.ai Slack', name: 'mcp__claude_ai_Slack', status: 'connected', scope: 'claudeai',
      tools: [
        tool('slack_read_user_profile'),
        tool('slack_send_message'),
        tool('slack_read_thread', { readOnly: true, annotated: true }),
        tool('slack_search_public', { readOnly: true, annotated: true, description: 'Search messages in public channels' }),
        // сервер разметил: не только чтение — прячем, хоть имя и безобидное
        tool('slack_schedule_message_later', { readOnly: false, annotated: true }),
      ],
    },
    { server: 'jira', name: 'mcp__jira', status: 'connected', scope: 'user', tools: [{ name: 'mcp__jira__list_issues', tool: 'list_issues', readOnly: false, annotated: false }] },
  ]);
  assert.equal(slack.title, 'Slack');
  assert.equal(slack.origin, 'claudeai');
  assert.deepEqual(slack.tools.map((x) => x.tool), ['slack_search_public', 'slack_read_thread', 'slack_read_user_profile']);
  assert.equal(slack.tools[0].description, 'Search messages in public channels');
  assert.equal(slack.hidden, 2);
  assert.deepEqual([local.title, local.origin, local.tools.map((x) => x.name)], ['jira', 'claude-code', ['mcp__jira__list_issues']]);
});

test('connector: поле выбирается из списка, а не вводится', () => {
  const f = connectorKind().setup.find((x) => x.key === 'tool')!;
  assert.equal(f.pick, 'mcp-tool');
  assert.match(f.hint!, /MCP/);
});
