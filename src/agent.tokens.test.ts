// Токены сессии этапа: счётчик по потоку сообщений SDK и поле tokens в run.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { contextSnapshot, newTally, resetWindowCache, runSession, tallyTokens, type ContextSnapshot, type SessionDeps, type SessionResult } from './agent.js';
import { runFlow } from './runner.js';
import type { FlowSpec } from './schema.js';

const assistant = (id: string, input: number, cacheRead: number, cacheCreation: number, parent: string | null = null) =>
  ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id, usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation, output_tokens: 1 } },
  }) as unknown as SDKMessage;

const model = (input: number, output: number, cacheRead: number, cacheCreation: number) => ({
  inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation, webSearchRequests: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0,
});

test('токены: контекст первого и самого большого запроса главного цикла, без повторов и сабагентов', () => {
  const t = newTally();
  assert.equal(tallyTokens(t, assistant('m1', 2, 0, 35000)), true);
  // тот же запрос, следующий блок стрима — не второй запрос
  assert.equal(tallyTokens(t, assistant('m1', 2, 0, 35000)), false);
  tallyTokens(t, assistant('m2', 1, 35000, 4000));
  // сабагент: в контекст этапа не входит
  assert.equal(tallyTokens(t, assistant('s1', 1, 900000, 0, 'toolu_1')), false);
  tallyTokens(t, assistant('m3', 1, 30000, 100));
  assert.deepEqual(
    { start: t.tokens.contextStart, peak: t.tokens.contextPeak, requests: t.tokens.requests },
    { start: 35002, peak: 39001, requests: 3 },
  );
  // обрыв без результата: контекст есть, итогов нет — нулевые суммы занизили бы итог по запуску
  assert.equal('input' in t.tokens || 'output' in t.tokens, false);
});

test('токены: итог по всем моделям сессии из modelUsage, без него — из usage главного цикла', () => {
  const t = newTally();
  const result = { type: 'result', subtype: 'success', modelUsage: { opus: model(10, 200, 5000, 300), haiku: model(1, 20, 100, 0) }, usage: { input_tokens: 999 } } as unknown as SDKMessage;
  assert.equal(tallyTokens(t, result), true);
  assert.deepEqual([t.tokens.input, t.tokens.output, t.tokens.cacheRead, t.tokens.cacheCreation], [11, 220, 5100, 300]);
  const u = newTally();
  tallyTokens(u, { type: 'result', subtype: 'success', usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } } as unknown as SDKMessage);
  assert.deepEqual([u.tokens.input, u.tokens.output, u.tokens.cacheRead, u.tokens.cacheCreation], [3, 4, 5, 6]);
  assert.equal(tallyTokens(newTally(), { type: 'system', subtype: 'init' } as unknown as SDKMessage), false);
});

test('токены сессии попадают в отчёт этапа в run.json; без них поля нет', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-tokens-'));
  try {
    const spec = { name: 'one', input: 'x', phases: [{ name: 'a', tools: [], prompt: 'p' }] } as unknown as FlowSpec;
    const tokens = { contextStart: 35000, contextPeak: 90000, requests: 7, input: 20, output: 3000, cacheRead: 400000, cacheCreation: 50000 };
    const base: SessionResult = { ok: true, subtype: 'success', text: 'ok', costUsd: 0, turns: 1, durationMs: 1, errors: [] };
    const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    const withTokens = await runFlow(spec, { cwd: runsDir, runsDir, session: async () => ({ ...base, tokens }) });
    assert.deepEqual(read(withTokens.runDir).phases[0].tokens, tokens);
    const without = await runFlow(spec, { cwd: runsDir, runsDir, session: async () => base });
    assert.equal('tokens' in read(without.runDir).phases[0], false);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

// --- окно контекста ---

const init = (modelId: string) => ({ type: 'system', subtype: 'init', model: modelId }) as unknown as SDKMessage;
const entry = (contextWindow: number, extra: Record<string, unknown> = {}) => ({ ...model(1, 1, 0, 0), contextWindow, ...extra });
const resultOf = (modelUsage: Record<string, unknown>) =>
  ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, session_id: 's', modelUsage }) as unknown as SDKMessage;
/** Счётчик после init и result с таким modelUsage: окно, которое он записал. */
const windowOf = (initId: string | undefined, usage: Record<string, unknown>) => {
  const t = newTally();
  if (initId) tallyTokens(t, init(initId));
  tallyTokens(t, resultOf(usage));
  return t.tokens.contextWindow;
};

test.beforeEach(() => resetWindowCache());

test('окно: точный ключ главной модели, canonicalModel, единственная запись; иначе окна нет', () => {
  // точный ключ: сабагентская haiku-запись окно не подменяет
  assert.equal(windowOf('opus', { haiku: entry(200000), opus: entry(1000000) }), 1000000);
  // ключ — алиас, главная модель опознана по canonicalModel
  assert.equal(windowOf('claude-opus-5', { 'opus[1m]': entry(1000000, { canonicalModel: 'claude-opus-5' }), haiku: entry(200000, { canonicalModel: 'claude-haiku-4-5' }) }), 1000000);
  // единственная запись, ключ не совпал с init
  assert.equal(windowOf('opus', { 'other-id': entry(200000) }), 200000);
  assert.equal(windowOf(undefined, { opus: entry(1000000) }), 1000000);
  // две записи без совпадения: угадывать по сабагентам нельзя
  assert.equal(windowOf('opus', { a: entry(200000), b: entry(1000000) }), undefined);
  assert.equal(windowOf(undefined, { a: entry(200000), b: entry(1000000) }), undefined);
  // SDK прислал 0 (фикстуры, старые версии) — окна нет, а ключа в tokens тоже нет
  const t = newTally();
  tallyTokens(t, init('opus'));
  tallyTokens(t, resultOf({ opus: entry(0) }));
  assert.equal('contextWindow' in t.tokens, false);
  // итоги по токенам при этом считаются как раньше
  assert.equal(t.tokens.input, 1);
});

