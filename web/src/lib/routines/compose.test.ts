import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectNeedHref, dropStash, readStash, stashDraft } from './compose.js';
import { emptyDraft } from './spec.js';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

test('черновик переживает уход на подключение: читается сколько угодно раз, пока его не забыли', () => {
  const s = memory();
  assert.equal(readStash(s), undefined);
  stashDraft({ ...emptyDraft(), title: 'Ревью', flow: 'review-mr' }, s);
  assert.equal(readStash(s)?.flow, 'review-mr');
  assert.equal(readStash(s)?.title, 'Ревью');
  dropStash(s);
  assert.equal(readStash(s), undefined);
});

test('мусор в хранилище и его отсутствие — не ошибка', () => {
  const s = memory();
  s.setItem('agentgraph.routineCompose', '{не json');
  assert.equal(readStash(s), undefined);
  s.setItem('agentgraph.routineCompose', '{"x":1}');
  assert.equal(readStash(s), undefined);
  // хранилище бросает (частное окно, переполнено) — форма просто откроется без черновика
  const broken = { getItem: () => { throw new Error('нет'); }, setItem: () => { throw new Error('нет'); }, removeItem: () => { throw new Error('нет'); } };
  assert.doesNotThrow(() => stashDraft(emptyDraft(), broken));
  assert.equal(readStash(broken), undefined);
  assert.doesNotThrow(() => dropStash(broken));
});

test('ссылка на подключение: готовый вид — kind, иначе описание словами в q', () => {
  assert.equal(connectNeedHref({ description: 'сообщения', kind: 'slack' }), '/routines/connect?from=new&kind=slack');
  const u = new URL(connectNeedHref({ description: 'записи встреч в Fireflies' }), 'http://x');
  assert.equal(u.searchParams.get('q'), 'записи встреч в Fireflies');
  assert.equal(u.searchParams.get('kind'), null);
  assert.equal(u.searchParams.get('from'), 'new');
});
