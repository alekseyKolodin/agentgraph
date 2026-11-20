// Шаблоны рутин «Моих дел» (этап 4.7): подбор источника, шаги «Новой рутины» и правило, которое из них получится.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceView } from '@server/routines/types';
import { matchFields } from './match';
import { buildSpec, draftMissing, SCHEDULE } from './spec';
import { connectHref, connectParam, isSlackConnector, profileLine, ROUTINE_TEMPLATES, servicesFor, sourceForTemplate, templateConds, templateDraft, templateOf } from './templates';

const src = (slug: string, kind: string, extra: Partial<SourceView['spec']> = {}, canReply = false): SourceView => ({
  slug,
  spec: { title: slug, kind, config: {}, ...extra },
  status: 'ok',
  missingSecrets: [],
  usedBy: [],
  canReply,
});

const SOURCES = [
  src('tg', 'telegram'),
  src('notion', 'connector', { title: 'Notion через Claude' }),
  src('slack-claude', 'connector', { title: 'Slack через Claude', description: 'сообщения каналов' }),
  src('gl', 'gitlab', {}, true),
  src('jira', 'jira', {}, true),
  src('ff', 'command', { title: 'Fireflies.ai · записи встреч' }),
];

test('шаблоны: четыре «Моих дел» первыми, у каждого — готовый flow', () => {
  const desk = ROUTINE_TEMPLATES.filter((x) => x.desk);
  assert.deepEqual(desk.slice(0, 4).map((x) => x.tpl), ['review-forge', 'review-slack', 'jira', 'meetings']);
  assert.deepEqual(ROUTINE_TEMPLATES.slice(0, desk.length), desk);
  for (const x of desk) assert.match(x.flow ?? '', /^desk-/);
});

test('источник шаблона: GitLab/GitHub, Slack через коннектор, Jira, встречи, расписание', () => {
  assert.equal(sourceForTemplate('review-forge', SOURCES), 'gl');
  assert.equal(sourceForTemplate('review-slack', SOURCES), 'slack-claude');
  assert.equal(isSlackConnector(SOURCES[1]!), false);
  // Slack токеном бота — тоже годится, если коннектора нет
  assert.equal(sourceForTemplate('review-slack', [src('work', 'slack')]), 'work');
  assert.equal(sourceForTemplate('jira', SOURCES), 'jira');
  assert.equal(sourceForTemplate('meetings', SOURCES), 'ff');
  assert.equal(sourceForTemplate('sweep', SOURCES), SCHEDULE);
  assert.equal(sourceForTemplate('review-forge', []), '');
});

test('ревью из GitLab: событие review, дело «Ревью» по вещи, flow desk-review-mr, черновик ответа в MR', () => {
  const d = templateDraft('review-forge', { source: SOURCES[3] });
  assert.deepEqual(draftMissing(d), []);
  const spec = buildSpec({ ...d, title: 'Ревью' }, [{ key: 'event', label: 'Что', type: 'enum' }]);
  assert.deepEqual(spec.when, { source: 'gl', match: [{ field: 'event', op: 'eq', value: 'review' }] });
  assert.equal(spec.run?.flow, 'desk-review-mr');
  assert.equal(spec.mode, 'suggest');
  assert.deepEqual(spec.task, { kind: 'Ревью', same: 'thing' });
  assert.deepEqual(spec.reply, { to: 'source', on: ['end'], draft: true });
});

test('ревью по ссылке в Slack: условие на ссылку MR/PR в тексте; без инструмента ответа — без ответа рутины', () => {
  const spec = buildSpec({ ...templateDraft('review-slack', { source: SOURCES[2] }), title: 'x' }, []);
  assert.deepEqual(spec.when, { source: 'slack-claude', match: [{ field: 'text', op: 'contains', value: ['/merge_requests/', '/pull/'] }] });
  assert.deepEqual(spec.task, { kind: 'Ревью', same: 'thing' });
  assert.deepEqual(spec.reply, { to: 'none' });
  // инструмент ответа в источнике настроен — черновик в тред
  assert.equal(buildSpec({ ...templateDraft('review-slack', { source: { ...SOURCES[2]!, canReply: true } }), title: 'x' }, []).reply?.to, 'source');
});

