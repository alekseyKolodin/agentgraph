import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { ASSIGNED_TO_ME_JQL, JIRA_SEARCH_PATH } from '../../jira.js';
import { jiraKind, resetJiraState } from './jira.js';
import { fakeFetch, makeCtx } from './testkit.js';

beforeEach(() => {
  resetJiraState();
  clock = Date.parse('2026-11-17T10:00:00Z');
});

const creds = { cfg: { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.com' }, token: 'jira-secret' };
const profile = () => ({ names: ['Борис Иванов'], emails: [] });
let clock = Date.parse('2026-11-17T10:00:00Z');
const deps = { creds: () => creds, profile, now: () => clock };
const issue = (key: string, updated: string, extra: Record<string, unknown> = {}) => ({
  key,
  fields: { summary: `Задача ${key}`, status: { name: 'В работе', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Bug' }, priority: { name: 'High' }, updated, ...extra },
});

type Hist = { created: string; author: string; field: string; from?: string; to?: string };
const entry = (h: Hist) => ({ created: h.created, author: { displayName: h.author }, items: [{ field: h.field, fromString: h.from ?? '', toString: h.to ?? '' }] });

/** Фейковая Jira: выборка, история по ключу (history[key]), myself, комментарий. */
function jiraApi(issues: Array<ReturnType<typeof issue>>, history: Record<string, Hist[]> = {}, created: Record<string, string> = {}, broken: { changelog?: boolean; myself?: boolean } = {}) {
  return fakeFetch(({ url, method, body }) => {
    if (url.pathname === JIRA_SEARCH_PATH) return { issues };
    if (url.pathname === '/rest/api/3/myself') return broken.myself ? new Response('busy', { status: 429 }) : { accountId: 'acc-me', displayName: 'Борис Иванов' };
    if (url.pathname.startsWith('/rest/api/3/issue/') && url.pathname.endsWith('/comment') && method === 'POST') return { id: '555', created: '2026-11-17T12:00:01.000Z', body };
    const ch = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/changelog$/.exec(url.pathname);
    if (ch) {
      if (broken.changelog) return new Response('busy', { status: 503 });
      const list = (history[ch[1]] ?? []).map(entry);
      return { isLast: true, total: list.length, values: list };
    }
    const m = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(url.pathname);
    if (m) return issue(m[1], '2026-11-17T10:00:00.000+0000', { description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Подробное описание' }] }] }, assignee: { accountId: 'acc-ann', displayName: 'Анна' }, created: created[m[1]] ?? '2026-01-01T00:00:00.000+0000' });
    return new Response('nope', { status: 404 });
  });
}

test('Jira: самый первый опрос — события «задача в выборке» без запросов истории; вещь jira, токен не в событии', async () => {
  const { fetch, calls } = jiraApi([issue('ABC-1', '2026-11-17T10:00:00.000+0000')]);
  const ctx = makeCtx({ slug: 'jira', config: { jql: 'project = ABC ORDER BY updated DESC' }, fetch });
  const [e] = await jiraKind(deps).poll!(ctx);
  assert.equal(e.id, 'ABC-1@new@2026-11-17T10:00:00.000+0000');
  assert.equal(e.title, 'ABC-1 Задача ABC-1');
  assert.match(e.text, /Новая задача в вашей выборке/);
  assert.match(e.text, /Статус: В работе · Тип: Bug · Приоритет: High/);
  assert.match(e.text, /Подробное описание/);
  assert.equal(e.link, 'https://acme.atlassian.net/browse/ABC-1');
  assert.equal(e.fields.status, 'В работе');
  assert.equal(e.fields.change, 'new');
  assert.deepEqual(e.replyTo, { key: 'ABC-1' });
  assert.equal(e.things?.length, 1);
  assert.equal(e.things![0].type, 'jira');
  assert.equal(e.things![0].key, 'jira:acme.atlassian.net/ABC-1');
  assert.deepEqual(e.things![0].ref, { host: 'acme.atlassian.net', key: 'ABC-1' });
  const search = calls.find((c) => c.url.pathname === JIRA_SEARCH_PATH)!;
  assert.equal((search.body as { jql: string }).jql, 'project = ABC ORDER BY updated DESC');
  assert.ok(search.headers.authorization.startsWith('Basic '));
  assert.ok(!JSON.stringify(e).includes('jira-secret'));
  assert.ok(!calls.some((c) => c.url.pathname.endsWith('/changelog')), 'на первом опросе историю не читаем');
});

test('Jira: без своего JQL берётся пресет «назначено на меня»', async () => {
  const { fetch, calls } = jiraApi([]);
  await jiraKind(deps).poll!(makeCtx({ config: {}, fetch }));
  assert.equal((calls.find((c) => c.url.pathname === JIRA_SEARCH_PATH)!.body as { jql: string }).jql, ASSIGNED_TO_ME_JQL);
});

test('Jira: ничего не изменилось — события нет, описание и история не перезапрашиваются', async () => {
  const { fetch, calls } = jiraApi([issue('ABC-1', '2026-11-17T10:00:00.000+0000')]);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind(deps);
  assert.equal((await kind.poll!(ctx)).length, 1);
  assert.deepEqual(await kind.poll!(ctx), []);
  assert.equal(calls.filter((c) => /\/issue\/ABC-1$/.test(c.url.pathname)).length, 1);
  assert.ok(!calls.some((c) => c.url.pathname.endsWith('/changelog')));
});

test('Jira: назначили на меня — событие assigned с вещью, кто назначил и что поменялось', async () => {
  const history: Record<string, Hist[]> = { 'ABC-1': [] };
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch } = jiraApi(list, history);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind(deps);
  await kind.poll!(ctx);
  list[0] = issue('ABC-1', '2026-11-17T11:00:00.000+0000');
  history['ABC-1'] = [
    { created: '2026-11-17T09:00:00.000+0000', author: 'Анна', field: 'status', from: 'Todo', to: 'В работе' }, // до прошлого раза
    { created: '2026-11-17T10:55:00.000+0000', author: 'Лид', field: 'assignee', from: 'Анна', to: 'Борис Иванов' },
    { created: '2026-11-17T10:56:00.000+0000', author: 'Лид', field: 'priority', from: 'Low', to: 'High' },
  ];
  const [e] = await kind.poll!(ctx);
  assert.equal(e.fields.change, 'assigned');
  assert.equal(e.fields.assigned_to_me, true);
  assert.equal(e.id, 'ABC-1@assigned@2026-11-17T10:55:00.000+0000');
  assert.equal(e.at, '2026-11-17T10:55:00.000Z');
  assert.match(e.text, /^Назначили на вас: исполнитель: Анна → Борис Иванов \(Лид\)/);
  assert.deepEqual(e.fields.changed_fields, ['assignee']);
  assert.deepEqual(e.fields.changed_by, ['Лид']);
  assert.equal(e.things![0].key, 'jira:acme.atlassian.net/ABC-1');
});

test('Jira: что изменилось — одно событие на задачу за опрос, список правок, прошлое не повторяется', async () => {
  const history: Record<string, Hist[]> = { 'ABC-1': [{ created: '2026-11-17T09:00:00.000+0000', author: 'Анна', field: 'status', from: 'Todo', to: 'В работе' }] };
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch } = jiraApi(list, history);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind(deps);
  await kind.poll!(ctx);
  list[0] = issue('ABC-1', '2026-11-17T12:00:00.000+0000');
  history['ABC-1'].push(
    { created: '2026-11-17T11:00:00.000+0000', author: 'Анна', field: 'status', from: 'В работе', to: 'Ревью' },
    { created: '2026-11-17T11:30:00.000+0000', author: 'Анна', field: 'priority', from: 'High', to: 'Low' },
  );
  const events = await kind.poll!(ctx);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.fields.change, 'changed');
  assert.equal(e.fields.assigned_to_me, false);
  assert.deepEqual(e.fields.changes, ['статус: В работе → Ревью (Анна)', 'приоритет: High → Low (Анна)']);
  assert.deepEqual(e.fields.changed_fields, ['status', 'priority']);
  assert.match(e.text, /^Изменилось: статус: В работе → Ревью \(Анна\); приоритет: High → Low \(Анна\)/);
  assert.equal(e.id, 'ABC-1@changed@2026-11-17T11:30:00.000+0000');
  // следующая правка — только она
  list[0] = issue('ABC-1', '2026-11-17T13:00:00.000+0000');
  history['ABC-1'].push({ created: '2026-11-17T12:45:00.000+0000', author: 'Анна', field: 'summary', from: 'a', to: 'b' });
  const next = await kind.poll!(ctx);
  assert.deepEqual(next.map((x) => x.fields.changes), [['заголовок: a → b (Анна)']]);
});

test('Jira: свои правки событием не считаются, но и потом не всплывают', async () => {
  const history: Record<string, Hist[]> = { 'ABC-1': [] };
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch } = jiraApi(list, history);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind(deps);
  await kind.poll!(ctx);
  list[0] = issue('ABC-1', '2026-11-17T10:30:00.200+0000');
  history['ABC-1'].push({ created: '2026-11-17T10:30:00.000+0000', author: 'Борис Иванов', field: 'status', from: 'В работе', to: 'Ревью' });
  assert.deepEqual(await kind.poll!(ctx), []);
  // чужая правка после моей: в событии только она
  list[0] = issue('ABC-1', '2026-11-17T12:00:00.000+0000');
  history['ABC-1'].push({ created: '2026-11-17T11:40:00.000+0000', author: 'Анна', field: 'priority', from: 'Low', to: 'High' });
  const [e] = await kind.poll!(ctx);
  assert.deepEqual(e.fields.changes, ['приоритет: Low → High (Анна)']);
});

test('Jira: обновление без записей в истории — «комментарий или правка»; история не получилась — повтор, потом то же самое, не ошибка', async () => {
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch } = jiraApi(list, {});
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind(deps);
  await kind.poll!(ctx);
  list[0] = issue('ABC-1', '2026-11-17T11:00:00.000+0000');
  const [e] = await kind.poll!(ctx);
  assert.equal(e.fields.change, 'comment');
  assert.match(e.text, /Новый комментарий или правка без истории/);

  // история не получилась: задача не теряется, после трёх неудачных опросов она придёт как правка без истории
  const broken = { changelog: true };
  const f2 = jiraApi(list, {}, {}, broken);
  const ctx2 = makeCtx({ config: {}, fetch: f2.fetch, cursor: { known: { 'ABC-1': '2026-11-17T10:00:00.000+0000' } } });
  list[0] = issue('ABC-1', '2026-11-17T14:00:00.000+0000');
  const k2 = jiraKind(deps);
  assert.deepEqual(await k2.poll!(ctx2), []);
  assert.deepEqual(await k2.poll!(ctx2), []);
  const [e2] = await k2.poll!(ctx2);
  assert.equal(e2.fields.change, 'comment');
  assert.ok(ctx2.logs.some((l) => /история не получена/.test(l)));
});

test('Jira: задача появилась в выборке — assigned, если назначили после прошлого опроса; создана недавно — new; давняя, просто поднявшаяся, — молча', async () => {
  const history: Record<string, Hist[]> = {
    'ABC-2': [{ created: '2026-11-17T10:50:00.000+0000', author: 'Лид', field: 'assignee', to: 'Борис Иванов' }],
    'ABC-3': [{ created: '2025-05-01T10:00:00.000+0000', author: 'Лид', field: 'assignee', to: 'Борис Иванов' }],
    'ABC-4': [],
    'ABC-5': [{ created: '2026-11-17T10:55:00.000+0000', author: 'Борис Иванов', field: 'assignee', to: 'Борис Иванов' }],
  };
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch } = jiraApi(list, history, { 'ABC-4': '2026-11-17T10:40:00.000+0000' });
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind(deps);
  await kind.poll!(ctx);
  clock = Date.parse('2026-11-17T11:00:00Z');
  list.push(...['ABC-2', 'ABC-3', 'ABC-4', 'ABC-5'].map((k) => issue(k, '2026-11-17T11:00:00.000+0000')));
  const events = await kind.poll!(ctx);
  assert.deepEqual(events.map((e) => [e.fields.key, e.fields.change]), [['ABC-2', 'assigned'], ['ABC-4', 'new']]);
  // молча запомнены: в следующем опросе повторно не всплывают
  assert.deepEqual(await kind.poll!(ctx), []);
});

