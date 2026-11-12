import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFailed, draftLine, draftStopText, rowsLossless, draftResult, draftRunning, isDocEmpty, isReqSection, lastIssued, latestDraftFor, merge3, readChunks, refTarget, reqKindFor, rowChanges, taskWhere,
  wrapMark,
} from './doc-view';
import { applyDecisions, trackChanges } from './track';
import { updatedText } from './docs';
import type { TeamDraft } from '@server/api-types';

const DOC = `# ТЗ: Экспорт

## Цель

Бухгалтерия собирает счета руками.

## Требования

- FR-1. Выгрузка за период.
- FR-2. Колонки по шаблону.

## Вне рамок

- XLSX.
`;

test('куски раздела: markdown и строки требований подряд, продолжение с отступом, пустые строки группу не рвут', () => {
  const body = 'Вступление.\n\n- FR-1. Выгрузка\n  за период.\n\n- FR-2. Колонки.\n\nХвост раздела.\n\n- обычный пункт';
  assert.deepEqual(readChunks(body), [
    { kind: 'md', text: 'Вступление.\n' },
    { kind: 'reqs', rows: [{ id: 'FR-1', text: 'Выгрузка за период.' }, { id: 'FR-2', text: 'Колонки.' }] },
    { kind: 'md', text: '\nХвост раздела.\n\n- обычный пункт' },
  ]);
  // в архитектуре требований нет: весь раздел — markdown; строка требования в ограде кода — тоже код
  assert.deepEqual(readChunks('- FR-1. x', false), [{ kind: 'md', text: '- FR-1. x' }]);
  assert.deepEqual(readChunks('```\n- FR-1. x\n```'), [{ kind: 'md', text: '```\n- FR-1. x\n```' }]);
  assert.deepEqual(readChunks('\n\n'), []);
});

test('пустой документ: только заголовки заготовки; текст в любом разделе — уже не пустой', () => {
  assert.equal(isDocEmpty('# ТЗ: Экспорт\n\nСуть\n\n## Цель\n\n## Требования\n'), true);
  assert.equal(isDocEmpty(DOC), false);
  assert.equal(isDocEmpty(''), true);
  assert.equal(isDocEmpty('# Заметки\n'), true);
  assert.equal(isDocEmpty('# Заметки\n\nвстреча'), false);
});

test('раздел требований и вид нового номера: по последней строке, без строк — по заголовку; последний выданный номер', () => {
  assert.equal(isReqSection('Требования', ''), true);
  assert.equal(isReqSection('Цель', 'текст'), false);
  assert.equal(isReqSection('Прочее', '- NFR-2. быстро'), true);
  assert.equal(reqKindFor('Требования', []), 'FR');
  assert.equal(reqKindFor('Нефункциональные требования', []), 'NFR');
  assert.equal(reqKindFor('Требования', [{ id: 'FR-1' }, { id: 'NFR-3' }]), 'NFR');
  assert.equal(lastIssued({ FR: 'FR-9', NFR: 'NFR-1' }, 'FR'), 8);
  assert.equal(lastIssued({ FR: 'FR-9', NFR: 'NFR-1' }, 'NFR'), 0);
  assert.equal(lastIssued(undefined, 'FR'), undefined);
});

test('задача на полях: бэклог, спринт не активный, статус по названию колонки команды, готово — ok', () => {
  const sprints = [{ number: 2, status: 'active' as const }, { number: 3, status: 'planned' as const }];
  const columns = { todo: 'К работе', in_progress: 'В работе', review: 'Ревью', done: 'Готово' };
  assert.deepEqual(taskWhere({ status: 'todo' }, sprints, columns), { text: 'бэклог', tone: '' });
  assert.deepEqual(taskWhere({ status: 'todo', sprint: 3 }, sprints, columns), { text: 'спринт 3', tone: '' });
  assert.deepEqual(taskWhere({ status: 'review', sprint: 2 }, sprints, columns), { text: 'ревью', tone: '' });
  assert.deepEqual(taskWhere({ status: 'done', sprint: 1 }, sprints, columns), { text: 'готово', tone: 'ok' });
  assert.deepEqual(taskWhere({ status: 'in_progress', sprint: 2 }, sprints), { text: 'в работе', tone: '' });
});

