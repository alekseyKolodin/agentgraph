import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Exec } from '../../git.js';
import type { SourceKind } from '../kind.js';
import { resolveThings } from '../../things/resolve.js';
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

test('GitLab: ревью, упоминания и комментарии к моим MR (одним событием на MR) становятся событиями', async () => {
  const { x, calls } = fakeExec([
    [/ user$/, { username: 'me' }],
    [/reviewer_username=me/, [glMr(5, { draft: true, source_branch: 'feat' })]],
    [/todos\?action=mentioned/, [{ id: 77, body: '@me глянь', target_url: 'https://gitlab.test/grp/repo/-/issues/3#note_1', created_at: '2026-11-17T10:00:00Z', author: { username: 'carol' }, target: { iid: 3, title: 'Баг оплаты' }, project: { path_with_namespace: 'grp/repo' } }]],
    [/author_username=me/, [glMr(9)]],
    [/merge_requests\/9\/notes/, [{ id: 1, body: 'исправь', author: { username: 'bob' }, created_at: '2026-11-17T11:00:00Z' }, { id: 2, body: 'merged', system: true }, { id: 3, body: 'ответ себе', author: { username: 'me' } }]],
  ]);
  const kind = gitlabKind(x);
  const events = await kind.poll!(gitlabCtx('gl-one.test'));
  assert.deepEqual(events.map((e) => e.id), ['review:https://gitlab.test/grp/repo/-/merge_requests/5', 'mention:77', 'comment:grp/repo!9:3']);
  const review = events[0];
  assert.equal(review.fields.event, 'review');
  assert.equal(review.fields.draft, true);
  assert.equal(review.fields.ref, 'grp/repo!5');
  assert.equal(review.author, 'bob');
  assert.match(review.title, /^Ревью: grp\/repo!5 MR 5/);
  assert.equal(events[1].fields.event, 'mention');
  assert.equal(events[1].fields.project, 'grp/repo');
  // два новых комментария — одно событие: ссылка на первый чужой, автор — последний не я, система пропущена
  const c = events[2];
  assert.equal(c.link, 'https://gitlab.test/grp/repo/-/merge_requests/9#note_1');
  assert.equal(c.author, 'bob');
  assert.equal(c.text, 'bob: исправь\n\nme: ответ себе');
  assert.equal(c.fields.count, 2);
  assert.deepEqual(c.replyTo, { forge: 'gitlab', host: 'gl-one.test', project: 'grp/repo', number: 9 });
  assert.equal(kind.isSelf!(gitlabCtx('gl-one.test'), c), false);
  // события о MR несут вещь; упоминание в задаче — нет
  assert.deepEqual(review.things?.map((t) => t.key), ['mr:gitlab.test/grp/repo/5']);
  assert.equal(review.things?.[0].ref.forge, 'gitlab');
  // назначение в GitLab и ссылка на тот же MR в Slack — одна вещь
  assert.equal(resolveThings({ text: 'глянь <https://GitLab.test/Grp/Repo/-/merge_requests/5/diffs|!5>' })[0].key, review.things?.[0].key);
  assert.deepEqual(c.things?.map((t) => t.key), ['mr:gitlab.test/grp/repo/9']);
  assert.equal(events[1].things, undefined);
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
  assert.deepEqual(events.map((e) => e.id), ['review:https://github.com/o/r/pull/1', 'mention:https://github.com/o/r/pull/2', 'comment:o/r#3:11']);
  assert.equal(events[0].fields.draft, true);
  assert.equal(events[0].fields.ref, 'o/r#1');
  assert.equal(events[1].fields.is_pr, true);
  assert.deepEqual(events[1].things?.map((t) => t.key), ['mr:github.com/o/r/2']);
  assert.equal(events[2].link, 'https://github.com/o/r/pull/3#issuecomment-10');
  assert.equal(events[2].fields.count, 2);
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
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'comment:o/r#7:21');
  assert.equal(events[0].fields.count, 10);
  assert.match(events[0].text, /dave: новый$/);
  assert.ok(calls.some((c) => c.args.join(' ').includes('issues/7/comments?per_page=10&page=3')));
});

