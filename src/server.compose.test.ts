import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';

// общий ~/.agentgraph не трогаем: сервер читает настройки при импорте модулей
process.env.AGENTGRAPH_CONFIG_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-config-'));
const { liveControl } = await import('./server.js');
const { makeRunDir, runFlow } = await import('./runner.js');

const phase = (name: string) => ({ name, tools: [], prompt: `PHASE:${name} {{input}}` });
const nameOf = (req: SessionRequest) => req.prompt.split('\n')[0].split(' ')[0].slice('PHASE:'.length);
const result = (text: string): SessionResult => ({ ok: true, subtype: 'success', text, costUsd: 0.01, turns: 1, durationMs: 1, errors: [] });

const parentSpec = { name: 'parent', input: 'задача', blocks: [{ name: 'review', flow: 'child', input: '{{input}}' }, { name: 'ship', phases: [phase('s')] }] } as unknown as FlowSpec;
const childSpec = { name: 'child', phases: [phase('c'), phase('d')] } as unknown as FlowSpec;

/** Ждёт условие, проверяя его между тиками раннера. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), `не дождались: ${what}`);
}

/**
 * Родитель с блоком-вызовом как живой запуск сервера, с поддельной сессией: этап c дочернего ждёт, пока тест его не
 * отпустит (release) — в это время дочерний идёт, а родитель стоит в блоке-вызове.
 */
function launch(spec: FlowSpec = parentSpec, flows: Record<string, FlowSpec> = { child: childSpec }, output: (name: string, n: number) => string = (n) => `out-${n}`) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-live-'));
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const session = async (req: SessionRequest): Promise<SessionResult> => {
    const name = nameOf(req);
    started.push(name);
    if (name === 'c') await gate;
    return result(output(name, started.filter((x) => x === name).length));
  };
  const deps = {
    // итоги итераций зовут модель: в тесте их нет
    runFlow: (s: FlowSpec, o: Parameters<typeof runFlow>[1]) => runFlow(s, { ...o, digest: undefined, session, loadFlow: (n) => flows[n]! }),
  };
  const { id, done } = liveControl.launch(spec, { cwd: runsDir, runsDir, runDir: makeRunDir(runsDir, 'parent') }, { port: 0, host: '127.0.0.1', defaultCwd: runsDir, notify: false }, undefined, deps);
  const child = () => liveControl.state(id)?.child;
  const cleanup = () => fs.rmSync(runsDir, { recursive: true, force: true });
  return { id, done, started, release, child, runsDir, cleanup };
}

const childReport = (runsDir: string, id: string) => JSON.parse(fs.readFileSync(path.join(runsDir, id, 'run.json'), 'utf8'));

test('пауза родителя во время вызова встаёт на дочернем, продолжение родителя отпускает обоих', async () => {
  const r = launch();
  try {
    await until(() => r.started.includes('c') && Boolean(r.child()), 'дочерний этап c');
    const kid = r.child()!;
    assert.equal(liveControl.pause(r.id), 'requested');
    assert.equal(liveControl.state(kid)?.pause, 'requested');
    r.release();
    // дочерний доиграл шаг и встал в контрольной точке; родитель ждёт его в блоке-вызове
    await until(() => liveControl.state(kid)?.pause === 'paused', 'пауза дочернего');
    assert.equal(liveControl.state(r.id)?.pause, 'requested');
    assert.deepEqual(r.started, ['c']);

    liveControl.resume(r.id);
    const report = await r.done;
    assert.equal(report.status, 'done');
    assert.deepEqual(r.started, ['c', 'd', 's']);
    assert.equal(liveControl.state(kid), undefined);
    assert.equal(childReport(r.runsDir, kid).parent.runId, r.id);
  } finally {
    r.cleanup();
  }
});

test('пауза дочернего родителя не трогает, продолжение дочернего — только его', async () => {
  const r = launch();
  try {
    await until(() => Boolean(r.child()), 'дочерний');
    const kid = r.child()!;
    liveControl.pause(kid);
    assert.equal(liveControl.state(r.id)?.pause, null);
    r.release();
    await until(() => liveControl.state(kid)?.pause === 'paused', 'пауза дочернего');
    liveControl.resume(kid);
    assert.equal((await r.done).status, 'done');
  } finally {
    r.cleanup();
  }
});