test('ссылки из текста: задача — панель, требование — якорь в ТЗ или вкладка ТЗ, документ — его вкладка или docs/', () => {
  assert.deepEqual(refTarget({ kind: 'task', text: 'PAY-12' }, 'prd'), { kind: 'task', id: 'PAY-12' });
  assert.deepEqual(refTarget({ kind: 'requirement', text: 'FR-3' }, 'prd'), { kind: 'req', id: 'FR-3' });
  assert.deepEqual(refTarget({ kind: 'requirement', text: 'NFR-1' }, 'architecture'), { kind: 'req', id: 'NFR-1', tab: 'prd' });
  assert.deepEqual(refTarget({ kind: 'doc', text: 'design.md' }, 'prd'), { kind: 'doc', tab: 'design' });
  assert.deepEqual(refTarget({ kind: 'doc', text: 'docs/columns.md' }, 'prd'), { kind: 'doc', tab: 'docs', name: 'docs/columns.md' });
});

test('черновики документа: идёт, ждёт ответа, готов, не получился; последний — по документу, разбивка не в счёт', () => {
  assert.equal(draftRunning('waiting'), true);
  assert.equal(draftRunning('done'), false);
  assert.equal(draftFailed('failed'), true);
  assert.equal(draftFailed('done'), false);
  assert.equal(draftFailed('running'), false);
  assert.deepEqual(draftLine({ status: 'running' }), { text: 'Черновик идёт', tone: 'live' });
  assert.deepEqual(draftLine({ status: 'waiting', section: 'Требования' }), { text: 'Черновик ждёт вашего ответа · раздел «Требования»', tone: 'wait' });
  assert.equal(draftLine({ status: 'done' }).tone, 'ok');
  assert.deepEqual(draftLine({ status: 'interrupted' }), { text: 'Черновик не получился: agentgraph остановили, пока он шёл', tone: 'fail' });
  assert.deepEqual(draftLine({ status: 'paused' }), { text: 'Черновик на паузе', tone: 'wait' });
  assert.equal(draftLine({ status: 'aborted', section: '' }).text, 'Черновик не получился: запуск остановили · раздел «начало»');
  assert.equal(draftStopText('failed'), 'запуск упал с ошибкой');
  // незнакомый статус — подписью статуса запуска, неизвестный совсем — как есть
  assert.equal(draftStopText('pending'), 'ожидает');
  assert.equal(draftStopText('weird'), 'weird');
  const d = (run: string, kind: TeamDraft['kind'], docs?: TeamDraft['docs']): TeamDraft => ({ run, kind, flow: `teamwork-${kind}`, status: 'done', startedAt: '2026-11-12T10:00:00Z', ...(docs ? { docs } : {}) });
  const list = [d('r3', 'split'), d('r2', 'architecture', ['architecture', 'design']), d('r1', 'prd', ['prd'])];
  assert.equal(latestDraftFor(list, 'prd')?.run, 'r1');
  assert.equal(latestDraftFor(list, 'design')?.run, 'r2');
  assert.equal(latestDraftFor(list, 'docs/x.md'), undefined);
});

