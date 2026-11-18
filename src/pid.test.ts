import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEtime, runnerAlive, type PidDeps } from './pid.js';

const RUN = '2026-10-20T12:40:31.000Z';
const at = (iso: string) => Date.parse(iso);
const NOW = at('2026-10-29T16:00:00Z');

/** Подмена ps и сигнала; calls — сколько раз «вызывали ps». */
function fake(exists: boolean, started?: number | 'gone') {
  const d = { calls: 0, now: NOW };
  const deps: PidDeps = {
    exists: () => exists,
    startedMs: () => (d.calls++, started),
    now: () => d.now,
    cache: new Map(),
  };
  return Object.assign(d, { deps });
}

test('pid: процесса нет — раннер мёртв', () => {
  assert.equal(runnerAlive(91028, RUN, fake(false, at('2026-10-20T12:00:00Z')).deps), false);
});

test('pid: процесс стартовал до запуска — это раннер', () => {
  assert.equal(runnerAlive(91028, RUN, fake(true, at('2026-10-20T12:00:00Z')).deps), true);
});

test('pid: номер достался процессу, стартовавшему после запуска, — раннер мёртв', () => {
  assert.equal(runnerAlive(91028, RUN, fake(true, at('2026-10-29T15:18:13Z')).deps), false);
});

test('pid: старт в пределах минуты после запуска — ещё раннер, дальше — уже нет', () => {
  assert.equal(runnerAlive(91028, RUN, fake(true, at(RUN) + 60_000).deps), true);
  assert.equal(runnerAlive(91028, RUN, fake(true, at(RUN) + 60_001).deps), false);
});

test('pid: процесс исчез между сигналом и ps — раннер мёртв', () => {
  assert.equal(runnerAlive(91028, RUN, fake(true, 'gone').deps), false);
});

test('pid: время старта неизвестно или нет startedAt — верим сигналу', () => {
  assert.equal(runnerAlive(91028, RUN, fake(true).deps), true);
  assert.equal(runnerAlive(91028, undefined, fake(true, at('2026-10-29T15:18:13Z')).deps), true);
});

test('pid: вердикт «чужой процесс» запоминается навсегда, ps больше не зовётся', () => {
  const f = fake(true, at('2026-10-29T15:18:13Z'));
  assert.equal(runnerAlive(91028, RUN, f.deps), false);
  f.now += 86_400_000;
  assert.equal(runnerAlive(91028, RUN, f.deps), false);
  assert.equal(f.calls, 1);
});

test('pid: вердикт «жив» помнится 30 секунд, потом ps зовётся снова', () => {
  const f = fake(true, at('2026-10-20T12:00:00Z'));
  runnerAlive(91028, RUN, f.deps);
  f.now += 29_000;
  runnerAlive(91028, RUN, f.deps);
  assert.equal(f.calls, 1);
  f.now += 2_000;
  runnerAlive(91028, RUN, f.deps);
  assert.equal(f.calls, 2);
});

test('pid: кэш не мешает заметить смерть процесса', () => {
  const f = fake(true, at('2026-10-20T12:00:00Z'));
  assert.equal(runnerAlive(91028, RUN, f.deps), true);
  f.deps.exists = () => false;
  assert.equal(runnerAlive(91028, RUN, f.deps), false);
});

// интеграционная: настоящие сигнал и ps на текущем процессе
test('pid: настоящий текущий процесс — живой раннер запуска, начатого сейчас', () => {
  assert.equal(runnerAlive(process.pid, new Date().toISOString()), true);
});

test('pid: etime во всех форматах ps, мусор — undefined', () => {
  assert.equal(parseEtime('   00:07\n'), 7);
  assert.equal(parseEtime('12:34'), 12 * 60 + 34);
  assert.equal(parseEtime('01:02:03'), 3723);
  assert.equal(parseEtime('1:02:03'), 3723);
  assert.equal(parseEtime('9-00:00:01'), 9 * 86400 + 1);
  assert.equal(parseEtime('123-00:00:00'), 123 * 86400);
  assert.equal(parseEtime(''), undefined);
  assert.equal(parseEtime('вчера'), undefined);
});