test('остановка родителя отпускает дочерний с паузы и останавливает его: оба aborted', async () => {
  const r = launch();
  try {
    await until(() => Boolean(r.child()), 'дочерний');
    const kid = r.child()!;
    liveControl.pause(r.id);
    r.release();
    await until(() => liveControl.state(kid)?.pause === 'paused', 'пауза дочернего');
    liveControl.abort(r.id);
    const report = await r.done;
    assert.equal(report.status, 'aborted');
    assert.equal(childReport(r.runsDir, kid).status, 'aborted');
    assert.deepEqual(r.started, ['c']);
    // живых записей не осталось ни у родителя, ни у дочернего
    assert.equal(liveControl.state(kid), undefined);
    assert.equal(liveControl.state(r.id), undefined);
  } finally {
    r.cleanup();
  }
});

test('остановка дочернего останавливает связку: родитель aborted', async () => {
  const r = launch();
  try {
    await until(() => Boolean(r.child()), 'дочерний');
    liveControl.abort(r.child()!);
    r.release();
    const report = await r.done;
    assert.equal(report.status, 'aborted');
    assert.deepEqual(r.started, ['c']);
  } finally {
    r.cleanup();
  }
});

test('пауза и остановка родителя доходят до внука через дочерний', async () => {
  const mid = { name: 'mid', blocks: [{ name: 'inner', flow: 'child', input: '{{input}}' }] } as unknown as FlowSpec;
  const top = { name: 'top', input: 'задача', blocks: [{ name: 'outer', flow: 'mid', input: '{{input}}' }] } as unknown as FlowSpec;
  const r = launch(top, { mid, child: childSpec });
  try {
    await until(() => r.started.includes('c') && Boolean(r.child() && liveControl.state(r.child()!)?.child), 'внук идёт');
    const kid = r.child()!;
    const grandkid = liveControl.state(kid)!.child!;
    liveControl.pause(r.id);
    assert.equal(liveControl.state(grandkid)?.pause, 'requested');
    r.release();
    await until(() => liveControl.state(grandkid)?.pause === 'paused', 'пауза внука');
    liveControl.abort(r.id);
    assert.equal((await r.done).status, 'aborted');
    assert.equal(childReport(r.runsDir, grandkid).status, 'aborted');
    assert.equal(childReport(r.runsDir, grandkid).parent.runId, kid);
    assert.equal(liveControl.state(grandkid), undefined);
  } finally {
    r.cleanup();
  }
});

test('«Возобновить» родителя не снимает паузу, которую дочерний поставил сам по вопросу этапа', async () => {
  const asker = {
    name: 'asker',
    loop: { max_iterations: 2, until: { type: 'marker', marker: '<DONE>' }, pause_marker: '<NEEDS_USER>' },
    phases: [phase('q')],
  } as unknown as FlowSpec;
  const top = { name: 'top', input: 'задача', blocks: [{ name: 'ask', flow: 'asker', input: '{{input}}' }] } as unknown as FlowSpec;
  const r = launch(top, { asker }, (name, n) => (n === 1 ? 'какой цвет?\n<NEEDS_USER>' : 'готово\n<DONE>'));
  try {
    await until(() => Boolean(r.child() && liveControl.state(r.child()!)?.pause === 'paused'), 'пауза дочернего по вопросу');
    const kid = r.child()!;
    liveControl.pause(r.id);
    liveControl.resume(r.id);
    // вопрос этапа ждёт ответа на странице дочернего
    assert.equal(liveControl.state(kid)?.pause, 'paused');
    assert.equal(childReport(r.runsDir, kid).pauseReason?.phase, 'q');
    liveControl.resume(kid);
    assert.equal((await r.done).status, 'done');
    assert.deepEqual(r.started, ['q', 'q']);
  } finally {
    r.cleanup();
  }
});