test('слияние трёх сторон: правку агента и чужую правку в другом месте берём обе, где поменял только один — его', () => {
  const base = DOC;
  const theirs = DOC.replace('Бухгалтерия собирает счета руками.', 'Бухгалтерия собирает счета руками, 4 часа в месяц.');
  const ours = DOC.replace('- FR-2. Колонки по шаблону.', '- FR-2. Колонки по шаблону.\n- FR-3. Кодировка CP1251.');
  const merged = merge3(base, ours, theirs).text;
  assert.match(merged, /4 часа в месяц/);
  assert.match(merged, /- FR-2\. Колонки по шаблону\.\n- FR-3\. Кодировка CP1251\.\n\n## Вне рамок/);
  assert.equal(merge3(base, base, theirs).text, theirs);
  assert.equal(merge3(base, ours, base).text, ours);
  assert.equal(merge3(base, ours, ours).text, ours);
});

test('слияние трёх сторон: один кусок поменяли оба по-разному — берём наш (правка принята вручную); удаление у них сохраняется', () => {
  const base = DOC;
  const theirs = DOC.replace('- FR-1. Выгрузка за период.', '- FR-1. Выгрузка за период включительно.').replace('\n## Вне рамок\n\n- XLSX.\n', '');
  const ours = DOC.replace('- FR-1. Выгрузка за период.', '- FR-1. Выгрузка за период в CSV.');
  const merged = merge3(base, ours, theirs).text;
  assert.match(merged, /- FR-1\. Выгрузка за период в CSV\./);
  assert.doesNotMatch(merged, /включительно/);
  assert.doesNotMatch(merged, /Вне рамок/);
});

test('слияние трёх сторон: их правка в соседнем блоке не теряется, наша вставка сразу за общим блоком — без пустой строки', () => {
  const base = '## НФТ\n\n- NFR-1. Быстрее 10 секунд.\n- NFR-2. Не блокирует админку.\n\n## Вне рамок\n\n- XLSX.\n';
  const theirs = base.replace('10 секунд', '5 секунд');
  const ours = base.replace('- NFR-2. Не блокирует админку.\n', '- NFR-2. Никогда не блокирует админку.\n- NFR-3. Только роли «Бухгалтер» и «Админ».\n');
  assert.equal(merge3(base, ours, theirs).text, '## НФТ\n\n- NFR-1. Быстрее 5 секунд.\n- NFR-2. Никогда не блокирует админку.\n- NFR-3. Только роли «Бухгалтер» и «Админ».\n\n## Вне рамок\n\n- XLSX.\n');
  // они дописали пункт в тот же список, мы — в конец другого раздела
  const theirs2 = base.replace('- XLSX.\n', '- XLSX.\n- ODS.\n');
  const ours2 = base.replace('- NFR-2. Не блокирует админку.\n', '- NFR-2. Не блокирует админку.\n- NFR-3. Права.\n');
  assert.equal(merge3(base, ours2, theirs2).text, '## НФТ\n\n- NFR-1. Быстрее 10 секунд.\n- NFR-2. Не блокирует админку.\n- NFR-3. Права.\n\n## Вне рамок\n\n- XLSX.\n- ODS.\n');
});

test('итог черновика: документ не менялся — решения поверх base с хэшем base; менялся — слияние с текущим и его хэш', () => {
  const next = DOC.replace('- XLSX.', '- XLSX и API 1С.');
  const tr = trackChanges(DOC, next);
  const decisions = { [tr.edits[0]!.id]: 'accept' as const };
  const same = draftResult({ base: DOC, next, current: DOC, moved: false, baseHash: 'b', currentHash: 'b' }, decisions);
  assert.deepEqual(same, { text: applyDecisions(DOC, next, decisions), base: 'b', lost: [] });
  const current = DOC.replace('## Цель', '## Цель и проблема');
  const moved = draftResult({ base: DOC, next, current, moved: true, baseHash: 'b', currentHash: 'c' }, decisions);
  assert.equal(moved.base, 'c');
  assert.match(moved.text, /## Цель и проблема/);
  assert.match(moved.text, /- XLSX и API 1С\./);
});

test('обёртка выделения: жирный, курсив и код вокруг выделения; повтор снимает метки; пустое выделение — пара меток', () => {
  assert.deepEqual(wrapMark('один два три', 5, 8, '**'), { text: 'один **два** три', from: 7, to: 10 });
  assert.deepEqual(wrapMark('один **два** три', 7, 10, '**'), { text: 'один два три', from: 5, to: 8 });
  assert.deepEqual(wrapMark('один **два** три', 5, 12, '**'), { text: 'один два три', from: 5, to: 8 });
  assert.deepEqual(wrapMark('ab', 1, 1, '`'), { text: 'a``b', from: 2, to: 2 });
  // курсив внутри жирного не снимает звёздочки жирного
  assert.deepEqual(wrapMark('**два**', 2, 5, '*'), { text: '***два***', from: 3, to: 6 });
});

test('изменения строк требований: добавлено, удалено, текст и порядок одним изменением', () => {
  const a = [{ id: 'FR-1', text: 'один' }, { id: 'FR-2', text: 'два' }, { id: 'FR-3', text: 'три' }];
  assert.equal(rowChanges(a, a), 0);
  assert.equal(rowChanges(a, [a[0]!, { id: 'FR-2', text: 'два!' }, a[2]!]), 1);
  assert.equal(rowChanges(a, [a[0]!, a[2]!, { id: 'FR-4', text: '' }]), 2);
  assert.equal(rowChanges(a, [a[1]!, a[0]!, a[2]!]), 1);
});

test('итог черновика после своей прошлой записи: документ равен базе с записанными правками — слияние даёт ровно решения поверх base', () => {
  const next = DOC.replace('- FR-2. Колонки по шаблону.\n', '- FR-2. Колонки по шаблону бухгалтерии.\n- FR-3. Кодировка CP1251.\n').replace('- XLSX.', '- XLSX и API 1С.');
  const tr = trackChanges(DOC, next);
  const first = { [tr.edits[0]!.id]: 'accept' as const };
  const current = applyDecisions(DOC, next, first);
  const all = Object.fromEntries(tr.edits.map((e) => [e.id, 'accept' as const]));
  const r = draftResult({ base: DOC, next, current, moved: true, baseHash: 'b', currentHash: 'c' }, all);
  assert.equal(r.text, applyDecisions(DOC, next, all));
  assert.equal(r.base, 'c');
});

test('applyDecisions: принятая замена пункта и принятая вставка под ним — без пустой строки внутри списка', () => {
  const base = '## НФТ\n\n- NFR-1. Быстро.\n- NFR-2. Фоном.\n\n## Вне рамок\n';
  const next = base.replace('- NFR-2. Фоном.\n', '- NFR-2. Всегда фоном.\n- NFR-3. Права.\n');
  const all = Object.fromEntries(trackChanges(base, next).edits.map((e) => [e.id, 'accept' as const]));
  assert.equal(applyDecisions(base, next, all), next);
});

test('автор правки в шапке документа узнаётся по email без учёта регистра', () => {
  const members = [{ name: 'Алексей Колодин', email: '1+alekseykolodin@users.noreply.github.com' }];
  const now = new Date('2026-11-12T12:00:00Z');
  assert.equal(updatedText({ updatedAt: '2026-11-12T10:00:00Z', updatedBy: '1+alekseyKolodin@users.noreply.github.com' }, members, now), 'обновлено сегодня, Алексей');
});

test('итог черновика: сначала записана вставка, потом принята замена соседнего блока — вставка не повторяется', () => {
  const next = DOC.replace('- FR-2. Колонки по шаблону.\n', '- FR-2. Колонки по шаблону бухгалтерии.\n- FR-3. Кодировка CP1251.\n');
  const tr = trackChanges(DOC, next);
  const added = tr.edits.find((e) => e.kind === 'added')!;
  const changed = tr.edits.find((e) => e.kind === 'changed')!;
  const written = { [added.id]: 'accept' as const };
  const current = applyDecisions(DOC, next, written);
  const all = { ...written, [changed.id]: 'accept' as const };
  const r = draftResult({ base: DOC, next, current, moved: true, baseHash: 'b', currentHash: 'c' }, all, written);
  assert.equal(r.text, next);
  assert.equal(r.text.match(/FR-3/g)?.length, 1);
  assert.deepEqual(r.lost, []);
});

test('слияние трёх сторон: их абзац между двумя нашими заменами остаётся', () => {
  const base = '# Д\n\nАбзац B.\n\nАбзац C.\n\nАбзац D.\n';
  const ours = base.replace('Абзац B.', 'Абзац B новый.').replace('Абзац C.', 'Абзац C новый.');
  const theirs = base.replace('Абзац B.\n', 'Абзац B.\n\nАбзац X коллеги.\n');
  const r = merge3(base, ours, theirs);
  assert.equal(r.text, '# Д\n\nАбзац B новый.\n\nАбзац X коллеги.\n\nАбзац C новый.\n\nАбзац D.\n');
  assert.deepEqual(r.lost, []);
});

test('слияние трёх сторон: конфликт берёт кусок ours между общими соседями, заменённые чужие блоки — в lost', () => {
  const base = '# Д\n\nАбзац B.\n\nАбзац C.\n\nАбзац D.\n';
  const ours = base.replace('Абзац B.', 'Абзац B наш.');
  const theirs = base.replace('Абзац B.', 'Абзац B их.').replace('Абзац C.', 'Абзац C их.');
  const r = merge3(base, ours, theirs);
  // C не пропадает: из ours приходит его версия base, а их правка C — в списке заменённого
  assert.equal(r.text, '# Д\n\nАбзац B наш.\n\nАбзац C.\n\nАбзац D.\n');
  assert.deepEqual(r.lost, ['Абзац B их.', 'Абзац C их.']);
});

test('слияние трёх сторон: вставка под заголовком, который у них переименовали, встаёт перед общим соседом снизу', () => {
  const base = '## S1\n\nТекст 1.\n\n## S2\n\nТекст 2.\n';
  const ours = base.replace('## S2\n\n', '## S2\n\nНовый абзац.\n\n');
  const theirs = base.replace('## S2', '## S2 переименован');
  const r = merge3(base, ours, theirs);
  assert.equal(r.text, '## S1\n\nТекст 1.\n\n## S2 переименован\n\nНовый абзац.\n\nТекст 2.\n');
  assert.deepEqual(r.lost, []);
});

test('итог черновика: документ удалили после старта — записывать нечего', () => {
  const r = draftResult({ base: DOC, next: DOC + '\nещё', current: '', moved: true, baseHash: 'b', currentHash: 'e' }, {});
  assert.equal(r.gone, true);
});

test('строки требований без потерь: только требования и текст вокруг — да; подзаголовки и вложенные пункты между ними — нет', () => {
  assert.equal(rowsLossless('Вступление.\n\n- FR-1. Один.\n\n- FR-2. Два.\n\nХвост.'), true);
  assert.equal(rowsLossless('### Экспорт\n\n- FR-1. Один.\n\n### Импорт\n\n- FR-2. Два.'), false);
  assert.equal(rowsLossless('- FR-1. Один.\n  - уточнение\n- FR-2. Два.'), false);
  assert.equal(rowsLossless(''), true);
});
