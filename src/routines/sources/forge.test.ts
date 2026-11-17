import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Exec } from '../../git.js';
import type { SourceKind } from '../kind.js';
import { githubKind, gitlabKind } from './forge.js';
import { makeCtx } from './testkit.js';

type Call = { cmd: string; args: string[] };

/** Exec, отвечающий по подстроке аргументов; все вызовы пишутся. */
function fakeExec(routes: Array<[RegExp, unknown]>): { x: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const x: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const line = args.join(' ');
    const hit = routes.find(([re]) => re.test(line));
    if (!hit) throw new Error(`нет ответа на ${cmd} ${line}`);
    return JSON.stringify(hit[1]);
  };
  return { x, calls };
}

const glMr = (iid: number, extra: Record<string, unknown> = {}) => ({ iid, title: `MR ${iid}`, description: 'описание', web_url: `https://gitlab.test/grp/repo/-/merge_requests/${iid}`, created_at: '2026-11-17T09:00:00Z', author: { username: 'bob' }, references: { full: `grp/repo!${iid}` }, ...extra });

// uniqueHost — glabUser кэширует логин по хосту на весь процесс, поэтому у каждого теста свой хост
const gitlabCtx = (host: string, config: Record<string, unknown> = {}) => makeCtx({ slug: 'gl', kind: 'gitlab', config: { host, ...config } });

test('GitLab: ревью, упоминания и комментарии к моим MR становятся событиями', async () => {
  const { x, calls } = fakeExec([
    [/ user$/, { username: 'me' }],
    [/reviewer_username=me/, [glMr(5, { draft: true, source_branch: 'feat' })]],
    [/todos\?action=mentioned/, [{ id: 77, body: '@me глянь', target_url: 'https://gitlab.test/grp/repo/-/issues/3#note_1', created_at: '2026-11-17T10:00:00Z', author: { username: 'carol' }, target: { iid: 3, title: 'Баг оплаты' }, project: { path_with_namespace: 'grp/repo' } }]],
    [/author_username=me/, [glMr(9)]],
    [/merge_requests\/9\/notes/, [{ id: 1, body: 'исправь', author: { username: 'bob' }, created_at: '2026-11-17T11:00:00Z' }, { id: 2, body: 'merged', system: true }, { id: 3, body: 'ответ себе', author: { username: 'me' } }]],
  ]);
  const kind = gitlabKind(x);
  const events = await kind.poll!(gitlabCtx('gl-one.test'));
  assert.deepEqual(events.map((e) => e.id), ['review:https://gitlab.test/grp/repo/-/merge_requests/5', 'mention:77', 'comment:grp/repo!9:1', 'comment:grp/repo!9:3']);
  const review = events[0];
  assert.equal(review.fields.event, 'review');
  assert.equal(review.fields.draft, true);
  assert.equal(review.fields.ref, 'grp/repo!5');
  assert.equal(review.author, 'bob');
  assert.match(review.title, /^Ревью: grp\/repo!5 MR 5/);
  assert.equal(events[1].fields.event, 'mention');
  assert.equal(events[1].fields.project, 'grp/repo');
  assert.equal(events[2].link, 'https://gitlab.test/grp/repo/-/merge_requests/9#note_1');
  assert.deepEqual(events[2].replyTo, { forge: 'gitlab', host: 'gl-one.test', project: 'grp/repo', number: 9 });
  // свой комментарий — self, система — пропущена
  assert.equal(kind.isSelf!(gitlabCtx('gl-one.test'), events[2]), false);
  assert.equal(kind.isSelf!(gitlabCtx('gl-one.test'), events[3]), true);
  assert.ok(calls.every((c) => c.cmd === 'glab' && c.args.includes('--hostname')));
});

test('GitLab с проектом ходит в проектные адреса и отсекает чужие упоминания', async () => {
  const { x, calls } = fakeExec([
    [/ user$/, { username: 'me' }],
    [/projects\/grp%2Frepo\/merge_requests\?state=opened&scope=all&reviewer_username=me/, []],
    [/todos/, [{ id: 1, body: 'x', project: { path_with_namespace: 'other/repo' }, target: {} }]],
    [/projects\/grp%2Frepo\/merge_requests\?state=opened&scope=all&author_username=me/, []],
  ]);
  const events = await gitlabKind(x).poll!(gitlabCtx('gl-two.test', { project: '/grp/repo/' }));
  assert.deepEqual(events, []);
  assert.ok(calls.some((c) => c.args.join(' ').includes('projects/grp%2Frepo/merge_requests?')));
});

