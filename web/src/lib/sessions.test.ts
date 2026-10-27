import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipHint, fileUris, pendingNote, sessionStatusLabel, sessionSub, sessionTone, sessionWsUrl, shellPath } from './sessions';

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
