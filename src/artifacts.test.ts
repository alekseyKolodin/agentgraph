import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  artifactAccess,
  artifactEditability,
  artifactGuardDecision,
  artifactProblems,
  artifactSection,
  artifactTasks,
  canonical,
  countTasks,
  declaredArtifacts,
  describeAuthor,
  EDIT_MAX,
  fmtWhen,
  INLINE_MAX,
  MAP_MAX,
  PART_LINES,
  artifactMap,
  artifactMapParts,
  sliceLines,
  splitLines,
  substitution,
  type ArtifactAccess,
  type EditState,
  type GuardScope,
} from './artifacts.js';
import { countDenial, nodeProbe } from './artifact-store.js';
import { sessionOptions } from './agent.js';
import { validateSpec } from './flows.js';
import { GENERATOR_SYSTEM } from './generate.js';
import { EDITOR_SYSTEM } from './edit.js';
import { flowJsonSchema, FlowSchema, GeneratedFlowSchema, type FlowSpec, type Phase } from './schema.js';
import { referencedArtifacts, render, emptyContext } from './template.js';

const flow = (yaml: string): FlowSpec => FlowSchema.parse(parseYaml(yaml));
const problems = (yaml: string) => artifactProblems(flow(yaml));

// ---------- A. объявление и валидация

const BASE = `
name: f
artifacts:
  plan: {title: План}
  progress: {file: progress.txt}
`;

test('A1: артефакт и этап с writes — ошибок нет, validateSpec пропускает', () => {
  const yaml = `${BASE}
phases:
  - name: analyze
    tools: []
    writes: [plan]
    prompt: 'План в {{artifacts.plan.path}}'
`;
  assert.deepEqual(problems(yaml), []);
  assert.doesNotThrow(() => validateSpec(parseYaml(yaml)));
});

test('A2: неизвестный артефакт в reads, writes, промпте, handoff и рубрике — ошибка называет место и ключ', () => {
  const p = problems(`${BASE}
blocks:
  - name: one
    phases:
      - {name: a, tools: [], reads: [nope], prompt: x}
      - {name: b, tools: [], writes: [nope2], prompt: x}
      - {name: c, tools: [], prompt: '{{artifacts.nope3}}', handoff: '{{artifacts.nope4.path}}'}
  - name: two
    loop: {max_iterations: 2, until: {type: judge, prompt: 'Оцени {{artifacts.nope5}}'}}
    phases:
      - {name: d, tools: [], prompt: x}
`);
  assert.deepEqual(p, [
    'этап a: reads — неизвестный артефакт nope',
    'этап b: writes — неизвестный артефакт nope2',
    'этап c: {{artifacts.nope3}} — неизвестный артефакт nope3',
    'этап c (handoff): {{artifacts.nope4.path}} — неизвестный артефакт nope4',
    'блок two, судья: {{artifacts.nope5}} — неизвестный артефакт nope5',
  ]);
});

test('A2: подстановка артефакта во flow без artifacts — ошибка, validateSpec её бросает', () => {
  const yaml = 'name: f\nphases:\n  - {name: a, tools: [], prompt: "{{artifacts.plan}}"}\n';
  assert.throws(() => validateSpec(parseYaml(yaml)), /этап a: \{\{artifacts\.plan\}\} — неизвестный артефакт plan/);
});

test('A3: имена файлов — каталоги, .., расширение, зарезервированные имена, дубли без учёта регистра', () => {
  const p = problems(`
name: f
artifacts:
  a: {file: sub/a.md}
  b: {file: ../b.md}
  c: {file: c.sh}
  d: {file: claude.md}
  e: {file: CLAUDE.local.MD}
  f: {file: Plan.md}
  g: {file: plan.MD}
  h: {file: .hidden.md}
  "bad key": {}
  "к": {file: k.md}
phases:
  - {name: x, tools: [], prompt: x}
`);
  const has = (re: RegExp) => assert.ok(p.some((x) => re.test(x)), `нет ${re} в\n${p.join('\n')}`);
  has(/артефакт a: file sub\/a\.md: только имя файла, без каталогов/);
  has(/артефакт b: file \.\.\/b\.md: только имя файла/);
  has(/артефакт c: file c\.sh: расширение md, txt, json, yaml, yml/);
  has(/артефакт d: file claude\.md: имя зарезервировано/);
  has(/артефакт e: file CLAUDE\.local\.MD: имя зарезервировано/);
  has(/артефакты f и g: один и тот же файл plan\.MD/);
  has(/артефакт h: file \.hidden\.md: имя не может начинаться с точки/);
  has(/артефакт bad key: ключ — латиница/);
  has(/артефакт к: ключ — латиница/);
});

test('A4: два артефакта с decisions — ошибка', () => {
  const p = problems('name: f\nartifacts:\n  a: {decisions: true}\n  b: {decisions: true}\n  c: {decisions: false}\nphases:\n  - {name: x, tools: [], prompt: x}\n');
  assert.deepEqual(p, ['decisions: true у нескольких артефактов (a, b): ответы на паузу пишутся в один']);
});

const groupFlow = (a: string, b: string) => `${BASE}
phases:
  - {name: a, group: g, tools: [], ${a}}
  - {name: b, group: g, tools: [], ${b}}
`;

test('A5: в группе два участника пишут один артефакт — ошибка', () => {
  assert.deepEqual(problems(groupFlow('writes: [plan], prompt: x', 'writes: [plan], prompt: y')), [
    'группа g: артефакт plan пишут несколько этапов (a, b) — они идут одновременно',
  ]);
});

