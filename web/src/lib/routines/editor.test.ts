import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryCheck, HistoryFunnel } from '@server/routines/types';
import { mergeAssistant, condCounts, condTokens, dropCond, extrasSummary, freshHistory, saveStatus, switchSource, tokensValue, type SaveState } from './editor';
import type { Condition } from './match';
import { buildSpec, draftFromSpec, emptyDraft, SCHEDULE } from './spec';

const SOURCES = [
  { slug: 'gitlab', canReply: true },
  { slug: 'ff', canReply: false },
  { slug: 'slack-me', canReply: true },
];

test('смена источника: условия уходят, ответ — туда, куда новый источник может ответить', () => {
  const d = { ...emptyDraft(), source: 'gitlab', reply: 'draft' as const, replyTo: 'source' };
  // новый источник умеет отвечать — ответ в него
  assert.deepEqual(switchSource(d, 'slack-me', SOURCES), { source: 'slack-me', conds: [], condsMode: 'all', replyTo: 'source' });
  // не умеет — первый другой источник с ответом
  assert.deepEqual(switchSource(d, 'ff', SOURCES), { source: 'ff', conds: [], condsMode: 'all', replyTo: 'gitlab' });
  // ответ уже в другой источник — не трогается
  assert.deepEqual(switchSource({ ...d, replyTo: 'slack-me' }, 'ff', SOURCES), { source: 'ff', conds: [], condsMode: 'all' });
  // ответить некуда — «Не сообщать»
  assert.deepEqual(switchSource(d, 'ff', [{ slug: 'ff', canReply: false }]), { source: 'ff', conds: [], condsMode: 'all', reply: 'off' });
  // ответ выключен — только источник и условия
  assert.deepEqual(switchSource({ ...d, reply: 'off' }, 'ff', SOURCES), { source: 'ff', conds: [], condsMode: 'all' });
});

test('счётчики условий: строка ↔ шаг воронки, незаполненные пропускаются, «любое» считает от всех', () => {
  const conds: Condition[] = [
    { field: 'title', op: 'ne', value: 'English_B1' },
    { field: 'participants', op: 'contains', value: '' },
    { field: 'duration', op: 'gt', value: '10' },
  ];
  const all: HistoryFunnel = { total: 30, mode: 'all', fields: [{ field: 'title', op: 'ne', passed: 27 }, { field: 'duration', op: 'gt', passed: 25 }], matched: 25 };
  assert.deepEqual(condCounts(conds, all), [{ from: 30, passed: 27 }, null, { from: 27, passed: 25 }]);
  assert.deepEqual(condCounts(conds, { ...all, mode: 'any', matched: 28 }), [{ from: 30, passed: 27 }, null, { from: 30, passed: 25 }]);
  // поле строки поменяли после проверки — чужое число не показываем
  assert.deepEqual(condCounts([{ ...conds[0]!, field: 'author' }], all), [null]);
  assert.deepEqual(condCounts(conds, undefined), [null, null, null]);
});

test('статус сохранения: «сохранён» с оговоркой про незаполненное условие, причины несохранения — предупреждением', () => {
  const base: SaveState = { draft: true, dirty: false, missing: false, autoFailed: false, unsavedConds: false, savedAt: '21:40' };
  assert.deepEqual(saveStatus(base), { text: 'черновик сохранён в 21:40', warn: false });
  assert.deepEqual(saveStatus({ ...base, savedAt: null }), { text: 'черновик сохранён', warn: false });
  assert.deepEqual(saveStatus({ ...base, unsavedConds: true }), { text: 'черновик сохранён, кроме незаполненного условия', warn: true });
  assert.deepEqual(saveStatus({ ...base, dirty: true }), { text: 'сохраняю черновик…', warn: false });
  assert.equal(saveStatus({ ...base, dirty: true, missing: true })?.text, 'черновик не сохранён: не хватает настроек');
  assert.equal(saveStatus({ ...base, dirty: true, missing: true, autoFailed: true })?.text, 'черновик не сохранён: причина выше. Поправь — сохранится сам');
  // включённая рутина: без правок говорить нечего
  assert.equal(saveStatus({ ...base, draft: false }), null);
  assert.deepEqual(saveStatus({ ...base, draft: false, dirty: true }), { text: 'есть несохранённые изменения', warn: true });
  assert.deepEqual(saveStatus({ ...base, draft: false, unsavedConds: true }), { text: 'незаполненное условие не сохранится', warn: true });
});

