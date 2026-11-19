import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Profile } from '../api-types.js';
import type { FetchFn } from '../jira.js';
import { describeChange, jiraWatcher } from './jira.js';
import type { Thing } from './types.js';

const cfg = { baseUrl: 'https://example.atlassian.net/', email: 'dev@example.com' };
const HOST = 'example.atlassian.net';
const profile: Profile = { names: ['Борис Иванов'], emails: ['boris@example.com'] };
const signal = new AbortController().signal;

const thing = (key = 'ABC-1', host = HOST): Thing => ({ type: 'jira', key: `jira:${host}/${key}`, ref: { host, key } });

type Issue = { status?: string; category?: string; assignee?: { accountId: string; displayName: string; emailAddress?: string } | null; updated?: string };
type World = { issues: Record<string, Issue | 404 | 403>; changelog: Record<string, unknown[]>; me?: { accountId: string; displayName: string } };

/** Фейковая Jira: задачи по ключу, история изменений, myself. */
function fakeJira(w: World) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    const path = url.replace('https://example.atlassian.net', '');
    calls.push(path);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path.startsWith('/rest/api/3/myself')) return json({ accountId: w.me?.accountId ?? 'acc-me', displayName: w.me?.displayName ?? 'Борис Иванов' });
    const ch = path.match(/\/issue\/([A-Z0-9-]+)\/changelog/);
    if (ch) return json({ isLast: true, total: (w.changelog[ch[1]] ?? []).length, values: w.changelog[ch[1]] ?? [] });
    const is = path.match(/\/issue\/([A-Z0-9-]+)\?/);
    if (is) {
      const i = w.issues[is[1]];
      if (i === 404 || i === undefined) return json({ errorMessages: ['Issue does not exist'] }, 404);
      if (i === 403) return json({ errorMessages: ['нет'] }, 403);
      return json({ key: is[1], fields: { summary: `Задача ${is[1]}`, status: { name: i.status ?? 'In Progress', statusCategory: { key: i.category ?? 'indeterminate' } }, issuetype: { name: 'Task' }, updated: i.updated ?? '2026-11-10T10:00:00.000+0000', assignee: i.assignee ?? null } });
    }
    return json({}, 500);
  }) as unknown as FetchFn;
  return { fn, calls };
}

const history = (created: string, author: string, field: string, from: string, to: string) => ({ created, author: { displayName: author }, items: [{ field, fromString: from, toString: to }] });

const watcher = (f: ReturnType<typeof fakeJira>, p: Profile = profile) => jiraWatcher({ creds: () => ({ cfg, token: 't' }), profile: () => p, fetch: f.fn, now: () => Date.parse('2026-11-18T12:00:00Z') });

test('Jira: задача на мне — мой ход, статус в why, факты для карточки', async () => {
  const f = fakeJira({ issues: { 'ABC-1': { status: 'В работе', assignee: { accountId: 'acc-me', displayName: 'Борис Иванов' } } }, changelog: {} });
  const st = (await watcher(f).state([thing()], signal)).get('jira:example.atlassian.net/ABC-1')!;
  assert.equal(st.exists, true);
  assert.equal(st.turn, 'me');
  assert.equal(st.closed, undefined);
  assert.equal(st.title, 'Задача ABC-1');
  assert.match(st.why, /назначена на вас · статус «В работе»/);
  assert.equal(st.facts.assigneeIsMe, true);
  assert.equal(st.facts.url, 'https://example.atlassian.net/browse/ABC-1');
});

test('Jira: статус из категории «Готово» — закрыта, ход ничей', async () => {
  const f = fakeJira({ issues: { 'ABC-1': { status: 'Готово', category: 'done', assignee: { accountId: 'acc-me', displayName: 'Борис Иванов' } } }, changelog: {} });
  const st = (await watcher(f).state([thing()], signal)).get('jira:example.atlassian.net/ABC-1')!;
  assert.equal(st.closed, 'done');
  assert.equal(st.turn, 'none');
  assert.equal(st.why, 'статус «Готово»');
});