test('A6: участник группы читает через reads или подстановку то, что пишет сосед, — ошибка', () => {
  assert.deepEqual(problems(groupFlow('reads: [plan], prompt: x', 'writes: [plan], prompt: y')), [
    'этап a: читает артефакт plan, который пишет этап b из той же группы g — они идут одновременно',
  ]);
  assert.deepEqual(problems(groupFlow('prompt: "{{artifacts.plan.path}}"', 'writes: [plan], prompt: y')), [
    'этап a: читает артефакт plan, который пишет этап b из той же группы g — они идут одновременно',
  ]);
});

test('A7: группа из двух этапов без Edit и Write, каждый пишет свой артефакт, — ошибок нет', () => {
  const yaml = groupFlow('writes: [plan], prompt: x', 'writes: [progress], prompt: y');
  assert.deepEqual(problems(yaml), []);
  assert.doesNotThrow(() => validateSpec(parseYaml(yaml)));
});

test('объявленный, но никем не используемый артефакт — не ошибка; file по умолчанию — <ключ>.md, title — ключ', () => {
  assert.deepEqual(problems(`${BASE}phases:\n  - {name: a, tools: [], prompt: x}\n`), []);
  assert.deepEqual(declaredArtifacts(flow(BASE + 'phases:\n  - {name: a, tools: [], prompt: x}\n')), [
    { key: 'plan', title: 'План', file: 'plan.md', decisions: false },
    { key: 'progress', title: 'progress', file: 'progress.txt', decisions: false },
  ]);
});

test('H1: схема генератора принимает artifacts, reads, writes, и результат проходит валидацию', () => {
  const raw = {
    name: 'g',
    artifacts: { plan: { title: 'План', initial: '# План\n' }, decisions: { decisions: true } },
    blocks: [{ name: 'main', phases: [{ name: 'a', tools: [], reads: ['decisions'], writes: ['plan'], prompt: '{{artifacts.plan}}' }] }],
  };
  const parsed = GeneratedFlowSchema.parse(raw);
  assert.deepEqual(parsed.artifacts, raw.artifacts);
  assert.deepEqual(parsed.blocks[0].phases[0].writes, ['plan']);
  assert.doesNotThrow(() => validateSpec(parsed));
  const js = JSON.stringify(flowJsonSchema());
  assert.ok(js.includes('"artifacts"') && js.includes('"reads"') && js.includes('"writes"'));
});

