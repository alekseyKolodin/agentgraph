import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askQuit, quitPrompt, sessionsLine, teamsLine, type QuitPrompt, type UnsentTeam } from './quit-dialog.js';

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
  const p = quitPrompt({ sessions: [], teams: [{ slug: 'p', title: 'Платежи', unpushed: 3, error: 'нет доступа\n к репо' }, { slug: 'p', title: 'Дизайн', unpushed: 1 }] })!;
  assert.deepEqual(p.buttons, ['Отправить и закрыть', 'Закрыть без отправки', 'Отмена']);
  assert.deepEqual(p.choices, ['push', 'quit', 'cancel']);
  assert.equal(p.defaultId, 0);
  assert.equal(p.cancelId, 2);
  assert.match(p.detail, /^Не отправлено в Teamwork: «Платежи» — 3 изменения \(нет доступа к репо\); «Дизайн» — 1 изменение\. /);
  assert.match(p.detail, /при следующем запуске agentgraph/);
});

test('сессии и изменения вместе: оба абзаца, кнопки говорят и про сессии', () => {
  const p = quitPrompt({ sessions: ['x'], teams: [{ slug: 'p', title: 'Платежи', unpushed: 11 }] })!;
  assert.deepEqual(p.buttons, ['Отправить, завершить сессии и закрыть', 'Завершить сессии и закрыть без отправки', 'Отмена']);
  const [first, , second] = p.detail.split('\n\n');
  assert.match(first!, /^Идёт 1 сессия Claude: «x»\./);
  assert.match(second!, /«Платежи» — 11 изменений/);
});

test('отправка не удалась — «Отправить» больше не предлагается, по умолчанию «Отмена»', () => {
  const p = quitPrompt({ sessions: [], teams: [{ slug: 'p', title: 'Платежи', unpushed: 2, error: 'Could not resolve host' }], pushFailed: true })!;
  assert.equal(p.message, 'Изменения Teamwork не отправились');
  assert.deepEqual(p.choices, ['quit', 'cancel']);
  assert.deepEqual(p.buttons, ['Закрыть без отправки', 'Отмена']);
  assert.equal(p.defaultId, 1);
  assert.match(p.detail, /«Платежи» — 2 изменения \(Could not resolve host\)/);
});

test('подписи: формы слов по числу, длинная причина обрезается', () => {
  assert.equal(sessionsLine(['a']), 'Идёт 1 сессия Claude: «a».');
  assert.equal(sessionsLine(['a', 'b', 'c', 'd', 'e']), 'Идут 5 сессий Claude: «a», «b», «c», «d» и «e».');
  assert.equal(teamsLine([{ slug: 't', title: 'T', unpushed: 21 }]), 'Не отправлено в Teamwork: «T» — 21 изменение.');
  const long = teamsLine([{ slug: 't', title: 'T', unpushed: 2, error: 'x'.repeat(300) }]);
  assert.equal(long.match(/\((.+)\)/)![1]!.length, 120);
  assert.match(long, /…\)\.$/);
});

test('отправка ещё идёт — так и написано, а не «не отправились»', () => {
  const p = quitPrompt({ sessions: [], teams: [{ slug: 'p', title: 'Платежи', unpushed: 1, error: 'старая ошибка', pushing: true }], pushFailed: true })!;
  assert.equal(p.message, 'Изменения Teamwork ещё отправляются');
  assert.match(p.detail, /«Платежи» — 1 изменение \(ещё отправляется\)/);
});

/** Подменённые источники: очередь ответов окна и списки неотправленного по вызовам; что показали и что отправили. */
function fake(o: { sessions?: string[]; unsent: UnsentTeam[][]; answers: number[]; push?: () => Promise<void> }) {
  const shown: QuitPrompt[] = [];
  const pushed: string[][] = [];
  let i = 0;
  const deps = {
    sessions: () => o.sessions ?? [],
    unsent: async () => o.unsent[Math.min(i++, o.unsent.length - 1)]!,
    push: async (slugs: string[]) => {
      pushed.push(slugs);
      await o.push?.();
    },
    show: async (p: QuitPrompt) => {
      shown.push(p);
      return o.answers.shift() ?? p.cancelId;
    },
    pushWaitMs: 50,
    unsentWaitMs: 50,
  };
  return { deps, shown, pushed };
}

const pay: UnsentTeam = { slug: 'pay', title: 'Платежи', unpushed: 2 };

test('askQuit: спрашивать не о чем — выход без окна', async () => {
  const f = fake({ unsent: [[]], answers: [] });
  assert.equal(await askQuit(f.deps), true);
  assert.equal(f.shown.length, 0);
});

test('askQuit: «Отправить и закрыть» — всё ушло, выход без второго окна, даже при живых сессиях', async () => {
  const f = fake({ sessions: ['a'], unsent: [[pay], []], answers: [0] });
  assert.equal(await askQuit(f.deps), true);
  assert.deepEqual(f.pushed, [['pay']]);
  assert.equal(f.shown.length, 1);
});

test('askQuit: не ушло — второе окно без «Отправить»; «Закрыть без отправки» выходит, «Отмена» остаётся', async () => {
  const failed = { ...pay, error: 'нет сети' };
  const quit = fake({ unsent: [[pay], [failed]], answers: [0, 0] });
  assert.equal(await askQuit(quit.deps), true);
  assert.equal(quit.shown.length, 2);
  assert.deepEqual(quit.shown[1]!.choices, ['quit', 'cancel']);
  assert.match(quit.shown[1]!.detail, /нет сети/);
  const stay = fake({ unsent: [[pay], [failed]], answers: [0, 1] });
  assert.equal(await askQuit(stay.deps), false);
});

test('askQuit: отправка не успела — не ждём её дольше срока, во втором окне «ещё отправляются»', async () => {
  const f = fake({ unsent: [[pay], [{ ...pay, pushing: true }]], answers: [0, 1], push: () => new Promise<void>(() => {}) });
  const started = Date.now();
  assert.equal(await askQuit(f.deps), false);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(f.shown[1]!.message, 'Изменения Teamwork ещё отправляются');
});

test('askQuit: «Отмена» в первом окне — остаёмся, ничего не отправляем; подсчёт коммитов завис — выход без вопроса', async () => {
  const f = fake({ unsent: [[pay]], answers: [2] });
  assert.equal(await askQuit(f.deps), false);
  assert.deepEqual(f.pushed, []);
  const hang = { ...fake({ unsent: [[]], answers: [] }).deps, unsent: () => new Promise<UnsentTeam[]>(() => {}) };
  assert.equal(await askQuit(hang), true);
});
