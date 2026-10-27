import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { canon, flowChanges, flowEditProblems, flowsSync, keepBlockName, patchFlowYaml, sameFlow, withFlowInput, type FixPoint, type FlowsFile } from './run-fix.js';
import { blockMaxIterations } from './runner.js';
import type { FlowSpec } from './schema.js';

const phase = (name: string, extra: Record<string, unknown> = {}) => ({ name, tools: [], prompt: `делай ${name}`, ...extra });

const flow = (over: Record<string, unknown> = {}) =>
  ({
    name: 'f',
    input: 'задача',
    artifacts: { plan: { initial: 'x' } },
    blocks: [
      { name: 'plan', phases: [phase('analyze')] },
      { name: 'impl', loop: { max_iterations: 5, until: { type: 'marker', marker: '<DONE>' } }, phases: [phase('code'), phase('review')] },
      { name: 'ship', phases: [phase('deploy')] },
    ],
    ...over,
  }) as unknown as FlowSpec;

/** Запуск стоит в блоке impl на итерации 2. */
const at: FixPoint = { block: 1, iterations: 2, limit: (b) => blockMaxIterations(b, {}) };
const withBlocks = (f: (blocks: FlowSpec['blocks'] & object) => void): FlowSpec => {
  const next = structuredClone(flow());
  f(next.blocks!);
  return next;
};

test('совместимость: правка идущего и будущих блоков, defaults — без проблем', () => {
  const next = withBlocks((b) => {
    b[1].phases[1].prompt = 'ревью строже';
    b[1].phases.push(phase('lint') as never);
    b[2].phases[0].model = 'haiku';
    b.push({ name: 'docs', phases: [phase('readme')] } as never);
  });
  next.defaults = { model: 'sonnet' };
  assert.deepEqual(flowEditProblems(flow(), next, at), []);
});

test('совместимость: другое имя, задача, артефакты — проблемы с понятным текстом', () => {
  const problems = flowEditProblems(flow(), flow({ name: 'g', input: 'другая', artifacts: {} }), at);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^name:/);
  assert.match(problems[1], /^input:.*дай указание/);
  assert.match(problems[2], /^artifacts:/);
});

test('совместимость: пройденный блок менять, убирать и переставлять нельзя', () => {
  const changed = withBlocks((b) => { b[0].phases[0].prompt = 'иначе'; });
  assert.deepEqual(flowEditProblems(flow(), changed, at), ['блок plan уже пройден: менять его нельзя']);
  const removed = withBlocks((b) => { b.shift(); });
  assert.ok(flowEditProblems(flow(), removed, at).includes('блок plan уже пройден: убрать или переставить его нельзя'));
});

test('совместимость: идущий блок остаётся на своём месте', () => {
  const moved = withBlocks((b) => { b.splice(1, 0, { name: 'extra', phases: [phase('x')] } as never); });
  assert.ok(flowEditProblems(flow(), moved, at).includes('блок impl идёт сейчас: он должен остаться 2-м'));
});

test('совместимость: один блок и несколько не меняются местами — логи лежат иначе', () => {
  const one = { name: 'f', input: 'задача', artifacts: { plan: { initial: 'x' } }, phases: [phase('a')] } as unknown as FlowSpec;
  const two = { ...one, phases: undefined, blocks: [{ name: 'main', phases: [phase('a')] }, { name: 'more', phases: [phase('b')] }] } as unknown as FlowSpec;
  assert.match(flowEditProblems(one, two, { ...at, block: 0, iterations: 1 })[0], /^blocks: у запуска один блок/);
  assert.match(flowEditProblems(two, one, { ...at, block: 0, iterations: 1 })[0], /^blocks: у запуска 2 блока/);
});

test('совместимость: лимит идущего блока во flow ниже начатой итерации — нельзя, выше или прежний — можно', () => {
  const lower = withBlocks((b) => { b[1].loop!.max_iterations = 1; });
  assert.deepEqual(flowEditProblems(flow(), lower, at), ['блок impl уже на итерации 2: лимит 1 меньше']);
  const higher = withBlocks((b) => { b[1].loop!.max_iterations = 9; });
  assert.deepEqual(flowEditProblems(flow(), higher, at), []);
  // без цикла у блока одна итерация, а он уже на второй
  const noLoop = withBlocks((b) => { delete b[1].loop; });
  assert.deepEqual(flowEditProblems(flow(), noLoop, at), ['блок impl уже на итерации 2: лимит 1 меньше']);
});

