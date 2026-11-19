import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify as toYaml } from 'yaml';
import { parse as parseYaml } from 'yaml';
import { flowFingerprint, flowHistory, versionYaml } from './flow-history.js';
import { parseFlow } from './flows.js';

const flowYaml = (prompt: string) => `name: demo\nphases:\n  - name: work\n    prompt: ${prompt}\n    tools: [Read]\n`;
/** Снимок, как его пишет раннер: разобранная схема через stringify. */
const snapshot = (yamlText: string) => toYaml(parseFlow(yamlText), { lineWidth: 0 });
const NOW = Date.parse('2026-11-19T12:00:00Z');
const at = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const run = (id: string, days: number, over: Record<string, unknown> = {}) => ({ id, flow: 'demo', startedAt: at(days), status: 'done', ...over });

function withRuns(snaps: Record<string, Record<string, string>>, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-fh-'));
  try {
    for (const [id, files] of Object.entries(snaps)) {
      fs.mkdirSync(path.join(dir, id));
      for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, id, f), text);
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('отпечаток flow: файл и снимок раннера совпадают, порядок ключей и пробелы не важны, другой промпт — другой', () => {
  const file = flowYaml('сделай');
  assert.equal(flowFingerprint(file), flowFingerprint(snapshot(file)));
  assert.equal(flowFingerprint(file), flowFingerprint(`phases:\n  - tools: [Read]\n    prompt:   сделай\n    name: work\nname: demo\n`));
  assert.notEqual(flowFingerprint(file), flowFingerprint(flowYaml('сделай иначе')));
  assert.equal(flowFingerprint(': : :\n  - ['), undefined);
});

test('статистика: запуски за 30 дней и последний; чужие и разовые не в счёт', () => {
  withRuns({}, (dir) => {
    const h = flowHistory('demo', [run('r1', 2, { title: 'Свежий' }), run('r2', 40), run('x', 1, { flow: 'other' }), run('a', 1, { adhoc: true })], { runsDir: dir, now: NOW });
    assert.equal(h.total, 2);
    assert.equal(h.runs30d, 1);
    assert.deepEqual(h.last, { id: 'r1', startedAt: at(2), status: 'done', title: 'Свежий' });
    assert.equal(h.noSnapshot, 2);
    assert.deepEqual(h.versions, []);
  });
});

test('версии: одинаковые снимки — одна, номер по появлению, текущая — по файлу, правка на ходу — версия начала', () => {
  const v1 = flowYaml('раз');
  const v2 = flowYaml('два');
  withRuns(
    {
      old: { 'flow.yaml': snapshot(v1) },
      mid: { 'flow.yaml': snapshot(v1) },
      // правили на ходу: начинался с v2, закончил на v1 — считается v2
      edited: { 'flow.0.yaml': snapshot(v2), 'flow.yaml': snapshot(v1) },
      fresh: { 'flow.yaml': snapshot(v2) },
    },
    (dir) => {
      const runs = [run('fresh', 1), run('edited', 3), run('mid', 10), run('old', 20)];
      const h = flowHistory('demo', runs, { runsDir: dir, now: NOW, currentYaml: v2 });
      assert.deepEqual(
        h.versions.map((v) => [v.n, v.runs, v.current, v.runId, v.file, v.firstAt, v.lastAt]),
        [
          [2, 2, true, 'fresh', 'flow.yaml', at(3), at(1)],
          [1, 2, false, 'mid', 'flow.yaml', at(20), at(10)],
        ],
      );
      assert.equal(h.currentUnrun, undefined);
      // файл поправили после последнего запуска — ни одна версия не текущая, и это видно
      const changed = flowHistory('demo', runs, { runsDir: dir, now: NOW, currentYaml: flowYaml('три') });
      assert.equal(changed.currentUnrun, true);
      assert.ok(changed.versions.every((v) => !v.current));
      // flow удалили — текущей нет, но и «не запускался» не говорим
      assert.equal(flowHistory('demo', runs, { runsDir: dir, now: NOW }).currentUnrun, undefined);
    },
  );
});

/** Снимок, как его пишет сервер: задача запуска — в input (у рутины — с блоком события). */
const withTask = (yamlText: string, task: string) => toYaml({ ...parseFlow(yamlText), input: task }, { lineWidth: 0 });

test('задача запуска в снимке — не версия: разные задачи того же flow — одна версия, текущая', () => {
  const file = flowYaml('сделай');
  withRuns({ a: { 'flow.yaml': withTask(file, 'почини A') }, b: { 'flow.yaml': withTask(file, 'почини B\n<source-data>событие</source-data>') } }, (dir) => {
    const h = flowHistory('demo', [run('a', 1), run('b', 2)], { runsDir: dir, now: NOW, currentYaml: `${file}input: задача по умолчанию\n` });
    assert.deepEqual(h.versions.map((v) => [v.n, v.runs, v.current]), [[1, 2, true]]);
    assert.equal(h.currentUnrun, undefined);
  });
});

test('ни одного запуска со снимком — «поправили после последнего» не говорим', () => {
  withRuns({}, (dir) => {
    assert.equal(flowHistory('demo', [], { runsDir: dir, now: NOW, currentYaml: flowYaml('x') }).currentUnrun, undefined);
    assert.equal(flowHistory('demo', [run('r', 1)], { runsDir: dir, now: NOW, currentYaml: flowYaml('x') }).currentUnrun, undefined);
  });
});

test('версия для редактора: задача запуска заменена задачей файла, нет её в файле — поля нет; остальное — из снимка', () => {
  const snap = withTask(flowYaml('старый промпт'), 'чужая задача <source-data>MR</source-data>');
  const next = parseYaml(versionYaml(snap, `${flowYaml('новый')}input: моя задача\n`));
  assert.equal(next.input, 'моя задача');
  assert.equal(next.phases[0].prompt, 'старый промпт');
  assert.equal('input' in parseYaml(versionYaml(snap, flowYaml('новый'))), false);
  assert.equal('input' in parseYaml(versionYaml(snap, undefined)), false);
  assert.throws(() => versionYaml('- список', undefined));
});