test('GitLab: версия ревью в id — обновление (новые коммиты) и запрос снова (todo, возврат в список) различимы', async () => {
  const url = 'https://gitlab.test/grp/repo/-/merge_requests/5';
  const st: { sha: string; todos: unknown[]; list: boolean } = { sha: 'aaa111', todos: [{ id: 10, target: { iid: 5 }, project: { path_with_namespace: 'grp/repo' }, created_at: '2026-11-17T09:00:00Z' }], list: true };
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/ user$/.test(line)) return JSON.stringify({ username: 'me' });
    if (/reviewer_username=me/.test(line)) return JSON.stringify(st.list ? [glMr(5, { sha: st.sha, updated_at: '2026-11-17T12:00:00Z' })] : []);
    if (/todos\?action=review_requested/.test(line)) return JSON.stringify(st.todos);
    if (/todos|author_username/.test(line)) return '[]';
    throw new Error(`нет ответа на ${line}`);
  };
  const kind = gitlabKind(x);
  const ctx = gitlabCtx('gl-ver.test');
  const ids = async () => (await kind.poll!(ctx)).map((e) => [e.id, e.fields.event, e.fields.again, e.title.split(':')[0]]);
  // первый раз — как раньше, без версии
  assert.deepEqual(await ids(), [[`review:${url}`, 'review', false, 'Ревью']]);
  assert.deepEqual(await ids(), [[`review:${url}`, 'review', false, 'Ревью']]);
  // новые коммиты, пока я ревьюер, — «MR обновлён»
  st.sha = 'bbb222';
  assert.deepEqual(await ids(), [[`update:${url}@bbb222`, 'update', false, 'MR обновлён']]);
  assert.deepEqual(await ids(), [[`update:${url}@bbb222`, 'update', false, 'MR обновлён']]);
  // автор запросил ревью снова — новый todo
  st.todos = [{ id: 11, target: { iid: 5 }, project: { path_with_namespace: 'grp/repo' }, created_at: '2026-11-17T13:00:00Z' }];
  const again = (await kind.poll!(ctx))[0];
  assert.deepEqual([again.id, again.fields.event, again.fields.again, again.at], [`review:${url}@t11`, 'review', true, '2026-11-17T13:00:00Z']);
  assert.match(again.title, /^Ревью снова: grp\/repo!5/);
  // todo закрыли — не новый запрос
  st.todos = [];
  assert.deepEqual((await ids())[0][0], `review:${url}@t11`);
  // меня сняли с ревьюеров и вернули — тоже запрос снова
  st.list = false;
  assert.deepEqual(await ids(), []);
  st.list = true;
  // метка — время обновления MR (todo нет); то же время, что у прошлого запроса, — всё равно новый id
  assert.deepEqual((await ids())[0].slice(0, 3), [`review:${url}@u20261117120000`, 'review', true]);
});

test('GitLab: todo «review_requested» не отдался (старый GitLab) — опрос идёт, запрос снова не выдумывается', async () => {
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/ user$/.test(line)) return JSON.stringify({ username: 'me' });
    if (/reviewer_username=me/.test(line)) return JSON.stringify([glMr(5, { sha: 'aaa' })]);
    if (/review_requested/.test(line)) throw new Error('400 action does not have a valid value');
    return '[]';
  };
  const ctx = gitlabCtx('gl-old.test');
  const kind = gitlabKind(x);
  assert.equal((await kind.poll!(ctx))[0].id, 'review:https://gitlab.test/grp/repo/-/merge_requests/5');
  assert.equal((await kind.poll!(ctx))[0].id, 'review:https://gitlab.test/grp/repo/-/merge_requests/5');
  assert.ok(ctx.logs.some((m) => /запросы ревью из todo не получены/.test(m)));
});

test('GitHub: PR вернулся в список ревью — запрос снова; новые коммиты — обновление; sha берётся только у обновлённых', async () => {
  const st = { list: true, updated: '2026-11-17T10:00:00Z', sha: 's1' };
  const { x, calls } = fakeExec([]);
  const exec: Exec = async (cmd, args, o) => {
    const line = args.join(' ');
    if (/gh-ver\.test user$/.test(line)) return JSON.stringify({ login: 'me' });
    if (/review-requested:me/.test(line)) return JSON.stringify({ items: st.list ? [ghItem(1, { updated_at: st.updated })] : [] });
    if (/repos\/o\/r\/pulls\/1$/.test(line)) {
      await x(cmd, args, o).catch(() => '');
      return JSON.stringify({ head: { sha: st.sha } });
    }
    return JSON.stringify({ items: [] });
  };
  const kind = githubKind(exec);
  const ctx = makeCtx({ slug: 'gh', kind: 'github', config: { host: 'gh-ver.test' } });
  const first = async () => (await kind.poll!(ctx))[0]?.id;
  const url = 'https://github.com/o/r/pull/1';
  assert.equal(await first(), `review:${url}`);
  assert.equal(await first(), `review:${url}`);
  // updated_at не менялся — head sha второй раз не спрашиваем
  assert.equal(calls.filter((c) => c.args.join(' ').endsWith('pulls/1')).length, 1);
  // комментарий двигает updated_at, а sha тот же — не обновление
  st.updated = '2026-11-17T11:00:00Z';
  assert.equal(await first(), `review:${url}`);
  st.updated = '2026-11-17T12:00:00Z';
  st.sha = 's2';
  assert.equal(await first(), `update:${url}@s2`);
  // я отревьюил — GitHub снял запрос; автор запросил снова
  st.list = false;
  assert.equal(await first(), undefined);
  st.list = true;
  assert.equal(await first(), `review:${url}@u20261117120000`);
});