test('совместимость: одинаковые flow из YAML с другим порядком ключей — без проблем и без изменений', () => {
  const a = parseYaml('name: f\ninput: задача\nphases:\n  - {name: a, tools: [], prompt: p, model: m}\n') as FlowSpec;
  const b = parseYaml('input: задача\nname: f\nphases:\n  - {prompt: p, model: m, tools: [], name: a}\n') as FlowSpec;
  assert.equal(canon(a), canon(b));
  assert.deepEqual(flowEditProblems(a, b, { ...at, block: 0, iterations: 1 }), []);
  assert.deepEqual(flowChanges(a, b), []);
});

test('изменения: поля этапа, добавленные и убранные этапы и блоки, defaults, порядок', () => {
  const next = withBlocks((b) => {
    b[1].phases = [phase('review', { prompt: 'иначе', model: 'haiku' }), phase('code'), phase('lint')] as never;
    b[2] = { name: 'docs', phases: [phase('readme')] } as never;
    b[1].loop!.max_iterations = 7;
  });
  next.defaults = { effort: 'low' };
  assert.deepEqual(flowChanges(flow(), next), [
    'defaults',
    '− блок ship',
    '+ блок docs',
    'блок impl: loop',
    'блок impl: порядок этапов',
    '− этап deploy',
    'этап review: model, prompt',
    '+ этап lint',
    '+ этап readme',
  ]);
});

test('keepBlockName: короткая форма правки получает имя единственного блока запуска', () => {
  const run = { name: 'f', blocks: [{ name: 'impl', loop: { max_iterations: 3, until: { type: 'none' } }, phases: [phase('a')] }] } as unknown as FlowSpec;
  const short = { name: 'f', loop: { max_iterations: 3, until: { type: 'none' } }, phases: [phase('a', { prompt: 'новый' })] } as unknown as FlowSpec;
  const kept = keepBlockName(run, short);
  assert.equal(kept.blocks?.[0].name, 'impl');
  assert.equal(kept.blocks?.[0].phases[0].prompt, 'новый');
  assert.equal('phases' in kept || 'loop' in kept, false);
  assert.deepEqual(flowChanges(run, kept), ['этап a: prompt']);
  // блок main или полная форма — как есть
  const main = { name: 'f', phases: [phase('a')] } as unknown as FlowSpec;
  assert.equal(keepBlockName(main, short), short);
});

