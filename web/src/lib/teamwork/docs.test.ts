import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addRequirementRow, changesText, coverage, currentSection, docFile, docHeadLine, docLabel, docTitle, findRefs, moveRequirementRow, nextRequirementId, parseRequirementId,
  parseRequirementRows, parseRequirements, proposalCoverage, readingMinutes, relativeDay, removeRequirementRow, requirementShort, sectionCommitMessage,
  serializeRequirementRows, splitRefs, splitSections, tocOf, updatedText,
} from './docs';
import { task } from './fixtures';

const PRD = `# Экспорт счетов

Вступление.

## Цель и проблема

Бухгалтерия собирает счета руками.

## Требования

Вводная строка.

- FR-1. Выгрузка счетов за выбранный период в CSV. Период включает обе границы.
- FR-2. Колонки и их порядок — как в шаблоне docs/columns.md.
- FR-4. Пустой период даёт файл только со строкой заголовков,
  а не ошибку.

Примечание после списка.

## Нефункциональные требования

- NFR-1. Месяц выгружается быстрее 10 секунд.
- NFR-2: с двоеточием — не требование, как на сервере.

\`\`\`md
## Не раздел
- FR-99. Не требование
\`\`\`

## Открытые вопросы ##

- Кому уходит письмо?
`;

test('документы: разделы по «## » вне оград кода, вступление без заголовка, тело без строки заголовка', () => {
  const s = splitSections(PRD);
  assert.deepEqual(s.map((x) => x.heading), ['', 'Цель и проблема', 'Требования', 'Нефункциональные требования', 'Открытые вопросы']);
  assert.equal(s[0]!.start, 0);
  assert.equal(s[1]!.text.split('\n')[0], '## Цель и проблема');
  assert.equal(s[1]!.body.trim(), 'Бухгалтерия собирает счета руками.');
  assert.ok(s[3]!.text.includes('## Не раздел'), 'ограда кода остаётся внутри раздела');
  assert.equal(splitSections(PRD).map((x) => x.text).join('\n'), PRD, 'разделы складываются обратно в документ');
  assert.deepEqual(splitSections('').length, 0);
  assert.deepEqual(splitSections('## A\n## B').map((x) => x.heading), ['A', 'B']);
  assert.equal(docTitle(PRD), 'Экспорт счетов');
  assert.equal(docTitle('## A'), '');
});

test('документы: требования FR-N и NFR-N с разделом, не из оград кода; следующий номер не меньше последнего выданного', () => {
  const reqs = parseRequirements(PRD);
  assert.deepEqual(reqs.map((r) => r.id), ['FR-1', 'FR-2', 'FR-4', 'NFR-1'], 'только точка после номера, как на сервере');
  assert.equal(reqs[0]!.section, 'Требования');
  assert.equal(reqs[3]!.section, 'Нефункциональные требования');
  assert.equal(reqs[2]!.text, 'Пустой период даёт файл только со строкой заголовков,');
  assert.equal(nextRequirementId(PRD, 'FR'), 'FR-5');
  assert.equal(nextRequirementId(reqs, 'NFR'), 'NFR-2');
  assert.equal(nextRequirementId(PRD, 'FR', 7), 'FR-8', 'удалённые номера не переиспользуются');
  assert.equal(nextRequirementId('', 'FR'), 'FR-1');
  assert.deepEqual(parseRequirementId('nfr-12'), { kind: 'NFR', n: 12 });
  assert.equal(parseRequirementId('PAY-12'), undefined);
});

test('документы: оглавление с подпунктами требований и короткими подписями; текущий раздел по прокрутке', () => {
  const toc = tocOf(PRD);
  assert.deepEqual(toc.map((x) => [x.heading, x.count]), [['Цель и проблема', undefined], ['Требования', 3], ['Нефункциональные требования', 1], ['Открытые вопросы', undefined]]);
  assert.deepEqual(toc[1]!.items.map((i) => i.id), ['FR-1', 'FR-2', 'FR-4']);
  assert.equal(requirementShort('Выгрузка счетов за выбранный период в CSV. Период включает обе границы.'), 'Выгрузка счетов за выбранный период в CSV');
  assert.equal(requirementShort('Кодировка на выбор в форме: CP1251 для 1С, UTF-8 с BOM для Excel.'), 'Кодировка на выбор в форме');
  assert.equal(requirementShort('Очень длинное требование без знаков препинания которое надо обрезать по слову', 30), 'Очень длинное требование без…');
  assert.equal(currentSection([{ heading: 'A', top: 0 }, { heading: 'B', top: 100 }, { heading: 'C', top: 200 }], 150), 'B');
  assert.equal(currentSection([{ heading: 'A', top: 50 }], 0), 'A');
});