test('Jira: самоназначение — моя правка, а не «назначили на вас»', async () => {
  const history: Record<string, Hist[]> = { 'ABC-1': [] };
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch } = jiraApi(list, history);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind(deps);
  await kind.poll!(ctx);
  clock = Date.parse('2026-11-17T11:00:00Z');
  list[0] = issue('ABC-1', '2026-11-17T10:50:00.000+0000');
  history['ABC-1'].push({ created: '2026-11-17T10:50:00.000+0000', author: 'Борис Иванов', field: 'assignee', from: 'Анна', to: 'Борис Иванов' });
  assert.deepEqual(await kind.poll!(ctx), []);
});

test('Jira: служебные поля (Rank, учёт времени) событием не считаются; комментарий после них — считается', async () => {
  const history: Record<string, Hist[]> = { 'ABC-1': [] };
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch } = jiraApi(list, history);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind(deps);
  await kind.poll!(ctx);
  list[0] = issue('ABC-1', '2026-11-17T10:30:00.500+0000');
  history['ABC-1'].push({ created: '2026-11-17T10:30:00.000+0000', author: 'Анна', field: 'Rank', from: 'a', to: 'b' });
  assert.deepEqual(await kind.poll!(ctx), []);
  // я поменял статус, а потом кто-то написал комментарий (в истории его нет)
  list[0] = issue('ABC-1', '2026-11-17T12:00:00.000+0000');
  history['ABC-1'].push({ created: '2026-11-17T10:40:00.000+0000', author: 'Борис Иванов', field: 'status', from: 'a', to: 'b' });
  const [e] = await kind.poll!(ctx);
  assert.equal(e.fields.change, 'comment');
});

