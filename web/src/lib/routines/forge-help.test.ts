import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgeProblem, forgeTool, loginCommand } from './forge-help.js';

test('утилита по виду: GitLab — glab, GitHub — gh, остальные — нет', () => {
  assert.equal(forgeTool('gitlab')?.tool, 'glab');
  assert.equal(forgeTool('github')?.tool, 'gh');
  assert.equal(forgeTool('slack'), undefined);
});

test('команда входа: свой сервер — с адресом, стандартный и пустой — без', () => {
  const gl = forgeTool('gitlab')!;
  assert.equal(loginCommand(gl, ''), 'glab auth login');
  assert.equal(loginCommand(gl, 'gitlab.com'), 'glab auth login');
  assert.equal(loginCommand(gl, ' https://git.company.com/ '), 'glab auth login --hostname git.company.com');
  assert.equal(loginCommand(forgeTool('github')!, undefined), 'gh auth login');
});

test('ошибки проверки: нет утилиты и нет входа — что сделать; чужая ошибка — undefined', () => {
  assert.match(forgeProblem('gitlab', 'glab api --hostname gitlab.com user: glab не установлен')!, /brew install glab/);
  assert.match(forgeProblem('github', 'gh api user: gh не установлен')!, /brew install gh/);
  assert.match(forgeProblem('gitlab', 'glab api user: 401 Unauthorized', 'git.company.com')!, /glab auth login --hostname git\.company\.com/);
  assert.equal(forgeProblem('gitlab', 'таймаут'), undefined);
  assert.equal(forgeProblem('slack', 'glab не установлен'), undefined);
  assert.equal(forgeProblem('gitlab', undefined), undefined);
});
