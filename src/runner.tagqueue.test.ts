// Саммари тега после запуска идёт через очередь записей тега (queueTagSummary): пока по тому же тегу пишет сессия
// терминала, запуск ждёт и считает новое саммари от уже записанного, а не затирает его.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFlow } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';
import { createTag, queueTagSummary, readTag, writeTagSummary } from './tags.js';

const result = (over: Partial<SessionResult> = {}): SessionResult => ({ ok: true, subtype: 'success', text: 'out', costUsd: 0.01, turns: 1, durationMs: 10, errors: [], ...over });
const isSummary = (req: SessionRequest) => Boolean(req.outputSchema && 'summary' in ((req.outputSchema as { properties?: object }).properties ?? {}));
const spec = { name: 'tagged', input: 'задача', blocks: [{ name: 'main', phases: [{ name: 'work', tools: [], prompt: 'сделай {{input}}' }] }] } as unknown as FlowSpec;

test('саммари после запуска ждёт идущую запись того же тега и считается от уже записанного саммари', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-tagqueue-')));
  const prev = process.env.AGENTGRAPH_CONFIG_DIR;
  process.env.AGENTGRAPH_CONFIG_DIR = path.join(root, 'cfg');
  try {
    createTag('p');
    writeTagSummary('p', 'Суть: старое', { id: 'r0', flow: 'f', finishedAt: '', status: 'done' });
    // сессия терминала держит очередь тега, пока не записала своё саммари
    let release!: () => void;
    const held = queueTagSummary('p', async () => {
      await new Promise<void>((r) => (release = r));
      writeTagSummary('p', 'Суть: от сессии', { id: 's1', flow: 'session', finishedAt: '', status: 'done', kind: 'session' });
    });
    const prompts: string[] = [];
    const session = async (req: SessionRequest): Promise<SessionResult> => {
      if (!isSummary(req)) return result();
      prompts.push(req.prompt);
      return result({ structured: { summary: 'Суть: от запуска' } });
    };
    const run = runFlow(spec, { cwd: root, runsDir: root, runDir: path.join(root, 'run'), tags: ['p'], saveTag: true, session });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(prompts.length, 0, 'саммари запуска не должно стартовать, пока пишет сессия');
    release();
    await held;
    const r = await run;
    assert.equal(r.status, 'done');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Суть: от сессии/);
    assert.equal(readTag('p')!.summary.trim(), 'Суть: от запуска');
    assert.deepEqual(readTag('p')!.runs.map((x) => x.id), [r.id, 's1', 'r0']);
  } finally {
    if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
    else process.env.AGENTGRAPH_CONFIG_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
