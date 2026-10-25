import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { continuationFrom, runFlow, type RunEvent, type RunOptions, type RunReport } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import { ArtifactStore } from './artifact-store.js';
import { consoleReporter } from './reporters.js';
import { FlowSchema, type FlowSpec } from './schema.js';

const flow = (yaml: string): FlowSpec => FlowSchema.parse(parseYaml(yaml));
const nameOf = (req: SessionRequest) => (req.prompt.startsWith('JUDGE') ? 'judge' : req.prompt.split(/[\n ]/)[0].slice('PHASE:'.length));
const ok = (text: string, over: Partial<SessionResult> = {}): SessionResult => ({ ok: true, subtype: 'success', text, costUsd: 0.01, turns: 1, durationMs: 1, errors: [], ...over });

type Call = { name: string; req: SessionRequest; iter: number };
/** Сессия-заглушка: act(name, req) — что «агент» делает с файлами; судья — done на итерации doneAt. */
function stub(act: (name: string, req: SessionRequest, n: number) => SessionResult | void = () => {}, doneAt = 2) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const session = async (req: SessionRequest): Promise<SessionResult> => {
    const name = nameOf(req);
    counts[name] = (counts[name] ?? 0) + 1;
    calls.push({ name, req, iter: counts[name] });
    const r = act(name, req, counts[name]);
    if (r) return r;
    if (name === 'judge') {
      const done = counts.judge >= doneAt;
      return ok('', { structured: { done, reason: '', feedback: done ? '' : 'ещё' } });
    }
    return ok(`out-${name}`);
  };
  const prompts = (name: string) => calls.filter((c) => c.name === name).map((c) => c.req.prompt);
  const reqs = (name: string) => calls.filter((c) => c.name === name).map((c) => c.req);
  return { calls, session, prompts, reqs };
}

