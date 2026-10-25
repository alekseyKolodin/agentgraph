import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFlow, type RunEvent, type RunOptions } from './runner.js';
import type { RunTitleReport } from './run-title.js';
import type { SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';

const spec = { name: 'one', input: 'Сделай экспорт', phases: [{ name: 'a', tools: [], prompt: 'p' }] } as unknown as FlowSpec;
const ok = (costUsd = 0.5): SessionResult => ({ ok: true, subtype: 'success', text: 'ok', costUsd, turns: 1, durationMs: 1, errors: [] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));

/** Запуск во временной папке с заглушкой этапов; events — все события. */
async function run(opts: Partial<RunOptions> = {}, session: RunOptions['session'] = async () => ok()) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-title-'));
  const events: RunEvent[] = [];
  try {
    const report = await runFlow(spec, { cwd: runsDir, runsDir, session, onEvent: (e) => events.push(e), ...opts });
    return { report, events, saved: read(report.runDir) };
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
}

const titles = (events: RunEvent[]) => events.filter((e) => e.type === 'title');
const endReport = (events: RunEvent[]) => (events.find((e) => e.type === 'end') as Extract<RunEvent, { type: 'end' }>).report;

test('имя запуска: без nameRun в run.json нет ключей title и titleSession, события title нет', async () => {
  const { saved, events } = await run();
  assert.equal('title' in saved, false);
  assert.equal('titleSession' in saved, false);
  assert.equal(titles(events).length, 0);
});

test('имя запуска: nameRun быстро вернул имя — оно в run.json и в end, событие title одно, стоимость в итоге', async () => {
  const calls: string[] = [];
  const nameRun = async (input: string): Promise<RunTitleReport> => {
    calls.push(input);
    return { title: 'Экспорт CSV', costUsd: 0.01 };
  };
  const { saved, events } = await run({ nameRun });
  assert.deepEqual(calls, ['Сделай экспорт']);
  assert.equal(saved.title, 'Экспорт CSV');
  assert.deepEqual(saved.titleSession, { costUsd: 0.01 });
  assert.equal(saved.totalCostUsd, 0.51);
  assert.equal(endReport(events).title, 'Экспорт CSV');
  // подбор быстрее этапа: в событии итог на тот момент — только стоимость подбора
  assert.deepEqual(titles(events), [{ type: 'title', title: 'Экспорт CSV', totalCostUsd: 0.01 }]);
  // событие title — после start
  assert.ok(events.findIndex((e) => e.type === 'title') > events.findIndex((e) => e.type === 'start'));
});

test('имя запуска: nameRun вернул ошибку — запуск done, имени нет, ошибка в titleSession', async () => {
  const { saved, events } = await run({ nameRun: async () => ({ error: 'модель не вернула имя', costUsd: 0.002 }) });
  assert.equal(saved.status, 'done');
  assert.equal('title' in saved, false);
  assert.deepEqual(saved.titleSession, { costUsd: 0.002, error: 'модель не вернула имя' });
  assert.deepEqual(titles(events), [{ type: 'title', error: 'модель не вернула имя', totalCostUsd: 0.002 }]);
  assert.equal(saved.totalCostUsd, 0.502);
});

test('имя запуска: nameRun бросил — запуск не падает, ошибка в titleSession', async () => {
  const { saved } = await run({ nameRun: () => { throw new Error('бум'); } });
  assert.equal(saved.status, 'done');
  assert.equal(saved.titleSession.error, 'бум');
});

test('имя запуска: nameRun медленнее этапов — end ждёт его, имя в итоговом run.json', async () => {
  const nameRun = async (): Promise<RunTitleReport> => {
    await sleep(80);
    return { title: 'Медленное имя', costUsd: 0 };
  };
  const { saved, events } = await run({ nameRun });
  assert.equal(saved.title, 'Медленное имя');
  assert.equal(endReport(events).title, 'Медленное имя');
  assert.ok(events.findIndex((e) => e.type === 'title') < events.findIndex((e) => e.type === 'end'));
});

test('имя запуска: остановка во время подбора — signal nameRun прерван, запуск aborted и не висит', async () => {
  const abort = new AbortController();
  let signalAborted = false;
  // подбор отвечает только по своему signal
  const nameRun = (_input: string, signal: AbortSignal) =>
    new Promise<RunTitleReport>((resolve) => {
      signal.addEventListener('abort', () => {
        signalAborted = true;
        resolve({ error: 'запуск остановлен', costUsd: 0 });
      });
    });
  const session = async () => {
    abort.abort();
    return ok();
  };
  const { saved } = await run({ nameRun, abort }, session);
  assert.ok(signalAborted);
  assert.equal(saved.status, 'aborted');
  assert.equal('title' in saved, false);
});

test('имя запуска: готовое title (продолжение) — в отчёте сразу, nameRun не вызывается', async () => {
  let called = false;
  const nameRun = async (): Promise<RunTitleReport> => {
    called = true;
    return { title: 'Другое', costUsd: 1 };
  };
  const { saved, events } = await run({ title: 'Исходное имя', nameRun });
  assert.equal(called, false);
  assert.equal(saved.title, 'Исходное имя');
  assert.equal('titleSession' in saved, false);
  assert.equal((events[0] as Extract<RunEvent, { type: 'start' }>).report.title, 'Исходное имя');
  assert.equal(titles(events).length, 0);
});

test('имя запуска: этап бросил исключение, пока подбор думает — запуск failed, имя всё равно попадает в end', async () => {
  const nameRun = async (): Promise<RunTitleReport> => {
    await sleep(40);
    return { title: 'Имя', costUsd: 0 };
  };
  const { saved, events } = await run({ nameRun }, async () => { throw new Error('сессия упала'); });
  assert.equal(saved.status, 'failed');
  assert.equal(saved.title, 'Имя');
  assert.equal(endReport(events).title, 'Имя');
});

test('имя запуска: runFlow вышел исключением раньше подбора — поздний ответ не пишет run.json и не шлёт title', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-title-'));
  const events: RunEvent[] = [];
  let resolveName!: (r: RunTitleReport) => void;
  let nameSignal!: AbortSignal;
  const nameRun = (_input: string, signal: AbortSignal) => {
    nameSignal = signal;
    return new Promise<RunTitleReport>((resolve) => { resolveName = resolve; });
  };
  // подписчик бросает на block_end после упавшего этапа: так runFlow выходит исключением
  const onEvent = (e: RunEvent) => {
    events.push(e);
    if (e.type === 'block_end') throw new Error('подписчик упал');
  };
  try {
    let runDir = '';
    const session = async () => { throw new Error('сессия упала'); };
    await assert.rejects(
      runFlow(spec, { cwd: runsDir, runsDir, session, nameRun, onEvent: (e) => { if (e.type === 'start') runDir = e.report.runDir; onEvent(e); } }),
      /подписчик упал/,
    );
    assert.ok(nameSignal.aborted);
    const before = fs.readFileSync(path.join(runDir, 'run.json'), 'utf8');
    resolveName({ title: 'Поздно', costUsd: 1 });
    await sleep(10);
    assert.equal(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'), before);
    assert.equal(titles(events).length, 0);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
