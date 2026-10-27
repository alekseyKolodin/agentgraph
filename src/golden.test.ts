// Золотые тесты: точное поведение раннера для flow без артефактов (AC-G1).
// Написаны до артефактов и не меняются вместе с ними: промпты этапов и судьи, опции сессии, run.json и папка запуска
// у такого flow должны остаться байт в байт прежними.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionOptions, type SessionRequest, type SessionResult } from './agent.js';
import { buildRequest, judgeRequest, renderPhasePrompt, runFlow, type RunEvent } from './runner.js';
import type { FlowSpec, Phase } from './schema.js';
import { emptyContext } from './template.js';

const ctx = () => ({
  ...emptyContext('сделать X', 3),
  prev: 'ПРЕДЫДУЩИЙ',
  feedback: 'ЗАМЕЧАНИЯ',
  iteration: 2,
  outputs: 'ВЫВОДЫ',
  history: 'ИСТОРИЯ',
  phases: { a: 'ВЫВОД-A' },
});

const fullPhase: Phase = {
  name: 'impl',
  title: 'Реализация',
  prompt: 'Задача: {{input}}\nprev={{prev}}\nfb={{feedback}}\nit={{iteration}}/{{max_iterations}}\na={{phases.a}}\nnope={{phases.nope}}\nunknown={{unknown}}\nart={{artifacts.plan}}\n\n',
  handoff: '  раздел «## Результат» для итерации {{iteration}}  ',
  tools: ['Read', 'Edit'],
  add_dirs: ['/qa', '~/rules'],
};

test('золотой: промпт этапа с handoff, доп. директориями этапа и запуска и вложениями', () => {
  const text = renderPhasePrompt(fullPhase, ctx(), '/work', { runDir: '/runs/r1', addDirs: ['/qa', 'shared'], attachments: ['attachments/a.png', 'attachments/b.txt'] });
  assert.equal(
    text,
    'Задача: сделать X\nprev=ПРЕДЫДУЩИЙ\nfb=ЗАМЕЧАНИЯ\nit=2/3\na=ВЫВОД-A\nnope=\nunknown={{unknown}}\nart={{artifacts.plan}}' +
      '\n\nЧем закончить ответ (это уйдёт следующему этапу): раздел «## Результат» для итерации 2' +
      `\n\nКроме директории проекта тебе доступны (правила, инструкции, скиллы — сверяйся с ними):\n- /qa\n- ${path.join(os.homedir(), 'rules')}\n- /work/shared` +
      '\n\nВложения к задаче (открой инструментом Read):\n- /runs/r1/attachments/a.png\n- /runs/r1/attachments/b.txt',
  );
});

test('золотой: промпт этапа без хвостов не меняется', () => {
  const plain: Phase = { name: 'a', prompt: 'Только {{input}}\n', tools: [] };
  assert.equal(renderPhasePrompt(plain, ctx()), 'Только сделать X\n');
  assert.equal(renderPhasePrompt(plain, ctx(), '/work', { runDir: '/runs/r1' }), 'Только сделать X\n');
});

const spec = (p: Phase, defaults?: FlowSpec['defaults']): FlowSpec => ({ name: 'g', phases: [p], ...(defaults ? { defaults } : {}) }) as FlowSpec;

test('золотой: запрос сессии этапа — ровно эти поля', () => {
  const p: Phase = { ...fullPhase, effort: 'high', max_turns: 7, permission_mode: 'acceptEdits', output_schema: { type: 'object' } };
  const req = buildRequest(spec(p, { model: 'm-default', max_budget_usd: 2 }), p, 'PROMPT', {
    cwd: '/work',
    runsDir: '/runs',
    runDir: '/runs/r1',
    addDirs: ['/extra'],
    attachments: ['attachments/a.png'],
    model: 'm-run',
  });
  assert.deepStrictEqual(req, {
    prompt: 'PROMPT',
    cwd: '/work',
    additionalDirectories: ['/qa', path.join(os.homedir(), 'rules'), '/extra', '/runs/r1/attachments'],
    system: undefined,
    tools: ['Read', 'Edit'],
    model: 'm-default',
    effort: 'high',
    maxTurns: 7,
    maxBudgetUsd: 2,
    permissionMode: 'acceptEdits',
    outputSchema: { type: 'object' },
    persist: true,
    foreground: true,
    abort: undefined,
  });
});

