import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { assertRunnable, CALL_DEPTH_MAX, callInput, callOutcome, callProblems, calledFlows, describeNext, pickNext } from './compose.js';
import { flowToYaml, parseFlow, summarize, validateSpec } from './flows.js';
import { compactSpec, flowBlocks, flowJsonSchema, flowPhases, GeneratedFlowSchema, type FlowSpec } from './schema.js';
import { emptyContext } from './template.js';

const phase = (name: string, prompt = 'x') => ({ name, tools: [], prompt });
const flow = (yaml: string): FlowSpec => parseFlow(yaml);
const fails = (raw: unknown, re: RegExp) => assert.throws(() => validateSpec(raw), re);

const chain = `
name: pipeline
blocks:
  - name: spec
    flow: write-spec
  - name: implement
    flow: implement-feature
    input: "{{input}}\\nСпека: {{phases.spec}}"
  - name: review
    flow: code-review
`;

test('блок-вызов: flow вместо phases разбирается, в flowBlocks у него один этап — сам вызов', () => {
  const spec = flow(chain);
  const blocks = flowBlocks(spec);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[1].phases, [{ name: 'implement', title: 'implement-feature', prompt: '{{input}}\nСпека: {{phases.spec}}', tools: [] }]);
  assert.equal(blocks[0].phases[0].prompt, '');
  // этапов-сессий у такого flow нет: контекст и сводки их не показывают
  assert.deepEqual(flowPhases(spec), []);
  assert.deepEqual(calledFlows(spec), ['write-spec', 'implement-feature', 'code-review']);
});

test('блок-вызов: YAML переживает сохранение и не сворачивается в короткую форму', () => {
  const one = flow('name: one\nblocks:\n  - name: main\n    flow: other\n');
  assert.equal(compactSpec(one).blocks?.[0].flow, 'other');
  assert.deepEqual(parseFlow(flowToYaml(compactSpec(flow(chain)))), flow(chain));
  const withNext = flow('name: n\nblocks:\n  - name: main\n    next: end\n    phases: [{ name: a, tools: [], prompt: x }]\n');
  assert.equal(compactSpec(withNext).blocks?.[0].next, 'end');
});

test('блок-вызов: либо phases, либо flow; input, теги знаний, плагины и пауза — по правилам вызова', () => {
  const base = { name: 'f' };
  fails({ ...base, blocks: [{ name: 'a', flow: 'g', phases: [phase('p')] }] }, /Либо phases, либо flow/);
  fails({ ...base, blocks: [{ name: 'a' }] }, /Нужны phases или flow/);
  fails({ ...base, blocks: [{ name: 'a', input: 'x', phases: [phase('p')] }] }, /input — задача вызываемого flow/);
  fails({ ...base, blocks: [{ name: 'a', flow: 'g', knowledge: ['qa'] }] }, /теги знаний задаются в вызываемом flow/);
  fails({ ...base, blocks: [{ name: 'a', flow: 'g', plugins: ['~/p'] }] }, /плагины задаются в вызываемом flow/);
  fails({ ...base, blocks: [{ name: 'a', flow: 'g', loop: { max_iterations: 2, until: { type: 'none' }, pause_marker: '<P>' } }] }, /Пауза по маркеру/);
  fails({ ...base, blocks: [{ name: 'a', flow: 'g', loop: { max_iterations: 2, until: { type: 'marker', marker: '<D>', phase: 'a' } } }] }, /phase не указывают/);
  fails({ ...base, blocks: [{ name: 'a', flow: 'f' }] }, /вызывает сам себя/);
  fails({ ...base, blocks: [{ name: 'a', flow: 'Bad_Name' }] }, /flow/);
});

