import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRunFlow, runFlowView, runSpec, saveRunFlow, specFromRunBody, type SaveFlowDeps } from './adhoc.js';
import { runFlow, type RunReport } from './runner.js';
import type { SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';

const draft = { name: 'fix-tests', phases: [{ name: 'fix', tools: ['Read'], prompt: 'Почини {{input}}' }] };
const draftYaml = 'name: fix-tests\nphases:\n  - name: fix\n    tools: [Read]\n    prompt: Почини\n';
const saved = { name: 'saved', phases: [{ name: 'a', tools: [], prompt: 'x' }] } as unknown as FlowSpec;
const noLoad = (name: string): FlowSpec => assert.fail(`flows/ не должен читаться: ${name}`);

test('specFromRunBody: flow — сохранённый, не разовый', () => {
  const r = specFromRunBody({ flow: 'saved' }, (n) => ({ ...saved, name: n }));
  assert.equal(r.adhoc, false);
  assert.equal(r.spec.name, 'saved');
});

test('specFromRunBody: spec из конструктора — разовый, в короткой форме, flows/ не читается', () => {
  const r = specFromRunBody({ spec: { ...draft, phases: undefined, blocks: [{ name: 'main', phases: draft.phases }] } }, noLoad);
  assert.equal(r.adhoc, true);
  assert.equal(r.spec.name, 'fix-tests');
  assert.equal(r.spec.blocks, undefined);
  assert.equal(r.spec.phases?.[0].name, 'fix');
});

test('specFromRunBody: yaml из скилла — разовый', () => {
  const r = specFromRunBody({ yaml: draftYaml }, noLoad);
  assert.equal(r.adhoc, true);
  assert.equal(r.spec.phases?.[0].prompt, 'Почини');
});

test('specFromRunBody: ничего или два поля сразу — ошибка', () => {
  assert.throws(() => specFromRunBody({}, noLoad), /Не выбран flow/);
  assert.throws(() => specFromRunBody({ flow: 'saved', spec: draft }, noLoad), /что-то одно/);
  assert.throws(() => specFromRunBody({ spec: draft, yaml: draftYaml }, noLoad), /что-то одно/);
});

test('specFromRunBody: невалидный черновик — ошибка с текстом валидации', () => {
  assert.throws(() => specFromRunBody({ spec: { name: 'x', phases: [{ name: 'a' }] } }, noLoad), /Невалидный flow:[\s\S]*prompt/);
  assert.throws(() => specFromRunBody({ yaml: 'name: [' }, noLoad), /Ошибка YAML/);
  assert.throws(() => specFromRunBody({ spec: 'name: x' }, noLoad), /spec — объект/);
});

test('specFromRunBody: имя с ../ — ошибка до создания папки запуска', () => {
  assert.throws(() => specFromRunBody({ spec: { ...draft, name: '../evil' } }, noLoad), /Невалидный flow|Недопустимое имя/);
  assert.throws(() => specFromRunBody({ flow: '../evil' }, noLoad), /Недопустимое имя/);
});

// --- по чему продолжать

const report = (over: Partial<RunReport>) => ({ id: 'run-1', flow: 'example-blocks', ...over }) as RunReport;
const loaders = {
  flow: (name: string) => ({ ...saved, name, description: 'из flows/' }) as FlowSpec,
  snapshot: (id: string) => ({ ...saved, name: 'example-blocks', description: `снимок ${id}` }) as FlowSpec,
};

test('runSpec: у разового с именем сохранённого flow берётся снимок, а не flows/', () => {
  assert.equal(runSpec(report({ adhoc: true }), loaders).description, 'снимок run-1');
});

test('runSpec: обычный запуск — текущая версия из flows/ по имени', () => {
  assert.equal(runSpec(report({}), loaders).description, 'из flows/');
});

test('runSpec: продолжение продолжения разового — снимок своей папки', () => {
  assert.equal(runSpec(report({ id: 'run-3', adhoc: true, continuedFrom: 'run-2' }), loaders).description, 'снимок run-3');
});

const edit = { version: 1, at: '2026-10-27T10:00:00.000Z', source: 'edit' as const, via: 'ui' as const, changed: ['этап a: prompt'] };

test('runSpec: flow правили на ходу (flowEdits) — снимок запуска, а не flows/', () => {
  assert.equal(runSpec(report({ flowEdits: [edit] }), loaders).description, 'снимок run-1');
  assert.equal(runSpec(report({ flowEdits: [] }), loaders).description, 'из flows/');
});

test('runSpec: продолжение запуска с правкой flow — свой снимок по цепочке continuedFrom', () => {
  const reports: Record<string, RunReport> = {
    'run-1': report({ flowEdits: [edit] }),
    'run-2': report({ id: 'run-2', continuedFrom: 'run-1' }),
  };
  const chain = { ...loaders, report: (id: string) => reports[id] };
  assert.equal(runSpec(report({ id: 'run-3', continuedFrom: 'run-2' }), chain).description, 'снимок run-3');
  // начало цепочки без правок или удалено — flows/
  assert.equal(runSpec(report({ id: 'run-3', continuedFrom: 'gone' }), chain).description, 'из flows/');
});

test('readRunFlow: id с .. или / — отказ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-adhoc-'));
  try {
    assert.throws(() => readRunFlow(dir, '..'), /Неверный id/);
    assert.throws(() => readRunFlow(dir, 'a/../b'), /Неверный id/);
    assert.throws(() => readRunFlow(dir, 'nope'), /нет снимка/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runFlowView: короткая форма — один блок main с этапами и артефактами, полная — блоки как есть; ошибки как у readRunFlow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-adhoc-'));
  try {
    const put = (id: string, yaml: string) => { fs.mkdirSync(path.join(dir, id)); fs.writeFileSync(path.join(dir, id, 'flow.yaml'), yaml); };
    put('short', `${draftYaml}loop:\n  max_iterations: 2\n  until: { type: none }\nartifacts:\n  plan: { title: План }\n`);
    const short = runFlowView(dir, 'short');
    assert.equal(short.name, 'fix-tests');
    assert.deepEqual(short.blocks.map((b) => [b.name, b.loop?.max_iterations, b.phases.map((p) => p.name)]), [['main', 2, ['fix']]]);
    assert.equal(short.artifacts?.plan.title, 'План');
    put('full', 'name: two\nblocks:\n  - name: a\n    knowledge: [qa]\n    phases: [{ name: x, tools: [], prompt: x }]\n  - name: b\n    phases: [{ name: y, tools: [], prompt: y }]\n');
    const full = runFlowView(dir, 'full');
    assert.deepEqual(full.blocks.map((b) => [b.name, b.knowledge, b.phases.map((p) => p.name)]), [['a', ['qa'], ['x']], ['b', undefined, ['y']]]);
    assert.equal('artifacts' in full, false);
    assert.throws(() => runFlowView(dir, 'nope'), /нет снимка/);
    assert.throws(() => runFlowView(dir, '..'), /Неверный id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('снимок, который пишет раннер у разового запуска, снова читается и годится для продолжения', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-adhoc-'));
  try {
    const spec = specFromRunBody({ yaml: draftYaml }, noLoad).spec;
    spec.input = 'тесты';
    const session = async (): Promise<SessionResult> => ({ ok: true, subtype: 'success', text: 'ok', costUsd: 0, turns: 1, durationMs: 1, errors: [] });
    const r = await runFlow(spec, { cwd: runsDir, runsDir, session, adhoc: true });
    const back = readRunFlow(runsDir, r.id);
    assert.equal(back.name, 'fix-tests');
    assert.equal(back.input, 'тесты');
    assert.deepEqual(back.phases?.map((p) => p.name), ['fix']);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

// --- «Сохранить как flow»

function withSnapshot(fn: (runsDir: string) => void): void {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-adhoc-'));
  try {
    fs.mkdirSync(path.join(runsDir, 'run-1'));
    fs.writeFileSync(path.join(runsDir, 'run-1', 'flow.yaml'), draftYaml);
    fn(runsDir);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
}

const fakeFlows = (taken: string[]) => {
  const writes: { name: string; yaml: string; folder: string }[] = [];
  const deps: SaveFlowDeps = {
    exists: (n) => taken.includes(n),
    freeName: (n) => (taken.includes(n) ? `${n}-2` : n),
    save: (name, yaml, folder) => { writes.push({ name, yaml, folder }); },
    folderOf: () => 'Разное',
  };
  return { deps, writes };
};

test('сохранить как flow: без имени — свободное имя, name в YAML переписан на него', () => {
  withSnapshot((runsDir) => {
    const { deps, writes } = fakeFlows(['fix-tests']);
    const r = saveRunFlow(runsDir, 'run-1', { folder: ' Разное ' }, deps);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { name: 'fix-tests-2', folder: 'Разное' });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].folder, 'Разное');
    assert.match(writes[0].yaml, /^name: fix-tests-2$/m);
  });
});

test('сохранить как flow: занятое имя — 409, существующий flow не перезаписывается', () => {
  withSnapshot((runsDir) => {
    const { deps, writes } = fakeFlows(['mine']);
    const r = saveRunFlow(runsDir, 'run-1', { name: 'mine' }, deps);
    assert.equal(r.status, 409);
    assert.equal(writes.length, 0);
  });
});

test('сохранить как flow: недопустимое имя — 400, нет снимка — 404', () => {
  withSnapshot((runsDir) => {
    const { deps, writes } = fakeFlows([]);
    assert.equal(saveRunFlow(runsDir, 'run-1', { name: '../x' }, deps).status, 400);
    assert.equal(saveRunFlow(runsDir, 'run-2', {}, deps).status, 404);
    assert.equal(writes.length, 0);
  });
});