/** Ключи env, которые сессия добавляет к process.env, с их значениями. */
const envExtras = (env: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(Object.entries(env ?? {}).filter(([k, v]) => process.env[k] !== v).sort(([a], [b]) => a.localeCompare(b)));

test('золотой: опции SDK этапа — инструменты, разрешения, директории, без хуков', () => {
  const p: Phase = { ...fullPhase, tools: ['Read', 'Edit', 'Bash', 'AskUserQuestion'] };
  const o = sessionOptions(buildRequest(spec(p), p, 'PROMPT', { cwd: '/work', runsDir: '/runs', runDir: '/runs/r1', attachments: ['attachments/a.png'] }));
  const { env, ...rest } = o;
  assert.deepStrictEqual(rest, {
    cwd: '/work',
    persistSession: true,
    permissionMode: 'default',
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    additionalDirectories: ['/qa', path.join(os.homedir(), 'rules'), '/runs/r1/attachments'],
    tools: ['Read', 'Edit', 'Bash', 'AskUserQuestion', 'Agent', 'Skill'],
    allowedTools: ['Read', 'Edit', 'Bash', 'Agent', 'Skill'],
  });
  assert.deepStrictEqual(envExtras(env), {
    BASH_DEFAULT_TIMEOUT_MS: '1800000',
    BASH_MAX_TIMEOUT_MS: '3600000',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'agentgraph/0.1.0',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  });
  assert.equal(o.hooks, undefined);
  assert.equal(o.canUseTool, undefined);
});

test('золотой: этап без инструментов и директорий — без доп. директорий и с Agent и Skill', () => {
  const p: Phase = { name: 'think', prompt: 'x', tools: [] };
  const o = sessionOptions(buildRequest(spec(p), p, 'x', { cwd: '/work', runsDir: '/runs' }));
  assert.equal(o.additionalDirectories, undefined);
  assert.deepStrictEqual(o.tools, ['Agent', 'Skill']);
  assert.deepStrictEqual(o.allowedTools, ['Agent', 'Skill']);
  assert.equal(o.hooks, undefined);
  assert.deepStrictEqual(Object.keys(envExtras(o.env)), ['BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'ENABLE_CLAUDEAI_MCP_SERVERS']);
});

test('золотой: запрос судьи — ровно эти поля', () => {
  const until = { type: 'judge' as const, prompt: 'Оцени', model: 'm-judge' };
  const withFiles = judgeRequest(spec(fullPhase), until, 'Рубрика {{x}}', { cwd: '/work', runsDir: '/runs', runDir: '/runs/r1', addDirs: ['/extra'], attachments: ['attachments/a.png'] });
  const { system, outputSchema, ...rest } = withFiles;
  assert.deepStrictEqual(rest, {
    prompt: 'Рубрика {{x}}\n\nВложения к задаче (открой инструментом Read):\n- /runs/r1/attachments/a.png',
    cwd: '/work',
    additionalDirectories: ['/runs/r1/attachments'],
    tools: ['Read', 'Grep', 'Glob'],
    model: 'm-judge',
    maxTurns: 30,
    persist: false,
    foreground: true,
    abort: undefined,
  });
  assert.match(system, /^Ты строгий приёмщик результата/);
  assert.match(system, /Пиши reason и feedback по-русски, если рубрика не требует другого языка\.$/);
  assert.match(judgeRequest(spec(fullPhase), until, 'x', { cwd: '/work', runsDir: '/runs' }, undefined, undefined, 'Implement BILL-142').system, /Пиши reason и feedback по-английски \(in English\), если рубрика/);
  assert.deepStrictEqual(Object.keys(outputSchema), ['type', 'properties', 'required', 'additionalProperties']);
  const bare = judgeRequest(spec(fullPhase, { model: 'm-def' }), { type: 'judge', prompt: 'x' }, 'Оцени', { cwd: '/work', runsDir: '/runs' });
  assert.equal(bare.prompt, 'Оцени');
  assert.deepStrictEqual(bare.additionalDirectories, []);
  assert.equal(bare.model, 'm-def');
  const o = sessionOptions(bare);
  assert.equal(o.hooks, undefined);
  assert.equal(o.additionalDirectories, undefined);
  assert.deepStrictEqual(o.tools, ['Read', 'Grep', 'Glob', 'Agent', 'Skill']);
});

// --- прогон с сессиями-заглушками: промпты, запросы, run.json, папка запуска, события

const nameOf = (req: SessionRequest) => (req.prompt.startsWith('JUDGE') ? 'judge' : req.prompt.split('\n')[0].slice('PHASE:'.length));

function stub() {
  const calls: { name: string; prompt: string; keys: string[] }[] = [];
  const session = async (req: SessionRequest): Promise<SessionResult> => {
    const name = nameOf(req);
    calls.push({ name, prompt: req.prompt, keys: Object.keys(req).sort() });
    const base = { ok: true, subtype: 'success', costUsd: 0.01, turns: 1, durationMs: 5, sessionId: `s-${name}`, errors: [] };
    if (name === 'judge') {
      const done = req.prompt.includes('итерация 2');
      return { ...base, text: '', structured: { done, reason: done ? 'готово' : 'нет', feedback: done ? '' : 'доделай' } };
    }
    return { ...base, text: `out-${name}` };
  };
  return { calls, session };
}

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-golden-')));

function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

const sortedKeys = (o: object) => Object.keys(o).sort();
const P = (name: string, body = 'prev=[{{prev}}]', extra: Partial<Phase> = {}): Phase => ({ name, prompt: `PHASE:${name}\n${body}`, tools: [], ...extra });

const multiFlow = (): FlowSpec =>
  ({
    name: 'golden',
    input: 'задача',
    blocks: [
      { name: 'spec', phases: [P('a', 'in={{input}}', { handoff: 'итог' })] },
      {
        name: 'impl',
        loop: { max_iterations: 3, until: { type: 'judge', prompt: 'JUDGE итерация {{iteration}}\n{{outputs}}' } },
        phases: [
          P('b', 'prev=[{{prev}}] fb=[{{feedback}}]', { group: 'g' }),
          P('c', 'prev=[{{prev}}]', { group: 'g', tools: ['Read'] }),
          P('d', 'prev=[{{prev}}] a=[{{phases.a}}]'),
        ],
      },
    ],
  }) as FlowSpec;

test('золотой: многоблочный прогон — промпты, запросы, run.json, файлы, события', async () => {
  const dir = tmp();
  try {
    const { calls, session } = stub();
    const events: RunEvent[] = [];
    const runDir = path.join(dir, 'runs', 'r1');
    const report = await runFlow(multiFlow(), { cwd: dir, runsDir: path.join(dir, 'runs'), runDir, session, onEvent: (e) => events.push(e) });
    assert.equal(report.status, 'done');

    // участники группы стартуют вместе: порядок вызовов внутри группы не важен
    const byName = (n: string) => calls.filter((c) => c.name === n).map((c) => c.prompt);
    assert.deepStrictEqual(byName('a'), ['PHASE:a\nin=задача\n\nЧем закончить ответ (это уйдёт следующему этапу): итог']);
    assert.deepStrictEqual(byName('b'), ['PHASE:b\nprev=[out-a] fb=[]', 'PHASE:b\nprev=[out-d] fb=[доделай]']);
    assert.deepStrictEqual(byName('c'), ['PHASE:c\nprev=[out-a]', 'PHASE:c\nprev=[out-d]']);
    assert.deepStrictEqual(byName('d'), ['PHASE:d\nprev=[### b\nout-b\n\n### c\nout-c] a=[out-a]', 'PHASE:d\nprev=[### b\nout-b\n\n### c\nout-c] a=[out-a]']);
    assert.deepStrictEqual(byName('judge'), [
      'JUDGE итерация 1\n### b\nout-b\n\n### c\nout-c\n\n### d\nout-d',
      'JUDGE итерация 2\n### b\nout-b\n\n### c\nout-c\n\n### d\nout-d',
    ]);
    const phaseKeys = ['abort', 'additionalDirectories', 'cwd', 'effort', 'foreground', 'maxBudgetUsd', 'maxTurns', 'model', 'onContext', 'onModel', 'onQuestion', 'outputSchema', 'permissionMode', 'persist', 'prompt', 'system', 'tools'];
    for (const c of calls) {
      if (c.name === 'judge') assert.deepStrictEqual(c.keys, ['abort', 'additionalDirectories', 'cwd', 'foreground', 'maxTurns', 'model', 'outputSchema', 'persist', 'prompt', 'system', 'tools']);
      else assert.deepStrictEqual(c.keys, phaseKeys, c.name);
    }

    const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.deepStrictEqual(sortedKeys(saved), [
      'blocks', 'conditions', 'cwd', 'final', 'finishedAt', 'flow', 'id', 'input', 'iterations', 'maxIterations', 'phases', 'pid', 'questions', 'runDir', 'startedAt', 'status', 'totalCostUsd',
    ]);
    assert.deepStrictEqual(sortedKeys(saved.phases[0]), ['block', 'chars', 'costUsd', 'durationMs', 'errors', 'files', 'index', 'iteration', 'ok', 'phase', 'sessionId', 'subtype', 'title', 'tools', 'turns']);
    assert.deepStrictEqual(sortedKeys(saved.phases.find((p: { group?: string }) => p.group)), ['block', 'chars', 'costUsd', 'durationMs', 'errors', 'files', 'group', 'index', 'iteration', 'ok', 'phase', 'sessionId', 'subtype', 'title', 'tools', 'turns']);
    assert.deepStrictEqual(sortedKeys(saved.conditions[0]), ['block', 'costUsd', 'detail', 'done', 'feedback', 'iteration', 'logFile', 'type']);
    assert.deepStrictEqual(sortedKeys(saved.blocks[1]), ['condition', 'index', 'iterations', 'looped', 'maxIterations', 'name', 'onFail', 'status', 'title']);
    assert.equal(saved.iterations, 3);
    assert.equal(saved.totalCostUsd.toFixed(2), '0.09');

    const iter = (n: number) => [
      `02-impl/iter-0${n}/01-b.output.md`, `02-impl/iter-0${n}/01-b.prompt.md`, `02-impl/iter-0${n}/01-b.transcript.md`,
      `02-impl/iter-0${n}/02-c.output.md`, `02-impl/iter-0${n}/02-c.prompt.md`, `02-impl/iter-0${n}/02-c.transcript.md`,
      `02-impl/iter-0${n}/03-d.output.md`, `02-impl/iter-0${n}/03-d.prompt.md`, `02-impl/iter-0${n}/03-d.transcript.md`,
      `02-impl/iter-0${n}/condition.json`, `02-impl/iter-0${n}/condition.judge.prompt.md`,
    ];
    assert.deepStrictEqual(listing(runDir), [
      '01-spec/iter-01/01-a.output.md', '01-spec/iter-01/01-a.prompt.md', '01-spec/iter-01/01-a.transcript.md',
      ...iter(1), ...iter(2),
      'flow.yaml', 'run.json',
    ]);
    assert.deepStrictEqual(listing(dir), listing(runDir).map((f) => `runs/r1/${f}`));

    const types = events.filter((e) => e.type !== 'log').map((e) => e.type);
    const iterEvents = ['iteration', 'phase_start', 'phase_start', 'phase_end', 'phase_end', 'phase_start', 'phase_end', 'condition_start', 'condition'];
    assert.deepStrictEqual(types, [
      'start',
      'block_start', 'iteration', 'phase_start', 'phase_end', 'block_end',
      'block_start', ...iterEvents, ...iterEvents, 'block_end',
      'end',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('золотой: короткая форма — логи в iter-NN/ без папки блока', async () => {
  const dir = tmp();
  try {
    const { calls, session } = stub();
    const runDir = path.join(dir, 'r');
    const flow = { name: 'short', loop: { max_iterations: 2, until: { type: 'none' } }, phases: [P('x'), P('y')] } as FlowSpec;
    const report = await runFlow(flow, { cwd: dir, runsDir: dir, runDir, session });
    assert.equal(report.status, 'done');
    assert.deepStrictEqual(calls.map((c) => c.prompt), ['PHASE:x\nprev=[]', 'PHASE:y\nprev=[out-x]', 'PHASE:x\nprev=[out-y]', 'PHASE:y\nprev=[out-x]']);
    const files = (n: number) => ['01-x.output.md', '01-x.prompt.md', '01-x.transcript.md', '02-y.output.md', '02-y.prompt.md', '02-y.transcript.md', 'condition.json'].map((f) => `iter-0${n}/${f}`);
    assert.deepStrictEqual(listing(runDir), ['flow.yaml', ...files(1), ...files(2), 'run.json']);
    assert.equal(fs.readFileSync(path.join(runDir, 'flow.yaml'), 'utf8'), 'name: short\nloop:\n  max_iterations: 2\n  until:\n    type: none\nphases:\n  - name: x\n    prompt: |-\n      PHASE:x\n      prev=[{{prev}}]\n    tools: []\n  - name: y\n    prompt: |-\n      PHASE:y\n      prev=[{{prev}}]\n    tools: []\n');
    const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.deepStrictEqual(sortedKeys(saved), [
      'blocks', 'conditions', 'cwd', 'final', 'finishedAt', 'flow', 'id', 'input', 'iterations', 'maxIterations', 'phases', 'pid', 'questions', 'runDir', 'startedAt', 'status', 'totalCostUsd',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