test('блок-вызов: имя блока — имя его этапа, {{phases.<блок>}} работает из следующих блоков', () => {
  assert.doesNotThrow(() => flow(chain));
  fails(
    { name: 'f', blocks: [{ name: 'a', phases: [phase('p', '{{phases.b}}')] }, { name: 'b', flow: 'g' }] },
    /\{\{phases\.b\}\} — этап из следующего блока b/,
  );
  fails({ name: 'f', blocks: [{ name: 'a', phases: [phase('b')] }, { name: 'b', flow: 'g' }] }, /этап b встречается дважды/);
});

test('next: строка или правила; переход только вперёд, к известному блоку или end', () => {
  const blocks = (next: unknown) => [
    { name: 'a', next, phases: [phase('p')] },
    { name: 'b', phases: [phase('q')] },
    { name: 'c', flow: 'g' },
  ];
  assert.doesNotThrow(() => validateSpec({ name: 'f', blocks: blocks('c') }));
  assert.doesNotThrow(() => validateSpec({ name: 'f', blocks: blocks('end') }));
  assert.doesNotThrow(() => validateSpec({ name: 'f', blocks: blocks([{ if: { type: 'marker', marker: '<BUG>' }, goto: 'c' }, { goto: 'b' }]) }));
  fails({ name: 'f', blocks: blocks('zzz') }, /Неизвестный блок zzz/);
  fails({ name: 'f', blocks: [{ name: 'a', phases: [phase('p')] }, { name: 'b', next: 'a', phases: [phase('q')] }] }, /Переход только вперёд: блок a не ниже блока b/);
  fails({ name: 'f', blocks: [{ name: 'a', next: 'a', phases: [phase('p')] }] }, /Переход только вперёд/);
  fails({ name: 'f', blocks: blocks([{ goto: 'b' }, { if: { type: 'command', run: 'true' }, goto: 'c' }]) }, /Правило без if — последнее/);
  fails({ name: 'f', blocks: blocks([{ if: { type: 'marker', marker: '<X>', phase: 'q' }, goto: 'c' }]) }, /этап q не из этого блока/);
  fails({ name: 'f', blocks: [{ name: 'a', flow: 'g', next: [{ if: { type: 'marker', marker: '<X>', phase: 'a' }, goto: 'end' }] }] }, /phase не указывают/);
  fails({ name: 'f', blocks: blocks([{ if: { type: 'judge', prompt: '{{phases.q}}' }, goto: 'c' }]) }, /next\[0\] судья: \{\{phases\.q\}\} — этап из следующего блока b/);
  fails({ name: 'f', blocks: [{ name: 'a', next: 'end', phases: [phase('p')] }, { name: 'end', phases: [phase('q')] }] }, /не может называться end/);
  // без next блок end, как раньше, допустим
  assert.doesNotThrow(() => validateSpec({ name: 'f', blocks: [{ name: 'a', phases: [phase('p')] }, { name: 'end', phases: [phase('q')] }] }));
  fails(
    { name: 'f', blocks: [{ name: 'a', next: [{ if: { type: 'marker', marker: '<X>' }, goto: 'end' }], phases: [{ ...phase('p'), group: 'g' }, { ...phase('q'), group: 'g' }] }] },
    /кончается параллельной группой g, укажи phase/,
  );
});

test('генератор: схема и JSON Schema блока без flow, input и next — ИИ пишет только блоки этапов', () => {
  const js = flowJsonSchema() as { properties: { blocks: { items: { properties: Record<string, unknown>; required: string[] } } } };
  const item = js.properties.blocks.items;
  assert.deepEqual(Object.keys(item.properties), ['name', 'title', 'loop', 'on_fail', 'knowledge', 'plugins', 'phases']);
  assert.ok(item.required.includes('phases'));
  assert.ok(!JSON.stringify(js).includes('"next"'));
  assert.equal(GeneratedFlowSchema.safeParse({ name: 'f', blocks: [{ name: 'a', flow: 'g' }] }).success, false);
});

