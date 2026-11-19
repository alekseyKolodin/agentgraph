import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackable, watch, watchers } from './index.js';
import { mrThing } from './resolve.js';
import type { Thing, ThingState, Watcher } from './types.js';

const state = (title: string): ThingState => ({ exists: true, turn: 'me', why: 'автор ответил', title, updatedAt: '2026-11-19T10:00:00Z', facts: {} });
const mr = (n: number, host = 'gitlab.com') => mrThing({ forge: 'gitlab', host, project: 'g/app', number: n });
const jira: Thing = { type: 'jira', key: 'jira:acme.atlassian.net/ABC-1', ref: { host: 'acme.atlassian.net', key: 'ABC-1' } };

function fakeWatcher(over: Partial<Watcher> & { calls?: Thing[][] } = {}): Watcher & { calls: Thing[][] } {
  const calls: Thing[][] = over.calls ?? [];
  return {
    type: 'mr',
    everyMs: 60_000,
    canWatch: (t) => (String(t.ref.host) === 'closed.corp' ? 'нет доступа к closed.corp: выполните glab auth login' : true),
    state: async (things) => {
      calls.push([...things]);
      return new Map(things.map((t) => [t.key, state(String(t.ref.number))]));
    },
    ...over,
    calls,
  };
}

test('реестр: по одному наблюдателю на MR, задачу Jira и ветку', () => {
  assert.deepEqual(watchers().map((w) => w.type).sort(), ['branch', 'jira', 'mr']);
});

test('watch: повторы ключей — один запрос, каждый наблюдатель получает только свои вещи', async () => {
  const w = fakeWatcher();
  const jiraCalls: Thing[][] = [];
  const j = fakeWatcher({ type: 'jira', calls: jiraCalls, canWatch: () => true });
  const out = await watch([mr(1), mr(2), mr(1), jira], new AbortController().signal, [w, j]);
  assert.deepEqual(w.calls.map((c) => c.map((t) => t.key)), [['mr:gitlab.com/g/app/1', 'mr:gitlab.com/g/app/2']]);
  assert.deepEqual(jiraCalls.map((c) => c.map((t) => t.key)), [['jira:acme.atlassian.net/ABC-1']]);
  assert.equal(out.size, 3);
  assert.equal(out.get(mr(2).key)?.title, '2');
});

test('watch: вещи без наблюдателя и без доступа в карту не попадают, trackable говорит почему', async () => {
  const w = fakeWatcher();
  const thread: Thing = { type: 'thread', key: 'thread:s/c/1', ref: {} };
  const out = await watch([mr(1, 'closed.corp'), thread, jira], new AbortController().signal, [w]);
  assert.equal(out.size, 0);
  assert.deepEqual(w.calls, []);
  assert.match(String(trackable(mr(1, 'closed.corp'), [w])), /glab auth login/);
  assert.match(String(trackable(thread, [w])), /наблюдателя нет/);
  assert.match(String(trackable(jira, [w])), /наблюдателя для «jira» нет/);
  assert.equal(trackable(mr(1), [w]), true);
});

test('watch: наблюдатель упал или не вернул вещь — exists: false с причиной, исключения наружу не идут', async () => {
  const broken = fakeWatcher({ state: async () => Promise.reject(new Error('glab: 401 Unauthorized')) });
  const out = await watch([mr(1)], new AbortController().signal, [broken]);
  assert.equal(out.get(mr(1).key)?.exists, false);
  assert.match(out.get(mr(1).key)!.error!, /не ответил: glab: 401/);
  const partial = fakeWatcher({ state: async (things) => new Map([[things[0].key, state('один')]]) });
  const out2 = await watch([mr(1), mr(2)], new AbortController().signal, [partial]);
  assert.equal(out2.get(mr(1).key)?.exists, true);
  assert.equal(out2.get(mr(2).key)?.exists, false);
  assert.match(out2.get(mr(2).key)!.error!, /не вернул состояние/);
  // canWatch кинул — вещь не отслеживается, а не роняет проверку
  const odd = fakeWatcher({ canWatch: () => { throw new Error('странный ref'); } });
  assert.equal(trackable(mr(1), [odd]), 'странный ref');
  assert.equal((await watch([mr(1)], new AbortController().signal, [odd])).size, 0);
});

test('watch: прерванная проверка — отказ, а не карта «вещи пропали»', async () => {
  const ac = new AbortController();
  const slow = fakeWatcher({
    state: async (things, signal) => {
      ac.abort(new Error('приложение закрывается'));
      if (signal.aborted) throw new Error('aborted');
      return new Map(things.map((t) => [t.key, state('x')]));
    },
  });
  await assert.rejects(() => watch([mr(1)], ac.signal, [slow]), /приложение закрывается/);
});
