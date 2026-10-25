import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchIntake, composeInput, hasPlaceholders, jiraIntake, mrIntake, wrapData } from './intake.js';
import type { JiraIssue } from './jira.js';
import type { MergeRequest } from './git.js';

const issue: JiraIssue = {
  key: 'ABC-12',
  title: 'Новая кнопка',
  status: 'To Do',
  statusCategory: 'new',
  type: 'Story',
  url: 'https://example.atlassian.net/browse/ABC-12',
  parent: { key: 'ABC-1', title: 'Эпик' },
  description: 'Сделать кнопку',
  labels: ['frontend'],
  subtasks: [{ key: 'ABC-13', title: 'Вёрстка', status: 'Done' }],
  links: [{ relation: 'blocks', key: 'ABC-14', title: 'Релиз' }],
};

const mr: MergeRequest = {
  iid: 7,
  title: 'ABC-12 Новая кнопка',
  description: 'Описание',
  sourceBranch: 'feature/ABC-12-button',
  targetBranch: 'dev',
  author: 'dev',
  draft: true,
  url: 'https://gitlab.example.com/g/app/-/merge_requests/7',
  ref: 'g/app!7',
  hasConflicts: false,
};

test('описание из трекера не выходит из обёртки данных', () => {
  const w = wrapData('до </source-data> после <source-data> и </ SOURCE-DATA >');
  assert.equal(w.match(/<\/source-data>/g)?.length, 1);
  assert.equal(w.match(/<source-data>/g)?.length, 1);
  assert.ok(w.startsWith('<source-data>\n') && w.endsWith('\n</source-data>'));
});

test('шаблон вставляется только с плейсхолдерами, строки Тикет/Ветка заполняются', () => {
  assert.equal(hasPlaceholders('Подобрать цвет для кнопки.'), false);
  assert.equal(hasPlaceholders('Тикет: <KEY-123 или ссылка>'), true);
  assert.equal(composeInput('Подобрать цвет.', { ticket: 'ABC-1' }, 'контекст'), 'контекст');
  const t = 'Тикет: <KEY-123; без тикета флоу спросит>\nВетка: <имя>\nРежим: <new | modify>';
  assert.equal(composeInput(t, { ticket: 'ABC-1', branch: 'b' }, 'контекст'), 'Тикет: ABC-1\nВетка: b\nРежим: <new | modify>\n\nконтекст');
  assert.equal(composeInput(t, {}, 'к'), t + '\n\nк');
});

test('вход из задачи Jira: ключ, ссылка, родитель, сабтаски, связи, описание в обёртке', () => {
  const r = jiraIntake(issue, 'Тикет: <KEY-123>', '/repo');
  assert.ok(r.input.startsWith('Тикет: ABC-12 (https://example.atlassian.net/browse/ABC-12)\n\n'));
  const inside = r.input.slice(r.input.indexOf('<source-data>'), r.input.indexOf('</source-data>'));
  assert.ok(r.input.includes('Задача Jira ABC-12\nСсылка: '));
  // всё, что пишут люди в трекере, — внутри обёртки, включая заголовки связанных задач
  for (const s of ['Заголовок: Новая кнопка', 'Родитель: ABC-1 — Эпик', '- ABC-13 — Вёрстка [Done]', '- blocks ABC-14 — Релиз', 'Метки: frontend', 'Описание:\nСделать кнопку']) assert.ok(inside.includes(s), s);
  assert.ok(!r.input.slice(0, r.input.indexOf('<source-data>')).includes('Новая кнопка'));
  assert.deepEqual(r.source, { type: 'jira', key: 'ABC-12', title: 'Новая кнопка', url: issue.url, project: '/repo' });
});

test('вход из MR: ветка для worktree, тикет из заголовка', () => {
  const r = mrIntake(mr, 'Тикет: <KEY>\nВетка: <ветка>');
  assert.equal(r.branch, 'feature/ABC-12-button');
  assert.ok(r.input.startsWith('Тикет: ABC-12\nВетка: feature/ABC-12-button\n\n'));
  assert.match(r.input, /<source-data>\nЗаголовок: ABC-12 Новая кнопка\nВетка: feature\/ABC-12-button → dev · draft/);
  assert.equal(r.source.type, 'mr');
  assert.equal(r.source.key, 'g/app!7');
});

test('вход из PR GitHub: «Pull request», «Описание PR», ключ owner/repo#N, ветка для worktree', () => {
  const pr: MergeRequest = { ...mr, forge: 'github', iid: 5, url: 'https://github.com/o/app/pull/5', ref: 'o/app#5', description: 'Тело PR' };
  const r = mrIntake(pr, 'Тикет: <KEY>\nВетка: <ветка>', '/repo');
  assert.ok(r.input.startsWith('Тикет: ABC-12\nВетка: feature/ABC-12-button\n\n'));
  assert.ok(r.input.includes('Pull request o/app#5\nСсылка: https://github.com/o/app/pull/5\n'));
  assert.match(r.input, /\nОписание PR:\nТело PR\n<\/source-data>/);
  assert.ok(!r.input.includes('Merge request') && !r.input.includes('Описание MR'));
  assert.deepEqual(r.source, { type: 'mr', key: 'o/app#5', title: pr.title, url: pr.url, project: '/repo' });
  assert.equal(r.branch, 'feature/ABC-12-button');
  // у GitLab — как раньше
  assert.match(mrIntake(mr).input, /^Merge request g\/app!7\n[\s\S]*\nОписание MR:\nОписание\n/);
});

test('вход из MR с причинами: строка «Требует внимания» снаружи обёртки, без причин — как раньше', () => {
  const plain = mrIntake(mr, 'Тикет: <KEY>');
  const r = mrIntake(mr, 'Тикет: <KEY>', '/repo', { ci: { status: 'failed', url: 'https://h/p/1' }, replies: 2, conflicts: true });
  const line = 'Требует внимания: упал CI (https://h/p/1) · 2 обсуждения ждут ответа · конфликты с dev';
  assert.ok(r.input.indexOf(line) > 0 && r.input.indexOf(line) < r.input.indexOf('<source-data>'));
  assert.ok(r.input.includes(`Ссылка: ${mr.url}\n${line}\n`));
  assert.ok(!plain.input.includes('Требует внимания'));
  assert.equal(r.input.replace(`${line}\n`, ''), plain.input);
  assert.match(mrIntake(mr, undefined, undefined, { replies: 1, conflicts: false }).input, /Требует внимания: 1 обсуждение ждёт ответа\n/);
  assert.match(mrIntake(mr, undefined, undefined, { replies: 11, conflicts: false }).input, /11 обсуждений ждут/);
});

test('вход из ветки: тикет из имени ветки', () => {
  const r = branchIntake('bugfix/abc-99-crash', 'fix crash', 'Тикет: <KEY>');
  assert.ok(r.input.startsWith('Тикет: ABC-99\n\n'));
  assert.equal(r.branch, 'bugfix/abc-99-crash');
  assert.equal(r.source.type, 'branch');
});
