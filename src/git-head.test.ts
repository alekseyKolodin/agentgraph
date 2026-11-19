import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { branchCache, headBranch } from './git-head.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-head-'));

test('ветка папки: HEAD ближайшего .git вверх по пути, в подпапке тоже', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/claude/desk-6\n');
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    assert.equal(headBranch(root), 'claude/desk-6');
    assert.equal(headBranch(path.join(root, 'src', 'deep')), 'claude/desk-6');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ветка worktree: .git — файл gitdir, HEAD — в папке worktree основного репо', () => {
  const root = tmp();
  try {
    const gitdir = path.join(root, 'main', '.git', 'worktrees', 'wt');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/feature/x\n');
    fs.mkdirSync(path.join(root, 'wt'));
    fs.writeFileSync(path.join(root, 'wt', '.git'), `gitdir: ${gitdir}\n`);
    assert.equal(headBranch(path.join(root, 'wt')), 'feature/x');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detached HEAD, не git и относительный путь — ветки нет; кэш читает папку один раз', () => {
  const root = tmp();
  try {
    assert.equal(headBranch('relative/path'), undefined);
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), '3f2a9c0d1e\n');
    assert.equal(headBranch(root), undefined);
    const cached = branchCache();
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    assert.equal(cached(root), 'main');
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    assert.equal(cached(root), 'main');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
