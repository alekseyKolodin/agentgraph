import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jiraIntake, mrIntake } from './intake.js';
import type { JiraIssue } from './jira.js';
import type { MergeRequest } from './git.js';
import { replyIn, taskLang } from './lang.js';
import { withTagsInput } from './tags.js';

test('язык задачи: английская — en, русская с путями и именами функций — ru, пустая — ru', () => {
  assert.equal(taskLang('Make `npm test` and `npm run lint` pass. Fix the code, not the tests.'), 'en');
  assert.equal(taskLang('Исправь buildInvoice в src/invoice.js: налог считается с суммы до скидки (applyDiscount, roundCents)'), 'ru');
  assert.equal(taskLang('Почини `npm test`:\n```\nTypeError: cannot read properties of undefined (reading map)\n```'), 'ru');
  assert.equal(taskLang(''), 'ru');
});

test('язык задачи: ссылки и списки пакетов в русской задаче не делают её английской', () => {
  assert.equal(taskLang('Посмотри https://gitlab.example.com/group/sub-group/very-long-project-name/-/merge_requests/1234#note_5678'), 'ru');
  assert.equal(taskLang('Check https://github.com/o/app/pull/5 и поправь'), 'ru');
  assert.equal(taskLang('Обнови зависимости в package.json: react, react-dom, @types/react, vite, vitest, eslint, prettier'), 'ru');
});

test('язык задачи: блок русского тега не делает английскую задачу русской', () => {
  const input = withTagsInput('Add CSV export of invoices', [{ slug: 'export', summary: 'Экспорт счетов: где код, решения, что осталось — длинная русская сводка' }]);
  assert.equal(taskLang(input), 'en');
  assert.equal(replyIn('en'), 'по-английски (in English)');
  assert.equal(replyIn('ru'), 'по-русски');
});

const issue = (title: string, description: string): JiraIssue => ({
  key: 'BILL-142', title, status: 'In Progress', statusCategory: 'indeterminate', type: 'Story', priority: 'High',
  url: 'https://acme.atlassian.net/browse/BILL-142', description, labels: [], subtasks: [], links: [],
});

test('язык задачи из трекера — язык тикета, а не нашей русской обвязки вокруг него', () => {
  assert.equal(taskLang(jiraIntake(issue('Volume discount for bulk orders', '')).input), 'en');
  assert.equal(taskLang(jiraIntake(issue('Volume discount', 'Orders of 10+ units get 5% off.')).input), 'en');
  assert.equal(taskLang(jiraIntake(issue('Скидка за объём', 'Заказы от 10 штук — скидка 5%.')).input), 'ru');
  const mr: MergeRequest = {
    iid: 7, title: 'Retry payment webhooks', description: 'Retries failed webhook deliveries with backoff.', sourceBranch: 'feature/retry',
    targetBranch: 'main', author: 'dana', draft: false, url: 'https://gitlab.example.com/g/app/-/merge_requests/7', ref: 'g/app!7', hasConflicts: true,
  };
  assert.equal(taskLang(mrIntake(mr, undefined, undefined, { ci: { status: 'failed', url: 'https://ci.example.com/1' }, replies: 2, conflicts: true }).input), 'en');
});