test('Jira: «я» узнаётся и по профилю, когда accountId не совпал (имя, почта)', async () => {
  const byName = fakeJira({ issues: { 'ABC-1': { assignee: { accountId: 'other', displayName: 'борис иванов' } } }, changelog: {}, me: { accountId: 'x', displayName: '?' } });
  assert.equal((await watcher(byName).state([thing()], signal)).get('jira:example.atlassian.net/ABC-1')!.turn, 'me');
  const byMail = fakeJira({ issues: { 'ABC-1': { assignee: { accountId: 'other', displayName: 'B.', emailAddress: 'Boris@example.com' } } }, changelog: {}, me: { accountId: 'x', displayName: '?' } });
  assert.equal((await watcher(byMail).state([thing()], signal)).get('jira:example.atlassian.net/ABC-1')!.turn, 'me');
});

test('Jira: сняли с меня — ход ничей, «переназначили на …» (по истории и по прошлому снимку)', async () => {
  // по changelog: исполнитель был «Борис Иванов»
  const f = fakeJira({
    issues: { 'ABC-1': { assignee: { accountId: 'acc-ann', displayName: 'Анна Петрова' } } },
    changelog: { 'ABC-1': [history('2026-11-09T10:00:00.000+0000', 'Лид', 'assignee', 'Борис Иванов', 'Анна Петрова')] },
  });
  const st = (await watcher(f).state([thing()], signal)).get('jira:example.atlassian.net/ABC-1')!;
  assert.equal(st.turn, 'none');
  assert.equal(st.closed, undefined);
  assert.match(st.why, /^переназначили на Анна Петрова/);
  assert.equal(st.facts.reassignedFromMe, true);

  // по прошлому снимку: истории нет, но раньше задача была на мне
  const world: World = { issues: { 'ABC-2': { assignee: { accountId: 'acc-me', displayName: 'Борис Иванов' } } }, changelog: {} };
  const w = watcher(fakeJira(world));
  assert.equal((await w.state([thing('ABC-2')], signal)).get('jira:example.atlassian.net/ABC-2')!.turn, 'me');
  world.issues['ABC-2'] = { assignee: { accountId: 'acc-ann', displayName: 'Анна Петрова' } };
  const moved = (await w.state([thing('ABC-2')], signal)).get('jira:example.atlassian.net/ABC-2')!;
  assert.match(moved.why, /^переназначили на Анна Петрова/);
  // чужая задача, которая никогда не была на мне, «переназначенной» не называется
  const other = (await watcher(fakeJira({ issues: { 'ABC-3': { assignee: { accountId: 'acc-ann', displayName: 'Анна Петрова' } } }, changelog: {} })).state([thing('ABC-3')], signal)).get('jira:example.atlassian.net/ABC-3')!;
  assert.match(other.why, /^исполнитель — Анна Петрова/);
});

test('Jira: чужая задача из ссылки — «исполнитель — …», без исполнителя — «не назначена»', async () => {
  const f = fakeJira({ issues: { 'ABC-1': { assignee: { accountId: 'acc-ann', displayName: 'Анна Петрова' } }, 'ABC-2': {} }, changelog: {} });
  const m = await watcher(f).state([thing('ABC-1'), thing('ABC-2')], signal);
  assert.match(m.get('jira:example.atlassian.net/ABC-1')!.why, /^исполнитель — Анна Петрова/);
  assert.equal(m.get('jira:example.atlassian.net/ABC-2')!.why, 'исполнитель не назначен');
  assert.equal(m.get('jira:example.atlassian.net/ABC-2')!.turn, 'none');
});

test('Jira: что изменилось с прошлого раза — по changelog, при первом взгляде только в facts', async () => {
  const world: World = {
    issues: { 'ABC-1': { status: 'Ревью', assignee: { accountId: 'acc-me', displayName: 'Борис Иванов' } } },
    changelog: { 'ABC-1': [history('2026-11-09T10:00:00.000+0000', 'Анна', 'status', 'Todo', 'В работе')] },
  };
  const f = fakeJira(world);
  const w = watcher(f);
  const first = (await w.state([thing()], signal)).get('jira:example.atlassian.net/ABC-1')!;
  assert.doesNotMatch(first.why, /изменилось/);
  assert.equal((first.facts.changes as unknown[]).length, 1);

  const same = (await w.state([thing()], signal)).get('jira:example.atlassian.net/ABC-1')!;
  assert.doesNotMatch(same.why, /изменилось/);
  assert.deepEqual(same.facts.changes, []);

  world.changelog['ABC-1'].push(history('2026-11-10T09:00:00.000+0000', 'Анна', 'status', 'В работе', 'Ревью'), history('2026-11-10T09:05:00.000+0000', 'Анна', 'priority', 'Low', 'High'), history('2026-11-10T09:06:00.000+0000', 'Анна', 'description', 'a', 'b'));
  const next = (await w.state([thing()], signal)).get('jira:example.atlassian.net/ABC-1')!;
  assert.match(next.why, /изменилось: статус: В работе → Ревью \(Анна\); приоритет: Low → High \(Анна\) и ещё 1$/);
});

