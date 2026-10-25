import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore, HISTORY_DIR, QUARANTINE_DIR, type ArtifactsEvent, type StepHolder, type StepRef, type StoreReport } from './artifact-store.js';
import { artifactAccess, INLINE_MAX, MAP_MAX, type ArtifactAccess, type DeclaredArtifact } from './artifacts.js';

const DECL: DeclaredArtifact[] = [
  { key: 'plan', title: 'План', file: 'plan.md', initial: '# План\n', decisions: false },
  { key: 'notes', title: 'Заметки', file: 'notes.md', decisions: false },
  { key: 'decisions', title: 'Решения', file: 'decisions.md', decisions: true },
];

type Env = { root: string; runDir: string; report: StoreReport; events: ArtifactsEvent[]; saves: number; store: ArtifactStore };

function setup(over: { declared?: DeclaredArtifact[]; from?: { runId: string; runDir: string }; runId?: string; root?: string } = {}): Env {
  const root = over.root ?? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-store-')));
  const runDir = path.join(root, 'runs', over.runId ?? 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const env = { root, runDir, report: {} as StoreReport, events: [] as ArtifactsEvent[], saves: 0 } as Env;
  env.store = new ArtifactStore({
    runDir,
    declared: over.declared ?? DECL,
    report: env.report,
    persist: () => {
      env.saves++;
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(env.report, null, 2));
    },
    emit: (e) => env.events.push(structuredClone(e)),
  });
  env.store.init(over.from);
  env.store.prepareStep();
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(env.report, null, 2));
  return env;
}

const done = (env: Env) => fs.rmSync(env.root, { recursive: true, force: true });
const art = (env: Env, file: string) => path.join(env.runDir, 'artifacts', file);
const item = (env: Env, key: string) => env.report.artifacts!.items.find((m) => m.key === key)!;
const author = (env: Env, key: string) => item(env, key).versions.at(-1)!.author;
const acc = (read: string[], write: string[] = []): ArtifactAccess => ({ read: [...new Set([...read, ...write])], write, implicit: [] });

/** Шаг этапов с отчётами-заглушками: run — что делает «сессия» между beginStep и finishStep. */
function phaseStep(env: Env, members: { name: string; access: ArtifactAccess }[], run: () => void, iteration = 1): StepRef & { kind: 'phases' } {
  env.store.prepareStep();
  const step: StepRef & { kind: 'phases' } = { kind: 'phases', block: 'main', iteration, members: members.map((m) => ({ ...m })) };
  env.store.beginStep(step);
  try {
    run();
  } finally {
    for (const m of step.members) m.report = {} as StepHolder;
    env.store.finishStep(step);
    env.store.endStep();
  }
  return step;
}

test('B1: при старте файлы созданы — с initial как есть или пустые; версия 1 с автором «заготовка» или «ещё не заполнялся»', () => {
  const env = setup();
  try {
    assert.equal(fs.readFileSync(art(env, 'plan.md'), 'utf8'), '# План\n');
    assert.equal(fs.readFileSync(art(env, 'notes.md'), 'utf8'), '');
    assert.deepEqual(author(env, 'plan'), { kind: 'initial' });
    assert.deepEqual(author(env, 'notes'), { kind: 'empty' });
    assert.equal(item(env, 'decisions').decisions, true);
    assert.equal(fs.readFileSync(path.join(env.runDir, HISTORY_DIR, 'plan', '0001.md'), 'utf8'), '# План\n');
    assert.deepEqual(env.report.artifacts!.warnings, []);
    assert.equal(env.report.artifacts!.from, undefined);
    assert.equal(env.events.length, 0, 'без изменений событий нет');
    assert.throws(() => env.store.init(), /EEXIST/, 'повторная инициализация в ту же папку — ошибка');
  } finally {
    done(env);
  }
});

