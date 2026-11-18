import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, guessProfile, loadProfile, readProfile, writeProfile, loadSettings, readJiraToken, saveSettings, updateSettings, worktreesDir, writeJiraToken } from './settings.js';
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

// ---------- профиль «кто я»

function withCfg(fn: () => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-profile-'));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = dir;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
const fakeExec = (answers: Record<string, string | Error>) => async (cmd: string, args: string[]) => {
  const a = answers[`${cmd} ${args.join(' ')}`];
  if (a === undefined || a instanceof Error) throw a ?? new Error('нет команды');
  return a;
};
const FULL = { 'glab api user': '{"username":"ipet"}', 'gh api user': '{"login":"ipet-gh"}', 'git config --global user.name': 'Иван К.\n', 'git config --global user.email': 'git@me.test\n' };

test('профиль: пустые поля заполняются из glab, gh, git config и Jira и помечаются auto', withCfg(async () => {
  saveSettings({ projects: [], jira: { baseUrl: 'https://j.test', email: 'jira@me.test' } });
  const r = await readProfile(fakeExec(FULL));
  assert.deepEqual(r.profile, { names: ['Иван К.'], emails: ['git@me.test', 'jira@me.test'], gitlab: 'ipet', github: 'ipet-gh', jiraEmail: 'jira@me.test' });
  assert.deepEqual(r.auto.sort(), ['emails', 'github', 'gitlab', 'jiraEmail', 'names']);
  assert.deepEqual(loadProfile(), r.profile, 'найденное сохранено');
}));

test('профиль: автозаполнение не перетирает введённое руками, а упавшая команда не мешает остальным', withCfg(async () => {
  writeProfile({ names: ['Лёша'], gitlab: 'mine' });
  const r = await readProfile(fakeExec({ ...FULL, 'gh api user': new Error('gh не установлен') }));
  assert.deepEqual(r.profile.names, ['Лёша']);
  assert.equal(r.profile.gitlab, 'mine');
  assert.equal(r.profile.github, undefined);
  assert.equal(r.profile.emails[0], 'git@me.test');
  assert.deepEqual(r.auto.sort(), ['emails']);
}));

test('профиль: правка автозаполненного поля снимает пометку, остальные остаются', withCfg(async () => {
  await readProfile(fakeExec(FULL));
  const r = writeProfile({ ...loadProfile(), gitlab: 'другой', slackUserId: ' U1 ' });
  assert.equal(r.profile.slackUserId, 'U1');
  assert.ok(!r.auto.includes('gitlab'));
  assert.ok(r.auto.includes('github'));
  assert.equal((await readProfile(fakeExec({}))).profile.gitlab, 'другой');
}));

test('профиль: имена и почты из строки — без пустых и повторов', withCfg(async () => {
  const r = writeProfile({ names: 'Анна, анна;  Борис\n', emails: ['a@b.test', 'A@B.test', ''] });
  assert.deepEqual(r.profile, { names: ['Анна', 'Борис'], emails: ['a@b.test'] });
  assert.deepEqual(await guessProfile(undefined, fakeExec({})), {});
}));

test('профиль: все команды недоступны или отвечают мусором — чтение не падает и ничего не записывает', withCfg(async () => {
  const r = await readProfile(fakeExec({}));
  assert.deepEqual(r, { profile: { names: [], emails: [] }, auto: [] });
  assert.equal(loadSettings().profile, undefined, 'мусора в файле нет');
  const junk = await readProfile(fakeExec({ 'glab api user': 'not json', 'gh api user': '{"login":42}', 'git config --global user.name': '  ', 'git config --global user.email': '' }));
  assert.deepEqual(junk.profile, { names: [], emails: [] });
  assert.equal(loadSettings().profile, undefined);
}));

test('профиль: сохранение во время долгого автозаполнения не затирается найденным', withCfg(async () => {
  const slow = async (cmd: string, args: string[]) => {
    if (cmd === 'glab') writeProfile({ gitlab: 'ручной', names: ['Лёша'] }); // человек сохранил, пока шли команды
    return fakeExec(FULL)(cmd, args);
  };
  const r = await readProfile(slow);
  assert.equal(r.profile.gitlab, 'ручной');
  assert.deepEqual(r.profile.names, ['Лёша']);
  assert.equal(r.profile.github, 'ipet-gh');
  assert.ok(!r.auto.includes('gitlab') && !r.auto.includes('names'));
}));
