// Путь одного срабатывания по шагам рутины, подпись модели и узел «ИИ рутины» в правиле.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '@server/routines/types';
import { eventPath, modelName } from './graph';
import { buildSpec, draftFromSpec, emptyDraft } from './spec';

const entry = (extra: Partial<LogEntry>): LogEntry => ({ id: 'l1', at: '2026-11-19T10:00:00Z', routine: 'r', event: { source: 'src', id: '1', title: 'e1', at: '2026-11-19T10:00:00Z' }, outcome: 'started', ...extra });

test('подпись модели: из общего списка, иначе id как есть; пусто — запасная подпись', () => {
  assert.equal(modelName('claude-sonnet-5-5', 'по умолчанию'), 'Sonnet 5.5');
  assert.equal(modelName('своя-модель', 'по умолчанию'), 'своя-модель');
  assert.equal(modelName(' ', 'как в flow'), 'как в flow');
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