test('B10: изменение пишущим этапом — автор этап, версия в истории, в отчёте этапа «изменил»; событие с итогом шага', () => {
  const env = setup();
  try {
    const step = phaseStep(env, [{ name: 'code', access: acc(['plan'], ['notes']) }], () => fs.writeFileSync(art(env, 'notes.md'), 'готово'));
    assert.deepEqual(step.members[0].report!.artifacts, { changed: ['notes'], warnings: [] });
    const a = author(env, 'notes');
    assert.equal(a.kind, 'phase');
    assert.equal((a as { phase: string }).phase, 'code');
    assert.equal(item(env, 'notes').versions.length, 2);
    assert.equal(fs.readFileSync(path.join(env.runDir, HISTORY_DIR, 'notes', '0002.md'), 'utf8'), 'готово');
    const last = env.events.at(-1)!;
    assert.deepEqual(last.step?.phases, [{ phase: 'code', changed: ['notes'], warnings: [], denials: [] }]);
    assert.deepEqual(last.items.find((i) => i.key === 'notes')!.lockedBy, []);
    // блокировка выставлялась на шаг и сообщалась событием
    assert.ok(env.events.some((e) => !e.step && e.items.find((i) => i.key === 'notes')!.lockedBy[0] === 'code'));
  } finally {
    done(env);
  }
});

test('C2: изменение артефакта этапом без права записи — «неизвестно», предупреждение первому участнику, содержимое не откатано', () => {
  const env = setup();
  try {
    const step = phaseStep(env, [{ name: 'verify', access: acc(['plan']) }, { name: 'other', access: acc([]) }], () => fs.writeFileSync(art(env, 'plan.md'), 'через Bash'));
    assert.equal(author(env, 'plan').kind, 'unknown');
    assert.equal(fs.readFileSync(art(env, 'plan.md'), 'utf8'), 'через Bash');
    const w = step.members[0].report!.artifacts!.warnings;
    assert.equal(w.length, 1);
    assert.match(w[0], /«План» изменён во время шага verify, other \(итерация 1\) не через UI.*не откатано.*в истории/);
    assert.deepEqual(step.members[0].report!.artifacts!.changed, []);
    assert.equal(fs.readFileSync(path.join(env.runDir, HISTORY_DIR, 'plan', '0001.md'), 'utf8'), '# План\n', 'прежняя версия в истории');
  } finally {
    done(env);
  }
});

test('изменение во время проверки условия — автор «условие», без предупреждения; finishStep идемпотентен', () => {
  const env = setup();
  try {
    env.store.prepareStep();
    const step: StepRef = { kind: 'condition', block: 'main', iteration: 2 };
    env.store.beginStep(step);
    fs.writeFileSync(art(env, 'notes.md'), 'команда');
    step.report = {};
    env.store.finishStep(step);
    env.store.finishStep(step);
    env.store.endStep();
    assert.deepEqual(author(env, 'notes'), { kind: 'condition', block: 'main', iteration: 2, at: (author(env, 'notes') as { at: string }).at });
    assert.deepEqual(step.report.artifacts, { changed: ['notes'], warnings: [] });
    assert.equal(item(env, 'notes').versions.length, 2);
  } finally {
    done(env);
  }
});

test('D8 (уточнение 1): изменение между шагами не через API — автор «снаружи», без предупреждения, сохранено сразу', () => {
  const env = setup();
  try {
    fs.writeFileSync(art(env, 'plan.md'), 'руками');
    const saves = env.saves;
    env.store.prepareStep();
    assert.equal(author(env, 'plan').kind, 'outside');
    assert.deepEqual(env.report.artifacts!.warnings, []);
    assert.ok(env.saves > saves);
    assert.match(env.store.section(acc(['plan'])), /изменён вне этапов между шагами .*, источник не установлен/);
  } finally {
    done(env);
  }
});

