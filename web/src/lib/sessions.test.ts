import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSummarize, chipHint, fileUris, pendingNote, sessionStatusLabel, sessionSub, sessionTone, sessionWsUrl, shellPath, summaryNote } from './sessions';

test('статус сессии: подписи и тон точки; выход без SessionStart — отдельный исход', () => {
  assert.deepEqual([sessionStatusLabel({ status: 'working' }), sessionTone({ status: 'working' })], ['Работает', 'live']);
  assert.deepEqual([sessionStatusLabel({ status: 'waiting' }), sessionTone({ status: 'waiting' })], ['Ждёт тебя', 'wait']);
  assert.deepEqual([sessionStatusLabel({ status: 'starting' }), sessionTone({ status: 'starting' })], ['Запускается', 'off']);
  assert.equal(sessionStatusLabel({ status: 'ended', exitCode: 0 }), 'Завершена · код 0');
  assert.equal(sessionStatusLabel({ status: 'ended' }), 'Завершена');
  assert.deepEqual([sessionStatusLabel({ status: 'ended', exitCode: 0, outcome: 'untrusted' }), sessionTone({ status: 'ended', outcome: 'untrusted' })], ['Папка не доверена', 'fail']);
  assert.equal(sessionStatusLabel({ status: 'ended', exitCode: 1, outcome: 'failed' }), 'Не запустилась · код 1');
});

test('строка «Сейчас»: сессия · папка · состояние', () => {
  assert.equal(sessionSub({ cwd: '/Users/me/proj/shop/', status: 'waiting' }), 'сессия · shop · ждёт тебя');
  assert.equal(sessionSub({ cwd: '/p/api', status: 'working' }), 'сессия · api · работает');
});

test('теги на ходу: подсказка у чипа и строка о недоставленном', () => {
  assert.equal(chipHint({ slug: 'a', kind: 'task', state: 'on' }), '');
  assert.match(chipHint({ slug: 'a', kind: 'task', state: 'pending' }), /со следующим своим шагом/);
  assert.equal(pendingNote([{ slug: 'a', kind: 'task', state: 'on' }]), '');
  assert.equal(
    pendingNote([{ slug: 'billing', kind: 'task', state: 'pending' }, { slug: 'legacy-cart', kind: 'task', state: 'removed' }]),
    'billing и снятие legacy-cart дойдут до модели со следующим её шагом или твоим сообщением',
  );
  assert.equal(pendingNote([{ slug: 'b', kind: 'task', state: 'pending' }]), 'b дойдёт до модели со следующим её шагом или твоим сообщением');
});

test('адрес WebSocket — тот же хост, что у страницы', () => {
  assert.equal(sessionWsUrl({ protocol: 'http:', host: '127.0.0.1:4755' }, 'a-b'), 'ws://127.0.0.1:4755/api/sessions/a-b/ws');
  assert.equal(sessionWsUrl({ protocol: 'https:', host: 'x' }, 'a'), 'wss://x/api/sessions/a/ws');
});

test('перетащенный файл: путь экранируется как в Terminal.app, file:// из uri-list — в путь', () => {
  assert.equal(shellPath("/Users/me/Снимок экрана (1)'s.png"), "/Users/me/Снимок\\ экрана\\ \\(1\\)\\'s.png");
  assert.equal(shellPath('/a/b-c_d.txt'), '/a/b-c_d.txt');
  assert.deepEqual(fileUris('# comment\r\nfile:///Users/me/a%20b.png\r\nhttps://x.y/z\nfile://other-host/c'), ['/Users/me/a b.png']);
});

const task = [{ slug: 'checkout', kind: 'task' as const, state: 'on' as const }];
const know = [{ slug: 'api', kind: 'knowledge' as const, state: 'on' as const }];

test('«Обновить саммари»: только с тегом задачи, только когда есть новые ходы и саммари не пишется', () => {
  assert.equal(canSummarize({ chips: know, newTurns: 3 }).show, false);
  assert.deepEqual(canSummarize({ chips: task, newTurns: 0 }), { show: true, ok: false, why: 'Новых ходов с прошлого саммари нет' });
  assert.equal(canSummarize({ chips: task, newTurns: 2, summarizing: true }).ok, false);
  assert.equal(canSummarize({ chips: task, newTurns: 2 }).ok, true);
});

test('состояние саммари: пишется, приложение закрыли, записано, ошибки по тегам; без тегов задач — ничего', () => {
  const now = new Date('2026-10-27T14:55:00');
  const at = new Date('2026-10-27T14:52:00').toISOString();
  assert.equal(summaryNote({ chips: know }), null);
  assert.equal(summaryNote({ chips: task })?.text, 'Саммари тегов задач: не обновлялось');
  assert.equal(summaryNote({ chips: task, summarizing: true })?.text, 'Саммари тегов задач: пишу…');
  assert.deepEqual(summaryNote({ chips: task, summaryPending: 'app-closed' })?.tone, 'warn');
  assert.deepEqual(summaryNote({ chips: task, summary: { at, tags: ['checkout', 'billing'], costUsd: 0.01 } }, now), { text: 'Саммари записано в checkout и billing · 14:52', tone: 'ok', title: '$0.010' });
  const err = summaryNote({ chips: task, summary: { at, tags: ['a'], errors: { b: 'таймаут' }, costUsd: 0 } }, now);
  assert.deepEqual([err?.text, err?.tone, err?.title], ['Саммари записано в a, ошибка в b', 'err', 'b: таймаут']);
});