function env() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-runart-')));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'code.ts'), 'x');
  const runsDir = path.join(root, 'runs');
  const opts = (id: string, over: Partial<RunOptions> = {}): RunOptions => ({ cwd, runsDir, runDir: path.join(runsDir, id), ...over });
  return { root, cwd, runsDir, opts, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const artPath = (report: RunReport, file: string) => path.join(report.runDir, 'artifacts', file);
/** Путь артефакта из раздела «Артефакты запуска» промпта этапа. */
function artFile(req: SessionRequest, title: string, access: 'чтение' | 'запись'): string {
  const m = req.prompt.match(new RegExp(`- ${title} — (\\S+) — ${access}`));
  assert.ok(m, `нет артефакта ${title} (${access}) в промпте:\n${req.prompt}`);
  return m[1]!;
}
const appendTo = (file: string, line: string) => fs.appendFileSync(file, line);
const TOOL_NAMES = ['mcp__artifacts__artifact_map', 'mcp__artifacts__artifact_read', 'mcp__artifacts__artifact_search'];
const saved = (report: RunReport): RunReport => JSON.parse(fs.readFileSync(path.join(report.runDir, 'run.json'), 'utf8'));

const MAIN = `
name: art
input: задача
artifacts:
  plan: {title: План, initial: "# План\\n"}
  notes: {title: Заметки}
blocks:
  - name: one
    loop: {max_iterations: 3, until: {type: judge, prompt: "JUDGE\\nплан=[{{artifacts.plan}}]"}}
    phases:
      - {name: analyze, tools: [], writes: [plan], prompt: "PHASE:analyze\\nплан=[{{artifacts.plan}}]"}
      - {name: verify, tools: [Read], reads: [plan], prompt: "PHASE:verify"}
      - {name: bare, tools: [], prompt: "PHASE:bare"}
  - name: two
    phases:
      - {name: final, tools: [], prompt: "PHASE:final\\nплан=[{{artifacts.plan}}]\\nпуть=[{{artifacts.plan.path}}]"}
`;

test('B1–B3, B9–B11: файлы до первого этапа, раздел и подстановки, права в запросе, артефакты переживают итерации и блоки, судья читает', async () => {
  const e = env();
  try {
    let atFirst: string | undefined;
    const s = stub((name, req, n) => {
      if (name === 'analyze') {
        const file = artFile(req, 'План', 'запись');
        if (n === 1) atFirst = fs.readFileSync(file, 'utf8');
        appendTo(file, `- итерация ${n}\n`);
      }
    });
    const events: RunEvent[] = [];
    const report = await runFlow(flow(MAIN), e.opts('r1', { session: s.session, onEvent: (x) => events.push(x) }));
    assert.equal(report.status, 'done', report.error ?? '');
    const dir = fs.realpathSync.native(path.join(report.runDir, 'artifacts'));
    const plan = path.join(dir, 'plan.md');

    assert.equal(atFirst, '# План\n', 'B1: initial как есть до первого этапа');
    assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), '', 'B1: без initial — пустой');

    const [a1, a2] = s.prompts('analyze');
    assert.ok(a1.startsWith('PHASE:analyze\nплан=[# План\n]'), a1);
    assert.match(a1, new RegExp(`\\n\\nАртефакты запуска:\\n- План — ${plan.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — запись — заготовка flow\\nПиши только в артефакты с доступом «запись»\\.\\nПути к артефактам — только отсюда, а не из выводов прошлых этапов\\.\\nТекст «План» уже есть выше на начало шага: читать файл ради содержимого не нужно\\.\\n«План» — текущее состояние, а не журнал: обновляй так, чтобы файл описывал, как есть сейчас\\. Списки \\(файлы, исправления\\) пополняй и уточняй, а историю попыток по итерациям не дописывай — версии хранит раннер\\.\\nАртефакты можно читать по разделам: artifact_map — карта, artifact_read — раздел целиком по ключу из карты, artifact_search — поиск строк\\.$`));
    assert.ok(a2.includes('план=[# План\n- итерация 1\n]'), 'B9: итерация 2 видит изменение итерации 1');
    assert.match(a2, /- План — .* — запись — изменён этапом analyze, итерация 1, \d\d\.\d\d \d\d:\d\d/);
    const v = s.prompts('verify')[0];
    assert.match(v, /^PHASE:verify\n\nАртефакты запуска:\n- План — .*plan\.md — чтение — изменён этапом analyze, итерация 1/, 'B2');
    assert.ok(!v.includes('Заметки'), 'этап узнаёт только о своих артефактах');
    assert.deepEqual(s.prompts('bare'), ['PHASE:bare', 'PHASE:bare'], 'B3: без доступа — без раздела');

    const [ra] = s.reqs('analyze');
    assert.deepEqual(ra.tools, ['Read', 'Edit', 'Write'], 'неявные права');
    assert.deepEqual(ra.additionalDirectories, [dir]);
    assert.equal(typeof ra.guard, 'function');
    const rv = s.reqs('verify')[0];
    assert.deepEqual(rv.tools, ['Read']);
    assert.deepEqual(rv.additionalDirectories, [dir]);
    // K1, K5: инструмент чтения по ключу — у этапов с доступом, даже с tools: [], разрешён без подтверждения
    for (const r of [ra, rv, s.reqs('judge')[0]]) {
      assert.deepEqual(Object.keys(r.mcpServers ?? {}), ['artifacts']);
      assert.deepEqual(r.allow, TOOL_NAMES);
    }
    for (const name of TOOL_NAMES) assert.equal(ra.guard!(name, { key: 'plan', section: 'x' }, { cwd: e.cwd }), undefined, 'guard не отклоняет инструмент чтения');
    const rb = s.reqs('bare')[0];
    assert.equal(rb.mcpServers, undefined, 'без доступа — без инструмента');
    assert.equal(rb.allow, undefined);
    assert.deepEqual(rb.tools, []);
    assert.deepEqual(rb.additionalDirectories, [], 'без доступа папка не даётся');
    assert.equal(typeof rb.guard, 'function', 'уточнение 8: guard у каждого этапа flow с артефактами');

    const [j1] = s.prompts('judge');
    assert.ok(j1.startsWith('JUDGE\nплан=[# План\n- итерация 1\n]'), 'B11: подстановка в рубрике');
    assert.match(j1, /Артефакты запуска:\n- План — .* — чтение — .*\n- Заметки — .*notes\.md — чтение — ещё не заполнялся/, 'B11: раздел по всем артефактам');
    assert.deepEqual(s.reqs('judge')[0].additionalDirectories, [dir], 'B11: судья может открыть файлы');

    const f = s.prompts('final')[0];
    assert.ok(f.includes('план=[# План\n- итерация 1\n- итерация 2\n]'), 'B9: следующий блок видит артефакт');
    assert.ok(f.includes(`путь=[${plan}]`));

    const r = saved(report);
    const p1 = r.phases.find((p) => p.phase === 'analyze' && p.iteration === 1)!;
    assert.deepEqual(p1.artifacts, { changed: ['plan'], warnings: [] }, 'B10');
    assert.deepEqual(p1.denials, []);
    assert.deepEqual(r.phases.find((p) => p.phase === 'verify')!.artifacts, { changed: [], warnings: [] });
    const meta = r.artifacts!.items.find((m) => m.key === 'plan')!;
    assert.deepEqual(meta.versions.map((x) => x.author.kind), ['initial', 'phase', 'phase']);
    assert.ok(fs.existsSync(path.join(report.runDir, 'artifacts-history', 'plan', '0002.md')));
    assert.ok(r.conditions.every((c) => c.artifacts && c.artifacts.changed.length === 0));

    const art = events.filter((x): x is Extract<RunEvent, { type: 'artifacts' }> => x.type === 'artifacts');
    assert.ok(art.some((x) => x.step?.phases.some((p) => p.phase === 'analyze' && p.changed[0] === 'plan')));
    assert.ok(art.some((x) => x.items.find((i) => i.key === 'plan')!.lockedBy[0] === 'analyze'), 'блокировка в событии');
    assert.ok(events.findIndex((x) => x.type === 'start') < events.findIndex((x) => x.type === 'artifacts'));
  } finally {
    e.done();
  }
});

