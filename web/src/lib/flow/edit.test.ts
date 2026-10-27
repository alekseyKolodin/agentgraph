import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowSpec } from '@server/schema';
import {
  addPhaseAfter, advLabel, collectSpec, duplicatePhase, insertVar, movePhase, newBlock, newPhase, phaseInputs, renamePhase, setBlockMode, specChanges,
  SpecError, toEditable, untilFor, variableList, type EditPhase, type EditSpec,
} from './edit';
import { conditionText, schemeSummary } from './summary';
import { setLangForTest } from '../i18n';
import { addConnTools, connChips, connManualError, connNote, connPick, connPicked, modelOptions } from './tools';

const ph = (name: string, extra: Partial<EditPhase> = {}): EditPhase => ({ name, prompt: '{{input}}', tools: ['Read'], ...extra });
const spec = (blocks: EditSpec['blocks'], extra: Partial<EditSpec> = {}): EditSpec => ({ name: 'f', blocks, ...extra });

test('toEditable: короткая форма — один блок main с циклом; полная — как есть', () => {
  const short = toEditable({ name: 'f', loop: { max_iterations: 2, until: { type: 'none' } }, phases: [ph('a')] } as FlowSpec);
  assert.deepEqual(short.blocks.map((b) => [b.name, b.loop?.max_iterations, b.phases.length]), [['main', 2, 1]]);
  assert.equal('loop' in short, false);
  assert.equal('phases' in short, false);
  const full = toEditable({ name: 'f', blocks: [{ name: 'x', phases: [ph('a')] }] } as FlowSpec);
  assert.equal(full.blocks[0]!.name, 'x');
});

test('переменные этапа: prev до группы одинаковый у участников, соседи по группе и следующие блоки недоступны', () => {
  const s = spec([
    { name: 'one', title: 'План', phases: [ph('plan')] },
    { name: 'two', loop: { max_iterations: 3, until: { type: 'judge', prompt: '' } }, phases: [ph('x', { group: 'g' }), ph('y', { group: 'g' }), ph('z')] },
    { name: 'three', phases: [ph('later')] },
  ]);
  const vx = variableList(s, 1, 0);
  const prev = vx.find((v) => v.key === 'prev')!;
  assert.equal(prev.label, 'Вывод до группы');
  assert.match(prev.hint, /вывод блока «план»/);
  assert.match(prev.hint, /на итерации 2\+ — последнего этапа этого блока/);
  const keys = vx.map((v) => v.key);
  assert.ok(keys.includes('phases.plan') && keys.includes('phases.z'));
  assert.ok(!keys.includes('phases.y') && !keys.includes('phases.x') && !keys.includes('phases.later'));
  assert.equal(vx.find((v) => v.key === 'phases.plan')!.label, 'Вывод этапа plan (блок 1)');
  // после группы — склейка её выводов
  assert.equal(variableList(s, 1, 2).find((v) => v.key === 'prev')!.label, 'Выводы группы g');
  // первый этап первого блока — прошлая итерация
  assert.equal(variableList(s, 0, 0).find((v) => v.key === 'prev')!.label, 'Вывод последнего этапа прошлой итерации');
});

test('phaseInputs: что этап получает — prev с источником, этапы по имени, остальное подписью', () => {
  const s = spec([{ name: 'main', phases: [ph('a', { prompt: 'Задача: {{ input }}' }), ph('b', { prompt: '{{prev}} {{phases.a}}', handoff: '{{iteration}}' }), ph('c', { prompt: 'без подстановок' })] }]);
  assert.deepEqual(phaseInputs(s, 0, 0), ['задача']);
  assert.deepEqual(phaseInputs(s, 0, 1), ['← a', '← a', '№ итерации']);
  assert.deepEqual(phaseInputs(s, 0, 2), []);
  const first = spec([{ name: 'main', phases: [ph('a', { prompt: '{{prev}}' })] }]);
  assert.deepEqual(phaseInputs(first, 0, 0), ['← прошлая итерация']);
});