test('Jira: сбой истории не теряет назначение — повтор в следующем опросе; постоянный сбой через три опроса — правка без истории', async () => {
  const history: Record<string, Hist[]> = { 'ABC-1': [] };
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const broken = { changelog: false };
  const { fetch } = jiraApi(list, history, {}, broken);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind(deps);
  await kind.poll!(ctx);
  clock = Date.parse('2026-11-17T11:00:00Z');
  list[0] = issue('ABC-1', '2026-11-17T10:50:00.000+0000');
  history['ABC-1'].push({ created: '2026-11-17T10:50:00.000+0000', author: 'Лид', field: 'assignee', from: 'Анна', to: 'Борис Иванов' });
  broken.changelog = true;
  assert.deepEqual(await kind.poll!(ctx), [], 'блип Jira: события нет, но и курсор по задаче не ушёл');
  broken.changelog = false;
  const [e] = await kind.poll!(ctx);
  assert.equal(e.fields.change, 'assigned');
  assert.ok(ctx.logs.some((l) => /история не получена/.test(l)));

  // постоянная ошибка: после трёх опросов задача не зависает навсегда
  const list2 = [issue('ABC-9', '2026-11-17T10:00:00.000+0000')];
  const b2 = { changelog: false };
  const f2 = jiraApi(list2, {}, {}, b2);
  const ctx2 = makeCtx({ config: {}, fetch: f2.fetch });
  await kind.poll!(ctx2);
  list2[0] = issue('ABC-9', '2026-11-17T11:00:00.000+0000');
  b2.changelog = true;
  assert.deepEqual(await kind.poll!(ctx2), []);
  assert.deepEqual(await kind.poll!(ctx2), []);
  const [last] = await kind.poll!(ctx2);
  assert.equal(last.fields.change, 'comment');
});

