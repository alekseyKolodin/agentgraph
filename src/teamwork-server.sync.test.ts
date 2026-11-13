// Сервис команды на двух настоящих клонах после финального ревью (docs/teamwork/notes/final-review.md): сервис у «alice» и
// «bob», общий временный bare-репо, без сети. Настройки и репо проекта правятся по элементам с неизвестными полями (D-9) и
// с base не затирают чужих правок (D-10); «взять моё» у списка (D-3) и у поля спринта (D-13); перенос между соседями с
// одним rank (D-12); slug проекта — по папке (S-5); ссылка без токена (S-8); конец запуска переименованной задачи (D-14).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { exec, type Exec } from './git.js';
import { defaultRepoDeps, TeamError } from './teamwork-repo.js';
import { TeamService, teamworkRoute } from './teamwork-server.js';
import { statusService, TeamworkStatus } from './teamwork-status.js';
import { sessionTeamwork } from './teamwork-work.js';
import type { TeamDetail } from './api-types.js';
import { serializeTask, type TaskFile } from './teamwork.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-tw-svc-sync-')));
const bare = path.join(tmp, 'team.git');
const T = 'team';

function actor(name: string): TeamService {
  const cfg = path.join(tmp, `${name}.gitconfig`);
  fs.writeFileSync(cfg, `[user]\n\tname = ${name}\n\temail = ${name}@example.com\n[init]\n\tdefaultBranch = main\n`);
  const x: Exec = (cmd, args, opts = {}) => exec(cmd, args, { ...opts, env: { ...opts.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg } });
  const root = path.join(tmp, name, 'teams');
  fs.mkdirSync(root, { recursive: true });
  // папки репо кода не ищем среди проектов дашборда: тест не читает настоящие настройки agentgraph
  return new TeamService({ root: () => root, timers: false, findLocal: async () => undefined, repo: { ...defaultRepoDeps(), exec: x, tmpDir: tmp, retryMinMs: 3_600_000, retryMaxMs: 3_600_000 } });
}

const alice = actor('alice');
const bob = actor('bob');
const carol = actor('carol');
const frank = actor('frank');

const sync = async (svc: TeamService) => {
  const s = await svc.sync(T);
  assert.equal(s.error ?? null, null);
};
const remoteYaml = (file: string) => parseYaml(execFileSync('git', ['--git-dir', bare, 'show', `main:${file}`], { encoding: 'utf8' })) as Record<string, unknown>;
const raw = (svc: TeamService, file: string) => parseYaml(svc.repo(T).read(file) ?? '') as Record<string, unknown>;
/** Правка YAML-файла клона руками и коммит через очередь, как это сделала бы новая версия agentgraph. */
const editYaml = (svc: TeamService, file: string, edit: (text: string) => string) => svc.repo(T).write(`${file}: руками`, (r) => r.writeFile(file, edit(r.read(file) ?? '')));

before(async () => {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  await alice.createTeam({ url: bare, title: 'Платёжная', prefix: 'PAY' });
  await alice.createProject(T, { slug: 'p', title: 'Проект P', repos: [{ key: 'billing', url: 'git@github.com:acme/billing.git' }] });
  await sync(alice);
  await bob.joinTeam({ url: bare });
  await sync(alice);
});

