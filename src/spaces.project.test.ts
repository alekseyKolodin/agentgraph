// Проект = пространство: репозитории пространства, проект по папке (projectOfPath), перенос cwd/dirs в repos, закрытие.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkSpaceMetaText,
  createSpace,
  checkSpaceRepos,
  gitRootOf,
  listSpaces,
  NO_PROJECT,
  projectOfPath,
  projectResolver,
  readSpace,
  readSpaceMeta,
  spaceDir,
  spaceReply,
  updateSpace,
  writeSpaceState,
} from './spaces.js';
import type { SpaceDetail } from './api-types.js';

/** Папка настроек и папка «кода» — во временных папках; пространства — в настройках. */
function withDirs(fn: (code: string) => void) {
  return () => {
    const code = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-code-')));
    const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-cfg-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = cfg;
    try {
      fn(code);
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(code, { recursive: true, force: true });
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  };
}

/** Репозиторий без git: папка .git — этого достаточно gitRootOf. */
function repo(dir: string): string {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

/** Worktree репозитория: файл .git со ссылкой на <main>/.git/worktrees/<имя>. */
function worktree(main: string, dir: string, name = path.basename(dir)): string {
  fs.mkdirSync(path.join(main, '.git', 'worktrees', name), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', name)}\n`);
  return dir;
}

/** space.json как его записала бы прошлая версия: без repos — перенос при первом чтении. */
function rawSpace(slug: string, meta: Record<string, unknown>): void {
  fs.mkdirSync(spaceDir(slug), { recursive: true });
  fs.writeFileSync(path.join(spaceDir(slug), 'space.json'), JSON.stringify({ slug, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', history: [], ...meta }));
}

const fileMeta = (slug: string) => JSON.parse(fs.readFileSync(path.join(spaceDir(slug), 'space.json'), 'utf8')) as Record<string, unknown>;

test(
  'корень git: вложенная папка — к корню репозитория, worktree — к основному checkout, не git — undefined',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    fs.mkdirSync(path.join(app, 'src', 'deep'), { recursive: true });
    const wt = worktree(app, path.join(code, 'wt', 'feature-x'));
    fs.mkdirSync(path.join(code, 'plain'));
    assert.equal(gitRootOf(path.join(app, 'src', 'deep')), app);
    assert.equal(gitRootOf(wt), app);
    assert.equal(gitRootOf(path.join(wt, 'sub')), app, 'несуществующая папка в worktree — от ближайшего предка');
    assert.equal(gitRootOf(path.join(code, 'plain')), undefined);
    assert.equal(gitRootOf('relative/path'), undefined);
  }),
);

test(
  'проект по папке: привязанный репозиторий (и его worktree) → пространство; папка пространства — если не git; иначе «Без проекта»',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    const wt = worktree(app, path.join(code, 'worktrees', 'app-fix'));
    const docs = path.join(code, 'docs', 'billing');
    fs.mkdirSync(path.join(docs, 'notes'), { recursive: true });
    rawSpace('shop', { title: 'Магазин', repos: [app] });
    rawSpace('billing', { dirs: [docs], repos: [] });
    assert.deepEqual(projectOfPath(path.join(app, 'src')), { space: 'shop', title: 'Магазин' });
    assert.deepEqual(projectOfPath(wt), { space: 'shop', title: 'Магазин' }, 'worktree сворачивается к основному checkout');
    assert.deepEqual(projectOfPath(path.join(docs, 'notes')), { space: 'billing', title: 'billing' }, 'без заголовка — слаг');
    assert.deepEqual(projectOfPath(path.join(spaceDir('billing'))), { space: 'billing', title: 'billing' }, '«Сессия в папке» пространства');
    assert.deepEqual(projectOfPath(path.join(code, 'elsewhere')), NO_PROJECT);
    assert.deepEqual(projectOfPath(undefined), NO_PROJECT);
    assert.deepEqual(projectOfPath(''), NO_PROJECT);
  }),
);

test(
  'проект по папке: вложенные папки пространств — самая глубокая; привязанный репозиторий главнее папки, которая его содержит',
  withDirs((code) => {
    const outer = path.join(code, 'work');
    const inner = path.join(outer, 'mobile');
    fs.mkdirSync(path.join(inner, 'ios'), { recursive: true });
    const api = repo(path.join(outer, 'api'));
    rawSpace('work', { cwd: outer, repos: [] });
    rawSpace('mobile', { dirs: [inner], repos: [] });
    rawSpace('api', { repos: [api], createdAt: '2026-05-01T00:00:00.000Z' });
    assert.equal(projectOfPath(path.join(inner, 'ios')).space, 'mobile');
    assert.equal(projectOfPath(path.join(outer, 'misc')).space, 'work');
    assert.equal(projectOfPath(path.join(api, 'src')).space, 'api', 'репозиторий привязан — папка work над ним не в счёт');
  }),
);

test(
  'проект по папке: репозиторий привязан к нескольким пространствам — самое старое по createdAt, при равенстве — по слагу',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    rawSpace('feature-new', { repos: [app], createdAt: '2026-11-01T00:00:00.000Z' });
    rawSpace('app-main', { repos: [app], createdAt: '2026-02-01T00:00:00.000Z' });
    rawSpace('zz-same', { repos: [app], createdAt: '2026-02-01T00:00:00.000Z' });
    assert.equal(projectOfPath(app).space, 'app-main');
    // явное пространство работы — главнее папки: фича на том же репо остаётся своей
    assert.equal(projectResolver().of({ space: 'feature-new', path: app }).space, 'feature-new');
    assert.equal(projectResolver().of({ space: 'deleted-space', path: app }).space, 'app-main', 'удалённое пространство — по папке');
    // страница пространства говорит, куда на самом деле идёт работа в его репозитории
    const detail = spaceReply('feature-new').body as SpaceDetail;
    assert.deepEqual(detail.repoProjects, { [app]: { space: 'app-main', title: 'app-main' } });
  }),
);