test('комментарии к MR: за опрос — одно событие из новых; новых нет — то же событие; все новые мои — «своё»', async () => {
  let notes: Array<{ id: number; body: string; author: { username: string }; created_at: string }> = [
    { id: 1, body: 'первый', author: { username: 'bob' }, created_at: '2026-11-17T10:00:00Z' },
    { id: 2, body: 'второй', author: { username: 'bob' }, created_at: '2026-11-17T10:01:00Z' },
  ];
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/ user$/.test(line)) return JSON.stringify({ username: 'me' });
    if (/author_username=me/.test(line)) return JSON.stringify([glMr(9)]);
    if (/merge_requests\/9\/notes/.test(line)) return JSON.stringify([...notes].reverse());
    return '[]';
  };
  const kind = gitlabKind(x);
  const ctx = gitlabCtx('gl-notes.test');
  const poll = async () => (await kind.poll!(ctx)).filter((e) => e.fields.event === 'comment');
  let [e] = await poll();
  assert.deepEqual([e.id, e.fields.count], ['comment:grp/repo!9:2', 2]);
  [e] = await poll();
  assert.equal(e.id, 'comment:grp/repo!9:2');
  notes = [...notes, { id: 3, body: 'поправил', author: { username: 'me' }, created_at: '2026-11-17T11:00:00Z' }];
  [e] = await poll();
  assert.deepEqual([e.id, e.fields.count, e.fields.self, e.text], ['comment:grp/repo!9:3', 1, true, 'поправил']);
  notes = [...notes, { id: 4, body: 'ок', author: { username: 'bob' }, created_at: '2026-11-17T12:00:00Z' }, { id: 5, body: 'и ещё', author: { username: 'carol' }, created_at: '2026-11-17T12:05:00Z' }];
  [e] = await poll();
  assert.deepEqual([e.id, e.fields.count, e.fields.self, e.author, e.link], ['comment:grp/repo!9:5', 2, false, 'carol', 'https://gitlab.test/grp/repo/-/merge_requests/9#note_4']);
  assert.equal(e.text, 'bob: ок\n\ncarol: и ещё');
});

test('проверка без записи курсора (история, пробная) отдаёт те же id, что и опрос', async () => {
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/ user$/.test(line)) return JSON.stringify({ username: 'me' });
    if (/reviewer_username=me/.test(line)) return JSON.stringify([glMr(5, { sha: 'aaa' })]);
    if (/author_username=me/.test(line)) return JSON.stringify([glMr(9)]);
    if (/merge_requests\/9\/notes/.test(line)) return JSON.stringify([{ id: 7, body: 'x', author: { username: 'bob' } }]);
    return '[]';
  };
  const ctx = gitlabCtx('gl-ro.test');
  const a = (await gitlabKind(x).poll!(ctx)).map((e) => e.id);
  // курсор не сохранили (readonlyCursor) — тот же ответ
  const ro = { ...ctx, cursor: { get: () => undefined, set: () => {} } };
  assert.deepEqual((await gitlabKind(x).poll!(ro)).map((e) => e.id), a);
});

