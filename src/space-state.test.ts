import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isStateRequest, parseSpaceState, sessionStatePrompt, sessionStateRequest, spaceStatePrompt, stateReadGuard, turnsDigest } from './space-state.js';
import type { Space } from './spaces.js';
import type { RunReport } from './runner.js';

const session = { id: 's-1', name: 'checkout-bug', cwd: '/p/shop' };
const space = (over: Partial<Space> = {}): Space =>
  ({ slug: 'checkout', title: 'Корзина', dir: '/cfg/spaces/checkout', map: '# Корзина', state: '', docs: [{ name: 'spec.md', size: 1, mtimeMs: 0, text: true }], history: [], createdAt: '', updatedAt: '', ...over }) as Space;

test('состояние по сессии: ходы и прошлое состояние — данные в обёртке, где карта и документы — от нас, транскрипта нет', () => {
  const p = sessionStatePrompt(session, space(), 'старое состояние', [{ prompt: 'почини корзину', answer: 'Поправил validate.ts' }, { prompt: 'и тест' }]);
  assert.ok(p.startsWith('Пространство: «Корзина» (checkout)\nКарта пространства (её пишет пользователь'));
  assert.ok(p.includes(`Документы пространства (читай, если нужно): ${path.join('/cfg/spaces/checkout', 'docs')}`));
  assert.ok(p.includes('Директория проекта: /p/shop'));
  assert.match(p, /<source-data>\nстарое состояние\n<\/source-data>/);
  assert.ok(p.includes('Ход 1. Пользователь:\nпочини корзину\nОтвет модели:\nПоправил validate.ts'));
  assert.ok(p.includes('Ход 2. Пользователь:\nи тест\nОтвет модели:\n(ответа нет: ход прервали)'));
  assert.ok(!p.includes('.claude/projects') && !p.includes('transcript'));
  assert.ok(sessionStatePrompt(session, space(), '', []).includes('(нет — пространство новое)'));
  // автозаголовок — только слаг; без карты и документов — без их строк
  const bare = sessionStatePrompt(session, space({ title: 'Придумала модель', autoTitle: true, map: '', docs: [] }), '', []);
  assert.ok(bare.startsWith('Пространство: checkout\nИсточник'));
});

test('состояние по сессии: запрос только на чтение в папке проекта и пространства, без сохранения сессии, ответ схемой state', () => {
  const r = sessionStateRequest(session, space(), '', [{ prompt: 'x' }], { model: 'haiku' });
  assert.deepEqual([r.cwd, r.tools, r.model, r.persist, r.maxTurns, r.additionalDirectories], ['/p/shop', ['Read', 'Grep', 'Glob'], 'haiku', false, 15, ['/cfg/spaces/checkout']]);
  assert.ok(isStateRequest(r));
});

test('сессия состояния: читает только проект, папку запуска и пространство; папка настроек (токен Jira) и секреты — нет, и Grep по ~ тоже', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-stguard-')));
  const prev = process.env.AGENTGRAPH_CONFIG_DIR;
  const cfg = path.join(root, 'cfg');
  process.env.AGENTGRAPH_CONFIG_DIR = cfg;
  try {
    const proj = path.join(root, 'proj');
    const spaceDir = path.join(cfg, 'spaces', 'p');
    for (const d of [proj, spaceDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'jira-token'), 'secret');
    const guard = stateReadGuard([proj, spaceDir], spaceDir);
    assert.equal(guard('Read', { file_path: path.join(proj, 'a.ts') }, { cwd: proj }), undefined);
    assert.equal(guard('Read', { file_path: path.join(spaceDir, 'STATE.md') }, { cwd: proj }), undefined);
    assert.equal(guard('Grep', { pattern: 'x' }, { cwd: proj }), undefined);
    assert.equal(guard('Glob', { pattern: 'src/**/*.ts' }, { cwd: proj }), undefined);
    assert.match(guard('Read', { file_path: path.join(cfg, 'jira-token') }, { cwd: proj }) ?? '', /секреты/);
    assert.match(guard('Read', { file_path: path.join(spaceDir, '..', '..', 'jira-token') }, { cwd: proj }) ?? '', /секреты/);
    assert.match(guard('Read', { file_path: '/etc/hosts' }, { cwd: proj }) ?? '', /вне них/);
    assert.match(guard('Glob', { pattern: '../**' }, { cwd: proj }) ?? '', /относительный/);
    assert.match(guard('Glob', { pattern: '/etc/*' }, { cwd: proj }) ?? '', /относительный/);
    // рабочая папка содержит папку настроек (как ~): Grep и Glob по ней искали бы и в токене
    const home = stateReadGuard([root, spaceDir], spaceDir);
    assert.match(home('Grep', { pattern: 'token' }, { cwd: root }) ?? '', /секреты/);
    assert.equal(home('Read', { file_path: path.join(proj, 'a.ts') }, { cwd: root }), undefined);
    // запросы сессий состояния несут guard
    assert.ok(sessionStateRequest(session, space({ dir: spaceDir }), '', [{ prompt: 'x' }], {}).guard);
  } finally {
    if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
    else process.env.AGENTGRAPH_CONFIG_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('состояние по запуску: блоки тегов старого ввода сняты, выводы последнего шага, источник и worktree — в промпте', () => {
  const report = { id: 'r1', flow: 'f', cwd: '/p', runDir: '/runs/r1', input: '<!-- tag:x -->\nстарое\n<!-- /tag -->\n\nзадача', final: [{ title: 'Этап', output: 'iter-01/01-a.output.md' }], worktree: { path: '/wt', branch: 'feat' } } as unknown as RunReport;
  const p = spaceStatePrompt(report, space(), 'было');
  assert.ok(p.includes('- Этап: /runs/r1/iter-01/01-a.output.md'));
  assert.ok(p.includes('Worktree: /wt, ветка feat'));
  assert.match(p, /Задача запуска:\n<source-data>\nзадача\n<\/source-data>/);
  assert.ok(!p.includes('<!-- tag:x -->'));
});

test('состояние: ответ — только непустой structured.state, иначе ошибка', () => {
  const ok = { ok: true, subtype: 'success', text: '', costUsd: 0, turns: 1, durationMs: 1, errors: [] };
  assert.equal(parseSpaceState({ ...ok, structured: { state: 'Суть' } }), 'Суть');
  assert.throws(() => parseSpaceState({ ...ok, structured: { state: ' ' } }), /не вернула поле state/);
  assert.throws(() => parseSpaceState({ ...ok, structured: { summary: 'x' } }), /не вернула поле state/);
  assert.throws(() => parseSpaceState({ ...ok, ok: false, subtype: 'error', errors: ['сбой'] }), /сбой/);
});

test('дайджест ходов: длинные обрезаются, ранние не влезшие — счётчиком, последние — всегда', () => {
  const long = 'я'.repeat(5000);
  const d = turnsDigest([{ prompt: long, answer: long }]);
  assert.ok(d.includes('я'.repeat(1500) + '…') && !d.includes('я'.repeat(2001)));
  const many = Array.from({ length: 30 }, (_, i) => ({ prompt: `вопрос ${i + 1} ` + 'а'.repeat(900), answer: 'б'.repeat(900) }));
  const m = turnsDigest(many);
  assert.match(m, /^…\(ранних ходов не вошло: \d+\)/);
  assert.ok(m.includes('Ход 30. Пользователь:\nвопрос 30'));
  assert.ok(m.length < 14_000);
});