test('init: задаёт модель счётчика и не считается запросом', () => {
  const t = newTally();
  assert.equal(tallyTokens(t, init('opus')), false);
  assert.equal(t.model, 'opus');
  assert.equal(t.tokens.requests, 0);
  // повторный init (резюме) модель не меняет
  tallyTokens(t, init('haiku'));
  assert.equal(t.model, 'opus');
});

test('кэш окна: берётся по модели из init; чужая модель его не получает; resetWindowCache чистит', () => {
  const first = newTally();
  tallyTokens(first, init('opus'));
  tallyTokens(first, assistant('m1', 1, 0, 1000));
  assert.deepEqual(contextSnapshot(first), { contextPeak: 1001, requests: 1 });
  tallyTokens(first, resultOf({ opus: entry(1000000) }));
  // окно из своего результата
  assert.equal(contextSnapshot(first).contextWindow, 1000000);

  const second = newTally();
  tallyTokens(second, init('opus'));
  tallyTokens(second, assistant('m1', 1, 0, 1000));
  assert.equal(contextSnapshot(second).contextWindow, 1000000);

  const other = newTally();
  tallyTokens(other, init('haiku'));
  tallyTokens(other, assistant('m1', 1, 0, 1000));
  assert.equal('contextWindow' in contextSnapshot(other), false);

  resetWindowCache();
  assert.equal('contextWindow' in contextSnapshot(second), false);
});

// --- runSession с поддельным потоком ---

type Fake = SessionDeps['query'];
const stream = (msgs: SDKMessage[], getContextUsage?: () => Promise<unknown>): Fake => () => {
  const it = (async function* () { yield* msgs; })();
  return Object.assign(it, getContextUsage ? { getContextUsage } : {}) as unknown as ReturnType<Fake>;
};
const base: Omit<Parameters<typeof runSession>[0], 'onContext'> = { prompt: 'p', cwd: os.tmpdir() };
const collect = async (msgs: SDKMessage[], getContextUsage?: () => Promise<unknown>) => {
  const snaps: ContextSnapshot[] = [];
  const res = await runSession({ ...base, onContext: (c) => snaps.push(c) }, () => {}, { query: stream(msgs, getContextUsage) });
  return { snaps, res };
};

test('onContext: снимок на каждый новый запрос главного цикла, не на повтор стрима и не на сабагента', async () => {
  const { snaps, res } = await collect([
    init('opus'),
    assistant('m1', 2, 0, 35000),
    assistant('m1', 2, 0, 35000),
    assistant('s1', 1, 900000, 0, 'toolu_1'),
    assistant('m2', 1, 35000, 4000),
    assistant('m3', 1, 30000, 100),
    resultOf({ opus: entry(1000000) }),
  ]);
  assert.deepEqual(snaps, [
    { contextPeak: 35002, requests: 1 },
    { contextPeak: 39001, requests: 2 },
    { contextPeak: 39001, requests: 3 },
  ]);
  assert.equal(res.tokens?.contextWindow, 1000000);
});

test('onContext: окно из кэша есть с первого запроса второй сессии той же модели', async () => {
  const msgs = [init('opus'), assistant('m1', 1, 0, 1000), resultOf({ opus: entry(1000000) })];
  const first = await collect(msgs);
  assert.equal('contextWindow' in first.snaps[0], false);
  const second = await collect(msgs);
  assert.equal(second.snaps[0].contextWindow, 1000000);
  // без onContext сессия работает как раньше
  const quiet = await runSession(base, () => {}, { query: stream(msgs) });
  assert.equal(quiet.tokens?.contextWindow, 1000000);
});

test('getContextUsage после init даёт окно идущей сессии без кэша; ошибка и мусор сессию не роняют', async () => {
  const msgs = [init('opus'), assistant('m1', 1, 0, 1000), resultOf({ opus: entry(1000000) })];
  const ok = await collect(msgs, async () => ({ rawMaxTokens: 1000000, maxTokens: 200000 }));
  assert.ok(ok.snaps.some((c) => c.contextWindow === 1000000));
  // в итог окно из getContextUsage не попадает: там только modelUsage
  const noResult = await collect([init('opus'), assistant('m1', 1, 0, 1000)], async () => ({ rawMaxTokens: 500000 }));
  assert.equal(noResult.res.tokens && 'contextWindow' in noResult.res.tokens, false);
  resetWindowCache();
  const failing = await collect(msgs, async () => { throw new Error('нет связи'); });
  assert.equal(failing.res.ok, true);
  assert.equal(failing.snaps.some((c) => 'contextWindow' in c), false);
  resetWindowCache();
  const zero = await collect(msgs, async () => ({ rawMaxTokens: 0 }));
  assert.equal(zero.snaps.some((c) => 'contextWindow' in c), false);
});
