// Синхронизация на двух настоящих клонах после финального ревью (docs/teamwork/notes/final-review.md, D-*): у каждого теста
// свой bare-репо как origin и свои «alice» и «bob» со своими папками команд и git config, без сети. Перепроигрывание не
// портит двоичные файлы и не теряет то, что не прочиталось (D-1), прерванный rebase восстанавливается (D-2), списки
// сливаются по элементам (D-3), комментарии переименованной задачи переезжают с ней (D-4), удаление против правки не
// уносит комментарии и ссылки (D-5), replay атомарен (D-6), без общей истории — ошибка (D-7), новый формат — только
// fast-forward (D-8), отключение (D-11, D-15), ссылки на переименованный номер (D-14), закрытый спринт (D-17).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, type Exec } from './git.js';
import { createTeam, defaultRepoDeps, joinTeam, TeamError, TeamRepo, type RepoDeps } from './teamwork-repo.js';
import { TeamService } from './teamwork-server.js';
import { parseTask, parseTeamConfig, serializeSprint, serializeTask, type TaskFile } from './teamwork.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-tw-sync-')));
const opened: TeamRepo[] = [];

after(async () => {
  for (const r of opened) await r.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Actor = { root: string; deps: RepoDeps; cfg: string };
let seq = 0;

/** Участник: своя папка команд и свой глобальный git config; таймеры далеко — отправка и получение только явные. */
function actor(dir: string, name: string): Actor {
  const cfg = path.join(dir, `${name}.gitconfig`);
  fs.writeFileSync(cfg, `[user]\n\tname = ${name}\n\temail = ${name}@example.com\n[init]\n\tdefaultBranch = main\n`);
  const x: Exec = (cmd, args, opts = {}) => exec(cmd, args, { ...opts, env: { ...opts.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg } });
  const root = path.join(dir, name, 'teams');
  fs.mkdirSync(root, { recursive: true });
  return { root, cfg, deps: { ...defaultRepoDeps(), exec: x, pushDelayMs: Infinity, retryMinMs: 3_600_000, retryMaxMs: 3_600_000, pollOpenMs: 3_600_000, pollIdleMs: 3_600_000, tmpDir: dir } };
}

/** git как его зовёт человек в папке клона (или в bare-репо): с git config участника. */
const gitAs = (cfg: string, cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg } });

const tf = (id: string, p = 'p') => `projects/${p}/tasks/${id}.md`;
const task = (id: string, extra: Partial<TaskFile> = {}, p = 'p'): TaskFile => ({
  id, title: `Задача ${id}`, type: 'feature', status: 'todo', rank: 'V', blockedBy: [], covers: [], body: '## Описание\n\nтекст\n', acceptance: { done: 0, total: 0 }, comments: 0, base: '', file: tf(id, p), extra: {}, ...extra,
});
const readTask = (r: TeamRepo, id: string, p = 'p') => parseTask(r.read(tf(id, p)) ?? '', tf(id, p));
const setTask = (r: TeamRepo, id: string, patch: Partial<TaskFile>, p = 'p') => r.writeFile(tf(id, p), serializeTask({ ...readTask(r, id, p), ...patch }));

/** Сервис команды поверх папки команд участника: «взять моё» и прочие решения конфликтов. */
const service = (x: Actor) => new TeamService({ root: () => x.root, timers: false, findLocal: async () => undefined, repo: x.deps });

