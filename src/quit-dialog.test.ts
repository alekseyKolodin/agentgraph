import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quitPrompt, sessionsLine, teamsLine } from './quit-dialog.js';

test('спрашивать не о чем — выход без диалога', () => {
  assert.equal(quitPrompt({ sessions: [], teams: [] }), undefined);
});

test('только сессии терминала — как раньше: «Завершить сессии и закрыть» и про состояние пространства', () => {
  const p = quitPrompt({ sessions: ['a', 'b'], teams: [] })!;
  assert.equal(p.message, 'Закрыть AgentGraph?');
  assert.deepEqual(p.buttons, ['Завершить сессии и закрыть', 'Отмена']);
  assert.deepEqual(p.choices, ['quit', 'cancel']);
  assert.equal(p.cancelId, 1);
  assert.match(p.detail, /^Идут 2 сессии Claude: «a» и «b»\. Они завершатся/);
  assert.match(p.detail, /Состояние пространства по этим сессиям/);
  assert.doesNotMatch(p.detail, /Teamwork/);
});

test('неотправленные изменения Teamwork — первой кнопкой «Отправить и закрыть», причина ошибки в одну строку', () => {
  const p = quitPrompt({ sessions: [], teams: [{ title: 'Платежи', unpushed: 3, error: 'нет доступа\n к репо' }, { title: 'Дизайн', unpushed: 1 }] })!;
  assert.deepEqual(p.buttons, ['Отправить и закрыть', 'Закрыть без отправки', 'Отмена']);
  assert.deepEqual(p.choices, ['push', 'quit', 'cancel']);
  assert.equal(p.defaultId, 0);
  assert.equal(p.cancelId, 2);
  assert.match(p.detail, /^Не отправлено в Teamwork: «Платежи» — 3 изменения \(нет доступа к репо\); «Дизайн» — 1 изменение\. /);
  assert.match(p.detail, /при следующем запуске agentgraph/);
});

test('сессии и изменения вместе: оба абзаца, кнопки говорят и про сессии', () => {
  const p = quitPrompt({ sessions: ['x'], teams: [{ title: 'Платежи', unpushed: 11 }] })!;
  assert.deepEqual(p.buttons, ['Отправить, завершить сессии и закрыть', 'Завершить сессии и закрыть без отправки', 'Отмена']);
  const [first, , second] = p.detail.split('\n\n');
  assert.match(first!, /^Идёт 1 сессия Claude: «x»\./);
  assert.match(second!, /«Платежи» — 11 изменений/);
});

test('отправка не удалась — «Отправить» больше не предлагается, по умолчанию «Отмена»', () => {
  const p = quitPrompt({ sessions: [], teams: [{ title: 'Платежи', unpushed: 2, error: 'Could not resolve host' }], pushFailed: true })!;
  assert.equal(p.message, 'Изменения Teamwork не отправились');
  assert.deepEqual(p.choices, ['quit', 'cancel']);
  assert.deepEqual(p.buttons, ['Закрыть без отправки', 'Отмена']);
  assert.equal(p.defaultId, 1);
  assert.match(p.detail, /«Платежи» — 2 изменения \(Could not resolve host\)/);
});

test('подписи: формы слов по числу, длинная причина обрезается', () => {
  assert.equal(sessionsLine(['a']), 'Идёт 1 сессия Claude: «a».');
  assert.equal(sessionsLine(['a', 'b', 'c', 'd', 'e']), 'Идут 5 сессий Claude: «a», «b», «c», «d» и «e».');
  assert.equal(teamsLine([{ title: 'T', unpushed: 21 }]), 'Не отправлено в Teamwork: «T» — 21 изменение.');
  const long = teamsLine([{ title: 'T', unpushed: 2, error: 'x'.repeat(300) }]);
  assert.equal(long.match(/\((.+)\)/)![1]!.length, 120);
  assert.match(long, /…\)\.$/);
});
