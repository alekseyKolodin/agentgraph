import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFlow, type RunOptions } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';
import { createTag, readTag, tagDir, updateTag, writeTagSummary } from './tags.js';
import { contextOptions } from './context.js';

const result = (text: string, over: Partial<SessionResult> = {}): SessionResult =>
  ({ ok: true, subtype: 'success', text, costUsd: 0.01, turns: 1, durationMs: 10, errors: [], ...over });

const isSummary = (req: SessionRequest) => Boolean(req.outputSchema && 'summary' in ((req.outputSchema as { properties?: object }).properties ?? {}));
const isJudge = (req: SessionRequest) => Boolean(req.outputSchema && 'done' in ((req.outputSchema as { properties?: object }).properties ?? {}));

/** Два блока: у первого тег знаний qa, у второго — нет. */
const spec = (first: Record<string, unknown> = { knowledge: ['qa'] }, second: Record<string, unknown> = {}) =>
  ({
    name: 'known',
    input: 'задача',
    blocks: [
      { name: 'one', phases: [{ name: 'work', tools: [], prompt: 'сделай {{input}}' }], ...first },
      { name: 'two', phases: [{ name: 'check', tools: [], prompt: 'проверь {{prev}}' }], ...second },
    ],
  }) as unknown as FlowSpec;