test('Jira: не узнал, кто я (сбой myself, профиль пуст) — опрос пропущен, курсор не двигается, сбой не запоминается', async () => {
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const history: Record<string, Hist[]> = { 'ABC-1': [] };
  const broken = { myself: false };
  const { fetch } = jiraApi(list, history, {}, broken);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind({ creds: () => creds, now: () => clock, profile: () => ({ names: [], emails: [] }) });
  await kind.poll!(ctx);
  const before = JSON.stringify(ctx.cursorValue());
  list[0] = issue('ABC-1', '2026-11-17T11:00:00.000+0000');
  history['ABC-1'].push({ created: '2026-11-17T10:50:00.000+0000', author: 'Лид', field: 'assignee', from: 'Анна', to: 'Борис Иванов' });
  broken.myself = true;
  assert.deepEqual(await kind.poll!(ctx), []);
  assert.equal(JSON.stringify(ctx.cursorValue()), before);
  assert.ok(ctx.logs.some((l) => /не удалось узнать, кто я/.test(l)));
  broken.myself = false;
  const [e] = await kind.poll!(ctx);
  assert.equal(e.fields.change, 'assigned');
});

test('Jira: историю читаем не больше десяти задач за опрос, остальные — в следующем', async () => {
  const keys = Array.from({ length: 12 }, (_, i) => `ABC-${i + 1}`);
  const list = keys.map((k) => issue(k, '2026-11-17T12:00:00.000+0000'));
  const history = Object.fromEntries(keys.map((k) => [k, [{ created: '2026-11-17T11:00:00.000+0000', author: 'Анна', field: 'status', from: 'a', to: 'b' }]]));
  const { fetch } = jiraApi(list, history);
  const ctx = makeCtx({ config: {}, fetch, cursor: { known: Object.fromEntries(keys.map((k) => [k, '2026-11-17T10:00:00.000+0000'])) } });
  const kind = jiraKind(deps);
  const first = await kind.poll!(ctx);
  assert.equal(first.length, 10);
  const second = await kind.poll!(ctx);
  assert.deepEqual(second.map((e) => e.fields.key), ['ABC-11', 'ABC-12']);
});