test('B5, B18, B19: большой артефакт — этапу и судье карта вместо текста, пишущему — перечитать после правок', async () => {
  const e = env();
  try {
    const big = Array.from({ length: 50 }, (_, i) => `## Раздел ${i + 1}\nО разделе ${i + 1}.\n${'строка раздела\n'.repeat(50)}`).join('');
    const s = stub(() => {}, 1);
    const report = await runFlow(
      flow(`
name: m
artifacts:
  plan: {title: План, initial: ${JSON.stringify(big)}}
loop: {max_iterations: 1, until: {type: judge, prompt: "JUDGE\\n{{artifacts.plan}}"}}
phases:
  - {name: w, tools: [], writes: [plan], prompt: "PHASE:w\\n{{artifacts.plan}}"}
  - {name: r, tools: [], reads: [plan], prompt: "PHASE:r\\n{{artifacts.plan}}"}
  - {name: p, tools: [], writes: [plan], prompt: "PHASE:p путь {{artifacts.plan.path}}"}
`),
      e.opts('m', { session: s.session }),
    );
    assert.equal(report.status, 'done', report.error ?? '');
    const [w] = s.prompts('w');
    assert.match(w, /^PHASE:w\nКарта артефакта «План» — \d+ КБ, строк: 2600, файл .*plan\.md\n/);
    assert.match(w, /\n- Раздел 1 — строки 1–52 \(52\), \d+ (Б|КБ): О разделе 1\./);
    assert.ok(!w.includes('строка раздела\nстрока раздела'), 'B5: начала файла вместо содержимого нет');
    assert.match(w, /\nКарта «План» снята на начало шага: после своих правок перечитай файл — строки сдвинулись\.\nАртефакты можно читать по разделам/, 'B18');
    assert.match(w, /Нужный раздел дочитай целиком: инструментом artifact_read по ключу раздела или Read с offset/, 'карта подсказывает инструмент');
    assert.doesNotMatch(s.prompts('r')[0], /перечитай/, 'читающему правило не нужно');
    assert.doesNotMatch(s.prompts('p')[0], /перечитай|Карта артефакта/, 'пишущему без карты — тоже');
    assert.match(s.prompts('judge')[0], /^JUDGE\nКарта артефакта «План»/, 'B19');
  } finally {
    e.done();
  }
});

