import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideRecentDir, recentDirProblem, recentDirs } from './projects.js';
import type { Settings } from './settings.js';

const run = (startedAt: string, cwd?: string, extra: { addDirs?: string[]; worktree?: unknown } = {}) => ({ startedAt, cwd, ...extra });

test('недавние директории: свежие сверху, без worktree и дублей, проекты и путь по умолчанию в конце', () => {
  const list = recentDirs({
    runs: [
      run('2026-10-01T10:00:00Z', '/w/old'),
      run('2026-10-03T10:00:00Z', '/w/app', { addDirs: ['/w/rules'] }),
      run('2026-10-04T10:00:00Z', '/wt/app-feature', { worktree: { path: '/wt/app-feature' }, addDirs: ['/w/qa'] }),
      run('2026-10-02T10:00:00Z', '/w/app'),
    ],
    projects: [{ path: '/w/app', name: 'Приложение' }, { path: '/w/lib' }],
    defaultCwd: '/w/old',
    exists: (d) => d !== '/w/qa',
  });
  assert.deepEqual(list.map((d) => d.path), ['/w/qa', '/w/app', '/w/rules', '/w/old', '/w/lib']);
  assert.deepEqual(list[0], { path: '/w/qa', label: 'qa', lastUsed: '2026-10-04T10:00:00Z', exists: false });
  assert.equal(list[1].label, 'Приложение');
  assert.equal(list[1].lastUsed, '2026-10-03T10:00:00Z');
  assert.equal(list[4].lastUsed, undefined);
});

test('недавние директории: убранные в «Подключениях» не показываются', () => {
  const list = recentDirs({ runs: [run('2026-10-01T00:00:00Z', '/w/gone'), run('2026-10-02T00:00:00Z', '/w/app')], projects: [], hidden: ['/w/gone'], exists: () => true });
  assert.deepEqual(list.map((d) => d.path), ['/w/app']);
});

test('недавние директории: лимит', () => {
  const runs = Array.from({ length: 12 }, (_, i) => run(`2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`, `/w/p${i}`));
  const list = recentDirs({ runs, projects: [], limit: 8, exists: () => true });
  assert.equal(list.length, 8);
  assert.equal(list[0].path, '/w/p11');
  assert.equal(recentDirs({ runs, projects: [], exists: () => true }).length, 12);
});

test('недавние директории: убранный путь не показывается, если после скрытия запусков с ним не было', () => {
  const at = '2026-10-05T12:00:00.000Z';
  const list = recentDirs({
    runs: [
      run('2026-10-05T11:59:59.999Z', '/w/review-6040'),
      run('2026-10-04T10:00:00Z', '/w/app', { addDirs: ['/w/rules'] }),
    ],
    projects: [{ path: '/w/review-6040' }, { path: '/w/lib' }],
    defaultCwd: '/w/home',
    hiddenDirs: [
      { path: '/w/review-6040', at },
      { path: '/w/rules', at },
      { path: '/w/lib', at },
      { path: '/w/home', at },
    ],
    exists: () => true,
  });
  // путь из cwd запуска и из проектов, путь из addDirs, проект и директория по умолчанию без запусков — все скрыты
  assert.deepEqual(list.map((d) => d.path), ['/w/app']);
});

test('недавние директории: запуск после скрытия возвращает путь', () => {
  const list = recentDirs({
    runs: [run('2026-10-05T12:00:01Z', '/w/app'), run('2026-10-01T00:00:00Z', '/w/app')],
    projects: [],
    hiddenDirs: [{ path: '/w/app', at: '2026-10-05T12:00:00.000Z' }],
    exists: () => true,
  });
  assert.deepEqual(list.map((d) => [d.path, d.lastUsed]), [['/w/app', '2026-10-05T12:00:01Z']]);
});

test('недавние директории: время сравнивается как дата, с миллисекундами и без', () => {
  const opts = (startedAt: string, at: string) => ({ runs: [run(startedAt, '/w/app')], projects: [], hiddenDirs: [{ path: '/w/app', at }], exists: () => true });
  // строкой '…:00Z' > '…:00.500Z', а по времени запуск раньше скрытия
  assert.equal(recentDirs(opts('2026-10-05T12:00:00Z', '2026-10-05T12:00:00.500Z')).length, 0);
  assert.equal(recentDirs(opts('2026-10-05T12:00:00.900Z', '2026-10-05T12:00:00.500Z')).length, 1);
  assert.equal(recentDirs(opts('2026-10-05T12:00:01Z', '2026-10-05T12:00:00.500Z')).length, 1);
  // нераспознанная дата запуска — «давно»
  assert.equal(recentDirs(opts('вчера', '2026-10-05T12:00:00.500Z')).length, 0);
});

test('недавние директории: hidden и hiddenDirs работают вместе, битое hiddenDirs не роняет список', () => {
  const runs = [run('2026-10-03T00:00:00Z', '/w/a'), run('2026-10-02T00:00:00Z', '/w/b'), run('2026-10-01T00:00:00Z', '/w/c')];
  const list = recentDirs({ runs, projects: [], hidden: ['/w/a'], hiddenDirs: [{ path: '/w/b', at: '2026-10-10T00:00:00Z' }], exists: () => true });
  assert.deepEqual(list.map((d) => d.path), ['/w/c']);
  const broken = recentDirs({ runs, projects: [], hiddenDirs: { path: '/w/a' } as unknown as [], exists: () => true });
  assert.equal(broken.length, 3);
});

test('недавние директории: лимит считается после скрытия', () => {
  const runs = Array.from({ length: 10 }, (_, i) => run(`2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`, `/w/p${i}`));
  const list = recentDirs({ runs, projects: [], hiddenDirs: [{ path: '/w/p9', at: '2026-10-20T00:00:00Z' }], limit: 8, exists: () => true });
  assert.equal(list.length, 8);
  assert.equal(list[0].path, '/w/p8');
  assert.equal(list[7].path, '/w/p1');
});

test('скрытие недавней директории: запись, повтор обновляет время без дубля, проекты не трогаются', () => {
  const s: Settings = { projects: [{ path: '/w/app' }], hiddenProjects: ['/w/old'] };
  hideRecentDir(s, '/w/app', '2026-10-05T00:00:00.000Z');
  hideRecentDir(s, '/w/rules', '2026-10-05T00:00:01.000Z');
  hideRecentDir(s, '/w/app', '2026-10-06T00:00:00.000Z');
  assert.deepEqual(s.hiddenDirs, [{ path: '/w/rules', at: '2026-10-05T00:00:01.000Z' }, { path: '/w/app', at: '2026-10-06T00:00:00.000Z' }]);
  assert.deepEqual(s.projects, [{ path: '/w/app' }]);
  assert.deepEqual(s.hiddenProjects, ['/w/old']);
  const broken = { projects: [], hiddenDirs: 'мусор' } as unknown as Settings;
  hideRecentDir(broken, '/w/app', '2026-10-05T00:00:00.000Z');
  assert.deepEqual(broken.hiddenDirs, [{ path: '/w/app', at: '2026-10-05T00:00:00.000Z' }]);
});

test('скрытие недавней директории: путь — непустая абсолютная строка', () => {
  assert.equal(recentDirProblem('/w/app'), undefined);
  for (const bad of ['relative/dir', '', '   ', null, undefined, 42]) assert.ok(recentDirProblem(bad), String(bad));
});
