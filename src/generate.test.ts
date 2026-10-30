import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DESIGN_RULES, generateFlow } from './generate.js';
import type { runSession, SessionEvent, SessionRequest, SessionResult } from './agent.js';

const GENERATED = {
  name: 'fix-tests',
  description: 'Чинит тесты',
  input: 'почини тесты',
  blocks: [{ name: 'main', phases: [{ name: 'work', tools: ['Read', 'Edit'], prompt: 'Задача: {{input}}' }] }],
};

/** Поддельная сессия: как runSession, зовёт onModel, onEvent и log, потом отдаёт результат. */
function fakeSession(over: Partial<SessionResult> = {}, during?: (req: SessionRequest) => void): typeof runSession & { calls: SessionRequest[] } {
  const calls: SessionRequest[] = [];
  const fn = async (req: SessionRequest, log: (line: string) => void): Promise<SessionResult> => {
    calls.push(req);
    req.onModel?.('claude-haiku-test');
    const retry: SessionEvent = { kind: 'retry', attempt: 1, maxRetries: 10, delayMs: 2000, status: 529 };
    req.onEvent?.(retry);
    log('думаю над flow');
    during?.(req);
    return { ok: true, subtype: 'success', text: '', structured: GENERATED, costUsd: 0.25, turns: 1, durationMs: 5, errors: [], model: 'claude-haiku-test', ...over };
  };
  return Object.assign(fn, { calls });
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-gen-'));

test('генерация отдаёт ход сессии: модель, повтор запроса, строки лога', async () => {
  const cwd = tmpDir();
  try {
    const models: string[] = [];
    const events: SessionEvent[] = [];
    const lines: string[] = [];
    const session = fakeSession();
    await generateFlow('почини тесты', { cwd, onModel: (m) => models.push(m), onEvent: (e) => events.push(e), log: (l) => lines.push(l), deps: { session } });
    assert.deepEqual(models, ['claude-haiku-test']);
    assert.equal(events[0]?.kind, 'retry');
    assert.deepEqual(lines, ['думаю над flow']);
    assert.deepEqual(session.calls[0]?.tools, ['Read', 'Grep', 'Glob'], 'генератор смотрит проект только на чтение');
    assert.deepEqual(session.calls[0]?.implicitTools, [], 'без сабагентов и скиллов');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('пример команды в правиле про список работ доходит до модели с обратными слэшами', () => {
  // в шаблонной строке «\[» молча теряет слэш, и grep искал бы не то
  assert.ok(DESIGN_RULES.includes("grep -q '^- \\[ \\]' docs/plan.md"));
});

test('генерация возвращает модель сессии и длительность', async () => {
  const cwd = tmpDir();
  try {
    const r = await generateFlow('почини тесты', { cwd, model: 'claude-haiku-4-5-20251001', deps: { session: fakeSession() } });
    assert.equal(r.spec.name, 'fix-tests');
    assert.equal(r.model, 'claude-haiku-test');
    assert.equal(typeof r.durationMs, 'number');
    assert.ok(r.durationMs >= 0);
    assert.equal(r.result.costUsd, 0.25);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('выбранная модель уходит в сессию', async () => {
  const cwd = tmpDir();
  try {
    const session = fakeSession();
    await generateFlow('почини тесты', { cwd, model: 'claude-sonnet-5-5', deps: { session } });
    assert.equal(session.calls[0]?.model, 'claude-sonnet-5-5');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('прерванная до старта генерация не запускает сессию', async () => {
  const cwd = tmpDir();
  try {
    const abort = new AbortController();
    abort.abort();
    const session = fakeSession();
    await assert.rejects(generateFlow('почини тесты', { cwd, abort, deps: { session } }), /Генерация прервана/);
    assert.equal(session.calls.length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('прерванная генерация — ошибка «прервана», а не «не вернул спецификацию»', async () => {
  const cwd = tmpDir();
  try {
    const abort = new AbortController();
    const session = fakeSession({ ok: false, subtype: 'no_result', structured: undefined, errors: ['aborted'] }, () => abort.abort());
    await assert.rejects(generateFlow('почини тесты', { cwd, abort, deps: { session } }), /Генерация прервана/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