test('Jira и встречи: назначили на меня → дело и запуск по кнопке; встреча → дела заводит flow, «кто я» в задаче', () => {
  const jira = buildSpec({ ...templateDraft('jira', { source: SOURCES[4] }), title: 'x' }, []);
  assert.deepEqual(jira.when, { source: 'jira', match: [{ field: 'change', op: 'eq', value: ['assigned', 'new'] }] });
  assert.equal(jira.run?.flow, 'desk-task-start');
  // правки задачи — в новом рабочем дереве
  assert.equal(jira.run?.worktree, 'new');
  assert.deepEqual(jira.task, { kind: 'Jira', same: 'thing' });
  const meet = buildSpec({ ...templateDraft('meetings', { source: SOURCES[5], me: 'Аня, anya@example.com' }), title: 'x' }, []);
  assert.equal(meet.run?.flow, 'desk-meeting-tasks');
  assert.match(meet.run?.input ?? '', /Кто я: Аня, anya@example\.com\./);
  assert.equal(meet.mode, 'auto');
  assert.deepEqual(meet.task, { kind: 'Встреча', from: 'flow', same: 'thing' });
  assert.deepEqual(meet.limits, { usd: 1 });
});

test('«кто я» из профиля: имена, почта, логины без повторов', () => {
  assert.equal(profileLine({ names: ['Аня'], emails: ['a@x.io'], jiraEmail: 'a@x.io', gitlab: 'anya' }), 'Аня, a@x.io, @anya (GitLab)');
  assert.equal(profileLine(undefined), '');
});

test('«Подключить сервис» у Slack-ревью ведёт сразу к коннектору Claude со Slack, у остальных — обычная страница', () => {
  const slack = new URL(connectHref(templateOf('review-slack')!), 'http://x');
  assert.equal(slack.pathname, '/routines/connect');
  assert.deepEqual(Object.fromEntries(slack.searchParams), { from: 'new', tpl: 'review-slack', mode: 'ready', kind: 'connector', service: 'slack' });
  assert.equal(connectHref(templateOf('jira')!), '/routines/connect?from=new&tpl=jira');
});

test('параметры адреса «Подключить сервис» — только слаг; сервисы по подсказке — подключённые с этим именем', () => {
  assert.equal(connectParam('connector'), 'connector');
  assert.equal(connectParam('Slack'), undefined);
  assert.equal(connectParam('a b'), undefined);
  assert.equal(connectParam(null), undefined);
  const ready = [{ server: 'claude.ai Slack', title: 'Slack' }, { server: 'notion', title: 'Notion' }, { server: 'x-slack-bot', title: 'Bot' }];
  assert.deepEqual(servicesFor(ready, 'slack'), ['claude.ai Slack', 'x-slack-bot']);
  assert.deepEqual(servicesFor(ready, undefined), []);
});

test('источник выбран руками: условие шаблона остаётся, если у источника есть такое поле; иначе его нет, а не «никогда не сработает»', () => {
  const plain = matchFields(undefined);
  const forge = matchFields({ match: [{ key: 'event', label: 'Событие', type: 'enum', options: ['review'] }] });
  // ссылка на MR — в тексте: «Текст» есть у любого источника, в том числе у своей команды
  assert.deepEqual(templateConds('review-slack', plain).map((c) => [c.field, c.op]), [['text', 'contains']]);
  // событие review — только у GitLab/GitHub; у своей команды такого поля нет
  assert.deepEqual(templateConds('review-forge', forge).map((c) => c.field), ['event']);
  assert.deepEqual(templateConds('review-forge', plain), []);
  // поле есть, а значения «review» в его списке нет — условие не сработает никогда
  const other = matchFields({ match: [{ key: 'event', label: 'Событие', type: 'enum', options: ['push', 'tag'] }] });
  assert.deepEqual(templateConds('review-forge', other), []);
  // без шаблона и у неизвестного — пусто
  assert.deepEqual(templateConds(null, forge), []);
  assert.deepEqual(templateConds('nope', forge), []);
  // правило получается то же, что у подставленного источника
  const spec = buildSpec({ ...templateDraft('review-slack', { source: SOURCES[2] }), conds: templateConds('review-slack', plain) }, plain);
  assert.deepEqual('match' in spec.when ? spec.when.match : undefined, [{ field: 'text', op: 'contains', value: ['/merge_requests/', '/pull/'] }]);
});
