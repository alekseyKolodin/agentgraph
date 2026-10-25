import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerPause, homePauseFields, listArtifacts, readArtifact, writeArtifact, type ArtifactRun } from './artifact-api.js';
import { ArtifactStore, type StepHolder, type StepRef, type StoreReport } from './artifact-store.js';
import { EDIT_MAX, type ArtifactAccess, type DeclaredArtifact } from './artifacts.js';

const DECL: DeclaredArtifact[] = [
  { key: 'plan', title: 'План', file: 'plan.md', initial: '# План\n', decisions: false },
  { key: 'notes', title: 'Заметки', file: 'notes.md', decisions: false },
  { key: 'decisions', title: 'Решения', file: 'decisions.md', decisions: true },
];

type Env = { root: string; runDir: string; report: StoreReport; store: ArtifactStore; resumed: number };

/** Запуск с артефактами: хранилище как у раннера, run.json на диске. */
function setup(status = 'running', declared = DECL): Env {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-api-')));
  const runDir = path.join(root, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const report: StoreReport = { status };
  const save = () => fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(report, null, 2));
  const store = new ArtifactStore({ runDir, declared, report, persist: save });
  store.init();
  save();
  return { root, runDir, report, store, resumed: 0 };
}
const done = (env: Env) => fs.rmSync(env.root, { recursive: true, force: true });
const art = (env: Env, file: string) => path.join(env.runDir, 'artifacts', file);
const runJson = (env: Env) => fs.readFileSync(path.join(env.runDir, 'run.json'), 'utf8');

function liveRun(env: Env, over: Partial<ArtifactRun> = {}): ArtifactRun {
  return {
    status: 'running',
    live: true,
    cliAlive: false,
    continuable: false,
    pendingQuestion: [],
    pause: null,
    view: env.store,
    writable: () => env.store,
    resume: () => {
      env.resumed++;
    },
    ...over,
  };
}

/** Неживой запуск, как его собирает сервер: чтение — open(readonly), запись — open() на запрос. */
function deadRun(env: Env, over: Partial<ArtifactRun> = {}): ArtifactRun {
  return {
    status: 'aborted',
    live: false,
    cliAlive: false,
    continuable: true,
    pendingQuestion: [],
    pause: null,
    view: ArtifactStore.open(env.runDir, { readonly: true })!,
    writable: () => ArtifactStore.open(env.runDir)!,
    ...over,
  };
}

const acc = (read: string[], write: string[] = []): ArtifactAccess => ({ read: [...new Set([...read, ...write])], write, implicit: [] });
/** Идущий шаг этапов: блокировка пишущих до finish(). */
function beginStep(env: Env, members: { name: string; access: ArtifactAccess }[]) {
  env.store.prepareStep();
  const step: StepRef & { kind: 'phases' } = { kind: 'phases', block: 'main', iteration: 1, members: members.map((m) => ({ ...m })) };
  env.store.beginStep(step);
  return () => {
    for (const m of step.members) m.report = {} as StepHolder;
    env.store.finishStep(step);
    env.store.endStep();
  };
}

const body = (r: { body: Record<string, unknown> }) => r.body as Record<string, any>;

test('список: метаданные без текста, путь, можно ли править; пишущий шаг — блокировка с этапами', () => {
  const env = setup();
  try {
    let r = listArtifacts(liveRun(env));
    assert.equal(r.status, 200);
    const items = body(r).items as Record<string, any>[];
    assert.deepEqual(items.map((a) => a.key), ['plan', 'notes', 'decisions']);
    assert.equal(items[0].path, art(env, 'plan.md'));
    assert.equal(items[0].editable, true);
    assert.equal(items[0].text, undefined);
    assert.equal(items[2].decisions, true);

    const finish = beginStep(env, [{ name: 'impl', access: acc(['plan'], ['plan']) }]);
    r = listArtifacts(liveRun(env));
    const plan = (body(r).items as Record<string, any>[])[0];
    assert.deepEqual([plan.editable, plan.reason, plan.lockedBy, plan.phases], [false, 'writing', ['impl'], ['impl']]);
    assert.equal((body(r).items as Record<string, any>[])[1].editable, true);
    finish();
    assert.equal((body(listArtifacts(liveRun(env))).items as Record<string, any>[])[0].editable, true);
  } finally {
    done(env);
  }
});