const load = (specs: Record<string, string>) => (name: string): FlowSpec => {
  if (!(name in specs)) throw new Error('нет такого flow в flows/');
  return flow(specs[name]);
};
const caller = (name: string, ...calls: string[]) => `name: ${name}\nblocks:\n${calls.map((c, i) => `  - name: b${i}\n    flow: ${c}\n`).join('')}`;
const leaf = (name: string) => `name: ${name}\nphases:\n  - { name: a, tools: [], prompt: x }\n`;

test('граф вызовов: вызываемый flow есть и валиден, без круга и не глубже лимита', () => {
  assert.deepEqual(callProblems(flow(caller('a', 'b', 'c')), load({ b: leaf('b'), c: caller('c', 'b') })), []);
  assert.deepEqual(callProblems(flow(caller('a', 'x')), load({})), ['блок b0: flow x не загружается: нет такого flow в flows/']);
  assert.deepEqual(callProblems(flow(caller('a', 'b')), load({ b: caller('b', 'a') })), ['a → b, блок b0: вызовы замыкаются в круг a → b → a']);
  const bad = 'name: b\nblocks:\n  - name: x\n';
  assert.match(callProblems(flow(caller('a', 'b')), load({ b: bad })).join('\n'), /блок b0: flow b не загружается: [^]*Нужны phases или flow/);
  // CALL_DEPTH_MAX вызовов вглубь — можно, на один больше — нет
  const deep: Record<string, string> = {};
  for (let i = 1; i <= CALL_DEPTH_MAX; i++) deep[`f${i}`] = caller(`f${i}`, `f${i + 1}`);
  deep[`f${CALL_DEPTH_MAX + 1}`] = leaf(`f${CALL_DEPTH_MAX + 1}`);
  assert.deepEqual(callProblems(flow(caller('f0', 'f1')), load({ ...deep, [`f${CALL_DEPTH_MAX}`]: leaf(`f${CALL_DEPTH_MAX}`) })), []);
  assert.match(callProblems(flow(caller('f0', 'f1')), load(deep)).join('\n'), new RegExp(`вызовы глубже ${CALL_DEPTH_MAX} уровней`));
  // один и тот же отсутствующий flow из двух блоков — одна ошибка
  assert.equal(callProblems(flow(caller('a', 'x', 'x')), load({})).length, 1);
});

test('задача вызываемого flow: шаблон input или задача + итог прошлого шага + замечания, пустые разделы не пишутся', () => {
  const ctx = { ...emptyContext('Сделать X', 3), phases: { spec: 'СПЕКА' } };
  assert.equal(callInput({ input: '{{input}} / {{phases.spec}}' }, ctx), 'Сделать X / СПЕКА');
  assert.equal(callInput({}, ctx), 'Сделать X');
  assert.equal(callInput({}, { ...ctx, prev: 'ИТОГ', feedback: '  ' }), 'Сделать X\n\n## Результат предыдущего шага\nИТОГ');
  assert.equal(
    callInput({}, { ...ctx, prev: 'ИТОГ', feedback: 'ЗАМЕЧАНИЯ' }),
    'Сделать X\n\n## Результат предыдущего шага\nИТОГ\n\n## Замечания проверки\nЗАМЕЧАНИЯ',
  );
});

test('развилка: правила по порядку, первое выполненное решает; без совпадения — следующий блок', async () => {
  const spec = flow(`
name: f
blocks:
  - name: triage
    flow: triage
    next:
      - if: { type: marker, marker: "<BUG>" }
        goto: fix
      - if: { type: command, run: "test -f docs" }
        goto: end
  - name: fix
    flow: fix-bug
    next: end
  - name: build
    flow: build
`);
  const blocks = flowBlocks(spec);
  const asked: number[] = [];
  const answer = (yes: number[]) => async (_c: unknown, k: number) => (asked.push(k), yes.includes(k));
  assert.deepEqual(await pickNext(blocks, 0, answer([0])), { to: 1, rule: 0 });
  assert.deepEqual(asked, [0]);
  assert.deepEqual(await pickNext(blocks, 0, answer([1])), { to: 3, rule: 1 });
  assert.deepEqual(await pickNext(blocks, 0, answer([])), { to: 1 });
  // безусловное правило не проверяется
  asked.length = 0;
  assert.deepEqual(await pickNext(blocks, 1, answer([])), { to: 3, rule: 0 });
  assert.deepEqual(asked, []);
  assert.deepEqual(await pickNext(blocks, 2, answer([])), { to: 3 });
});