test('A8: короткая и полная форма одного flow — одинаковые промпты и содержимое artifacts/', async () => {
  const e = env();
  try {
    const body = `
artifacts:
  plan: {initial: "x\\n"}
loop: {max_iterations: 2, until: {type: none}}
phases:
  - {name: w, tools: [], writes: [plan], prompt: "PHASE:w {{artifacts.plan}}"}
  - {name: r, tools: [], reads: [plan], prompt: "PHASE:r"}
`;
    const short = flow(`name: s${body}`);
    const full = flow(`name: s\nartifacts:\n  plan: {initial: "x\\n"}\nblocks:\n  - name: main\n    loop: {max_iterations: 2, until: {type: none}}\n    phases:\n      - {name: w, tools: [], writes: [plan], prompt: "PHASE:w {{artifacts.plan}}"}\n      - {name: r, tools: [], reads: [plan], prompt: "PHASE:r"}\n`);
    const act = (name: string, req: SessionRequest, n: number) => {
      if (name === 'w') appendTo(artFile(req, 'plan', 'запись'), `${n}\n`);
    };
    const a = stub(act);
    const b = stub(act);
    const ra = await runFlow(short, e.opts('a', { session: a.session }));
    const rb = await runFlow(full, e.opts('b', { session: b.session }));
    const norm = (s: string) => s.replaceAll(e.runsDir + '/a/', 'RUN/').replaceAll(e.runsDir + '/b/', 'RUN/').replace(/\d\d\.\d\d \d\d:\d\d/g, 'T');
    assert.deepEqual(a.calls.map((c) => norm(c.req.prompt)), b.calls.map((c) => norm(c.req.prompt)));
    assert.equal(fs.readFileSync(artPath(ra, 'plan.md'), 'utf8'), fs.readFileSync(artPath(rb, 'plan.md'), 'utf8'));
    assert.deepEqual(fs.readdirSync(path.join(ra.runDir, 'artifacts')), fs.readdirSync(path.join(rb.runDir, 'artifacts')));
  } finally {
    e.done();
  }
});

test('B12 и группа: участники получают одинаковую подстановку на старте группы; пишущий участник — автор', async () => {
  const e = env();
  try {
    const s = stub((name, req) => {
      if (name === 'writer') appendTo(artFile(req, 'notes', 'запись'), 'из группы\n');
    });
    const report = await runFlow(
      flow(`
name: g
artifacts: {plan: {initial: "общий план"}, notes: {}}
phases:
  - {name: a, group: g, tools: [], reads: [plan], prompt: "PHASE:a [{{artifacts.plan}}]"}
  - {name: b, group: g, tools: [Read], prompt: "PHASE:b [{{artifacts.plan}}]"}
  - {name: writer, group: g, tools: [], writes: [notes], prompt: "PHASE:writer"}
`),
      e.opts('g', { session: s.session }),
    );
    assert.equal(report.status, 'done', report.error ?? '');
    assert.ok(s.prompts('a')[0].startsWith('PHASE:a [общий план]'));
    assert.ok(s.prompts('b')[0].startsWith('PHASE:b [общий план]'));
    const r = saved(report);
    assert.deepEqual(r.phases.find((p) => p.phase === 'writer')!.artifacts, { changed: ['notes'], warnings: [] });
    assert.equal(r.artifacts!.items.find((m) => m.key === 'notes')!.versions.at(-1)!.author.kind, 'phase');
  } finally {
    e.done();
  }
});