/** Свежая команда: alice создаёт на пустом bare-репо, кладёт задачи и отправляет; bob подключается; оба на одном коммите. */
async function team(setup?: (r: TeamRepo) => void) {
  const dir = path.join(tmp, `t${++seq}`);
  fs.mkdirSync(dir);
  const bare = path.join(dir, 'team.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const A = actor(dir, 'alice');
  const B = actor(dir, 'bob');
  const a = await createTeam({ url: bare, title: 'Платёжная', prefix: 'PAY' }, A.deps, A.root);
  opened.push(a);
  await a.write('начало', (r) => {
    r.writeFile(tf('PAY-1'), serializeTask(task('PAY-1')));
    setup?.(r);
  });
  await a.push();
  const { repo: b } = await joinTeam({ url: bare }, B.deps, B.root);
  opened.push(b);
  await a.pull();
  /** Файл в репо команды (bare, ветка main) как байты; нет — undefined. */
  const remote = (file: string): Buffer | undefined => {
    try {
      return execFileSync('git', ['--git-dir', bare, 'show', `main:${file}`], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return undefined;
    }
  };
  const remoteText = (file: string) => remote(file)?.toString('utf8');
  return { dir, bare, a, b, A, B, remote, remoteText };
}

/** Двоичный файл в клон мимо writeFile: та строкой не пишет. */
const writeBin = (r: TeamRepo, rel: string, data: Buffer) => {
  fs.mkdirSync(path.dirname(r.abs(rel)), { recursive: true });
  fs.writeFileSync(r.abs(rel), data);
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x10]);

test('D-1: перепроигрывание не портит двоичный файл, который менял только я: в репо команды те же байты', async () => {
  const { a, b, remote } = await team();
  writeBin(b, 'projects/p/docs/screen.png', PNG);
  // конфликт по полю рядом: rebase откатывается, идёт перепроигрывание
  await b.write('PAY-1: оценка 5', (r) => setTask(r, 'PAY-1', { estimate: 5 }));
  await a.write('PAY-1: оценка 3', (r) => setTask(r, 'PAY-1', { estimate: 3 }));
  await a.push();
  await b.push();
  assert.deepEqual(remote('projects/p/docs/screen.png'), PNG);
  assert.deepEqual(fs.readFileSync(path.join(b.repoDir, 'projects/p/docs/screen.png')), PNG);
  assert.deepEqual(b.local().conflicts.map((c) => [c.kind, c.field]), [['field', 'estimate']]);
});

test('D-1: двоичный файл, изменённый обеими сторонами, — в конфликт: в репо байты команды, «взять моё» возвращает мои байты', async () => {
  const { a, b, remote } = await team((r) => writeBin(r, 'projects/p/docs/pic.png', PNG));
  const mine = Buffer.concat([PNG, Buffer.from([0x01, 0x00, 0xfa])]);
  const theirs = Buffer.concat([PNG, Buffer.from([0x02, 0x00, 0xfb])]);
  await b.pull();
  await b.write('картинка bob', (r) => writeBin(r, 'projects/p/docs/pic.png', mine));
  await a.write('картинка alice', (r) => writeBin(r, 'projects/p/docs/pic.png', theirs));
  await a.push();
  await b.push();
  assert.deepEqual(remote('projects/p/docs/pic.png'), theirs);
  const [c] = b.local().conflicts;
  assert.equal(c?.file, 'projects/p/docs/pic.png');
  assert.equal(c?.kind, 'text');
  assert.ok(c?.blob, 'у двоичного конфликта есть blob моей версии');
  // «взять моё»: blob из конфликта в рабочую копию и коммит
  await b.write('взято моё', (r) => r.restoreBlob(c!.file, c!.blob!));
  await b.push();
  assert.deepEqual(remote('projects/p/docs/pic.png'), mine);
});

test('D-1: имя файла с табом и переводом строки при перепроигрывании не теряется', async () => {
  const { a, b, remoteText } = await team();
  const odd = 'projects/p/docs/a\tb\nc.md';
  await b.write('странное имя', (r) => r.writeFile(odd, 'текст\n'));
  await b.write('PAY-1: оценка 5', (r) => setTask(r, 'PAY-1', { estimate: 5 }));
  await a.write('PAY-1: оценка 3', (r) => setTask(r, 'PAY-1', { estimate: 3 }));
  await a.push();
  await b.push();
  assert.equal(remoteText(odd), 'текст\n');
});

test('D-1: шаблон кладёт .gitignore с .DS_Store — служебные файлы macOS не уходят команде', async () => {
  const { a, remoteText } = await team();
  assert.match(a.read('.gitignore') ?? '', /\.DS_Store/);
  // клон команды, созданной до .gitignore, — локальное исключение
  assert.match(fs.readFileSync(path.join(a.repoDir, '.git', 'info', 'exclude'), 'utf8'), /^\.DS_Store$/m);
  fs.writeFileSync(path.join(a.repoDir, 'projects', '.DS_Store'), 'x');
  await a.write('PAY-1: оценка', (r) => setTask(r, 'PAY-1', { estimate: 1 }));
  await a.push();
  assert.equal(remoteText('projects/.DS_Store'), undefined);
});

/** Свой rebase agentgraph, на котором процесс умер: маркер в папке git клона с pid процесса, которого уже нет. */
const ownRebase = (r: TeamRepo, cfg: string) => {
  gitAs(cfg, r.repoDir, 'fetch', '-q', 'origin');
  fs.writeFileSync(path.join(r.repoDir, '.git', 'agentgraph-rebase'), '');
  assert.throws(() => gitAs(cfg, r.repoDir, 'rebase', 'origin/main'));
  assert.ok(fs.existsSync(path.join(r.repoDir, '.git', 'rebase-merge')));
};

test('D-2: клон остался посреди своего rebase с конфликтом — синхронизация откатывает rebase, маркеров в репо команды нет, мои коммиты уходят', async () => {
  const { a, b, B, remoteText } = await team();
  await a.write('PAY-1: оценка 3', (r) => setTask(r, 'PAY-1', { estimate: 3 }));
  await a.push();
  await b.write('PAY-1: оценка 5', (r) => setTask(r, 'PAY-1', { estimate: 5 }));
  await b.write('PAY-2: создана', (r) => r.writeFile(tf('PAY-2'), serializeTask(task('PAY-2'))));
  // процесс умер посреди своего rebase: git остановился на конфликте
  ownRebase(b, B.cfg);
  await b.sync();
  assert.equal(fs.existsSync(path.join(b.repoDir, '.git', 'agentgraph-rebase')), false);
  assert.doesNotMatch(remoteText(tf('PAY-1')) ?? '', /<<<<<<<|>>>>>>>/);
  assert.equal(parseTask(remoteText(tf('PAY-1')) ?? '', tf('PAY-1')).estimate, 3);
  assert.ok(remoteText(tf('PAY-2')), 'мой коммит после конфликтного ушёл команде');
  assert.equal(fs.existsSync(path.join(b.repoDir, '.git', 'rebase-merge')), false);
  assert.equal(gitAs(B.cfg, b.repoDir, 'symbolic-ref', '-q', 'HEAD').trim(), 'refs/heads/main');
  assert.equal(await b.unpushed(), 0);
  assert.deepEqual(b.local().conflicts.map((c) => [c.kind, c.field, c.ours]), [['field', 'estimate', 5]]);
});

test('D-2: запись в клон посреди своего rebase сначала откатывает его и пишет на ветку, а не в отделённый HEAD', async () => {
  const { a, b, B } = await team();
  await a.write('PAY-1: оценка 3', (r) => setTask(r, 'PAY-1', { estimate: 3 }));
  await a.push();
  await b.write('PAY-1: оценка 5', (r) => setTask(r, 'PAY-1', { estimate: 5 }));
  ownRebase(b, B.cfg);
  // пока rebase стоит, неотправленные коммиты всё равно видны
  assert.equal(await b.unpushed(), 1);
  await b.write('PAY-1: тип', (r) => setTask(r, 'PAY-1', { type: 'bug' }));
  assert.equal(gitAs(B.cfg, b.repoDir, 'symbolic-ref', '-q', 'HEAD').trim(), 'refs/heads/main');
  assert.equal(readTask(b, 'PAY-1').estimate, 5);
  assert.equal(readTask(b, 'PAY-1').type, 'bug');
  assert.doesNotMatch(b.read(tf('PAY-1')) ?? '', /<<<<<<<|>>>>>>>/);
  assert.equal(await b.unpushed(), 2);
});

test('D-2: слияние, начатое руками, agentgraph не откатывает и не коммитит маркерами — 409 repo_state с подсказкой, сведённое руками на месте', async () => {
  const { a, b, B, remoteText } = await team();
  await a.write('PAY-1: оценка 3', (r) => setTask(r, 'PAY-1', { estimate: 3 }));
  await a.push();
  await b.write('PAY-1: оценка 5', (r) => setTask(r, 'PAY-1', { estimate: 5 }));
  gitAs(B.cfg, b.repoDir, 'fetch', '-q', 'origin');
  assert.throws(() => gitAs(B.cfg, b.repoDir, 'merge', 'origin/main'));
  // человек свёл файл руками и ещё не сделал git add
  const resolved = serializeTask({ ...task('PAY-1'), estimate: 4 });
  fs.writeFileSync(path.join(b.repoDir, tf('PAY-1')), resolved);
  const repoState = (e: TeamError) => e.status === 409 && e.code === 'repo_state' && /merge --abort/.test(e.message);
  await assert.rejects(b.write('PAY-1: тип', (r) => setTask(r, 'PAY-1', { type: 'bug' })), repoState);
  await assert.rejects(b.pull(), repoState);
  assert.equal(fs.readFileSync(path.join(b.repoDir, tf('PAY-1')), 'utf8'), resolved);
  assert.ok(fs.existsSync(path.join(b.repoDir, '.git', 'MERGE_HEAD')));
  // MERGE_HEAD сняли руками — остались файлы с конфликтом в индексе: тоже не коммитятся
  fs.rmSync(path.join(b.repoDir, '.git', 'MERGE_HEAD'));
  await assert.rejects(b.sync(), (e: TeamError) => e.code === 'repo_state' && /незавершённое слияние/.test(e.message));
  assert.equal(parseTask(remoteText(tf('PAY-1')) ?? '', tf('PAY-1')).estimate, 3);
  assert.doesNotMatch(remoteText(tf('PAY-1')) ?? '', /<<<<<<<|>>>>>>>/);
});

test('D-2: rebase, начатый руками, и rebase другого живого процесса agentgraph не откатываются', async () => {
  const { a, b, B } = await team();
  await a.write('PAY-1: оценка 3', (r) => setTask(r, 'PAY-1', { estimate: 3 }));
  await a.push();
  await b.write('PAY-1: оценка 5', (r) => setTask(r, 'PAY-1', { estimate: 5 }));
  gitAs(B.cfg, b.repoDir, 'fetch', '-q', 'origin');
  assert.throws(() => gitAs(B.cfg, b.repoDir, 'rebase', 'origin/main'));
  await assert.rejects(b.sync(), (e: TeamError) => e.code === 'repo_state' && /rebase --abort/.test(e.message));
  assert.ok(fs.existsSync(path.join(b.repoDir, '.git', 'rebase-merge')));
  // маркер живого процесса (не этого): его rebase не трогаем
  fs.writeFileSync(path.join(b.repoDir, '.git', 'agentgraph-rebase'), String(process.ppid));
  await assert.rejects(b.write('x', (r) => setTask(r, 'PAY-1', { type: 'bug' })), (e: TeamError) => e.code === 'busy');
  assert.ok(fs.existsSync(path.join(b.repoDir, '.git', 'rebase-merge')));
});

test('D-3: двое одновременно подключаются с «добавить меня» — у команды оба, конфликтов нет', async () => {
  const { dir, bare, remoteText } = await team();
  const C = actor(dir, 'carol');
  const D = actor(dir, 'dave');
  const [{ repo: c }, { repo: d }] = await Promise.all([joinTeam({ url: bare }, C.deps, C.root), joinTeam({ url: bare }, D.deps, D.root)]);
  opened.push(c, d);
  await c.push();
  await d.push();
  await c.push();
  const members = parseTeamConfig(remoteText('teamwork.yaml') ?? '').members.map((m) => m.email).sort();
  assert.deepEqual(members, ['alice@example.com', 'bob@example.com', 'carol@example.com', 'dave@example.com']);
  assert.deepEqual(c.local().conflicts, []);
  assert.deepEqual(d.local().conflicts, []);
});

test('D-3: одновременные добавления в blockedBy одной задачи сливаются в оба, удалённое одной стороной убирается', async () => {
  const { a, b } = await team((r) => {
    for (const id of ['PAY-2', 'PAY-3', 'PAY-4']) r.writeFile(tf(id), serializeTask(task(id)));
    r.writeFile(tf('PAY-5'), serializeTask(task('PAY-5', { blockedBy: ['PAY-1'] })));
  });
  await b.pull();
  await a.write('PAY-5 ждёт PAY-2', (r) => setTask(r, 'PAY-5', { blockedBy: ['PAY-1', 'PAY-2'], estimate: 1 }));
  await b.write('PAY-5 ждёт PAY-3, не PAY-1', (r) => setTask(r, 'PAY-5', { blockedBy: ['PAY-3'], estimate: 2 }));
  await a.push();
  await b.push();
  assert.deepEqual([...readTask(b, 'PAY-5').blockedBy].sort(), ['PAY-2', 'PAY-3']);
  assert.deepEqual(b.local().conflicts.map((c) => c.field), ['estimate']);
});

test('D-4: моя задача переименована из-за совпавшего номера — мои комментарии переезжают с ней, чужие остаются', async () => {
  const { a, b, remoteText } = await team();
  await a.write('PAY-2 alice', (r) => {
    r.writeFile(tf('PAY-2'), serializeTask(task('PAY-2', { title: 'от alice' })));
    r.writeFile('projects/p/comments/PAY-2/2026-11-12T09-00-00Z-alice.md', '---\nauthor: alice@example.com\nat: 2026-11-12T09:00:00Z\n---\n\nк задаче alice\n');
  });
  await b.write('PAY-2 bob', (r) => r.writeFile(tf('PAY-2'), serializeTask(task('PAY-2', { title: 'от bob' }))));
  await b.write('PAY-2 комментарий', (r) => r.writeFile('projects/p/comments/PAY-2/2026-11-12T10-00-00Z-bob.md', '---\nauthor: bob@example.com\nat: 2026-11-12T10:00:00Z\n---\n\nк своей задаче\n'));
  await a.push();
  await b.push();
  assert.equal(readTask(b, 'PAY-2').title, 'от alice');
  assert.equal(readTask(b, 'PAY-3').title, 'от bob');
  assert.deepEqual(b.list('projects/p/comments/PAY-2'), ['2026-11-12T09-00-00Z-alice.md']);
  assert.deepEqual(b.list('projects/p/comments/PAY-3'), ['2026-11-12T10-00-00Z-bob.md']);
  assert.match(remoteText('projects/p/comments/PAY-3/2026-11-12T10-00-00Z-bob.md') ?? '', /к своей задаче/);
  assert.equal(remoteText('projects/p/comments/PAY-2/2026-11-12T10-00-00Z-bob.md'), undefined);
});

test('D-4: переименование после чистого rebase (номер занят в другом проекте) тоже переносит мои комментарии', async () => {
  const { a, b } = await team();
  await a.write('PAY-9 в q', (r) => r.writeFile(tf('PAY-9', 'q'), serializeTask(task('PAY-9', { title: 'alice q' }, 'q'))));
  await a.push();
  await b.write('PAY-9 в p', (r) => {
    r.writeFile(tf('PAY-9'), serializeTask(task('PAY-9', { title: 'bob p' })));
    r.writeFile('projects/p/comments/PAY-9/2026-11-12T10-00-00Z-bob.md', '---\nauthor: bob@example.com\nat: 2026-11-12T10:00:00Z\n---\n\nмой\n');
  });
  await b.push();
  assert.equal(readTask(b, 'PAY-10').title, 'bob p');
  assert.deepEqual(b.list('projects/p/comments/PAY-10'), ['2026-11-12T10-00-00Z-bob.md']);
  assert.deepEqual(b.dirs('projects/p/comments'), ['PAY-10']);
});

test('D-5: я удалил задачу, коллега её правил и отправил первым — задача остаётся, её комментарии и ссылки соседей тоже', async () => {
  const { a, b, A } = await team((r) => {
    r.writeFile(tf('PAY-2'), serializeTask(task('PAY-2', { blockedBy: ['PAY-1'] })));
    r.writeFile('projects/p/comments/PAY-1/c1.md', '---\nauthor: alice@example.com\nat: 2026-11-12T09:00:00Z\n---\n\nважный комментарий\n');
  });
  await b.pull();
  // alice удаляет PAY-1 так же, как deleteTask: файл, комментарии, ссылки соседей
  await a.write('PAY-1: удалена', (r) => {
    r.remove(tf('PAY-1'));
    r.remove('projects/p/comments/PAY-1');
    setTask(r, 'PAY-2', { blockedBy: [] });
  });
  await b.write('PAY-1: оценка', (r) => setTask(r, 'PAY-1', { estimate: 5 }));
  await b.push();
  await a.push();
  assert.ok(a.exists(tf('PAY-1')));
  assert.ok(a.exists('projects/p/comments/PAY-1/c1.md'));
  assert.deepEqual(readTask(a, 'PAY-2').blockedBy, ['PAY-1']);
  assert.deepEqual(a.local().conflicts.map((c) => [c.kind, c.file]), [['deleted', tf('PAY-1')]]);
  // «вернуть моё» — удаление целиком, как deleteTask: и комментарии, и ссылки соседей
  const svc = service(A);
  await svc.resolveConflict(a.slug, a.local().conflicts[0].id, 'mine');
  const after = svc.repo(a.slug);
  assert.equal(after.exists(tf('PAY-1')), false);
  assert.equal(after.exists('projects/p/comments/PAY-1'), false);
  assert.deepEqual(readTask(after, 'PAY-2').blockedBy, []);
  await svc.stop();
});

test('D-5: мой комментарий к задаче, которую команда удалила, — в конфликт deleted, а не сиротой в репо', async () => {
  const { a, b, B, remoteText } = await team();
  await b.pull();
  await a.write('PAY-1: удалена', (r) => {
    r.remove(tf('PAY-1'));
    r.remove('projects/p/comments/PAY-1');
  });
  await a.push();
  await b.write('PAY-1: комментарий', (r) => r.writeFile('projects/p/comments/PAY-1/2026-11-12T10-00-00Z-bob.md', '---\nauthor: bob@example.com\nat: 2026-11-12T10:00:00Z\n---\n\nмой\n'));
  await b.write('PAY-1: оценка', (r) => setTask(r, 'PAY-1', { estimate: 2 }));
  await b.push();
  assert.equal(remoteText('projects/p/comments/PAY-1/2026-11-12T10-00-00Z-bob.md'), undefined);
  assert.deepEqual(b.local().conflicts.map((c) => [c.kind, c.file, c.task]).sort(), [
    ['deleted', 'projects/p/comments/PAY-1/2026-11-12T10-00-00Z-bob.md', 'PAY-1'],
    ['deleted', tf('PAY-1'), 'PAY-1'],
  ]);
  // вернуть комментарий к задаче, которой нет, — сирота: 409
  const svc = service(B);
  const c = b.local().conflicts.find((x) => x.file.includes('/comments/'))!;
  await assert.rejects(svc.resolveConflict(b.slug, c.id, 'mine'), (e: TeamError) => e.status === 409 && /комментарий вернуть некуда/.test(e.message));
  await svc.stop();
});

test('D-6: сбой посреди перепроигрывания ничего не теряет — ни до коммита, ни после записи конфликтов; повтор их не задваивает', async () => {
  const { a, b, B, remoteText } = await team();
  await a.write('PAY-1: оценка 3', (r) => setTask(r, 'PAY-1', { estimate: 3 }));
  await a.push();
  await b.write('PAY-1: оценка 5', (r) => setTask(r, 'PAY-1', { estimate: 5 }));
  await b.write('PAY-2: создана', (r) => r.writeFile(tf('PAY-2'), serializeTask(task('PAY-2'))));
  const head = gitAs(B.cfg, b.repoDir, 'rev-parse', 'HEAD').trim();
  // коммит перепроигрывания подписывается, как и остальные: подпись не удалась — ничего не сдвинулось
  gitAs(B.cfg, b.repoDir, 'config', 'commit.gpgsign', 'true');
  gitAs(B.cfg, b.repoDir, 'config', 'gpg.program', '/nonexistent/gpg');
  await assert.rejects(b.sync(), /commit-tree/);
  assert.equal(gitAs(B.cfg, b.repoDir, 'rev-parse', 'HEAD').trim(), head);
  gitAs(B.cfg, b.repoDir, 'config', '--unset', 'commit.gpgsign');
  gitAs(B.cfg, b.repoDir, 'config', '--unset', 'gpg.program');
  let fail = 'commit-tree';
  const x: Exec = (cmd, args, opts) => {
    if (fail && args.includes(fail)) {
      fail = '';
      return Promise.reject(new Error(`git ${args.find((v) => !v.startsWith('-') && v !== 'core.quotePath=false')}: сбой`));
    }
    return B.deps.exec(cmd, args, opts);
  };
  const flaky = new TeamRepo(b.slug, b.dir, { ...B.deps, exec: x });
  opened.push(flaky);
  await assert.rejects(flaky.sync(), /commit-tree: сбой/);
  assert.equal(gitAs(B.cfg, b.repoDir, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(gitAs(B.cfg, b.repoDir, 'status', '--porcelain'), '');
  assert.deepEqual(flaky.local().conflicts, []);
  assert.equal(await flaky.unpushed(), 2);
  // сбой после записи конфликтов, до сдвига ветки: ветка на месте, конфликт записан
  fail = 'reset';
  await assert.rejects(flaky.sync(), /reset: сбой/);
  assert.equal(gitAs(B.cfg, b.repoDir, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(flaky.local().conflicts.length, 1);
  await flaky.sync();
  assert.deepEqual(flaky.local().conflicts.map((c) => [c.field, c.ours]), [['estimate', 5]]);
  assert.ok(remoteText(tf('PAY-2')));
  assert.equal(parseTask(remoteText(tf('PAY-1')) ?? '', tf('PAY-1')).estimate, 3);
});

test('D-7: история репо команды переписана — синхронизация отвечает rewritten, без перепроигрывания и отправки', async () => {
  const { dir, bare, b, A } = await team();
  await b.write('PAY-1: оценка', (r) => setTask(r, 'PAY-1', { estimate: 1 }));
  // репо команды пересоздали: новая история без общих коммитов, push --force
  const work = path.join(dir, 'fresh');
  gitAs(A.cfg, dir, 'init', '-q', '-b', 'main', work);
  fs.writeFileSync(path.join(work, 'teamwork.yaml'), 'format: 1\ntitle: Новая\nprefix: PAY\n');
  gitAs(A.cfg, work, 'add', '.');
  gitAs(A.cfg, work, 'commit', '-q', '-m', 'заново');
  gitAs(A.cfg, work, 'push', '-q', '--force', bare, 'main');
  const before = gitAs(A.cfg, dir, '--git-dir', bare, 'rev-parse', 'main').trim();
  await assert.rejects(b.sync(), (e: TeamError) => e.status === 409 && e.code === 'rewritten');
  assert.equal(gitAs(A.cfg, dir, '--git-dir', bare, 'rev-parse', 'main').trim(), before);
  assert.match(b.local().sync.error ?? '', /История репо команды переписана/);
  assert.equal(readTask(b, 'PAY-1').estimate, 1);
  assert.equal(await b.unpushed() > 0, true);
});

test('D-8: репо команды перешло на новый формат, а у меня неотправленный коммит — ни слияния, ни отправки, клон только для чтения', async () => {
  const { dir, bare, a, b, A } = await team();
  await a.write('формат 2', (r) => r.writeFile('teamwork.yaml', r.read('teamwork.yaml')!.replace(/^format: 1/m, 'format: 2')));
  await a.push();
  const remoteHead = gitAs(A.cfg, dir, '--git-dir', bare, 'rev-parse', 'main').trim();
  await b.write('PAY-1: оценка', (r) => setTask(r, 'PAY-1', { estimate: 1 }));
  const head = gitAs(A.cfg, b.repoDir, 'rev-parse', 'HEAD').trim();
  await assert.rejects(b.sync(), (e: TeamError) => e.status === 409 && e.code === 'readonly');
  assert.equal(gitAs(A.cfg, dir, '--git-dir', bare, 'rev-parse', 'main').trim(), remoteHead);
  assert.equal(gitAs(A.cfg, b.repoDir, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(b.readonly(), true);
  assert.equal((await b.syncState()).state, 'readonly');
  assert.equal(await b.unpushed(), 1);
  await assert.rejects(b.write('ещё', (r) => setTask(r, 'PAY-1', { estimate: 2 })), (e: TeamError) => e.code === 'readonly');
});

test('D-11: отключение ждёт идущую запись и считает после неё; нерешённые конфликты тоже держат; отказ возвращает клон в работу', async () => {
  const { b } = await team();
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const gate = new Promise<void>((r) => (release = r));
  const writing = b.write('PAY-1: тип', async (r) => {
    entered();
    await gate;
    setTask(r, 'PAY-1', { type: 'bug' });
  });
  await inside;
  const disconnecting = b.disconnect(false);
  release();
  await writing;
  await assert.rejects(disconnecting, (e: TeamError) => e.code === 'unpushed' && e.extra?.unpushed === 1 && JSON.stringify(e.extra.commits) === '["PAY-1: тип"]');
  // клон снова работает: запись и отправка проходят
  await b.write('PAY-1: оценка', (r) => setTask(r, 'PAY-1', { estimate: 1 }));
  await b.push();
  assert.equal(await b.unpushed(), 0);
  b.saveLocal((l) => l.conflicts.push({ id: 'abc123', file: tf('PAY-1'), kind: 'field', field: 'estimate', ours: 2, theirs: 1, at: 'x' }));
  await assert.rejects(b.disconnect(false), (e: TeamError) => e.code === 'unpushed' && e.extra?.conflicts === 1 && /нерешённых конфликтов: 1/i.test(e.message));
  assert.ok(fs.existsSync(b.repoDir));
  // «два активных спринта» — сообщение без моей версии: отключению не мешает
  b.saveLocal((l) => (l.conflicts = [{ id: 'def456', file: 'projects/p/sprints/2.yaml', kind: 'sprint', ours: 2, theirs: 1, at: 'x' }]));
  await b.disconnect(false);
  assert.equal(fs.existsSync(b.dir), false);
});

test('D-15: после отключения отправка и получение ничего не делают, а папка команды не появляется снова', async () => {
  const { bare, b, B } = await team();
  await b.disconnect(true);
  await b.push();
  await b.pull();
  await b.sync();
  assert.equal(fs.existsSync(b.dir), false);
  assert.deepEqual(TeamRepo.list(B.root), []);
  const { repo } = await joinTeam({ url: bare, addMe: false }, B.deps, B.root);
  opened.push(repo);
  assert.equal(repo.slug, b.slug);
});

test('D-13: одно поле спринта с разными значениями — обычный конфликт поля (kind field), не «два активных спринта»', async () => {
  const { a, b } = await team((r) => r.writeFile('projects/p/sprints/1.yaml', serializeSprint({ number: 1, title: 'Спринт 1', status: 'planned', extra: {} })));
  await b.pull();
  await a.write('спринт: название A', (r) => r.writeFile('projects/p/sprints/1.yaml', r.read('projects/p/sprints/1.yaml')!.replace('Спринт 1', 'A')));
  await b.write('спринт: название B', (r) => r.writeFile('projects/p/sprints/1.yaml', r.read('projects/p/sprints/1.yaml')!.replace('Спринт 1', 'B')));
  await a.push();
  await b.push();
  assert.deepEqual(b.local().conflicts.map((c) => [c.kind, c.field, c.ours, c.theirs]), [['field', 'title', 'B', 'A']]);
});

test('D-14: моя задача переименована — мои ссылки на неё в изменённых (не только новых) задачах идут за новым номером, и после rebase, и после перепроигрывания', async () => {
  const { a, b } = await team((r) => r.writeFile(tf('PAY-2'), serializeTask(task('PAY-2'))));
  await b.pull();
  // чистый rebase: номер занят задачей другого проекта
  await a.write('PAY-9 в q', (r) => r.writeFile(tf('PAY-9', 'q'), serializeTask(task('PAY-9', { title: 'alice q' }, 'q'))));
  await a.push();
  await b.write('PAY-9 в p', (r) => r.writeFile(tf('PAY-9'), serializeTask(task('PAY-9', { title: 'bob p' }))));
  await b.write('PAY-2 ждёт PAY-9', (r) => setTask(r, 'PAY-2', { blockedBy: ['PAY-9'] }));
  await b.push();
  assert.equal(readTask(b, 'PAY-10').title, 'bob p');
  assert.deepEqual(readTask(b, 'PAY-2').blockedBy, ['PAY-10']);
  await a.pull();
  // перепроигрывание: конфликт поля рядом, номер снова занят в другом проекте
  await a.write('PAY-11 в q', (r) => {
    r.writeFile(tf('PAY-11', 'q'), serializeTask(task('PAY-11', { title: 'alice q2' }, 'q')));
    setTask(r, 'PAY-1', { estimate: 3 });
  });
  await a.push();
  await b.write('PAY-11 в p', (r) => r.writeFile(tf('PAY-11'), serializeTask(task('PAY-11', { title: 'bob p2' }))));
  await b.write('PAY-2 ждёт и PAY-11', (r) => setTask(r, 'PAY-2', { blockedBy: ['PAY-10', 'PAY-11'], estimate: 5 }));
  await b.write('PAY-1: оценка 5', (r) => setTask(r, 'PAY-1', { estimate: 5 }));
  await b.push();
  assert.equal(readTask(b, 'PAY-12').title, 'bob p2');
  assert.deepEqual(readTask(b, 'PAY-2').blockedBy, ['PAY-10', 'PAY-12']);
  assert.equal(readTask(b, 'PAY-11', 'q').title, 'alice q2');
});

test('D-17: спринт закрыли, пока я переносил в него задачу, — она возвращается в бэклог у обоих, без конфликтов', async () => {
  const { a, b } = await team((r) => {
    r.writeFile('projects/p/sprints/1.yaml', serializeSprint({ number: 1, title: 'Спринт 1', status: 'active', startedAt: '2026-11-12T10:00:00Z', extra: {} }));
    setTask(r, 'PAY-1', { sprint: 1 });
    r.writeFile(tf('PAY-2'), serializeTask(task('PAY-2')));
  });
  await b.pull();
  await a.write('спринт 1 завершён', (r) => {
    r.writeFile('projects/p/sprints/1.yaml', serializeSprint({ number: 1, title: 'Спринт 1', status: 'closed', startedAt: '2026-11-12T10:00:00Z', closedAt: '2026-11-13T10:00:00Z', result: { done: [], carried: [], returned: ['PAY-1'] }, extra: {} }));
    setTask(r, 'PAY-1', { sprint: undefined });
  });
  await a.push();
  await b.write('PAY-2: спринт → 1', (r) => setTask(r, 'PAY-2', { sprint: 1 }));
  await b.push();
  assert.equal(readTask(b, 'PAY-2').sprint, undefined);
  await a.pull();
  assert.equal(readTask(a, 'PAY-2').sprint, undefined);
  assert.deepEqual([a.local().conflicts, b.local().conflicts], [[], []]);
  assert.equal(await b.unpushed(), 0);
});

test('S-7: висячая ссылка в клоне не пропускает запись наружу; ссылка внутрь клона — можно', async () => {
  const { dir, a } = await team();
  const target = path.join(dir, 'outside.md');
  fs.symlinkSync(target, path.join(a.repoDir, 'projects', 'p', 'dangling.md'));
  assert.throws(() => a.writeFile('projects/p/dangling.md', 'x'), /за пределы/);
  assert.equal(fs.existsSync(target), false);
  fs.symlinkSync(path.join(a.repoDir, 'projects'), path.join(a.repoDir, 'inner'));
  assert.equal(a.abs('inner/p/x.md'), path.join(a.repoDir, 'inner/p/x.md'));
  fs.unlinkSync(path.join(a.repoDir, 'projects', 'p', 'dangling.md'));
  fs.unlinkSync(path.join(a.repoDir, 'inner'));
});

test('D-1: файл и папка с одним путём (у меня файл стал папкой, у команды он изменился) — в конфликт, синхронизация не падает', async () => {
  const { a, b, remoteText } = await team((r) => r.writeFile('projects/p/docs/a', 'было\n'));
  await b.pull();
  await a.write('a изменён', (r) => r.writeFile('projects/p/docs/a', 'стало\n'));
  await a.push();
  await b.write('a стал папкой', (r) => {
    r.remove('projects/p/docs/a');
    r.writeFile('projects/p/docs/a/b.md', 'внутри\n');
  });
  await b.sync();
  assert.equal(remoteText('projects/p/docs/a'), 'стало\n');
  assert.deepEqual(b.local().conflicts.map((c) => [c.kind, c.file]).sort(), [['deleted', 'projects/p/docs/a'], ['deleted', 'projects/p/docs/a/b.md']]);
  assert.equal(await b.unpushed(), 0);
});

test('D-1: текст больше 8 МБ, изменённый обеими сторонами, — в конфликт с blob, а не ошибка синхронизации', async () => {
  const big = (c: string) => `${c.repeat(9 * 1024 * 1024)}\n`;
  const { a, b, remote } = await team((r) => r.writeFile('projects/p/docs/big.txt', big('a')));
  await b.pull();
  await a.write('big alice', (r) => r.writeFile('projects/p/docs/big.txt', big('b')));
  await a.push();
  await b.write('big bob', (r) => r.writeFile('projects/p/docs/big.txt', big('c')));
  await b.sync();
  assert.equal(remote('projects/p/docs/big.txt')?.[0], 'b'.charCodeAt(0));
  const [c] = b.local().conflicts;
  assert.deepEqual([c?.kind, c?.file, Boolean(c?.blob)], ['text', 'projects/p/docs/big.txt', true]);
});