test('версия вещи MR: у обновления и у упоминания в MR, где я ревьюер, — версия текущего запроса, у прочего — своя', async () => {
  const url = 'https://gitlab.test/grp/repo/-/merge_requests/5';
  let sha = 'aaa';
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/ user$/.test(line)) return JSON.stringify({ username: 'me' });
    if (/reviewer_username=me/.test(line)) return JSON.stringify([glMr(5, { sha })]);
    if (/review_requested/.test(line)) return '[]';
    if (/action=mentioned/.test(line))
      return JSON.stringify([
        { id: 70, target_type: 'MergeRequest', target_url: `${url}#note_3`, target: { iid: 5 }, project: { path_with_namespace: 'grp/repo' } },
        { id: 71, target_type: 'MergeRequest', target_url: 'https://gitlab.test/grp/repo/-/merge_requests/8#note_4', target: { iid: 8 }, project: { path_with_namespace: 'grp/repo' } },
      ]);
    return '[]';
  };
  const kind = gitlabKind(x);
  const ctx = gitlabCtx('gl-version.test');
  await kind.poll!(ctx);
  sha = 'bbb';
  const [update, mention, other] = await kind.poll!(ctx);
  assert.equal(update.id, `update:${url}@bbb`);
  assert.equal(update.things?.[0].ref.version, `review:${url}`);
  assert.equal(mention.things?.[0].ref.version, `review:${url}`);
  // MR, где я не ревьюер, — версию даст движок (id события)
  assert.equal(other.things?.[0].ref.version, undefined);
});

test('GitLab: todo исходного запроса пришёл позже первого опроса — не «ревью снова»; новый todo через полчаса — снова', async () => {
  let todos: unknown[] = [];
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/ user$/.test(line)) return JSON.stringify({ username: 'me' });
    if (/reviewer_username=me/.test(line)) return JSON.stringify([glMr(5, { sha: 'aaa' })]);
    if (/review_requested/.test(line)) return JSON.stringify(todos);
    return '[]';
  };
  const kind = gitlabKind(x);
  const ctx = gitlabCtx('gl-late.test');
  const id = async () => (await kind.poll!(ctx))[0].id;
  const url = 'https://gitlab.test/grp/repo/-/merge_requests/5';
  assert.equal(await id(), `review:${url}`);
  todos = [{ id: 20, target: { iid: 5 }, project: { path_with_namespace: 'grp/repo' }, created_at: new Date(Date.now() + 30_000).toISOString() }];
  assert.equal(await id(), `review:${url}`);
  todos = [{ id: 21, target: { iid: 5 }, project: { path_with_namespace: 'grp/repo' }, created_at: new Date(Date.now() + 30 * 60_000).toISOString() }];
  assert.equal(await id(), `review:${url}@t21`);
});

test('GitLab с корнем не в «/»: ключ вещи — по веб-адресу (как у ссылки в чате), путь для API — из ответа', async () => {
  const web = 'https://gitlab.test/gitlab/grp/repo/-/merge_requests/5';
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/ user$/.test(line)) return JSON.stringify({ username: 'me' });
    if (/reviewer_username=me/.test(line)) return JSON.stringify([glMr(5, { web_url: web })]);
    return '[]';
  };
  const [e] = await gitlabKind(x).poll!(gitlabCtx('gl-root.test'));
  assert.equal(e.things?.[0].key, resolveThings({ text: `глянь ${web}` })[0].key);
  assert.equal(e.things?.[0].ref.project, 'grp/repo');
});

test('GitHub: неполная выдача поиска (incomplete_results) не помечает PR ушедшим — без ложного «ревью снова»', async () => {
  let resp: { items: unknown[]; incomplete_results?: boolean } = { items: [ghItem(1)] };
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/gh-inc\.test user$/.test(line)) return JSON.stringify({ login: 'me' });
    if (/review-requested:me/.test(line)) return JSON.stringify(resp);
    if (/pulls\/1$/.test(line)) return JSON.stringify({ head: { sha: 's1' } });
    return JSON.stringify({ items: [] });
  };
  const kind = githubKind(x);
  const ctx = makeCtx({ slug: 'gh', kind: 'github', config: { host: 'gh-inc.test' } });
  await kind.poll!(ctx);
  resp = { items: [], incomplete_results: true };
  await kind.poll!(ctx);
  resp = { items: [ghItem(1)] };
  assert.equal((await kind.poll!(ctx))[0].id, 'review:https://github.com/o/r/pull/1');
});

