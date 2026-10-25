import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, loadSettings, readJiraToken, saveSettings, updateSettings, worktreesDir, writeJiraToken } from './settings.js';
import { addProject, autodetectProjects, removeProject } from './projects.js';

function withConfigDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-cfg-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = path.join(dir, 'cfg');
    try {
      await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const mode = (p: string) => fs.statSync(p).mode & 0o777;

test(
  'настройки: пусто по умолчанию, запись, права 700/600, токен отдельно',
  withConfigDir(() => {
    assert.deepEqual(loadSettings(), { projects: [] });
    assert.equal(readJiraToken(), undefined);
    saveSettings({ projects: [], jira: { baseUrl: 'https://example.atlassian.net', email: 'a@b' } });
    assert.equal(mode(configDir()), 0o700);
    assert.equal(loadSettings().jira?.email, 'a@b');
    fs.writeFileSync(path.join(configDir(), 'jira-token'), 'old', { mode: 0o644 });
    writeJiraToken(' tok \n');
    assert.equal(readJiraToken(), 'tok');
    assert.equal(mode(path.join(configDir(), 'jira-token')), 0o600);
    assert.ok(!fs.readFileSync(path.join(configDir(), 'settings.json'), 'utf8').includes('tok'));
    assert.equal(worktreesDir(), path.join(configDir(), 'worktrees'));
    assert.equal(worktreesDir({ projects: [], worktreesDir: '~/wt' }), path.join(os.homedir(), 'wt'));
  }),
);

test(
  'проекты: автоподхват только git-репо, убранный руками не возвращается',
  withConfigDir(async (dir) => {
    const repo = path.join(dir, 'App');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    const s = loadSettings();
    assert.equal(await autodetectProjects(s, [path.join(repo, 'sub'), repo, dir, path.join(dir, 'nope')]), true);
    assert.deepEqual(s.projects, [{ path: repo }]);
    removeProject(s, repo);
    assert.equal(await autodetectProjects(s, [repo]), false);
    await addProject(s, path.join(repo, 'sub'));
    assert.deepEqual(s.projects, [{ path: repo, manual: true }]);
    assert.deepEqual(s.hiddenProjects, []);
    await assert.rejects(addProject(s, dir), /не git-репозиторий/);
    updateSettings((x) => Object.assign(x, s));
    assert.equal(loadSettings().projects.length, 1);
  }),
);
