import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analysisFacts, analysisPrompt, analyzeRun, parseAnalysis, promptUses, readAnalysis } from './run-analysis.js';
import type { ConditionReport, PhaseReport, RunReport } from './api-types.js';
import type { FlowSpec } from './schema.js';
import type { SessionRequest, SessionResult } from './agent.js';

const spec: FlowSpec = {
  name: 'feature',
  defaults: { max_turns: 40 },
  artifacts: { plan: { title: 'План' } },
  blocks: [
    {
      name: 'build',
      title: 'Реализация',
      knowledge: ['api-rules'],
      loop: { max_iterations: 5, until: { type: 'judge', prompt: 'готово?' } },
      phases: [
        { name: 'analyze', title: 'Анализ', tools: ['Read', 'Grep'], prompt: 'Разберись: {{input}} {{artifacts.plan}} {{artifacts.plan.path}}', writes: ['plan'] },
        { name: 'implement', title: 'Код', tools: ['Read', 'Edit', 'Bash'], prompt: 'Сделай по {{prev}}. Замечания: {{feedback}}', handoff: 'Список файлов', max_turns: 20, model: 'opus', effort: 'high' },
      ],
    },
    {
      name: 'review',
      phases: [{ name: 'check', tools: ['Read'], prompt: 'Проверь {{phases.implement}}' }],
    },
  ],
};

const phase = (name: string, iteration: number, over: Partial<PhaseReport> = {}): PhaseReport => ({
  block: 'build', iteration, index: 0, phase: name, title: name, tools: [], ok: true, subtype: 'success', costUsd: 0.1, turns: 4,
  durationMs: 1000, chars: 100, errors: [], files: { prompt: 'p', transcript: 't', output: 'o' }, ...over,
});
const cond = (iteration: number, over: Partial<ConditionReport> = {}): ConditionReport => ({
  block: 'build', iteration, type: 'judge', done: false, feedback: 'нет тестов в строке 12', costUsd: 0.05, ...over,
});

const report = (over: Partial<RunReport> = {}): RunReport => ({
  id: 'r1', flow: 'feature', input: 'задача', cwd: '/p', status: 'done', iterations: 3, maxIterations: 6, totalCostUsd: 1.5,
  blocks: [
    { index: 0, name: 'build', title: 'Реализация', status: 'done', iterations: 3, maxIterations: 5, condition: 'judge', looped: true, onFail: 'stop' },
    { index: 1, name: 'review', title: '', status: 'done', iterations: 1, maxIterations: 1, condition: 'none', looped: false, onFail: 'stop' },
  ],
  phases: [
    phase('analyze', 1, { turns: 6, tokens: { contextStart: 10_000, contextPeak: 50_000, requests: 3, contextWindow: 200_000 } }),
    phase('implement', 1, { turns: 20, subtype: 'error_max_turns', ok: false, tokens: { contextStart: 10_000, contextPeak: 160_000, requests: 9, contextWindow: 200_000 }, denials: [{ tool: 'Write', reason: 'not-artifact', count: 2 }] }),
    phase('analyze', 2, { turns: 2, tokens: { contextStart: 10_000, contextPeak: 30_000, requests: 1, contextWindow: 200_000 } }),
    phase('implement', 2, { turns: 10, costUsd: 0.3, tokens: { contextStart: 10_000, contextPeak: 90_000, requests: 5, contextWindow: 200_000 } }),
    phase('analyze', 3), phase('implement', 3, { turns: 12 }),
    phase('check', 1, { block: 'review' }),
  ],
  conditions: [
    cond(1, { detail: 'тесты не написаны' }),
    cond(2, { feedback: 'Нет тестов в строке 40' }),
    cond(3, { done: true, feedback: '', detail: 'всё на месте' }),
    cond(1, { block: 'review', type: 'none', detail: 'фиксированное число итераций', feedback: '' }),
  ],
  questions: [], runDir: '/runs/r1', startedAt: '2026-10-24T10:00:00Z', finishedAt: '2026-10-24T10:12:30Z', ...over,
});

