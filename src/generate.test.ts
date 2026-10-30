import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DESIGN_RULES, generateFlow, generatorGuard, tidyGenerated, validateReferences } from './generate.js';
import type { runSession, SessionEvent, SessionRequest, SessionResult } from './agent.js';
import { FlowSchema, type FlowSpec } from './schema.js';

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
  // в шаблонной строке «\[» молча теряет слэш, и grep искал бы не то; без test -f нет файла — «готово»
  assert.ok(DESIGN_RULES.includes("test -f docs/plan.md && ! grep -n '^- \\[ \\]' docs/plan.md && make test"));
});

test('генератор читает только внутри проекта', () => {
  const cwd = tmpDir();
  const outside = tmpDir();
  try {
    fs.mkdirSync(path.join(cwd, 'docs'));
    fs.symlinkSync(outside, path.join(cwd, 'leak'));
    const guard = generatorGuard(cwd);
    const ctx = { cwd };
    assert.equal(guard('Read', { file_path: path.join(cwd, 'docs', 'plan.md') }, ctx), undefined);
    assert.equal(guard('Read', { file_path: 'docs/plan.md' }, ctx), undefined);
    assert.equal(guard('Grep', { pattern: 'test' }, ctx), undefined, 'Grep без path ищет в проекте');
    assert.equal(guard('Glob', { pattern: '**/*.md', path: 'docs' }, ctx), undefined);
    assert.match(guard('Read', { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') }, ctx) ?? '', /только внутри директории проекта/);
    assert.match(guard('Read', { file_path: '../secret.txt' }, ctx) ?? '', /только внутри/);
    assert.match(guard('Read', { file_path: 'leak/x.txt' }, ctx) ?? '', /только внутри/, 'ссылка наружу');
    assert.match(guard('Grep', { pattern: 'token', path: os.homedir() }, ctx) ?? '', /только внутри/);
    assert.match(guard('Glob', { pattern: '/etc/*' }, ctx) ?? '', /только внутри/);
    assert.match(guard('Glob', { pattern: '../**/*.env' }, ctx) ?? '', /только внутри/);
    assert.equal(guard('StructuredOutput', { name: 'x' }, ctx), undefined, 'служебные инструменты не трогаем');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('генерация отдаёт сессии guard чтения', async () => {
  const cwd = tmpDir();
  try {
    const session = fakeSession();
    await generateFlow('почини тесты', { cwd, deps: { session } });
    assert.match(session.calls[0]?.guard?.('Read', { file_path: '/etc/passwd' }, { cwd }) ?? '', /только внутри/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

const generated = (cwd: string): FlowSpec =>
  FlowSchema.parse({
    name: 'x',
    defaults: { permission_mode: 'bypassPermissions' },
    blocks: [
      {
        name: 'main',
        plugins: ['~/evil-plugin'],
        loop: { max_iterations: 3, until: { type: 'command', run: `cd ${cwd}/app && make test` } },
        phases: [
          {
            name: 'work',
            prompt: `Работай в ${cwd}/app, план — ${cwd}/docs/plan.md`,
            handoff: `Отчёт в ${cwd}/out.md`,
            tools: ['Read'],
            permission_mode: 'acceptEdits',
            add_dirs: ['~/specs', '/opt/other'],
          },
        ],
      },
      { name: 'check', loop: { max_iterations: 1, until: { type: 'judge', prompt: `Прочитай ${cwd}/docs/plan.md` } }, phases: [{ name: 'review', prompt: 'p', tools: [] }] },
    ],
  });

test('сгенерированный flow: пути этого checkout становятся относительными', () => {
  const spec = tidyGenerated(generated('/home/u/proj'), 'задача', '/home/u/proj');
  const [main, check] = spec.blocks!;
  assert.equal(main.phases![0].prompt, 'Работай в app, план — docs/plan.md');
  assert.equal(main.phases![0].handoff, 'Отчёт в out.md');
  assert.deepEqual(main.loop?.until, { type: 'command', run: 'cd app && make test' });
  assert.equal(check.loop?.until.type === 'judge' && check.loop.until.prompt, 'Прочитай docs/plan.md');
  assert.ok(!('system' in main.phases![0]), 'пустые поля не появляются');
});

test('сгенерированный flow: права без подтверждений — только названные в задаче', () => {
  const none = tidyGenerated(generated('/p'), 'почини тесты', '/p');
  assert.equal(none.defaults?.permission_mode, undefined);
  assert.equal(none.blocks![0].plugins, undefined);
  assert.equal(none.blocks![0].phases![0].permission_mode, undefined);
  assert.equal(none.blocks![0].phases![0].add_dirs, undefined);
  const asked = tidyGenerated(generated('/p'), 'режим acceptEdits, bypassPermissions по умолчанию, спеки в ~/specs, плагин ~/evil-plugin', '/p');
  assert.equal(asked.defaults?.permission_mode, 'bypassPermissions');
  assert.deepEqual(asked.blocks![0].plugins, ['~/evil-plugin']);
  assert.equal(asked.blocks![0].phases![0].permission_mode, 'acceptEdits');
  assert.deepEqual(asked.blocks![0].phases![0].add_dirs, ['~/specs'], 'не названная папка отброшена');
});

test('переменная шаблона в команде условия — ошибка, шаблон Go — нет', () => {
  const spec = (run: string): FlowSpec =>
    FlowSchema.parse({ name: 'x', loop: { max_iterations: 2, until: { type: 'command', run } }, phases: [{ name: 'a', prompt: 'p', tools: [] }] });
  assert.throws(() => validateReferences(spec("! grep -n '^- \\[ \\]' {{artifacts.plan.path}}")), /\{\{artifacts\.plan\.path\}\} — в команде переменные шаблона не подставляются/);
  assert.doesNotThrow(() => validateReferences(spec("docker inspect --format '{{.State.Status}}' db | grep -q running")));
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
