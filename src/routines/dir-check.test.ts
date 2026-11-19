// Проверка папки рутины: нет папки, файл, не git, git (ветка, корень из подпапки). git — настоящий, во временной папке.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkDir, expandDir } from './dir-check.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-dircheck-')));

test('папки нет, это файл, обычная папка — три разных ответа', async () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, 'f.txt'), 'x');
    assert.deepEqual(await checkDir(path.join(d, 'нет')), { path: path.join(d, 'нет'), exists: false, isDir: false, git: false });
    assert.deepEqual(await checkDir(path.join(d, 'f.txt')), { path: path.join(d, 'f.txt'), exists: true, isDir: false, git: false });
    assert.deepEqual(await checkDir(d), { path: d, exists: true, isDir: true, git: false });
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('репозиторий: корень и ветка, и из подпапки тоже', async () => {
  const d = tmp();
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', d]);
    fs.mkdirSync(path.join(d, 'sub'));
    const r = await checkDir(d);
    assert.equal(r.git, true);
    assert.equal(r.root, d);
    assert.equal(r.branch, 'main');
    const sub = await checkDir(path.join(d, 'sub'));
    assert.equal(sub.git, true);
    assert.equal(sub.root, d);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('«~» раскрывается в домашнюю папку', () => {
  assert.equal(expandDir('~'), os.homedir());
  assert.equal(expandDir('~/work'), path.join(os.homedir(), 'work'));
});
