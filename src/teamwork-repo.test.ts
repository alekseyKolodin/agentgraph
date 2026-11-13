// Клон репо команды на настоящем git: временный bare-репо как origin и два клона, «alice» и «bob», каждый со своей
// папкой команд и своим глобальным git config (идентичность), без сети. Создание и подключение (spec §15 «Создание и
// подключение»), синхронизация на двух клонах (§15 «Синхронизация»), совпадение номеров (§15 «Порядок и номера»).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, type Exec } from './git.js';
import { checkRemote, createTeam, joinTeam, TeamError, TeamRepo, type ChangeEvent, type RepoDeps } from './teamwork-repo.js';
import { defaultRepoDeps } from './teamwork-repo.js';
import { composeTask, parseTask, parseTeamConfig, serializeTask, type TaskFile } from './teamwork.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-teamwork-')));
const bare = path.join(tmp, 'team.git');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'none.gitconfig') } }).trim();

type Actor = { name: string; root: string; deps: RepoDeps };

/** Участник: своя папка команд и свой глобальный git config с именем и email; таймеры далеко — отправка только явным push(). */
function actor(name: string, email: string): Actor {
  const cfg = path.join(tmp, `${name}.gitconfig`);
  fs.writeFileSync(cfg, `[user]\n\tname = ${name}\n\temail = ${email}\n[init]\n\tdefaultBranch = main\n`);
  const x: Exec = (cmd, args, opts = {}) => exec(cmd, args, { ...opts, env: { ...opts.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg } });
  const root = path.join(tmp, name, 'teams');
  fs.mkdirSync(root, { recursive: true });
  return { name, root, deps: { ...defaultRepoDeps(), exec: x, pushDelayMs: 60_000, retryMinMs: 60_000, retryMaxMs: 60_000, pollOpenMs: 3_600_000, pollIdleMs: 3_600_000, tmpDir: tmp } };
}

const alice = actor('alice', 'alice@example.com');
const bob = actor('bob', 'bob@example.com');
const repos: TeamRepo[] = [];
const track = (r: TeamRepo) => {
  repos.push(r);
  return r;
};

const task = (id: string, extra: Partial<TaskFile> = {}, body = '## Описание\n\nтекст\n'): TaskFile => ({
  id, title: `Задача ${id}`, type: 'feature', status: 'todo', rank: 'V', blockedBy: [], covers: [], body, acceptance: { done: 0, total: 0 }, comments: 0, base: '', file: `projects/p/tasks/${id}.md`, extra: {}, ...extra,
});
const taskFile = (id: string) => `projects/p/tasks/${id}.md`;
const readTask = (r: TeamRepo, id: string) => parseTask(r.read(taskFile(id)) ?? '', taskFile(id));

before(() => {
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
});

