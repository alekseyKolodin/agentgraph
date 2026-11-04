import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canUpdateState, chipHint, fileUris, osc52Text, pendingNote, sessionStatusLabel, sessionSub, sessionTone, sessionWsUrl, shellPath, spaceChipHint, stateNote,
} from './sessions';

test('статус сессии: подписи и тон точки; выход без SessionStart — отдельный исход', () => {
  assert.deepEqual([sessionStatusLabel({ status: 'working' }), sessionTone({ status: 'working' })], ['Работает', 'live']);
  assert.deepEqual([sessionStatusLabel({ status: 'waiting' }), sessionTone({ status: 'waiting' })], ['Ждёт тебя', 'wait']);
  assert.deepEqual([sessionStatusLabel({ status: 'starting' }), sessionTone({ status: 'starting' })], ['Запускается', 'off']);
  assert.equal(sessionStatusLabel({ status: 'ended', exitCode: 0 }), 'Завершена · код 0');
  assert.equal(sessionStatusLabel({ status: 'ended' }), 'Завершена');
  assert.deepEqual([sessionStatusLabel({ status: 'ended', exitCode: 0, outcome: 'untrusted' }), sessionTone({ status: 'ended', outcome: 'untrusted' })], ['Папка не доверена', 'fail']);
  assert.equal(sessionStatusLabel({ status: 'ended', exitCode: 1, outcome: 'failed' }), 'Не запустилась · код 1');
});

test('строка «Сейчас»: пространство (без него — папка) · статус · когда была активность', () => {
  assert.equal(sessionSub({ cwd: '/Users/me/proj/shop/', status: 'waiting' }), 'shop · ждёт тебя');
  assert.equal(sessionSub({ cwd: '/p/api', status: 'working' }), 'api · работает');
  // пространство вместо папки и время последней активности: три сессии в одной папке различимы
  const now = new Date('2026-11-04T12:00:00Z');
  assert.equal(sessionSub({ cwd: '/p/api', status: 'working', space: 'press-alert', lastActivityAt: '2026-11-04T11:55:00Z' }, now), '◇ press-alert · работает · 5 мин назад');
});

test('пространство и теги на ходу: подсказка у чипа и строка о недоставленном', () => {
  assert.equal(chipHint({ state: 'on' }), '');
  assert.match(chipHint({ state: 'pending' }), /со следующим своим шагом/);
  assert.equal(pendingNote([{ slug: 'a', state: 'on' }]), '');
  assert.equal(
    pendingNote([{ slug: 'billing', state: 'pending' }, { slug: 'legacy-cart', state: 'removed' }]),
    'billing и снятие legacy-cart дойдут до модели со следующим её шагом или твоим сообщением',
  );
  assert.equal(pendingNote([{ slug: 'b', state: 'pending' }]), 'b дойдёт до модели со следующим её шагом или твоим сообщением');
  assert.match(spaceChipHint({ slug: 'p', state: 'pending' }, true), /«Перезапустить»/);
  assert.ok(!spaceChipHint({ slug: 'p', state: 'on' }, true).includes('Перезапустить'));
  assert.match(spaceChipHint({ slug: 'p', state: 'on', missing: true }, true), /Пространства p больше нет/);
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

test('«Обновить состояние»: только с пространством (не удалённым), только когда есть новые ходы и состояние не пишется', () => {
  assert.equal(canUpdateState({ newTurns: 3 }).show, false);
  assert.equal(canUpdateState({ space: 'p', spaceChip: { slug: 'p', state: 'on', missing: true }, newTurns: 3 }).show, false);
  assert.deepEqual(canUpdateState({ space: 'p', newTurns: 0 }), { show: true, ok: false, why: 'Новых ходов с прошлого обновления нет' });
  assert.equal(canUpdateState({ space: 'p', newTurns: 2, updatingState: true }).ok, false);
  assert.equal(canUpdateState({ space: 'p', newTurns: 2 }).ok, true);
});

test('состояние пространства: пишется, приложение закрыли, записано, ошибка; без пространства — ничего', () => {
  const now = new Date('2026-10-27T14:55:00');
  const at = new Date('2026-10-27T14:52:00').toISOString();
  assert.equal(stateNote({}), null);
  assert.equal(stateNote({ space: 'p' })?.text, 'Состояние пространства: не обновлялось');
  assert.equal(stateNote({ space: 'p', updatingState: true })?.text, 'Состояние пространства: пишу…');
  assert.equal(stateNote({ space: 'p', statePending: 'app-closed' })?.tone, 'warn');
  assert.deepEqual(stateNote({ space: 'p', stateUpdate: { at, space: 'p', ok: true, costUsd: 0.01 } }, now), { text: 'Состояние записано в p · 14:52', tone: 'ok', title: '$0.010' });
  const err = stateNote({ space: 'p', stateUpdate: { at, space: 'p', ok: false, error: 'таймаут', costUsd: 0 } }, now);
  assert.deepEqual([err?.text, err?.tone, err?.title], ['Состояние не записано: ошибка', 'err', 'таймаут']);
});

test('OSC 52: текст из base64 в UTF-8, любой буфер; запрос буфера, пустое и не base64 — null', () => {
  const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  assert.equal(osc52Text('c;ZWxsbyBjb3B5IHRlc3Q='), 'ello copy test');
  assert.equal(osc52Text(`;${b64('корзина ✓\nвторая строка')}`), 'корзина ✓\nвторая строка');
  assert.equal(osc52Text(`p;${b64('x')}`), 'x');
  assert.equal(osc52Text('c;?'), null);
  assert.equal(osc52Text('c;'), null);
  assert.equal(osc52Text('нет-разделителя'), null);
  assert.equal(osc52Text('c;не base64!'), null);
});
