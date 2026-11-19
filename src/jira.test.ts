import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToMarkdown, ASSIGNED_TO_ME_JQL, JIRA_SEARCH_PATH, JQL_PRESETS, jiraClient, LIST_FIELDS, normalizeBaseUrl, parseIssueKey, type FetchFn } from './jira.js';

const cfg = { baseUrl: 'https://example.atlassian.net/', email: 'dev@example.com' };
const TOKEN = 'secret-token-123';

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as FetchFn;
  return { fn, calls };
}

test('ключ задачи из ключа и из ссылок', () => {
  assert.equal(parseIssueKey('abc-12'), 'ABC-12');
  assert.equal(parseIssueKey('https://example.atlassian.net/browse/ABC-7'), 'ABC-7');
  assert.equal(parseIssueKey('https://example.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-9'), 'ABC-9');
  assert.equal(parseIssueKey('просто текст'), undefined);
});

test('адрес Jira: только https, путь отбрасывается', () => {
  assert.equal(normalizeBaseUrl('https://example.atlassian.net/jira/your-work'), 'https://example.atlassian.net');
  assert.throws(() => normalizeBaseUrl('http://example.atlassian.net'), /https/);
});

test('поиск: POST на search/jql с явными fields, разбор задач', async () => {
  const f = fakeFetch(() => ({
    body: {
      issues: [{ key: 'ABC-1', fields: { summary: 'Кнопка', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Story' }, parent: { key: 'ABC-0', fields: { summary: 'Эпик' } } } }],
      isLast: true,
    },
  }));
  const list = await jiraClient(cfg, TOKEN, f.fn).search('assignee = currentUser()', 10);
  assert.equal(f.calls[0].url, 'https://example.atlassian.net' + JIRA_SEARCH_PATH);
  assert.equal(f.calls[0].init.method, 'POST');
  const body = JSON.parse(String(f.calls[0].init.body));
  assert.deepEqual(body, { jql: 'assignee = currentUser()', fields: LIST_FIELDS, maxResults: 10 });
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, 'Basic ' + Buffer.from(`dev@example.com:${TOKEN}`).toString('base64'));
  assert.deepEqual(list[0], {
    key: 'ABC-1',
    title: 'Кнопка',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    type: 'Story',
    priority: undefined,
    updated: undefined,
    parent: { key: 'ABC-0', title: 'Эпик' },
    url: 'https://example.atlassian.net/browse/ABC-1',
  });
});

test('ошибка HTTP: статус и errorMessages, без токена', async () => {
  const f = fakeFetch(() => ({ status: 400, body: { errorMessages: ['Ошибка в JQL'], errors: { jql: 'плохо' } } }));
  await assert.rejects(jiraClient(cfg, TOKEN, f.fn).search('bad'), (err: Error) => {
    assert.match(err.message, /400.*Ошибка в JQL.*jql: плохо/);
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
  const g = fakeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(jiraClient(cfg, TOKEN, g.fn).myself(), /401.*токен/);
});

test('задача: описание из ADF, сабтаски, связи', async () => {
  const f = fakeFetch(() => ({
    body: {
      key: 'ABC-2',
      fields: {
        summary: 'Экран',
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Сделать' }] }] },
        subtasks: [{ key: 'ABC-3', fields: { summary: 'Вёрстка', status: { name: 'To Do' } } }],
        issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'ABC-4', fields: { summary: 'API' } } }],
      },
    },
  }));
  const i = await jiraClient(cfg, TOKEN, f.fn).issue('ABC-2');
  assert.match(f.calls[0].url, /\/rest\/api\/3\/issue\/ABC-2\?fields=.*description/);
  assert.equal(i.description, 'Сделать');
  assert.deepEqual(i.subtasks, [{ key: 'ABC-3', title: 'Вёрстка', status: 'To Do' }]);
  assert.deepEqual(i.links, [{ relation: 'is blocked by', key: 'ABC-4', title: 'API' }]);
  await assert.rejects(jiraClient(cfg, TOKEN, f.fn).issue('../myself'), /Не ключ/);
});

test('ADF → markdown: заголовки, списки, код, ссылки', () => {
  const md = adfToMarkdown({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Цель' }] },
      { type: 'heading', attrs: { level: 99 }, content: [{ type: 'text', text: 'Мелко' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'жирно', marks: [{ type: 'strong' }] }, { type: 'text', text: ' и ' }, { type: 'text', text: 'ссылка', marks: [{ type: 'link', attrs: { href: 'https://x.test' } }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'раз' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'два' }] }] }] },
      { type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'a = 1' }] },
    ],
  });
  assert.equal(md.trim(), '## Цель\n\n###### Мелко\n\n**жирно** и [ссылка](https://x.test)\n\n- раз\n- два\n\n```python\na = 1\n```');
});

