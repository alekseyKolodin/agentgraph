// Контекст этапа: событие phase_context по ходу сессии и окно модели в отчёте этапа (run.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFlow, type PhaseReport, type RunEvent } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';

const base: SessionResult = { ok: true, subtype: 'success', text: 'ok', costUsd: 0, turns: 1, durationMs: 1, errors: [] };
const flow = (phases: Array<Record<string, unknown>> = [{ name: 'a', tools: [], prompt: 'p' }]) =>
  ({ name: 'one', input: 'x', phases }) as unknown as FlowSpec;

/** Запуск с заглушкой сессии: события и этапы из run.json. */
async function run(spec: FlowSpec, session: (req: SessionRequest) => Promise<SessionResult>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-context-'));
  try {
    const events: RunEvent[] = [];
    const r = await runFlow(spec, { cwd: dir, runsDir: dir, session, onEvent: (e) => events.push(e) });
    const phases = JSON.parse(fs.readFileSync(path.join(r.runDir, 'run.json'), 'utf8')).phases as PhaseReport[];
    return { events, phases };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const contexts = (events: RunEvent[]) => events.filter((e) => e.type === 'phase_context');

test('onContext сессии становится phase_context между phase_start и phase_end, с блоком, итерацией и этапом', async () => {
  const { events } = await run(flow(), async (req) => {
    req.onContext?.({ contextPeak: 35000, requests: 1 });
    req.onContext?.({ contextPeak: 90000, requests: 2, contextWindow: 1000000 });
    return base;
  });
  const types = events.map((e) => e.type);
  const first = types.indexOf('phase_context');
  assert.ok(first > types.indexOf('phase_start') && types.lastIndexOf('phase_context') < types.indexOf('phase_end'));
  assert.deepEqual(contexts(events).map((e) => e.type === 'phase_context' && [e.block, e.iteration, e.phase, e.contextPeak, e.requests, e.contextWindow]), [
    ['main', 1, 'a', 35000, 1, undefined],
    ['main', 1, 'a', 90000, 2, 1000000],
  ]);
  // без окна ключа в событии нет
  assert.equal('contextWindow' in contexts(events)[0], false);
});

test('сессия не звала onContext — события нет', async () => {
  const { events } = await run(flow(), async () => base);
  assert.equal(contexts(events).length, 0);
});

test('параллельная группа: у каждого участника свои события', async () => {
  const spec = flow([
    { name: 'x', tools: [], prompt: 'PHASE:x', group: 'g' },
    { name: 'y', tools: [], prompt: 'PHASE:y', group: 'g' },
  ]);
  const { events } = await run(spec, async (req) => {
    const peak = req.prompt.includes('PHASE:x') ? 1000 : 2000;
    req.onContext?.({ contextPeak: peak, requests: 1 });
    return base;
  });
  const byPhase = Object.fromEntries(contexts(events).map((e) => (e.type === 'phase_context' ? [e.phase, e.contextPeak] : [])));
  assert.deepEqual(byPhase, { x: 1000, y: 2000 });
});

test('окно модели из результата сессии попадает в phase_end и run.json; без окна ключа нет', async () => {
  const tokens = { contextStart: 35000, contextPeak: 90000, requests: 7 };
  const withWindow = await run(flow(), async () => ({ ...base, tokens: { ...tokens, contextWindow: 1000000 } }));
  const end = withWindow.events.find((e) => e.type === 'phase_end');
  assert.equal(end?.type === 'phase_end' && end.report.tokens?.contextWindow, 1000000);
  assert.equal(withWindow.phases[0].tokens?.contextWindow, 1000000);
  const without = await run(flow(), async () => ({ ...base, tokens }));
  assert.equal(without.phases[0].tokens && 'contextWindow' in without.phases[0].tokens, false);
});