after(async () => {
  for (const r of repos) await r.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let a!: TeamRepo;
let b!: TeamRepo;

test('проверка ссылки: плохая ссылка — error, пустой репо — empty, непустой без teamwork.yaml — not_empty', async () => {
  assert.equal((await checkRemote('-oProxyCommand=x', alice.deps)).kind, 'error');
  assert.equal((await checkRemote(path.join(tmp, 'nope.git'), alice.deps)).kind, 'error');
  assert.deepEqual(await checkRemote(bare, alice.deps), { kind: 'empty' });
  const other = path.join(tmp, 'other.git');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', other);
  const work = path.join(tmp, 'other-work');
  git(tmp, 'clone', '-q', other, work);
  fs.writeFileSync(path.join(work, 'README.md'), 'не команда');
  git(work, '-c', 'user.name=x', '-c', 'user.email=x@x', 'add', '.');
  git(work, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  assert.deepEqual(await checkRemote(other, alice.deps), { kind: 'not_empty' });
  await assert.rejects(createTeam({ url: other, title: 'X', prefix: 'XX' }, alice.deps, alice.root), (e: TeamError) => e.status === 409 && e.code === 'not_empty');
  await assert.rejects(joinTeam({ url: other }, alice.deps, alice.root), (e: TeamError) => e.status === 409 && e.code === 'not_empty');
  // в папке команд ничего не осталось
  assert.deepEqual(TeamRepo.list(alice.root), []);
});

test('создание команды: пустой репо получает шаблон, teamwork.yaml — название, префикс и меня с комментариями шаблона, всё отправлено', async () => {
  await assert.rejects(createTeam({ url: bare, title: '', prefix: 'PAY' }, alice.deps, alice.root), /название/);
  await assert.rejects(createTeam({ url: bare, title: 'Платёжная', prefix: 'p1' }, alice.deps, alice.root), /латиница/);
  // без user.email — подсказка, клона не остаётся
  const nobody = actor('nobody', '');
  fs.writeFileSync(path.join(tmp, 'nobody.gitconfig'), '[init]\n\tdefaultBranch = master\n');
  await assert.rejects(createTeam({ url: bare, title: 'Платёжная', prefix: 'PAY' }, nobody.deps, nobody.root), /user\.email/);
  assert.deepEqual(TeamRepo.list(nobody.root), []);
  assert.deepEqual(await checkRemote(bare, alice.deps), { kind: 'empty' });

  a = track(await createTeam({ url: bare, title: 'Платёжная команда', prefix: 'pay' }, alice.deps, alice.root));
  assert.equal(a.slug, 'team');
  assert.deepEqual(TeamRepo.list(alice.root), ['team']);
  for (const f of ['teamwork.yaml', 'README.md', 'project-template/prd.md', 'project-template/architecture.md', 'project-template/design.md']) assert.ok(a.exists(f), f);
  const text = a.read('teamwork.yaml')!;
  assert.match(text, /# версия формата/);
  const cfg = parseTeamConfig(text);
  assert.equal(cfg.title, 'Платёжная команда');
  assert.equal(cfg.prefix, 'PAY');
  assert.deepEqual(cfg.members, [{ name: 'alice', email: 'alice@example.com' }]);
  assert.equal(cfg.defaultFlow, 'teamwork-task');
  assert.equal(await a.unpushed(), 0);
  assert.equal(git(bare, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(bare, 'log', '--format=%s %ae', 'main'), 'Команда «Платёжная команда» создана alice@example.com');
  const local = a.local();
  assert.equal(local.remote, bare);
  assert.equal(local.branch, 'main');
  assert.ok(local.sync.lastPushAt);
  assert.deepEqual(await a.identity(), { name: 'alice', email: 'alice@example.com' });
  const st = await a.syncState();
  assert.equal(st.state, 'ok');
  // репо команды — предложение подключиться, а не создать
  const check = await checkRemote(bare, bob.deps);
  assert.equal(check.kind, 'team');
  if (check.kind === 'team') {
    assert.equal(check.title, 'Платёжная команда');
    assert.equal(check.prefix, 'PAY');
    assert.deepEqual(check.projects, []);
  }
  await assert.rejects(createTeam({ url: bare, title: 'Ещё', prefix: 'TWO' }, bob.deps, bob.root), (e: TeamError) => e.status === 409 && e.code === 'is_team');
});

test('подключение: bob клонирует, добавляется участником отдельным коммитом; alice получает его после pull; слаг не повторяется', async () => {
  const joined = await joinTeam({ url: bare }, bob.deps, bob.root);
  b = track(joined.repo);
  assert.equal(joined.added, true);
  assert.equal(b.slug, 'team');
  assert.equal(await b.unpushed(), 0);
  assert.deepEqual(parseTeamConfig(b.read('teamwork.yaml')!).members.map((m) => m.email), ['alice@example.com', 'bob@example.com']);
  assert.match(git(bare, 'log', '-1', '--format=%s %ae', 'main'), /^Участник добавлен: bob bob@example.com$/);
  const changes: string[][] = [];
  const off = a.onChange((e) => changes.push(e.projects));
  await a.pull();
  off();
  assert.deepEqual(parseTeamConfig(a.read('teamwork.yaml')!).members.map((m) => m.email), ['alice@example.com', 'bob@example.com']);
  // изменился только корень — событие с пустым списком проектов
  assert.deepEqual(changes, [[]]);
  // уже в участниках — второго коммита нет; второй клон той же команды получает слаг team-2
  const again = await joinTeam({ url: bare, addMe: true }, bob.deps, bob.root);
  assert.equal(again.added, false);
  assert.equal(again.repo.slug, 'team-2');
  await again.repo.disconnect(false);
  assert.deepEqual(TeamRepo.list(bob.root), ['team']);
  assert.equal(TeamRepo.open('team', bob.deps, bob.root)?.repoDir, b.repoDir);
  assert.equal(TeamRepo.open('nope', bob.deps, bob.root), undefined);
});

test('запись: один коммит на запись с автором из git config, сообщение как есть, событие с проектом; бросившая mutate ничего не коммитит', async () => {
  const seen: { team: string; projects: string[] }[] = [];
  const off = a.onChange((e) => seen.push(e));
  await a.write('PAY-1: создана', (r) => r.writeFile(taskFile('PAY-1'), serializeTask(task('PAY-1'))));
  await a.write('PAY-2: создана', (r) => r.writeFile(taskFile('PAY-2'), serializeTask(task('PAY-2', { rank: 'l' }))));
  off();
  assert.deepEqual(seen, [{ team: 'team', projects: ['p'] }, { team: 'team', projects: ['p'] }]);
  assert.equal(await a.unpushed(), 2);
  assert.deepEqual(await a.unpushedSubjects(), ['PAY-2: создана', 'PAY-1: создана']);
  assert.equal((await a.syncState()).state, 'pending');
  await assert.rejects(a.write('упадёт', (r) => {
    r.writeFile(taskFile('PAY-9'), 'мусор');
    throw new TeamError(409, 'конфликт');
  }), /конфликт/);
  assert.equal(a.exists(taskFile('PAY-9')), false);
  assert.equal(await a.unpushed(), 2);
  // пустая запись — без коммита
  await a.write('ничего', () => undefined);
  assert.equal(await a.unpushed(), 2);
  await a.push();
  assert.equal(await a.unpushed(), 0);
  assert.equal(git(bare, 'log', '-1', '--format=%an <%ae>', 'main'), 'alice <alice@example.com>');
  // автор, переданный записью
  await a.write('PAY-1: комментарий', (r) => r.writeFile('projects/p/comments/PAY-1/x.md', 'hi'), { author: { name: 'Робот', email: 'bot@example.com' } });
  await a.push();
  assert.equal(git(bare, 'log', '-1', '--format=%an <%ae>', 'main'), 'Робот <bot@example.com>');
});

test('два клона: разные задачи сливаются, разные поля одной задачи сливаются по полям, одно поле — значение команды и конфликт у меня', async () => {
  await b.pull();
  assert.ok(b.exists(taskFile('PAY-1')));
  // разные задачи с двух сторон
  await a.write('PAY-3: создана', (r) => r.writeFile(taskFile('PAY-3'), serializeTask(task('PAY-3', { rank: 'q' }))));
  await b.write('PAY-5: создана', (r) => r.writeFile(taskFile('PAY-5'), serializeTask(task('PAY-5', { rank: 'r' }))));
  await a.push();
  await b.push();
  await a.pull();
  assert.ok(a.exists(taskFile('PAY-5')) && b.exists(taskFile('PAY-3')));
  assert.equal(await a.unpushed(), 0);
  assert.equal(await b.unpushed(), 0);
  // разные поля одной задачи: alice — статус, bob — исполнитель
  await a.write('PAY-1: статус', (r) => r.writeFile(taskFile('PAY-1'), serializeTask({ ...readTask(r, 'PAY-1'), status: 'in_progress' })));
  await b.write('PAY-1: исполнитель', (r) => r.writeFile(taskFile('PAY-1'), serializeTask({ ...readTask(r, 'PAY-1'), assignee: 'bob@example.com' })));
  await a.push();
  await b.push();
  const merged = readTask(b, 'PAY-1');
  assert.equal(merged.error, undefined);
  assert.equal(merged.status, 'in_progress');
  assert.equal(merged.assignee, 'bob@example.com');
  assert.equal(await b.unpushed(), 0);
  assert.deepEqual(b.local().conflicts, []);
  // слияние — один коммит с темой моего коммита, без маркеров конфликта в рабочей копии
  assert.equal(git(bare, 'log', '-1', '--format=%s', 'main'), 'PAY-1: исполнитель');
  assert.equal(git(b.repoDir, 'status', '--porcelain'), '');
  await a.pull();
  assert.equal(readTask(a, 'PAY-1').assignee, 'bob@example.com');
  // одно поле с разными значениями: у bob остаётся значение команды (alice), его — в конфликты
  await a.write('PAY-2: оценка 3', (r) => r.writeFile(taskFile('PAY-2'), serializeTask({ ...readTask(r, 'PAY-2'), estimate: 3 })));
  await b.write('PAY-2: оценка 5', (r) => r.writeFile(taskFile('PAY-2'), serializeTask({ ...readTask(r, 'PAY-2'), estimate: 5 })));
  await a.push();
  await b.push();
  assert.equal(readTask(b, 'PAY-2').estimate, 3);
  const c = b.local().conflicts;
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'field');
  assert.equal(c[0].field, 'estimate');
  assert.equal(c[0].task, 'PAY-2');
  assert.equal(c[0].project, 'p');
  assert.equal(c[0].ours, 5);
  assert.equal(c[0].theirs, 3);
  assert.equal(c[0].theirsBy, 'alice@example.com');
  assert.equal((await b.syncState()).state, 'conflict');
  await a.pull();
  assert.equal(readTask(a, 'PAY-2').estimate, 3);
  b.saveLocal((l) => (l.conflicts = []));
});

test('два клона: updatedAt и updatedBy сливаются без конфликта — более поздняя метка; конфликт только по настоящему полю', async () => {
  await a.pull();
  await b.pull();
  const stamp = (r: TeamRepo, id: string, patch: Partial<TaskFile>, at: string, by: string) =>
    r.write(`${id}: правка`, (x) => x.writeFile(taskFile(id), serializeTask({ ...readTask(x, id), ...patch, updatedAt: at, updatedBy: by })));
  // разные поля, у обоих своя метка в одной строке frontmatter: rebase конфликтует, слияние по полям — без конфликтов
  await stamp(a, 'PAY-3', { status: 'review' }, '2026-11-12T10:00:00.000Z', 'alice@example.com');
  await stamp(b, 'PAY-3', { assignee: 'bob@example.com' }, '2026-11-12T10:00:00.100Z', 'bob@example.com');
  await a.push();
  await b.push();
  let t = readTask(b, 'PAY-3');
  assert.deepEqual([t.status, t.assignee, t.updatedAt, t.updatedBy], ['review', 'bob@example.com', '2026-11-12T10:00:00.100Z', 'bob@example.com']);
  assert.deepEqual(b.local().conflicts, []);
  await a.pull();
  // одно поле по-разному, метка bob позже: у bob один конфликт estimate, метка его
  await stamp(a, 'PAY-3', { estimate: 3 }, '2026-11-12T11:00:00.000Z', 'alice@example.com');
  await stamp(b, 'PAY-3', { estimate: 8 }, '2026-11-12T11:00:00.100Z', 'bob@example.com');
  await a.push();
  await b.push();
  t = readTask(b, 'PAY-3');
  assert.deepEqual([t.estimate, t.updatedAt, t.updatedBy], [3, '2026-11-12T11:00:00.100Z', 'bob@example.com']);
  assert.deepEqual(b.local().conflicts.map((c) => [c.kind, c.field, c.ours, c.theirs]), [['field', 'estimate', 8, 3]]);
  assert.equal(git(b.repoDir, 'status', '--porcelain'), '');
  b.saveLocal((l) => (l.conflicts = []));
  await a.pull();
});

test('два клона: текст документа — версия команды, моя версия сохранена в конфликте; разные разделы сливаются git', async () => {
  const doc = 'projects/p/prd.md';
  await a.write('p: ТЗ', (r) => r.writeFile(doc, '# ТЗ\n\n## Цель\n\nЦель.\n\n## Требования\n\n- FR-1. Один\n'));
  await a.push();
  await b.pull();
  // разные разделы — сливаются обычным rebase
  await a.write('p: цель', (r) => r.writeFile(doc, r.read(doc)!.replace('Цель.', 'Новая цель.')));
  await b.write('p: требования', (r) => r.writeFile(doc, r.read(doc)!.replace('- FR-1. Один\n', '- FR-1. Один\n- FR-2. Два\n')));
  await a.push();
  await b.push();
  assert.match(b.read(doc)!, /Новая цель\.[\s\S]*FR-2\. Два/);
  assert.deepEqual(b.local().conflicts, []);
  // одно и то же место — версия команды, моя в конфликте
  await a.pull();
  await a.write('p: цель 2', (r) => r.writeFile(doc, r.read(doc)!.replace('Новая цель.', 'Цель от alice.')));
  await b.write('p: цель 3', (r) => r.writeFile(doc, r.read(doc)!.replace('Новая цель.', 'Цель от bob.')));
  await a.push();
  await b.push();
  assert.match(b.read(doc)!, /Цель от alice\./);
  assert.doesNotMatch(b.read(doc)!, /<<<<<<<|>>>>>>>/);
  const c = b.local().conflicts;
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'text');
  assert.equal(c[0].doc, 'prd');
  assert.match(String(c[0].ours), /Цель от bob\./);
  assert.match(String(c[0].theirs), /Цель от alice\./);
  assert.equal(await b.unpushed(), 0);
  b.saveLocal((l) => (l.conflicts = []));
  // тело задачи с двух сторон: поля сливаются, тело — команды, конфликт body
  await a.pull();
  await a.write('PAY-3: описание', (r) => r.writeFile(taskFile('PAY-3'), serializeTask({ ...readTask(r, 'PAY-3'), body: '## Описание\n\nот alice\n' })));
  await b.write('PAY-3: описание и оценка', (r) => r.writeFile(taskFile('PAY-3'), serializeTask({ ...readTask(r, 'PAY-3'), estimate: 8, body: '## Описание\n\nот bob\n' })));
  await a.push();
  await b.push();
  const t3 = readTask(b, 'PAY-3');
  assert.equal(t3.estimate, 8);
  assert.match(t3.body, /от alice/);
  assert.deepEqual(b.local().conflicts.map((x) => [x.kind, x.field, x.task]), [['text', 'body', 'PAY-3']]);
  b.saveLocal((l) => (l.conflicts = []));
});

test('совпадение номеров: одинаковый номер у двух клонов — переименовывается своя неотправленная задача, её blockedBy у соседей по пачке тоже', async () => {
  await a.pull();
  await b.pull();
  await a.write('PAY-6: создана', (r) => r.writeFile(taskFile('PAY-6'), serializeTask(task('PAY-6', { rank: 's', title: 'от alice' }))));
  await b.write('PAY-6: создана', (r) => {
    r.writeFile(taskFile('PAY-6'), serializeTask(task('PAY-6', { rank: 't', title: 'от bob' })));
    r.writeFile(taskFile('PAY-7'), serializeTask(task('PAY-7', { rank: 'u', blockedBy: ['PAY-6'] })));
  });
  b.saveLocal((l) => (l.work['PAY-6'] = [{ kind: 'run', id: 'r1', at: 'x' }]));
  await a.push();
  await b.push();
  assert.equal(readTask(b, 'PAY-6').title, 'от alice');
  assert.equal(readTask(b, 'PAY-8').title, 'от bob');
  assert.deepEqual(readTask(b, 'PAY-7').blockedBy, ['PAY-8']);
  assert.ok(b.local().work['PAY-8']);
  assert.equal(b.local().work['PAY-6'], undefined);
  assert.deepEqual(b.local().conflicts, []);
  assert.match(git(bare, 'log', '-1', '--format=%s%n%b', 'main'), /PAY-6 → PAY-8: номер уже занят/);
  await a.pull();
  assert.ok(a.exists(taskFile('PAY-8')));
});

test('удалено с одной стороны, изменено с другой — как у команды, моё в конфликт deleted', async () => {
  await a.write('PAY-5: удалена', (r) => r.remove(taskFile('PAY-5')));
  await b.write('PAY-5: статус', (r) => r.writeFile(taskFile('PAY-5'), serializeTask({ ...readTask(r, 'PAY-5'), status: 'done' })));
  await a.push();
  await b.push();
  assert.equal(b.exists(taskFile('PAY-5')), false);
  assert.deepEqual(b.local().conflicts.map((c) => [c.kind, c.task, c.theirs]), [['deleted', 'PAY-5', null]]);
  b.saveLocal((l) => (l.conflicts = []));
});

test('не-ASCII имя файла: перепроигрывание не теряет мой документ, событие знает проект', async () => {
  await a.pull();
  await b.pull();
  const doc = 'projects/p/docs/Заметки встречи.md';
  const seen: string[][] = [];
  const off = a.onChange((e) => seen.push(e.projects));
  await a.write('p: заметки', (r) => r.writeFile(doc, '# Заметки\n'));
  off();
  assert.deepEqual(seen, [['p']]);
  // конфликт по полю рядом, чтобы rebase откатился и пошло перепроигрывание
  await a.write('PAY-1: оценка 1', (r) => r.writeFile(taskFile('PAY-1'), serializeTask({ ...readTask(r, 'PAY-1'), estimate: 1 })));
  await b.write('PAY-1: оценка 4', (r) => r.writeFile(taskFile('PAY-1'), serializeTask({ ...readTask(r, 'PAY-1'), estimate: 4 })));
  await b.push();
  await a.push();
  assert.equal(a.read(doc), '# Заметки\n');
  assert.equal(readTask(a, 'PAY-1').estimate, 4);
  assert.deepEqual(a.local().conflicts.map((c) => [c.kind, c.field, c.ours]), [['field', 'estimate', 1]]);
  a.saveLocal((l) => (l.conflicts = []));
  await b.pull();
  assert.equal(b.read(doc), '# Заметки\n');
  assert.ok(git(bare, 'ls-tree', '-r', '--name-only', 'main').includes(doc));
});

test('совпадение номеров между проектами после чистого rebase: моя неотправленная задача получает свободный номер', async () => {
  await a.pull();
  await b.pull();
  await a.write('PAY-9: создана в p', (r) => r.writeFile(taskFile('PAY-9'), serializeTask(task('PAY-9', { rank: 'w', title: 'в p' }))));
  await b.write('PAY-9: создана в q', (r) => {
    r.writeFile('projects/q/tasks/PAY-9.md', serializeTask({ ...task('PAY-9', { rank: 'w', title: 'в q' }), file: 'projects/q/tasks/PAY-9.md' }));
    r.writeFile('projects/q/tasks/PAY-10.md', serializeTask({ ...task('PAY-10', { rank: 'x', blockedBy: ['PAY-9'] }), file: 'projects/q/tasks/PAY-10.md' }));
  });
  await a.push();
  await b.push();
  assert.equal(readTask(b, 'PAY-9').title, 'в p');
  assert.equal(b.exists('projects/q/tasks/PAY-9.md'), false);
  const renamed = parseTask(b.read('projects/q/tasks/PAY-11.md') ?? '', 'projects/q/tasks/PAY-11.md');
  assert.equal(renamed.title, 'в q');
  assert.equal(renamed.error, undefined);
  assert.deepEqual(parseTask(b.read('projects/q/tasks/PAY-10.md') ?? '', 'projects/q/tasks/PAY-10.md').blockedBy, ['PAY-11']);
  assert.equal(await b.unpushed(), 0);
  await a.pull();
  assert.ok(a.exists('projects/q/tasks/PAY-11.md'));
});

test('ссылка в репо команды становится обычным файлом (core.symlinks=false); путь через ссылку внутри клона отклоняется', async () => {
  const work = path.join(tmp, 'work-symlink');
  git(tmp, 'clone', '-q', bare, work);
  fs.mkdirSync(path.join(work, 'projects', 'p', 'docs'), { recursive: true });
  fs.symlinkSync('/etc/hosts', path.join(work, 'projects', 'p', 'docs', 'link.md'));
  git(work, '-c', 'user.name=x', '-c', 'user.email=x@x', 'add', '.');
  git(work, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'ссылка');
  git(work, 'push', '-q', 'origin', 'main');
  await a.pull();
  const st = fs.lstatSync(path.join(a.repoDir, 'projects', 'p', 'docs', 'link.md'));
  assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.equal(a.read('projects/p/docs/link.md'), '/etc/hosts');
  fs.symlinkSync(tmp, path.join(a.repoDir, 'outside'));
  assert.throws(() => a.writeFile('outside/x.md', 'x'), /за пределы/);
  assert.throws(() => a.abs('../x'), /вне репо/);
  fs.unlinkSync(path.join(a.repoDir, 'outside'));
  await a.write('p: ссылка убрана', (r) => r.remove('projects/p/docs/link.md'));
  await a.push();
});

test('коммит не удался (подпись без ключа): рабочая копия откатывается к HEAD, следующая запись проходит', async () => {
  git(a.repoDir, 'config', 'commit.gpgsign', 'true');
  git(a.repoDir, 'config', 'gpg.program', '/nonexistent/gpg');
  await assert.rejects(
    a.write('PAY-1: тип', (r) => r.writeFile(taskFile('PAY-1'), serializeTask({ ...readTask(r, 'PAY-1'), type: 'bug' }))),
    (e: TeamError) => e.status === 500 && /Коммит в репо команды не удался/.test(e.message),
  );
  assert.equal(git(a.repoDir, 'status', '--porcelain'), '');
  assert.equal(readTask(a, 'PAY-1').type, 'feature');
  git(a.repoDir, 'config', '--unset', 'commit.gpgsign');
  git(a.repoDir, 'config', '--unset', 'gpg.program');
  await a.write('PAY-1: тип', (r) => r.writeFile(taskFile('PAY-1'), serializeTask({ ...readTask(r, 'PAY-1'), type: 'bug' })));
  assert.equal(readTask(a, 'PAY-1').type, 'bug');
  await a.push();
});

test('правки руками в клоне коммитятся перед pull отдельным коммитом', async () => {
  await a.pull();
  fs.writeFileSync(path.join(a.repoDir, 'projects', 'p', 'notes.md'), 'руками');
  await a.pull();
  assert.equal(git(a.repoDir, 'log', '-1', '--format=%s'), 'Правки в папке команды');
  assert.equal(git(a.repoDir, 'status', '--porcelain'), '');
  await a.push();
  assert.equal(await a.unpushed(), 0);
});

test('нет сети: коммиты ждут, ошибка в строке синхронизации, повтор отправляет', async () => {
  const hidden = `${bare}.hidden`;
  fs.renameSync(bare, hidden);
  await a.write('PAY-1: оценка', (r) => r.writeFile(taskFile('PAY-1'), serializeTask({ ...readTask(r, 'PAY-1'), estimate: 2 })));
  await assert.rejects(a.push());
  let st = await a.syncState();
  assert.equal(st.state, 'pending');
  assert.equal(st.unpushed, 1);
  assert.ok(st.error);
  fs.renameSync(hidden, bare);
  await a.push();
  st = await a.syncState();
  assert.equal(st.state, 'ok');
  assert.equal(st.unpushed, 0);
  assert.equal(st.error, undefined);
  assert.equal(git(bare, 'log', '-1', '--format=%s', 'main'), 'PAY-1: оценка');
});

test('событие team после отправки: одно на push, с проектами из fetch; без изменений — нет; ошибка сети и её снятие — событие', async () => {
  await a.pull();
  await b.pull();
  const seen: ChangeEvent[] = [];
  const off = a.onChange((e) => seen.push(e));
  const estimate = (r: TeamRepo, id: string, n: number) => r.write(`${id}: оценка ${n}`, (x) => x.writeFile(taskFile(id), serializeTask({ ...readTask(x, id), estimate: n })));
  await estimate(a, 'PAY-3', 4);
  assert.deepEqual(seen, [{ team: 'team', projects: ['p'] }]);
  // мои коммиты ушли, нового с сервера нет — одно событие без проектов: сменилась только строка синхронизации
  seen.length = 0;
  await a.push();
  assert.deepEqual(seen, [{ team: 'team', projects: [] }]);
  // нечего отправлять и нечего получать — тишина
  seen.length = 0;
  await a.push();
  await a.pull();
  assert.deepEqual(seen, []);
  // fetch принёс задачу bob, и мои ушли — всё равно одно событие, с проектом
  await estimate(b, 'PAY-2', 2);
  await b.push();
  await estimate(a, 'PAY-3', 6);
  seen.length = 0;
  await a.push();
  assert.deepEqual(seen, [{ team: 'team', projects: ['p'] }]);
  // нет сети: первая ошибка — событие, та же ошибка при повторе — нет, отправка после восстановления — событие
  const hidden = `${bare}.hidden`;
  fs.renameSync(bare, hidden);
  try {
    await estimate(a, 'PAY-3', 7);
    seen.length = 0;
    await assert.rejects(a.push());
    assert.equal(seen.length, 1);
    await assert.rejects(a.push());
    assert.equal(seen.length, 1);
  } finally {
    fs.renameSync(hidden, bare);
  }
  await a.push();
  assert.equal(seen.length, 2);
  assert.equal((await a.syncState()).state, 'ok');
  off();
  await b.pull();
});

test('ошибка сети с меняющимся текстом: событие только когда ошибка появилась и когда снялась', async () => {
  let n = 0;
  let offline = true;
  const x: Exec = (cmd, args, opts) =>
    offline && args.includes('fetch') ? Promise.reject(new Error(`Failed to connect to github.com port 443 after ${++n} ms`)) : alice.deps.exec(cmd, args, opts);
  const r = track(TeamRepo.open(a.slug, { ...alice.deps, exec: x }, alice.root)!);
  const seen: ChangeEvent[] = [];
  r.onChange((e) => seen.push(e));
  // иначе: событие → GET команды → фоновый pull → новый текст ошибки → событие, и так по кругу
  for (let i = 0; i < 3; i++) await assert.rejects(r.pull());
  assert.equal(seen.length, 1);
  assert.match(r.local().sync.error ?? '', /after 3 ms/);
  offline = false;
  await r.push();
  assert.deepEqual(seen, [{ team: 'team', projects: [] }, { team: 'team', projects: [] }]);
  assert.equal(r.local().sync.error, null);
});

test('получение без отправки снимает ошибку синхронизации, только если отправлять нечего', async () => {
  let offline = false;
  const x: Exec = (cmd, args, opts) => (offline && args.includes('fetch') ? Promise.reject(new Error('Could not resolve host: github.com')) : alice.deps.exec(cmd, args, opts));
  const r = track(TeamRepo.open(a.slug, { ...alice.deps, exec: x }, alice.root)!);
  await r.pull();
  offline = true;
  await assert.rejects(r.pull());
  assert.match(r.local().sync.error ?? '', /resolve host/);
  // сеть вернулась, отправлять нечего: открытие экрана (pull) снимает старую причину — строка снова «синхронизировано»
  offline = false;
  await r.pull();
  assert.equal(r.local().sync.error, null);
  assert.equal((await r.syncState()).state, 'ok');
  // есть неотправленный коммит: получение без отправки ошибку не снимает — отправка ещё не удалась
  offline = true;
  await r.write('PAY-3: оценка 9', (t) => t.writeFile(taskFile('PAY-3'), serializeTask({ ...readTask(t, 'PAY-3'), estimate: 9 })));
  await assert.rejects(r.pull());
  offline = false;
  await r.pull();
  assert.match(r.local().sync.error ?? '', /resolve host/);
  await r.push();
  assert.equal(r.local().sync.error, null);
  await b.pull();
});

test('два активных спринта после одновременного запуска: активным остаётся более ранний, второй снова запланирован', async () => {
  await a.pull();
  await b.pull();
  await a.write('p: спринт 1 запущен', (r) => r.writeFile('projects/p/sprints/1.yaml', 'number: 1\ntitle: Спринт 1\nstatus: active\nstartedAt: 2026-11-12T10:00:00Z\nstartedBy: alice@example.com\n'));
  await b.write('p: спринт 2 запущен', (r) => r.writeFile('projects/p/sprints/2.yaml', 'number: 2\ntitle: Спринт 2\nstatus: active\nstartedAt: 2026-11-12T10:05:00Z\nstartedBy: bob@example.com\n'));
  await a.push();
  await b.push();
  assert.match(b.read('projects/p/sprints/1.yaml')!, /status: active/);
  const s2 = b.read('projects/p/sprints/2.yaml')!;
  assert.match(s2, /status: planned/);
  assert.doesNotMatch(s2, /startedAt/);
  assert.deepEqual(b.local().conflicts.map((c) => [c.kind, c.project, c.ours, c.theirs]), [['sprint', 'p', 2, 1]]);
  await a.pull();
  assert.match(a.read('projects/p/sprints/2.yaml')!, /status: planned/);
  b.saveLocal((l) => (l.conflicts = []));
});

test('формат новее — только чтение: запись отвечает 409 readonly, строка синхронизации readonly, pull работает', async () => {
  await a.write('формат 2', (r) => r.writeFile('teamwork.yaml', r.read('teamwork.yaml')!.replace(/^format: 1/m, 'format: 2')));
  await a.push();
  await b.pull();
  assert.equal(b.readonly(), true);
  assert.equal((await b.syncState()).state, 'readonly');
  await assert.rejects(b.write('x', (r) => r.writeFile('x.md', 'x')), (e: TeamError) => e.status === 409 && e.code === 'readonly');
  // alice теперь тоже только читает: формат возвращается правкой руками, которую push коммитит сам
  await assert.rejects(a.write('x', (r) => r.writeFile('x.md', 'x')), (e: TeamError) => e.code === 'readonly');
  fs.writeFileSync(path.join(a.repoDir, 'teamwork.yaml'), a.read('teamwork.yaml')!.replace(/^format: 2/m, 'format: 1'));
  await a.push();
  assert.equal(git(bare, 'log', '-1', '--format=%s', 'main'), 'Правки в папке команды');
  await b.pull();
  assert.equal(b.readonly(), false);
});

test('история: последние коммиты по файлу с автором и временем', async () => {
  const h = await a.history({ path: taskFile('PAY-1'), limit: 2 });
  assert.equal(h.length, 2);
  assert.equal(h[0].message, 'PAY-1: оценка');
  assert.equal(h[0].email, 'alice@example.com');
  assert.match(h[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok((await a.history()).length > 5);
});

test('отключение: с неотправленными изменениями — 409 unpushed со списком, с force — клон удалён', async () => {
  await b.write('PAY-7: статус', (r) => r.writeFile(taskFile('PAY-7'), serializeTask({ ...readTask(r, 'PAY-7'), status: 'review' })));
  await assert.rejects(b.disconnect(false), (e: TeamError) => e.status === 409 && e.code === 'unpushed' && e.extra?.unpushed === 1 && JSON.stringify(e.extra.commits) === '["PAY-7: статус"]');
  assert.ok(fs.existsSync(b.repoDir));
  await b.disconnect(true);
  assert.equal(fs.existsSync(b.dir), false);
  assert.deepEqual(TeamRepo.list(bob.root), []);
  // мусор в папке команд — не команда
  fs.mkdirSync(path.join(bob.root, 'junk'));
  assert.deepEqual(TeamRepo.list(bob.root), []);
  assert.equal(parseTask(composeTask({ id: 'PAY-1', title: 't' }, ''), 'PAY-1.md').error, undefined);
});