test('insertVar: есть — выделить, нет — вставить на место выделения с пробелом', () => {
  assert.deepEqual(insertVar('a {{ prev }} b', 'prev', 0, 0), { text: 'a {{ prev }} b', select: [2, 12] });
  assert.deepEqual(insertVar('Задача:', 'input', 7, 7), { text: 'Задача: {{input}}', select: [17, 17] });
  assert.deepEqual(insertVar('x\n', 'prev', 2, 2), { text: 'x\n{{prev}}', select: [10, 10] });
  assert.deepEqual(insertVar('abcd', 'prev', 1, 3), { text: 'a {{prev}}d', select: [10, 10] });
});

test('newPhase и newBlock: свободные имена, заготовки промпта по месту', () => {
  const s = spec([{ name: 'main', phases: [ph('stage-2')] }]);
  const p = newPhase(s, 0);
  assert.equal(p.name, 'stage-3');
  assert.match(p.prompt, /Результат предыдущего этапа/);
  const b = newBlock(s);
  assert.equal(b.name, 'block-2');
  assert.match(b.phases[0]!.prompt, /Результат предыдущего блока/);
  assert.match(newPhase(spec([{ name: 'main', phases: [] }]), 0).prompt, /Замечания с прошлой итерации/);
});

test('«+»: после участника группы — после всей группы; на рамке группы — новый участник', () => {
  const s = spec([{ name: 'main', phases: [ph('a'), ph('x', { group: 'g' }), ph('y', { group: 'g' }), ph('z')] }]);
  assert.equal(addPhaseAfter(s, 0, 1), 3);
  assert.equal(s.blocks[0]!.phases[3]!.group, undefined);
  const at = addPhaseAfter(s, 0, 2, 'g');
  assert.equal(at, 3);
  assert.equal(s.blocks[0]!.phases[3]!.group, 'g');
});

test('movePhase: внутри блока — обмен, с края — в соседний блок без группы; последний этап блок не покидает', () => {
  const s = spec([{ name: 'a', phases: [ph('a1'), ph('a2', { group: 'g' })] }, { name: 'b', phases: [ph('b1')] }]);
  assert.equal(movePhase(s, 0, 0, false), null);
  assert.deepEqual(s.blocks[0]!.phases.map((p) => p.name), ['a2', 'a1']);
  assert.equal(movePhase(s, 0, 0, false), null);
  movePhase(s, 0, 1, false);
  assert.deepEqual(s.blocks.map((b) => b.phases.map((p) => p.name)), [['a1'], ['a2', 'b1']]);
  assert.equal(s.blocks[1]!.phases[0]!.group, undefined);
  assert.equal(movePhase(s, 0, 0, false), 'В блоке должен остаться хотя бы один этап');
  assert.equal(movePhase(s, 1, 1, false), null, 'с конца последнего блока — некуда');
});

test('duplicatePhase: копия рядом, имя -copy, занято — с двойками', () => {
  const s = spec([{ name: 'main', phases: [ph('a'), ph('a-copy')] }]);
  assert.equal(duplicatePhase(s, 0, 0), 1);
  assert.deepEqual(s.blocks[0]!.phases.map((p) => p.name), ['a', 'a-copy2', 'a-copy']);
});

test('renamePhase: ссылки в промптах, handoff, рубрике и marker.phase; занятое имя — ошибка', () => {
  const s = spec([
    { name: 'a', loop: { max_iterations: 2, until: { type: 'judge', prompt: 'см. {{ phases.old }}' } }, phases: [ph('old'), ph('b', { prompt: '{{phases.old}}', handoff: 'и {{phases.old}}' })] },
    { name: 'c', loop: { max_iterations: 2, until: { type: 'marker', marker: '<D>', phase: 'old' } }, phases: [ph('d')] },
  ]);
  assert.equal(renamePhase(s, 'old', 'b'), 'Этап b уже есть');
  assert.equal(renamePhase(s, 'old', 'new'), null);
  assert.equal(s.blocks[0]!.phases[0]!.name, 'new');
  assert.equal(s.blocks[0]!.phases[1]!.prompt, '{{phases.new}}');
  assert.equal(s.blocks[0]!.phases[1]!.handoff, 'и {{phases.new}}');
  assert.equal(s.blocks[0]!.loop!.until.prompt, 'см. {{phases.new}}');
  assert.equal(s.blocks[1]!.loop!.until.phase, 'new');
});