test('C4: CLAUDE.md и .claude в папке артефактов — в карантин перед следующим шагом, предупреждение у этапа, после которого нашли', () => {
  const env = setup();
  try {
    const step = phaseStep(env, [{ name: 'code', access: acc([], ['plan']) }], () => {
      fs.writeFileSync(art(env, 'CLAUDE.md'), 'инструкции');
      fs.mkdirSync(art(env, '.claude/skills'), { recursive: true });
      fs.writeFileSync(art(env, '.env'), 'x');
      fs.symlinkSync('/etc', art(env, 'etc.md'));
    });
    env.store.prepareStep();
    assert.deepEqual(fs.readdirSync(path.join(env.runDir, 'artifacts')).sort(), ['decisions.md', 'notes.md', 'plan.md']);
    const q = fs.readdirSync(path.join(env.runDir, QUARANTINE_DIR));
    assert.equal(q.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(env.runDir, QUARANTINE_DIR, q[0])).sort(), ['.claude', '.env', 'CLAUDE.md', 'etc.md']);
    const w = step.members[0].report!.artifacts!.warnings;
    assert.equal(w.length, 4);
    assert.ok(w.every((x) => x.includes('после этапа code (итерация 1)') && x.includes(QUARANTINE_DIR)), w.join('\n'));
  } finally {
    done(env);
  }
});

test('C5: посторонний обычный файл остаётся, предупреждение одно за два шага', () => {
  const env = setup();
  try {
    fs.writeFileSync(art(env, 'extra.txt'), 'x');
    env.store.prepareStep();
    env.store.prepareStep();
    phaseStep(env, [{ name: 'a', access: acc([]) }], () => {});
    assert.ok(fs.existsSync(art(env, 'extra.txt')));
    const all = [...env.report.artifacts!.warnings];
    assert.equal(all.filter((w) => w.includes('extra.txt')).length, 1);
  } finally {
    done(env);
  }
});

test('C6: удалённый артефакт пересоздаётся пустым, предупреждение у этапа, после которого нашли', () => {
  const env = setup();
  try {
    const step = phaseStep(env, [{ name: 'a', access: acc([]) }, { name: 'b', access: acc([], ['plan']) }], () => fs.rmSync(art(env, 'plan.md')));
    env.store.prepareStep();
    assert.equal(fs.readFileSync(art(env, 'plan.md'), 'utf8'), '');
    assert.equal(step.members[0].report!.artifacts!.warnings.length, 0, 'предупреждение — пишущему этот артефакт участнику');
    assert.match(step.members[1].report!.artifacts!.warnings[0], /«План» исчез после шага a, b \(итерация 1\): создан пустым/);
  } finally {
    done(env);
  }
});

test('подмена артефакта симлинком и жёсткая ссылка: ссылка — в карантин и пустой файл, жёсткая — пересоздана копией', () => {
  const env = setup();
  try {
    const outside = path.join(env.root, 'secret.txt');
    fs.writeFileSync(outside, 'секрет');
    fs.rmSync(art(env, 'plan.md'));
    fs.symlinkSync(outside, art(env, 'plan.md'));
    fs.writeFileSync(art(env, 'notes.md'), 'заметка');
    fs.linkSync(art(env, 'notes.md'), path.join(env.root, 'hard.md'));
    env.store.prepareStep();
    assert.ok(fs.lstatSync(art(env, 'plan.md')).isFile());
    assert.equal(fs.readFileSync(art(env, 'plan.md'), 'utf8'), '');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'секрет');
    assert.equal(fs.lstatSync(art(env, 'notes.md')).nlink, 1);
    assert.equal(fs.readFileSync(art(env, 'notes.md'), 'utf8'), 'заметка');
    fs.writeFileSync(path.join(env.root, 'hard.md'), 'через вторую ссылку');
    assert.equal(fs.readFileSync(art(env, 'notes.md'), 'utf8'), 'заметка', 'связь разорвана');
    assert.equal(env.report.artifacts!.warnings.length, 2);
  } finally {
    done(env);
  }
});

test('папку артефактов подменили симлинком — в карантин, создана заново с пустыми файлами', () => {
  const env = setup();
  try {
    const dir = path.join(env.runDir, 'artifacts');
    fs.renameSync(dir, path.join(env.root, 'moved'));
    fs.symlinkSync(path.join(env.root, 'moved'), dir);
    env.store.prepareStep();
    assert.ok(fs.lstatSync(dir).isDirectory());
    assert.deepEqual(fs.readdirSync(dir).sort(), ['decisions.md', 'notes.md', 'plan.md']);
    assert.match(env.report.artifacts!.warnings[0], /подменена/);
  } finally {
    done(env);
  }
});