after(async () => {
  await alice.stop();
  await bob.stop();
  await carol.stop();
  await frank.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('D-9: неизвестные поля участников переживают подключение нового участника и правку настроек', async () => {
  // поле новой версии agentgraph у участника и неизвестная колонка
  await editYaml(alice, 'teamwork.yaml', (t) => t.replace(/(  - name: alice\n    email: alice@example.com\n)/, '$1    role: lead\n').replace(/(columns:\n)/, '$1  blocked: Ждёт\n'));
  await sync(alice);
  await carol.joinTeam({ url: bare });
  const members = remoteYaml('teamwork.yaml').members as Record<string, unknown>[];
  assert.deepEqual(members.map((m) => m.email), ['alice@example.com', 'bob@example.com', 'carol@example.com']);
  assert.equal(members[0].role, 'lead');
  await sync(alice);
  // правка настроек (старый клиент: весь список, без base) — role и неизвестная колонка на месте
  await alice.updateTeam(T, { members: [{ name: 'Алиса', email: 'alice@example.com' }, { name: 'bob', email: 'bob@example.com', github: 'bobgh' }, { name: 'carol', email: 'carol@example.com' }], columns: { todo: 'Сделать' } });
  const cfg = raw(alice, 'teamwork.yaml');
  const list = cfg.members as Record<string, unknown>[];
  assert.deepEqual([list[0].name, list[0].role, list[1].github], ['Алиса', 'lead', 'bobgh']);
  assert.deepEqual(cfg.columns, { blocked: 'Ждёт', todo: 'Сделать', in_progress: 'В работе', review: 'Ревью', done: 'Готово' });
  await sync(alice);
  await sync(bob);
  await sync(carol);
});

test('D-10: настройки с устаревшим base — участник, пришедший после открытия формы, не удаляется, правка другого поля не откатывается', async () => {
  const form = await bob.team(T); // bob открыл настройки
  // тем временем alice переименовала команду, а dave подключился
  await alice.updateTeam(T, { title: 'Платежи' });
  await alice.updateTeam(T, { members: [...(await alice.team(T)).memberList, { name: 'dave', email: 'dave@example.com' }], base: (await alice.team(T)).base });
  await sync(alice);
  await sync(bob);
  // bob сохраняет форму целиком, как она была открыта, только со своим github
  const mine = form.memberList.map((m) => (m.email === 'bob@example.com' ? { ...m, github: 'bob2' } : m));
  await bob.updateTeam(T, { title: form.title, members: mine, columns: form.columns, base: form.base });
  const cfg = raw(bob, 'teamwork.yaml');
  assert.equal(cfg.title, 'Платежи');
  const list = cfg.members as Record<string, unknown>[];
  assert.deepEqual(list.map((m) => m.email), ['alice@example.com', 'bob@example.com', 'carol@example.com', 'dave@example.com']);
  assert.equal(list[1].github, 'bob2');
  assert.equal(list[0].role, 'lead');
  await sync(bob);
  await sync(alice);
  // одно место изменено по-разному — 409 conflict с текущим видом, ничего не записано
  const stale = await bob.team(T);
  await alice.updateTeam(T, { title: 'Платежи и счета' });
  await sync(alice);
  await sync(bob);
  await assert.rejects(bob.updateTeam(T, { title: 'Касса', base: stale.base }), (e: TeamError) => e.status === 409 && e.code === 'conflict' && (e.extra?.current as { title?: string })?.title === 'Платежи и счета');
  assert.equal(raw(bob, 'teamwork.yaml').title, 'Платежи и счета');
  // base, которого нет в истории, — тоже 409
  await assert.rejects(bob.updateTeam(T, { title: 'Касса', base: '0000000000000000' }), (e: TeamError) => e.status === 409);
});

test('D-9, D-10: репо кода проекта — неизвестные поля элемента остаются, репо коллеги не пропадает при сохранении устаревшей формы', async () => {
  await editYaml(alice, 'projects/p/project.yaml', (t) => t.replace(/(    defaultBranch: main\n|    url: git@github.com:acme\/billing.git\n)/, '$1    ci: true\n'));
  await sync(alice);
  await sync(bob);
  const form = await bob.project(T, 'p');
  await alice.updateProject(T, 'p', { repos: [...(await alice.project(T, 'p')).repos.map((r) => ({ key: r.key, url: r.url })), { key: 'web', url: 'git@github.com:acme/web.git' }], base: (await alice.project(T, 'p')).base });
  await sync(alice);
  await sync(bob);
  await bob.updateProject(T, 'p', { summary: 'Суть от bob', repos: form.repos.map((r) => ({ key: r.key, url: r.url, defaultBranch: 'develop' })), base: form.base });
  const p = raw(bob, 'projects/p/project.yaml');
  assert.equal(p.summary, 'Суть от bob');
  const repos = p.repos as Record<string, unknown>[];
  assert.deepEqual(repos.map((r) => [r.key, r.defaultBranch ?? null, r.ci ?? null]), [['billing', 'develop', true], ['web', null, null]]);
  // старый клиент без base: весь список — элемент сохраняет неизвестное поле
  await bob.updateProject(T, 'p', { repos: [{ key: 'billing', url: 'git@github.com:acme/billing.git' }] });
  assert.deepEqual((raw(bob, 'projects/p/project.yaml').repos as Record<string, unknown>[]).map((r) => [r.key, r.ci ?? null]), [['billing', true]]);
  await sync(bob);
  await sync(alice);
});

test('D-9: неизвестный ключ lastRequirement переживает запись ТЗ', async () => {
  await editYaml(alice, 'projects/p/project.yaml', (t) => `${t.trimEnd()}\nlastRequirement:\n  FR: 2\n  UX: 7\n`);
  await alice.writeDoc(T, 'p', 'prd', '# ТЗ\n\n## Требования\n\n- FR-3. Выгрузка\n');
  assert.deepEqual(raw(alice, 'projects/p/project.yaml').lastRequirement, { FR: 3, NFR: 0, UX: 7 });
  await sync(alice);
  await sync(bob);
});

test('D-12: перенос между соседями с одним rank — задача встаёт рядом с ними, а не в конец списка', async () => {
  const repo = alice.repo(T);
  const t = (id: string, rank: string): TaskFile => ({ id, title: id, type: 'feature', status: 'todo', rank, blockedBy: [], covers: [], body: '', acceptance: { done: 0, total: 0 }, comments: 0, base: '', file: `projects/p/tasks/${id}.md`, extra: {} });
  await repo.write('задачи с одним rank', (r) => {
    for (const [id, rank] of [['PAY-1', 'l'], ['PAY-2', 'l'], ['PAY-3', 'p'], ['PAY-4', 's'], ['PAY-5', 'x']] as const) r.writeFile(`projects/p/tasks/${id}.md`, serializeTask(t(id, rank)));
  });
  const moved = await alice.moveTask(T, 'p', 'PAY-5', { after: 'PAY-1', before: 'PAY-2' });
  assert.ok(moved.rank > 'l' && moved.rank < 'p', `rank ${moved.rank}`);
  assert.deepEqual(alice.tasks(T, 'p').map((x) => x.id), ['PAY-1', 'PAY-2', 'PAY-5', 'PAY-3', 'PAY-4']);
  // соседи наоборот (одновременные переносы): после after, до ближайшего большего
  const back = await alice.moveTask(T, 'p', 'PAY-5', { after: 'PAY-3', before: 'PAY-1' });
  assert.ok(back.rank > 'p' && back.rank < 's', `rank ${back.rank}`);
  await sync(alice);
  await sync(bob);
});

test('D-3: один участник изменён по-разному — конфликт только по нему; «взять моё» берёт мою версию участника и не трогает остальных', async () => {
  const members = async (svc: TeamService) => (await svc.team(T)).memberList;
  const withGh = (list: Awaited<ReturnType<typeof members>>, gh: string) => list.map((m) => (m.email === 'carol@example.com' ? { ...m, github: gh } : m));
  await alice.updateTeam(T, { members: withGh(await members(alice), 'carol-a'), base: (await alice.team(T)).base });
  await bob.updateTeam(T, { members: withGh(await members(bob), 'carol-b'), base: (await bob.team(T)).base });
  await sync(alice);
  await sync(bob);
  const [c] = bob.conflicts(T);
  assert.deepEqual([c?.kind, c?.field], ['field', 'members']);
  const ghOf = (list: unknown, email: string) => (list as Record<string, unknown>[]).find((m) => m.email === email)?.github;
  assert.equal(ghOf(raw(bob, 'teamwork.yaml').members, 'carol@example.com'), 'carol-a');
  // пока конфликт не решён, alice добавила eve — «взять моё» её не уберёт
  await alice.updateTeam(T, { members: [...(await members(alice)), { name: 'eve', email: 'eve@example.com' }], base: (await alice.team(T)).base });
  await sync(alice);
  await sync(bob);
  await bob.resolveConflict(T, c!.id, 'mine');
  const after = raw(bob, 'teamwork.yaml').members as Record<string, unknown>[];
  assert.equal(ghOf(after, 'carol@example.com'), 'carol-b');
  assert.ok(after.some((m) => m.email === 'eve@example.com'));
  assert.equal(after.find((m) => m.email === 'alice@example.com')?.role, 'lead');
  await sync(bob);
  await sync(alice);
});

test('D-13: «взять моё» у поля спринта записывает моё значение', async () => {
  const s = await alice.createSprint(T, 'p', { title: 'Спринт' });
  await sync(alice);
  await sync(bob);
  const file = `projects/p/sprints/${s.number}.yaml`;
  await editYaml(alice, file, (t) => t.replace('title: Спринт', 'title: A'));
  await editYaml(bob, file, (t) => t.replace('title: Спринт', 'title: B'));
  await sync(alice);
  await sync(bob);
  const c = bob.conflicts(T).find((x) => x.file === file);
  assert.deepEqual([c?.kind, c?.field], ['field', 'title']);
  await bob.resolveConflict(T, c!.id, 'mine');
  assert.equal(raw(bob, file).title, 'B');
  await sync(bob);
  await sync(alice);
});

test('S-5: slug проекта — по имени папки: скопированная папка не отдаёт данные исходного проекта', async () => {
  const repo = alice.repo(T);
  await repo.write('копия проекта руками', (r) => r.writeFile('projects/gamma/project.yaml', r.read('projects/p/project.yaml') ?? ''));
  const g = await alice.project(T, 'gamma');
  assert.equal(g.slug, 'gamma');
  assert.equal(g.dir, repo.abs('projects/gamma'));
  assert.deepEqual(g.docs, []);
  assert.ok(alice.listProjects(T).some((x) => x.slug === 'gamma'));
  await sync(alice);
});

test('S-8: ссылка на репо команды в ответах API — без логина и токена', async () => {
  const repo = bob.repo(T);
  const remote = repo.local().remote;
  repo.saveLocal((l) => (l.remote = 'https://bob:ghp_secret@github.com/acme/team.git'));
  try {
    assert.equal((await bob.team(T)).remote, 'https://github.com/acme/team.git');
    assert.ok((await bob.listTeams()).every((t) => !t.remote.includes('ghp_secret')));
  } finally {
    repo.saveLocal((l) => (l.remote = remote));
  }
  const check = await bob.check('https://bob:ghp_secret@127.0.0.1:9/team.git');
  assert.equal(check.kind, 'error');
  assert.doesNotMatch(check.kind === 'error' ? check.error : '', /ghp_secret/);
});

test('D-14: моя неотправленная задача переименована из-за совпавшего номера — конец запуска двигает её, а не чужую задачу со старым номером', async () => {
  const st = new TeamworkStatus({ service: statusService(bob), timers: false, log: () => {} });
  const [mine] = await bob.createTasks(T, 'p', [{ title: 'от bob' }]);
  await st.started({ team: T, project: 'p', task: mine.id }, { kind: 'run', id: 'run-1', status: 'running' });
  // alice в это время отправила свою задачу с тем же номером в другом проекте
  await alice.createProject(T, { slug: 'q', title: 'Проект Q' });
  const file = `projects/q/tasks/${mine.id}.md`;
  await alice.repo(T).write(`${mine.id}: в q`, (r) => r.writeFile(file, serializeTask({ id: mine.id, title: 'от alice', type: 'feature', status: 'todo', rank: 'V', blockedBy: [], covers: [], body: '', acceptance: { done: 0, total: 0 }, comments: 0, base: '', file, extra: {} })));
  await sync(alice);
  await sync(bob);
  const renamed = bob.tasks(T, 'p').find((x) => x.title === 'от bob')!;
  assert.notEqual(renamed.id, mine.id);
  assert.equal(renamed.status, 'in_progress');
  await st.ended({ team: T, project: 'p', task: mine.id }, { kind: 'run', id: 'run-1', status: 'done' });
  assert.equal(bob.task(T, 'p', renamed.id).status, 'review');
  assert.equal(bob.task(T, 'q', mine.id).status, 'todo');
  assert.equal(bob.repo(T).local().work[mine.id], undefined);
  assert.deepEqual(bob.repo(T).local().work[renamed.id]?.map((w) => w.status), ['done']);
});

test('D-14: сессия по моей задаче после переименования совпавшего номера — team_task_update и team_doc_write пишут в мою задачу, а не в чужую со старым номером', async () => {
  const st = new TeamworkStatus({ service: statusService(bob), timers: false, log: () => {} });
  const hooks = sessionTeamwork(bob, st);
  const [mine] = await bob.createTasks(T, 'p', [{ title: 'сессия bob' }]);
  const link = { team: T, project: 'p', task: mine.id };
  await hooks.started(link, { kind: 'session', id: 's-1', status: 'running' });
  // alice отправила свою задачу с тем же номером в том же проекте: старый номер в p теперь у неё
  const file = `projects/p/tasks/${mine.id}.md`;
  await alice.repo(T).write(`${mine.id}: от alice`, (r) => r.writeFile(file, serializeTask({ id: mine.id, title: 'чужая alice', type: 'feature', status: 'todo', rank: 'V', blockedBy: [], covers: [], body: '', acceptance: { done: 0, total: 0 }, comments: 0, base: '', file, extra: {} })));
  await sync(alice);
  // модель зовёт инструмент, пока идёт синхронизация, которая переименует задачу: номер ищется уже в очереди клона
  const pulling = bob.sync(T);
  const calling = hooks.updateTask(link, { status: 'review', comment: 'готово из сессии' }, 's-1');
  assert.equal((await pulling).error ?? null, null);
  const said = await calling;
  const renamed = bob.tasks(T, 'p').find((x) => x.title === 'сессия bob')!;
  assert.notEqual(renamed.id, mine.id);
  assert.match(said, new RegExp(`^Задача ${renamed.id}:`));
  // вопрос PreToolUse — о моей задаче под новым номером
  assert.match(hooks.label(link, 's-1'), new RegExp(`^${renamed.id} «сессия bob»`));
  assert.equal(bob.task(T, 'p', renamed.id).status, 'review');
  assert.deepEqual((await bob.comments(T, 'p', renamed.id)).map((c) => c.text.trim()), ['готово из сессии']);
  const theirs = bob.task(T, 'p', mine.id);
  assert.deepEqual([theirs.title, theirs.status, theirs.comments], ['чужая alice', 'todo', 0]);
  // документ — проекта; номер задачи в сообщении коммита — новый
  await hooks.writeDoc(link, 'docs/session.md', '# Из сессии\n', 's-1');
  assert.match(await bob.repo(T).git(['log', '-1', '--format=%s']), new RegExp(`по задаче ${renamed.id}$`, 'm'));
  // сессии нет в работе задач (задачу удалили, старт не записался) — отказ, а не запись в задачу со старым номером
  await assert.rejects(hooks.updateTask(link, { status: 'done' }, 's-unknown'), /больше нет среди работы этой сессии/);
  assert.equal(bob.task(T, 'p', mine.id).status, 'todo');
  await hooks.ended(link, { kind: 'session', id: 's-1', status: 'ended' });
  await sync(bob);
  await sync(alice);
});

test('«Добавить меня» — отдельный путь сервера: список участников не перезаписывается, повтор ничего не пишет', async () => {
  await frank.joinTeam({ url: bare, addMe: false });
  assert.equal((await frank.team(T)).me.inTeam, false);
  // экран frank загрузил список, а потом alice добавила участника и поправила другого; клон frank это уже получил
  await sync(alice);
  const before = (await alice.team(T)).memberList;
  await alice.updateTeam(T, { members: [...before.map((m) => (m.email === 'bob@example.com' ? { ...m, github: 'bob-new' } : m)), { name: 'erin', email: 'erin@example.com' }] });
  // у erin поле новой версии agentgraph (D-9)
  await editYaml(alice, 'teamwork.yaml', (t) => t.replace(/(    email: erin@example\.com\n)/, '$1    role: qa\n'));
  await sync(alice);
  await sync(frank);
  const r = await teamworkRoute('POST', new URL('http://127.0.0.1/api/teams/team/members/me'), async () => ({}), { service: frank });
  assert.equal(r?.status, 200);
  const detail = r!.body as TeamDetail;
  assert.equal(detail.me.inTeam, true);
  const emails = detail.memberList.map((m) => m.email);
  assert.deepEqual(emails.slice(-2), ['erin@example.com', 'frank@example.com']);
  assert.equal(detail.memberList.find((m) => m.email === 'bob@example.com')?.github, 'bob-new');
  // неизвестное поле участника из файла (D-9) на месте
  assert.equal((raw(frank, 'teamwork.yaml').members as Record<string, unknown>[]).find((m) => m.email === 'erin@example.com')?.role, 'qa');
  assert.equal(await frank.repo(T).unpushed(), 1);
  // повтор: уже участник — ни коммита, ни второй записи
  await frank.addMe(T);
  assert.equal(await frank.repo(T).unpushed(), 1);
  await sync(frank);
  const remote = (remoteYaml('teamwork.yaml').members as Record<string, unknown>[]).map((m) => m.email);
  assert.equal(remote.filter((e) => e === 'frank@example.com').length, 1);
  assert.ok(remote.includes('erin@example.com'));
});
