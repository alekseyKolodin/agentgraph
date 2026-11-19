import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FlowEditStep } from './api-types.js';
import type { runSession, SessionRequest, SessionResult } from './agent.js';
import { flowShape, shapeSteps, stepWatcher } from './edit-steps.js';
import { editFlow } from './edit.js';

const BASE = `name: demo
description: d
artifacts:
  scoring: { file: scoring.md }
phases:
  - name: find
    title: Поиск
    tools: [Read]
    prompt: найди
  - name: score
    tools: []
    prompt: оцени
`;

const steps = (a: string, b: string) => shapeSteps(flowShape(a)!, flowShape(b)!);

test('шаги: новый этап, правка полей этапа, новый файл и поля flow', () => {
  const after = BASE
    .replace('description: d', 'description: другое')
    .replace('prompt: найди', 'prompt: найди иначе\n    handoff: список')
    .replace('  scoring: { file: scoring.md }', '  scoring: { file: scoring.md }\n  review: { file: user_review.md }')
    .replace('  - name: score', '  - name: review\n    title: Утверждение\n    tools: [AskUserQuestion]\n    prompt: спроси\n  - name: score');
  assert.deepEqual(steps(BASE, after), [
    { kind: 'edit', what: 'flow', name: '', fields: ['description'] },
    { kind: 'edit', what: 'phase', name: 'find', title: 'Поиск', fields: ['prompt', 'handoff'] },
    { kind: 'add', what: 'phase', name: 'review', title: 'Утверждение' },
    { kind: 'add', what: 'artifact', name: 'review', title: 'user_review.md' },
  ]);
});

test('шаги: удалённый этап, условие короткой формы — правка блока main', () => {
  const after = BASE.replace(/  - name: score\n    tools: \[\]\n    prompt: оцени\n/, '').replace('phases:', 'loop: { max_iterations: 3, until: { type: none } }\nphases:');
  assert.deepEqual(steps(BASE, after), [
    { kind: 'edit', what: 'block', name: 'main', fields: ['loop'] },
    { kind: 'remove', what: 'phase', name: 'score' },
  ]);
});

test('шаги: невалидный посреди правки flow всё равно сравнивается, не YAML — снимка нет', () => {
  // этап читает артефакт, которого нет: валидацию не прошёл бы, но шаг виден
  assert.deepEqual(steps(BASE, BASE.replace('prompt: оцени', 'prompt: оцени\n    reads: [nope]')), [{ kind: 'edit', what: 'phase', name: 'score', fields: ['reads'] }]);
  assert.equal(flowShape('a: [b'), null);
  assert.equal(flowShape(''), null);
  assert.deepEqual(steps(BASE, BASE), []);
});

test('наблюдатель: первый Read — «прочитал», правка — что поменялось, ошибка инструмента и чужой файл — без шагов', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-steps-'));
  const file = path.join(dir, 'flow.yaml');
  fs.writeFileSync(file, BASE);
  const got: FlowEditStep[] = [];
  const watch = stepWatcher(file, () => fs.readFileSync(file, 'utf8'), (s) => got.push(s));
  try {
    watch({ kind: 'tool_use', id: 'r1', name: 'Read', input: { file_path: file } });
    watch({ kind: 'tool_result', toolUseId: 'r1', isError: false, text: '' });
    watch({ kind: 'tool_use', id: 'r2', name: 'Read', input: { file_path: file } });
    watch({ kind: 'tool_result', toolUseId: 'r2', isError: false, text: '' });
    assert.deepEqual(got, [{ kind: 'read', blocks: 1, phases: 2, artifacts: 1 }]);

    fs.writeFileSync(file, BASE.replace('prompt: оцени', 'prompt: оцени строже'));
    watch({ kind: 'tool_use', id: 'e0', name: 'Edit', input: { file_path: path.join(dir, 'other.yaml') } });
    watch({ kind: 'tool_result', toolUseId: 'e0', isError: false, text: '' });
    watch({ kind: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: file } });
    watch({ kind: 'tool_result', toolUseId: 'e1', isError: true, text: 'old_string not found' });
    assert.equal(got.length, 1);

    watch({ kind: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: file } });
    watch({ kind: 'tool_result', toolUseId: 'e2', isError: false, text: '' });
    // снимок с прошлого раза: правка e1 не учитывалась, но файл тот же — одна правка промпта
    assert.deepEqual(got.at(-1), { kind: 'edit', what: 'phase', name: 'score', fields: ['prompt'] });
    assert.equal(got.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('editFlow отдаёт шаги словами по Read и Edit поддельной сессии', async () => {
  const fake = async (req: SessionRequest): Promise<SessionResult> => {
    const file = path.join(req.cwd, 'flow.yaml');
    req.onEvent?.({ kind: 'tool_use', id: 'r', name: 'Read', input: { file_path: file } });
    req.onEvent?.({ kind: 'tool_result', toolUseId: 'r', isError: false, text: '' });
    req.onEvent?.({ kind: 'tool_use', id: 'e', name: 'Edit', input: { file_path: file } });
    fs.writeFileSync(file, BASE.replace('tools: [Read]', 'tools: [Read, Grep]'));
    req.onEvent?.({ kind: 'tool_result', toolUseId: 'e', isError: false, text: '' });
    return { ok: true, subtype: 'success', text: '- `find`: добавлен Grep', costUsd: 0.1, turns: 2, durationMs: 5, errors: [], model: 'm' };
  };
  const got: FlowEditStep[] = [];
  const r = await editFlow('demo', 'добавь Grep', { yaml: BASE }, { onStep: (s) => got.push(s), deps: { session: fake as typeof runSession } });
  assert.equal(r.changed, true);
  assert.deepEqual(got, [
    { kind: 'read', blocks: 1, phases: 2, artifacts: 1 },
    { kind: 'edit', what: 'phase', name: 'find', title: 'Поиск', fields: ['tools'] },
  ]);
});

test('наблюдатель не роняет правку: YAML с циклическим якорем — шага нет', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-steps-'));
  const file = path.join(dir, 'flow.yaml');
  fs.writeFileSync(file, BASE);
  const got: FlowEditStep[] = [];
  const watch = stepWatcher(file, () => fs.readFileSync(file, 'utf8'), (s) => got.push(s));
  try {
    fs.writeFileSync(file, BASE.replace('description: d', 'description: &x\n  b: *x'));
    watch({ kind: 'tool_use', id: 'e', name: 'Edit', input: { file_path: 'flow.yaml' } });
    assert.doesNotThrow(() => watch({ kind: 'tool_result', toolUseId: 'e', isError: false, text: '' }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
