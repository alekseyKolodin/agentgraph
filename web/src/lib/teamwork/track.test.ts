import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptRest, applyDecisions, attachNotes, decisionText, draftTitle, editLabel, foldText, lcsOps, lineDiff, markConflicts, nextUnresolved, parseBlocks, serializeBlocks,
  stepEdit, trackChanges, wordDiff,
} from './track';

const OLD = `# Экспорт счетов

## Цель и проблема

Бухгалтерия собирает счета руками.

## Требования

- FR-1. Выгрузка счетов за выбранный период в CSV. Период включает обе границы.
- FR-2. Колонки и их порядок — как в шаблоне бухгалтерии docs/columns.md.
- FR-3. Кодировка файла — UTF-8.
- FR-7. Фильтр по контрагенту: один или несколько.

## Нефункциональные требования

- NFR-1. Месяц выгружается быстрее 10 секунд.

## Вне рамок

- Выгрузка в XLSX.
- Правка счетов из выгрузки.

## Открытые вопросы

- Кому уходит письмо с выгрузкой по расписанию: один адрес или список?
`;

const NEXT = OLD
  .replace('- FR-3. Кодировка файла — UTF-8.', '- FR-3. Кодировка на выбор в форме: CP1251 для 1С, UTF-8 с BOM для Excel.')
  .replace('- FR-7. Фильтр по контрагенту: один или несколько.\n', '- FR-7. Фильтр по контрагенту: один или несколько.\n- FR-8. Журнал выгрузок: кто, когда и за какой период выгружал. Видит роль «Админ».\n')
  .replace('- Выгрузка в XLSX.', '- Выгрузка в XLSX и загрузка в 1С через API: отдаём только файл.')
  .replace('один адрес или список?\n', 'один адрес или список?\n- Сколько хранить журнал выгрузок: 12 месяцев или дольше?\n');

test('правки: блоки markdown складываются обратно без потерь — заголовки, абзацы, пункты с продолжением, требования, код, таблица', () => {
  const md = '\n\n# Заголовок\nАбзац сразу под заголовком\nвторая строка.\n\n- пункт\n  продолжение\n- FR-1. Требование\n\n```md\n## не раздел\n\n- не пункт\n```\n\n| a | b |\n|---|---|\n\n---\n\nХвост';
  const doc = parseBlocks(md);
  assert.deepEqual(doc.lead, ['', '']);
  assert.deepEqual(doc.blocks.map((b) => b.kind), ['heading', 'paragraph', 'item', 'requirement', 'code', 'other', 'other', 'paragraph']);
  assert.deepEqual(doc.blocks[2]!.lines, ['- пункт', '  продолжение']);
  assert.equal(doc.blocks[3]!.requirement, 'FR-1');
  assert.equal(doc.blocks[0]!.title, 'Заголовок');
  assert.equal(doc.blocks[0]!.content, 'Заголовок');
  assert.equal(doc.blocks[2]!.content, 'пункт\nпродолжение');
  assert.equal(doc.blocks[3]!.content, 'Требование');
  assert.equal(doc.blocks[0]!.level, 1);
  assert.equal(serializeBlocks(doc), md);
  assert.equal(serializeBlocks(parseBlocks(OLD)), OLD);
  assert.equal(serializeBlocks(parseBlocks('')), '');
  assert.equal(serializeBlocks(parseBlocks('```\nнезакрытая ограда\n')), '```\nнезакрытая ограда\n');
});

test('правки: LCS — общий префикс и суффикс, середина по таблице; дифф по словам с чисткой одиночных общих слов', () => {
  assert.deepEqual(lcsOps([1, 2, 3, 4], [1, 3, 4, 5]), ['same', 'del', 'same', 'same', 'ins']);
  assert.deepEqual(lcsOps([], [1]), ['ins']);
  assert.deepEqual(lcsOps(['a'], ['a']), ['same']);
  assert.deepEqual(wordDiff('Кодировка файла — UTF-8.', 'Кодировка на выбор в форме: CP1251 для 1С, UTF-8 с BOM для Excel.'), [
    { kind: 'same', text: 'Кодировка' },
    { kind: 'del', text: 'файла — UTF-8.' },
    { kind: 'ins', text: 'на выбор в форме: CP1251 для 1С, UTF-8 с BOM для Excel.' },
  ]);
  assert.deepEqual(wordDiff('Выгрузка в XLSX.', 'Выгрузка в XLSX и загрузка в 1С через API: отдаём только файл.'), [
    { kind: 'same', text: 'Выгрузка в' },
    { kind: 'del', text: 'XLSX.' },
    { kind: 'ins', text: 'XLSX и загрузка в 1С через API: отдаём только файл.' },
  ]);
  assert.deepEqual(wordDiff('a b c', 'a b c'), [{ kind: 'same', text: 'a b c' }]);
  assert.deepEqual(wordDiff('', 'a'), [{ kind: 'ins', text: 'a' }]);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd'), [{ kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'same', text: 'c' }, { kind: 'ins', text: 'd' }]);
});

