// Модель и effort этапа: приоритет, события phase_start / phase_model и поля отчёта в run.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phaseModel, runFlow, type PhaseReport, type RunEvent } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec, Phase } from './schema.js';

const base: SessionResult = { ok: true, subtype: 'success', text: 'ok', costUsd: 0, turns: 1, durationMs: 1, errors: [] };
const flow = (over: Record<string, unknown> = {}, phases: Array<Record<string, unknown>> = [{ name: 'a', tools: [], prompt: 'p' }]) =>
  ({ name: 'one', input: 'x', phases, ...over }) as unknown as FlowSpec;

/** Запуск с заглушкой сессии: возвращает события и этапы из run.json. */
async function run(spec: FlowSpec, session: (req: SessionRequest) => Promise<SessionResult>, extra: { model?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-model-'));
  try {
    const events: RunEvent[] = [];
    const r = await runFlow(spec, { cwd: dir, runsDir: dir, session, onEvent: (e) => events.push(e), ...extra });
    const phases = JSON.parse(fs.readFileSync(path.join(r.runDir, 'run.json'), 'utf8')).phases as PhaseReport[];
    return { events, phases };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('phaseModel: модель — этап, defaults, opts.model; effort — этап, defaults', () => {
  const spec = (d: Record<string, unknown>) => ({ name: 'x', input: 'x', defaults: d, phases: [] }) as unknown as FlowSpec;
  const ph = (extra: Record<string, unknown>) => ({ name: 'a', tools: [], prompt: 'p', ...extra }) as unknown as Phase;
  assert.deepEqual(phaseModel(spec({ model: 'd', effort: 'low' }), ph({ model: 'p', effort: 'high' }), { model: 'o' }), { model: 'p', effort: 'high' });
  assert.deepEqual(phaseModel(spec({ model: 'd', effort: 'low' }), ph({}), { model: 'o' }), { model: 'd', effort: 'low' });
  assert.deepEqual(phaseModel(spec({}), ph({}), { model: 'o' }), { model: 'o', effort: undefined });
  assert.deepEqual(phaseModel(spec({}), ph({}), {}), { model: undefined, effort: undefined });
});

test('фактическая модель из init: phase_start несёт заданные, один phase_model до phase_end, в run.json фактическая', async () => {
  const { events, phases } = await run(
    flow({ defaults: { model: 'm-def', effort: 'high' } }),
    async (req) => {
      req.onModel?.('actual-id');
      return { ...base, model: 'actual-id' };
    },
  );
  const start = events.find((e) => e.type === 'phase_start');
  assert.ok(start && start.type === 'phase_start');
  assert.equal(start.model, 'm-def');
  assert.equal(start.effort, 'high');
  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'phase_model').length, 1);
  assert.ok(types.indexOf('phase_model') > types.indexOf('phase_start') && types.indexOf('phase_model') < types.indexOf('phase_end'));
  const pm = events.find((e) => e.type === 'phase_model');
  assert.deepEqual(pm && pm.type === 'phase_model' && [pm.block, pm.phase, pm.iteration, pm.model], ['main', 'a', 1, 'actual-id']);
  assert.equal(phases[0].model, 'actual-id');
  assert.equal(phases[0].effort, 'high');
});

test('ничего не задано и init не пришёл: ключей model/effort нет ни в отчёте, ни в phase_start, phase_model нет', async () => {
  const { events, phases } = await run(flow(), async () => base);
  assert.equal('model' in phases[0] || 'effort' in phases[0], false);
  assert.equal(events.some((e) => e.type === 'phase_model'), false);
  const start = events.find((e) => e.type === 'phase_start');
  assert.ok(start);
  assert.equal('model' in start || 'effort' in start, false);
});

test('сессия упала до init: в отчёте заданная модель', async () => {
  const { phases } = await run(flow({}, [{ name: 'a', tools: [], prompt: 'p', model: 'm-req' }]), async () => ({ ...base, ok: false, subtype: 'no_result' }));
  assert.equal(phases[0].model, 'm-req');
  assert.equal('effort' in phases[0], false);
});

test('модель запуска (--model, поле формы) при незаданных этапе и defaults попадает в отчёт', async () => {
  const { phases } = await run(flow(), async () => base, { model: 'm-form' });
  assert.equal(phases[0].model, 'm-form');
});

test('параллельная группа: у каждого участника своя модель и своё phase_model', async () => {
  const spec = flow({}, [
    { name: 'x', tools: [], prompt: 'PHASE:x', group: 'g', model: 'm-x' },
    { name: 'y', tools: [], prompt: 'PHASE:y', group: 'g', model: 'm-y', effort: 'low' },
  ]);
  const { events, phases } = await run(spec, async (req) => {
    const actual = req.prompt.includes('PHASE:x') ? 'actual-x' : 'actual-y';
    req.onModel?.(actual);
    return { ...base, model: actual };
  });
  const models = Object.fromEntries(events.flatMap((e) => (e.type === 'phase_model' ? [[e.phase, e.model]] : [])));
  assert.deepEqual(models, { x: 'actual-x', y: 'actual-y' });
  const byName = Object.fromEntries(phases.map((p) => [p.phase, p]));
  assert.deepEqual([byName.x.model, byName.x.effort], ['actual-x', undefined]);
  assert.deepEqual([byName.y.model, byName.y.effort], ['actual-y', 'low']);
});