test('GitLab reply: комментарий в MR через glab api POST, ссылка на заметку', async () => {
  const { x, calls } = fakeExec([[/notes/, { id: 42 }]]);
  const r = await gitlabKind(x).reply!(gitlabCtx('gl.test'), { forge: 'gitlab', host: 'gitlab.test', project: 'grp/repo', number: 9 }, 'Взял в работу\n"кавычки"');
  assert.deepEqual(calls[0].args, ['api', '--hostname', 'gitlab.test', 'projects/grp%2Frepo/merge_requests/9/notes', '-X', 'POST', '-f', 'body=Взял в работу\n"кавычки"']);
  assert.equal(r.link, 'https://gitlab.test/grp/repo/-/merge_requests/9#note_42');
});

test('reply без MR в адресе — понятная ошибка', async () => {
  const { x } = fakeExec([]);
  await assert.rejects(() => gitlabKind(x).reply!(gitlabCtx('gl.test'), undefined, 'x'), /нет MR\/PR/);
  await assert.rejects(() => githubKind(x).reply!(gitlabCtx('gh.test'), { host: 'github.com', project: 'a/b', number: 0 }, 'x'), /нет MR\/PR/);
});

const ghItem = (n: number, extra: Record<string, unknown> = {}) => ({ number: n, title: `PR ${n}`, body: 'тело', html_url: `https://github.com/o/r/pull/${n}`, created_at: '2026-11-17T09:00:00Z', user: { login: 'dave' }, repository_url: 'https://api.github.com/repos/o/r', ...extra });

test('GitHub: ревью, упоминания и комментарии к моим PR', async () => {
  const { x, calls } = fakeExec([
    [/gh-host\.test user$/, { login: 'me' }],
    [/review-requested:me/, { items: [ghItem(1, { draft: true })] }],
    [/is:open\+mentions:me/, { items: [ghItem(2, { pull_request: {} })] }],
    [/is:pr\+is:open\+author:me/, { items: [ghItem(3)] }],
    [/issues\/3\/comments/, [{ id: 10, body: 'общий', user: { login: 'dave' }, html_url: 'https://github.com/o/r/pull/3#issuecomment-10', created_at: '2026-11-17T12:00:00Z' }]],
    [/pulls\/3\/comments/, [{ id: 11, body: 'строка', user: { login: 'me' }, html_url: 'https://github.com/o/r/pull/3#discussion_r11' }]],
  ]);
  const kind = githubKind(x);
  const ctx = makeCtx({ slug: 'gh', kind: 'github', config: { host: 'gh-host.test', project: 'o/r' } });
  const events = await kind.poll!(ctx);
  assert.deepEqual(events.map((e) => e.id), ['review:https://github.com/o/r/pull/1', 'mention:https://github.com/o/r/pull/2', 'comment:o/r#3:10', 'comment:o/r#3:11']);
  assert.equal(events[0].fields.draft, true);
  assert.equal(events[0].fields.ref, 'o/r#1');
  assert.equal(events[1].fields.is_pr, true);
  assert.equal(events[2].link, 'https://github.com/o/r/pull/3#issuecomment-10');
  assert.equal(kind.isSelf!(ctx, events[3]), true);
  assert.equal(kind.isSelf!(ctx, events[2]), false);
  // репозиторий ограничивает поиск
  assert.ok(calls.some((c) => c.args.join(' ').includes('review-requested:me+repo:o/r')));
});

test('GitHub reply: комментарий через gh api, ссылка из ответа', async () => {
  const { x, calls } = fakeExec([[/comments/, { html_url: 'https://github.com/o/r/pull/3#issuecomment-99' }]]);
  const r = await githubKind(x).reply!(makeCtx(), { forge: 'github', host: 'github.com', project: 'o/r', number: 3 }, 'Готово');
  assert.deepEqual(calls[0].args, ['api', '--hostname', 'github.com', 'repos/o/r/issues/3/comments', '-X', 'POST', '-f', 'body=Готово']);
  assert.equal(r.link, 'https://github.com/o/r/pull/3#issuecomment-99');
});

