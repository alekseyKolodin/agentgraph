import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRequest, checkAddDirs, judgeRequest, renderPhasePrompt, resolveAddDirs } from './runner.js';
import { emptyContext } from './template.js';
import type { FlowSpec, Phase } from './schema.js';

const phase = (add_dirs?: string[], tools: string[] = []): Phase => ({ name: 'qa', prompt: 'Проверь', tools, add_dirs });
const spec = (p: Phase): FlowSpec => ({ name: 'f', phases: [p] }) as unknown as FlowSpec;

test('add_dirs: ~ раскрывается, относительные пути — от рабочей директории, дубли убираются', () => {
  assert.deepEqual(resolveAddDirs(phase(['~/qa', '../rules', '/abs', ' /abs ', '']), '/work/repo'), [
    path.join(os.homedir(), 'qa'),
    '/work/rules',
    '/abs',
  ]);
  assert.deepEqual(resolveAddDirs(phase(), '/work/repo'), []);
});

test('add_dirs дописываются в конец промпта, без них промпт прежний', () => {
  const ctx = emptyContext('', 1);
  assert.equal(renderPhasePrompt(phase(), ctx, '/work'), 'Проверь');
  assert.equal(renderPhasePrompt(phase(), ctx, '/work', { runDir: '/runs/1', addDirs: [], attachments: [] }), 'Проверь');
  assert.match(renderPhasePrompt(phase(['/qa']), ctx, '/work'), /^Проверь\n\n.*\n- \/qa$/);
});

test('директории запуска и вложения дописываются в промпт абсолютными путями', () => {
  const ctx = emptyContext('', 1);
  const text = renderPhasePrompt(phase(['/qa'], ['Read']), ctx, '/work', { runDir: '/runs/1', addDirs: ['/qa', '/rules'], attachments: ['attachments/shot.png'] });
  assert.equal(
    text,
    'Проверь\n\nКроме директории проекта тебе доступны (правила, инструкции, скиллы — сверяйся с ними):\n- /qa\n- /rules' +
      '\n\nВложения к задаче (открой инструментом Read):\n- /runs/1/attachments/shot.png',
  );
});

test('buildRequest: add_dirs этапа, директории запуска и папка вложений без дублей', () => {
  const p = phase(['/qa', '/rules'], ['Read']);
  const req = buildRequest(spec(p), p, 'x', { cwd: '/work', runsDir: '/runs', runDir: '/runs/1', addDirs: ['/rules', '/extra'], attachments: ['attachments/a.png'] });
  assert.deepEqual(req.additionalDirectories, ['/qa', '/rules', '/extra', '/runs/1/attachments']);
  assert.deepEqual(buildRequest(spec(p), p, 'x', { cwd: '/work', runsDir: '/runs', runDir: '/runs/1' }).additionalDirectories, ['/qa', '/rules']);
});

test('вложения получает каждый этап, в том числе без Read', () => {
  const ctx = emptyContext('', 1);
  const p = phase(undefined, []);
  const run = { cwd: '/work', runsDir: '/runs', runDir: '/runs/1', addDirs: ['/extra'], attachments: ['attachments/a.png'] };
  assert.equal(
    renderPhasePrompt(p, ctx, '/work', run),
    'Проверь\n\nКроме директории проекта тебе доступны (правила, инструкции, скиллы — сверяйся с ними):\n- /extra' +
      '\n\nВложения к задаче (открой инструментом Read):\n- /runs/1/attachments/a.png',
  );
  assert.deepEqual(buildRequest(spec(p), p, 'x', run).additionalDirectories, ['/extra', '/runs/1/attachments']);
});

test('судья получает вложения и их папку, но не директории запуска', () => {
  const until = { type: 'judge' as const, prompt: 'Оцени' };
  const req = judgeRequest(spec(phase()), until, 'Оцени', { cwd: '/work', runsDir: '/runs', runDir: '/runs/1', addDirs: ['/extra'], attachments: ['attachments/a.png'] });
  assert.deepEqual(req.additionalDirectories, ['/runs/1/attachments']);
  assert.match(req.prompt, /^Оцени\n\nВложения к задаче.*\n- \/runs\/1\/attachments\/a\.png$/);
  assert.doesNotMatch(req.prompt, /extra/);
  const bare = judgeRequest(spec(phase()), until, 'Оцени', { cwd: '/work', runsDir: '/runs', runDir: '/runs/1' });
  assert.equal(bare.prompt, 'Оцени');
  assert.deepEqual(bare.additionalDirectories, []);
});

test('несуществующая директория из add_dirs — ошибка до запуска этапов', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-dirs-'));
  const blocks = [{ name: 'main', phases: [phase([dir]), { ...phase(['nope']), name: 'fix' }] }];
  assert.throws(() => checkAddDirs(blocks, dir), /fix: .*nope/);
  assert.doesNotThrow(() => checkAddDirs([{ name: 'main', phases: [phase([dir])] }], dir));
  assert.throws(() => checkAddDirs([{ name: 'main', phases: [phase()] }], dir, [dir, '/nope-run-dir']), /запуск: \/nope-run-dir/);
  fs.rmSync(dir, { recursive: true });
});