test('правки: дифф документа по блокам — изменённое требование, новое требование, пункт списка, добавленный вопрос; разделы и счётчики', () => {
  const doc = trackChanges(OLD, NEXT);
  assert.equal(doc.total, 4);
  assert.equal(doc.progress, 'решено 0 из 4');
  assert.deepEqual(doc.edits.map((e) => [e.n, e.kind, e.block, e.section, e.requirement]), [
    [1, 'changed', 'requirement', 'Требования', 'FR-3'],
    [2, 'added', 'requirement', 'Требования', 'FR-8'],
    [3, 'changed', 'item', 'Вне рамок', undefined],
    [4, 'added', 'item', 'Открытые вопросы', undefined],
  ]);
  assert.equal(doc.edits[0]!.words![0]!.text, 'Кодировка');
  assert.equal(doc.edits[0]!.oldContent, 'Кодировка файла — UTF-8.');
  assert.equal(doc.edits[2]!.words![1]!.text, 'XLSX.');
  assert.equal(doc.edits[3]!.nextContent, 'Сколько хранить журнал выгрузок: 12 месяцев или дольше?');
  assert.equal(doc.edits[1]!.next, '- FR-8. Журнал выгрузок: кто, когда и за какой период выгружал. Видит роль «Админ».');
  assert.deepEqual(doc.sections.map((s) => [s.heading, s.edits.length, s.unresolved]), [
    ['', 0, 0], ['Цель и проблема', 0, 0], ['Требования', 2, 2], ['Нефункциональные требования', 0, 0], ['Вне рамок', 1, 1], ['Открытые вопросы', 1, 1],
  ]);
  const req = doc.sections[2]!;
  assert.deepEqual(req.rows.map((r) => (r.kind === 'same' ? r.requirement ?? r.block : `edit:${r.edit.kind}`)), ['heading', 'FR-1', 'FR-2', 'edit:changed', 'FR-7', 'edit:added']);
  const decided = trackChanges(OLD, NEXT, [], { [doc.edits[0]!.id]: 'accept' });
  assert.equal(decided.resolved, 1);
  assert.equal(decided.sections[2]!.unresolved, 1);
  assert.equal(trackChanges(OLD, OLD).total, 0);
  assert.equal(foldText(['Цель и проблема', 'Для кого']), 'Цель и проблема, Для кого — без правок');
});

test('правки: удалённое требование и новое с другим номером — две правки, не замена; удалённый заголовок остаётся в текущем разделе', () => {
  const old = '## A\n\n- FR-1. Один.\n- FR-2. Два.\n\n## B\n\nТекст.\n';
  const next = '## A\n\n- FR-1. Один.\n- FR-3. Три.\n\nТекст.\n';
  const doc = trackChanges(old, next);
  assert.deepEqual(doc.edits.map((e) => [e.kind, e.requirement ?? e.block, e.section]), [['removed', 'FR-2', 'A'], ['added', 'FR-3', 'A'], ['removed', 'heading', 'A']]);
  const renamed = trackChanges('## A\n\nТекст.\n', '## B\n\nТекст.\n');
  assert.deepEqual(renamed.edits.map((e) => [e.kind, e.section]), [['changed', 'B']]);
  assert.deepEqual(renamed.sections.map((s) => s.heading), ['B']);
});

test('правки: причины из notes.json — по номеру требования, по заголовку раздела (и с «##»), лишние пропадают', () => {
  const doc = trackChanges(OLD, NEXT, [
    { at: 'FR-3', why: 'Вы ответили агенту: 1С ждёт CP1251.' },
    { at: 'fr-8', why: 'Из задания: журнал выгрузок.' },
    { at: '## Вне рамок', why: 'Уточняет FR-3.' },
    { at: 'Открытые вопросы', why: 'Срока хранения журнала нет.' },
    { at: 'Открытые вопросы', why: 'Вторая причина к тому же.' },
    { at: 'Нет такого раздела', why: 'пропадёт' },
    { at: 'FR-1', why: 'правки нет — пропадёт' },
  ]);
  assert.deepEqual(doc.edits.map((e) => e.why), ['Вы ответили агенту: 1С ждёт CP1251.', 'Из задания: журнал выгрузок.', 'Уточняет FR-3.', 'Срока хранения журнала нет. Вторая причина к тому же.']);
  assert.deepEqual(attachNotes(doc.edits.map((e) => ({ ...e, why: undefined })), []).map((e) => e.why), [undefined, undefined, undefined, undefined]);
  const byDoc = trackChanges(OLD, NEXT, [{ at: 'FR-3', why: 'про дизайн', doc: 'design' }, { at: 'FR-8', why: 'про архитектуру', doc: 'architecture' }, { at: 'Вне рамок', why: 'общая' }], {}, 'architecture');
  assert.deepEqual(byDoc.edits.map((e) => e.why), [undefined, 'про архитектуру', 'общая', undefined]);
});