test(
  'перенос: пространство без repos получает корни git из cwd и dirs один раз, cwd, dirs и updatedAt не меняются',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    const lib = repo(path.join(code, 'lib'));
    fs.mkdirSync(path.join(app, 'android'), { recursive: true });
    fs.mkdirSync(path.join(code, 'notes'));
    fs.writeFileSync(path.join(lib, 'README.md'), '# lib');
    rawSpace('shop', { cwd: path.join(app, 'android'), dirs: [path.join(lib, 'README.md'), path.join(code, 'notes'), path.join(code, 'gone')] });
    const s = readSpace('shop')!;
    assert.deepEqual(s.repos, [app, lib], 'файл в репо — его корень; не git и несуществующее — мимо');
    const meta = fileMeta('shop');
    assert.deepEqual(meta.repos, [app, lib], 'записано в space.json');
    assert.equal(meta.cwd, path.join(app, 'android'));
    assert.deepEqual(meta.dirs, [path.join(lib, 'README.md'), path.join(code, 'notes'), path.join(code, 'gone')]);
    assert.equal(meta.updatedAt, '2026-01-01T00:00:00.000Z');
    // отвязали всё — пусто и остаётся пусто: перенос не повторяется
    updateSpace('shop', { repos: [] });
    assert.deepEqual(readSpace('shop')!.repos, []);
    assert.deepEqual(readSpaceMeta('shop')!.repos, []);
    assert.equal(projectOfPath(path.join(app, 'android', 'x')).space, 'shop', 'рабочая папка всё ещё содержит путь');
    assert.deepEqual(projectOfPath(app), NO_PROJECT);
  }),
);

test(
  'перенос: список пространств и проект по папке видят перенесённые репозитории сразу',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    rawSpace('shop', { cwd: app });
    assert.equal(projectOfPath(path.join(app, 'x')).space, 'shop');
    assert.deepEqual(listSpaces().find((s) => s.slug === 'shop')?.repos, [app]);
  }),
);

test(
  'привязка репозитория: подпапка сворачивается к корню, не git и относительный путь — ошибка, привязанный и стёртый — остаётся',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    fs.mkdirSync(path.join(app, 'src'));
    fs.mkdirSync(path.join(code, 'plain'));
    assert.deepEqual(checkSpaceRepos([path.join(app, 'src'), app]), [app]);
    assert.throws(() => checkSpaceRepos([path.join(code, 'plain')]), /не git-репозиторий/);
    assert.throws(() => checkSpaceRepos(['app']), /абсолютный путь/);
    assert.throws(() => checkSpaceRepos('app'), /список путей/);
    assert.throws(() => checkSpaceRepos([path.join(code, 'nope')]), /нет/);
    const gone = path.join(code, 'gone-repo');
    assert.deepEqual(checkSpaceRepos([gone, app], [gone]), [gone, app]);
    rawSpace('shop', { repos: [] });
    assert.deepEqual(updateSpace('shop', { repos: [path.join(app, 'src')] })!.repos, [app]);
    assert.throws(() => updateSpace('shop', { repos: [path.join(code, 'plain')] }), /не git-репозиторий/);
  }),
);

test(
  'закрытие: дата закрытия держится при повторе; единственное закрытое по-прежнему подписывает работу своего репо; открыть снова',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    rawSpace('shop', { repos: [app] });
    const closed = updateSpace('shop', { closed: true })!;
    assert.ok(closed.closedAt);
    assert.equal(updateSpace('shop', { closed: true })!.closedAt, closed.closedAt, 'повторное «закрыть» не сдвигает дату');
    assert.equal(listSpaces()[0].closedAt, closed.closedAt);
    assert.equal(projectOfPath(app).space, 'shop', 'история не теряет проект: открытого на этом репо нет');
    assert.deepEqual(projectResolver().of({ space: 'shop', path: app }), { space: 'shop', title: 'shop' });
    assert.throws(() => updateSpace('shop', { closed: 'yes' }), /true или false/);
    assert.equal(updateSpace('shop', { closed: false })!.closedAt, undefined);
    assert.equal(projectOfPath(app).space, 'shop');
    assert.equal(fileMeta('shop').closedAt, undefined);
  }),
);

