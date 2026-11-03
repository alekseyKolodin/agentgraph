// Состояние пространства после запуска идёт через очередь записей пространства (queueSpaceState): пока его пишет сессия
// терминала, запуск ждёт и считает новое состояние от уже записанного, а не затирает его.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFlow } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';
import { createSpace, queueSpaceState, readSpace, spaceReadDirs, writeSpaceState } from './spaces.js';
import { isStateRequest } from './space-state.js';

const result = (over: Partial<SessionResult> = {}): SessionResult => ({ ok: true, subtype: 'success', text: 'out', costUsd: 0.01, turns: 1, durationMs: 10, errors: [], ...over });
const spec = { name: 'spaced', input: 'задача', blocks: [{ name: 'main', phases: [{ name: 'work', tools: [], prompt: 'сделай {{input}}' }] }] } as unknown as FlowSpec;

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-spacequeue-')));
  const prev = process.env.AGENTGRAPH_CONFIG_DIR;
  process.env.AGENTGRAPH_CONFIG_DIR = path.join(root, 'cfg');
  try {
    await fn(root);
  } finally {
    if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
    else process.env.AGENTGRAPH_CONFIG_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('состояние после запуска ждёт идущую запись того же пространства и считается от уже записанного', () =>
  withRoot(async (root) => {
    createSpace('p');
    writeSpaceState('p', 'Суть: старое', { id: 'r0', at: '', kind: 'run' });
    // сессия терминала держит очередь пространства, пока не записала своё состояние
    let release!: () => void;
    const held = queueSpaceState('p', async () => {
      await new Promise<void>((r) => (release = r));
      writeSpaceState('p', 'Суть: от сессии', { id: 's1', at: '', kind: 'session' });
    });
    const prompts: string[] = [];
    const session = async (req: SessionRequest): Promise<SessionResult> => {
      if (!isStateRequest(req)) return result();
      prompts.push(req.prompt);
      return result({ structured: { state: 'Суть: от запуска' } });
    };
    const run = runFlow(spec, { cwd: root, runsDir: root, runDir: path.join(root, 'run'), space: 'p', spaceDirs: spaceReadDirs(readSpace('p')!, root), saveState: true, session });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(prompts.length, 0, 'состояние запуска не должно стартовать, пока пишет сессия');
    release();
    await held;
    const r = await run;
    assert.equal(r.status, 'done');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Суть: от сессии/);
    assert.equal(readSpace('p')!.state.trim(), 'Суть: от запуска');
    assert.deepEqual(readSpace('p')!.history.map((x) => x.id), [r.id, 's1', 'r0']);
  }));

test('«Стоп», пока состояние запуска ждало в очереди: ни файла промпта, ни сессии состояния — «остановлено»', () =>
  withRoot(async (root) => {
    createSpace('p');
    let release!: () => void;
    const held = queueSpaceState('p', () => new Promise<void>((r) => (release = r)));
    let states = 0;
    const session = async (req: SessionRequest): Promise<SessionResult> => {
      if (isStateRequest(req)) states++;
      return isStateRequest(req) ? result({ structured: { state: 'Суть' } }) : result();
    };
    const abort = new AbortController();
    const runDir = path.join(root, 'run');
    const run = runFlow(spec, { cwd: root, runsDir: root, runDir, space: 'p', saveState: true, session, abort });
    await new Promise((r) => setTimeout(r, 50));
    abort.abort();
    release();
    await held;
    const r = await run;
    assert.equal(r.status, 'done');
    assert.equal(states, 0);
    assert.deepEqual(r.stateUpdate, { space: 'p', ok: false, costUsd: 0, skipped: 'остановлено' });
    assert.equal(fs.existsSync(path.join(runDir, 'space-state.prompt.md')), false);
    assert.equal(readSpace('p')!.history.length, 0);
  }));
