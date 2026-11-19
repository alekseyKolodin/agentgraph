import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askNote, canUpdateState, chipHint, endCandidates, fileUris, homeSessionMeta, homeSessions, noTranscriptWhy, osc52Text, pendingNote, sessionEndText, sessionExitTitle, sessionStatusLabel, sessionSub, sessionTone, sessionWsUrl,
  shellPath, spaceChipHint, stateNote,
} from './sessions';

test('статус сессии: подписи и тон точки; выход без SessionStart — отдельный исход', () => {
  assert.deepEqual([sessionStatusLabel({ status: 'working' }), sessionTone({ status: 'working' })], ['Работает', 'live']);
  // ход за человеком без вопроса — просто закончила ход, без тревоги; с вопросом или разрешением — ждёт
  assert.deepEqual([sessionStatusLabel({ status: 'waiting' }), sessionTone({ status: 'waiting' })], ['Ход закончен', 'idle']);
  const at = '2026-11-04T11:00:00Z';
  assert.deepEqual([sessionStatusLabel({ status: 'waiting', ask: { kind: 'question', text: 'Так?', at } }), sessionTone({ status: 'waiting', ask: { kind: 'question', text: 'Так?', at } })], ['Ждёт ответа', 'wait']);
  assert.equal(sessionStatusLabel({ status: 'waiting', ask: { kind: 'permission', text: 'Bash: ls', at } }), 'Ждёт разрешения');
  // у завершённой вопрос — в строке askNote, а статус — «Завершена»
  assert.deepEqual([sessionStatusLabel({ status: 'ended', ask: { kind: 'question', text: 'Так?', at } }), sessionTone({ status: 'ended', ask: { kind: 'question', text: 'Так?', at } })], ['Завершена', 'off']);
  assert.deepEqual([sessionStatusLabel({ status: 'starting' }), sessionTone({ status: 'starting' })], ['Запускается', 'off']);
  assert.equal(sessionStatusLabel({ status: 'ended' }), 'Завершена');
  assert.deepEqual([sessionStatusLabel({ status: 'ended', outcome: 'untrusted' }), sessionTone({ status: 'ended', outcome: 'untrusted' })], ['Папка не доверена', 'fail']);
  assert.equal(sessionStatusLabel({ status: 'ended', outcome: 'failed' }), 'Не запустилась');
});

test('код выхода claude — только в подсказке завершённой сессии, неизвестный — нигде', () => {
  assert.equal(sessionExitTitle({ live: false, exitCode: 129 }), 'Код выхода claude: 129');
  assert.equal(sessionExitTitle({ live: false }), '');
  assert.equal(sessionExitTitle({ live: true, exitCode: 0 }), '');
});

test('карточка завершённой: кто погасил claude словами, а не «код ?» и «код 129»', () => {
  assert.equal(sessionEndText({ endedBy: 'button', exitCode: 129 }), 'Сессию завершили кнопкой «Завершить».');
  assert.equal(sessionEndText({ endedBy: 'app', exitCode: 129 }), 'Claude остановлен вместе с приложением.');
  // запись до endedBy: SIGHUP — значит, погасил agentgraph
  assert.equal(sessionEndText({ exitCode: 129 }), 'Claude остановлен кнопкой «Завершить» или вместе с приложением.');
  assert.equal(sessionEndText({}), 'Claude вышел.');
  assert.equal(sessionEndText({ exitCode: 0 }), 'Claude вышел.');
  assert.equal(sessionEndText({ exitCode: 2 }), 'Claude вышел с кодом 2.');
  assert.match(sessionEndText({ outcome: 'failed' }), /^claude завершился, не начав сессию/);
  assert.match(sessionEndText({ outcome: 'failed', exitCode: 1 }), /^claude завершился с кодом 1, не начав сессию/);
  assert.match(sessionEndText({ outcome: 'untrusted', exitCode: 0 }), /доверие к папке не принято/);
});

test('сессии на главной: с вопросом — в «Ждёт тебя», дольше ждущие сверху; работающие и запускающиеся — в «Идут»; простаивающих и завершённых нет', () => {
  const at = '2026-11-04T11:00:00Z';
  const ask = (when: string) => ({ ask: { kind: 'question' as const, text: 'Так?', at: when } });
  const s = (id: string, status: 'starting' | 'working' | 'waiting' | 'ended', o: object = {}) => ({ id, status, live: status !== 'ended', lastActivityAt: at, ...o });
  const { waiting, live } = homeSessions([s('a', 'waiting', ask('2026-11-04T11:50:00Z')), s('b', 'working'), s('c', 'ended', ask(at)), s('d', 'waiting', ask('2026-11-04T11:10:00Z')), s('e', 'starting'), s('f', 'waiting')]);
  assert.deepEqual([waiting.map((x) => x.id), live.map((x) => x.id)], [['d', 'a'], ['b', 'e']]);
  // пять простаивающих сессий не дают ни одного «ждёт тебя»
  assert.deepEqual(homeSessions(['1', '2', '3', '4', '5'].map((id) => s(id, 'waiting', { waitingSince: at }))), { waiting: [], live: [] });
  // диалог доверия к папке на экране: запускается, но ждёт тебя
  const trust = homeSessions([{ ...s('t', 'starting'), delivery: 'trust' as const }]);
  assert.deepEqual([trust.waiting.map((x) => x.id), trust.live], [['t'], []]);
});