test('C2 и отказы guard: правка без права — «неизвестно» и предупреждение; отказ guard — в denials этапа', async () => {
  const e = env();
  try {
    const s = stub((name, req) => {
      if (name === 'verify') {
        const file = artFile(req, 'План', 'чтение');
        const why = req.guard!('Edit', { file_path: file }, { cwd: e.cwd });
        assert.match(why!, /«План» этому этапу доступен только для чтения/);
        // Edit у этапа нет вовсе (SDK его не предложит); неявный Read — только для своих артефактов
        req.guard!('Read', { file_path: path.join(e.cwd, 'code.ts') }, { cwd: e.cwd });
        req.guard!('Read', { file_path: 'code.ts' }, { cwd: e.cwd });
        fs.writeFileSync(file, 'через Bash'); // мимо guard
      }
    });
    const report = await runFlow(
      flow(`
name: c
artifacts: {plan: {title: План}}
phases:
  - {name: verify, tools: [Bash], reads: [plan], prompt: "PHASE:verify"}
`),
      e.opts('c', { session: s.session }),
    );
    const r = saved(report);
    const v = r.phases[0];
    assert.deepEqual(v.denials, [{ tool: 'Edit', reason: 'artifact-readonly', count: 1 }, { tool: 'Read', reason: 'outside-artifacts', count: 2 }]);
    assert.deepEqual(v.artifacts!.changed, []);
    assert.match(v.artifacts!.warnings[0], /«План» изменён во время этапа verify \(итерация 1\) не через UI/);
    assert.equal(r.artifacts!.items[0].versions.at(-1)!.author.kind, 'unknown');
    assert.equal(fs.readFileSync(artPath(report, 'plan.md'), 'utf8'), 'через Bash');
  } finally {
    e.done();
  }
});

test('D4, D14: сохранение пользователем во время читающего шага — автор «пользователь», без предупреждения, следующий шаг видит правку', async () => {
  const e = env();
  try {
    let store: ArtifactStore | undefined;
    let readers: string[] = [];
    const s = stub((name) => {
      if (name === 'read1') {
        const cur = store!.read('plan');
        const w = store!.userWrite('plan', 'план пользователя', cur.ok ? cur.hash : '', 'ui');
        assert.ok(w.ok);
        if (w.ok) readers = w.readers;
        const locked = store!.userWrite('notes', 'x', store!.list().find((i) => i.key === 'notes')!.hash, 'ui');
        assert.equal(!locked.ok && locked.code, 'locked', 'notes пишет write1 из того же шага');
      }
    });
    const report = await runFlow(
      flow(`
name: d
artifacts: {plan: {title: План, initial: старый}, notes: {}}
phases:
  - {name: read1, group: g, tools: [], reads: [plan], prompt: "PHASE:read1 [{{artifacts.plan}}]"}
  - {name: write1, group: g, tools: [], writes: [notes], prompt: "PHASE:write1"}
  - {name: read2, tools: [], reads: [plan], prompt: "PHASE:read2 [{{artifacts.plan}}]"}
`),
      e.opts('d', { session: s.session, onArtifactStore: (x) => { store = x; } }),
    );
    assert.equal(report.status, 'done', report.error ?? '');
    assert.deepEqual(readers, ['read1']);
    assert.ok(s.prompts('read1')[0].startsWith('PHASE:read1 [старый]'), 'идущий этап получил прежнюю версию');
    const r2 = s.prompts('read2')[0];
    assert.ok(r2.startsWith('PHASE:read2 [план пользователя]'));
    assert.match(r2, /— чтение — последнюю правку сделал пользователь \d\d\.\d\d \d\d:\d\d: учитывай её и не откатывай/);
    const r = saved(report);
    assert.ok(r.phases.every((p) => p.artifacts!.warnings.length === 0));
    assert.deepEqual(r.artifacts!.warnings, []);
  } finally {
    e.done();
  }
});

