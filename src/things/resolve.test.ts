import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mrThing, resolveSignal, resolveThings, thingLabel, thingOfUrl, threadOfItem, threadRef, THINGS_MAX } from './resolve.js';

const JIRA = ['jira.company.com'];
const keys = (s: Parameters<typeof resolveThings>[0], hosts: string[] = JIRA) => resolveThings(s, { jiraHosts: hosts }).map((t) => t.key);

test('адрес MR GitLab любого хоста — вещь mr; хвосты /diffs, #note и ?query не меняют ключ', () => {
  for (const u of [
    'https://gitlab.company.com/grp/sub/app/-/merge_requests/12',
    'https://gitlab.company.com/grp/sub/app/-/merge_requests/12/diffs#note_5',
    'https://GITLAB.company.com/Grp/Sub/App/-/merge_requests/12?tab=overview',
    'https://gitlab.company.com/grp/sub/app/merge_requests/12',
  ]) {
    const t = thingOfUrl(u);
    assert.equal(t?.key, 'mr:gitlab.company.com/grp/sub/app/12', u);
    assert.equal(t?.ref.forge, 'gitlab');
    assert.equal(t?.ref.number, 12);
  }
  // путь для API — как в ссылке, ссылка — каноническая
  const t = thingOfUrl('https://gitlab.company.com/Grp/App/-/merge_requests/3/diffs')!;
  assert.equal(t.ref.project, 'Grp/App');
  assert.equal(t.url, 'https://gitlab.company.com/Grp/App/-/merge_requests/3');
  assert.equal(thingLabel(t), 'MR Grp/App!3');
});

test('адрес PR GitHub и GitHub Enterprise — вещь mr с forge github', () => {
  const t = thingOfUrl('https://github.com/Acme/Billing/pull/42/files#diff-1')!;
  assert.equal(t.key, 'mr:github.com/acme/billing/42');
  assert.deepEqual(t.ref, { forge: 'github', host: 'github.com', project: 'Acme/Billing', number: 42 });
  assert.equal(t.url, 'https://github.com/Acme/Billing/pull/42');
  assert.equal(thingLabel(t), 'PR Acme/Billing#42');
  assert.equal(thingOfUrl('https://ghe.corp.local/o/r/pull/7')?.key, 'mr:ghe.corp.local/o/r/7');
});

test('не MR: задача GitLab, эпик, список MR группы, коммит, issue GitHub, не http', () => {
  for (const u of [
    'https://gitlab.com/grp/app/-/issues/3',
    'https://gitlab.com/groups/grp/-/epics/5',
    'https://gitlab.com/groups/grp/-/merge_requests',
    'https://gitlab.com/app/-/merge_requests/1',
    'https://github.com/o/r/commit/abc',
    'https://github.com/o/r/issues/4',
    'ftp://github.com/o/r/pull/4',
    'не адрес',
  ])
    assert.equal(thingOfUrl(u), undefined, u);
});

test('задача Jira — по хостам из настроек и Jira Cloud: /browse/, ?selectedIssue=, …/issues/KEY; Confluence — нет', () => {
  assert.equal(thingOfUrl('https://jira.company.com/browse/abc-12', JIRA)?.key, 'jira:jira.company.com/ABC-12');
  assert.equal(thingOfUrl('https://jira.company.com/secure/RapidBoard.jspa?rapidView=1&selectedIssue=ABC-7', JIRA)?.key, 'jira:jira.company.com/ABC-7');
  assert.equal(thingOfUrl('https://acme.atlassian.net/jira/software/c/projects/ABC/issues/ABC-9')?.key, 'jira:acme.atlassian.net/ABC-9');
  assert.equal(thingOfUrl('https://acme.atlassian.net/browse/ABC-9')?.url, 'https://acme.atlassian.net/browse/ABC-9');
  // чужой хост с /browse/ — не знаем, что это Jira
  assert.equal(thingOfUrl('https://tracker.other.com/browse/ABC-1', JIRA), undefined);
  // страница Confluence «Release-2» на том же хосте — не задача
  assert.equal(thingOfUrl('https://acme.atlassian.net/wiki/spaces/ENG/pages/1/RELEASE-2'), undefined);
  assert.equal(thingOfUrl('https://acme.atlassian.net/jira/software/projects/ABC/boards/1'), undefined);
});