test('режим блока и тип условия: цикл помнится, заготовки по типу, введённое не теряется', () => {
  const b: EditSpec['blocks'][number] = { name: 'b', loop: { max_iterations: 7, until: { type: 'command', run: 'make' } }, phases: [] };
  setBlockMode(b, false);
  assert.equal(b.loop, undefined);
  setBlockMode(b, true);
  assert.equal(b.loop!.max_iterations, 7);
  assert.deepEqual(untilFor('judge', { type: 'command', run: 'make' }).type, 'judge');
  assert.deepEqual(untilFor('command', { type: 'judge', run: 'make' }), { type: 'command', run: 'make' });
  assert.deepEqual(untilFor('marker', { type: 'none' }), { type: 'marker', marker: '<DONE>' });
  const fresh: EditSpec['blocks'][number] = { name: 'x', phases: [] };
  setBlockMode(fresh, true);
  assert.equal(fresh.loop!.until.type, 'judge');
});

test('collectSpec: чистые поля, числа из строк, on_fail только у нескольких блоков; ошибки — с полем этапа', () => {
  const s = spec([
    { name: 'a', title: ' План ', loop: { max_iterations: 2, until: { type: 'none' } }, on_fail: 'continue', knowledge: ['qa'], _savedLoop: undefined, phases: [
      ph('One', { title: ' ', handoff: '  итог ', add_dirs: [' ~/x ', ''], model: ' ', max_turns: '5', max_budget_usd: '0', group: 'G 1', reads: ['plan'], _schemaText: '{"type":"object"}' }),
    ] },
    { name: 'b', phases: [ph('two')] },
  ], { description: '  ', input: ' задача ' });
  const out = collectSpec(s) as { description?: string; input?: string; blocks: Record<string, unknown>[] };
  assert.equal(out.description, undefined);
  assert.equal(out.input, 'задача');
  const [a] = out.blocks;
  assert.equal(a!.title, 'План');
  assert.equal(a!.on_fail, 'continue');
  assert.deepEqual(a!.knowledge, ['qa']);
  assert.equal('_savedLoop' in a!, false);
  assert.deepEqual((a!.phases as unknown[])[0], { name: 'one', prompt: '{{input}}', tools: ['Read'], handoff: 'итог', add_dirs: ['~/x'], max_turns: 5, group: 'g-1', reads: ['plan'], output_schema: { type: 'object' } });
  // один блок: on_fail не сохраняется
  const single = collectSpec(spec([{ name: 'm', loop: { max_iterations: 1, until: { type: 'none' } }, on_fail: 'continue', phases: [ph('x')] }])) as { blocks: Record<string, unknown>[] };
  assert.equal(single.blocks[0]!.on_fail, undefined);

  const dup = spec([{ name: 'm', phases: [ph('x'), ph('x')] }]);
  assert.throws(() => collectSpec(dup), (err: unknown) => err instanceof SpecError && /1\.2: идентификатор x повторяется/.test(err.message) && err.field?.i === 1 && err.field.field === 'p-name');
  const bad = spec([{ name: 'm', phases: [ph('x', { _schemaText: '{' })] }]);
  assert.throws(() => collectSpec(bad), (err: unknown) => err instanceof SpecError && err.field?.field === 'p-schema');
  assert.throws(() => collectSpec(spec([{ name: 'm', phases: [ph('x')] }, { name: 'm', phases: [ph('y')] }])), /Блок 2: идентификатор m повторяется/);
});