test('D8: правка файла на паузе не через API — автор «снаружи», без предупреждения, раздел без голоса пользователя', async () => {
  const e = env();
  try {
    let file = '';
    let n = 0;
    const s = stub((name, req) => {
      if (name === 'a') file = artFile(req, 'plan', 'чтение');
    });
    const control = {
      checkpoint: async () => {
        // checkpoint перед вторым шагом: «пользователь в редакторе»
        if (++n === 2) fs.writeFileSync(file, 'руками');
      },
    };
    const report = await runFlow(
      flow('name: p\nartifacts: {plan: {initial: x}}\nphases:\n  - {name: a, tools: [], reads: [plan], prompt: "PHASE:a"}\n  - {name: b, tools: [], reads: [plan], prompt: "PHASE:b [{{artifacts.plan}}]"}\n'),
      e.opts('p', { session: s.session, control }),
    );
    const b = s.prompts('b')[0];
    assert.ok(b.startsWith('PHASE:b [руками]'));
    assert.match(b, /изменён вне этапов между шагами .*, источник не установлен/);
    assert.doesNotMatch(b, /пользовател/);
    const r = saved(report);
    assert.equal(r.artifacts!.items[0].versions.at(-1)!.author.kind, 'outside');
    assert.deepEqual(r.phases.flatMap((p) => p.artifacts!.warnings), []);
  } finally {
    e.done();
  }
});

test('C4 в раннере: CLAUDE.md, созданный этапом, уходит в карантин до следующего этапа; предупреждение у этапа, после которого нашли', async () => {
  const e = env();
  try {
    const s = stub((name, req) => {
      if (name === 'a') fs.writeFileSync(path.join(path.dirname(artFile(req, 'plan', 'запись')), 'CLAUDE.md'), 'инструкции');
      if (name === 'b') assert.ok(!fs.existsSync(path.join(req.additionalDirectories![0], 'CLAUDE.md')), 'следующий этап CLAUDE.md не видит');
    });
    const report = await runFlow(
      flow('name: q\nartifacts: {plan: {}}\nphases:\n  - {name: a, tools: [], writes: [plan], prompt: "PHASE:a"}\n  - {name: b, tools: [], reads: [plan], prompt: "PHASE:b"}\n'),
      e.opts('q', { session: s.session }),
    );
    const r = saved(report);
    assert.match(r.phases[0].artifacts!.warnings[0], /CLAUDE\.md.*artifacts-quarantine/);
    assert.deepEqual(r.phases[1].artifacts!.warnings, []);
  } finally {
    e.done();
  }
});

test('исключение этапа вне группы и остановка посреди этапа — изменения записаны с автором-этапом', async () => {
  const e = env();
  try {
    const yaml = 'name: x\nartifacts: {plan: {}}\nphases:\n  - {name: a, tools: [], writes: [plan], prompt: "PHASE:a"}\n';
    const thrower = stub((_n, req) => {
      fs.writeFileSync(artFile(req, 'plan', 'запись'), 'до исключения');
      throw new Error('сессия упала');
    });
    const r1 = await runFlow(flow(yaml), e.opts('x1', { session: thrower.session }));
    assert.equal(r1.status, 'failed');
    const m1 = saved(r1).artifacts!.items[0];
    assert.deepEqual([m1.versions.at(-1)!.author.kind, (m1.versions.at(-1)!.author as { phase: string }).phase], ['phase', 'a']);

    const abort = new AbortController();
    const stopper = stub((_n, req) => {
      fs.writeFileSync(artFile(req, 'plan', 'запись'), 'до остановки');
      abort.abort();
      return ok('', { ok: false, subtype: 'aborted' });
    });
    const r2 = await runFlow(flow(yaml), e.opts('x2', { session: stopper.session, abort }));
    assert.equal(r2.status, 'aborted');
    assert.equal(fs.readFileSync(artPath(r2, 'plan.md'), 'utf8'), 'до остановки');
    assert.equal(saved(r2).artifacts!.items[0].versions.at(-1)!.author.kind, 'phase');
  } finally {
    e.done();
  }
});

