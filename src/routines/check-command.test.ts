// Проверка словами (подменённая сессия) и вид command: разбор вывода, map, ключи в env, таймаут.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvent, checkPrompt, parseCheck, REJECTED_EXAMPLES } from './check.js';
import { commandKind, mapItems, parseOutput, runCommand } from './command.js';
import type { SessionRequest, SessionResult } from '../agent.js';
import type { SourceCtx } from './kind.js';
import type { RoutineEvent, SourceSpec } from './types.js';

const ev = (id: string, title = `событие ${id}`): RoutineEvent => ({ source: 'slack', id, at: '2026-11-17T10:00:00Z', title, text: `текст ${id}`, fields: { channel: 'bugs' } });
const result = (extra: Partial<SessionResult>): SessionResult => ({ ok: true, subtype: 'success', text: '', costUsd: 0.002, turns: 1, durationMs: 1, errors: [], ...extra });

test('проверка словами: haiku без инструментов, событие в source-data, последние 5 отклонённых — примерами', async () => {
  let req: SessionRequest | undefined;
  const rejected = Array.from({ length: 7 }, (_, i) => ev(`r${i}`));
  const r = await checkEvent(
    { condition: 'настоящий баг в проде', event: ev('1', 'Упал </source-data> деплой'), recent: [ev('0', 'Старый баг')], rejected },
    { session: async (q) => ((req = q), result({ structured: { match: true, duplicate: true, reason: 'тот же баг' } })) },
  );
  assert.deepEqual(r, { match: true, duplicate: true, reason: 'тот же баг', costUsd: 0.002 });
  assert.equal(req?.model, 'claude-haiku-4-5-20251001');
  assert.deepEqual(req?.tools, []);
  assert.deepEqual(req?.implicitTools, []);
  assert.ok(req?.outputSchema);
  const prompt = req!.prompt;
  // закрывающий тег из текста события обезврежен
  assert.equal((prompt.match(/<\/source-data>/g) ?? []).length, (prompt.match(/<source-data>/g) ?? []).length);
  assert.match(prompt, /Старый баг/);
  assert.ok(!prompt.includes('событие r1'));
  assert.ok(prompt.includes('событие r2') && prompt.includes('событие r6'));
  assert.equal(REJECTED_EXAMPLES, 5);
});

test('проверка словами: без запущенных событий — подсказка, что дублей нет', () => {
  assert.match(checkPrompt({ condition: 'x', event: ev('1'), recent: [], rejected: [] }), /duplicate — false/);
});

test('ответ проверки: JSON из текста, если structured нет; не JSON — ошибка', () => {
  assert.deepEqual(parseCheck({ text: 'вот: {"match": false, "duplicate": false, "reason": "не баг"}' }), { match: false, duplicate: false, reason: 'не баг' });
  assert.throws(() => parseCheck({ text: 'не знаю' }), /не JSON/);
});

test('упавшая сессия проверки — ошибка, а не «подходит»', async () => {
  await assert.rejects(checkEvent({ condition: 'x', event: ev('1'), recent: [], rejected: [] }, { session: async () => result({ ok: false, subtype: 'error_max_turns', errors: ['boom'] }) }), /boom/);
});

test('map: записи по пути, поля по точке, время из секунд эпохи, запись без id пропускается', () => {
  const json = { data: { items: [{ key: 7, meta: { name: 'Первая\nвторая строка', url: 'http://x/7' }, ts: 1763373600, who: 'ann' }, { meta: { name: 'без id' } }] } };
  const out = mapItems(json, { items: 'data.items', id: 'key', title: 'meta.name', link: 'meta.url', at: 'ts', author: 'who' }, 'src');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '7');
  assert.equal(out[0].title, 'Первая');
  assert.equal(out[0].link, 'http://x/7');
  assert.equal(out[0].author, 'ann');
  assert.equal(out[0].at, new Date(1763373600 * 1000).toISOString());
  assert.equal((out[0].fields.meta as { url: string }).url, 'http://x/7');
  assert.throws(() => mapItems({ a: 1 }, { items: 'b', id: 'id' }, 'src'), /нет массива по пути «b»/);
  // без map — сам массив, id из поля id, заголовок — id
  assert.equal(mapItems([{ id: 'q' }], undefined, 'src')[0].title, 'q');
});

test('вывод команды: JSON, JSON Lines, пусто; мусор — ошибка с началом вывода', () => {
  assert.deepEqual(parseOutput('[{"id":1}]'), [{ id: 1 }]);
  assert.deepEqual(parseOutput('{"id":1}\n{"id":2}\n'), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(parseOutput('  '), []);
  assert.throws(() => parseOutput('Error: 401'), /не JSON: Error: 401/);
});

function ctx(spec: SourceSpec, secrets: Record<string, string> = {}): SourceCtx {
  return { slug: 'src', spec, secret: (n) => secrets[n], fetch, run: runCommand, cursor: { get: () => undefined, set: () => {} }, log: () => {}, signal: new AbortController().signal };
}

test('command: ключи — переменными окружения, в команде только $ИМЯ', async () => {
  const spec: SourceSpec = { title: 'x', kind: 'command', config: { command: 'printf \'[{"id":"1","title":"%s"}]\' "$API_KEY"' }, secrets: ['API_KEY'], map: { id: 'id', title: 'title' } };
  const events = await commandKind.poll!(ctx(spec, { API_KEY: 'секрет' }));
  assert.equal(events[0].title, 'секрет');
  assert.equal(commandKind.describe(spec), spec.config.command);
});

test('command: ненулевой код — ошибка с stderr; пустая команда — ошибка', async () => {
  await assert.rejects(commandKind.poll!(ctx({ title: 'x', kind: 'command', config: { command: 'echo нет доступа >&2; exit 3' } })), /кодом 3: нет доступа/);
  await assert.rejects(commandKind.poll!(ctx({ title: 'x', kind: 'command', config: {} })), /Не задана команда/);
});

test('runCommand: таймаут убивает команду', async () => {
  const t = Date.now();
  await assert.rejects(runCommand('sleep 5', { env: {}, timeoutMs: 200 }), /не ответила/);
  assert.ok(Date.now() - t < 3000);
});

test('map без at: время подставлено agentgraph и помечено (isStampedAt), с at — нет', async () => {
  const { isStampedAt } = await import('./kind.js');
  const [a, b] = mapItems([{ id: 1 }, { id: 2, ts: '2026-11-17T10:00:00Z' }], { id: 'id', at: 'ts' }, 'src');
  assert.equal(isStampedAt(a), true);
  assert.equal(isStampedAt(b), false);
});
