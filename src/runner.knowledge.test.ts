import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runFlow, type RunOptions } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import { FlowSchema, type FlowSpec } from './schema.js';
import { createTag, KNOWLEDGE_LIST_HEAD, readTag, tagDir, updateTag, writeTagSummary } from './tags.js';
import { KNOWLEDGE_TOOLS_ALLOW } from './knowledge-tools.js';
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

const QA_NOTES = 'Проверяй граничные значения\nВторая строка правил';
const QA_LINE = /\n- qa — Правила QA: Правила проверки \(знаков заметок: \d+, вложений: 1, путей: 1\)/;

/** Тег знаний qa по запросу: описание, заметки, путь и вложение. */
function qaTag(root: string) {
  const dir = path.join(root, 'qa-rules');
  fs.mkdirSync(dir, { recursive: true });
  createTag('qa', 'Правила QA', 'knowledge');
  updateTag('qa', { description: 'Правила проверки', notes: QA_NOTES, dirs: [dir, path.join(root, 'нет')] });
  const attach = path.join(tagDir('qa'), 'attachments');
  fs.mkdirSync(attach, { recursive: true });
  fs.writeFileSync(path.join(attach, 'cases.md'), '# кейсы');
  return { dir, attach };
}

/** Тег знаний rules в режиме inline: короткое правило, которое должно быть в каждом промпте целиком. */
function inlineTag() {
  createTag('rules', 'Правила', 'knowledge');
  updateTag('rules', { notes: 'Коротко: пиши тесты', inline: true });
}

/** Без инструмента знаний: ни сервера knowledge, ни его имени в allow. */
function noKnowledgeTool(req: SessionRequest) {
  assert.ok(!('knowledge' in (req.mcpServers ?? {})), 'сервера knowledge быть не должно');
  assert.ok(!(req.allow ?? []).some((t) => KNOWLEDGE_TOOLS_ALLOW.includes(t)), 'knowledge_read в allow быть не должно');
}

test(
  'знания: блок с knowledge — строка списка и инструмент knowledge_read у его этапов, заметок в промпте нет; у соседнего блока ничего; run.json без knowledge и tagSummaries',
  withEnv(async (o, root) => {
    const { dir, attach } = qaTag(root);
    const f = fake();
    const r = await runFlow(spec(), { ...o, session: f.session });
    assert.equal(r.status, 'done');
    const work = f.phase('сделай');
    assert.ok(work.prompt.includes(`\n\n${KNOWLEDGE_LIST_HEAD}\n- qa — Правила QA: `), work.prompt);
    assert.match(work.prompt, QA_LINE);
    // текст заметок, пути и вложения — только по запросу инструментом
    assert.ok(!work.prompt.includes('Проверяй граничные значения'));
    assert.ok(!work.prompt.includes(dir));
    assert.ok(!work.prompt.includes('cases.md'));
    assert.ok(!work.prompt.includes('<source-data>'));
    // папки — независимо от режима
    assert.ok(work.additionalDirectories!.includes(dir));
    assert.ok(work.additionalDirectories!.includes(attach));
    assert.deepEqual(Object.keys(work.mcpServers ?? {}), ['knowledge']);
    const srv = work.mcpServers!.knowledge as { type?: string; name?: string };
    assert.equal(srv.type, 'sdk');
    assert.equal(srv.name, 'knowledge');
    assert.deepEqual(work.allow, ['mcp__knowledge__knowledge_read']);
    const check = f.phase('проверь');
    assert.ok(!check.prompt.includes('Области знаний'));
    assert.ok(!check.additionalDirectories!.includes(dir));
    assert.equal(check.mcpServers, undefined);
    assert.equal(check.allow, undefined);
    // сессии саммари нет, в run.json только knowledge
    assert.equal(f.reqs.filter(isSummary).length, 0);
    const s = saved(o);
    assert.equal('knowledge' in s, false);
    assert.equal('tagSummaries' in s, false);
  }),
);

test(
  'знания: тег знаний на весь запуск — строка у всех этапов, судья получает папки без текста и без инструмента; тег задачи — саммари, тег знаний — нет',
  withEnv(async (o, root) => {
    const { dir } = qaTag(root);
    createTag('feat');
    writeTagSummary('feat', 'Суть: старое', { id: 'r0', flow: 'f', finishedAt: '', status: 'done' });
    const f = fake();
    const r = await runFlow(spec({ loop: { max_iterations: 1, until: { type: 'judge', prompt: 'ok?' } } }, {}), {
      ...o, tags: ['feat'], knowledge: ['qa'], session: f.session,
    });
    assert.equal(r.status, 'done');
    assert.match(f.phase('сделай').prompt, QA_LINE);
    assert.match(f.phase('проверь').prompt, QA_LINE);
    // блок one: qa и из flow, и из запуска — строка один раз
    assert.equal(f.phase('сделай').prompt.split('- qa — Правила QA').length - 1, 1);
    const judge = f.reqs.find(isJudge)!;
    assert.ok(judge.additionalDirectories!.includes(dir));
    assert.ok(!judge.prompt.includes('Област'));
    noKnowledgeTool(judge);
    assert.equal(judge.mcpServers, undefined);
    assert.equal(f.reqs.filter(isSummary).length, 1);
    const s = saved(o);
    assert.deepEqual(s.knowledge, ['qa']);
    assert.deepEqual(s.tags, ['feat']);
    assert.deepEqual(s.tagSummaries.map((x: { tag: string }) => x.tag), ['feat']);
  }),
);