test('неживой запуск: чтение не пишет run.json, даже если файл изменён снаружи; исчезнувший файл — missing', () => {
  const env = setup('aborted');
  try {
    fs.writeFileSync(art(env, 'plan.md'), 'руками\n- [ ] a\n- [x] b\n');
    fs.rmSync(art(env, 'notes.md'));
    const before = runJson(env);
    const run = deadRun(env);
    const list = body(listArtifacts(run)).items as Record<string, any>[];
    assert.equal(list[1].missing, true);
    assert.equal(list[0].missing, undefined);
    assert.equal(list[0].tasks, undefined, 'список — из метаданных, файл не читается');
    const plan = body(readArtifact(run, 'plan'));
    assert.equal(plan.text, 'руками\n- [ ] a\n- [x] b\n');
    assert.equal(plan.unrecorded, true, 'файл изменён после последней записанной версии');
    assert.deepEqual(plan.tasks, { open: 1, done: 1 }, 'пункты — по текущему тексту');
    assert.equal(plan.reason, 'continuable');
    const notes = readArtifact(run, 'notes');
    assert.deepEqual([notes.status, body(notes).code], [404, 'missing']);
    assert.equal(runJson(env), before, 'GET ничего не пишет');
    assert.throws(() => run.view.userWrite('plan', 'x', '', 'ui'), /только для чтения/);
  } finally {
    done(env);
  }
});

test('пункты чек-листа: в списке и чтении текущей версии; без чек-листа и в чтении версии N — поля нет', () => {
  const env = setup('running', [
    { key: 'checks', title: 'Пункты проверки', file: 'checks.md', initial: '- [ ] a\n- [x] b\n- [X] c\n', decisions: false },
    { key: 'plan', title: 'План', file: 'plan.md', initial: '# План\n', decisions: false },
  ]);
  try {
    const run = liveRun(env);
    const list = body(listArtifacts(run)).items as Record<string, any>[];
    assert.deepEqual(list[0].tasks, { open: 1, done: 2 });
    assert.equal('tasks' in list[1], false);
    const r = body(readArtifact(run, 'checks'));
    assert.deepEqual(r.tasks, { open: 1, done: 2 });
    assert.equal(r.unrecorded, undefined);
    assert.equal('tasks' in body(readArtifact(run, 'plan')), false);
    const w = body(writeArtifact(run, 'checks', { text: '- [x] a\n- [x] b\n- [X] c\n', base: r.hash }));
    assert.equal(w.ok, true);
    assert.deepEqual(body(readArtifact(run, 'checks')).tasks, { open: 0, done: 3 });
    assert.deepEqual((body(listArtifacts(run)).items as Record<string, any>[])[0].tasks, { open: 0, done: 3 });
    assert.equal('tasks' in body(readArtifact(run, 'checks', '1')), false, 'бейдж — по текущей версии');
  } finally {
    done(env);
  }
});

test('чтение: текст, хэш-база, версии; версия N; неизвестный ключ и путь вместо ключа (D21)', () => {
  const env = setup();
  try {
    const run = liveRun(env);
    const r = body(readArtifact(run, 'plan'));
    assert.equal(r.text, '# План\n');
    assert.equal(typeof r.hash, 'string');
    assert.deepEqual(r.author, { kind: 'initial' });
    assert.equal(r.versions.length, 1);
    assert.equal(r.editable, true);

    assert.equal(writeArtifact(run, 'plan', { text: 'v2\n', base: r.hash }).status, 200);
    const v1 = body(readArtifact(run, 'plan', '1'));
    assert.equal(v1.text, '# План\n');
    assert.deepEqual(v1.version.author, { kind: 'initial' });
    assert.equal(body(readArtifact(run, 'plan')).versions.length, 2);
    assert.deepEqual([readArtifact(run, 'plan', '9').status, body(readArtifact(run, 'plan', '9')).code], [404, 'unknown_version']);
    assert.equal(readArtifact(run, 'plan', 'abc').status, 400);

    for (const key of ['nope', '..%2Frun.json', '../run.json', 'constructor', '__proto__', 'plan.md']) {
      const g = readArtifact(run, key);
      assert.deepEqual([g.status, body(g).code], [404, 'unknown_key'], key);
      assert.match(body(g).error, /Артефакты запуска: plan, notes, decisions/);
      const w = writeArtifact(run, key, { text: 'x', base: '' });
      assert.deepEqual([w.status, body(w).code], [404, 'unknown_key'], key);
    }
    assert.ok(!runJson(env).includes('"x"'));
    assert.equal(fs.readFileSync(path.join(env.runDir, 'run.json'), 'utf8').length > 0, true);
  } finally {
    done(env);
  }
});

