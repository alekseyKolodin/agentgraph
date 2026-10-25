import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HomeCond, HomeRun, QuestionRecord } from '@server/api-types';
import {
  collectAnswers, docTitle, homeMeta, homeRunView, homeStuck, ignoredConfirmText, inbox, inboxCount, liveCount, liveRows, liveRowTitle,
  optionView, OTHER, questionLastCond, questionWhere, sideLiveInfo, withoutQuestion,
} from './home';

const T0 = Date.parse('2026-10-24T10:00:00Z');
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

const question = (id: string, askedAt: string, over: Partial<QuestionRecord> = {}): QuestionRecord => ({
  id, block: 'main', iteration: 2, phase: 'plan', title: 'План', askedAt,
  questions: [{ question: 'Какой вариант?', header: 'Выбор', options: [{ label: 'A' }, { label: 'B' }] }],
  ...over,
});

const run = (over: Partial<HomeRun> = {}): HomeRun => ({
  id: 'r1', flow: 'fix-tests', cwd: '/p/app', input: 'почини', status: 'running', pause: null, startedAt: iso(0), totalCostUsd: 0.4,
  iterations: 1, maxIterations: 5, blocks: [{ name: 'main', status: 'running', iterations: 3, maxIterations: 10, looped: true }],
  current: { block: 'main', iteration: 3, title: 'Реализация' }, running: [{ block: 'main', iteration: 3, phase: 'impl', title: 'Реализация' }],
  questions: [], conds: [], ...over,
});

const fail = (iteration: number, text = 'тест 12 упал'): HomeCond => ({ iteration, type: 'command', done: false, text });

test('входящие: вопросы всех запусков, сначала давние; счётчик и заголовок вкладки', () => {
  const runs = [run({ id: 'a', questions: [question('q2', iso(5))] }), run({ id: 'b', questions: [question('q1', iso(1)), question('q3', iso(9))] })];
  assert.deepEqual(inbox(runs).map((x) => `${x.run.id}:${x.q.id}`), ['b:q1', 'a:q2', 'b:q3']);
  assert.equal(inboxCount(runs), 3);
  assert.equal(docTitle(3), '(3) agentgraph');
  assert.equal(docTitle(0), 'agentgraph');
  assert.equal(docTitle(1, 'Кнопка'), '(1) Кнопка · agentgraph');
  assert.equal(homeMeta(runs, 3), 'идут 2 · вопросов 3 · ≈$0.80');
  assert.equal(homeMeta([], 0), '');
  assert.deepEqual(withoutQuestion(runs, 'b', 'q1')[1]!.questions.map((q) => q.id), ['q3']);
});

test('буксует: пять подряд одинаковых провалов (числа не различают), успех обрывает хвост', () => {
  assert.equal(homeStuck([1, 2, 3, 4].map((i) => fail(i))), null);
  assert.deepEqual(homeStuck([1, 2, 3, 4, 5].map((i) => fail(i, `тест ${i} упал`))), { from: 1, to: 5, text: 'тест 5 упал' });
  assert.equal(homeStuck([...[1, 2, 3, 4].map((i) => fail(i)), fail(5, 'другое')]), null);
  assert.equal(homeStuck([...[1, 2, 3, 4, 5].map((i) => fail(i)), { iteration: 6, type: 'command', done: true, text: '' }]), null);
  const withSummary = [1, 2, 3, 4, 5].map((i) => ({ ...fail(i), summary: 'итог' }));
  assert.equal(homeStuck(withSummary)?.text, 'итог');
});

test('строка запуска: сейчас идёт этап, мини-лента и стоимость', () => {
  const v = homeRunView(run({ conds: [fail(1), { iteration: 2, type: 'command', done: true, text: '' }] }), 'app', false, T0 + 12 * 60_000);
  assert.equal(v.tone, 'live');
  assert.equal(v.title, 'fix-tests');
  assert.equal(v.meta, 'app · итер. 3/10');
  assert.equal(v.sum, 'Сейчас этап «Реализация»');
  assert.deepEqual(v.ticks, ['fail', 'ok', 'live']);
  assert.equal(v.cost, '12 мин · $0.40');
  assert.equal(v.costTitle, 'Идёт 12 мин · оценка по прайсу API');
  assert.equal(v.answer, false);
});

test('строка запуска: имя от модели, блоки, вердикт и сводка «где мы»', () => {
  const blocks = [
    { name: 'a', status: 'done', iterations: 1, maxIterations: 1, looped: false },
    { name: 'b', status: 'running', iterations: 2, maxIterations: 5, looped: true },
  ];
  const r = run({ title: 'Почини тесты', blocks, conds: [fail(1, '## Ошибка\n`npm test` упал')] });
  assert.equal(homeRunView(r, 'app', false, T0).meta, 'fix-tests · app · блок 2/2 · итер. 2/5');
  assert.equal(homeRunView(r, 'app', false, T0).sum, 'Сейчас этап «Реализация» · итерация 1 не прошла: «Ошибка npm test упал»');
  assert.equal(homeRunView({ ...r, digest: { text: 'Почти готово', block: 'b', iteration: 1, at: iso(1) } }, 'app', false, T0).sum, 'Сейчас этап «Реализация» · Почти готово');
  // между шагами и без цикла — без мини-ленты
  const idle = run({ current: null, running: [], blocks: [{ name: 'main', status: 'running', iterations: 1, maxIterations: 1, looped: false }] });
  assert.equal(homeRunView(idle, '', false, T0).sum, 'Между шагами');
  assert.deepEqual(homeRunView(idle, '', false, T0).ticks, []);
  // параллельная группа
  const par = run({ running: [{ block: 'main', iteration: 1, phase: 'a', title: 'A' }, { block: 'main', iteration: 1, phase: 'b', title: 'B' }] });
  assert.equal(homeRunView(par, '', false, T0).sum, 'Сейчас этапы «A», «B»');
});