test('Jira без подключения — понятная ошибка', async () => {
  await assert.rejects(() => jiraKind({ creds: () => undefined }).poll!(makeCtx()), /Jira не подключена/);
});

test('Jira reply: комментарий в формате ADF, обновление от него событием не считается', async () => {
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch, calls } = jiraApi(list);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind(deps);
  await kind.poll!(ctx);
  const r = await kind.reply!(ctx, { key: 'ABC-1' }, 'Взял в работу\n\nЖду подтверждения');
  assert.equal(r.link, 'https://acme.atlassian.net/browse/ABC-1?focusedCommentId=555');
  const post = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/comment'))!;
  const body = post.body as { body: { type: string; content: Array<{ content: Array<{ text: string }> }> } };
  assert.equal(body.body.type, 'doc');
  assert.deepEqual(body.body.content.map((p) => p.content[0].text), ['Взял в работу', 'Жду подтверждения']);
  // наш комментарий сдвинул updated: это не новое событие
  list[0] = issue('ABC-1', '2026-11-17T12:00:02.000+0000');
  assert.deepEqual(await kind.poll!(ctx), []);
  // а следующее настоящее обновление — событие
  list[0] = issue('ABC-1', '2026-11-17T13:00:00.000+0000');
  assert.equal((await kind.poll!(ctx)).length, 1);
});

test('Jira reply без ключа в адресе — ошибка', async () => {
  await assert.rejects(() => jiraKind(deps).reply!(makeCtx(), undefined, 'x'), /нет задачи Jira/);
});

test('Jira: комментарий, отправленный пока шёл опрос (другой ctx со своим курсором), не превращается в новое событие и не зацикливает рутину', async () => {
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch } = jiraApi(list);
  const kind = jiraKind(deps);
  const pollCtx = makeCtx({ slug: 'jira', config: {}, fetch });
  await kind.poll!(pollCtx);
  // reply идёт в другом ctx: его set курсора poll-ctx не видит и не должен затирать
  const replyCtx = makeCtx({ slug: 'jira', config: {}, fetch });
  await kind.reply!(replyCtx, { key: 'ABC-1' }, 'ответ');
  list[0] = issue('ABC-1', '2026-11-17T12:00:02.000+0000');
  assert.deepEqual(await kind.poll!(pollCtx), [], 'обновление от нашего комментария');
  assert.deepEqual(await kind.poll!(pollCtx), [], 'и в следующем опросе тоже: этот updated уже не станет событием');
  list[0] = issue('ABC-1', '2026-11-17T13:00:00.000+0000');
  assert.equal((await kind.poll!(pollCtx)).length, 1, 'а настоящее обновление после — событие');
  assert.equal(kind.isSelf, undefined, 'isSelf, который ничего не проверял, убран');
  assert.deepEqual(Object.keys(pollCtx.cursorValue() as object), ['known', 'own', 'seen', 'fails', 'at'], 'в курсоре: известные задачи, обновления от наших комментариев, время последней разобранной записи истории, сбои истории и начало опроса');
});