test('specChanges: поля flow, блоки, этапы, перенос, удаление; adv — у кого раскрыть «Дополнительно»', () => {
  const before = spec([{ name: 'a', phases: [ph('x'), ph('y')] }, { name: 'gone', phases: [ph('z')] }]);
  const after = spec([{ name: 'a', title: 'Новое', phases: [ph('y'), ph('x', { prompt: 'другой', model: 'opus' })] }, { name: 'c', phases: [ph('z'), ph('n')] }], { description: 'есть' });
  const d = specChanges(before, after);
  assert.deepEqual(d.lines.map((l) => l.text), [
    'Flow: описание',
    'Блок «Новое»: название, порядок этапов',
    'Блок «c»: добавлен',
    'Блок «gone»: удалён',
    'Этап x: промпт, модель',
    'Этап z: перенесён в блок «c»',
    'Этап n: добавлен',
  ]);
  assert.deepEqual([...d.phases].sort(), ['n', 'x', 'z']);
  assert.deepEqual([...d.blocks].sort(), ['a', 'c']);
  assert.deepEqual([...d.adv].sort(), ['n', 'x']);
  assert.equal(specChanges(null, after).lines.length, 0);
});

test('коннекторы: весь коннектор заменяет отдельные инструменты, ручной ввод, примечание и чипы', () => {
  assert.deepEqual(addConnTools(['Read', 'mcp__claude_ai_Slack__send'], ['mcp__claude_ai_Slack']), ['Read', 'mcp__claude_ai_Slack']);
  assert.deepEqual(addConnTools(['mcp__claude_ai_Slack'], ['mcp__claude_ai_Slack__send']), ['mcp__claude_ai_Slack']);
  assert.equal(connManualError('mcp__claude_ai_Slack__send'), '');
  assert.match(connManualError('mcp__abc__x y'), /desktop-сессии не подойдёт/);
  assert.match(connManualError('slack'), /Нужно имя вида/);
  const builtin = new Set(['Read', 'Agent', 'Skill']);
  const view = {
    at: '', connectors: [{ server: 'claude.ai Slack', name: 'mcp__claude_ai_Slack', status: 'connected', tools: [
      { name: 'mcp__claude_ai_Slack__read', tool: 'read', readOnly: true, description: 'читать' },
      { name: 'mcp__claude_ai_Slack__read2', tool: 'read2', readOnly: true },
      { name: 'mcp__claude_ai_Slack__send', tool: 'send', readOnly: false },
    ] }, { server: 'claude.ai Jira', name: 'mcp__claude_ai_Jira', status: 'needs-auth', tools: [] }],
  };
  const p = ph('a', { tools: ['Read', 'mcp__claude_ai_Slack__send', 'mcp__x__y'] });
  assert.deepEqual(connNote(p, builtin, view), ['warn', 'Этап получит коннекторы. Без подтверждения он сможет и менять данные: send.']);
  assert.deepEqual(connChips(p, builtin, view).map((c) => [c.text, c.cls]), [['Slack · send', 'on write'], ['mcp__x__y', 'other']]);
  assert.match(connNote(ph('b', { prompt: 'открой задачу в Jira' }), builtin, null)[1], /Промпт обращается к Jira/);
  assert.match(connNote(ph('b', { permission_mode: 'auto' }), builtin, null)[1], /Права «auto»/);
  const pick = connPick(p, view);
  assert.equal(pick.ready, 1);
  assert.deepEqual(pick.off, ['Jira']);
  assert.deepEqual(pick.groups[0]!.options.map((o) => o.value), ['whole:mcp__claude_ai_Slack', 'mcp__claude_ai_Slack__read', 'mcp__claude_ai_Slack__read2']);
  // «всё на чтение» — когда кроме чтения у коннектора остаются и меняющие данные
  assert.deepEqual(connPick(ph('c'), view).groups[0]!.options.map((o) => o.value).slice(0, 2), ['whole:mcp__claude_ai_Slack', 'read:mcp__claude_ai_Slack']);
  assert.deepEqual(connPicked('read:mcp__claude_ai_Slack', view), ['mcp__claude_ai_Slack__read', 'mcp__claude_ai_Slack__read2']);
  assert.deepEqual(connPicked('whole:mcp__claude_ai_Slack', view), ['mcp__claude_ai_Slack']);
  assert.deepEqual(modelOptions('my-model').at(-1), ['my-model', 'my-model']);
  assert.equal(modelOptions('claude-opus-5-5').length, 5);
});

