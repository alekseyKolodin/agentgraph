// Flow шаблона репо команды (templates/teamwork/flows/, spec §5.1 и §9.1): каждый разбирается и проходит ту же проверку,
// что сохранение flow из UI (схема, ссылки на артефакты и этапы, writes, вызовы), вход — анкета с плейсхолдерами,
// один этап, ровно нужные артефакты и инструменты.
// flows/ — временная папка: saveFlowYaml пишет туда; AGENTGRAPH_HOME задаётся до импорта (paths.ts читает его при загрузке).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-teamwork-flows-'));
process.env.AGENTGRAPH_HOME = home;
const { APP_DIR } = await import('./paths.js');
const { deleteFlow, parseFlow, saveFlowYaml } = await import('./flows.js');
const { composeInput, hasPlaceholders } = await import('./intake.js');
const { flowPhases } = await import('./schema.js');
const { REQUIREMENT_RE } = await import('./teamwork.js');

after(() => fs.rmSync(home, { recursive: true, force: true }));

const dir = path.join(APP_DIR, 'templates', 'teamwork', 'flows');
const read = (name: string) => fs.readFileSync(path.join(dir, `${name}.yaml`), 'utf8');
const load = (name: string) => parseFlow(read(name));

// артефакты (ключ → файл) и инструменты — таблица spec §9.1
const EXPECTED: Record<string, { artifacts: Record<string, string>; tools: string[] }> = {
  'teamwork-prd': { artifacts: { prd: 'prd.md', notes: 'notes.json' }, tools: ['Read', 'Grep', 'Glob', 'AskUserQuestion'] },
  'teamwork-architecture': {
    artifacts: { architecture: 'architecture.md', design: 'design.md', notes: 'notes.json' },
    tools: ['Read', 'Grep', 'Glob', 'AskUserQuestion'],
  },
  'teamwork-split': { artifacts: { tasks: 'tasks.json' }, tools: ['Read', 'Grep', 'Glob'] },
  'teamwork-task': { artifacts: {}, tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] },
};

/** Строки анкеты входа: «Поле: <…>». */
const inputFields = (input: string | undefined) => (input ?? '').split('\n').map((l) => l.match(/^([^:<>]+):\s*<[^<>]+>\s*$/)?.[1]).filter((f): f is string => Boolean(f));

test('в шаблоне ровно четыре flow из spec §5.1, и ничего лишнего', () => {
  // только файлы flow: .DS_Store от Finder — не лишний flow
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort(), Object.keys(EXPECTED).map((n) => `${n}.yaml`).sort());
});

for (const [name, want] of Object.entries(EXPECTED)) {
  test(`${name}: проходит проверку сохранения, один этап, анкета входа, ровно свои артефакты и инструменты`, () => {
    const yaml = read(name);
    const spec = parseFlow(yaml);
    assert.equal(spec.name, name, 'имя flow — имя файла');
    // та же проверка, что при сохранении из UI, вместе с вызовами других flow
    const saved = saveFlowYaml(name, yaml, 'teamwork');
    assert.equal(saved.spec.name, name);
    deleteFlow(name);

    assert.ok(hasPlaceholders(spec.input), 'input — анкета с плейсхолдерами <...>, её заполняет сервер');
    const phases = flowPhases(spec);
    assert.equal(phases.length, 1, 'один этап: граница только по контексту');
    const [phase] = phases;
    assert.deepEqual(Object.keys(spec.artifacts ?? {}).sort(), Object.keys(want.artifacts).sort());
    for (const [key, file] of Object.entries(want.artifacts)) assert.equal(spec.artifacts?.[key].file, file, `артефакт ${key}`);
    assert.deepEqual([...(phase.writes ?? [])].sort(), Object.keys(want.artifacts).sort(), 'этап пишет ровно свои артефакты');
    assert.deepEqual([...phase.tools].sort(), [...want.tools].sort());
    assert.ok(spec.defaults?.model && spec.defaults.max_budget_usd, 'модель и бюджет — в defaults, команда их правит');
    assert.match(phase.prompt, /\{\{input\}\}/);
    assert.match(phase.prompt, /source-data/, 'текст команды во входе — данные, промпт напоминает об этом');
    assert.ok(phase.handoff, 'этап заканчивается явным handoff');
  });
}