test(
  'знания: тег с inline — полный раздел в промпте и без инструмента, если все теги блока inline; вместе с тегом по запросу — список, затем раздел, инструмент есть',
  withEnv(async (o) => {
    inlineTag();
    let f = fake();
    let r = await runFlow(spec({ knowledge: ['rules'] }), { ...o, session: f.session });
    assert.equal(r.status, 'done');
    let work = f.phase('сделай');
    assert.match(work.prompt, /\n\nОбласть знаний rules — Правила\nКоротко: пиши тесты$/);
    assert.ok(!work.prompt.includes(KNOWLEDGE_LIST_HEAD));
    assert.equal(work.mcpServers, undefined);
    assert.equal(work.allow, undefined);
    // qa по запросу + rules целиком: шапка списка, строка qa, после списка — раздел rules
    qaTag(o.cwd);
    f = fake();
    r = await runFlow(spec({ knowledge: ['qa', 'rules'] }), { ...o, runDir: path.join(o.runsDir, 'run-2'), session: f.session });
    assert.equal(r.status, 'done');
    work = f.phase('сделай');
    const head = work.prompt.indexOf(KNOWLEDGE_LIST_HEAD);
    const section = work.prompt.indexOf('Область знаний rules — Правила\nКоротко: пиши тесты');
    assert.ok(head > 0 && section > head, work.prompt);
    assert.match(work.prompt, QA_LINE);
    assert.ok(!work.prompt.includes('- rules'), 'inline-тег в списке по запросу не дублируется');
    assert.deepEqual(Object.keys(work.mcpServers ?? {}), ['knowledge']);
    assert.deepEqual(work.allow, KNOWLEDGE_TOOLS_ALLOW);
  }),
);

test(
  'знания: flow с артефактами и тегом знаний — в запросе этапа оба MCP-сервера (artifacts и knowledge) и оба набора allow',
  withEnv(async (o, root) => {
    qaTag(root);
    const both = FlowSchema.parse(parseYaml(`
name: both
input: задача
artifacts:
  plan: {title: План, initial: "# План\\n"}
blocks:
  - name: one
    knowledge: [qa]
    phases:
      - {name: work, tools: [], writes: [plan], prompt: "сделай {{input}}"}
      - {name: bare, tools: [], prompt: "без {{input}}"}
`));
    const f = fake();
    const r = await runFlow(both, { ...o, session: f.session });
    assert.equal(r.status, 'done', r.error ?? '');
    const work = f.phase('сделай');
    assert.deepEqual(Object.keys(work.mcpServers ?? {}).sort(), ['artifacts', 'knowledge']);
    assert.deepEqual(work.allow, ['mcp__artifacts__artifact_map', 'mcp__artifacts__artifact_read', 'mcp__artifacts__artifact_search', 'mcp__knowledge__knowledge_read']);
    assert.match(work.prompt, QA_LINE);
    assert.match(work.prompt, /Артефакты запуска:/);
    // этап без доступа к артефактам — только знания
    const bare = f.phase('без');
    assert.deepEqual(Object.keys(bare.mcpServers ?? {}), ['knowledge']);
    assert.deepEqual(bare.allow, KNOWLEDGE_TOOLS_ALLOW);
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
  'знания: продолжение наследует tags, saveTag и knowledge, строка списка пересчитывается по текущему тегу',
  withEnv(async (o, root) => {
    qaTag(root);
    createTag('feat');
    const f = fake();
    const first = await runFlow(spec({}, { loop: { max_iterations: 1, until: { type: 'marker', marker: '<DONE>' } } }), {
      ...o, tags: ['feat'], saveTag: false, knowledge: ['qa'], session: f.session,
    });
    assert.equal(first.status, 'max_iterations');
    // как сервер: продолжение берёт поля из прошлого отчёта, тег к этому моменту изменили
    updateTag('qa', { description: 'Новое описание' });
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
    assert.match(g.phase('проверь').prompt, /- qa — Правила QA: Новое описание/);
    assert.ok(!g.phase('проверь').prompt.includes('Правила проверки'));
    assert.equal(readTag('feat')!.summary, '');
  }),
);

test(
  'знания: страница «Контекст» — теги знаний блока этапа с режимом и объёмом, путь тега в доп. директориях, инструмент knowledge_read в опциях, предупреждение на отсутствующий',
  withEnv(async (_o, root) => {
    const { dir } = qaTag(root);
    inlineTag();
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
    knowledge: [rules]
    phases:
      - name: check
        prompt: p
        tools: []
`);
    const c = contextOptions({ cwd: root, flow: file, phase: 'work' });
    assert.deepEqual(c.knowledge, [
      { slug: 'qa', exists: true, kind: 'knowledge', title: 'Правила QA', description: 'Правила проверки', mode: 'on-demand', notesChars: QA_NOTES.length, attachments: 1, dirs: 1 },
      { slug: 'nope', exists: false },
      { slug: 'feat', exists: true, kind: 'task' },
    ]);
    assert.ok(c.warnings.some((w) => /Нет тега знаний nope/.test(w)), c.warnings.join('\n'));
    assert.ok(c.warnings.some((w) => /feat .*тег задачи/.test(w)), c.warnings.join('\n'));
    assert.ok((c.options.additionalDirectories ?? []).includes(dir));
    // инструмент знаний — в опциях сессии листинга, как в настоящем запуске
    assert.deepEqual(Object.keys(c.options.mcpServers ?? {}), ['knowledge']);
    assert.ok((c.options.allowedTools ?? []).includes('mcp__knowledge__knowledge_read'));
    const other = contextOptions({ cwd: root, flow: file, phase: 'check' });
    assert.deepEqual(other.knowledge, [{ slug: 'rules', exists: true, kind: 'knowledge', title: 'Правила', mode: 'inline', notesChars: 'Коротко: пиши тесты'.length, attachments: 0, dirs: 0 }]);
    assert.ok(!(other.options.additionalDirectories ?? []).includes(dir));
    assert.equal(other.options.mcpServers, undefined);
  }),
);