test('строка сессии на главной: пространство (без него — папка), сколько ждёт, ходы', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const base = { cwd: '/p/shop', lastActivityAt: '2026-11-04T11:00:00Z', turns: 3 };
  assert.equal(homeSessionMeta({ ...base, space: 'press-alert', status: 'waiting', waitingSince: '2026-11-04T11:40:00Z', ask: { kind: 'question', text: 'Так?', at: '2026-11-04T11:55:00Z' } }, now), '◇ press-alert · ждёт 5 мин · 3 хода');
  assert.equal(homeSessionMeta({ ...base, status: 'waiting', waitingSince: '2026-11-04T11:55:00Z' }, now), 'shop · ход закончен · 3 хода');
  assert.equal(homeSessionMeta({ ...base, status: 'working', turns: 1 }, now), 'shop · работает · 1 ход');
  assert.equal(homeSessionMeta({ ...base, status: 'starting', turns: 0 }, now), 'shop · запускается');
  assert.equal(homeSessionMeta({ ...base, status: 'starting', delivery: 'trust', turns: 0 }, now), 'shop · ждёт: доверие к папке');
});

test('нет транскрипта у завершённой: не было сообщений — или файл удалили', () => {
  assert.equal(noTranscriptWhy({ turns: 0 }), 'в прошлом не было ни одного сообщения');
  assert.equal(noTranscriptWhy({ turns: 4 }), 'транскрипт прошлого разговора удалён');
});

test('строка «Сейчас»: пространство (без него — папка) · статус · когда была активность', () => {
  assert.equal(sessionSub({ cwd: '/Users/me/proj/shop/', status: 'waiting', ask: { kind: 'question', text: 'Так?', at: '' } }), 'shop · ждёт тебя');
  assert.equal(sessionSub({ cwd: '/Users/me/proj/shop/', status: 'waiting' }), 'shop · ход закончен');
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
  assert.ok(!spaceChipHint({ slug: 'p', state: 'on', memory: true }, true).includes('Перезапустить'));
  // выбрано на ходу и уже дошло: карта — строкой «прочитай», памятью — после перезапуска
  assert.match(spaceChipHint({ slug: 'p', state: 'on' }, true), /выбрано на ходу: карта \(CLAUDE\.md\) — строкой «прочитай»/);
  assert.ok(!spaceChipHint({ slug: 'p', state: 'on' }, false).includes('на ходу'));
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
  // ходы сделаны в прежнем пространстве — кнопка есть и без текущего; в удалённом или без пространства — некуда
  assert.deepEqual(canUpdateState({ newTurns: 2, stateSpaces: ['a'] }), { show: true, ok: true, why: 'Сессия haiku перепишет состояние пространств a: каждому — ходы, сделанные в нём' });
  assert.match(canUpdateState({ space: 'b', newTurns: 3, stateSpaces: ['a', 'b'] }).why, /пространств a, b/);
  assert.equal(canUpdateState({ space: 'b', newTurns: 3, stateSpaces: [] }).ok, false);
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

test('что спросил Claude: у живой — «Спрашивает» и «Просит разрешение», у завершённой — «Закончилась на вопросе»', () => {
  assert.equal(askNote({ live: true }), '');
  assert.equal(askNote({ live: true, ask: { kind: 'question', text: 'Так делать?' } }), 'Спрашивает: Так делать?');
  assert.equal(askNote({ live: true, ask: { kind: 'permission', text: 'Bash: rm -rf build' } }), 'Просит разрешение: Bash: rm -rf build');
  assert.equal(askNote({ live: true, ask: { kind: 'elicitation', text: '' } }), 'Ждёт ответа в форме: …');
  assert.equal(askNote({ live: false, ask: { kind: 'question', text: 'Так делать?' } }), 'Закончилась на вопросе: Так делать?');
  assert.equal(askNote({ live: false, ask: { kind: 'permission', text: 'Bash: ls' } }), 'Закончилась на запросе разрешения: Bash: ls');
});

test('предел живых сессий: завершить предлагают простаивающие (дольше — выше), потом ждущие ответа; работающие и сама сессия — нет', () => {
  const at = (m: number) => `2026-11-04T11:${String(m).padStart(2, '0')}:00Z`;
  const s = (id: string, status: 'working' | 'waiting' | 'ended', since: number, asked = false) => ({ id, status, live: status !== 'ended', lastActivityAt: at(since), waitingSince: at(since), ...(asked ? { ask: { kind: 'question' as const, text: '?', at: at(since) } } : {}) });
  const list = [s('q', 'waiting', 1, true), s('w', 'working', 2), s('i2', 'waiting', 30), s('i1', 'waiting', 10), s('e', 'ended', 0), s('me', 'waiting', 0)];
  assert.deepEqual(endCandidates(list, 'me').map((x) => x.id), ['i1', 'i2', 'q']);
});