test('документы: покрытие требований задачами — «Задачи есть у N из M», список без задач; покрытие предложением', () => {
  const reqs = parseRequirements(PRD);
  const tasks = [task({ id: 'PAY-1', covers: ['FR-1', 'FR-2'] }), task({ id: 'PAY-2', covers: ['FR-1', 'FR-77'] })];
  const c = coverage(reqs, tasks);
  assert.equal(c.text, 'Задачи есть у 2 из 4 требований');
  assert.equal(c.missingText, 'FR-4, NFR-1 без задач');
  assert.deepEqual(c.byReq.get('FR-1')!.map((x) => x.id), ['PAY-1', 'PAY-2']);
  assert.equal(coverage(reqs, [task({ id: 'a', covers: ['FR-1', 'FR-2', 'FR-4', 'NFR-1'] })]).missingText, '');
  assert.equal(coverage([reqs[0]!], []).text, 'Задачи есть у 0 из 1 требования');
  const p = proposalCoverage(reqs, [{ covers: ['FR-4'] }], tasks);
  assert.deepEqual(p.items.map((i) => i.state), ['existing', 'existing', 'proposed', 'none']);
  assert.equal(p.text, 'Новые задачи покрывают FR-4 · NFR-1 остаётся без задач');
  assert.equal(proposalCoverage(reqs, [{ covers: ['FR-4', 'NFR-1'] }], tasks).text, 'Новые задачи покрывают FR-4, NFR-1');
  assert.equal(proposalCoverage(reqs, [], tasks).text, 'Новые задачи не покрывают требований · FR-4, NFR-1 остаются без задач');
});

test('документы: шапка — файл, кто и когда менял, требования, время чтения', () => {
  const now = new Date('2026-11-12T12:00:00');
  assert.equal(relativeDay('2026-11-12T08:00:00', now), 'сегодня');
  assert.equal(relativeDay('2026-11-11T23:00:00', now), 'вчера');
  assert.match(relativeDay('2026-10-01T10:00:00', now), /01\.10/);
  const members = [{ name: 'Мария Серова', email: 'maria@x.io' }];
  assert.equal(updatedText({ updatedAt: '2026-11-11T10:00:00', updatedBy: 'maria@x.io' }, members, now), 'обновлено вчера, Мария');
  assert.equal(updatedText({ updatedAt: '2026-11-12T10:00:00', updatedBy: 'guest@y.io' }, members, now), 'обновлено сегодня, guest');
  assert.equal(updatedText({}, members, now), '');
  assert.equal(readingMinutes('раз два три'), 1);
  assert.equal(readingMinutes(Array(720).fill('слово').join(' ')), 4);
  assert.equal(docHeadLine({ name: 'prd', text: PRD, updatedAt: '2026-11-11T10:00:00', updatedBy: 'maria@x.io' }, members, now), 'prd.md · обновлено вчера, Мария · 4 требования · ≈1 мин чтения');
  assert.equal(docHeadLine({ name: 'docs/notes.md', text: 'текст' }, [], now), 'docs/notes.md · ≈1 мин чтения');
  assert.equal(docFile('architecture'), 'architecture.md');
  assert.equal(docLabel('prd'), 'ТЗ');
  assert.equal(docLabel('docs/1c-format.md'), '1c-format.md');
});

test('документы: правка раздела требований строками — туда и обратно без потерь, добавить, убрать, переставить', () => {
  const body = splitSections(PRD)[2]!.body;
  const parts = parseRequirementRows(body);
  assert.deepEqual(parts.intro, ['', 'Вводная строка.', '']);
  assert.deepEqual(parts.rows.map((r) => r.id), ['FR-1', 'FR-2', 'FR-4']);
  assert.equal(parts.rows[2]!.text, 'Пустой период даёт файл только со строкой заголовков, а не ошибку.');
  assert.deepEqual(parts.outro, ['', 'Примечание после списка.', '']);
  const plain = '\nВводная строка.\n\n- FR-1. Один.\n- FR-2. Два.\n\nПримечание после списка.\n';
  assert.equal(serializeRequirementRows(parseRequirementRows(plain)), plain, 'раздел без переносов внутри строк не меняется');
  const added = addRequirementRow(parts, 'FR', parseRequirements(PRD), 7);
  assert.equal(added.id, 'FR-8');
  assert.deepEqual(added.parts.rows.at(-1), { id: 'FR-8', text: '' });
  assert.deepEqual(removeRequirementRow(parts, 'FR-2').rows.map((r) => r.id), ['FR-1', 'FR-4']);
  assert.deepEqual(moveRequirementRow(parts, 2, 0).rows.map((r) => r.id), ['FR-4', 'FR-1', 'FR-2']);
  assert.deepEqual(moveRequirementRow(parts, 9, 0).rows.map((r) => r.id), ['FR-1', 'FR-2', 'FR-4']);
  assert.equal(parseRequirementRows('').rows.length, 0);
  assert.equal(sectionCommitMessage('prd', 'Требования'), 'ТЗ: Требования');
  assert.equal(changesText(1, 'ТЗ: Требования'), '1 изменение · уйдёт коммитом «ТЗ: Требования»');
});

test('документы: ссылки в тексте — номера задач и требований, пути документов', () => {
  const text = 'См. PAY-12 и FR-3, NFR-1; шаблон docs/columns.md, ТЗ prd.md. Не PAYX-1, не APAY-2, не FR-3a.';
  assert.deepEqual(findRefs(text, 'PAY').map((r) => [r.kind, r.text]), [['task', 'PAY-12'], ['requirement', 'FR-3'], ['requirement', 'NFR-1'], ['doc', 'docs/columns.md'], ['doc', 'prd.md']]);
  assert.deepEqual(findRefs('FR-1', '').map((r) => r.kind), ['requirement']);
  const parts = splitRefs('a PAY-1 b', 'PAY');
  assert.deepEqual(parts.map((p) => [p.kind, p.text]), [['text', 'a '], ['task', 'PAY-1'], ['text', ' b']]);
  assert.deepEqual(splitRefs('', 'PAY'), []);
});