test('ответ glab не JSON — ошибка с понятным текстом', async () => {
  const x: Exec = async () => 'oops';
  await assert.rejects(() => gitlabKind(x).poll!(gitlabCtx('gl-bad.test')), /glab/);
});

test('подписи видов: условия описаны по-русски, ответ умеют оба', () => {
  for (const k of [gitlabKind(), githubKind()] as SourceKind[]) {
    assert.ok(k.match.some((m) => m.key === 'event' && m.options?.includes('review')));
    assert.ok(k.setup.every((f) => f.label && /[а-я]/i.test(f.label)));
    assert.ok(k.reply);
  }
});

test('GitLab: упоминание в задаче — ответ уходит в issues/<n>/notes, а не в чужой MR с тем же номером', async () => {
  const todo = (id: number, target_type: string, url: string) => ({ id, body: '@me глянь', target_type, target_url: url, created_at: '2026-11-17T10:00:00Z', author: { username: 'carol' }, target: { iid: 5, title: 'Тема' }, project: { path_with_namespace: 'grp/repo' } });
  const { x, calls } = fakeExec([
    [/ user$/, { username: 'me' }],
    [/reviewer_username=me/, []],
    [/todos/, [todo(1, 'Issue', 'https://gitlab.test/grp/repo/-/issues/5#note_1'), todo(2, 'MergeRequest', 'https://gitlab.test/grp/repo/-/merge_requests/5#note_2'), todo(3, 'Epic', 'https://gitlab.test/groups/grp/-/epics/5')]],
    [/author_username=me/, []],
    [/issues\/5\/notes/, { id: 9 }],
  ]);
  const events = await gitlabKind(x).poll!(gitlabCtx('gl-issue.test'));
  assert.equal(events[0].fields.ref, 'grp/repo#5');
  assert.deepEqual(events[0].replyTo, { forge: 'gitlab', host: 'gl-issue.test', project: 'grp/repo', number: 5, type: 'issue' });
  assert.equal(events[1].fields.ref, 'grp/repo!5');
  assert.equal(events[1].replyTo!.type, undefined);
  assert.equal(events[2].replyTo!.number, 0, 'у эпика нет MR/задачи для ответа');
  const r = await gitlabKind(x).reply!(gitlabCtx('gl.test'), events[0].replyTo, 'ок');
  assert.equal(calls.at(-1)!.args[3], 'projects/grp%2Frepo/issues/5/notes');
  assert.equal(r.link, 'https://gl-issue.test/grp/repo/-/issues/5#note_9');
  await assert.rejects(() => gitlabKind(x).reply!(gitlabCtx('gl.test'), events[2].replyTo, 'ок'), /нет MR\/PR/);
});

test('GitHub: в PR больше десяти комментариев — берутся последние (последняя страница), а не самые старые', async () => {
  const { x, calls } = fakeExec([
    [/gh-big\.test user$/, { login: 'me' }],
    [/review-requested:me/, { items: [] }],
    [/is:open\+mentions:me/, { items: [] }],
    [/is:pr\+is:open\+author:me/, { items: [ghItem(7, { comments: 25 })] }],
    [/issues\/7\/comments\?per_page=10&page=3/, [{ id: 21, body: 'новый', user: { login: 'dave' } }]],
    [/issues\/7\/comments\?per_page=10&page=2/, Array.from({ length: 10 }, (_, i) => ({ id: 11 + i, body: 'x', user: { login: 'dave' } }))],
    [/pulls\/7\/comments\?sort=created&direction=desc/, []],
  ]);
  const events = await githubKind(x).poll!(makeCtx({ slug: 'gh', kind: 'github', config: { host: 'gh-big.test' } }));
  assert.equal(events.length, 10);
  assert.equal(events.at(-1)!.id, 'comment:o/r#7:21');
  assert.ok(calls.some((c) => c.args.join(' ').includes('issues/7/comments?per_page=10&page=3')));
});
