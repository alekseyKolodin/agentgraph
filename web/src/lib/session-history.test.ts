import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historySub, historyTitle, SESSION_GROUP_LIMIT, sessionGroupKey, sessionHistory, type HistorySession } from './session-history';

const at = (min: number) => new Date(Date.UTC(2026, 10, 4, 12, 0) - min * 60000).toISOString();
const ses = (id: string, over: Partial<HistorySession> = {}): HistorySession => ({
  id, name: 'Kai', cwd: '/Users/me/Kai', live: false, lastActivityAt: at(0), turns: 1, ...over,
});

const shop = { space: 'shop', title: 'Магазин' };

test('история сессий: только завершённые, группы по проекту с сервера от свежих, «Без проекта» — своей группой', () => {
  const list = [
    ses('live', { live: true, space: 'shop', lastActivityAt: at(0), projectRef: shop }),
    ses('a', { space: 'shop', endedAt: at(30), projectRef: shop }),
    ses('b', { endedAt: at(10), projectRef: { space: null, title: 'Без проекта' } }),
    ses('c', { space: 'kai', endedAt: at(60), projectRef: { space: 'kai', title: 'kai' } }),
    // без пространства, но в репозитории проекта — в группе проекта, как его запуски
    ses('d', { endedAt: at(5), projectRef: shop }),
  ];
  const groups = sessionHistory(list, null, new Set());
  assert.deepEqual(groups.map((g) => [g.label, g.sessions.map((s) => s.id)]), [['◇ Магазин', ['d', 'a']], ['Без проекта', ['b']], ['◇ kai', ['c']]]);
  assert.equal(groups[0]!.key, sessionGroupKey('shop'));
  assert.equal(groups[1]!.key, 'sspace:');
  assert.equal(groups[0]!.title, 'Проект — пространство shop');
  assert.deepEqual(sessionHistory([ses('x', { live: true })], null, new Set()), []);
});

test('история сессий: первые N и «ещё N»; раскрытый хвост и открытая за лимитом — вся группа', () => {
  const list = Array.from({ length: SESSION_GROUP_LIMIT + 2 }, (_, i) => ses(`s${i}`, { space: 'shop', endedAt: at(i), projectRef: shop }));
  const [g] = sessionHistory(list, null, new Set());
  assert.deepEqual([g!.count, g!.sessions.length, g!.more], [SESSION_GROUP_LIMIT + 2, SESSION_GROUP_LIMIT, 2]);
  assert.equal(sessionHistory(list, null, new Set([sessionGroupKey('shop')]))[0]!.more, 0);
  assert.equal(sessionHistory(list, `s${SESSION_GROUP_LIMIT + 1}`, new Set())[0]!.sessions.length, SESSION_GROUP_LIMIT + 2);
});

test('подпись строки истории: исход, папка — только без пространства, когда и ходы; подсказка — имя, пространство, папка', () => {
  const now = new Date(Date.UTC(2026, 10, 4, 12, 0));
  assert.deepEqual(historySub(ses('a', { endedAt: at(5), turns: 3 }), true, now), { outcome: '', rest: 'Kai · 5 мин назад · 3 хода' });
  assert.deepEqual(historySub(ses('a', { endedAt: at(5), turns: 0, outcome: 'failed' }), false, now), { outcome: 'не запустилась', rest: '5 мин назад · 0 ходов' });
  assert.equal(historySub(ses('a', { outcome: 'untrusted', turns: 1 }), false, now).outcome, 'папка не доверена');
  // без endedAt — по последней активности
  assert.equal(historySub(ses('a', { lastActivityAt: at(1), turns: 21 }), false, now).rest, '1 мин назад · 21 ход');
  const title = historyTitle(ses('a', { space: 'shop', projectRef: shop })).split('\n');
  assert.deepEqual(title.slice(0, 3), ['Kai', '◇ Магазин', '/Users/me/Kai']);
  assert.match(title[3]!, /^последняя активность /);
});
