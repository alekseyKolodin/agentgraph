import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleReporter } from './reporters.js';
import type { PhaseReport, RunEvent } from './runner.js';

/** Всё, что репортёр напечатал (console.log и process.stdout.write), без цветов. */
function capture(fn: () => void): string {
  const orig = { log: console.log, write: process.stdout.write.bind(process.stdout) };
  let out = '';
  console.log = (...a: unknown[]) => { out += `${a.join(' ')}\n`; };
  process.stdout.write = ((chunk: string) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    console.log = orig.log;
    process.stdout.write = orig.write;
  }
  return out.replace(/\x1b\[[0-9;]*m/g, '');
}

const phaseEnd = { block: 'main', iteration: 1, index: 0, phase: 'a', title: 'A', tools: [], ok: true, subtype: 'success', costUsd: 0.01, turns: 2, durationMs: 1000, chars: 5, errors: [], files: { prompt: '', transcript: '', output: '' } } as PhaseReport;
const events: RunEvent[] = [
  { type: 'phase_start', block: 'main', iteration: 1, index: 0, phase: 'a', title: 'A', tools: [], files: phaseEnd.files },
  { type: 'phase_end', report: phaseEnd },
];

test('консольный вывод дочернего запуска: префикс в начале каждой строки, «▶ этап … ✓» — одна строка с одним префиксом', () => {
  const out = capture(() => events.forEach(consoleReporter(false, '│ ')));
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^│ ▶ A \[без инструментов\] … ✓ 2 ходов/);
  // без префикса — как раньше
  const plain = capture(() => events.forEach(consoleReporter(false)));
  assert.equal(plain, out.replace(/^│ /gm, ''));
});

test('консольный вывод связки: «▶ блок … вызов flow» кончает строку, развилка и пропущенный блок — своими строками', () => {
  const call: RunEvent[] = [
    { ...events[0], phase: 'review', title: 'review' } as RunEvent,
    { type: 'call', block: 'main', iteration: 1, phase: 'review', runId: 'kid-1', flow: 'child' },
    { type: 'next', block: 'main', next: { to: 'ship', rule: 0, checks: [] }, total: 2 },
    { type: 'block_end', block: { name: 'slogan', title: 'Слоган', status: 'pending', bypassed: true } as never },
    { type: 'next', block: 'ship', next: { to: 'end', checks: [] }, total: 2 },
  ];
  const lines = capture(() => call.forEach(consoleReporter(false))).split('\n').filter(Boolean);
  assert.deepEqual(lines, [
    '▶ review [без инструментов] … вызов flow child · запуск kid-1',
    '⤷ После блока main: блок ship (правило 1)',
    '↷ Блок Слоган: пропущен развилкой',
    '⤷ После блока ship: конец запуска (ни одно правило не выполнилось — по порядку)',
  ]);
});