test('teamwork-prd: раздел, следующий номер и папка проекта во входе, ТЗ подставляется, причины — в notes', () => {
  const spec = load('teamwork-prd');
  assert.deepEqual(inputFields(spec.input), ['Проект', 'Суть проекта', 'Что сделать', 'Раздел', 'Новые номера', 'Папка проекта']);
  assert.equal(spec.loop?.until.type, 'none');
  assert.deepEqual(JSON.parse(spec.artifacts!.notes.initial!), []);
  const p = flowPhases(spec)[0].prompt;
  assert.match(p, /\{\{artifacts\.prd\}\}/, 'текущее ТЗ целиком: этап обновляет его, а не пишет с нуля');
  assert.match(p, /\{\{artifacts\.notes\.path\}\}/);
  assert.match(p, /«Новые номера»/, 'новый номер — из входа, его считает сервер');
  assert.match(p, /только раздел/i);
  assert.match(p, /"at"/);
  // формат строки требования — тот, что разбирает сервер: примеры из промпта проходят REQUIREMENT_RE, двоеточия нет
  const examples = [...p.matchAll(/`(- N?FR-\d+[^`]*)`/g)].map((m) => m[1]);
  assert.equal(examples.length, 2, 'в промпте пример для FR и для NFR');
  for (const line of examples) assert.match(line, REQUIREMENT_RE, line);
  assert.doesNotMatch(p, /N?FR-\d+:/, 'требование с двоеточием сервер не увидит');
  assert.doesNotMatch(p, /сохраняй его оформление/, 'формат обязателен: ТЗ пишут только этот flow и правка в UI');
});

test('teamwork-architecture: что писать и раздел во входе, оба документа подставляются, ссылки на FR-N', () => {
  const spec = load('teamwork-architecture');
  assert.deepEqual(inputFields(spec.input), ['Проект', 'Суть проекта', 'Что сделать', 'Что писать', 'Раздел', 'Папка проекта']);
  assert.match(spec.input!, /архитектура \| дизайн \| оба/);
  assert.deepEqual(JSON.parse(spec.artifacts!.notes.initial!), []);
  const p = flowPhases(spec)[0].prompt;
  assert.match(p, /"doc"/, 'в notes сказано, к какому из двух документов правка');
  for (const ref of ['{{artifacts.architecture}}', '{{artifacts.design}}', '{{artifacts.architecture.path}}', '{{artifacts.design.path}}', '{{artifacts.notes.path}}']) {
    assert.ok(p.includes(ref), ref);
  }
  assert.match(p, /prd\.md/, 'ТЗ открывает сам из папки проекта');
  assert.match(p, /FR-\d/);
});

test('teamwork-split: репо и существующие задачи во входе, tasks.json по схеме, зависимости явные и без циклов', () => {
  const spec = load('teamwork-split');
  assert.deepEqual(inputFields(spec.input), ['Проект', 'Суть проекта', 'Что сделать', 'Репо кода', 'Папка проекта', 'Существующие задачи']);
  assert.deepEqual(JSON.parse(spec.artifacts!.tasks.initial!), { tasks: [] });
  const p = flowPhases(spec)[0].prompt;
  for (const field of ['"key"', '"title"', '"type"', '"description"', '"acceptance"', '"estimate"', '"repo"', '"dependsOn"', '"covers"']) assert.ok(p.includes(field), field);
  assert.match(p, /dependsOn/);
  assert.match(p, /цикл/i);
  assert.match(p, /не предлагай этого снова/, 'существующие задачи не дублируются');
  assert.doesNotMatch(p, /AskUserQuestion/, 'разбивка без вопросов: нет такого инструмента');
});

test('teamwork-task: анкета заполняется composeInput, судья по критериям до трёх итераций, без push и PR', () => {
  const spec = load('teamwork-task');
  assert.deepEqual(inputFields(spec.input), ['Задача', 'Ветка']);
  assert.equal(composeInput(spec.input, { ticket: 'PAY-12', branch: 'tw/PAY-12-csv' }, 'текст задачи'), 'Задача: PAY-12\nВетка: tw/PAY-12-csv\n\nтекст задачи');
  assert.equal(spec.artifacts, undefined);
  assert.equal(spec.loop?.max_iterations, 3);
  assert.equal(spec.loop?.until.type, 'judge');
  const judge = spec.loop!.until as { type: 'judge'; prompt: string };
  assert.match(judge.prompt, /\{\{input\}\}/);
  assert.match(judge.prompt, /\{\{outputs\}\}/);
  assert.match(judge.prompt, /Критерии приёмки/);
  assert.match(judge.prompt, /тест/i);
  assert.equal(spec.loop?.pause_marker, '<NEEDS_USER>', 'невыполнимый критерий — пауза, а не три итерации по кругу');
  const p = flowPhases(spec)[0].prompt;
  assert.match(p, /<NEEDS_USER>/);
  assert.match(p, /\{\{feedback\}\}/, 'замечания судьи — в следующую итерацию');
  assert.match(p, /git push не делай/);
  assert.match(p, /PR и MR не открывай/);
  assert.match(p, /prd\.md/, 'документы проекта открывает сам по путям из входа');
});
