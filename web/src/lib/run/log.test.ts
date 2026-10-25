import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOG_CHUNK_LINES, LOG_LINE_MAX, LOG_MAX_LINES, planLogChunks, RunLogBuffer } from './log';

test('длинная строка обрезается с подсказкой про транскрипт; хвост — 6 строк по 240 знаков, по этапам отдельно', () => {
  const log = new RunLogBuffer();
  log.append(`[a] ${'x'.repeat(LOG_LINE_MAX + 10)}`);
  assert.match(log.queue[0]!, /… \(ещё знаков: 14, полный текст в транскрипте этапа\)$/);
  assert.equal(log.tail[0]!.length, 241);
  for (let i = 0; i < 8; i++) log.append(`[${i % 2 ? 'b' : 'a'}] строка ${i}`);
  assert.equal(log.tail.length, 6);
  assert.equal(log.tail.at(-1), '[b] строка 7');
  assert.deepEqual(log.byPhase.get('b'), ['строка 1', 'строка 3', 'строка 5', 'строка 7']);
  assert.equal(log.byPhase.get('a')?.length, 5);
  const { lines, reset } = log.take();
  assert.equal(lines.length, 9);
  assert.equal(reset, false);
  assert.equal(log.queue.length, 0);
});

test('переполненная очередь — сброс DOM и только последние строки', () => {
  const log = new RunLogBuffer();
  for (let i = 0; i < LOG_MAX_LINES + LOG_CHUNK_LINES; i++) log.append(`[a] ${i}`);
  const { lines, reset } = log.take();
  assert.equal(reset, true);
  assert.equal(lines.length, LOG_MAX_LINES);
  assert.equal(lines.at(-1), `[a] ${LOG_MAX_LINES + LOG_CHUNK_LINES - 1}`);
  log.clear();
  assert.deepEqual([log.tail, log.byPhase.size], [[], 0]);
});

test('раскладка по кускам: добить последний, новые по 200, лишние первые — убрать', () => {
  assert.deepEqual(planLogChunks([], 450), { fill: 0, chunks: [200, 200, 50], drop: 0 });
  assert.deepEqual(planLogChunks([200, 150], 60), { fill: 50, chunks: [10], drop: 0 });
  assert.deepEqual(planLogChunks([200], 10), { fill: 0, chunks: [10], drop: 0 });
  const full = Array(15).fill(200);
  assert.deepEqual(planLogChunks(full, 5), { fill: 0, chunks: [5], drop: 1 });
  assert.deepEqual(planLogChunks([], 0), { fill: 0, chunks: [], drop: 0 });
});
