import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantReply, changeRows, followUp, parseReply, phaseAsk, prevAfterUndo, rowsSummary, type UndoLink } from './assistant';
import type { EditPhase, EditSpec } from './edit';

const ph = (name: string, extra: Partial<EditPhase> = {}): EditPhase => ({ name, prompt: '{{input}}', tools: ['Read'], ...extra });
const spec = (blocks: EditSpec['blocks'], extra: Partial<EditSpec> = {}): EditSpec => ({ name: 'f', blocks, ...extra });

const BEFORE = spec([{ name: 'main', loop: { max_iterations: 8, until: { type: 'none' } }, phases: [ph('find', { title: 'Поиск болей' }), ph('score')] }], {
  artifacts: { scoring: { file: 'scoring.md' } },
});
const AFTER = spec([{ name: 'main', loop: { max_iterations: 12, until: { type: 'none' } }, phases: [
  ph('find', { title: 'Поиск болей', prompt: 'другой' }), ph('review', { title: 'Утверждение партии' }), ph('score'),
] }], { artifacts: { scoring: { file: 'scoring.md' }, review: { file: 'user_review.md' } } });

const SUMMARY = `Понял так: ты сам утверждаешь каждую партию идей.

- \`review\`: показывает идеи и спрашивает, какие проверять
- \`find\` — не повторяет отклонённое
- \`ghost\`: такого нет
- \`review\`: повтор не перетирает первую фразу
! Каждая партия теперь ждёт твоего ответа.
Обрати внимание: 8 повторов может не хватить.`;

test('итог ИИ: вступление, фразы по известным именам, предупреждения; чужое имя — во вступлении', () => {
  const r = parseReply(SUMMARY, new Set(['review', 'find']));
  assert.equal(r.items.get('review'), 'показывает идеи и спрашивает, какие проверять');
  assert.equal(r.items.get('find'), 'не повторяет отклонённое');
  assert.deepEqual(r.notes, ['Каждая партия теперь ждёт твоего ответа.', '8 повторов может не хватить.']);
  assert.match(r.intro, /^Понял так/);
  assert.match(r.intro, /ghost/);
  assert.match(r.intro, /повтор не перетирает/);
});

test('итог ИИ без формата и строки внутри блока кода остаются текстом', () => {
  const r = parseReply('Добавил этап.\n```\n- `find`: в коде\n! не предупреждение\n```', new Set(['find']));
  assert.equal(r.items.size, 0);
  assert.deepEqual(r.notes, []);
  assert.match(r.intro, /в коде/);
  assert.equal(parseReply('', new Set()).intro, '');
});

test('строки «Что изменилось»: новый этап, правка этапа, условие повтора одиночного блока, новый файл', () => {
  const { items } = parseReply(SUMMARY, new Set(['review', 'find', 'main', 'scoring', 'score']));
  assert.deepEqual(changeRows(BEFORE, AFTER, items), [
    { kind: 'edit', what: 'block', name: 'main', label: 'Условие повтора', text: 'Повторы и условие.' },
    { kind: 'edit', what: 'phase', name: 'find', label: 'Поиск болей', text: 'Не повторяет отклонённое.' },
    { kind: 'new', what: 'phase', name: 'review', label: 'Утверждение партии', text: 'Показывает идеи и спрашивает, какие проверять.' },
    { kind: 'new', what: 'artifact', name: 'review', label: 'Файл user_review.md', text: 'Показывает идеи и спрашивает, какие проверять.' },
  ]);
});

test('строки: удалённые этап и блок, настройки flow, поля словами без фразы ИИ', () => {
  const before = spec([{ name: 'a', phases: [ph('x'), ph('y')] }, { name: 'b', title: 'Второй', phases: [ph('z')] }]);
  const after = spec([{ name: 'a', phases: [ph('x', { handoff: 'итог', tools: [] })] }], { description: 'новое' });
  assert.deepEqual(changeRows(before, after).map((r) => [r.kind, r.what, r.label, r.text]), [
    ['edit', 'flow', 'Настройки flow', 'Описание.'],
    ['gone', 'block', 'Блок «Второй»', 'Блок удалён.'],
    ['edit', 'phase', 'x', 'Что передать следующему этапу, инструменты.'],
    ['gone', 'phase', 'y', 'Этап удалён.'],
    ['gone', 'phase', 'z', 'Этап удалён.'],
  ]);
  assert.deepEqual(changeRows(before, before), []);
});

test('ответ целиком: фраза про то, чего в разнице нет, уходит во вступление; сломанный flow — только текст', () => {
  const r = assistantReply('Сделал.\n- `score`: поправил промпт', BEFORE, AFTER);
  assert.ok(!r.rows.some((x) => x.name === 'score'));
  assert.match(r.intro, /`score`: поправил промпт/);
  const broken = assistantReply('Починил.\n- `find`: промпт', null, AFTER);
  assert.deepEqual(broken.rows, []);
  assert.match(broken.intro, /`find`: промпт/);
});

test('плашка: «1 новый этап и 1 изменённых», без этапов — число изменений', () => {
  const rows = changeRows(BEFORE, AFTER);
  assert.equal(rowsSummary(rows), '1 новый этап и 1 изменённый — они выделены зелёным.');
  assert.equal(rowsSummary(rows.filter((r) => r.what !== 'phase')), '2 изменения — выделены зелёным.');
  assert.equal(rowsSummary(rows.filter((r) => r.kind === 'edit' && r.what === 'phase')), '1 изменённый этап — они выделены зелёным.');
  assert.equal(rowsSummary([]), '');
  assert.equal(phaseAsk('2', 'Утверждение'), 'Этап 2 «Утверждение»: ');
});

test('уточнение из очереди уходит вместе с прошлым запросом', () => {
  const s = followUp('добавь утверждение', 'и проверь только одобренные');
  assert.match(s, /Предыдущий запрос[^\n]*\nдобавь утверждение\n\n/);
  assert.ok(s.endsWith('\nи проверь только одобренные'));
});

test('отмена цепочки правок ИИ: без ручных правок прошлая снова «чистая», с ними — спросит', () => {
  interface Ai extends UndoLink<Ai> { id: string }
  // ai1 легла на счётчике 1, ai2 — на 2 (до неё счётчик был 1)
  const ai1: Ai = { id: '1', seq: 1, undo: { prev: null, seq: 0 } };
  const ai2: Ai = { id: '2', seq: 2, undo: { prev: ai1, seq: 1 } };
  assert.equal(prevAfterUndo(ai2, 2), ai1);
  assert.equal(ai1.seq, 2);
  // руками правили после ai2: ai1 остаётся со старым счётчиком — её отмена спросит
  const b1: Ai = { id: '1', seq: 1, undo: { prev: null, seq: 0 } };
  const b2: Ai = { id: '2', seq: 2, undo: { prev: b1, seq: 1 } };
  prevAfterUndo(b2, 3);
  assert.equal(b1.seq, 1);
  // руками правили между ai1 и ai2
  const c1: Ai = { id: '1', seq: 1, undo: { prev: null, seq: 0 } };
  const c2: Ai = { id: '2', seq: 3, undo: { prev: c1, seq: 2 } };
  prevAfterUndo(c2, 3);
  assert.equal(c1.seq, 1);
  assert.equal(prevAfterUndo(c1, 1), null);
});
