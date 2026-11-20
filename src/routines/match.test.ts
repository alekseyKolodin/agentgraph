// Поля события для примера в редакторе (eventFields): ключи — те же пути, что принимает matchRule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventFields, explainMatch, matchConditions, matchRule } from './match.js';
import { parseRoutineYaml, toYaml } from './schema.js';
import type { RoutineEvent, RoutineSpec } from './types.js';

const event = (fields: Record<string, unknown>): RoutineEvent => ({ source: 's', id: '1', at: '2026-11-19T10:00:00.000Z', title: 'Заголовок', text: 'текст', fields });

test('поля события: вложенные объекты — путём через точку, типы по значению', () => {
  const f = eventFields(event({ channel: 'bugs', count: 3, draft: false, user: { name: 'Аня', team: { id: 7 } } }));
  assert.deepEqual(f, [
    { key: 'channel', type: 'text', value: 'bugs' },
    { key: 'count', type: 'number', value: '3' },
    { key: 'draft', type: 'bool', value: 'false' },
    { key: 'user.name', type: 'text', value: 'Аня' },
    { key: 'user.team.id', type: 'number', value: '7' },
  ]);
});

test('поля события: список — одно поле, пустые значения не показываются', () => {
  const f = eventFields(event({ labels: ['bug', 'urgent'], people: [{ name: 'Аня' }], empty: [], none: null, blank: '', obj: {} }));
  assert.deepEqual(f, [
    { key: 'labels', type: 'text', value: 'bug, urgent', list: true },
    { key: 'people', type: 'text', value: '[{"name":"Аня"}]', list: true },
  ]);
});

test('поля события: ключ из примера работает в условии как есть', () => {
  const e = event({ title: 'из сервиса', labels: ['bug'], people: [{ name: 'Аня' }], user: { name: 'Аня' }, count: 3, draft: true });
  const byKey = new Map(eventFields(e).map((f) => [f.key, f]));
  // поле с именем верхнего поля события получает префикс: без него условие смотрело бы на заголовок события
  assert.equal(byKey.get('fields.title')?.value, 'из сервиса');
  assert.equal(byKey.has('title'), false);
  assert.equal(matchRule({ 'fields.title': 'из сервиса' }, e).ok, true);
  assert.equal(matchRule({ labels: 'bug' }, e).ok, true);
  assert.equal(matchRule({ 'people~': 'аня' }, e).ok, true);
  assert.equal(matchRule({ 'user.name': byKey.get('user.name')!.value }, e).ok, true);
  assert.equal(matchRule({ count: byKey.get('count')!.value }, e).ok, true);
  assert.equal(matchRule({ draft: byKey.get('draft')!.value }, e).ok, true);
});

test('поля события: длинное значение обрезается, глубокий объект остаётся одним полем, полей не больше предела', () => {
  const long = eventFields(event({ body: 'я'.repeat(500) }));
  assert.equal(long[0]!.value.length, 200);
  assert.ok(long[0]!.value.endsWith('…'));
  const deep = eventFields(event({ a: { b: { c: { d: { e: { f: 1 } } } } } }));
  assert.deepEqual(deep, [{ key: 'a.b.c.d', type: 'text', value: '{"e":{"f":1}}' }]);
  const many = eventFields(event(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))));
  assert.equal(many.length, 60);
  assert.deepEqual(eventFields(event({ 'a.b': 1 })), []);
});

test('условия списком: два «≠» на одно поле работают оба', () => {
  const rule = [
    { field: 'title', op: 'ne' as const, value: 'A' },
    { field: 'title', op: 'ne' as const, value: 'B' },
  ];
  assert.equal(matchRule(rule, { ...event({}), title: 'A' }).ok, false);
  assert.equal(matchRule(rule, { ...event({}), title: 'B' }).ok, false);
  assert.equal(matchRule(rule, { ...event({}), title: 'C' }).ok, true);
  // «≠» со списком — ни одно из
  assert.equal(matchRule([{ field: 'title', op: 'ne', value: ['A', 'B'] }], { ...event({}), title: 'b' }).ok, false);
});

test('старый словарь читается как раньше и даёт тот же список условий', () => {
  const e = event({ channel: 'bugs', duration: 40 });
  const old = { channel: ['qa', 'bugs'], 'title~': 'заголов', 'author!': 'bot', 'duration>': 30, 'duration<': 60 };
  assert.equal(matchRule(old, e).ok, true);
  assert.deepEqual(matchConditions(old), [
    { field: 'channel', op: 'eq', value: ['qa', 'bugs'] },
    { field: 'title', op: 'contains', value: 'заголов' },
    { field: 'author', op: 'ne', value: 'bot' },
    { field: 'duration', op: 'gt', value: 30 },
    { field: 'duration', op: 'lt', value: 60 },
  ]);
  assert.equal(matchRule({ ...old, 'duration>': 50 }, e).reason, 'duration: «40» не больше «50»');
});

test('режим any: хватает одного условия; не прошло ни одно — в причине все', () => {
  const rule = [
    { field: 'channel', value: 'qa' },
    { field: 'title', op: 'contains' as const, value: 'заголов' },
  ];
  const e = event({ channel: 'bugs' });
  assert.equal(matchRule(rule, e).ok, false);
  assert.equal(matchRule(rule, e, 'any').ok, true);
  const no = matchRule([{ field: 'channel', value: 'qa' }, { field: 'title', value: 'x' }], e, 'any');
  assert.equal(no.ok, false);
  assert.equal(no.reason, 'ни одно условие не прошло: channel: «bugs» не равно «qa»; title: «Заголовок» не равно «x»');
  assert.equal(matchRule([], e, 'any').ok, true);
});

test('пустое условие (без значения или поля) не применяется и не отсеивает всё подряд', () => {
  const e = event({ channel: 'bugs' });
  const rule = [
    { field: 'channel', value: 'bugs' },
    { field: 'title', op: 'ne' as const, value: '' },
    { field: 'author', value: [] },
    { field: ' ', value: 'x' },
  ];
  assert.equal(matchConditions(rule).length, 1);
  assert.equal(matchRule(rule, e).ok, true);
  assert.equal(matchRule(rule, e, 'any').ok, true);
  assert.equal(explainMatch(rule, e).length, 1);
  // ложь и ноль — значения, а не пустота
  assert.equal(matchConditions([{ field: 'draft', value: false }, { field: 'n', value: 0 }]).length, 2);
});

test('правило с условиями списком и notify проходит схему и переживает YAML', () => {
  const spec: RoutineSpec = {
    title: 'Р',
    when: { source: 'src', match: [{ field: 'title', op: 'ne', value: 'A' }, { field: 'title', op: 'ne', value: 'B' }], match_mode: 'any' },
    run: { flow: 'demo' },
    mode: 'auto',
    notify: { os: ['start', 'fail'] },
  };
  const back = parseRoutineYaml(toYaml(spec));
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.spec, spec);
  // старый словарь в файле по-прежнему проходит схему
  assert.deepEqual(parseRoutineYaml('title: Р\nwhen:\n  source: src\n  match:\n    title~: баг\n    author!: bot\nrun:\n  flow: demo\nmode: auto\n').problems, []);
  assert.ok(parseRoutineYaml('title: Р\nwhen:\n  source: src\n  match:\n    - field: title\n      op: like\n      value: x\nrun:\n  flow: demo\nmode: auto\n').problems.length);
  assert.ok(parseRoutineYaml('title: Р\nwhen:\n  source: src\nrun:\n  flow: demo\nmode: auto\nnotify:\n  os: [later]\n').problems.length);
});