test('H2: тексты генератора и «Правки с ИИ» описывают артефакты, правило «ссылайся на артефакт» и поправку правила 6', () => {
  const anchors: [string, RegExp][] = [
    ['поле artifacts', /top-level "artifacts"/],
    ['поле reads', /reads: \[KEY\]/],
    ['поле writes', /writes: \[KEY\]/],
    ['подстановка содержимого', /\{\{artifacts\.KEY\}\} — the content of artifact KEY/],
    ['подстановка пути', /\{\{artifacts\.KEY\.path\}\} — its absolute path/],
    ['ссылайся на артефакт, а не на пересказ этапа', /Refer to the artifact, not to a phase's retelling of it/],
    ['когда артефакт полезнее {{prev}}', /Declare an artifact when state must outlive one hand-off[^\n]*a plan[^\n]*a checklist[^\n]*decisions/],
    ['по умолчанию без артефактов', /By default a flow has none/],
    ['этап проверки: writes вместо Edit', /verification: [^\n]*writes: \[KEY\] of that artifact instead of "Edit"/],
    ['судья проверяет по файлам проекта и командам', /checked against the project's files and the results of commands, not against what an artifact/],
    ['группа: один писатель артефакта', /at most one member writes a given artifact/],
    ['правило 6: max_turns 1-3 только без tools и без артефактов', /Set max_turns \(1-3\) only for phases with no tools and no writes or reads of artifacts/],
    ['артефакты — второй канал между этапами', /Run artifacts are named text files of the run/],
  ];
  for (const [name, text] of [['генератор', GENERATOR_SYSTEM], ['Правка с ИИ', EDITOR_SYSTEM]] as const) {
    for (const [what, re] of anchors) assert.match(text, re, `${name}: нет «${what}»`);
    assert.doesNotMatch(text, /only for tool-less phases/, `${name}: старая формулировка правила 6`);
    assert.doesNotMatch(text, /only through template variables/, `${name}: «только текст между этапами» больше неправда`);
  }
  // у генератора своё правило после DESIGN_RULES: номера не повторяются
  assert.equal(GENERATOR_SYSTEM.match(/^9\. /gm)?.length, 1);
  assert.match(GENERATOR_SYSTEM, /^10\. "input" must contain/m);
});

// ---------- права этапа

const ph = (over: Partial<Phase>): Phase => ({ name: 'p', prompt: '', tools: [], ...over });

test('права: read = reads ∪ writes ∪ подстановки, write = writes, неявные — только недостающие Read/Edit/Write', () => {
  assert.deepEqual(artifactAccess(ph({ reads: ['a'], writes: ['b'], prompt: '{{artifacts.c}} {{artifacts.d.path}}', handoff: '{{artifacts.e}}' })), {
    read: ['a', 'b', 'c', 'd', 'e'],
    write: ['b'],
    implicit: ['Read', 'Edit', 'Write'],
  });
  assert.deepEqual(artifactAccess(ph({ reads: ['a'], tools: ['Read'] })), { read: ['a'], write: [], implicit: [] });
  assert.deepEqual(artifactAccess(ph({ writes: ['a'], tools: ['Read', 'Edit'] })).implicit, ['Write']);
  assert.deepEqual(artifactAccess(ph({ tools: ['Bash'] })), { read: [], write: [], implicit: [] });
});

// ---------- шаблон и подстановка

test('шаблон: {{artifacts.KEY}} и .path из контекста; без артефактов в контексте и с неизвестным ключом — как есть', () => {
  const ctx = { ...emptyContext('', 1), artifacts: { plan: { text: 'ТЕКСТ', path: '/r/plan.md' } } };
  assert.equal(render('a={{artifacts.plan}} p={{ artifacts.plan.path }} n={{artifacts.nope}} x={{artifacts.plan.x}}', ctx), 'a=ТЕКСТ p=/r/plan.md n={{artifacts.nope}} x={{artifacts.plan.x}}');
  assert.equal(render('{{artifacts.plan}}', emptyContext('', 1)), '{{artifacts.plan}}');
  assert.equal(render('{{artifacts.constructor}}', ctx), '{{artifacts.constructor}}');
  assert.deepEqual(referencedArtifacts('{{artifacts.a}} {{artifacts.b.path}} {{artifacts.a}} {{phases.x}}'), { content: ['a'], path: ['b'] });
});

test('B4, B8: подстановка до 32 КБ — текст целиком, пустой файл — пустая строка', () => {
  const small = 'строка\n'.repeat(1700);
  assert.ok(Buffer.byteLength(small) > 20 * 1024 && Buffer.byteLength(small) < INLINE_MAX);
  assert.deepEqual(substitution(small, { title: 'План', path: '/r/plan.md', file: 'plan.md' }), { text: small, mapped: false });
  assert.deepEqual(substitution('', { title: 'План', path: '/r/plan.md', file: 'plan.md' }), { text: '', mapped: false });
});

/** markdown с преамбулой, вложенными и повторяющимися заголовками, заголовком в ограде кода, кириллицей, чек-листом. */
function bigMarkdown(): string {
  const parts = ['Вступление до первого заголовка.\n', '\n'];
  for (let i = 1; i <= 12; i++) {
    parts.push(`# Глава ${i}\n`, `Глава ${i} о миграции данных.\n`);
    parts.push('```bash\n# не заголовок: комментарий в коде\nnpm test\n```\n');
    parts.push('## Детали\n', 'Подробности главы.\n', '- [x] сделано\n- [ ] не сделано\n- обычный пункт\n');
    parts.push('## Детали\n', 'Второй раздел с тем же названием.\n', 'ж'.repeat(3000) + '\n');
  }
  return parts.join('');
}

/** Свойство B14: разделы подряд с первой строки до последней, каждый диапазон — ровно текст раздела, вместе — весь файл. */
function assertCovers(content: string, sections: { from: number; to: number; bytes: number }[]): void {
  const lines = splitLines(content).length;
  let next = 1;
  let joined = '';
  for (const s of sections) {
    assert.equal(s.from, next, `разрыв или пересечение на строке ${next}`);
    assert.ok(s.to >= s.from);
    const text = sliceLines(content, s.from, s.to);
    assert.equal(Buffer.byteLength(text), s.bytes);
    joined += text;
    next = s.to + 1;
  }
  assert.equal(next - 1, lines);
  assert.equal(joined, content);
}

test('B5, B14: карта markdown — разделы по заголовкам вне оград кода, пути через ›, дубли, начало; покрывает весь файл; до 8 КБ', () => {
  const md = bigMarkdown();
  assert.ok(Buffer.byteLength(md) > 50 * 1024);
  const m = artifactMap(md, { title: 'План', path: '/r/plan.md', file: 'plan.md' });
  assertCovers(md, m.sections);
  const keys = m.sections.map((x) => x.key);
  assert.equal(keys[0], '(начало)');
  assert.ok(keys.includes('Глава 1 › Детали'));
  assert.ok(keys.includes('Глава 1 › Детали (2)'));
  assert.ok(!keys.some((k) => k.includes('не заголовок')), 'заголовок в ограде кода не режет файл');
  const ch1 = m.sections.find((x) => x.key === 'Глава 1')!;
  assert.equal(ch1.about, 'Глава 1 о миграции данных.');
  assert.equal(m.sections.find((x) => x.key === 'Глава 1 › Детали')!.about, 'Подробности главы. (пунктов: 3, отмечено 1 из 2)');
  assert.ok(Buffer.byteLength(m.text) <= MAP_MAX, String(Buffer.byteLength(m.text)));
  assert.match(m.text, /^Карта артефакта «План» — \d+ КБ, строк: \d+, файл \/r\/plan\.md\n.*Read с offset = первой строке диапазона и limit = числу строк\./);
  assert.match(m.text, /\n- Глава 1 — строки \d+–\d+ \(\d+\), \d+ (Б|КБ): Глава 1 о миграции данных\./);
  assert.ok(!m.text.includes('Подробности главы.\n- [x]'), 'начала файла под видом содержимого нет');
  const sub = substitution(md, { title: 'План', path: '/r/plan.md', file: 'plan.md' });
  assert.equal(sub.mapped, true);
  assert.equal(sub.text, m.text);
  assert.match(artifactMap(md, { title: 'План', path: '/r/plan.md', file: 'plan.md', tool: true }).text, /инструментом artifact_read по ключу раздела/);
});

test('B15: файл 100 КБ без заголовков — части не длиннее 200 строк покрывают весь файл; большой раздел — части', () => {
  const txt = Array.from({ length: 2000 }, (_, i) => `строка ${i + 1} ${'x'.repeat(40)}`).join('\n');
  assert.ok(Buffer.byteLength(txt) > 90 * 1024);
  const m = artifactMap(txt, { title: 'Лог', path: '/r/log.txt', file: 'log.txt' });
  assertCovers(txt, m.sections);
  assert.ok(m.sections.every((x) => x.to - x.from + 1 <= PART_LINES));
  assert.deepEqual(m.sections.slice(0, 2).map((x) => [x.key, x.from, x.to]), [['часть 1', 1, 200], ['часть 2', 201, 400]]);
  const big = `# Один\n${'длинная строка раздела\n'.repeat(1500)}# Два\nконец\n`;
  const mb = artifactMap(big, { title: 'X', path: '/x.md', file: 'x.md' });
  assertCovers(big, mb.sections);
  assert.deepEqual(mb.sections.map((x) => x.key).slice(0, 2), ['Один · часть 1', 'Один · часть 2']);
  assert.equal(mb.sections.at(-1)!.key, 'Два');
});

test('B16: JSON — ключи верхнего уровня с типом, размером, превью и строками; неразбираемый — как текст; YAML и массив', () => {
  const obj: Record<string, unknown> = { name: 'проект', version: 3, flags: { a: true, b: false }, items: Array.from({ length: 400 }, (_, i) => ({ id: i, text: 'элемент '.repeat(10) })) };
  const json = JSON.stringify(obj, null, 2) + '\n';
  assert.ok(Buffer.byteLength(json) > 50 * 1024);
  const m = artifactMap(json, { title: 'Данные', path: '/r/data.json', file: 'data.json' });
  assertCovers(json, m.sections);
  assert.deepEqual(m.sections.map((x) => x.key), ['name', 'version', 'flags', 'items']);
  assert.deepEqual(m.sections.map((x) => x.about), ['строка: проект', 'число: 3', 'объект, ключей: 2 — a, b', 'массив, элементов: 400']);
  const broken = json.replace('"version": 3,', '"version": 3,,');
  const mt = artifactMap(broken, { title: 'Данные', path: '/r/data.json', file: 'data.json' });
  assert.ok(mt.sections.every((x) => x.key.startsWith('часть')), 'неразбираемый JSON — как текст');
  assertCovers(broken, mt.sections);
  const yaml = 'first:\n  a: 1\nsecond: строка\nthird:\n  - x\n  - y\n';
  const my = artifactMap(yaml, { title: 'Y', path: '/y.yaml', file: 'y.yaml' });
  assertCovers(yaml, my.sections);
  assert.deepEqual(my.sections.map((x) => [x.key, x.about]), [['first', 'объект, ключей: 1 — a'], ['second', 'строка: строка'], ['third', 'массив, элементов: 2']]);
  const arr = JSON.stringify([{ a: 1 }, { b: 2 }], null, 2);
  assert.deepEqual(artifactMap(arr, { title: 'A', path: '/a.json', file: 'a.json' }).sections.map((x) => x.key), ['[0]', '[1]']);
  const flat = artifactMap('{"a":1,"b":"x"}', { title: 'F', path: '/f.json', file: 'f.json' });
  assert.deepEqual(flat.sections.map((x) => [x.key, x.from, x.to]), [['a', 1, 1], ['b', 1, 1]], 'файл в одну строку — по ключам без диапазонов');
});

test('B17: 2000 разделов — карта не больше 8 КБ, свёрнутые диапазоны покрывают весь файл', () => {
  const md = Array.from({ length: 2000 }, (_, i) => `## Раздел ${i + 1}\nтекст раздела ${i + 1}\n`).join('');
  const m = artifactMap(md, { title: 'Много', path: '/m.md', file: 'm.md' });
  assert.equal(m.sections.length, 2000);
  assertCovers(md, m.sections);
  assert.ok(Buffer.byteLength(m.text) <= MAP_MAX, String(Buffer.byteLength(m.text)));
  const ranges = [...m.text.matchAll(/— строк(?:и (\d+)–(\d+)|а (\d+))/g)].map((r) => (r[3] ? [Number(r[3]), Number(r[3])] : [Number(r[1]), Number(r[2])]));
  assert.ok(ranges.length > 1 && ranges.length < 2000);
  let next = 1;
  for (const [a, b] of ranges) {
    assert.equal(a, next);
    next = b + 1;
  }
  assert.equal(next - 1, m.lines);
  assert.match(m.text, /- разделы 1–\d+ — строки 1–\d+ \(\d+\), \d+ (Б|КБ): от «Раздел 1» до «Раздел \d+»/);
});

test('сворачивание: сначала глубокие уровни, верхние разделы остаются', () => {
  const md = Array.from({ length: 40 }, (_, i) => `# Глава ${i + 1}\nО главе ${i + 1}.\n${Array.from({ length: 30 }, (_, j) => `### Пункт ${j + 1}\nтекст\n`).join('')}`).join('');
  const m = artifactMap(md, { title: 'Г', path: '/g.md', file: 'g.md' });
  assert.ok(Buffer.byteLength(m.text) <= MAP_MAX);
  assert.match(m.text, /\n- Глава 1 \(\+ подразделов: 30\) — строки 1–62 \(62\), \d+ Б: О главе 1\.\n- Глава 2 \(\+ подразделов: 30\) — строки 63–124/);
});

test('карта файла больше 8 МБ — части по 200 строк без описаний', () => {
  const m = artifactMapParts(1000, { title: 'Огромный', path: '/h.md', file: 'h.md', size: 9 * 1024 * 1024 });
  assert.deepEqual(m.sections.map((x) => [x.from, x.to]), [[1, 200], [201, 400], [401, 600], [601, 800], [801, 1000]]);
  assert.match(m.text, /9\.0 МБ, строк: 1000/);
});

test('sliceLines: как Read с offset и limit, последняя строка без перевода строки', () => {
  assert.equal(sliceLines('a\nb\nc', 2, 3), 'b\nc');
  assert.equal(sliceLines('a\nb\nc\n', 1, 1), 'a\n');
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
});

// ---------- пункты чек-листа

test('countTasks: пустой файл и текст без чек-листа — undefined', () => {
  assert.equal(countTasks(''), undefined);
  assert.equal(countTasks('# Заголовок\n\n- пункт\n* ещё\n1. нумерованный\nтекст [ ] в строке\n'), undefined);
});

test('countTasks: только открытые', () => {
  assert.deepEqual(countTasks('# Пункты\n- [ ] один\n- [ ] два\n- [ ] три'), { open: 3, done: 0 });
});

test('countTasks: смешанные — [x] и [X], маркеры -, * и +', () => {
  assert.deepEqual(countTasks('- [ ] a\n- [x] b\n* [X] c\n+ [ ] d\n* [ ] e\n+ [x] f\n'), { open: 3, done: 3 });
});

test('countTasks: вложенные с отступом — пункты, а не код с отступом', () => {
  assert.deepEqual(countTasks('- [ ] верхний\n  - [x] два пробела\n    - [ ] четыре\n        - [X] восемь\n\t- [ ] таб\n'), { open: 3, done: 2 });
});

test('countTasks: внутри оград ``` и ~~~ не считаются; после закрытия — снова считаются', () => {
  const text = [
    '- [ ] до',
    '```md',
    '- [ ] в коде',
    '- [x] в коде',
    '```',
    '- [x] между',
    '~~~',
    '- [ ] в тильдах',
    '```',
    '- [ ] ``` внутри ~~~ не закрывает',
    '~~~',
    '````',
    '- [ ] в длинной',
    '```',
    '- [ ] короче не закрывает',
    '````',
    '- [ ] после',
  ].join('\n');
  assert.deepEqual(countTasks(text), { open: 2, done: 1 });
});

test('countTasks: незакрытая ограда — до конца файла не считается', () => {
  assert.deepEqual(countTasks('- [x] до\n```\n- [ ] в коде\n- [ ] тоже\n'), { open: 0, done: 1 });
  assert.equal(countTasks('```\n- [ ] всё в коде\n'), undefined);
});

test('countTasks: не пункты — без пробела после маркера, в середине строки, другой символ в скобках', () => {
  assert.equal(countTasks('-[ ] слитно\nтекст - [ ] в строке\n- [y] не то\n- [] пусто\n- [  ] два пробела\n'), undefined);
});

test('artifactTasks: только markdown-артефакты', () => {
  assert.deepEqual(artifactTasks('checks.md', '- [ ] a\n- [x] b\n'), { open: 1, done: 1 });
  assert.deepEqual(artifactTasks('CHECKS.MD', '- [ ] a\n'), { open: 1, done: 0 });
  assert.equal(artifactTasks('list.yaml', '- [ ]\n'), undefined);
  assert.equal(artifactTasks('notes.txt', '- [ ] a\n'), undefined);
  assert.equal(artifactTasks('data.json', '"- [ ] a"\n'), undefined);
});

// ---------- раздел промпта

test('B2: раздел «Артефакты запуска» — название, путь, доступ, автор с датой и временем, два правила', () => {
  const at = '2026-10-15T09:03:00.000Z';
  const s = artifactSection([
    { title: 'План', path: '/r/artifacts/plan.md', write: false, author: { kind: 'user', via: 'ui', at } },
    { title: 'Пункты', path: '/r/artifacts/progress.md', write: true, author: { kind: 'phase', block: 'main', iteration: 2, phase: 'verify', at } },
    { title: 'Заметки', path: '/r/artifacts/notes.md', write: false, author: { kind: 'outside', at } },
    { title: 'Идеи', path: '/r/artifacts/ideas.md', write: false, author: { kind: 'initial' } },
  ]);
  assert.equal(
    s,
    [
      'Артефакты запуска:',
      `- План — /r/artifacts/plan.md — чтение — последнюю правку сделал пользователь ${fmtWhen(at)}: учитывай её и не откатывай`,
      `- Пункты — /r/artifacts/progress.md — запись — изменён этапом verify, итерация 2, ${fmtWhen(at)}`,
      `- Заметки — /r/artifacts/notes.md — чтение — изменён вне этапов между шагами ${fmtWhen(at)}, источник не установлен`,
      '- Идеи — /r/artifacts/ideas.md — чтение — заготовка flow',
      'Пиши только в артефакты с доступом «запись».',
      'Пути к артефактам — только отсюда, а не из выводов прошлых этапов.',
      '«Пункты» — текущее состояние, а не журнал: обновляй так, чтобы файл описывал, как есть сейчас. Списки (файлы, исправления) пополняй и уточняй, а историю попыток по итерациям не дописывай — версии хранит раннер.',
    ].join('\n'),
  );
  assert.match(fmtWhen(at), /^\d\d\.10 \d\d:03$/);
  assert.equal(artifactSection([]), '');
  // B18: пишущий этап, получивший карту, — перечитать файл после правок; читающему с картой и пишущему без карты — нет
  const withMap = artifactSection([
    { title: 'План', path: '/p', write: true, author: { kind: 'initial' }, mapped: true },
    { title: 'Заметки', path: '/n', write: false, author: { kind: 'initial' }, mapped: true },
    { title: 'Итог', path: '/i', write: true, author: { kind: 'initial' } },
  ]);
  assert.ok(withMap.endsWith('\nКарта «План» снята на начало шага: после своих правок перечитай файл — строки сдвинулись.'));
  assert.doesNotMatch(s, /перечитай/);
});

test('раздел: текст уже в промпте — файл ради содержимого не читать; записываемое — состояние, кроме журнала решений', () => {
  const s = artifactSection([
    { title: 'План', path: '/p', write: false, author: { kind: 'initial' }, inline: true },
    { title: 'Пункты', path: '/c', write: true, author: { kind: 'initial' }, inline: true },
    { title: 'Изменения', path: '/ch', write: true, author: { kind: 'initial' } },
    { title: 'Большой', path: '/b', write: false, author: { kind: 'initial' }, inline: true, mapped: true },
    { title: 'Решения', path: '/d', write: true, author: { kind: 'initial' }, decisions: true },
  ]);
  const tail = s.split('\n').slice(-2);
  assert.equal(tail[0], 'Текст «План», «Пункты» уже есть выше на начало шага: читать файл ради содержимого не нужно.', 'карта — не текст');
  assert.equal(tail[1], '«Пункты», «Изменения» — текущее состояние, а не журнал: обновляй так, чтобы файл описывал, как есть сейчас. Списки (файлы, исправления) пополняй и уточняй, а историю попыток по итерациям не дописывай — версии хранит раннер.', 'журнал решений — не состояние');
  assert.doesNotMatch(artifactSection([{ title: 'План', path: '/p', write: false, author: { kind: 'initial' } }]), /уже есть выше|текущее состояние/, 'только чтение по пути — без новых строк');
});

test('уточнение 1: правка снаружи и неизвестный автор — без голоса пользователя; перенос из запуска помечен', () => {
  const at = '2026-10-15T09:03:00.000Z';
  assert.doesNotMatch(describeAuthor({ kind: 'outside', at }), /учитывай|пользовател/);
  assert.doesNotMatch(describeAuthor({ kind: 'unknown', block: 'm', iteration: 1, phase: 'x', at }), /учитывай|пользовател/);
  assert.equal(describeAuthor({ kind: 'user', via: 'skill', at }, 'run-1'), `последнюю правку сделал пользователь ${fmtWhen(at)} (из запуска run-1): учитывай её и не откатывай`);
  assert.equal(describeAuthor({ kind: 'empty' }), 'ещё не заполнялся');
  assert.equal(describeAuthor({ kind: 'condition', block: 'm', iteration: 3, at }), `изменён при проверке условия, итерация 3, ${fmtWhen(at)}`);
});

// ---------- canonical и guard

function withTmp(fn: (dir: string) => void) {
  return () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-art-')));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('canonical: ~, относительный путь от cwd, симлинк каталога, несуществующий хвост', withTmp((dir) => {
  fs.mkdirSync(path.join(dir, 'real', 'sub'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  assert.equal(canonical('link/sub/new/x.md', dir, nodeProbe), path.join(dir, 'real', 'sub', 'new', 'x.md'));
  assert.equal(canonical('.././sub', path.join(dir, 'link', 'sub'), nodeProbe), path.join(dir, 'real', 'sub'));
  const rel = path.relative(os.homedir(), path.join(dir, 'link', 'sub'));
  assert.equal(canonical(`~/${rel}`, '/', nodeProbe), path.join(dir, 'real', 'sub'));
  // регистр: probe (на APFS — realpath.native) отдаёт настоящий регистр, дальше сравнение точное
  const probe = { realpath: (p: string) => (p.toLowerCase() === '/a/plan.md' ? '/a/plan.md' : p === '/' ? '/' : undefined) };
  assert.equal(canonical('/A/PLAN.md', '/', probe), '/a/plan.md');
}));

/** Папка запусков с запуском r1: артефакты plan (пишет), notes (читает), other (нет доступа); проект рядом. */
function scope(dir: string, access: ArtifactAccess, tools: string[] = []): GuardScope {
  const runs = path.join(dir, 'runs');
  const art = path.join(runs, 'r1', 'artifacts');
  fs.mkdirSync(art, { recursive: true });
  fs.mkdirSync(path.join(runs, 'r0'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
  for (const f of ['plan.md', 'notes.md', 'other.md']) fs.writeFileSync(path.join(art, f), f);
  fs.writeFileSync(path.join(dir, 'project', 'code.ts'), 'x');
  const keys = ['plan', 'notes', 'other'];
  return {
    access,
    tools,
    dir: art,
    runsDir: runs,
    files: new Map(keys.map((k) => [path.join(art, `${k}.md`), k])),
    titles: new Map([['plan', 'План'], ['notes', 'Заметки'], ['other', 'Чужое']]),
    probe: nodeProbe,
  };
}
const IMPLICIT: ArtifactAccess = { read: ['plan', 'notes'], write: ['plan'], implicit: ['Read', 'Edit', 'Write'] };

test('guard, неявные инструменты: свои артефакты — да; чужой — только чтение; проект, папка, необъявленный — отказ', withTmp((dir) => {
  const s = scope(dir, IMPLICIT);
  const art = s.dir;
  const cwd = path.join(dir, 'project');
  const check = (tool: string, input: Record<string, unknown>) => artifactGuardDecision(s, tool, input, cwd)?.reason;
  assert.equal(check('Edit', { file_path: path.join(art, 'plan.md') }), undefined, 'B7: правка своего');
  assert.equal(check('Write', { file_path: path.join(art, 'plan.md') }), undefined);
  assert.equal(check('Read', { file_path: path.join(art, 'notes.md') }), undefined, 'B6: чтение своего');
  assert.equal(check('Edit', { file_path: path.join(art, 'notes.md') }), 'artifact-readonly', 'C1: правка читаемого');
  assert.equal(check('Write', { file_path: path.join(art, 'other.md') }), 'artifact-readonly', 'запись в артефакт без доступа');
  assert.equal(check('Read', { file_path: path.join(art, 'other.md') }), 'not-artifact', 'чтение артефакта без доступа');
  assert.equal(check('Edit', { file_path: path.join(cwd, 'code.ts') }), 'outside-artifacts', 'B7: правка проекта');
  assert.equal(check('Read', { file_path: path.join(cwd, 'code.ts') }), 'outside-artifacts', 'B6: чтение проекта');
  assert.equal(check('Write', { file_path: path.join(art, 'new.md') }), 'not-artifact', 'C3: новый файл в папке');
  assert.equal(check('Edit', {}), 'not-artifact', 'нет пути');
  assert.equal(check('Edit', { file_path: 42 }), 'not-artifact', 'путь не строка');
  assert.equal(check('Edit', { file_path: path.relative(cwd, path.join(art, 'plan.md')) }), undefined, 'относительный путь к своему');
  assert.equal(check('Edit', { file_path: `~/${path.relative(os.homedir(), path.join(art, 'notes.md'))}` }), 'artifact-readonly', '~-путь');
  assert.equal(check('Edit', { file_path: path.join(art, 'sub', '..', 'notes.md') }), 'artifact-readonly');
  assert.equal(check('Grep', { path: path.join(cwd) }), undefined, 'прочие инструменты не проверяются');
  assert.ok(artifactGuardDecision(s, 'Edit', { file_path: path.join(art, 'notes.md') }, cwd)!.message.includes('«Заметки»'), 'C1: объяснение называет артефакт');
}));

test('guard: удалённый свой артефакт — Write пересоздаёт (C3), Edit и Read — отказ', withTmp((dir) => {
  const s = scope(dir, IMPLICIT);
  fs.rmSync(path.join(s.dir, 'plan.md'));
  assert.equal(artifactGuardDecision(s, 'Write', { file_path: path.join(s.dir, 'plan.md') }, dir), undefined);
  assert.equal(artifactGuardDecision(s, 'Edit', { file_path: path.join(s.dir, 'plan.md') }, dir)?.reason, 'not-artifact');
}));

test('guard: симлинк и жёсткая ссылка вместо артефакта, симлинк в папке на проект — отказ неявному', withTmp((dir) => {
  const s = scope(dir, IMPLICIT);
  const plan = path.join(s.dir, 'plan.md');
  const code = path.join(dir, 'project', 'code.ts');
  fs.rmSync(plan);
  fs.linkSync(code, plan);
  assert.equal(artifactGuardDecision(s, 'Edit', { file_path: plan }, dir)?.reason, 'not-artifact', 'жёсткая ссылка');
  fs.rmSync(plan);
  fs.symlinkSync(code, plan);
  assert.equal(artifactGuardDecision(s, 'Edit', { file_path: plan }, dir)?.reason, 'outside-artifacts', 'симлинк на файл проекта');
  fs.symlinkSync(code, path.join(s.dir, 'x.md'));
  assert.equal(artifactGuardDecision(s, 'Read', { file_path: path.join(s.dir, 'x.md') }, dir)?.reason, 'outside-artifacts');
}));

test('guard, явные инструменты: проект — как раньше; в папке артефактов — только свои из writes; остальная папка запусков — отказ', withTmp((dir) => {
  const s = scope(dir, { read: ['notes'], write: [], implicit: [] }, ['Read', 'Edit', 'Write']);
  const check = (tool: string, file: string) => artifactGuardDecision(s, tool, { file_path: file }, dir)?.reason;
  assert.equal(check('Edit', path.join(dir, 'project', 'code.ts')), undefined);
  assert.equal(check('Read', path.join(s.dir, 'other.md')), undefined, 'явный Read читает что угодно');
  assert.equal(check('Edit', path.join(s.dir, 'notes.md')), 'artifact-readonly', 'C1 при Edit в tools');
  assert.equal(check('Write', path.join(s.dir, 'new.md')), 'not-artifact');
  assert.equal(check('Write', path.join(dir, 'runs', 'r1', 'run.json')), 'runs-dir', 'уточнение 8');
  assert.equal(check('Edit', path.join(dir, 'runs', 'r0', 'x.md')), 'runs-dir');
  assert.equal(artifactGuardDecision(s, 'NotebookEdit', { notebook_path: path.join(dir, 'runs', 'n.ipynb') }, dir)?.reason, 'runs-dir');
  assert.equal(artifactGuardDecision(s, 'Edit', {}, dir), undefined, 'явный без пути — решает сам инструмент');
  const w = scope(dir, { read: ['plan'], write: ['plan'], implicit: [] }, ['Read', 'Edit', 'Write']);
  assert.equal(artifactGuardDecision(w, 'Edit', { file_path: path.join(w.dir, 'plan.md') }, dir), undefined);
}));

test('guard: явный Edit и неявный Write у одного этапа — Edit правит проект, Write только свои артефакты', withTmp((dir) => {
  const s = scope(dir, { read: ['plan'], write: ['plan'], implicit: ['Read', 'Write'] }, ['Edit']);
  const code = path.join(dir, 'project', 'code.ts');
  assert.equal(artifactGuardDecision(s, 'Edit', { file_path: code }, dir), undefined);
  assert.equal(artifactGuardDecision(s, 'Write', { file_path: code }, dir)?.reason, 'outside-artifacts');
  assert.equal(artifactGuardDecision(s, 'Write', { file_path: path.join(s.dir, 'plan.md') }, dir), undefined);
}));

test('уточнение 10: сабагент с isolation у этапа с неявными правами — отказ; без них или без isolation — можно', withTmp((dir) => {
  const s = scope(dir, IMPLICIT);
  assert.equal(artifactGuardDecision(s, 'Agent', { prompt: 'x', isolation: 'worktree' }, dir)?.reason, 'isolation');
  assert.equal(artifactGuardDecision(s, 'Task', { prompt: 'x', isolation: 'remote' }, dir)?.reason, 'isolation');
  assert.equal(artifactGuardDecision(s, 'Agent', { prompt: 'x' }, dir), undefined);
  const explicit = scope(dir, { read: ['plan'], write: ['plan'], implicit: [] }, ['Read', 'Edit', 'Write']);
  assert.equal(artifactGuardDecision(explicit, 'Agent', { prompt: 'x', isolation: 'worktree' }, dir), undefined);
}));

test('agent.ts: исключение внутри guard — отказ, cwd приходит из входа хука', async () => {
  const seen: string[] = [];
  const o = sessionOptions({
    prompt: 'x',
    cwd: '/w',
    tools: [],
    guard: (_tool, _input, ctx) => {
      seen.push(ctx.cwd);
      throw new Error('сломалось');
    },
  });
  const hook = o.hooks!.PreToolUse![0].hooks[0];
  const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/w/a' }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/from-hook' }, 't', { signal: new AbortController().signal });
  assert.deepEqual(seen, ['/from-hook']);
  const spec = (out as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput;
  assert.equal(spec.permissionDecision, 'deny');
  assert.match(spec.permissionDecisionReason, /сломалось.*отклонён/);
});

test('отказы считаются по инструменту и причине', () => {
  const list: Parameters<typeof countDenial>[0] = [];
  countDenial(list, 'Edit', 'outside-artifacts');
  countDenial(list, 'Edit', 'outside-artifacts');
  countDenial(list, 'Write', 'artifact-readonly');
  assert.deepEqual(list, [{ tool: 'Edit', reason: 'outside-artifacts', count: 2 }, { tool: 'Write', reason: 'artifact-readonly', count: 1 }]);
});

test('artifactEditability: кто и когда правит артефакт через API (таблица «Когда артефакт можно править»)', () => {
  const base: EditState = { live: false, lockedBy: [], pendingQuestion: [], cliAlive: false, continuable: true, size: 10, path: '/runs/r/artifacts/plan.md' };
  const e = (status: string, over: Partial<EditState> = {}) => artifactEditability({ status }, { ...base, ...over });

  // живой запуск: шаг не пишет — можно; пишущий шаг — writing со всеми пишущими; спросивший пишущий — asking
  assert.deepEqual(e('running', { live: true }), { editable: true });
  const writing = e('running', { live: true, lockedBy: ['a', 'b'] });
  assert.equal(writing.editable, false);
  assert.equal(writing.reason, 'writing');
  assert.deepEqual(writing.phases, ['a', 'b']);
  assert.match(writing.message!, /Пишет этап a, b/);
  const asking = e('running', { live: true, lockedBy: ['a', 'b'], pendingQuestion: ['b'] });
  assert.equal(asking.reason, 'asking');
  assert.deepEqual(asking.phases, ['b']);
  assert.match(asking.message!, /Этап b ждёт твоего ответа и пишет этот артефакт/);
  // спросивший только читает — правка открыта (предупреждение даст ответ записи: readers)
  assert.deepEqual(e('running', { live: true, pendingQuestion: ['c'] }), { editable: true });
  assert.equal(e('running', { live: true, size: EDIT_MAX + 1 }).reason, 'too-big');

  // неживой: CLI — чтение; done — чтение; продолжить нельзя — чтение с причиной; можно — правка в продолжение
  assert.equal(e('running', { cliAlive: true }).reason, 'cli');
  assert.equal(e('running', { cliAlive: true }).editable, false);
  assert.deepEqual([e('done', { continuable: false }).editable, e('done', { continuable: false }).reason], [false, 'done']);
  const nc = e('max_iterations', { continuable: false, continueReason: 'Первый блок «main» не завершён: продолжать нечего, запусти заново' });
  assert.equal(nc.editable, false);
  assert.equal(nc.reason, 'not-continuable');
  assert.match(nc.message!, /Продолжить этот запуск нельзя \(первый блок «main» не завершён/);
  for (const status of ['aborted', 'failed', 'max_iterations', 'budget_exceeded', 'interrupted']) {
    const ok = e(status);
    assert.deepEqual([ok.editable, ok.reason], [true, 'continuable'], status);
    assert.match(ok.message!, /попадёт в продолжение/);
  }
  // больше 1 МБ — только чтение с путём к файлу; ровно 1 МБ — можно
  const big = e('aborted', { size: EDIT_MAX + 1 });
  assert.deepEqual([big.editable, big.reason], [false, 'too-big']);
  assert.match(big.message!, /\/runs\/r\/artifacts\/plan\.md/);
  assert.equal(e('aborted', { size: EDIT_MAX }).editable, true);
});