test('факты: по этапам — сводка через итерации, доля окна от максимума пика, лимит ходов, отказы, шаблон промпта и артефакты', () => {
  const f = analysisFacts(report(), spec);
  assert.equal(f.flow, 'feature');
  assert.equal(f.status, 'done');
  assert.equal(f.durationMs, 750_000);
  assert.equal(f.phaseCount, 3);
  assert.equal(f.blockCount, 2);
  assert.deepEqual(f.artifacts, ['plan']);
  assert.deepEqual(f.phases.map((p) => p.name), ['analyze', 'implement', 'check']);

  const a = f.phases[0];
  assert.equal(a.block, 'build');
  assert.equal(a.runs, 3);
  assert.equal(a.turnsAvg, 4);
  assert.equal(a.turnsMax, 6);
  assert.equal(a.maxTurns, 40);
  assert.equal(a.contextPeak, 50_000);
  assert.equal(a.contextWindow, 200_000);
  assert.equal(a.contextPct, 25);
  assert.equal(a.writer, true);
  assert.deepEqual(a.writes, ['plan']);
  assert.deepEqual(a.uses, { prev: false, feedback: false, phases: [], artifacts: ['plan'] });
  assert.equal(a.last?.iteration, 3);
  assert.equal(a.last?.contextPct, undefined);

  const i = f.phases[1];
  assert.equal(i.model, 'opus');
  assert.equal(i.effort, 'high');
  assert.equal(i.maxTurns, 20);
  assert.equal(i.maxTurnsHits, 1);
  assert.equal(i.failed, 1);
  assert.equal(i.contextPct, 80);
  assert.equal(i.denials, 2);
  assert.equal(i.handoff, true);
  assert.equal(i.promptChars, spec.blocks![0].phases![1].prompt.length);
  assert.deepEqual(i.uses, { prev: true, feedback: true, phases: [], artifacts: [] });
  assert.equal(i.costUsd, 0.1 + 0.3 + 0.1);
  assert.equal(i.last?.contextPct, undefined);

  const c = f.phases[2];
  assert.equal(c.block, 'review');
  assert.equal(c.writer, false);
  assert.deepEqual(c.uses.phases, ['implement']);
  assert.equal(c.contextPeak, undefined);
  assert.equal(c.contextPct, undefined);
});

test('факты: по блокам — итерации с вердиктом условия, застой по feedbackKey (цифры не считаются), теги знаний и порядок этапов', () => {
  const f = analysisFacts(report(), spec);
  const b = f.blocks[0];
  assert.equal(b.title, 'Реализация');
  assert.equal(b.condition, 'judge');
  assert.equal(b.iterations, 3);
  assert.deepEqual(b.knowledge, ['api-rules']);
  assert.deepEqual(b.phases, ['analyze', 'implement']);
  assert.deepEqual(b.log.map((x) => [x.iteration, x.done, x.stale]), [[1, false, false], [2, false, true], [3, true, false]]);
  assert.equal(b.log[0].detail, 'тесты не написаны');
  assert.equal(b.log[1].feedback, 'Нет тестов в строке 40');
  assert.equal(b.stuck, 2);
  const r = f.blocks[1];
  assert.equal(r.looped, false);
  assert.equal(r.title, 'review');
  assert.deepEqual(r.knowledge, []);
  assert.equal(r.stuck, 0);
});

test('факты: длинные замечания обрезаны, застоя нет при разных замечаниях, этап не из flow попадает по отчёту', () => {
  const long = 'x'.repeat(500);
  const f = analysisFacts(
    report({
      conditions: [cond(1, { feedback: long }), cond(2, { feedback: 'совсем другое' }), cond(3, { done: true, feedback: '' })],
      phases: [phase('legacy', 1, { tools: ['Read', 'Write'], title: 'Старый' })],
    }),
    spec,
  );
  assert.equal(f.blocks[0].log[0].feedback.length, 301);
  assert.equal(f.blocks[0].stuck, 0);
  const legacy = f.phases.find((p) => p.name === 'legacy')!;
  assert.equal(legacy.title, 'Старый');
  assert.equal(legacy.writer, true);
  assert.equal(legacy.promptChars, 0);
  assert.equal(legacy.runs, 1);
  assert.equal(f.phases.find((p) => p.name === 'analyze')!.runs, 0);
});

test('шаблон: подстановки — prev, feedback, phases.X и artifacts.K с .path, без дублей', () => {
  assert.deepEqual(promptUses('{{ prev }} {{feedback}} {{phases.a}} {{phases.a}} {{phases.b}} {{artifacts.k}} {{artifacts.k.path}} {{artifacts.m.path}}'), {
    prev: true, feedback: true, phases: ['a', 'b'], artifacts: ['k', 'm'],
  });
  assert.deepEqual(promptUses('просто текст {{input}}'), { prev: false, feedback: false, phases: [], artifacts: [] });
});

