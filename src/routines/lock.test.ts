// Один движок рутин на папку настроек: замок в routines-state/, второй процесс фон не ведёт, после смерти первого — берёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoutineEngine } from './engine.js';
import type { SourceKind } from './kind.js';
import { acquireEngineLock } from './lock.js';
import { RoutineStore } from './store.js';

const NOW = () => new Date('2026-11-18T10:00:00.000Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-lock-'));

test('замок: второй живой процесс не берёт; мёртвый владелец — перехват; снимается только свой', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'routines-state', 'engine.lock');
    let firstAlive = true;
    const a = acquireEngineLock(file, 'ui', { pid: 111, alive: () => firstAlive, now: NOW });
    assert.equal(a.ok, true);
    const b = acquireEngineLock(file, 'desktop', { pid: 222, alive: () => firstAlive, now: NOW });
    assert.deepEqual(b, { ok: false, owner: { pid: 111, who: 'ui', at: NOW().toISOString() } });
    firstAlive = false;
    const c = acquireEngineLock(file, 'desktop', { pid: 222, alive: () => firstAlive, now: NOW });
    assert.equal(c.ok, true);
    // первый «проснулся» и снимает замок — он уже не его, файл остаётся
    if (a.ok) a.release();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 222);
    if (c.ok) c.release();
    assert.equal(fs.existsSync(file), false);
    // битый замок — перехватывается
    fs.writeFileSync(file, 'не json');
    assert.equal(acquireEngineLock(file, 'ui', { pid: 333, alive: () => true, now: NOW }).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('замок: второй движок на той же папке не опрашивает источники и не запускает flow; после смерти первого — берёт замок', async () => {
  const root = tmp();
  try {
    const store = new RoutineStore(root);
    let polls = 0;
    const kind: SourceKind = { kind: 'fake', title: 'Фейк', summary: 'тест', delivery: 'poll', minEveryMs: 0, setup: [], match: [], poll: async () => (polls++, []), describe: () => 'фейк' };
    store.writeSource('src', { title: 'Чат', kind: 'fake', config: {} });
    const pids = { alive: new Set([111]) };
    const intervals: Array<() => void> = [];
    const started: string[] = [];
    const engine = (pid: number, who: string) =>
      new RoutineEngine({
        store,
        kinds: () => [kind],
        startRun: async (r) => (started.push(r.event.id), `run-${pid}`),
        resumeRun: () => {},
        stopRun: () => {},
        flowBlocks: () => [],
        now: NOW,
        timers: { setInterval: (fn) => intervals.push(fn), clearInterval: () => {}, setTimeout: (fn) => setTimeout(fn, 1), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
        log: () => {},
        lock: { who, deps: { pid, alive: (p) => pids.alive.has(p), now: NOW } },
      });
    const first = engine(111, 'ui');
    first.saveRoutine('r', { spec: { title: 'r', when: { source: 'src' }, run: { flow: 'demo' }, mode: 'auto' } });
    first.start();
    await first.idle();
    await new Promise((r) => setTimeout(r, 5));
    const firstPolls = polls;
    assert.ok(firstPolls >= 1);

    const second = engine(222, 'desktop');
    second.start();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(polls, firstPolls, 'второй движок не опрашивает');
    assert.deepEqual(second.overview().engineOwner, { pid: 111, who: 'ui' });
    assert.equal(first.overview().engineOwner, undefined);
    // «Запустить сейчас» у второго работает
    store.addHistory('src', [{ source: 'src', id: 'e1', at: NOW().toISOString(), title: 'Баг', text: 'текст', fields: {} }]);
    await second.runNow('r');
    assert.deepEqual(started, ['e1']);

    // первый умер (не снял замок) — второй на следующей попытке берёт замок и ведёт фон
    pids.alive.delete(111);
    intervals.at(-1)!();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(second.overview().engineOwner, undefined);
    assert.ok(polls > firstPolls);
    assert.equal(JSON.parse(fs.readFileSync(store.lockFile(), 'utf8')).who, 'desktop');
    second.stop();
    assert.equal(fs.existsSync(store.lockFile()), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