test('D4, D14: userWrite — автор «пользователь», версия; во время читающего шага — список читателей, без ложного предупреждения', () => {
  const env = setup();
  try {
    let res: ReturnType<ArtifactStore['userWrite']> | undefined;
    const step = phaseStep(env, [{ name: 'verify', access: acc(['plan']) }], () => {
      res = env.store.userWrite('plan', 'правка', item(env, 'plan').hash, 'ui');
    });
    assert.ok(res?.ok);
    if (res?.ok) assert.deepEqual(res.readers, ['verify']);
    assert.equal(author(env, 'plan').kind, 'user');
    assert.deepEqual(step.members[0].report!.artifacts!.warnings, []);
    assert.equal(fs.readFileSync(path.join(env.runDir, HISTORY_DIR, 'plan', '0002.md'), 'utf8'), 'правка');
    assert.match(env.store.section(acc(['plan'])), /последнюю правку сделал пользователь .*: учитывай её и не откатывай/);
    const saved = JSON.parse(fs.readFileSync(path.join(env.runDir, 'run.json'), 'utf8'));
    assert.equal(saved.artifacts.items[0].versions.at(-1).author.kind, 'user', 'сохранено сразу');
  } finally {
    done(env);
  }
});

test('userWrite: пишущий шаг — locked; устаревшая база — conflict с автором; больше 1 МБ — too_big; неизвестный ключ', () => {
  const env = setup();
  try {
    const base = item(env, 'plan').hash;
    phaseStep(env, [{ name: 'code', access: acc([], ['plan']) }], () => {
      const r = env.store.userWrite('plan', 'x', base, 'ui');
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, 'locked');
      if (!r.ok && r.code === 'locked') assert.deepEqual(r.phases, ['code']);
      fs.writeFileSync(art(env, 'plan.md'), 'этап');
    });
    const c = env.store.userWrite('plan', 'моё', base, 'ui');
    assert.equal(c.ok, false);
    if (!c.ok && c.code === 'conflict') {
      assert.equal(c.author.kind, 'phase');
      assert.equal(c.hash, item(env, 'plan').hash);
      assert.ok(c.at);
    } else assert.fail('ждали conflict');
    assert.equal(fs.readFileSync(art(env, 'plan.md'), 'utf8'), 'этап');
    const big = env.store.userWrite('plan', 'я'.repeat(600 * 1024), item(env, 'plan').hash, 'ui');
    assert.equal(!big.ok && big.code, 'too_big');
    const unk = env.store.userWrite('../run.json', 'x', '', 'ui');
    assert.equal(!unk.ok && unk.code, 'unknown_key');
    const proto = env.store.userWrite('constructor', 'x', '', 'ui');
    assert.equal(!proto.ok && proto.code, 'unknown_key');
  } finally {
    done(env);
  }
});

