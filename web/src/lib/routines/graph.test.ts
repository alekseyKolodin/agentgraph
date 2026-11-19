// Граф рутины: что написано на узлах по черновику формы, счётчики по проверке на истории и путь одного срабатывания.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryCheck, LogEntry, RoutineEvent } from '@server/routines/types';
import { eventPath, historyCounts, modelName, routineNodes } from './graph';
import { buildSpec, draftFromSpec, emptyDraft, SCHEDULE } from './spec';

const ev = (id: string): RoutineEvent => ({ source: 'src', id, at: '2026-11-19T10:00:00Z', title: `e${id}`, text: '', fields: {} });
const hist = (rows: Array<[HistoryCheck['events'][number]['outcome'], boolean?]>): HistoryCheck => ({
  events: rows.map(([outcome, unsure], i) => ({ event: ev(String(i)), outcome, ...(unsure ? { unsure } : {}) })),
  disagreements: 0,
});
const entry = (extra: Partial<LogEntry>): LogEntry => ({ id: 'l1', at: '2026-11-19T10:00:00Z', routine: 'r', event: { source: 'src', id: '1', title: 'e1', at: '2026-11-19T10:00:00Z' }, outcome: 'started', ...extra });
const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((n) => [n.id, n]));

test('узлы источника: порядок фиксированный, на узле — кто работает; ИИ без условия и дело «не заводить» приглушены', () => {
  const d = { ...emptyDraft(), source: 'slack', flow: 'review', mode: 'until_pause' as const, pauseBefore: ['push'] };
  const nodes = routineNodes(d, { source: { title: 'Slack · #mr', kind: 'connector', every: '30m' }, delivery: 'poll', replyWhere: 'в тред Slack' });
  assert.deepEqual(nodes.map((n) => n.id), ['trigger', 'conds', 'ai', 'task', 'run', 'wait', 'reply']);
  const n = byId(nodes);
  assert.match(n.trigger!.sub, /Slack · #mr · опрос/);
  assert.deepEqual([n.trigger!.who.kind, n.conds!.who.kind, n.ai!.who.kind, n.run!.who.kind, n.wait!.who.kind], ['none', 'none', 'none', 'model', 'me']);
  assert.deepEqual([n.ai!.off, n.task!.off, n.conds!.off, n.run!.off], [true, true, true, false]);
  assert.equal(n.wait!.sub, 'перед блоком «push»');
  assert.equal(n.reply!.sub, 'в тред Slack, после твоей проверки');
});

test('узел ИИ: с условием — модель (своя или «по умолчанию») и начало условия; опрос моделью виден на триггере', () => {
  const d = { ...emptyDraft(), source: 'slack', flow: 'review', check: 'это запрос на ревью мне' };
  const ai = byId(routineNodes(d, { delivery: 'model' })).ai!;
  assert.deepEqual([ai.off, ai.who.kind, ai.who.label, ai.sub], [false, 'model', 'haiku, по умолчанию', 'это запрос на ревью мне']);
  assert.equal(byId(routineNodes({ ...d, checkModel: 'claude-sonnet-5-5' })).ai!.who.label, 'Sonnet 5.5');
  assert.equal(byId(routineNodes(d, { delivery: 'model' })).trigger!.who.kind, 'model');
  assert.equal(modelName('своя-модель', 'по умолчанию'), 'своя-модель');
});

test('расписание: условий и ИИ нет; рутина только с делом — запуск, ожидание и ответ приглушены', () => {
  assert.deepEqual(routineNodes({ ...emptyDraft(), source: SCHEDULE, flow: 'digest', mode: 'auto' }).map((n) => n.id), ['trigger', 'task', 'run', 'wait', 'reply']);
  const n = byId(routineNodes({ ...emptyDraft(), source: 'gitlab', taskOn: true, taskKind: 'Ревью' }));
  assert.deepEqual([n.task!.off, n.run!.off, n.wait!.off, n.reply!.off], [false, true, true, true]);
  assert.equal(n.task!.sub, '«Ревью» в «Новое»');
});

test('чего не хватает — подсказкой на своём узле', () => {
  const n = byId(routineNodes({ ...emptyDraft(), mode: 'until_pause' }, { missing: ['source', 'flow', 'block'] }));
  assert.deepEqual([n.trigger!.warn, n.run!.warn, n.wait!.warn], ['выбери, что запускает', 'выбери flow', 'выбери блок, перед которым ждать']);
});

test('счётчики по истории: пришло → прошло условия → ИИ решил запустить, пропустить или спросить', () => {
  const h = hist([['started'], ['waiting', true], ['check_no'], ['duplicate'], ['filtered'], ['filtered']]);
  assert.deepEqual(historyCounts(h), { total: 6, conds: 4, run: 1, skip: 2, ask: 1 });
  const d = { ...emptyDraft(), source: 'slack', flow: 'review', check: 'ревью мне', mode: 'auto' as const };
  const n = byId(routineNodes(d, { hist: h }));
  assert.deepEqual([n.trigger!.count, n.conds!.count, n.ai!.count, n.run!.count], [6, 4, 2, 1]);
  assert.deepEqual(n.ai!.outcomes, { run: 1, skip: 2, ask: 1 });
  assert.equal(historyCounts(null), undefined);
});

test('узел ИИ в правиле: модель и «спросить меня» пишутся только вместе с условием и читаются обратно', () => {
  const base = { ...emptyDraft(), title: 'Ревью', source: 'slack', flow: 'review' };
  assert.deepEqual(buildSpec({ ...base, checkModel: 'claude-opus-5-5' }, []).when, { source: 'slack' });
  const when = buildSpec({ ...base, check: ' ревью мне ', checkModel: 'claude-opus-5-5' }, []).when;
  assert.deepEqual(when, { source: 'slack', check: 'ревью мне', model: 'claude-opus-5-5', ask: true });
  const back = draftFromSpec({ title: 'Ревью', when: { source: 'slack', check: 'ревью мне', model: 'sonnet' }, run: { flow: 'review' }, mode: 'auto' });
  // старое правило без поля не спрашивает; у правила без узла новый узел спрашивать будет
  assert.deepEqual([back.checkModel, back.checkAsk], ['sonnet', false]);
  assert.equal(draftFromSpec({ title: 'Ревью', when: { source: 'slack' }, run: { flow: 'review' }, mode: 'auto' }).checkAsk, true);
});

test('путь события: пропущено ИИ — узел остановки с причиной и моделью, дальше «не дошло»', () => {
  const x = { schedule: false, conditions: [{ key: 'reviewer', op: '=', want: 'я', got: 'я', ok: true }], check: 'ревью мне' };
  const path = eventPath(entry({ outcome: 'check_no', reason: 'обсуждение чужого MR', checkModel: 'claude-haiku-4-5' }), x);
  assert.deepEqual(path.map((p) => [p.id, p.state]), [['trigger', 'pass'], ['conds', 'pass'], ['ai', 'stop'], ['run', 'off'], ['wait', 'off'], ['reply', 'off']]);
  assert.deepEqual([path[2]!.note, path[2]!.model], ['обсуждение чужого MR', 'claude-haiku-4-5']);
  assert.equal(path[1]!.note, 'условия совпали');
});

test('путь события: не подошло по полям, ИИ не уверен, ждёт перед запуском, повтор по вещи, запущено', () => {
  const x = { schedule: false, conditions: [], check: 'ревью мне' };
  const stop = (e: Partial<LogEntry>) => {
    const p = eventPath(entry(e), x).find((n) => n.state === 'stop' || n.state === 'ask');
    return p ? [p.id, p.state] : undefined;
  };
  assert.deepEqual(stop({ outcome: 'filtered', reason: 'channel не bugs' }), ['conds', 'stop']);
  assert.deepEqual(stop({ outcome: 'waiting', unsure: true, why: 'неясно' }), ['ai', 'ask']);
  assert.deepEqual(stop({ outcome: 'waiting', why: 'подходит' }), ['wait', 'ask']);
  assert.deepEqual(stop({ outcome: 'duplicate', sameAs: { routine: 'r', logId: 'l0' } }), ['conds', 'stop']);
  // у рутины с делом повтор по вещи режет запуск уже после ИИ: дело сигнал получило
  assert.deepEqual(eventPath(entry({ outcome: 'duplicate', sameAs: { routine: 'r', logId: 'l0' }, deskKey: 'k' }), x, { hasTask: true }).filter((n) => n.state === 'stop').map((n) => n.id), ['task']);
  // старая строка без ответа ИИ, а причина — про запуск: это не узел ИИ
  assert.deepEqual(stop({ outcome: 'error', reason: 'запуск не начался' }), ['run', 'stop']);
  assert.deepEqual(stop({ outcome: 'duplicate', reason: 'тот же баг' }), ['ai', 'stop']);
  assert.deepEqual(stop({ outcome: 'limit' }), ['run', 'stop']);
  assert.deepEqual(stop({ outcome: 'error', reason: 'сеть' }), ['ai', 'stop']);
  assert.deepEqual(stop({ outcome: 'error', reason: 'flow сломан', why: 'подходит' }), ['run', 'stop']);
  assert.equal(stop({ outcome: 'started', runId: 'run-1' }), undefined);
  // расписание: условий и ИИ на пути нет; рутина только с делом: путь кончается на деле
  assert.deepEqual(eventPath(entry({ runId: 'run-1' }), { schedule: true, conditions: [] }).map((p) => p.id), ['trigger', 'run', 'wait', 'reply']);
  assert.deepEqual(eventPath(entry({ outcome: 'task', deskKey: 'k' }), { schedule: false, conditions: [] }, { hasTask: true, runs: false }).map((p) => [p.id, p.state]), [['trigger', 'pass'], ['conds', 'pass'], ['ai', 'pass'], ['task', 'stop']]);
});

test('путь события: ждёт перед запуском — flow ещё не запущен; узла остановки на графе нет — встаёт на ближайшем до него', () => {
  const x = { schedule: false, conditions: [], check: 'ревью мне' };
  const waiting = eventPath(entry({ outcome: 'waiting', why: 'подходит' }), x);
  assert.deepEqual(waiting.map((p) => [p.id, p.state]), [['trigger', 'pass'], ['conds', 'pass'], ['ai', 'pass'], ['run', 'off'], ['wait', 'ask'], ['reply', 'off']]);
  assert.equal(waiting[3]!.note, 'ещё не запущен');
  // запуск уже стоит на паузе перед блоком: flow запущен
  assert.equal(eventPath(entry({ outcome: 'waiting', runId: 'run-1' }), x)[3]!.state, 'pass');
  // строка «дело», а дело из правила уже убрали: остановка — на ИИ, дальше ничего не пройдено
  const noTask = eventPath(entry({ outcome: 'task' }), x);
  assert.deepEqual(noTask.map((p) => [p.id, p.state]), [['trigger', 'pass'], ['conds', 'pass'], ['ai', 'stop'], ['run', 'off'], ['wait', 'off'], ['reply', 'off']]);
});

