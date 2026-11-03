import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phaseGuard, runFlow, spaceSection, type RunEvent, type RunOptions } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';
import { addSpaceDoc, createSpace, readSpace, spaceDir, spaceReadDirs, updateSpace, writeSpaceState } from './spaces.js';
import { dropRunPaths, isStateRequest } from './space-state.js';

const result = (text: string, over: Partial<SessionResult> = {}): SessionResult =>
  ({ ok: true, subtype: 'success', text, costUsd: 0.01, turns: 1, durationMs: 10, errors: [], ...over });

const isState = isStateRequest;

const spec = (over: Record<string, unknown> = {}) =>
  ({ name: 'spaced', input: 'задача', blocks: [{ name: 'main', phases: [{ name: 'work', tools: [], prompt: 'сделай {{input}}' }], ...over }] }) as unknown as FlowSpec;

/** Временный каталог настроек (пространства) и папка запусков; fn получает опции запуска. */
function withEnv(fn: (o: RunOptions, root: string) => Promise<void>) {
  return async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-runspace-')));
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

/** Сессия: этапы отвечают out, сессия состояния — state (или over). Все запросы — в reqs. */
function fake(state: Partial<SessionResult> | Error = { structured: { state: 'Суть: новое' } }) {
  const reqs: SessionRequest[] = [];
  const session = async (req: SessionRequest): Promise<SessionResult> => {
    reqs.push(req);
    if (!isState(req)) return result('out');
    if (state instanceof Error) throw state;
    return result('', { costUsd: 0.5, ...state });
  };
  return { reqs, session, states: () => reqs.filter(isState), phases: () => reqs.filter((r) => !isState(r)) };
}

const saved = (o: RunOptions) => JSON.parse(fs.readFileSync(path.join(o.runDir!, 'run.json'), 'utf8'));

/** Опции запуска с пространством, как у сервера: папки — spaceReadDirs. */
const inSpace = (slug: string, runsDir: string, over: Partial<RunOptions> = {}): Partial<RunOptions> => ({ space: slug, spaceDirs: spaceReadDirs(readSpace(slug)!, runsDir), ...over });

test(
  'пространство: done + галочка — одна сессия состояния только на чтение, состояние записано, кто записал — в истории, стоимость в итоге',
  withEnv(async (o) => {
    createSpace('p', { title: 'Пуш', gist: 'суть' });
    writeSpaceState('p', 'Суть: старое', { id: 'r0', at: '', kind: 'run', flow: 'f' });
    const f = fake();
    const events: RunEvent[] = [];
    const r = await runFlow(spec(), { ...o, ...inSpace('p', o.runsDir), saveState: true, session: f.session, onEvent: (e) => events.push(e) });
    assert.equal(r.status, 'done');
    assert.equal(f.states().length, 1);
    const req = f.states()[0];
    assert.deepEqual(req.tools, ['Read', 'Grep', 'Glob']);
    assert.equal(req.persist, false);
    assert.equal(req.model, 'haiku');
    // прошлое состояние, путь вывода последнего этапа и карта пространства — в промпте; папка пространства — для чтения
    assert.match(req.prompt, /Суть: старое/);
    assert.ok(req.prompt.includes(path.join(o.runDir!, r.final![0].output)), req.prompt);
    assert.ok(req.prompt.includes(path.join(spaceDir('p'), 'CLAUDE.md')), req.prompt);
    assert.ok(req.additionalDirectories!.includes(spaceDir('p')));
    assert.ok(fs.existsSync(path.join(o.runDir!, 'space-state.prompt.md')));
    const s = readSpace('p')!;
    assert.equal(s.state.trim(), 'Суть: новое');
    assert.deepEqual([s.history[0].id, s.history[0].kind, s.history[0].flow], [r.id, 'run', 'spaced']);
    assert.ok(Math.abs(r.totalCostUsd - 0.51) < 1e-9, String(r.totalCostUsd));
    const j = saved(o);
    assert.equal(j.space, 'p');
    assert.equal(j.saveState, true);
    assert.deepEqual([j.stateUpdate.space, j.stateUpdate.ok, j.stateUpdate.costUsd], ['p', true, 0.5]);
    for (const k of ['tags', 'saveTag', 'tagSummaries', 'autoTag']) assert.equal(k in j, false, k);
    const types = events.map((e) => e.type);
    assert.ok(types.indexOf('space_state_start') < types.indexOf('space_state'));
    assert.ok(types.indexOf('space_state') < types.indexOf('end'));
  }),
);

test(
  'пространство: раздел в конце промпта этапа — шапка, документы, состояние данными; папка пространства — в доп. директориях этапа и судьи, не в addDirs; задача без блоков',
  withEnv(async (o, root) => {
    const extra = path.join(root, 'api');
    fs.mkdirSync(extra);
    createSpace('p', { title: 'Пуш', dirs: [extra] });
    addSpaceDoc('p', { name: 'spec.md', data: Buffer.from('# Спека').toString('base64') });
    writeSpaceState('p', 'Суть: пуш', { id: 'r0', at: '', kind: 'run' });
    const f = fake();
    const judge: SessionRequest[] = [];
    await runFlow(spec({ loop: { max_iterations: 1, until: { type: 'judge', prompt: 'ok?' } } }), {
      ...o,
      ...inSpace('p', o.runsDir),
      session: async (req) => {
        if (!req.outputSchema || isState(req)) return f.session(req);
        judge.push(req);
        return result('', { structured: { done: true, reason: '', feedback: '' } });
      },
    });
    const stage = f.phases()[0];
    assert.match(stage.prompt, /^сделай задача\n\nПространство agentgraph «Пуш» \(p\)/);
    assert.ok(stage.prompt.includes(path.join(spaceDir('p'), 'docs', 'spec.md')));
    assert.match(stage.prompt, /<source-data>\nСуть: пуш\n<\/source-data>$/);
    assert.match(stage.prompt, /уже в контексте как память/);
    assert.ok(!stage.prompt.includes('space_write'));
    for (const d of [spaceDir('p'), extra]) {
      assert.ok(stage.additionalDirectories!.includes(d), d);
      assert.ok(judge[0].additionalDirectories!.includes(d), d);
    }
    // судье — только папки: рубрика своя, состояние ему не даётся
    assert.ok(!judge[0].prompt.includes('Пространство agentgraph'));
    const s = saved(o);
    assert.equal(s.addDirs, undefined);
    assert.equal(s.input, 'задача');
  }),
);

test(
  'пространство: раздел собирается на старте этапа — состояние, переписанное во время запуска, видно следующему этапу; удалённое пространство — без раздела',
  withEnv(async (o) => {
    createSpace('p', { title: 'П' });
    writeSpaceState('p', 'Суть: было', { id: 'r0', at: '', kind: 'run' });
    const two = { name: 'two', input: 'з', blocks: [{ name: 'a', phases: [{ name: 'one', tools: [], prompt: 'один' }, { name: 'second', tools: [], prompt: 'два' }] }] } as unknown as FlowSpec;
    const prompts: string[] = [];
    await runFlow(two, {
      ...o,
      ...inSpace('p', o.runsDir, { saveState: false }),
      session: async (req) => {
        prompts.push(req.prompt);
        if (prompts.length === 1) writeSpaceState('p', 'Суть: стало', { id: 's1', at: '', kind: 'session' });
        return result('out');
      },
    });
    assert.match(prompts[0], /Суть: было/);
    assert.match(prompts[1], /Суть: стало/);
    assert.equal(spaceSection({ space: 'nope' }), undefined);
    assert.equal(spaceSection({}), undefined);
    // карта не среди папок этапа — «прочитай», а не «уже в памяти»
    assert.match(spaceSection({ space: 'p', spaceDirs: [] })!, /прочитай её инструментом Read/);
  }),
);

test(
  'пространство: guard — этап с Write/Edit не пишет в папку пространств, отказ в отчёте этапа; без пространства guard тоже есть: папки данных agentgraph',
  withEnv(async (o, root) => {
    createSpace('p');
    const guards: NonNullable<SessionRequest['guard']>[] = [];
    const s1 = { name: 'g', input: 'з', blocks: [{ name: 'a', phases: [{ name: 'w', tools: ['Write', 'Edit'], prompt: 'пиши' }] }] } as unknown as FlowSpec;
    const r = await runFlow(s1, {
      ...o,
      ...inSpace('p', o.runsDir, { saveState: false }),
      session: async (req) => {
        if (req.guard) {
          guards.push(req.guard);
          assert.match(req.guard('Write', { file_path: path.join(spaceDir('p'), 'CLAUDE.md') }, { cwd: o.cwd }) ?? '', /только для чтения/);
          assert.equal(req.guard('Write', { file_path: path.join(o.cwd, 'x.ts') }, { cwd: o.cwd }), undefined);
        }
        return result('out');
      },
    });
    assert.equal(guards.length, 1);
    assert.deepEqual(r.phases[0].denials, [{ tool: 'Write', reason: 'space-readonly', count: 1 }]);
    // без пространства guard тоже есть: этап не пишет ни в пространства, ни в артефакты прошлых запусков (их CLAUDE.md —
    // память пространства), а проект правит как раньше
    const plain: SessionRequest[] = [];
    const proj = path.join(root, 'proj');
    const runsDir = path.join(root, 'runs');
    fs.mkdirSync(proj);
    await runFlow(s1, { ...o, cwd: proj, runsDir, runDir: path.join(runsDir, 'run-2'), session: async (req) => (plain.push(req), result('out')) });
    const g = plain[0].guard!;
    assert.ok(g('Write', { file_path: path.join(spaceDir('p'), 'STATE.md') }, { cwd: proj }));
    assert.ok(g('Write', { file_path: path.join(runsDir, 'old', 'artifacts', 'CLAUDE.md') }, { cwd: proj }));
    assert.equal(g('Write', { file_path: path.join(proj, 'x.ts') }, { cwd: proj }), undefined);
  }),
);

test('пространство: phaseGuard — первый отказ решает, артефакты раньше папок данных; без обоих guard нет', () => {
  assert.deepEqual(phaseGuard(undefined, undefined), {});
  const art = (tool: string) => (tool === 'Read' ? 'артефакты' : undefined);
  const data = (tool: string) => (tool === 'Write' || tool === 'Read' ? 'данные' : undefined);
  const { guard } = phaseGuard(art, data);
  const ctx = { cwd: '/' };
  assert.equal(guard!('Read', {}, ctx), 'артефакты');
  assert.equal(guard!('Write', {}, ctx), 'данные');
  assert.equal(guard!('Bash', {}, ctx), undefined);
});

test(
  'пространство: галочка снята — сессии нет, состояние не меняется, пространство в отчёте есть',
  withEnv(async (o) => {
    createSpace('p');
    writeSpaceState('p', 'старое', { id: 'r0', at: '', kind: 'run' });
    const f = fake();
    const r = await runFlow(spec(), { ...o, ...inSpace('p', o.runsDir), saveState: false, session: f.session });
    assert.equal(r.status, 'done');
    assert.equal(f.states().length, 0);
    assert.equal(readSpace('p')!.state.trim(), 'старое');
    assert.equal(saved(o).space, 'p');
    assert.equal(saved(o).saveState, false);
    assert.match(saved(o).stateUpdate.skipped, /галочка/);
  }),
);

test(
  'пространство: запуск не done — сессии нет, причина в skipped',
  withEnv(async (o) => {
    createSpace('p');
    let f = fake();
    let r = await runFlow(spec({ loop: { max_iterations: 1, until: { type: 'marker', marker: '<DONE>' } } }), { ...o, ...inSpace('p', o.runsDir), session: f.session });
    assert.equal(r.status, 'max_iterations');
    assert.equal(f.states().length, 0);
    assert.match(r.stateUpdate!.skipped!, /max_iterations/);
    f = fake();
    r = await runFlow(spec(), { ...o, ...inSpace('p', o.runsDir), runDir: path.join(o.runsDir, 'run-2'), session: async (req) => (isState(req) ? f.session(req) : result('x', { ok: false, subtype: 'error' })) });
    assert.equal(r.status, 'failed');
    assert.equal(f.states().length, 0);
    assert.match(r.stateUpdate!.skipped!, /failed/);
    f = fake();
    const abort = new AbortController();
    abort.abort();
    r = await runFlow(spec(), { ...o, ...inSpace('p', o.runsDir), runDir: path.join(o.runsDir, 'run-3'), abort, session: f.session });
    assert.equal(r.status, 'aborted');
    assert.equal(f.states().length, 0);
    assert.equal(readSpace('p')!.state, '');
  }),
);

test(
  'пространство: сессия состояния упала или не вернула state — запуск done, ошибка в stateUpdate, старое состояние цело; удалённое пространство — ошибка',
  withEnv(async (o) => {
    createSpace('p');
    writeSpaceState('p', 'старое', { id: 'r0', at: '', kind: 'run' });
    let r = await runFlow(spec(), { ...o, ...inSpace('p', o.runsDir), session: fake(new Error('сеть упала')).session });
    assert.equal(r.status, 'done');
    assert.equal(r.error, undefined);
    assert.match(r.stateUpdate!.error!, /сеть упала/);
    r = await runFlow(spec(), { ...o, ...inSpace('p', o.runsDir), runDir: path.join(o.runsDir, 'run-2'), session: fake({ structured: { state: '  ' } }).session });
    assert.match(r.stateUpdate!.error!, /state/);
    assert.equal(r.stateUpdate!.costUsd, 0.5);
    assert.equal(readSpace('p')!.state.trim(), 'старое');
    const dirs = inSpace('p', o.runsDir);
    fs.rmSync(spaceDir('p'), { recursive: true });
    r = await runFlow(spec(), { ...o, ...dirs, runDir: path.join(o.runsDir, 'run-3'), session: fake().session });
    assert.equal(r.status, 'done');
    assert.match(r.stateUpdate!.error!, /удалили/);
    assert.equal(fs.existsSync(spaceDir('p')), false);
  }),
);

test(
  'без пространства: в run.json нет ключей пространства и тегов, сессии состояния нет',
  withEnv(async (o) => {
    const f = fake();
    await runFlow(spec(), { ...o, session: f.session });
    const s = saved(o);
    for (const k of ['space', 'saveState', 'stateUpdate', 'autoSpace', 'tags', 'saveTag', 'tagSummaries', 'autoTag']) assert.equal(k in s, false, k);
    assert.equal(f.states().length, 0);
    assert.equal(fs.existsSync(path.join(o.runDir!, 'space-state.prompt.md')), false);
    assert.ok(!f.phases()[0].prompt.includes('Пространство'));
  }),
);

test(
  'пространство: длинная задача старого запуска — блоки тегов снимаются до обрезки, сама задача в промпте состояния',
  withEnv(async (o) => {
    createSpace('p');
    const input = `<!-- tag:p -->\nТег задачи: p\n${'x'.repeat(5000)}\n<!-- /tag -->\n\nЗАДАЧА-ХВОСТ`;
    const f = fake();
    await runFlow({ ...spec(), input }, { ...o, ...inSpace('p', o.runsDir), session: f.session });
    assert.match(f.states()[0].prompt, /ЗАДАЧА-ХВОСТ/);
    assert.ok(!f.states()[0].prompt.includes('<!-- tag:p -->'));
  }),
);

test(
  'пространство: пути папки запуска вне artifacts/ вычищаются из состояния, артефакты и файлы репо остаются',
  withEnv(async (o) => {
    createSpace('p');
    const runs = path.dirname(o.runDir!);
    const bad = path.join(o.runDir!, 'iter-01', '02-pick.output.md');
    const good = path.join(o.runDir!, 'artifacts', 'plan.md');
    const repo = '/repo/src/x.ts';
    const f = fake({ structured: { state: `Где читать: \`${bad}\`, [план](${good}), ${repo}.` } });
    const r = await runFlow(spec(), { ...o, ...inSpace('p', o.runsDir), session: f.session });
    const s = readSpace('p')!.state;
    assert.ok(!s.includes(bad), s);
    assert.match(s, /недоступен следующим запускам/);
    assert.ok(s.includes(`(${good})`), s);
    assert.ok(s.includes(repo), s);
    assert.equal(r.stateUpdate!.ok, true);
    assert.equal(dropRunPaths(`${runs}-old/x.md`, runs), `${runs}-old/x.md`);
    assert.match(dropRunPaths(`${runs}/r1/artifacts/../iter-01/a.md`, runs), /недоступен/);
    assert.equal(dropRunPaths(`${runs}/r1/artifacts/a.md.`, runs), `${runs}/r1/artifacts/a.md.`);
  }),
);

test(
  'пространство: «Остановить» во время сессии состояния — запуск done, ошибка в stateUpdate, старое состояние цело',
  withEnv(async (o) => {
    createSpace('p');
    writeSpaceState('p', 'старое', { id: 'r0', at: '', kind: 'run' });
    const abort = new AbortController();
    const r = await runFlow(spec(), {
      ...o,
      ...inSpace('p', o.runsDir),
      abort,
      session: async (req) => {
        if (!isState(req)) return result('out');
        abort.abort();
        return result('', { ok: false, subtype: 'error_during_execution', errors: ['aborted'], costUsd: 0.2 });
      },
    });
    assert.equal(r.status, 'done');
    assert.equal(r.stateUpdate!.ok, false);
    assert.match(r.stateUpdate!.error!, /aborted/);
    assert.equal(readSpace('p')!.state.trim(), 'старое');
  }),
);

test(
  'автопространство: отчёт подбора — в run.json, его стоимость — в totalCostUsd; ошибка подбора без пространства — только autoSpace.error',
  withEnv(async (o) => {
    createSpace('p');
    const f = fake();
    const r = await runFlow(spec(), { ...o, ...inSpace('p', o.runsDir), saveState: true, autoSpace: { slug: 'p', costUsd: 0.01 }, session: f.session });
    const s = saved(o);
    assert.deepEqual(s.autoSpace, { slug: 'p', costUsd: 0.01 });
    assert.equal(s.space, 'p');
    // этап 0.01 + состояние 0.5 + подбор 0.01
    assert.ok(Math.abs(r.totalCostUsd - 0.52) < 1e-9, String(r.totalCostUsd));
    const g = fake();
    await runFlow(spec(), { ...o, runDir: path.join(o.runsDir, 'run-2'), autoSpace: { error: 'таймаут', costUsd: 0 }, session: g.session });
    const s2 = saved({ ...o, runDir: path.join(o.runsDir, 'run-2') });
    assert.equal(s2.autoSpace.error, 'таймаут');
    for (const k of ['space', 'saveState', 'stateUpdate']) assert.equal(k in s2, false, k);
    assert.equal(g.states().length, 0);
  }),
);

test(
  'пространство: блок-вызов — дочерний запуск получает раздел и папки пространства, но состояние пишет только родитель',
  withEnv(async (o) => {
    createSpace('p');
    updateSpace('p', { state: 'Суть: общее' });
    const callee = { name: 'callee', input: 'i', phases: [{ name: 'inner', tools: [], prompt: 'внутри' }] } as unknown as FlowSpec;
    const parent = { name: 'parent', input: 'з', blocks: [{ name: 'call', flow: 'callee' }] } as unknown as FlowSpec;
    const f = fake();
    const r = await runFlow(parent, { ...o, ...inSpace('p', o.runsDir), loadFlow: () => callee, session: f.session });
    assert.equal(r.status, 'done');
    const inner = f.phases().find((x) => x.prompt.startsWith('внутри'))!;
    assert.match(inner.prompt, /Суть: общее/);
    assert.ok(inner.additionalDirectories!.includes(spaceDir('p')));
    assert.equal(f.states().length, 1);
    assert.equal(r.stateUpdate!.ok, true);
  }),
);