test('withFlowInput: в flows/ уходит input сохранённого flow, комментарии остаются', () => {
  const text = '# мой flow\nname: f\ninput: задача запуска\nphases:\n  - name: a # этап\n    tools: []\n    prompt: p\n';
  const back = withFlowInput(text, 'по умолчанию');
  assert.match(back, /^# мой flow/);
  assert.match(back, /# этап/);
  assert.equal((parseYaml(back) as FlowSpec).input, 'по умолчанию');
  assert.equal('input' in (parseYaml(withFlowInput(text, undefined)) as object), false);
});

// --- галочка «сохранить и в flow»: правка поверх flows/<имя>.yaml

const flowsFile = [
  '# flow для тестов: комментарий владельца',
  'name: f',
  'input: задача по умолчанию',
  'phases:',
  '  # первым — план',
  '  - name: a',
  '    tools: [Read]',
  '    prompt: |',
  '      план',
  '      по шагам',
  '  - name: b # проверка',
  '    tools: []',
  '    prompt: проверь',
  '',
].join('\n');
// снимок запуска: без комментариев, input — задача запуска; правка поменяла промпт a и добавила этап c
const runEdit = [
  'name: f',
  'input: задача запуска',
  'phases:',
  '  - name: a',
  '    tools: [Read]',
  '    prompt: |',
  '      план',
  '      по шагам, с тестами',
  '  - name: b',
  '    tools: []',
  '    prompt: проверь',
  '  - name: c',
  '    tools: []',
  '    prompt: отчёт',
  '',
].join('\n');

test('sameFlow: задача не в счёт, остальное — да', () => {
  const a = parseYaml(flowsFile) as FlowSpec;
  assert.equal(sameFlow(a, { ...a, input: 'другая' }), true);
  assert.equal(sameFlow(a, { ...a, phases: a.phases!.slice(0, 1) }), false);
});

test('patchFlowYaml: правка ложится поверх файла — комментарии и стиль строк остаются, по смыслу ровно правка', () => {
  const out = patchFlowYaml(flowsFile, runEdit);
  assert.deepEqual(parseYaml(out), parseYaml(runEdit));
  assert.match(out, /^# flow для тестов: комментарий владельца/);
  assert.match(out, /# первым — план\n  - name: a/);
  assert.match(out, /- name: b # проверка/);
  assert.match(out, /prompt: \|\n {6}план\n {6}по шагам, с тестами/);
  assert.match(out, /tools: \[Read\]/);
  // этапы сопоставляются по имени: перестановка уносит комментарий этапа с ним (комментарий над списком — над списком)
  const swapped = runEdit.replace(/  - name: a[\s\S]*?(?=  - name: b)/, '').replace('  - name: c', '  - name: a\n    tools: [Read]\n    prompt: план\n  - name: c');
  const moved = patchFlowYaml(flowsFile, swapped);
  assert.deepEqual(parseYaml(moved), parseYaml(swapped));
  assert.match(moved, /phases:\n  # первым — план\n  - name: b # проверка\n[\s\S]*- name: a\n/);
  // файл не читается — текст правки как есть
  assert.equal(patchFlowYaml('name: [', runEdit), runEdit);
});

test('patchFlowYaml: в списке без name комментарий не переезжает к чужому значению', () => {
  const text = 'name: f\nphases:\n  - name: a\n    tools:\n      - Read # только чтение\n      - Bash # опасно: только тесты\n    prompt: p\n';
  const out = patchFlowYaml(text, 'name: f\nphases:\n  - name: a\n    tools: [Bash]\n    prompt: p\n');
  assert.match(out, /- Bash # опасно: только тесты/);
  assert.doesNotMatch(out, /только чтение/);
});

// файл flows/ в памяти: что записано и сколько раз
const memFile = (text: string | null) => {
  const f = { text, writes: 0, fail: false };
  const file: FlowsFile = {
    read: () => f.text,
    write: (t) => {
      if (f.fail) throw new Error('EACCES');
      f.text = t;
      f.writes++;
    },
    parse: (t) => parseYaml(t) as FlowSpec,
  };
  return { f, file };
};
const startSpec = { ...(parseYaml(flowsFile) as FlowSpec), input: 'задача запуска' };

test('flowsSync: файл тот, с которым шёл запуск, — правка поверх него с его input и комментариями; вторая запись тоже идёт', () => {
  const { f, file } = memFile(flowsFile);
  const sync = flowsSync('f', file, startSpec);
  assert.ok('undo' in sync.save(runEdit));
  assert.equal((parseYaml(f.text!) as FlowSpec).input, 'задача по умолчанию');
  assert.equal((parseYaml(f.text!) as FlowSpec).phases!.length, 3);
  assert.match(f.text!, /# проверка/);
  // сверка теперь с записанным: следующая правка того же запуска тоже ложится в файл
  assert.ok('undo' in sync.save(runEdit.replace('prompt: отчёт', 'prompt: отчёт кратко')));
  assert.match(f.text!, /prompt: отчёт кратко/);
  assert.equal(f.writes, 2);
});

test('flowsSync: файл переписали без смены смысла (конструктор, CRLF, комментарий) — запись идёт, чужой комментарий остаётся', () => {
  const { f, file } = memFile(flowsFile);
  const sync = flowsSync('f', file, startSpec);
  f.text = `# добавлено в конструкторе\n${flowsFile}`.replace(/\n/g, '\r\n');
  assert.ok('undo' in sync.save(runEdit));
  assert.match(f.text, /# добавлено в конструкторе/);
  assert.equal((parseYaml(f.text) as FlowSpec).phases!.length, 3);
});

test('flowsSync: файл поменяли по смыслу после старта или запуск шёл не по нему — отказ, файл не тронут', () => {
  const { f, file } = memFile(flowsFile);
  const sync = flowsSync('f', file, startSpec);
  f.text = flowsFile + '  - name: z\n    tools: []\n    prompt: z\n';
  const changed = sync.save(runEdit);
  assert.ok('error' in changed);
  assert.match(changed.error, /flows\/f\.yaml поменяли после старта запуска — правка только в запуске/);
  f.text = null;
  assert.ok('error' in sync.save(runEdit));
  assert.equal(f.writes, 0);
  // продолжение по снимку: flow запуска с файлом не совпадал уже на старте
  const other = memFile(flowsFile);
  const diverged = flowsSync('f', other.file, { ...startSpec, phases: startSpec.phases!.slice(0, 1) }).save(runEdit);
  assert.ok('error' in diverged);
  assert.match(diverged.error, /уже на старте отличался от flows\/f\.yaml/);
  assert.equal(other.f.writes, 0);
});

test('flowsSync: после «взять из flows/» сверка — с файлом; undo возвращает файл и сверку; сбой записи — причина, а не исключение', () => {
  const { f, file } = memFile(flowsFile);
  const sync = flowsSync('f', file, { ...startSpec, phases: startSpec.phases!.slice(0, 1) });
  sync.took(parseYaml(flowsFile) as FlowSpec);
  const saved = sync.save(runEdit);
  assert.ok('undo' in saved);
  saved.undo();
  assert.equal(f.text, flowsFile);
  // сверка вернулась к прежнему файлу: запись снова проходит
  assert.ok('undo' in sync.save(runEdit));
  f.fail = true;
  const failed = sync.save(runEdit);
  assert.ok('error' in failed);
  assert.match(failed.error, /flows\/f\.yaml не записан: EACCES/);
});