test('сводка «Дополнительно»: пусто — «нет», лимиты и модель словами, пространство — только при фиче', () => {
  const d = emptyDraft();
  assert.equal(extrasSummary(d, { spaces: true }), 'пространство: нет · рабочее дерево: нет · лимиты: нет · модель: как в flow');
  assert.equal(extrasSummary(d, { spaces: false }), 'рабочее дерево: нет · лимиты: нет · модель: как в flow');
  const full = { ...d, space: 'pay', worktree: 'new' as const, usd: '0,5', perDay: '3', parallel: '', model: 'claude-haiku-4-5-20251001' };
  assert.equal(extrasSummary(full, { spaces: true }), 'пространство: pay · рабочее дерево: новое · лимиты: $0.5, 3 в день · модель: Haiku 4.5');
});

test('значения условия: «a, b» ↔ токены, пустые куски не считаются', () => {
  assert.deepEqual(condTokens('English_B1,  Daily Standup ,'), ['English_B1', 'Daily Standup']);
  assert.deepEqual(condTokens(''), []);
  assert.equal(tokensValue(['a', 'b']), 'a, b');
});

test('помощник поверх формы: берётся только то, что он поменял; разделы с его правками помечаются', () => {
  const base = { ...emptyDraft(), source: 'gitlab', flow: 'review' };
  // помощник поменял flow и ответ; остальное как было
  const r = mergeAssistant(base, base, draftFromSpec(buildSpec({ ...base, flow: 'review-mr', reply: 'off' }, [])));
  assert.equal(r.next.flow, 'review-mr');
  assert.equal(r.next.reply, 'off');
  assert.deepEqual(r.changed, [2, 3]);
  assert.deepEqual(r.kept, []);
  // результат, повторяющий форму, ничего не меняет и меток не ставит
  assert.deepEqual(mergeAssistant(base, base, draftFromSpec(buildSpec(base, []))).changed, []);
});

test('помощник поверх формы: поле, которое человек сам поменял после сообщения, не перетирается', () => {
  const base = { ...emptyDraft(), source: 'gitlab', flow: 'review', input: 'старое' };
  const mine = { ...base, input: 'моё', cwd: '~/x' };
  const theirs = draftFromSpec(buildSpec({ ...base, input: 'помощника', mode: 'auto' as const }, []));
  const r = mergeAssistant(base, mine, theirs);
  assert.equal(r.next.input, 'моё');
  assert.equal(r.next.cwd, '~/x');
  assert.equal(r.next.mode, 'auto');
  assert.deepEqual(r.kept, ['input']);
  // человек пришёл к тому же, что и помощник, — не конфликт
  assert.deepEqual(mergeAssistant(base, { ...base, mode: 'auto' }, theirs).kept, []);
});

test('помощник поверх формы: недописанная строка условия человека остаётся после условий помощника', () => {
  const base = { ...emptyDraft(), source: 'gitlab', flow: 'review' };
  const mine = { ...base, conds: [{ field: 'author', op: 'eq' as const, value: '' }] };
  const theirs = draftFromSpec(buildSpec({ ...base, conds: [{ field: 'title', op: 'contains' as const, value: 'MR' }] }, []));
  const r = mergeAssistant(base, mine, theirs);
  assert.deepEqual(r.next.conds.map((c) => c.field), ['title', 'author']);
});

test('помощник поверх формы: снимка нет — сравнение с формой как есть; значения по умолчанию разницей не считаются', () => {
  const plain = { ...emptyDraft(), source: 'gitlab', flow: 'review' };
  const sched = { ...emptyDraft(), source: SCHEDULE, flow: 'digest', input: 'Сводка' };
  const task = { ...emptyDraft(), source: 'ff', taskOn: true, taskKind: 'Встреча', check: 'я говорил' };
  for (const d of [plain, sched, task]) assert.deepEqual(mergeAssistant(undefined, d, draftFromSpec(buildSpec(d, []))).changed, [], d.source);
});