test('итог вызова: done — успех с выводом последнего шага; группа — склейка; иначе ошибка со статусом дочернего', () => {
  const read = (rel: string) => ({ 'iter-01/01-a.output.md': 'ВЫВОД A', 'iter-01/02-b.output.md': 'ВЫВОД B' })[rel];
  const final = (phase: string, output: string) => ({ block: 'main', iteration: 1, phase, title: phase, ok: true, output });
  const one = callOutcome('child', { id: 'r1', status: 'done', totalCostUsd: 0.5, final: [final('a', 'iter-01/01-a.output.md')] }, read, 1000);
  assert.deepEqual(one, { ok: true, subtype: 'done', text: 'ВЫВОД A', costUsd: 0.5, turns: 0, durationMs: 1000, errors: [] });
  const group = callOutcome('child', { id: 'r1', status: 'done', totalCostUsd: 0, final: [final('a', 'iter-01/01-a.output.md'), final('b', 'iter-01/02-b.output.md')] }, read, 0);
  assert.equal(group.text, '### a\nВЫВОД A\n\n### b\nВЫВОД B');
  const failed = callOutcome('child', { id: 'r2', status: 'max_iterations', error: 'лимит', totalCostUsd: 1, final: [] }, read, 0);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.errors, ['Вызванный flow child завершился статусом max_iterations (запуск r2): лимит']);
});

test('сводка flow: у блока-вызова имя вызываемого flow и нет этапов; развилка словами', () => {
  const spec = flow(`
name: f
blocks:
  - name: triage
    flow: triage
    next:
      - if: { type: marker, marker: "<BUG>" }
        goto: fix
      - goto: build
  - name: fix
    flow: fix-bug
    loop: { max_iterations: 3, until: { type: command, run: npm test } }
    next: end
  - name: build
    phases: [{ name: a, tools: [Read], prompt: x }]
`);
  const s = summarize('f', '', spec);
  assert.deepEqual(s.phases?.map((p) => p.name), ['a']);
  assert.deepEqual(s.blocks?.map((b) => [b.flow, b.phases.length, b.next]), [
    ['triage', 0, 'маркер <BUG> → fix; иначе → build'],
    ['fix-bug', 0, '→ конец'],
    [undefined, 1, undefined],
  ]);
  assert.equal(s.blocks?.[1].condition, 'пока команда `npm test` не вернёт 0');
  assert.equal(describeNext({ next: [{ if: { type: 'judge', prompt: 'p' }, goto: 'end' }] }), 'судья → конец');
});

test('flow без вызовов и next разбирается как раньше: блоки этапов те же объекты', () => {
  const raw = parseYaml('name: f\nblocks:\n  - name: a\n    phases: [{ name: p, tools: [], prompt: x }]\n');
  const spec = validateSpec(raw);
  assert.equal(flowBlocks(spec)[0], spec.blocks![0]);
  assert.deepEqual(spec, raw);
});

test('до подключения в раннер flow с вызовом или next не запускается, остальные — как раньше', () => {
  assert.throws(() => assertRunnable(flow(chain)), /раннер пока не исполняет вызов flow \(блоки spec, implement, review\)/);
  assert.throws(() => assertRunnable(flow('name: n\nblocks:\n  - name: a\n    next: end\n    phases: [{ name: p, tools: [], prompt: x }]\n')), /развилку next \(блоки a\)/);
  assert.doesNotThrow(() => assertRunnable(flow('name: n\nphases: [{ name: p, tools: [], prompt: x }]\n')));
});
