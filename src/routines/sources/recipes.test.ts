import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commandProblem } from './command-guard.js';
import { loadRecipes, parseRecipe, templatesDir } from './recipes.js';
import { builtinKinds } from './index.js';

test('рецепты приложения: Fireflies, Sentry, Linear, GitHub-уведомления читаются и описывают command', () => {
  const recipes = loadRecipes({ templates: templatesDir(), user: '/nonexistent-recipes' });
  const ids = recipes.map((r) => r.id).sort();
  assert.deepEqual(ids, ['fireflies', 'github-notifications', 'linear', 'sentry']);
  for (const r of recipes) {
    assert.equal(r.spec.kind, 'command', r.id);
    assert.ok(typeof r.spec.config.command === 'string' && r.spec.config.command.length > 10, r.id);
    assert.ok(r.spec.map?.id, r.id);
    assert.ok(r.summary && /[а-я]/i.test(r.summary), r.id);
    assert.ok(r.file.endsWith('.yaml'));
  }
});

test('рецепты: команды проходят проверку безопасности, и ключи названы в secrets', () => {
  for (const r of loadRecipes({ templates: templatesDir(), user: '/nonexistent-recipes' })) {
    if (r.id === 'github-notifications') continue; // gh, а не curl: проверяется только для сгенерированных моделью
    assert.equal(commandProblem(String(r.spec.config.command), r.spec.secrets ?? []), undefined, r.id);
  }
});

test('рецепты: команды синтаксически корректны для sh', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const r of loadRecipes({ templates: templatesDir(), user: '/nonexistent-recipes' })) {
    execFileSync('sh', ['-n', '-c', String(r.spec.config.command)]);
  }
});

test('личный рецепт заменяет встроенный с тем же id, битые файлы пропускаются, плоский формат принимается', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-recipes-'));
  try {
    fs.writeFileSync(path.join(dir, 'linear.yaml'), 'id: linear\nsummary: Мой Linear\nspec:\n  title: Мой\n  kind: command\n  config: { command: "echo []" }\n  map: { id: id }\n');
    fs.writeFileSync(path.join(dir, 'broken.yaml'), ': : не yaml [');
    fs.writeFileSync(path.join(dir, 'no-spec.yaml'), 'foo: 1\n');
    fs.writeFileSync(path.join(dir, 'Flat Recipe.yml'), 'title: Плоский\nkind: command\nconfig: { command: "echo []" }\nmap: { id: id }\n');
    const recipes = loadRecipes({ templates: templatesDir(), user: dir });
    const by = Object.fromEntries(recipes.map((r) => [r.id, r]));
    assert.equal(by.linear.summary, 'Мой Linear');
    assert.equal(by.linear.file, path.join(dir, 'linear.yaml'));
    assert.equal(by['flat-recipe'].spec.title, 'Плоский');
    assert.ok(!('broken' in by) && !('no-spec' in by));
    assert.equal(recipes.length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseRecipe: причина отказа понятна', () => {
  assert.throws(() => parseRecipe('- 1', 'x.yaml'), /словарь/);
  assert.throws(() => parseRecipe('spec: { kind: command, config: {} }', 'x.yaml'), /title/);
  assert.throws(() => parseRecipe('spec: { title: a, kind: command }', 'x.yaml'), /config/);
});

test('builtinKinds: все виды-сервисы на месте, у каждого русские подписи и поля условий', () => {
  const kinds = builtinKinds();
  assert.deepEqual(kinds.map((k) => k.kind), ['slack', 'telegram', 'gitlab', 'github', 'jira', 'rss', 'folder', 'email', 'connector']);
  for (const k of kinds) {
    assert.ok(/[а-яa-z]/i.test(k.title) && /[а-я]/i.test(k.summary), k.kind);
    assert.ok(k.setup.length > 0 && k.setup.every((f) => f.key && /[а-я]/i.test(f.label)), k.kind);
    assert.ok(k.match.every((m) => m.key && /[а-я]/i.test(m.label)), k.kind);
    assert.ok(k.poll || k.listen, k.kind);
    assert.ok(k.minEveryMs >= 5000, k.kind);
    assert.ok(k.describe({ title: 't', kind: k.kind, config: {} }).length > 10, k.kind);
  }
  const by = Object.fromEntries(kinds.map((k) => [k.kind, k]));
  for (const k of ['slack', 'telegram', 'gitlab', 'github', 'jira']) assert.ok(by[k].reply, `${k} умеет отвечать`);
  for (const k of ['rss', 'folder', 'email', 'connector']) assert.equal(by[k].reply, undefined);
  assert.equal(by.connector.delivery, 'model');
  assert.equal(by.slack.delivery, 'live');
  assert.equal(by.telegram.delivery, 'live');
});

test('github-notifications: ссылки ведут на существующие страницы — релизы, PR, коммиты, проверки, задачи', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  if (spawnSync('jq', ['--version']).status !== 0) return;
  const r = loadRecipes({ templates: templatesDir(), user: '/nonexistent-recipes' }).find((x) => x.id === 'github-notifications')!;
  const filter = /--jq '([\s\S]*)'\s*$/.exec(String(r.spec.config.command))![1];
  const repo = { full_name: 'o/r', html_url: 'https://github.com/o/r' };
  const note = (id: string, type: string, url: string | null) => ({ id, updated_at: '2026-11-17T10:00:00Z', reason: 'subscribed', repository: repo, subject: { title: type, type, url } });
  const input = JSON.stringify([
    note('1', 'PullRequest', 'https://api.github.com/repos/o/r/pulls/7'),
    note('2', 'Issue', 'https://api.github.com/repos/o/r/issues/8'),
    note('3', 'Release', 'https://api.github.com/repos/o/r/releases/123'),
    note('4', 'Commit', 'https://api.github.com/repos/o/r/commits/abc'),
    note('5', 'CheckSuite', 'https://api.github.com/repos/o/r/check-suites/99'),
    note('6', 'Discussion', null),
  ]);
  const out = JSON.parse(execFileSync('jq', ['-c', filter], { input }).toString()) as Array<{ link: string }>;
  assert.deepEqual(out.map((x) => x.link), [
    'https://github.com/o/r/pull/7',
    'https://github.com/o/r/issues/8',
    'https://github.com/o/r/releases',
    'https://github.com/o/r/commit/abc',
    'https://github.com/o/r/actions',
    'https://github.com/o/r',
  ]);
});