test('ошибка создания хранилища — запуск failed до первого этапа', async () => {
  const e = env();
  try {
    const runDir = path.join(e.runsDir, 'bad');
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    const s = stub();
    const report = await runFlow(flow('name: b\nartifacts: {plan: {}}\nphases:\n  - {name: a, tools: [], prompt: "PHASE:a"}\n'), e.opts('bad', { session: s.session }));
    assert.equal(report.status, 'failed');
    assert.match(report.error!, /EEXIST/);
    assert.equal(s.calls.length, 0);
  } finally {
    e.done();
  }
});

test('E1, E4, E5: продолжение многоблочного flow — копия артефактов с правкой после остановки, автор «пользователь, из запуска X»', async () => {
  const e = env();
  try {
    const spec = flow(MAIN);
    const first = stub((name, req) => {
      if (name === 'analyze') appendTo(artFile(req, 'План', 'запись'), 'шаг\n');
      if (name === 'final') return ok('ошибка', { ok: false, subtype: 'error_during_execution' });
    }, 1);
    const prev = await runFlow(spec, e.opts('first', { session: first.session }));
    assert.equal(prev.status, 'failed');
    const open = ArtifactStore.open(prev.runDir)!;
    const cur = open.read('plan');
    assert.ok(open.userWrite('plan', 'план после правки', cur.ok ? cur.hash : '', 'ui').ok);

    const prevReport = saved(prev);
    const cont = continuationFrom(prevReport, spec, {
      report: (id) => (id === prevReport.id ? prevReport : undefined),
      output: (runId, rel) => fs.readFileSync(path.join(e.runsDir, runId, rel), 'utf8'),
    });
    const second = stub();
    const next = await runFlow(spec, e.opts('second', { session: second.session, continueFrom: cont, artifactsFrom: { runId: prev.id, runDir: prev.runDir } }));
    assert.equal(next.status, 'done', next.error ?? '');
    const f = second.prompts('final')[0];
    assert.ok(f.includes('план=[план после правки]'), 'E1');
    assert.match(f, /последнюю правку сделал пользователь .* \(из запуска first\): учитывай/, 'E4');
    const r = saved(next);
    assert.equal(r.artifacts!.from, 'first', 'E5');
    assert.equal(r.continuedFrom, 'first');
    assert.deepEqual(second.calls.map((c) => c.name), ['final']);
  } finally {
    e.done();
  }
});

test('B13: консольный вывод — изменения и предупреждения этапов, отказы, путь к папке артефактов в конце', async () => {
  const e = env();
  const lines: string[] = [];
  const orig = { log: console.log, write: process.stdout.write.bind(process.stdout) };
  try {
    const s = stub((name, req) => {
      if (name === 'a') {
        appendTo(artFile(req, 'plan', 'запись'), 'x');
        req.guard!('Write', { file_path: path.join(e.cwd, 'code.ts') }, { cwd: e.cwd });
      }
    });
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    process.stdout.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const report = await runFlow(flow('name: o\nartifacts: {plan: {}}\nphases:\n  - {name: a, tools: [], writes: [plan], prompt: "PHASE:a"}\n'), e.opts('o', { session: s.session, onEvent: consoleReporter(false) }));
    console.log = orig.log;
    process.stdout.write = orig.write;
    const out = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(out, /изменил: plan/);
    assert.match(out, /отказов записи: 1/);
    assert.ok(out.includes(`Артефакты: ${path.join(report.runDir, 'artifacts')}`), out);
  } finally {
    console.log = orig.log;
    process.stdout.write = orig.write;
    e.done();
  }
});
