import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchKey, jiraKey, keyLabel, mrKey, normHost, ownKey, parseKey, runKey, sessionKey, threadKey, twKey } from './keys.js';

test('ключ MR один, как ни напиши хост и путь: регистр, схема, «/» по краям, .git, www и порт по умолчанию', () => {
  const k = 'mr:gitlab.company.com/grp/sub/app/12';
  assert.equal(mrKey('gitlab.company.com', 'grp/sub/app', 12), k);
  assert.equal(mrKey('https://GitLab.Company.com/', '/Grp/Sub/App/', 12), k);
  assert.equal(mrKey('gitlab.company.com:443', 'grp/sub/app.git', 12), k);
  assert.equal(mrKey('www.github.com', 'Acme/Billing', 7), 'mr:github.com/acme/billing/7');
  // нестандартный порт — часть хоста
  assert.equal(mrKey('git.local:8443', 'a/b', 1), 'mr:git.local:8443/a/b/1');
  assert.equal(normHost('https://user@Jira.Example.com./browse/X-1'), 'jira.example.com');
});

test('ключ MR без проекта, с одним сегментом пути или без номера не собирается', () => {
  assert.throws(() => mrKey('gitlab.com', '', 1), /не собрать/);
  assert.throws(() => mrKey('gitlab.com', 'app', 1), /не собрать/);
  assert.throws(() => mrKey('gitlab.com', 'a/b', 0), /не собрать/);
  assert.throws(() => mrKey('', 'a/b', 3), /не собрать/);
});

test('ключ задачи Jira: хост в нижнем регистре, ключ заглавными; не ключ — ошибка', () => {
  assert.equal(jiraKey('https://Acme.atlassian.net', 'abc-12'), 'jira:acme.atlassian.net/ABC-12');
  assert.throws(() => jiraKey('acme.atlassian.net', 'ABC'), /не собрать/);
  assert.throws(() => jiraKey('acme.atlassian.net', 'ABC-0'), /не собрать/);
});

test('ключ ветки: корень без «/» в конце, refs/heads/ снимается; # в ветке разбирается обратно', () => {
  assert.equal(branchKey('/Users/me/app/', 'refs/heads/feat/x'), 'branch:/Users/me/app#feat/x');
  assert.equal(branchKey('C:\\work\\app', 'main'), 'branch:C:/work/app#main');
  const k = branchKey('/repo', 'fix#12');
  assert.deepEqual(parseKey(k), { type: 'branch', ref: { root: '/repo', branch: 'fix#12' } });
  assert.throws(() => branchKey('/repo', ''), /не собрать/);
});

test('ключ нити: «/» и «%» в частях не ломают разбор; канала может не быть', () => {
  const k = threadKey({ source: 'slack-work', channel: 'C01', thread: '1700000000.000100' });
  assert.equal(k, 'thread:slack-work/C01/1700000000.000100');
  assert.deepEqual(parseKey(k), { type: 'thread', ref: { source: 'slack-work', channel: 'C01', thread: '1700000000.000100' } });
  const mail = threadKey({ source: 'mail', thread: '<a/b%c@host>' });
  assert.deepEqual(parseKey(mail), { type: 'thread', ref: { source: 'mail', thread: '<a/b%c@host>' } });
  assert.throws(() => threadKey({ source: 'x', thread: ' ' }), /не собрать/);
});

test('parseKey разбирает каждый тип и отвечает undefined на чужое', () => {
  assert.deepEqual(parseKey('mr:gitlab.com/grp/sub/app/12'), { type: 'mr', ref: { host: 'gitlab.com', project: 'grp/sub/app', number: 12 } });
  assert.deepEqual(parseKey('jira:acme.atlassian.net/ABC-12'), { type: 'jira', ref: { host: 'acme.atlassian.net', key: 'ABC-12' } });
  assert.deepEqual(parseKey(twKey('core', 'billing', 'T-3')), { type: 'teamwork', ref: { team: 'core', project: 'billing', id: 'T-3' } });
  assert.deepEqual(parseKey(sessionKey('s1')), { type: 'session', ref: { id: 's1' } });
  assert.deepEqual(parseKey(runKey('r1')), { type: 'run', ref: { id: 'r1' } });
  assert.deepEqual(parseKey(ownKey('o1')), { type: 'own', ref: { id: 'o1' } });
  for (const bad of ['', 'mr', 'mr:', 'mr:gitlab.com/app/1', 'mr:gitlab.com/a/b/x', 'jira:host/abc', 'zzz:1', 'branch:#x', 'thread:a/b']) assert.equal(parseKey(bad), undefined, bad);
});

test('подпись по ключу: MR и PR, задача, ветка', () => {
  assert.equal(keyLabel('mr:gitlab.com/grp/app/12'), 'MR grp/app!12');
  assert.equal(keyLabel('mr:github.com/o/r/7'), 'PR o/r#7');
  assert.equal(keyLabel('mr:ghe.corp/o/r/7', 'github'), 'PR o/r#7');
  assert.equal(keyLabel('jira:acme.atlassian.net/ABC-1'), 'ABC-1');
  assert.equal(keyLabel('branch:/repo#feat'), 'ветка feat');
  assert.equal(keyLabel('что-то'), 'что-то');
});
