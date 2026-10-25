import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFlow, type RunEvent, type RunOptions } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';
import { createTag, readTag, tagInputBlock, updateTag, withTagsInput, writeTagSummary } from './tags.js';
import { dropRunPaths } from './tag-summary.js';

const result = (text: string, over: Partial<SessionResult> = {}): SessionResult =>
  ({ ok: true, subtype: 'success', text, costUsd: 0.01, turns: 1, durationMs: 10, errors: [], ...over });

const isSummary = (req: SessionRequest) => Boolean(req.outputSchema && 'summary' in ((req.outputSchema as { properties?: object }).properties ?? {}));

const spec = (over: Record<string, unknown> = {}) =>
  ({ name: 'tagged', input: 'задача', blocks: [{ name: 'main', phases: [{ name: 'work', tools: [], prompt: 'сделай {{input}}' }], ...over }] }) as unknown as FlowSpec;

/** Временный каталог настроек (теги) и папка запусков; fn получает опции запуска. */
function withEnv(fn: (o: RunOptions, root: string) => Promise<void>) {
  return async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-runtags-')));
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

/** Сессия: этапы отвечают out, сессия саммари — summary (или over). Все запросы — в reqs. */
function fake(summary: Partial<SessionResult> | Error = { structured: { summary: 'Суть: новое' } }) {
  const reqs: SessionRequest[] = [];
  const session = async (req: SessionRequest): Promise<SessionResult> => {
    reqs.push(req);
    if (!isSummary(req)) return result('out');
    if (summary instanceof Error) throw summary;
    return result('', { costUsd: 0.5, ...summary });
  };
  return { reqs, session, summaries: () => reqs.filter(isSummary) };
}

const saved = (o: RunOptions) => JSON.parse(fs.readFileSync(path.join(o.runDir!, 'run.json'), 'utf8'));

test(
  'тег: done + галочка — одна сессия саммари только на чтение, саммари записано, стоимость в итоге',
  withEnv(async (o) => {
    createTag('p');
    writeTagSummary('p', 'Суть: старое', { id: 'r0', flow: 'f', finishedAt: '', status: 'done' });
    const f = fake();
    const events: RunEvent[] = [];
    const r = await runFlow(spec(), { ...o, tags: ['p'], saveTag: true, session: f.session, onEvent: (e) => events.push(e) });
    assert.equal(r.status, 'done');
    assert.equal(f.summaries().length, 1);
    const req = f.summaries()[0];
    assert.deepEqual(req.tools, ['Read', 'Grep', 'Glob']);
    assert.equal(req.persist, false);
    assert.equal(req.model, 'haiku');
    // прошлое саммари и путь вывода последнего этапа (report.final) — в промпте
    assert.match(req.prompt, /Суть: старое/);
    assert.ok(req.prompt.includes(path.join(o.runDir!, r.final![0].output)), req.prompt);
    assert.ok(fs.existsSync(path.join(o.runDir!, 'tag-summary.p.prompt.md')));
    assert.equal(readTag('p')!.summary.trim(), 'Суть: новое');
    assert.equal(readTag('p')!.runs[0].id, r.id);
    assert.ok(Math.abs(r.totalCostUsd - 0.51) < 1e-9, String(r.totalCostUsd));
    const s = saved(o);
    assert.deepEqual(s.tags, ['p']);
    assert.equal(s.saveTag, true);
    assert.equal(s.tagSummaries[0].tag, 'p');
    assert.equal(s.tagSummaries[0].ok, true);
    assert.equal(s.tagSummaries[0].costUsd, 0.5);
    const types = events.map((e) => e.type);
    assert.ok(types.indexOf('tag_summary_start') < types.indexOf('tag_summary'));
    assert.ok(types.indexOf('tag_summary') < types.indexOf('end'));
  }),
);

test(
  'тег: галочка снята — сессии нет, саммари не меняется, тег в отчёте есть',
  withEnv(async (o) => {
    createTag('p');
    writeTagSummary('p', 'старое', { id: 'r0', flow: 'f', finishedAt: '', status: 'done' });
    const f = fake();
    const r = await runFlow(spec(), { ...o, tags: ['p'], saveTag: false, session: f.session });
    assert.equal(r.status, 'done');
    assert.equal(f.summaries().length, 0);
    assert.equal(readTag('p')!.summary.trim(), 'старое');
    assert.deepEqual(saved(o).tags, ['p']);
    assert.equal(saved(o).saveTag, false);
    assert.match(saved(o).tagSummaries[0].skipped, /галочка/);
  }),
);

test(
  'тег: запуск не done — сессии нет, причина в skipped',
  withEnv(async (o) => {
    createTag('p');
    // max_iterations: маркер не появился
    let f = fake();
    let r = await runFlow(spec({ loop: { max_iterations: 1, until: { type: 'marker', marker: '<DONE>' } } }), { ...o, tags: ['p'], session: f.session });
    assert.equal(r.status, 'max_iterations');
    assert.equal(f.summaries().length, 0);
    assert.match(r.tagSummaries![0].skipped!, /max_iterations/);
    // failed: этап вернул ошибку
    f = fake();
    r = await runFlow(spec(), { ...o, runDir: path.join(o.runsDir, 'run-2'), tags: ['p'], session: async (req) => (isSummary(req) ? f.session(req) : result('x', { ok: false, subtype: 'error' })) });
    assert.equal(r.status, 'failed');
    assert.equal(f.summaries().length, 0);
    assert.match(r.tagSummaries![0].skipped!, /failed/);
    // budget_exceeded
    f = fake();
    r = await runFlow(spec(), { ...o, runDir: path.join(o.runsDir, 'run-3'), tags: ['p'], maxBudgetUsd: 0.001, session: f.session });
    assert.equal(r.status, 'budget_exceeded');
    assert.equal(f.summaries().length, 0);
    // aborted
    f = fake();
    const abort = new AbortController();
    abort.abort();
    r = await runFlow(spec(), { ...o, runDir: path.join(o.runsDir, 'run-4'), tags: ['p'], abort, session: f.session });
    assert.equal(r.status, 'aborted');
    assert.equal(f.summaries().length, 0);
    assert.equal(readTag('p')!.summary, '');
  }),
);

test(
  'тег: сессия саммари упала или не вернула summary — запуск done, ошибка в tagSummary, старое саммари цело',
  withEnv(async (o) => {
    createTag('p');
    writeTagSummary('p', 'старое', { id: 'r0', flow: 'f', finishedAt: '', status: 'done' });
    let r = await runFlow(spec(), { ...o, tags: ['p'], session: fake(new Error('сеть упала')).session });
    assert.equal(r.status, 'done');
    assert.equal(r.error, undefined);
    assert.match(r.tagSummaries![0].error!, /сеть упала/);
    assert.equal(r.tagSummaries![0].ok, false);
    r = await runFlow(spec(), { ...o, runDir: path.join(o.runsDir, 'run-2'), tags: ['p'], session: fake({ structured: { summary: '  ' } }).session });
    assert.equal(r.status, 'done');
    assert.match(r.tagSummaries![0].error!, /summary/);
    assert.equal(r.tagSummaries![0].costUsd, 0.5);
    assert.equal(readTag('p')!.summary.trim(), 'старое');
  }),
);

test(
  'тег: tagDirs — в доп. директориях этапа и судьи, но не в addDirs отчёта',
  withEnv(async (o, root) => {
    createTag('p');
    const extra = path.join(root, 'old-run', 'artifacts');
    fs.mkdirSync(extra, { recursive: true });
    const f = fake();
    const judge: SessionRequest[] = [];
    await runFlow(spec({ loop: { max_iterations: 1, until: { type: 'judge', prompt: 'ok?' } } }), {
      ...o,
      tags: ['p'],
      tagDirs: [extra],
      session: async (req) => {
        if (!req.outputSchema || isSummary(req)) return f.session(req);
        judge.push(req);
        return result('', { structured: { done: true, reason: '', feedback: '' } });
      },
    });
    const stage = f.reqs.find((r) => !isSummary(r))!;
    assert.ok(stage.additionalDirectories!.includes(extra));
    assert.ok(judge[0].additionalDirectories!.includes(extra));
    assert.equal(saved(o).addDirs, undefined);
    assert.ok(!JSON.stringify(saved(o)).includes(extra));
  }),
);

test(
  'без тега: в run.json нет ключей тега, сессии саммари нет',
  withEnv(async (o) => {
    const f = fake();
    await runFlow(spec(), { ...o, session: f.session });
    const s = saved(o);
    for (const k of ['tags', 'saveTag', 'tagSummaries', 'autoTag']) assert.equal(k in s, false, k);
    assert.equal(f.summaries().length, 0);
    assert.deepEqual(fs.readdirSync(o.runDir!).filter((x) => x.startsWith('tag-summary')), []);
  }),
);

test(
  'теги: два тега — по сессии на каждый, в промпте прошлое саммари только своего тега и ровно один раз',
  withEnv(async (o) => {
    createTag('a');
    createTag('b');
    writeTagSummary('a', 'Суть: саммари-А', { id: 'r0', flow: 'f', finishedAt: '', status: 'done' });
    writeTagSummary('b', 'Суть: саммари-Б', { id: 'r0', flow: 'f', finishedAt: '', status: 'done' });
    // ввод как после сервера: блоки обоих тегов сверху, задача ниже
    const input = withTagsInput('почини баг', [readTag('a')!, readTag('b')!]);
    const f = fake();
    const r = await runFlow({ ...spec(), input }, { ...o, tags: ['a', 'b'], session: f.session });
    assert.equal(r.status, 'done');
    const [ra, rb] = f.summaries();
    assert.equal(f.summaries().length, 2);
    assert.equal(ra.prompt.split('саммари-А').length - 1, 1, ra.prompt);
    assert.ok(!ra.prompt.includes('саммари-Б'), ra.prompt);
    assert.equal(rb.prompt.split('саммари-Б').length - 1, 1);
    assert.match(ra.prompt, /почини баг/);
    assert.match(ra.prompt, /Другие теги запуска: b/);
    assert.deepEqual(r.tagSummaries!.map((x) => [x.tag, x.ok]), [['a', true], ['b', true]]);
    assert.ok(fs.existsSync(path.join(o.runDir!, 'tag-summary.a.prompt.md')));
    assert.ok(fs.existsSync(path.join(o.runDir!, 'tag-summary.b.prompt.md')));
    assert.ok(Math.abs(r.totalCostUsd - 1.01) < 1e-9, String(r.totalCostUsd));
  }),
);

test(
  'тег: длинная задача — блок тега снимается до обрезки, сама задача в промпте саммари',
  withEnv(async (o) => {
    createTag('p');
    writeTagSummary('p', 'x'.repeat(2400), { id: 'r0', flow: 'f', finishedAt: '', status: 'done' });
    // блок длиннее лимита задачи в промпте (4000): обрезка до снятия блока съела бы задачу целиком
    updateTag('p', { notes: 'n'.repeat(2000) });
    const input = withTagsInput('ЗАДАЧА-ХВОСТ', [readTag('p')!]);
    assert.ok(input.length > 4400, String(input.length));
    const f = fake();
    await runFlow({ ...spec(), input }, { ...o, tags: ['p'], session: f.session });
    assert.match(f.summaries()[0].prompt, /ЗАДАЧА-ХВОСТ/);
    assert.ok(!f.summaries()[0].prompt.includes('<!-- tag:p -->'));
  }),
);

test(
  'тег: пути папки запуска вне artifacts/ вычищаются из саммари, артефакты и файлы репо остаются',
  withEnv(async (o) => {
    createTag('p');
    const runs = path.dirname(o.runDir!);
    const bad = path.join(o.runDir!, 'iter-01', '02-pick.output.md');
    const good = path.join(o.runDir!, 'artifacts', 'plan.md');
    const repo = '/repo/src/x.ts';
    const f = fake({ structured: { summary: `Где читать: \`${bad}\`, [план](${good}), ${repo}.` } });
    const r = await runFlow(spec(), { ...o, tags: ['p'], session: f.session });
    const s = readTag('p')!.summary;
    assert.ok(!s.includes(bad), s);
    assert.match(s, /недоступен следующим запускам/);
    assert.ok(s.includes(`(${good})`), s);
    assert.ok(s.includes(repo), s);
    assert.equal(r.tagSummaries![0].ok, true);
    // dropRunPaths отдельно: соседняя папка с тем же началом имени и выход через .. 
    assert.equal(dropRunPaths(`${runs}-old/x.md`, runs), `${runs}-old/x.md`);
    assert.match(dropRunPaths(`${runs}/r1/artifacts/../iter-01/a.md`, runs), /недоступен/);
    assert.equal(dropRunPaths(`${runs}/r1/artifacts/a.md.`, runs), `${runs}/r1/artifacts/a.md.`);
  }),
);

test(
  'теги: «Остановить» во время саммари — запуск done, ошибка у тега, следующий тег пропущен, старое саммари цело',
  withEnv(async (o) => {
    createTag('a');
    createTag('b');
    writeTagSummary('a', 'старое-А', { id: 'r0', flow: 'f', finishedAt: '', status: 'done' });
    const abort = new AbortController();
    const r = await runFlow(spec(), {
      ...o,
      tags: ['a', 'b'],
      abort,
      session: async (req) => {
        if (!isSummary(req)) return result('out');
        abort.abort();
        return result('', { ok: false, subtype: 'error_during_execution', errors: ['aborted'], costUsd: 0.2 });
      },
    });
    assert.equal(r.status, 'done');
    assert.equal(r.error, undefined);
    assert.equal(r.tagSummaries![0].ok, false);
    assert.match(r.tagSummaries![0].error!, /aborted/);
    assert.match(r.tagSummaries![1].skipped!, /остановлено/);
    assert.equal(readTag('a')!.summary.trim(), 'старое-А');
  }),
);

test('теги: блок тега с заметками, путями и вложениями', () => {
  const block = tagInputBlock({ slug: 'p', summary: '', notes: 'Пиши тесты', dirs: [process.cwd(), '/нет/такого'], attachments: ['a.png'] });
  assert.match(block, /Заметки к тегу:\nПиши тесты/);
  assert.ok(block.includes(process.cwd()));
  assert.ok(!block.includes('/нет/такого'));
  assert.match(block, /attachments\/a\.png/);
  assert.ok(!block.includes('саммари ещё нет'));
});

test(
  'автотег: отчёт подбора — в run.json, его стоимость — в totalCostUsd',
  withEnv(async (o) => {
    createTag('p');
    const f = fake();
    const r = await runFlow(spec(), { ...o, tags: ['p'], saveTag: true, autoTag: { slug: 'p', costUsd: 0.01 }, session: f.session });
    assert.equal(r.status, 'done');
    const s = saved(o);
    assert.deepEqual(s.autoTag, { slug: 'p', costUsd: 0.01 });
    assert.deepEqual(s.tags, ['p']);
    assert.equal(s.saveTag, true);
    // этап 0.01 + саммари 0.5 + подбор 0.01
    assert.ok(Math.abs(r.totalCostUsd - 0.52) < 1e-9, String(r.totalCostUsd));
  }),
);

test(
  'автотег: ошибка подбора без тегов — autoTag.error в run.json, ни tags, ни tagSummaries',
  withEnv(async (o) => {
    const f = fake();
    await runFlow(spec(), { ...o, autoTag: { error: 'таймаут', costUsd: 0 }, session: f.session });
    const s = saved(o);
    assert.equal(s.autoTag.error, 'таймаут');
    for (const k of ['tags', 'saveTag', 'tagSummaries']) assert.equal(k in s, false, k);
    assert.equal(f.summaries().length, 0);
  }),
);