test('ADF: текст из attrs и незнакомых узлов не теряется', () => {
  const md = adfToMarkdown({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { text: '@Разработчик' } },
          { type: 'text', text: ' см. ' },
          { type: 'inlineCard', attrs: { url: 'https://x.test/a' } },
          { type: 'emoji', attrs: { shortName: ':ok:' } },
          { type: 'status', attrs: { text: 'BLOCKED' } },
        ],
      },
      { type: 'futureBlock', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'внутри нового узла' }] }] },
      { type: 'expand', attrs: { title: 'Подробнее' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'скрытое' }] }] },
    ],
  });
  for (const s of ['@Разработчик', 'https://x.test/a', ':ok:', '[BLOCKED]', 'внутри нового узла', 'скрытое']) assert.ok(md.includes(s), s);
});

test('задача: исполнитель в issue(); нет исполнителя — undefined', async () => {
  const f = fakeFetch(() => ({ body: { key: 'ABC-1', fields: { summary: 'S', status: { name: 'Todo' }, assignee: { accountId: 'acc-1', displayName: 'Анна', emailAddress: 'ann@example.com' } } } }));
  const issue = await jiraClient(cfg, TOKEN, f.fn).issue('ABC-1');
  assert.deepEqual(issue.assignee, { accountId: 'acc-1', displayName: 'Анна', email: 'ann@example.com' });
  assert.match(f.calls[0].url, /fields=[^&]*assignee/);
  const none = fakeFetch(() => ({ body: { key: 'ABC-1', fields: { assignee: null } } }));
  assert.equal((await jiraClient(cfg, TOKEN, none.fn).issue('ABC-1')).assignee, undefined);
});

test('changelog: записи по полям, отсутствующий toString не подменяется методом объекта', async () => {
  const f = fakeFetch(() => ({
    body: { isLast: true, total: 2, values: [
      { created: '2026-11-09T10:00:00.000+0000', author: { displayName: 'Анна' }, items: [{ field: 'status', fromString: 'Todo', toString: 'Done' }, { field: 'labels' }] },
      { created: '2026-11-10T10:00:00.000+0000', items: [{ field: 'assignee', fromString: null, toString: 'Борис' }] },
    ] },
  }));
  const list = await jiraClient(cfg, TOKEN, f.fn).changelog('ABC-1');
  assert.match(f.calls[0].url, /\/rest\/api\/3\/issue\/ABC-1\/changelog\?startAt=0&maxResults=100$/);
  assert.deepEqual(list, [
    { at: '2026-11-09T10:00:00.000+0000', author: 'Анна', field: 'status', from: 'Todo', to: 'Done' },
    { at: '2026-11-09T10:00:00.000+0000', author: 'Анна', field: 'labels', from: '', to: '' },
    { at: '2026-11-10T10:00:00.000+0000', author: '', field: 'assignee', from: '', to: 'Борис' },
  ]);
});

test('changelog: длинная история — берём последнюю страницу, плохой ключ отклоняется', async () => {
  const f = fakeFetch((url) => ({ body: url.includes('startAt=0') ? { isLast: false, total: 250, values: [{ created: 'old', items: [{ field: 'x' }] }] } : { isLast: true, total: 250, values: [{ created: 'new', items: [{ field: 'status', toString: 'Done' }] }] } }));
  const list = await jiraClient(cfg, TOKEN, f.fn).changelog('ABC-1', 100);
  assert.match(f.calls[1].url, /startAt=150&maxResults=100$/);
  assert.deepEqual(list.map((c) => c.at), ['new']);
  await assert.rejects(jiraClient(cfg, TOKEN, f.fn).changelog('нет'), /Не ключ задачи/);
});

test('пресет «назначено на меня» общий: «Код» (mine) и рутина берут один запрос', () => {
  assert.equal(JQL_PRESETS.mine, ASSIGNED_TO_ME_JQL);
  assert.match(ASSIGNED_TO_ME_JQL, /assignee = currentUser\(\) AND statusCategory != Done/);
});