test('запись живого запуска: успех от скилла; conflict с автором; locked; asking; too_big; плохое тело', () => {
  const env = setup();
  try {
    const run = liveRun(env);
    const base = body(readArtifact(run, 'plan')).hash as string;
    const ok = writeArtifact(run, 'plan', { text: 'правка\n', base, via: 'skill' });
    assert.equal(ok.status, 200);
    assert.equal(body(ok).author.kind, 'user');
    assert.equal(body(ok).author.via, 'skill');
    assert.deepEqual(body(ok).readers, []);
    assert.equal(fs.readFileSync(art(env, 'plan.md'), 'utf8'), 'правка\n');

    // устаревшая база: файл после неё сохранили — 409 с автором и текущим хэшем
    const stale = writeArtifact(run, 'plan', { text: 'моё\n', base });
    assert.equal(stale.status, 409);
    assert.equal(body(stale).code, 'conflict');
    assert.equal(body(stale).author.kind, 'user');
    assert.equal(body(stale).hash, body(ok).hash);
    assert.equal(fs.readFileSync(art(env, 'plan.md'), 'utf8'), 'правка\n');

    const finish = beginStep(env, [{ name: 'impl', access: acc([], ['plan']) }, { name: 'rev', access: acc(['plan']) }]);
    const locked = writeArtifact(run, 'plan', { text: 'x', base: body(ok).hash });
    assert.deepEqual([locked.status, body(locked).code, body(locked).reason, body(locked).phases], [423, 'locked', 'writing', ['impl']]);
    const asking = writeArtifact(liveRun(env, { pendingQuestion: ['impl'] }), 'plan', { text: 'x', base: body(ok).hash });
    assert.deepEqual([asking.status, body(asking).reason, body(asking).phases], [423, 'asking', ['impl']]);
    // notes пишущий шаг не пишет: правка открыта; читатели шага — в ответе
    const notesBase = body(readArtifact(run, 'notes')).hash as string;
    finish();
    const finish2 = beginStep(env, [{ name: 'rev', access: acc(['notes']) }]);
    const read = writeArtifact(run, 'notes', { text: 'n\n', base: notesBase });
    assert.deepEqual(body(read).readers, ['rev']);
    finish2();

    const big = writeArtifact(run, 'notes', { text: 'я'.repeat(EDIT_MAX / 2 + 1), base: body(read).hash });
    assert.deepEqual([big.status, body(big).code], [413, 'too_big']);
    for (const b of [{}, { text: 1, base: '' }, { text: 'x' }, { text: 'x', base: '', resume: 'yes' }]) {
      assert.deepEqual([writeArtifact(run, 'notes', b).status, body(writeArtifact(run, 'notes', b)).code], [400, 'bad_request'], JSON.stringify(b));
    }
  } finally {
    done(env);
  }
});

test('«Сохранить и возобновить»: не на паузе — 409 not_paused до записи; на паузе — запись и возобновление', () => {
  const env = setup();
  try {
    const base = body(readArtifact(liveRun(env), 'plan')).hash as string;
    for (const pause of [null, 'requested'] as const) {
      const r = writeArtifact(liveRun(env, { pause }), 'plan', { text: 'x\n', base, resume: true });
      assert.deepEqual([r.status, body(r).code], [409, 'not_paused'], String(pause));
    }
    assert.equal(fs.readFileSync(art(env, 'plan.md'), 'utf8'), '# План\n');
    assert.equal(env.resumed, 0);
    const r = writeArtifact(liveRun(env, { pause: 'paused' }), 'plan', { text: 'x\n', base, resume: true });
    assert.equal(r.status, 200);
    assert.equal(body(r).resumed, true);
    assert.equal(env.resumed, 1);
    // у неживого запуска возобновлять нечего
    env.report.status = 'aborted';
    fs.writeFileSync(path.join(env.runDir, 'run.json'), JSON.stringify(env.report));
    const dead = writeArtifact(deadRun(env), 'plan', { text: 'y\n', base: body(r).hash, resume: true });
    assert.deepEqual([dead.status, body(dead).code], [409, 'not_paused']);
  } finally {
    done(env);
  }
});

test('запись неживого запуска: продолжаемый — правка и сразу run.json; done, CLI, продолжить нельзя, больше 1 МБ — 403 readonly без записи', () => {
  const env = setup('aborted');
  try {
    const base = body(readArtifact(deadRun(env), 'plan')).hash as string;
    const before = runJson(env);
    const cases: [Partial<ArtifactRun>, string][] = [
      [{ status: 'done', continuable: false }, 'done'],
      [{ status: 'running', cliAlive: true, continuable: false }, 'cli'],
      [{ continuable: false, continueReason: 'Первый блок «main» не завершён' }, 'not-continuable'],
    ];
    for (const [over, reason] of cases) {
      const r = writeArtifact(deadRun(env, over), 'plan', { text: 'x\n', base });
      assert.deepEqual([r.status, body(r).code, body(r).reason], [403, 'readonly', reason]);
    }
    assert.equal(runJson(env), before, 'отказ — run.json не тронут');
    assert.equal(fs.readFileSync(art(env, 'plan.md'), 'utf8'), '# План\n');

    const r = writeArtifact(deadRun(env), 'plan', { text: 'в продолжение\n', base });
    assert.equal(r.status, 200);
    const saved = JSON.parse(runJson(env)) as StoreReport;
    const plan = saved.artifacts!.items.find((m) => m.key === 'plan')!;
    assert.equal(plan.versions.at(-1)!.author.kind, 'user');
    assert.equal(plan.hash, body(r).hash);

    fs.writeFileSync(art(env, 'notes.md'), 'a'.repeat(EDIT_MAX + 1));
    const big = writeArtifact(deadRun(env), 'notes', { text: 'x', base: '' });
    assert.deepEqual([big.status, body(big).reason], [403, 'too-big']);
    const read = body(readArtifact(deadRun(env), 'notes'));
    assert.equal(read.editable, false);
    assert.match(read.message, /notes\.md/);
  } finally {
    done(env);
  }
});