test('ссылки в тексте Slack (<url|подпись>), markdown и с пунктуацией; несколько ссылок — несколько вещей без повторов', () => {
  const text = 'Глянь <https://gitlab.com/grp/app/-/merge_requests/5|!5>, и ещё [PR](https://github.com/o/r/pull/9). И снова https://gitlab.com/grp/app/-/merge_requests/5.';
  assert.deepEqual(keys({ text }), ['mr:gitlab.com/grp/app/5', 'mr:github.com/o/r/9']);
});

test('ключ задачи в тексте — когда хост Jira один; стандарты и кодировки ключами не считаются', () => {
  const text = 'ABC-12: правка оплаты, UTF-8 и ISO-8601, см. SHA-256 и GPT-4; версия 1.2-3; X-1; DEF-7.';
  assert.deepEqual(keys({ text }), ['jira:jira.company.com/ABC-12', 'jira:jira.company.com/DEF-7']);
  // хоста нет или их несколько — чей ключ, не знаем
  assert.deepEqual(keys({ text }, []), []);
  assert.deepEqual(keys({ text }, ['a.atlassian.net', 'b.atlassian.net']), []);
  // ключ внутри адреса не дублируется отдельной вещью и не путается с путём
  assert.deepEqual(keys({ text: 'https://jira.company.com/browse/ABC-12 и feature/ABC-13' }), ['jira:jira.company.com/ABC-12']);
});

test('своя вещь — из ссылки события, упомянутые — из текста; MR раньше задач; главная — первая', () => {
  const r = resolveSignal({ link: 'https://jira.company.com/browse/ABC-1', title: 'ABC-1 Оплата', text: 'MR: https://gitlab.com/g/app/-/merge_requests/3, ещё DEF-2' }, { jiraHosts: JIRA });
  assert.deepEqual(r.own.map((t) => t.key), ['jira:jira.company.com/ABC-1']);
  assert.deepEqual(r.mentioned.map((t) => t.key), ['mr:gitlab.com/g/app/3', 'jira:jira.company.com/DEF-2']);
  // ссылка события — не вещь (сообщение Slack): главная — упомянутый MR, даже если ключ задачи стоит раньше
  assert.deepEqual(keys({ link: 'https://acme.slack.com/archives/C1/p1', text: 'ABC-1 готов https://gitlab.com/g/app/-/merge_requests/3' }), ['mr:gitlab.com/g/app/3', 'jira:jira.company.com/ABC-1']);
});

test('сводка со множеством ссылок — не больше THINGS_MAX вещей', () => {
  const text = Array.from({ length: 30 }, (_, i) => `https://gitlab.com/g/app/-/merge_requests/${i + 1}`).join('\n');
  assert.equal(resolveThings({ text }).length, THINGS_MAX);
});

test('mrThing нормализует ключ, но хранит путь как есть', () => {
  const t = mrThing({ forge: 'gitlab', host: 'GitLab.com', project: '/Grp/App/', number: 4 });
  assert.equal(t.key, 'mr:gitlab.com/grp/app/4');
  assert.deepEqual(t.ref, { forge: 'gitlab', host: 'gitlab.com', project: 'Grp/App', number: 4 });
});

test('нить записи по FieldMap: пути через точку, число — строкой, пустая нить — нет нити', () => {
  const item = { msg: { ts: 1700000000.0001, thread_ts: '1700000000.000100' }, channel: { id: 'C01' } };
  assert.deepEqual(threadOfItem('slack', item, { thread: 'msg.thread_ts', channel: 'channel.id' }), { source: 'slack', channel: 'C01', thread: '1700000000.000100' });
  assert.deepEqual(threadOfItem('slack', item, { thread: 'msg.ts' }), { source: 'slack', thread: '1700000000.0001' });
  assert.equal(threadOfItem('slack', item, { thread: 'msg.none', channel: 'channel.id' }), undefined);
  assert.equal(threadOfItem('slack', item, {}), undefined);
  assert.equal(threadRef('s', 'C1', ''), undefined);
});