test('комментарии: MR впервые в курсоре — старые (до прошлого опроса) не идут в пачку; id в ответе не вытесняются', async () => {
  const old = new Date(Date.now() - 3600_000).toISOString();
  const fresh = new Date(Date.now() + 1000).toISOString();
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/ user$/.test(line)) return JSON.stringify({ username: 'me' });
    if (/author_username=me/.test(line)) return JSON.stringify([glMr(9)]);
    if (/merge_requests\/9\/notes/.test(line))
      return JSON.stringify([
        { id: 8, body: 'новый', author: { username: 'bob' }, created_at: fresh },
        { id: 7, body: 'старый', author: { username: 'bob' }, created_at: old },
      ]);
    return '[]';
  };
  // прошлый опрос был минуту назад, этого MR тогда в курсоре не было
  const ctx = gitlabCtx('gl-first.test');
  ctx.cursor.set({ reviews: {}, notes: {}, at: new Date(Date.now() - 60_000).toISOString() });
  const [e] = (await gitlabKind(x).poll!(ctx)).filter((ev) => ev.fields.event === 'comment');
  assert.deepEqual([e.id, e.text, e.fields.count], ['comment:grp/repo!9:8', 'новый', 1]);
  // в курсоре 40 других id и 7-й, который ещё в ответе: 7-й остаётся
  const many = Array.from({ length: 45 }, (_, i) => `x${i}`);
  ctx.cursor.set({ reviews: {}, notes: { 'grp/repo!9': { ids: ['7', ...many], last: 'comment:grp/repo!9:8' } }, at: new Date().toISOString() });
  await gitlabKind(x).poll!(ctx);
  const ids = (ctx.cursorValue() as { notes: Record<string, { ids: string[] }> }).notes['grp/repo!9'].ids;
  assert.ok(ids.includes('7') && ids.includes('8'));
  assert.equal(ids.length, 40);
});

test('MR, вытесненный из курсора и вернувшийся в ревью, получает id с меткой, а не уже виденный review:<адрес>', async () => {
  const url = 'https://gitlab.test/grp/repo/-/merge_requests/5';
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/ user$/.test(line)) return JSON.stringify({ username: 'me' });
    if (/reviewer_username=me/.test(line)) return JSON.stringify([glMr(5, { sha: 'aaa', updated_at: '2026-11-18T09:30:00Z' })]);
    if (/review_requested/.test(line)) return JSON.stringify([{ id: 99, target: { iid: 5 }, project: { path_with_namespace: 'grp/repo' } }]);
    return '[]';
  };
  // курсор уже работал (прошлый опрос был), а этого MR в нём нет — вытеснен
  const ctx = gitlabCtx('gl-evicted.test');
  ctx.cursor.set({ reviews: { 'https://gitlab.test/other/-/merge_requests/1': { req: 1, id: 'review:x', kind: 'review' } }, notes: {}, at: '2026-11-18T09:00:00Z' });
  const [e] = await gitlabKind(x).poll!(ctx);
  assert.equal(e.id, `review:${url}@t99`);
  // самый первый опрос источника — как раньше, без метки
  assert.equal((await gitlabKind(x).poll!(gitlabCtx('gl-fresh.test')))[0].id, `review:${url}`);
});

test('MR из форка: ветку не отдаём (она в другом репо), fields.fork = true', async () => {
  const x: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/ user$/.test(line)) return JSON.stringify({ username: 'me' });
    if (/reviewer_username=me/.test(line))
      return JSON.stringify([glMr(5, { source_branch: 'feat', source_project_id: 7, target_project_id: 3 }), glMr(6, { source_branch: 'fix', source_project_id: 3, target_project_id: 3 })]);
    return '[]';
  };
  const [fork, own] = await gitlabKind(x).poll!(gitlabCtx('gl-fork.test'));
  assert.deepEqual([fork.fields.fork, fork.fields.branch], [true, undefined]);
  assert.deepEqual([own.fields.fork, own.fields.branch], [undefined, 'fix']);
  // GitHub: голова PR из другого репо
  const gx: Exec = async (_cmd, args) => {
    const line = args.join(' ');
    if (/gh-fork\.test user$/.test(line)) return JSON.stringify({ login: 'me' });
    if (/review-requested:me/.test(line)) return JSON.stringify({ items: [ghItem(1)] });
    if (/pulls\/1$/.test(line)) return JSON.stringify({ head: { sha: 's1', repo: { full_name: 'dave/r' } }, base: { repo: { full_name: 'o/r' } } });
    return JSON.stringify({ items: [] });
  };
  const [pr] = await githubKind(gx).poll!(makeCtx({ slug: 'gh', kind: 'github', config: { host: 'gh-fork.test' } }));
  assert.equal(pr.fields.fork, true);
});
