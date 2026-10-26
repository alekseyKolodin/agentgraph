import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRequest, checkPlugins, judgeRequest, resolvePlugins, runFlow } from './runner.js';
import { sessionOptions, type SessionResult } from './agent.js';
import { contextOptions } from './context.js';
import { compactSpec, FlowSchema, type Block, type FlowSpec, type Phase } from './schema.js';
import { flowToYaml, parseFlow } from './flows.js';

const phase = (name: string, plugins?: string[]): Phase => ({ name, prompt: 'Проверь', tools: ['Bash'], plugins });
const run = { cwd: '/work/repo', runsDir: '/runs' };

test('plugins: блок и этап складываются, ~ и относительные пути раскрываются, дубли убираются', () => {
  const qa = phase('qa', ['~/my-plugin', '/shared']);
  const spec = { name: 'f', blocks: [{ name: 'test', plugins: ['/shared', '../tools'], phases: [qa] }] } as unknown as FlowSpec;
  assert.deepEqual(resolvePlugins(spec, qa, '/work/repo'), ['/shared', '/work/tools', path.join(os.homedir(), 'my-plugin')]);
});

test('plugins получает только свой этап и этапы своего блока', () => {
  const code = phase('code');
  const qa = phase('qa', ['/my-plugin']);
  const spec = { name: 'f', blocks: [{ name: 'dev', phases: [code] }, { name: 'test', phases: [qa] }] } as unknown as FlowSpec;
  assert.deepEqual(buildRequest(spec, qa, 'x', run).plugins, ['/my-plugin']);
  assert.equal('plugins' in buildRequest(spec, code, 'x', run), false);
});

test('короткая форма flow: plugins этапа доходят до запроса', () => {
  const qa = phase('qa', ['/my-plugin']);
  const spec = { name: 'f', phases: [qa] } as unknown as FlowSpec;
  assert.deepEqual(buildRequest(spec, qa, 'x', run).plugins, ['/my-plugin']);
});

test('опции SDK: плагины уходят как local, без плагинов поля нет', () => {
  assert.deepEqual(sessionOptions({ prompt: 'x', cwd: '/w', plugins: ['/my-plugin'] }).plugins, [{ type: 'local', path: '/my-plugin' }]);
  assert.equal(sessionOptions({ prompt: 'x', cwd: '/w' }).plugins, undefined);
  assert.equal(sessionOptions({ prompt: 'x', cwd: '/w', plugins: [] }).plugins, undefined);
});

test('судья плагинов этапа не получает', () => {
  const qa = phase('qa', ['/my-plugin']);
  const spec = { name: 'f', blocks: [{ name: 'test', plugins: ['/blk'], phases: [qa] }] } as unknown as FlowSpec;
  const req = judgeRequest(spec, { type: 'judge', prompt: 'Оцени' }, 'Оцени', run);
  assert.equal('plugins' in req, false);
});

test('несуществующая папка плагина — ошибка до запуска этапов, с именем этапа или блока', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-plugins-'));
  try {
    const ok: Block[] = [{ name: 'test', plugins: [dir], phases: [phase('qa', [dir])] }];
    assert.doesNotThrow(() => checkPlugins(ok, dir));
    assert.doesNotThrow(() => checkPlugins([{ name: 'dev', phases: [phase('code')] }], dir));
    assert.throws(() => checkPlugins([{ name: 'test', phases: [phase('qa', ['nope'])] }], dir), /qa: .*nope/);
    assert.throws(() => checkPlugins([{ name: 'test', plugins: ['/nope-plugin'], phases: [phase('qa')] }], dir), /блок test: \/nope-plugin/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('схема: plugins у этапа и блока необязательны, старый flow проходит', () => {
  const base = { name: 'f', blocks: [{ name: 'b', phases: [{ name: 'p', prompt: 'x', tools: [] }] }] };
  assert.equal(FlowSchema.safeParse(base).success, true);
  const withPlugins = { name: 'f', blocks: [{ name: 'b', plugins: ['~/my-plugin'], phases: [{ name: 'p', prompt: 'x', tools: [], plugins: ['/p'] }] }] };
  assert.equal(FlowSchema.safeParse(withPlugins).success, true);
  assert.equal(FlowSchema.safeParse({ ...withPlugins, blocks: [{ ...withPlugins.blocks[0], plugins: '~/my-plugin' }] }).success, false);
});

test('один блок с plugins не сворачивается в короткую форму и переживает YAML', () => {
  const spec = { name: 'f', blocks: [{ name: 'main', plugins: ['~/my-plugin'], phases: [phase('qa')] }] } as unknown as FlowSpec;
  const compact = compactSpec(spec);
  assert.equal(compact.phases, undefined);
  assert.deepEqual(parseFlow(flowToYaml(compact)).blocks?.[0].plugins, ['~/my-plugin']);
});

test('клон этапа получает плагины блока: блок ищется по имени этапа', () => {
  const qa = phase('qa');
  const spec = { name: 'f', blocks: [{ name: 'test', plugins: ['/blk'], phases: [qa] }] } as unknown as FlowSpec;
  assert.deepEqual(resolvePlugins(spec, { ...qa }, '/work'), ['/blk']);
});

test('runFlow: нет папки плагина — запуск падает до первого этапа', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-plugins-run-'));
  try {
    const spec = { name: 'one', input: 'x', phases: [{ name: 'a', tools: [], prompt: 'p', plugins: ['nope-plugin'] }] } as unknown as FlowSpec;
    let calls = 0;
    const session = async (): Promise<SessionResult> => {
      calls++;
      return { ok: true, subtype: 'success', text: 'ok', costUsd: 0, turns: 1, durationMs: 1, errors: [] };
    };
    const report = await runFlow(spec, { cwd: runsDir, runsDir, session });
    assert.equal(calls, 0);
    assert.equal(report.status, 'failed');
    assert.match(JSON.stringify(report), /Нет папок плагинов/);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('контекст: нет папки плагина — предупреждение, в опции сессии идёт только существующая', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-plugins-ctx-'));
  try {
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(path.join(cwd, 'qa-plugin'), { recursive: true });
    const flow = path.join(dir, 'ctx-plugins.yaml');
    fs.writeFileSync(flow, 'name: ctx-plugins\nblocks:\n  - name: b\n    plugins: [qa-plugin]\n    phases:\n      - {name: qa, tools: [], prompt: p, plugins: [missing-plugin]}\n');
    const r = contextOptions({ cwd, flow, phase: 'qa' });
    assert.deepEqual(r.options.plugins, [{ type: 'local', path: path.join(cwd, 'qa-plugin') }]);
    assert.equal(r.warnings.filter((w) => /missing-plugin/.test(w)).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