test('F1: ответ на паузу — запись в конец decisions (время, блок, итерация, этап, вопросы цитатой, ответ) и answer в pauses', () => {
  const env = setup();
  try {
    env.report.pauses = [{ block: 'main', iteration: 2, phase: 'review', text: 'Стенд или перенос?\nВторой вопрос', at: 'x' }];
    fs.writeFileSync(art(env, 'decisions.md'), 'Решение этапа');
    env.store.prepareStep();
    const r = env.store.appendAnswer('  Стенд  ', 'ui');
    assert.ok(r.ok);
    const text = fs.readFileSync(art(env, 'decisions.md'), 'utf8');
    assert.match(text, /^Решение этапа\n\n## Ответ на паузу — \d\d\.\d\d \d\d:\d\d\n\nБлок main, итерация 2, этап review\.\n\nВопросы этапа:\n> Стенд или перенос\?\n> Второй вопрос\n\nОтвет:\nСтенд\n$/);
    const p = env.report.pauses![0];
    assert.equal(p.answer?.text, 'Стенд');
    assert.equal(p.answer?.via, 'ui');
    assert.equal(author(env, 'decisions').kind, 'user');
  } finally {
    done(env);
  }
});

test('F2: ответ не записан — нет паузы, пустой, пишущий шаг, нет decisions: файл не тронут', () => {
  const env = setup();
  try {
    const before = fs.readFileSync(art(env, 'decisions.md'), 'utf8');
    assert.equal((env.store.appendAnswer('x', 'ui') as { code: string }).code, 'not_paused');
    env.report.pauses = [{ block: 'main', iteration: 1, phase: 'a', text: 'q' }];
    assert.equal((env.store.appendAnswer('   ', 'ui') as { code: string }).code, 'empty');
    phaseStep(env, [{ name: 'w', access: acc([], ['decisions']) }], () => {
      assert.equal((env.store.appendAnswer('x', 'ui') as { code: string }).code, 'locked');
    });
    assert.equal(fs.readFileSync(art(env, 'decisions.md'), 'utf8'), before);
    assert.equal(env.report.pauses![0].answer, undefined);
    const none = setup({ declared: [DECL[0]] });
    try {
      none.report.pauses = [{ block: 'main', iteration: 1, phase: 'a', text: 'q' }];
      assert.equal((none.store.appendAnswer('x', 'ui') as { code: string }).code, 'no_decisions');
    } finally {
      done(none);
    }
  } finally {
    done(env);
  }
});

test('E2–E4: продолжение — копия текущих файлов по ключу, автор переносится с пометкой; новый — из initial; убранный — нет; смена file', () => {
  const prev = setup({ runId: 'old' });
  try {
    prev.store.userWrite('plan', 'план пользователя', item(prev, 'plan').hash, 'ui');
    fs.writeFileSync(art(prev, 'notes.md'), 'правка руками после остановки');
    const declared: DeclaredArtifact[] = [
      { key: 'plan', title: 'План', file: 'the-plan.txt', decisions: false },
      { key: 'notes', title: 'Заметки', file: 'notes.md', decisions: false },
      { key: 'fresh', title: 'Новое', file: 'fresh.md', initial: 'новое', decisions: false },
    ];
    const next = setup({ root: prev.root, runId: 'new', declared, from: { runId: 'old', runDir: prev.runDir } });
    assert.equal(fs.readFileSync(art(next, 'the-plan.txt'), 'utf8'), 'план пользователя', 'E3');
    assert.equal(author(next, 'plan').kind, 'user', 'E4: автор перенесён');
    assert.equal(item(next, 'plan').versions.at(-1)!.fromRun, 'old');
    assert.match(next.store.section(acc(['plan'])), /последнюю правку сделал пользователь .* \(из запуска old\): учитывай/);
    assert.equal(author(next, 'notes').kind, 'outside', 'правка руками после остановки');
    assert.equal(fs.readFileSync(art(next, 'fresh.md'), 'utf8'), 'новое', 'E2');
    assert.ok(!fs.existsSync(art(next, 'decisions.md')), 'E2: убранный не копируется');
    assert.equal(next.report.artifacts!.from, 'old', 'E5');
    assert.deepEqual(item(next, 'plan').versions.map((v) => v.n), [1], 'нумерация версий заново, история не копируется');
  } finally {
    done(prev);
  }
});

test('продолжение: file с .. в run.json прошлого запуска и ссылка вместо файла — не копируются', () => {
  const prev = setup({ runId: 'old' });
  try {
    fs.writeFileSync(path.join(prev.root, 'secret.md'), 'секрет');
    const saved = JSON.parse(fs.readFileSync(path.join(prev.runDir, 'run.json'), 'utf8'));
    saved.artifacts.items[0].file = '../../secret.md';
    fs.writeFileSync(path.join(prev.runDir, 'run.json'), JSON.stringify(saved));
    fs.rmSync(art(prev, 'notes.md'));
    fs.symlinkSync(path.join(prev.root, 'secret.md'), art(prev, 'notes.md'));
    const next = setup({ root: prev.root, runId: 'new', from: { runId: 'old', runDir: prev.runDir } });
    assert.equal(fs.readFileSync(art(next, 'plan.md'), 'utf8'), '# План\n');
    assert.equal(fs.readFileSync(art(next, 'notes.md'), 'utf8'), '');
    assert.ok(next.report.artifacts!.warnings.some((w) => w.includes('не обычный файл')));
  } finally {
    done(prev);
  }
});

test('open(): неживой запуск — сверка с диском (снаружи; у оборвавшегося — неизвестно), запись, чтение версий', () => {
  const env = setup();
  try {
    fs.writeFileSync(art(env, 'plan.md'), 'после остановки');
    const s = ArtifactStore.open(env.runDir)!;
    const saved = () => JSON.parse(fs.readFileSync(path.join(env.runDir, 'run.json'), 'utf8'));
    assert.equal(saved().artifacts.items[0].versions.at(-1).author.kind, 'outside');
    const r = s.read('plan');
    assert.ok(r.ok && r.text === 'после остановки');
    const w = s.userWrite('plan', 'правка', r.ok ? r.hash : '', 'skill');
    assert.ok(w.ok);
    assert.deepEqual(saved().artifacts.items[0].versions.at(-1).author.via, 'skill');
    const v1 = s.readVersion('plan', 1);
    assert.ok(v1.ok && v1.stored && v1.text === '# План\n');
    assert.equal((s.readVersion('plan', 99) as { code: string }).code, 'unknown_version');

    const raw = saved();
    raw.status = 'running';
    raw.phases = [{ block: 'main', iteration: 3, phase: 'code' }];
    fs.writeFileSync(path.join(env.runDir, 'run.json'), JSON.stringify(raw));
    fs.writeFileSync(art(env, 'notes.md'), 'оборвался посреди шага');
    ArtifactStore.open(env.runDir);
    const notes = saved().artifacts.items[1].versions.at(-1).author;
    assert.deepEqual([notes.kind, notes.phase, notes.iteration], ['unknown', 'code', 3]);
  } finally {
    done(env);
  }
});

test('open(): записи с плохим file или ключом из run.json отбрасываются; без артефактов — undefined', () => {
  const env = setup();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(env.runDir, 'run.json'), 'utf8'));
    raw.artifacts.items.push({ ...raw.artifacts.items[0], key: 'evil', file: '../run.json' });
    raw.artifacts.items.push({ ...raw.artifacts.items[0], key: 'constructor', file: 'c.md' });
    raw.artifacts.items.push({ ...raw.artifacts.items[0], key: '__proto__', file: 'p.md' });
    fs.writeFileSync(path.join(env.runDir, 'run.json'), JSON.stringify(raw));
    const s = ArtifactStore.open(env.runDir)!;
    assert.deepEqual(s.list().map((i) => i.key), ['plan', 'notes', 'decisions', 'constructor']);
    assert.equal((s.userWrite('evil', 'x', '', 'ui') as { code: string }).code, 'unknown_key');
    fs.writeFileSync(path.join(env.runDir, 'run.json'), '{}');
    assert.equal(ArtifactStore.open(env.runDir), undefined);
  } finally {
    done(env);
  }
});