test('изменение снаружи у неживого запуска: запись со старой базой — conflict с автором «снаружи»; со свежей — версия «снаружи», затем правка', () => {
  const env = setup('aborted');
  try {
    const old = body(readArtifact(deadRun(env), 'plan')).hash as string;
    fs.writeFileSync(art(env, 'plan.md'), 'руками\n');
    const c = writeArtifact(deadRun(env), 'plan', { text: 'x\n', base: old });
    assert.deepEqual([c.status, body(c).code, body(c).author.kind], [409, 'conflict', 'outside']);
    const fresh = body(readArtifact(deadRun(env), 'plan')).hash as string;
    assert.equal(writeArtifact(deadRun(env), 'plan', { text: 'x\n', base: fresh }).status, 200);
    const plan = (JSON.parse(runJson(env)) as StoreReport).artifacts!.items.find((m) => m.key === 'plan')!;
    assert.deepEqual(plan.versions.map((v) => v.author.kind), ['initial', 'outside', 'user']);
  } finally {
    done(env);
  }
});

test('ответ на паузу: запись в decisions и в pauses, возобновление; не на паузе, ручная пауза, без decisions, большой — ошибка без записи', () => {
  const env = setup();
  try {
    const run = liveRun(env, { pause: 'paused' });
    const decisions = art(env, 'decisions.md');
    // ручная пауза: агент паузу не просил
    let r = answerPause('paused', run, 'да', 'skill');
    assert.deepEqual([r.status, body(r).code], [409, 'not_paused']);
    env.report.pauses = [{ block: 'main', iteration: 2, phase: 'plan', text: 'Какой вариант?\nА или Б', at: '2026-10-15T10:00:00.000Z' }];
    for (const pause of [null, 'requested'] as const) {
      r = answerPause(pause, run, 'Б', 'skill');
      assert.deepEqual([r.status, body(r).code], [409, 'not_paused']);
    }
    r = answerPause('paused', undefined, 'Б', 'skill');
    assert.deepEqual([r.status, body(r).code], [400, 'no_decisions']);
    r = answerPause('paused', run, 'я'.repeat(40 * 1024), 'skill');
    assert.deepEqual([r.status, body(r).code], [413, 'too_big']);
    assert.equal(fs.readFileSync(decisions, 'utf8'), '');
    assert.equal(env.resumed, 0);

    r = answerPause('paused', run, 'Вариант Б', 'skill');
    assert.equal(r.status, 200);
    assert.equal(env.resumed, 1);
    const text = fs.readFileSync(decisions, 'utf8');
    assert.match(text, /Блок main, итерация 2, этап plan\./);
    assert.match(text, /> Какой вариант\?\n> А или Б/);
    assert.match(text, /Ответ:\nВариант Б/);
    assert.equal(env.report.pauses[0].answer?.text, 'Вариант Б');
    assert.equal(env.report.pauses[0].answer?.via, 'skill');

    const noDecisions = setup('running', DECL.filter((a) => !a.decisions));
    try {
      const nr = answerPause('paused', liveRun(noDecisions), 'x', 'ui');
      assert.deepEqual([nr.status, body(nr).code], [400, 'no_decisions']);
    } finally {
      done(noDecisions);
    }
  } finally {
    done(env);
  }
});

test('главная: поля паузы агента и decisions только когда есть; ручная пауза и flow без decisions — без полей', () => {
  const reason = { phase: 'ask', iteration: 2, at: '2026-10-15T12:00:00.000Z', text: 'вопрос', output: 'out.md', block: 'main' };
  assert.deepEqual(homePauseFields('paused', reason, true), {
    pauseReason: { phase: 'ask', iteration: 2, at: '2026-10-15T12:00:00.000Z' },
    decisions: true,
  });
  // текст вопросов и путь вывода на главную не уходят
  assert.deepEqual(Object.keys(homePauseFields('requested', reason, false).pauseReason ?? {}), ['phase', 'iteration', 'at']);
  assert.deepEqual(homePauseFields('paused', undefined, true), { decisions: true });
  assert.deepEqual(homePauseFields(null, reason, false), {});
  assert.deepEqual(homePauseFields(null, undefined, false), {});
});