test(
  'закрытое пространство уступает открытому: репозиторий и папка — к открытому, даже если оно моложе или папка мельче',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    rawSpace('old', { repos: [app], createdAt: '2026-01-01T00:00:00.000Z' });
    rawSpace('new', { repos: [app], createdAt: '2026-06-01T00:00:00.000Z' });
    assert.equal(projectOfPath(app).space, 'old');
    updateSpace('old', { closed: true });
    assert.equal(projectOfPath(app).space, 'new');
    const docs = path.join(code, 'docs');
    fs.mkdirSync(path.join(docs, 'deep'), { recursive: true });
    rawSpace('deep-closed', { dirs: [path.join(docs, 'deep')], repos: [], closedAt: '2026-11-01T00:00:00.000Z' });
    rawSpace('wide-open', { dirs: [docs], repos: [] });
    assert.equal(projectOfPath(path.join(docs, 'deep', 'x')).space, 'wide-open');
  }),
);

test(
  'список пространств: дата состояния (mtime STATE.md) у превью — только когда состояние есть',
  withDirs(() => {
    rawSpace('a', { repos: [] });
    rawSpace('b', { repos: [] });
    writeSpaceState('a', 'Где мы: сделали вход', { id: 'r1', at: new Date().toISOString(), kind: 'run' });
    const list = listSpaces();
    assert.equal(typeof list.find((s) => s.slug === 'a')?.stateMtimeMs, 'number');
    assert.equal(list.find((s) => s.slug === 'b')?.stateMtimeMs, undefined);
  }),
);

test(
  'space.json правкой сессии: repos и closedAt — допустимые поля с проверкой типа',
  withDirs(() => {
    rawSpace('shop', { repos: ['/abs/gone'] });
    const prev = readSpaceMeta('shop')!;
    // привязанный раньше и стёртый с диска — остаётся как был
    const ok = checkSpaceMetaText('shop', JSON.stringify({ ...prev, repos: ['/abs/gone'], closedAt: '2026-11-18T10:00:00.000Z' }), prev);
    assert.deepEqual(ok.repos, ['/abs/gone']);
    assert.equal(ok.closedAt, '2026-11-18T10:00:00.000Z');
    assert.throws(() => checkSpaceMetaText('shop', JSON.stringify({ ...prev, repos: ['rel'] }), prev), /repos — список абсолютных путей/);
    assert.throws(() => checkSpaceMetaText('shop', JSON.stringify({ ...prev, closedAt: 'вчера' }), prev), /closedAt — дата/);
  }),
);

test(
  'корень git: относительный gitdir worktree и .git ссылкой на папку',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    fs.mkdirSync(path.join(app, '.git', 'worktrees', 'rel'), { recursive: true });
    const wt = path.join(code, 'rel-wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../app/.git/worktrees/rel\n');
    assert.equal(gitRootOf(wt), app);
    const linked = path.join(code, 'linked');
    fs.mkdirSync(linked);
    fs.mkdirSync(path.join(code, 'real-git'));
    fs.symlinkSync(path.join(code, 'real-git'), path.join(linked, '.git'));
    assert.equal(gitRootOf(path.join(linked)), linked);
  }),
);

test(
  'новое пространство привязывает только репозиторий рабочей папки: папки чтения — справочные',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    const lib = repo(path.join(code, 'design-system'));
    const s = createSpace('feature', { cwd: path.join(app), dirs: [lib] });
    assert.deepEqual(s.repos, [app]);
    assert.deepEqual(createSpace('bare').repos, []);
    assert.equal(projectOfPath(lib), NO_PROJECT);
  }),
);

test(
  'space.json правкой сессии: новые repos сворачиваются к корню git, не git — ошибка; слишком широкий путь не забирает работу',
  withDirs((code) => {
    const app = repo(path.join(code, 'app'));
    fs.mkdirSync(path.join(app, 'src'));
    rawSpace('shop', { repos: [] });
    const prev = readSpaceMeta('shop')!;
    assert.deepEqual(checkSpaceMetaText('shop', JSON.stringify({ ...prev, repos: [path.join(app, 'src')] }), prev).repos, [app]);
    assert.throws(() => checkSpaceMetaText('shop', JSON.stringify({ ...prev, repos: [code] }), prev), /не git-репозиторий/);
    // записано мимо проверки (старая версия, руками): корень диска и домашняя папка — не репозиторий проекта
    rawSpace('greedy', { repos: ['/', os.homedir()] });
    fs.mkdirSync(path.join(code, 'loose'));
    assert.deepEqual(projectOfPath(path.join(code, 'loose')), NO_PROJECT);
  }),
);