test('B5, B8, B12: снимок — путь у всех, содержимое только у упомянутых, большой файл — карта, пустой — пусто', () => {
  const env = setup();
  try {
    const big = Array.from({ length: 60 }, (_, i) => `## Шаг ${i + 1}\nО шаге ${i + 1}.\n${'текст шага\n'.repeat(60)}`).join('');
    assert.ok(Buffer.byteLength(big) > INLINE_MAX);
    fs.writeFileSync(art(env, 'notes.md'), big);
    env.store.prepareStep();
    const snap = env.store.snapshot(['{{artifacts.notes}}', '{{artifacts.decisions}} {{artifacts.plan.path}}']);
    assert.equal(snap.plan.text, '');
    assert.equal(snap.plan.path, path.join(env.store.dir, 'plan.md'));
    assert.equal(snap.decisions.text, '');
    assert.equal(snap.decisions.mapped, undefined);
    assert.equal(snap.notes.mapped, true);
    assert.ok(Buffer.byteLength(snap.notes.text) <= MAP_MAX);
    assert.match(snap.notes.text, new RegExp(`^Карта артефакта «Заметки» — \\d+ КБ, строк: ${60 * 62}, файл ${art(env, 'notes.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`));
    assert.match(snap.notes.text, /\n- Шаг 1 — строки 1–62 \(62\), \d+ (Б|КБ): О шаге 1\./);
    assert.ok(!snap.notes.text.includes('текст шага\nтекст шага'), 'не начало файла');
    assert.equal(fs.readFileSync(art(env, 'notes.md'), 'utf8'), big, 'файл не меняется');
  } finally {
    done(env);
  }
});

