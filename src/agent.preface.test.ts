// Текст агента перед вопросом: трекер по потоку SDK, передача в обработчик вопроса и поле preface в run.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { PREFACE_MAX, sessionOptions, takePreface, trackPreface, type AskQuestion, type Preface, type SessionResult } from './agent.js';
import { runFlow, type QuestionRecord } from './runner.js';
import type { FlowSpec } from './schema.js';

const text = (t: string, parent: string | null = null) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: t }] } }) as unknown as SDKMessage;
const tool = (name: string) =>
  ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name, input: {} }] } }) as unknown as SDKMessage;
const fresh = (): Preface => ({ text: '', open: false });

test('preface: подряд идущий текст склеивается, текст после инструмента начинает заново, сабагент не в счёт', () => {
  const p = fresh();
  for (const m of [text('Читаю файл'), tool('Read'), text('| № | Суть |'), text('Что публикуем?'), text('чужое', 'toolu_1')]) trackPreface(p, m);
  assert.equal(takePreface(p), '| № | Суть |\n\nЧто публикуем?');
});

test('preface: инструмент без текста после таблицы не теряет её', () => {
  const p = fresh();
  for (const m of [text('таблица'), tool('Edit')]) trackPreface(p, m);
  assert.equal(takePreface(p), 'таблица');
});

test('preface: забирается один раз, пустой — undefined, длинный — хвост', () => {
  const p = fresh();
  trackPreface(p, text('раз'));
  assert.equal(takePreface(p), 'раз');
  assert.equal(takePreface(p), undefined);
  trackPreface(p, text('   '));
  assert.equal(takePreface(p), undefined);
  trackPreface(p, text('a'.repeat(PREFACE_MAX) + 'КОНЕЦ'));
  const long = takePreface(p)!;
  assert.ok(long.startsWith('…') && long.endsWith('КОНЕЦ'));
  assert.equal(long.length, PREFACE_MAX + 1);
});

test('canUseTool: обработчик вопроса получает текст перед вопросом, следующий вопрос без нового текста — нет', async () => {
  const got: Array<string | undefined> = [];
  const p = fresh();
  const options = sessionOptions({ prompt: 'x', cwd: '.', tools: ['AskUserQuestion'], onQuestion: async (_q, _s, preface) => (got.push(preface), {}) }, p);
  const questions: AskQuestion[] = [{ question: 'Публикуем?', header: 'MR', options: [{ label: 'да' }] }];
  const ctx = { signal: new AbortController().signal, toolUseID: 't1' } as unknown as Parameters<NonNullable<typeof options.canUseTool>>[2];
  trackPreface(p, text('| 1 | баг |'));
  await options.canUseTool!('AskUserQuestion', { questions }, ctx);
  await options.canUseTool!('AskUserQuestion', { questions }, ctx);
  assert.deepEqual(got, ['| 1 | баг |', undefined]);
});

test('runner: preface ложится в вопрос run.json, без текста ключа нет', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-preface-'));
  try {
    const spec = { name: 'ask', input: 'x', phases: [{ name: 'a', tools: ['AskUserQuestion'], prompt: 'p' }] } as unknown as FlowSpec;
    const base: SessionResult = { ok: true, subtype: 'success', text: 'ok', costUsd: 0, turns: 1, durationMs: 1, errors: [] };
    const q: AskQuestion[] = [{ question: 'Какие?', header: 'MR', options: [{ label: 'все' }] }];
    const seen: QuestionRecord[] = [];
    const r = await runFlow(spec, {
      cwd: dir, runsDir: dir,
      onQuestion: async (rec) => (seen.push(rec), { 'Какие?': 'все' }),
      session: async (req) => {
        const signal = new AbortController().signal;
        await req.onQuestion!(q, signal, '| № | Суть |');
        await req.onQuestion!(q, signal);
        return base;
      },
    });
    const saved = JSON.parse(fs.readFileSync(path.join(r.runDir, 'run.json'), 'utf8')).questions as QuestionRecord[];
    assert.equal(saved[0].preface, '| № | Суть |');
    assert.equal('preface' in saved[1], false);
    assert.equal(seen[0].preface, '| № | Суть |');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