test('сводка «Схемы»: один блок — этапы и цикл, несколько — блоки и этапы', () => {
  const blk = (looped: boolean, n: number) => ({ name: 'b', looped, maxIterations: 5, condition: 'пока команда `npm test` не вернёт 0', onFail: 'stop' as const, phases: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, tools: [] })) });
  assert.equal(schemeSummary({ name: 'f', file: '', folder: '', valid: true, blocks: [blk(true, 3)] }), '3 этапа · до 5 итераций, пока команда npm test не вернёт 0');
  assert.equal(schemeSummary({ name: 'f', file: '', folder: '', valid: true, blocks: [blk(false, 1)] }), '1 этап · один проход');
  assert.equal(schemeSummary({ name: 'f', file: '', folder: '', valid: true, blocks: [blk(false, 1), blk(true, 4)] }), '2 блока · 5 этапов');
});

test('условие от сервера по-английски: команда, маркер, судья, пауза; русский и незнакомый текст — как есть', () => {
  assert.equal(conditionText('пока команда `npm test` не вернёт 0'), 'пока команда `npm test` не вернёт 0');
  setLangForTest('en');
  try {
    assert.equal(conditionText('пока команда `git diff --stat -- \'{a}\' && npm test` не вернёт 0'), "until `git diff --stat -- '{a}' && npm test` exits 0");
    assert.equal(conditionText('пока в выводе этапа нет маркера <DONE>, пауза по маркеру <NEEDS_USER>'), 'until the phase outputs <DONE>, pause on marker <NEEDS_USER>');
    assert.equal(conditionText('пока судья не скажет «готово»'), 'until the judge approves');
    assert.equal(conditionText('что-то новое'), 'что-то новое');
    assert.equal(conditionText('пока команда `npm test` не вернёт 0 → один проход → пока судья не скажет «готово»'), 'until `npm test` exits 0 → single pass → until the judge approves');
    assert.equal(conditionText('пока в выводе этапа нет маркера <ALL DONE>, пауза по маркеру <NEEDS USER>'), 'until the phase outputs <ALL DONE>, pause on marker <NEEDS USER>');
    const blk = { name: 'b', looped: true, maxIterations: 4, condition: 'пока команда `npm test` не вернёт 0', onFail: 'stop' as const, phases: [{ name: 'p', tools: [] }] };
    assert.match(schemeSummary({ name: 'f', file: '', folder: '', valid: true, blocks: [blk] }), /, until npm test exits 0$/);
  } finally {
    setLangForTest('ru');
  }
});

test('collectSpec: plugins этапа и блока сохраняются как есть, пустые — не сохраняются', () => {
  const out = collectSpec(spec([{ name: 'm', plugins: ['~/my-plugin'], phases: [ph('x', { plugins: ['/p'] }), ph('y', { plugins: [] })] }])) as { blocks: Record<string, unknown>[] };
  const [b] = out.blocks;
  assert.deepEqual(b!.plugins, ['~/my-plugin']);
  const [x, y] = b!.phases as Record<string, unknown>[];
  assert.deepEqual(x!.plugins, ['/p']);
  assert.equal('plugins' in y!, false);
});

test('specChanges: правка плагинов этапа и блока видна в сводке', () => {
  const before = spec([{ name: 'a', phases: [ph('x')] }]);
  const after = spec([{ name: 'a', plugins: ['~/qa'], phases: [ph('x', { plugins: ['/p'] })] }]);
  assert.deepEqual(specChanges(before, after).lines.map((l) => l.text), ['Блок «a»: плагины', 'Этап x: плагины']);
});

test('collectSpec: плагины из конструктора — без пустых строк и пробелов; advLabel считает плагины', () => {
  const out = collectSpec(spec([{ name: 'm', plugins: [' ~/qa ', ''], phases: [ph('x', { plugins: ['/p', '  '] })] }])) as { blocks: Record<string, unknown>[] };
  assert.deepEqual(out.blocks[0]!.plugins, ['~/qa']);
  assert.deepEqual((out.blocks[0]!.phases as Record<string, unknown>[])[0]!.plugins, ['/p']);
  assert.equal(advLabel(ph('x', { plugins: ['/p'], add_dirs: ['/d'] })), 'Дополнительно · директорий: 1 · плагинов: 1');
});