test('правки: applyDecisions — нерешённые и отклонённые дают старый текст, принятые новый; всё принято — новый документ', () => {
  const doc = trackChanges(OLD, NEXT);
  const ids = doc.edits.map((e) => e.id);
  assert.equal(applyDecisions(OLD, NEXT, {}), OLD);
  assert.equal(applyDecisions(OLD, NEXT, Object.fromEntries(ids.map((id) => [id, 'reject' as const]))), OLD);
  assert.equal(applyDecisions(OLD, NEXT, acceptRest(doc.edits, {})), NEXT);
  const partial = applyDecisions(OLD, NEXT, { [ids[0]!]: 'accept', [ids[3]!]: 'accept' });
  assert.ok(partial.includes('- FR-3. Кодировка на выбор в форме'));
  assert.ok(!partial.includes('FR-8'));
  assert.ok(partial.includes('- Выгрузка в XLSX.\n'));
  assert.ok(partial.includes('Сколько хранить журнал'));
  assert.equal(applyDecisions(OLD, OLD, {}), OLD);
  assert.equal(applyDecisions('', 'Новый.\n', acceptRest(trackChanges('', 'Новый.\n').edits, {})), 'Новый.\n');
});

test('правки: между блоками из разных документов без пустой строки она добавляется, у пунктов списка — нет', () => {
  const all = (o: string, n: string) => applyDecisions(o, n, acceptRest(trackChanges(o, n).edits, {}));
  assert.equal(all('Абзац', 'Абзац\n\nВторой\n'), 'Абзац\n\nВторой\n');
  assert.equal(all('- один', '- один\n- два\n'), '- один\n- два\n');
  assert.equal(all('## A\n\nСтарый.\n\n## B\n', '## A\n\nНовый.\n\n## B\n'), '## A\n\nНовый.\n\n## B\n');
});

test('правки: id устойчивы — одинаковые при перерасчёте и после записи части правок; дубли различаются', () => {
  const a = trackChanges(OLD, NEXT);
  const b = trackChanges(OLD, NEXT);
  assert.deepEqual(a.edits.map((e) => e.id), b.edits.map((e) => e.id));
  const first = a.edits[0]!.id;
  const written = applyDecisions(OLD, NEXT, { [first]: 'accept' });
  const rest = trackChanges(written, NEXT);
  assert.deepEqual(rest.edits.map((e) => e.id), a.edits.slice(1).map((e) => e.id));
  const dup = trackChanges('- a\n- a\n', '- b\n- b\n');
  assert.equal(dup.edits.length, 2);
  assert.notEqual(dup.edits[0]!.id, dup.edits[1]!.id);
  assert.equal(dup.edits[1]!.id, `${dup.edits[0]!.id}-2`);
});

test('правки: переходы, «принять остальные», конфликты с изменённым документом, подписи', () => {
  const doc = trackChanges(OLD, NEXT);
  const [e1, e2, e3, e4] = doc.edits as [typeof doc.edits[0], typeof doc.edits[0], typeof doc.edits[0], typeof doc.edits[0]];
  assert.equal(stepEdit(doc.edits, undefined, 1)?.id, e1.id);
  assert.equal(stepEdit(doc.edits, undefined, -1)?.id, e4.id);
  assert.equal(stepEdit(doc.edits, e4.id, 1)?.id, e1.id);
  assert.equal(stepEdit(doc.edits, e1.id, -1)?.id, e4.id);
  assert.equal(stepEdit([], undefined, 1), undefined);
  assert.equal(nextUnresolved(doc.edits, { [e1.id]: 'accept', [e2.id]: 'reject' })?.id, e3.id);
  assert.equal(nextUnresolved(doc.edits, { [e3.id]: 'accept' }, e2.id)?.id, e4.id);
  assert.equal(nextUnresolved(doc.edits, acceptRest(doc.edits, {})), undefined);
  assert.deepEqual(acceptRest(doc.edits, { [e2.id]: 'reject' }), { [e1.id]: 'accept', [e2.id]: 'reject', [e3.id]: 'accept', [e4.id]: 'accept' });
  const current = OLD.replace('- FR-3. Кодировка файла — UTF-8.', '- FR-3. Кодировка файла — UTF-8 с BOM.');
  assert.deepEqual(markConflicts(doc.edits, current).map((e) => Boolean(e.conflict)), [true, false, false, false]);
  assert.equal(editLabel(e1, 4), '1 из 4');
  assert.equal(decisionText('accept'), 'принято');
  assert.equal(decisionText(undefined), '');
  assert.equal(draftTitle(4), 'Черновик агента: 4 правки');
  assert.equal(draftTitle(1), 'Черновик агента: 1 правка');
});