/** Временный каталог настроек (теги) и папка запусков; fn получает опции запуска. */
function withEnv(fn: (o: RunOptions, root: string) => Promise<void>) {
  return async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-knowledge-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = path.join(root, 'cfg');
    try {
      await fn({ cwd: root, runsDir: root, runDir: path.join(root, 'run') }, root);
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function fake() {
  const reqs: SessionRequest[] = [];
  const session = async (req: SessionRequest): Promise<SessionResult> => {
    reqs.push(req);
    if (isSummary(req)) return result('', { structured: { summary: 'Суть: новое' } });
    if (isJudge(req)) return result('', { structured: { done: true, reason: '', feedback: '' } });
    return result('out');
  };
  return { reqs, session, phase: (name: string) => reqs.find((r) => !r.outputSchema && r.prompt.startsWith(name))! };
}

const saved = (o: RunOptions) => JSON.parse(fs.readFileSync(path.join(o.runDir!, 'run.json'), 'utf8'));

/** Тег знаний qa с заметками, путём и вложением. */
function qaTag(root: string) {
  const dir = path.join(root, 'qa-rules');
  fs.mkdirSync(dir, { recursive: true });
  createTag('qa', 'Правила QA', 'knowledge');
  updateTag('qa', { notes: 'Проверяй граничные значения', dirs: [dir, path.join(root, 'нет')] });
  const attach = path.join(tagDir('qa'), 'attachments');
  fs.mkdirSync(attach, { recursive: true });
  fs.writeFileSync(path.join(attach, 'cases.md'), '# кейсы');
  return { dir, attach };
}

test(
  'знания: блок с knowledge — раздел и папки у его этапов, у соседнего блока нет; run.json с knowledge без tagSummaries',
  withEnv(async (o, root) => {
    const { dir, attach } = qaTag(root);
    const f = fake();
    const r = await runFlow(spec(), { ...o, session: f.session });
    assert.equal(r.status, 'done');
    const work = f.phase('сделай');
    assert.match(work.prompt, /Область знаний qa — Правила QA\nПроверяй граничные значения/);
    assert.ok(work.prompt.includes(`Пути (только чтение): ${dir}`), work.prompt);
    assert.ok(!work.prompt.includes(path.join(root, 'нет')));
    assert.ok(work.prompt.includes(path.join(attach, 'cases.md')));
    assert.ok(!work.prompt.includes('<source-data>'));
    assert.ok(work.additionalDirectories!.includes(dir));
    assert.ok(work.additionalDirectories!.includes(attach));
    const check = f.phase('проверь');
    assert.ok(!check.prompt.includes('Область знаний'));
    assert.ok(!check.additionalDirectories!.includes(dir));
    // сессии саммари нет, в run.json только knowledge
    assert.equal(f.reqs.filter(isSummary).length, 0);
    const s = saved(o);
    assert.equal('knowledge' in s, false);
    assert.equal('tagSummaries' in s, false);
  }),
);

test(
  'знания: тег знаний на весь запуск — раздел у всех этапов, судья получает папки без текста; тег задачи — саммари, тег знаний — нет',
  withEnv(async (o, root) => {
    const { dir } = qaTag(root);
    createTag('feat');
    writeTagSummary('feat', 'Суть: старое', { id: 'r0', flow: 'f', finishedAt: '', status: 'done' });
    const f = fake();
    const r = await runFlow(spec({ loop: { max_iterations: 1, until: { type: 'judge', prompt: 'ok?' } } }, {}), {
      ...o, tags: ['feat'], knowledge: ['qa'], session: f.session,
    });
    assert.equal(r.status, 'done');
    assert.match(f.phase('сделай').prompt, /Область знаний qa/);
    assert.match(f.phase('проверь').prompt, /Область знаний qa/);
    // блок one: qa и из flow, и из запуска — раздел один раз
    assert.equal(f.phase('сделай').prompt.split('Область знаний qa').length - 1, 1);
    const judge = f.reqs.find(isJudge)!;
    assert.ok(judge.additionalDirectories!.includes(dir));
    assert.ok(!judge.prompt.includes('Область знаний'));
    assert.equal(f.reqs.filter(isSummary).length, 1);
    const s = saved(o);
    assert.deepEqual(s.knowledge, ['qa']);
    assert.deepEqual(s.tags, ['feat']);
    assert.deepEqual(s.tagSummaries.map((x: { tag: string }) => x.tag), ['feat']);
  }),
);

test(
  'знания: несуществующий тег или тег задачи в knowledge — запуск failed до первого этапа',
  withEnv(async (o) => {
    let f = fake();
    let r = await runFlow(spec({ knowledge: ['nope'] }), { ...o, session: f.session });
    assert.equal(r.status, 'failed');
    assert.match(r.error!, /блок one: тега знаний nope нет/);
    assert.equal(f.reqs.length, 0);
    assert.equal(saved(o).status, 'failed');
    createTag('feat');
    f = fake();
    r = await runFlow(spec({ knowledge: ['feat'] }), { ...o, runDir: path.join(o.runsDir, 'run-2'), session: f.session });
    assert.equal(r.status, 'failed');
    assert.match(r.error!, /feat — тег задачи/);
    assert.equal(f.reqs.length, 0);
    // тег запуска — то же, с пометкой «запуск»
    f = fake();
    r = await runFlow(spec({}), { ...o, runDir: path.join(o.runsDir, 'run-3'), knowledge: ['feat'], session: f.session });
    assert.match(r.error!, /запуск: feat — тег задачи/);
  }),
);

test(
  'знания: продолжение наследует tags, saveTag и knowledge, раздел пересчитывается по текущему тегу',
  withEnv(async (o, root) => {
    qaTag(root);
    createTag('feat');
    const f = fake();
    const first = await runFlow(spec({}, { loop: { max_iterations: 1, until: { type: 'marker', marker: '<DONE>' } } }), {
      ...o, tags: ['feat'], saveTag: false, knowledge: ['qa'], session: f.session,
    });
    assert.equal(first.status, 'max_iterations');
    // как сервер: продолжение берёт поля из прошлого отчёта, тег к этому моменту изменили
    updateTag('qa', { notes: 'Новое правило' });
    const g = fake();
    const second = await runFlow(spec({}, {}), {
      ...o,
      runDir: path.join(o.runsDir, 'run-2'),
      tags: first.tags,
      saveTag: first.saveTag,
      knowledge: first.knowledge,
      continueFrom: { runId: first.id, skipBlocks: ['one'], phases: { work: 'out' }, prev: 'out', history: [] },
      session: g.session,
    });
    assert.equal(second.status, 'done');
    const s = saved({ ...o, runDir: path.join(o.runsDir, 'run-2') });
    assert.deepEqual(s.tags, ['feat']);
    assert.equal(s.saveTag, false);
    assert.deepEqual(s.knowledge, ['qa']);
    assert.match(g.phase('проверь').prompt, /Новое правило/);
    assert.ok(!g.phase('проверь').prompt.includes('Проверяй граничные'));
    assert.equal(readTag('feat')!.summary, '');
  }),
);

test(
  'знания: страница «Контекст» — теги знаний блока этапа, путь тега в доп. директориях, предупреждение на отсутствующий',
  withEnv(async (_o, root) => {
    const { dir } = qaTag(root);
    createTag('feat');
    const file = path.join(root, 'flow.yaml');
    fs.writeFileSync(file, `name: ctx-know
blocks:
  - name: one
    knowledge: [qa, nope, feat]
    phases:
      - name: work
        prompt: p
        tools: [Read]
  - name: two
    phases:
      - name: check
        prompt: p
        tools: []
`);
    const c = contextOptions({ cwd: root, flow: file, phase: 'work' });
    assert.deepEqual(c.knowledge, [{ slug: 'qa', exists: true, kind: 'knowledge' }, { slug: 'nope', exists: false }, { slug: 'feat', exists: true, kind: 'task' }]);
    assert.ok(c.warnings.some((w) => /Нет тега знаний nope/.test(w)), c.warnings.join('\n'));
    assert.ok(c.warnings.some((w) => /feat .*тег задачи/.test(w)), c.warnings.join('\n'));
    assert.ok((c.options.additionalDirectories ?? []).includes(dir));
    const other = contextOptions({ cwd: root, flow: file, phase: 'check' });
    assert.deepEqual(other.knowledge, []);
    assert.ok(!(other.options.additionalDirectories ?? []).includes(dir));
  }),
);