test('Jira: описание изменения — по-русски, без простыни описания', () => {
  assert.equal(describeChange({ at: '', author: 'Анна', field: 'status', from: 'Todo', to: '' }), 'статус: Todo → — (Анна)');
  assert.equal(describeChange({ at: '', author: '', field: 'description', from: 'длинно', to: 'ещё' }), 'описание изменено');
  assert.equal(describeChange({ at: '', author: '', field: 'Fix Version', from: '', to: '1.2' }), 'Fix Version: — → 1.2');
});

test('Jira: нет доступа или задачи — exists: false с понятной error, исключения наружу не идут', async () => {
  const f = fakeJira({ issues: { 'ABC-1': 404, 'ABC-2': 403 }, changelog: {} });
  const m = await watcher(f).state([thing('ABC-1'), thing('ABC-2')], signal);
  const a = m.get('jira:example.atlassian.net/ABC-1')!;
  assert.equal(a.exists, false);
  assert.match(a.error!, /Задача ABC-1 не найдена или нет доступа/);
  const b = m.get('jira:example.atlassian.net/ABC-2')!;
  assert.equal(b.exists, false);
  assert.match(b.error!, /403.*нет доступа/);
});

test('Jira: Jira не подключена или чужой хост — canWatch объясняет, state не падает', async () => {
  const f = fakeJira({ issues: {}, changelog: {} });
  const w = watcher(f);
  assert.equal(w.canWatch(thing()), true);
  assert.match(String(w.canWatch(thing('ABC-1', 'other.atlassian.net'))), /other\.atlassian\.net не подключена \(подключена example\.atlassian\.net\)/);
  assert.match(String(w.canWatch({ type: 'jira', key: 'k', ref: {} })), /нет адреса Jira/);
  const none = jiraWatcher({ creds: () => undefined, profile: () => profile });
  assert.match(String(none.canWatch(thing())), /Jira не подключена/);
  const m = await none.state([thing()], signal);
  assert.equal(m.get('jira:example.atlassian.net/ABC-1')!.exists, false);
  assert.match(m.get('jira:example.atlassian.net/ABC-1')!.error!, /Jira не подключена/);
  assert.equal(f.calls.length, 0);
});

test('Jira: сеть упала — состояние с error, токен в ошибку не попадает', async () => {
  const fn = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as FetchFn;
  const m = await jiraWatcher({ creds: () => ({ cfg, token: 'secret-token-123' }), profile: () => profile, fetch: fn }).state([thing()], signal);
  const st = m.get('jira:example.atlassian.net/ABC-1')!;
  assert.equal(st.exists, false);
  assert.match(st.error!, /Jira недоступна: connect ECONNREFUSED/);
  assert.ok(!st.error!.includes('secret-token-123'));
});

test('Jira: адрес подключения с «www.», портом по умолчанию и точкой в конце — тот же хост, что в ключе вещи', async () => {
  const f = fakeJira({ issues: {}, changelog: {} });
  for (const baseUrl of ['https://www.example.atlassian.net/', 'https://Example.Atlassian.net:443', 'https://example.atlassian.net./']) {
    const w = jiraWatcher({ creds: () => ({ cfg: { ...cfg, baseUrl }, token: 't' }), profile: () => profile, fetch: f.fn });
    assert.equal(w.canWatch(thing()), true, baseUrl);
  }
  // и обратная сторона: в ref вещи хост записан с «www.» — для той же Jira
  const w = watcher(f);
  assert.equal(w.canWatch(thing('ABC-1', 'www.example.atlassian.net')), true);
  assert.match(String(w.canWatch(thing('ABC-1', 'www.other.atlassian.net'))), /other\.atlassian\.net не подключена/);
});