test('строка запуска: ждёт ответа, пауза, буксует, пауза после шага и «Ответить»', () => {
  assert.deepEqual(
    [homeRunView(run({ status: 'waiting' }), '', false, T0).tone, homeRunView(run({ status: 'waiting' }), '', false, T0).sum],
    ['wait', 'Ждёт ответа: этап «Реализация» — вопрос выше'],
  );
  const paused = run({ pause: 'paused', pauseReason: { phase: 'ask', iteration: 2 }, decisions: true });
  assert.equal(homeRunView(paused, '', false, T0).sum, 'На паузе: этап «ask» попросил остановиться');
  assert.equal(homeRunView(paused, '', false, T0).answer, false);
  assert.equal(homeRunView(paused, '', true, T0).answer, true);
  assert.equal(homeRunView(run({ pause: 'paused' }), '', true, T0).sum, 'На паузе');
  const stuck = run({ conds: [1, 2, 3, 4, 5].map((i) => fail(i)) });
  assert.equal(homeRunView(stuck, '', false, T0).sum, 'Буксует: итерации 1–5 падают с одним и тем же — «тест 12 упал»');
  assert.equal(homeRunView(run({ pause: 'requested' }), '', false, T0).sum, 'Сейчас этап «Реализация» · пауза после шага');
  // длинная лента — последние 16
  assert.equal(homeRunView(run({ conds: Array.from({ length: 30 }, (_, i) => ({ ...fail(i), text: String.fromCharCode(97 + (i % 3)) })) }), '', false, T0).ticks.length, 16);
});

test('«Сейчас»: ждущие первыми, счётчик и подсказка; без /api/home — по статусу из списка запусков', () => {
  const rows = liveRows([run({ id: 'a' }), run({ id: 'b', status: 'waiting' }), run({ id: 'c', pause: 'paused' })]);
  assert.deepEqual(rows.map((x) => [x.r.id, x.tone, x.sub, x.it]), [
    ['b', 'wait', 'ждёт ответа · этап «Реализация»', '3/10'],
    ['c', 'wait', 'на паузе', '3/10'],
    ['a', 'live', 'этап «Реализация»', '3/10'],
  ]);
  assert.deepEqual(liveCount(rows), { text: 'ждут 2 · идут 1', wait: true });
  assert.deepEqual(liveCount(rows.slice(2)), { text: 'идут 1', wait: false });
  assert.equal(liveRowTitle(rows[0]!), 'fix-tests\nждёт ответа · этап «Реализация»');
  assert.equal(liveRowTitle({ ...rows[0]!, r: { ...rows[0]!.r, title: 'Имя' } }), 'Имя\nflow fix-tests · ждёт ответа · этап «Реализация»');
  assert.deepEqual(sideLiveInfo({ id: 'x', flow: 'f', status: 'running' }), { tone: 'live', sub: 'между шагами', it: '' });
  assert.deepEqual(sideLiveInfo({ id: 'x', flow: 'f', status: 'paused' }), { tone: 'wait', sub: 'на паузе', it: '' });
  assert.equal(sideLiveInfo(run({ conds: [1, 2, 3, 4, 5].map((i) => fail(i)) })).sub, 'буксует: итерации 1–5');
});

test('карточка вопроса: где спросили, итог прошлой итерации, рекомендованный вариант', () => {
  const q = question('q', iso(0), { iteration: 3 });
  assert.equal(questionWhere(q, run()), 'этап «План» · итерация 3');
  assert.equal(questionWhere({ ...q, title: '' }, run({ blocks: [...run().blocks, ...run().blocks] })), 'блок main · этап «plan» · итерация 3');
  assert.equal(questionLastCond(q, run({ conds: [fail(1), fail(2), fail(3)] }))?.iteration, 2);
  assert.equal(questionLastCond(q, run({ conds: [fail(1), { iteration: 2, type: 'judge', done: true, text: '' }] })), null);
  assert.deepEqual(optionView('Быстро (Recommended)'), { label: 'Быстро', rec: true });
  assert.deepEqual(optionView('Медленно (рекомендую)'), { label: 'Медленно', rec: true });
  assert.deepEqual(optionView('Средне'), { label: 'Средне', rec: false });
});

test('ответ: варианты через запятую, свой ответ — если выбран или ничего не выбрано', () => {
  const qs = [
    { question: 'Q1', header: 'H1', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
    { question: 'Q2', header: '', options: [] },
    { question: 'Q3', header: 'H3', options: [{ label: 'X' }] },
  ];
  const r = collectAnswers(qs, [['A', 'B', OTHER], [], ['X']], ['свой', 'текст', 'забытый']);
  assert.deepEqual(r.answers, { Q1: 'A, B, свой', Q2: 'текст', Q3: 'X' });
  assert.equal(r.missing, false);
  assert.deepEqual(r.ignored, ['H3']);
  assert.equal(collectAnswers(qs, [['A'], [], []], ['', '', '']).missing, true);
  // выбран «свой», но текста нет — вопрос без ответа
  assert.equal(collectAnswers([qs[1]!], [[OTHER]], ['  ']).missing, true);
  assert.equal(ignoredConfirmText(['H3', 'Q4']), 'Свой ответ написан, но не выбран — он не уйдёт агенту:\n• H3\n• Q4\nОтправить без него?');
});
