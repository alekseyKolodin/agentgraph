// Опция раннера pauseBefore (рутины, src/routines): перед первой итерацией указанного блока запуск встаёт на паузу
// с pauseReason (before: true), продолжение снимает её как обычную паузу; без requestPause (CLI) опция не действует.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFlow, type RunControl, type RunEvent, type RunReport } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';

const phase = (name: string) => ({ name, tools: [], prompt: `PHASE:${name}` });
const result = (text: string): SessionResult => ({ ok: true, subtype: 'success', text, costUsd: 0.01, turns: 1, durationMs: 1, errors: [] });

const spec: FlowSpec = {
  name: 'demo',
  input: 'задача',
  blocks: [
    { name: 'analyze', phases: [phase('look')] },
    { name: 'fix', phases: [phase('patch'), phase('test')] },
  ],
} as FlowSpec;

async function run(o: { pauseBefore?: string[]; withPause?: boolean }) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-pb-'));
  const order: string[] = [];
  const events: RunEvent[] = [];
  let reportAtPause: RunReport | undefined;
  let saved: RunReport | undefined;
  let requested = 0;
  let paused = false;
  const control: RunControl = {
    checkpoint: async () => {
      if (!paused) return;
      paused = false;
      order.push('#paused');
      saved = JSON.parse(fs.readFileSync(path.join(reportAtPause!.runDir, 'run.json'), 'utf8')) as RunReport;
    },
    ...(o.withPause === false
      ? {}
      : {
          requestPause: () => {
            requested++;
            paused = true;
          },
        }),
  };
  const session = async (req: SessionRequest): Promise<SessionResult> => {
    order.push(req.prompt.split('\n')[0].slice('PHASE:'.length));
    return result('ok');
  };
  try {
    const report = await runFlow(spec, {
      cwd: runsDir,
      runsDir,
      session,
      control,
      pauseBefore: o.pauseBefore,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'start') reportAtPause = e.report;
      },
    });
    return { report, order, requested, saved, events };
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
}

test('pauseBefore: пауза перед первой итерацией блока, причина в run.json, после продолжения блок идёт', async () => {
  const r = await run({ pauseBefore: ['fix'] });
  assert.equal(r.report.status, 'done');
  assert.equal(r.requested, 1);
  assert.deepEqual(r.order, ['look', '#paused', 'patch', 'test']);
  // на паузе в run.json — причина «перед блоком», без вывода этапа
  assert.equal(r.saved?.pauseReason?.block, 'fix');
  assert.equal(r.saved?.pauseReason?.before, true);
  assert.equal(r.saved?.pauseReason?.phase, 'patch');
  assert.equal(r.saved?.pauseReason?.iteration, 1);
  assert.match(r.saved?.pauseReason?.text ?? '', /fix/);
  // после продолжения причины нет, а в истории пауз — с временем продолжения
  assert.equal(r.report.pauseReason, undefined);
  assert.equal(r.report.pauses?.length, 1);
  assert.ok(r.report.pauses?.[0].resumedAt);
});

test('pauseBefore: первый блок тоже ждёт до первого этапа', async () => {
  const r = await run({ pauseBefore: ['analyze'] });
  assert.deepEqual(r.order, ['#paused', 'look', 'patch', 'test']);
});

test('pauseBefore без блоков из flow и без опции пауз не ставит', async () => {
  assert.equal((await run({ pauseBefore: ['nope'] })).requested, 0);
  assert.equal((await run({})).requested, 0);
});

test('pauseBefore без requestPause (CLI) не действует: запуск идёт до конца', async () => {
  const r = await run({ pauseBefore: ['fix'], withPause: false });
  assert.equal(r.report.status, 'done');
  assert.deepEqual(r.order, ['look', 'patch', 'test']);
  assert.equal(r.report.pauses, undefined);
});
