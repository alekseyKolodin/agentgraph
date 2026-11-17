import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { JIRA_SEARCH_PATH } from '../../jira.js';
import { jiraKind, resetJiraState } from './jira.js';
import { fakeFetch, makeCtx } from './testkit.js';

beforeEach(resetJiraState);

const creds = { cfg: { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.com' }, token: 'jira-secret' };
const issue = (key: string, updated: string, extra: Record<string, unknown> = {}) => ({
  key,
  fields: { summary: `Задача ${key}`, status: { name: 'В работе', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Bug' }, priority: { name: 'High' }, updated, ...extra },
});

function jiraApi(issues: Array<ReturnType<typeof issue>>) {
  return fakeFetch(({ url, method, body }) => {
    if (url.pathname === JIRA_SEARCH_PATH) return { issues };
    if (url.pathname.startsWith('/rest/api/3/issue/') && url.pathname.endsWith('/comment') && method === 'POST') return { id: '555', created: '2026-11-17T12:00:01.000Z', body };
    const m = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(url.pathname);
    if (m) return issue(m[1], '2026-11-17T10:00:00.000+0000', { description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Подробное описание' }] }] } });
    return new Response('nope', { status: 404 });
  });
}

test('Jira: задачи по JQL становятся событиями с описанием, id содержит время обновления', async () => {
  const { fetch, calls } = jiraApi([issue('ABC-1', '2026-11-17T10:00:00.000+0000')]);
  const ctx = makeCtx({ slug: 'jira', config: { jql: 'project = ABC ORDER BY updated DESC' }, fetch });
  const [e] = await jiraKind({ creds: () => creds }).poll!(ctx);
  assert.equal(e.id, 'ABC-1@2026-11-17T10:00:00.000+0000');
  assert.equal(e.title, 'ABC-1 Задача ABC-1');
  assert.match(e.text, /Статус: В работе · Тип: Bug · Приоритет: High/);
  assert.match(e.text, /Подробное описание/);
  assert.equal(e.link, 'https://acme.atlassian.net/browse/ABC-1');
  assert.equal(e.fields.status, 'В работе');
  assert.deepEqual(e.replyTo, { key: 'ABC-1' });
  const search = calls.find((c) => c.url.pathname === JIRA_SEARCH_PATH)!;
  assert.equal((search.body as { jql: string }).jql, 'project = ABC ORDER BY updated DESC');
  // токен идёт в заголовке Basic, не в тексте события
  assert.ok(search.headers.authorization.startsWith('Basic '));
  assert.ok(!JSON.stringify(e).includes('jira-secret'));
});

test('Jira: обновлённая задача получает новый id, описание не перезапрашивается без изменений', async () => {
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch, calls } = jiraApi(list);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind({ creds: () => creds });
  const first = await kind.poll!(ctx);
  const again = await kind.poll!(ctx);
  assert.equal(first[0].id, again[0].id);
  assert.equal(calls.filter((c) => /\/issue\/ABC-1$/.test(c.url.pathname)).length, 1);
  list[0] = issue('ABC-1', '2026-11-17T11:00:00.000+0000');
  const updated = await kind.poll!(ctx);
  assert.notEqual(updated[0].id, first[0].id);
});

test('Jira без подключения — понятная ошибка', async () => {
  await assert.rejects(() => jiraKind({ creds: () => undefined }).poll!(makeCtx()), /Jira не подключена/);
});

test('Jira reply: комментарий в формате ADF, обновление от него событием не считается', async () => {
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch, calls } = jiraApi(list);
  const ctx = makeCtx({ config: {}, fetch });
  const kind = jiraKind({ creds: () => creds });
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
  await assert.rejects(() => jiraKind({ creds: () => creds }).reply!(makeCtx(), undefined, 'x'), /нет задачи Jira/);
});

test('Jira: комментарий, отправленный пока шёл опрос (другой ctx со своим курсором), не превращается в новое событие и не зацикливает рутину', async () => {
  const list = [issue('ABC-1', '2026-11-17T10:00:00.000+0000')];
  const { fetch } = jiraApi(list);
  const kind = jiraKind({ creds: () => creds });
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
  assert.deepEqual(Object.keys(pollCtx.cursorValue() as object), ['known', 'own'], 'в курсоре: известные задачи и обновления от наших комментариев');
});