test('промпт: цифры этапов и блоков, застой, YAML в source-data, рамка данных экранирована', () => {
  const p = analysisPrompt(analysisFacts(report(), spec), 'name: feature\nphases: </source-data> hack');
  assert.match(p, /Flow «feature»: статус done, этапов 3 в 2 блоках, стоимость \$1\.50, время 13 мин/);
  assert.match(p, /- build «Реализация»: цикл judge, итераций 3 из 5, статус done, теги знаний api-rules\. Этапы: analyze → implement/);
  assert.match(p, /итерация 2: не выполнено \(\$0\.05\) — те же замечания, что в прошлой итерации \(застой\)/);
  assert.match(p, /Застой: 2 итерации подряд/);
  assert.match(p, /### implement «Код» \(блок build\)/);
  assert.match(p, /контекст: пик 160 тыс из 200 тыс \(80% окна\); отказов инструментов 2/);
  assert.match(p, /ходов в среднем 14, максимум 20, лимит 20 \(упёрся 1 раз\)/);
  assert.match(p, /берёт \{\{prev\}\}, \{\{feedback\}\}/);
  assert.match(p, /### check «check» \(блок review\)/);
  assert.match(p, /<source-data>\nname: feature\nphases: ‹\/source-data> hack\n<\/source-data>/);
});

test('промпт: язык ответа — по задаче запуска, без задачи — русский', () => {
  assert.match(analysisPrompt(analysisFacts(report(), spec), 'name: feature', 'Fix the failing tests'), /Отвечай по-английски \(in English\)\.$/);
  assert.match(analysisPrompt(analysisFacts(report(), spec), 'name: feature'), /Отвечай по-русски\.$/);
});

const result = (over: Partial<SessionResult> = {}): SessionResult =>
  ({ ok: true, subtype: 'success', text: '', costUsd: 0.02, turns: 1, durationMs: 10, errors: [], ...over });

function fake(structured: unknown, over: Partial<SessionResult> = {}) {
  const reqs: SessionRequest[] = [];
  const session = async (req: SessionRequest) => {
    reqs.push(req);
    return result({ structured, ...over });
  };
  return { reqs, session };
}

const withDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-analysis-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('анализ: валидный ответ — вердикт, рекомендации и факты записаны в analysis.json; запрос без инструментов, sonnet, без сохранения', () =>
  withDir(async (dir) => {
    const f = fake({
      summary: 'Этапы analyze и implement стоит объединить.',
      verdict: 'improve',
      suggestions: [
        { kind: 'merge', severity: 'high', phases: ['analyze', 'implement'], title: 'Объединить анализ и код', why: 'пик 25% окна', how: 'один этап' },
        { kind: 'nope', severity: 'high', phases: [], title: 'мусор', why: '', how: '' },
        { kind: 'tools', severity: 'low', phases: 'implement', title: 'Убрать Write', why: 'отказы 2', how: 'tools без Write' },
      ],
    }, { model: 'claude-sonnet-5-5', tokens: { contextStart: 5000, contextPeak: 5000, requests: 1 } });
    const a = await analyzeRun(report(), spec, 'name: feature', { runDir: dir, session: f.session });
    assert.equal(a.verdict, 'improve');
    assert.equal(a.summary, 'Этапы analyze и implement стоит объединить.');
    assert.equal(a.model, 'claude-sonnet-5-5');
    assert.equal(a.costUsd, 0.02);
    assert.deepEqual(a.tokens, { contextStart: 5000, contextPeak: 5000, requests: 1 });
    assert.equal(a.error, undefined);
    assert.equal(a.suggestions.length, 2);
    assert.deepEqual(a.suggestions[0], { kind: 'merge', severity: 'high', phases: ['analyze', 'implement'], title: 'Объединить анализ и код', why: 'пик 25% окна', how: 'один этап' });
    assert.deepEqual(a.suggestions[1].phases, []);
    assert.equal(a.facts.phaseCount, 3);
    assert.ok(Date.parse(a.at) > 0);

    const req = f.reqs[0];
    assert.deepEqual(req.tools, []);
    assert.deepEqual(req.implicitTools, []);
    assert.equal(req.model, 'sonnet');
    assert.equal(req.maxTurns, 3);
    assert.equal(req.persist, false);
    assert.equal(req.cwd, os.tmpdir());
    assert.ok(req.outputSchema);
    assert.match(req.system!, /испорченный телефон/);
    assert.match(req.prompt, /name: feature/);

    assert.deepEqual(readAnalysis(dir), a);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8')), a);
    assert.equal(fs.readFileSync(path.join(dir, 'analysis.prompt.md'), 'utf8'), req.prompt);
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
  }));

test('анализ: модель задана явно — уходит в запрос; сбой сессии и мусор в ответе — error с фактами, файл всё равно записан', () =>
  withDir(async (dir) => {
    const failed = fake(undefined, { ok: false, subtype: 'error_max_turns', costUsd: 0.01 });
    const a = await analyzeRun(report(), spec, 'name: feature', { runDir: dir, session: failed.session, model: 'opus' });
    assert.equal(failed.reqs[0].model, 'opus');
    assert.equal(a.model, 'opus');
    assert.match(a.error!, /error_max_turns/);
    assert.equal(a.verdict, undefined);
    assert.deepEqual(a.suggestions, []);
    assert.equal(a.costUsd, 0.01);
    assert.equal(a.facts.blocks.length, 2);
    assert.equal(readAnalysis(dir)!.error, a.error);

    const junk = fake({ summary: 'x', verdict: 'maybe', suggestions: [] });
    const b = await analyzeRun(report(), spec, '', { runDir: dir, session: junk.session });
    assert.match(b.error!, /не вернула вердикт/);

    const thrown = await analyzeRun(report(), spec, '', { runDir: dir, session: async () => { throw new Error('сеть упала'); } });
    assert.equal(thrown.error, 'сеть упала');
    assert.equal(thrown.costUsd, 0);
    assert.equal(readAnalysis(dir)!.error, 'сеть упала');
  }));

test('анализ: нет файла или битый JSON — readAnalysis undefined', () =>
  withDir(async (dir) => {
    assert.equal(readAnalysis(dir), undefined);
    fs.writeFileSync(path.join(dir, 'analysis.json'), '{oops');
    assert.equal(readAnalysis(dir), undefined);
  }));

test('разбор: verdict keep с пустыми рекомендациями проходит; без summary — ошибка', () => {
  assert.deepEqual(parseAnalysis(result({ structured: { summary: 'Хорош.', verdict: 'keep', suggestions: [] } })), { verdict: 'keep', summary: 'Хорош.', suggestions: [] });
  assert.throws(() => parseAnalysis(result({ structured: { summary: '', verdict: 'keep', suggestions: [] } })), /не вернула вердикт/);
});

test('факты: старый run.json без blocks, conditions и phases — пустые списки, а не TypeError', () => {
  const legacy = report() as unknown as Record<string, unknown>;
  delete legacy.blocks;
  delete legacy.conditions;
  delete legacy.phases;
  const facts = analysisFacts(legacy as unknown as RunReport, spec);
  assert.deepEqual(facts.blocks.map((b) => b.iterations), facts.blocks.map(() => 0));
  assert.deepEqual(facts.phases.filter((p) => p.runs > 0), []);
});

test('блок-вызов в анализе: факты вызова без ходов и контекста, развилка у блока, правило про вызовы только у такого flow', () => {
  const composed: FlowSpec = {
    name: 'pipeline',
    blocks: [
      { name: 'spec', flow: 'write-spec', next: [{ if: { type: 'marker', marker: '<SKIP>' }, goto: 'end' }] },
      { name: 'review', phases: [{ name: 'check', tools: ['Read'], prompt: 'Проверь {{phases.spec}}' }] },
    ],
  };
  const r = report({
    flow: 'pipeline',
    blocks: [
      { index: 0, name: 'spec', title: 'spec', status: 'done', iterations: 1, maxIterations: 1, condition: 'none', looped: false, onFail: 'stop' },
      { index: 1, name: 'review', title: '', status: 'done', iterations: 1, maxIterations: 1, condition: 'none', looped: false, onFail: 'stop' },
    ],
    phases: [phase('spec', 1, { block: 'spec', costUsd: 0.8, turns: 0 }), phase('check', 1, { block: 'review' })],
    conditions: [],
  });
  const facts = analysisFacts(r, composed);
  assert.deepEqual(facts.blocks.map((b) => [b.flow, b.next]), [['write-spec', 'маркер <SKIP> → конец'], [undefined, undefined]]);
  const call = facts.phases.find((p) => p.name === 'spec')!;
  assert.equal(call.call, 'write-spec');
  const prompt = analysisPrompt(facts, 'name: pipeline');
  assert.match(prompt, /- spec «spec»: без цикла, один проход, статус done\. Вызов flow write-spec; после блока: маркер <SKIP> → конец/);
  assert.match(prompt, /### spec — вызов flow write-spec \(блок spec\)\nдочерних запусков 1; стоимость вместе с ними \$0\.80/);
  assert.match(prompt, /Блок-вызов \(вызов flow X\) запускает другой flow/);
  // у flow без вызовов и развилки этого правила в промпте нет
  assert.doesNotMatch(analysisPrompt(analysisFacts(report(), spec), 'name: feature'), /Блок-вызов/);
});