test('версия файла больше 1 МБ — без копии, с предупреждением', () => {
  const env = setup();
  try {
    const step = phaseStep(env, [{ name: 'w', access: artifactAccess({ prompt: '', tools: [], writes: ['notes'] }) }], () => fs.writeFileSync(art(env, 'notes.md'), Buffer.alloc(1024 * 1024 + 1, 0x61)));
    const v = item(env, 'notes').versions.at(-1)!;
    assert.equal(v.stored, false);
    assert.equal(v.size, 1024 * 1024 + 1);
    assert.match(step.members[0].report!.artifacts!.warnings[0], /без копии/);
    assert.ok(!fs.existsSync(path.join(env.runDir, HISTORY_DIR, 'notes', '0002.md')));
    const r = env.store.readVersion('notes', 2);
    assert.ok(r.ok && !r.stored);
  } finally {
    done(env);
  }
});

test('пункты чек-листа: в мете, списке, событии и run.json; без чек-листа и у не-markdown — поля нет', () => {
  const env = setup({
    declared: [
      { key: 'checks', title: 'Пункты проверки', file: 'checks.md', initial: '# Пункты\n- [ ] a\n- [x] b\n- [ ] c\n', decisions: false },
      { key: 'plan', title: 'План', file: 'plan.md', initial: '# План\n', decisions: false },
      { key: 'data', title: 'Данные', file: 'data.json', initial: '"- [ ] a"\n- [ ] b\n', decisions: false },
    ],
  });
  try {
    assert.deepEqual(item(env, 'checks').tasks, { open: 2, done: 1 });
    assert.equal('tasks' in item(env, 'plan'), false);
    assert.equal('tasks' in item(env, 'data'), false);
    const list = env.store.list();
    assert.deepEqual(list.find((a) => a.key === 'checks')!.tasks, { open: 2, done: 1 });
    assert.equal('tasks' in list.find((a) => a.key === 'plan')!, false);
    assert.equal('tasks' in list.find((a) => a.key === 'data')!, false);

    // отметили пункт — число меняется, событие несёт новое
    const w1 = env.store.userWrite('checks', '- [x] a\n- [x] b\n- [ ] c\n', item(env, 'checks').hash, 'ui');
    assert.ok(w1.ok);
    assert.deepEqual(item(env, 'checks').tasks, { open: 1, done: 2 });
    assert.deepEqual(env.events.at(-1)!.items.find((a) => a.key === 'checks')!.tasks, { open: 1, done: 2 });
    const saved = JSON.parse(fs.readFileSync(path.join(env.runDir, 'run.json'), 'utf8')) as StoreReport;
    assert.deepEqual(saved.artifacts!.items.find((m) => m.key === 'checks')!.tasks, { open: 1, done: 2 });

    // чек-лист убрали — поле исчезает отовсюду
    const w2 = env.store.userWrite('checks', '# Всё исправлено\n', item(env, 'checks').hash, 'ui');
    assert.ok(w2.ok);
    assert.equal('tasks' in item(env, 'checks'), false);
    assert.equal('tasks' in env.events.at(-1)!.items.find((a) => a.key === 'checks')!, false);

    // чек-лист появился в пустом артефакте
    const w3 = env.store.userWrite('plan', '# План\n- [ ] шаг\n', item(env, 'plan').hash, 'ui');
    assert.ok(w3.ok);
    assert.deepEqual(env.store.list().find((a) => a.key === 'plan')!.tasks, { open: 1, done: 0 });
  } finally {
    done(env);
  }
});
