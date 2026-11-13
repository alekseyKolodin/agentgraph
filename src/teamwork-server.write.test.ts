// Записи сервиса команды на двух настоящих клонах: сервис у «alice» и «bob», у каждого своя папка команд и свой глобальный
// git config, общий временный bare-репо как origin, без сети. Номера задач (spec §5.7): номер удалённой задачи не
// возвращается (teamwork.yaml → lastTask), счётчик сливается как большее значение, совпавший номер переименовывается за
// счётчиком. Место новой задачи по after/before (§5.8). Номера требований ТЗ не повторяются при записи (§8.4).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, type Exec } from './git.js';
import { defaultRepoDeps } from './teamwork-repo.js';
import { TeamService, teamworkRoute } from './teamwork-server.js';
import { sessionTeamwork } from './teamwork-work.js';
import { parseTeamConfig } from './teamwork.js';
import type { TeamDoc, TeamTask } from './api-types.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-tw-numbers-')));
const bare = path.join(tmp, 'team.git');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'none.gitconfig') } }).trim();

/** Участник: своя папка команд, свой git config; таймеров нет — отправка и получение только через sync(). */
function actor(name: string, email: string): TeamService {
  const cfg = path.join(tmp, `${name}.gitconfig`);
  fs.writeFileSync(cfg, `[user]\n\tname = ${name}\n\temail = ${email}\n[init]\n\tdefaultBranch = main\n`);
  const x: Exec = (cmd, args, opts = {}) => exec(cmd, args, { ...opts, env: { ...opts.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: cfg } });
  const root = path.join(tmp, name, 'teams');
  fs.mkdirSync(root, { recursive: true });
  return new TeamService({ root: () => root, timers: false, repo: { ...defaultRepoDeps(), exec: x, tmpDir: tmp, retryMinMs: 3_600_000, retryMaxMs: 3_600_000 } });
}

const alice = actor('alice', 'alice@example.com');
const bob = actor('bob', 'bob@example.com');
const T = 'team';

const ids = (svc: TeamService, project = 'p') => svc.tasks(T, project).map((t) => t.id);
const lastTask = (svc: TeamService) => parseTeamConfig(svc.repo(T).read('teamwork.yaml') ?? '').lastTask;
const create = async (svc: TeamService, title: string, project = 'p') => (await svc.createTasks(T, project, [{ title }]))[0].id;
/** Отправить своё и получить чужое; расхождение не должно оставлять конфликтов. */
const sync = async (svc: TeamService) => {
  const s = await svc.sync(T);
  assert.equal(s.error ?? null, null);
};

before(async () => {
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  await alice.createTeam({ url: bare, title: 'Платёжная', prefix: 'PAY' });
  await alice.createProject(T, { slug: 'p', title: 'Проект P' });
  await alice.createProject(T, { slug: 'q', title: 'Проект Q' });
  await sync(alice);
  await bob.joinTeam({ url: bare });
  await sync(alice);
});

after(async () => {
  await alice.stop();
  await bob.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('удалённая последняя задача не отдаёт свой номер: следующая новая получает новый, запись работы по старому номеру к ней не переезжает', async () => {
  assert.equal(await create(alice, 'первая'), 'PAY-1');
  assert.equal(await create(alice, 'вторая'), 'PAY-2');
  assert.equal(lastTask(alice), undefined, 'создание счётчик не трогает: номер и так виден среди задач');
  alice.recordWork(T, 'PAY-2', { kind: 'run', id: 'run-1', at: '2026-11-12T10:00:00Z' });
  await alice.deleteTask(T, 'p', 'PAY-2');
  assert.equal(lastTask(alice), 2);
  // удаление и счётчик — один коммит
  assert.match(git(alice.repo(T).repoDir, 'show', '--stat', '--format=%s', 'HEAD'), /PAY-2: удалена[\s\S]*teamwork\.yaml/);
  const id = await create(alice, 'третья');
  assert.equal(id, 'PAY-3');
  assert.equal(alice.task(T, 'p', id).work, undefined);
  // не последняя задача: счётчик — наибольший номер команды на момент удаления
  await alice.deleteTask(T, 'p', 'PAY-1');
  assert.equal(lastTask(alice), 3);
  assert.deepEqual(ids(alice), ['PAY-3']);
  await sync(alice);
  // у второго клона после pull — тот же счётчик
  await sync(bob);
  assert.equal(lastTask(bob), 3);
  await bob.deleteTask(T, 'p', 'PAY-3');
  assert.equal(await create(bob, 'от bob'), 'PAY-4');
  await sync(bob);
  await sync(alice);
  assert.deepEqual(ids(alice), ['PAY-4']);
});

test('задача удалена руками в папке команды: правки руками коммитятся вместе со счётчиком, номер не возвращается', async () => {
  assert.equal(await create(alice, 'пятая'), 'PAY-5');
  fs.rmSync(path.join(alice.repo(T).repoDir, 'projects/p/tasks/PAY-5.md'));
  assert.equal(await create(alice, 'шестая'), 'PAY-6');
  assert.equal(lastTask(alice), 5);
  assert.match(git(alice.repo(T).repoDir, 'log', '-2', '--format=%s'), /PAY-6: создана[\s\S]*Правки в папке команды/);
  await sync(alice);
  await sync(bob);
});

test('одновременно: счётчик с двух сторон сливается как большее значение без конфликта, совпавший номер переименовывается за счётчиком', async () => {
  // alice создала две задачи, последнюю удалила и отправила: выдан PAY-8
  assert.equal(await create(alice, 'от alice'), 'PAY-7');
  assert.equal(await create(alice, 'удалённая'), 'PAY-8');
  await alice.deleteTask(T, 'p', 'PAY-8');
  assert.equal(lastTask(alice), 8);
  await sync(alice);
  // bob этого ещё не видел: его новая задача — тоже PAY-7, а удаление PAY-4 пишет свой счётчик — 7
  assert.equal(await create(bob, 'от bob'), 'PAY-7');
  await bob.deleteTask(T, 'p', 'PAY-4');
  assert.equal(lastTask(bob), 7);
  await sync(bob);
  // своя неотправленная PAY-7 получила номер за счётчиком команды: PAY-9, а не PAY-8 удалённой задачи
  const tasks = bob.tasks(T, 'p');
  assert.deepEqual(tasks.map((t) => [t.id, t.title]), [['PAY-6', 'шестая'], ['PAY-7', 'от alice'], ['PAY-9', 'от bob']]);
  assert.equal(lastTask(bob), 8);
  assert.deepEqual(bob.repo(T).local().conflicts, [], 'счётчик — не конфликт');
  assert.equal(git(bob.repo(T).repoDir, 'status', '--porcelain'), '');
  assert.equal(await bob.repo(T).unpushed(), 0);
  await sync(alice);
  assert.deepEqual(ids(alice), ['PAY-6', 'PAY-7', 'PAY-9']);
  assert.equal(lastTask(alice), 8);
  assert.equal(await create(alice, 'дальше'), 'PAY-10');
  await sync(alice);
  await sync(bob);
});

test('совпадение номеров в разных проектах после чистого rebase: своя задача получает номер за счётчиком', async () => {
  // alice: PAY-11 в p и удалённая PAY-12 — счётчик 12; bob в это время создаёт PAY-11 в q и teamwork.yaml не трогает
  assert.equal(await create(alice, 'в p'), 'PAY-11');
  assert.equal(await create(alice, 'удалённая'), 'PAY-12');
  await alice.deleteTask(T, 'p', 'PAY-12');
  await sync(alice);
  assert.equal(await create(bob, 'в q', 'q'), 'PAY-11');
  await sync(bob);
  assert.deepEqual(bob.tasks(T, 'q').map((t) => [t.id, t.title]), [['PAY-13', 'в q']]);
  assert.ok(ids(bob).includes('PAY-11'));
  assert.deepEqual(bob.repo(T).local().conflicts, []);
  assert.match(git(bare, 'log', '-1', '--format=%s', 'main'), /PAY-11 → PAY-13: номер уже занят/);
});

test('одновременно: команда выдала и удалила номер, я создал такой же до pull — моя задача получает номер за счётчиком, работа удалённой к ней не переезжает', async () => {
  await sync(alice);
  await sync(bob);
  const id = await create(alice, 'выдана и удалена');
  alice.recordWork(T, id, { kind: 'run', id: 'run-a', at: '2026-11-12T11:00:00Z' });
  await alice.deleteTask(T, 'p', id);
  assert.equal(alice.repo(T).local().work[id], undefined, 'запуски удалённой задачи забыты');
  await sync(alice);
  // bob ещё не получил: его задача — тот же номер в другом проекте, teamwork.yaml он не трогал, rebase чистый
  assert.equal(await create(bob, 'от bob', 'q'), id);
  bob.recordWork(T, id, { kind: 'session', id: 'ses-b', at: '2026-11-12T11:01:00Z' });
  await sync(bob);
  const n = Number(id.split('-')[1]);
  const mine = bob.tasks(T, 'q').find((t) => t.title === 'от bob')!;
  assert.equal(mine.id, `PAY-${n + 1}`);
  assert.deepEqual(mine.work?.map((w) => w.id), ['ses-b'], 'моя работа переехала вместе с моей задачей');
  assert.equal(bob.repo(T).local().work[id], undefined);
  assert.match(git(bare, 'log', '-1', '--format=%s', 'main'), new RegExp(`${id} → PAY-${n + 1}: номер уже выдавался в команде`));
  await sync(alice);
  assert.ok(ids(alice, 'q').includes(`PAY-${n + 1}`));
  assert.equal([...ids(alice, 'p'), ...ids(alice, 'q')].includes(id), false);
});

test('зеркально: я создал и удалил номер, команда в это время отправила свою задачу с ним же — моя работа к её задаче не переезжает', async () => {
  await sync(bob);
  const id = await create(bob, 'моя временная', 'q');
  bob.recordWork(T, id, { kind: 'run', id: 'run-b', at: '2026-11-12T12:00:00Z' });
  await bob.deleteTask(T, 'q', id);
  // alice этого не видела: её новая задача — тот же номер, и она отправила первой
  assert.equal(await create(alice, 'от alice'), id);
  await sync(alice);
  await sync(bob);
  const theirs = bob.task(T, 'p', id);
  assert.equal(theirs.title, 'от alice');
  assert.equal(theirs.work, undefined);
  assert.deepEqual(bob.repo(T).local().conflicts, []);
  await sync(alice);
  assert.equal(alice.task(T, 'p', id).title, 'от alice', 'задачу команды, которую уже видели, никто не переименовывает');
});

// ---------- место новой задачи (spec §5.8)

/** HTTP-маршрут без сервера: тело как пришло бы в POST/PUT. */
const route = async <T = unknown>(method: string, url: string, body?: unknown) => {
  const r = await teamworkRoute(method, new URL(`http://x${url}`), async () => body, { service: alice });
  assert.ok(r, url);
  return r as { status: number; body: T };
};
const titles = (project: string, sprint?: number) => alice.tasks(T, project).filter((t) => t.sprint === sprint).map((t) => t.title);

test('новая задача по after/before встаёт рядом с соседом своего списка; без них — в конец; пачка с одним after — в своём порядке', async () => {
  await alice.createProject(T, { slug: 'r', title: 'Порядок' });
  const [a, b, c] = (await alice.createTasks(T, 'r', [{ title: 'A' }, { title: 'B' }, { title: 'C' }])).map((t) => t.id);
  assert.deepEqual(titles('r'), ['A', 'B', 'C']);
  // через маршрут: after и before доходят из тела POST …/tasks
  const one = await route<TeamTask>('POST', `/api/teams/${T}/projects/r/tasks`, { title: 'после A', after: a });
  assert.equal(one.status, 201);
  assert.deepEqual(titles('r'), ['A', 'после A', 'B', 'C']);
  await alice.createTasks(T, 'r', [{ title: 'перед A', before: a }]);
  await alice.createTasks(T, 'r', [{ title: 'между', after: one.body.id, before: b }]);
  await alice.createTasks(T, 'r', [{ title: 'перед C', before: c }]);
  await alice.createTasks(T, 'r', [{ title: 'в конец' }]);
  assert.deepEqual(titles('r'), ['перед A', 'A', 'после A', 'между', 'B', 'перед C', 'C', 'в конец']);
  await alice.createTasks(T, 'r', [{ title: 'x', after: b }, { title: 'y', after: b }, { title: 'z', before: c }]);
  assert.deepEqual(titles('r'), ['перед A', 'A', 'после A', 'между', 'B', 'x', 'y', 'перед C', 'z', 'C', 'в конец']);
  // спринт — свой список
  const sprint = await alice.createSprint(T, 'r', { title: 'Спринт 1' });
  const [s1] = (await alice.createTasks(T, 'r', [{ title: 'S1', sprint: sprint.number }])).map((t) => t.id);
  await alice.createTasks(T, 'r', [{ title: 'S0', sprint: sprint.number, before: s1 }]);
  assert.deepEqual(titles('r', sprint.number), ['S0', 'S1']);
  assert.equal(titles('r').length, 11, 'бэклог не тронут');
});

/** rank, правленный руками в папке команды: следующая запись закоммитит его как правку руками. */
const setRank = (project: string, id: string, rank: string) => {
  const file = `projects/${project}/tasks/${id}.md`;
  alice.repo(T).writeFile(file, alice.repo(T).read(file)!.replace(/^rank: .*$/m, `rank: ${rank}`));
};

test('новая задача у соседей с одним rank (одновременные вставки) встаёт сразу за группой или перед ней, а не за чужими задачами; rank, правленный руками, не даёт повторов', async () => {
  await alice.createProject(T, { slug: 's', title: 'Ранги' });
  const [x, y, z] = (await alice.createTasks(T, 's', [{ title: 'X' }, { title: 'Y' }, { title: 'Z' }])).map((t) => t.id);
  // как после двух одновременных вставок в конец: у X и Y один rank, Z — сразу за ними
  setRank('s', x, 't');
  setRank('s', y, 't');
  setRank('s', z, 'x');
  await alice.createTasks(T, 's', [{ title: 'после X', after: x }]);
  assert.deepEqual(titles('s'), ['X', 'Y', 'после X', 'Z']);
  await alice.createTasks(T, 's', [{ title: 'перед Y', before: y }]);
  assert.deepEqual(titles('s'), ['перед Y', 'X', 'Y', 'после X', 'Z']);
  // у последней задачи rank правлен руками (хвостовой 0): пачка в конец всё равно получает разные rank по порядку
  setRank('s', z, 'z0');
  const batch = await alice.createTasks(T, 's', [{ title: 'e1' }, { title: 'e2' }]);
  const all = alice.tasks(T, 's');
  const rank = (title: string) => all.find((t) => t.title === title)!.rank;
  assert.ok(rank('после X') < rank('e1') && rank('e1') < rank('e2'), `${rank('e1')} ${rank('e2')}`);
  assert.equal(new Set(all.filter((t) => t.title !== 'X' && t.title !== 'Y').map((t) => t.rank)).size, all.length - 2, 'новые rank не повторяются');
  assert.deepEqual(batch.map((t) => t.title), ['e1', 'e2']);
});

test('новая задача: сосед не из её списка или неизвестный — 400, ничего не записано', async () => {
  const before = ids(alice, 'r');
  const head = git(alice.repo(T).repoDir, 'rev-parse', 'HEAD');
  const backlog = alice.tasks(T, 'r').find((t) => t.sprint === undefined)!.id;
  const unknown = await route<{ error: string }>('POST', `/api/teams/${T}/projects/r/tasks`, { title: 'x', after: 'PAY-999' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /PAY-999 \(after\) нет в бэклоге/);
  const other = await route<{ error: string }>('POST', `/api/teams/${T}/projects/r/tasks`, { title: 'x', sprint: 1, before: backlog });
  assert.equal(other.status, 400);
  assert.match(other.body.error, new RegExp(`${backlog} \\(before\\) нет в спринте 1`));
  // задача другого проекта — тоже не сосед
  assert.equal((await route('POST', `/api/teams/${T}/projects/r/tasks`, { tasks: [{ title: 'ok' }, { title: 'x', after: ids(alice, 'p')[0] }] })).status, 400);
  assert.equal((await route('POST', `/api/teams/${T}/projects/r/tasks`, { title: 'x', after: 5 })).status, 400);
  assert.deepEqual(ids(alice, 'r'), before);
  assert.equal(git(alice.repo(T).repoDir, 'rev-parse', 'HEAD'), head);
});

// ---------- номера требований (spec §8.4)

const PRD = '# ТЗ\n\n## Требования\n\n- FR-1. Выгрузка CSV\n- FR-2. Пустой период\n\n## Нефункциональные\n\n- NFR-1. Быстро\n';

test('ТЗ с повтором номера требования не записывается: 400 с номерами и следующим свободным — и целиком, и разделом; повтор, который уже был, соседний раздел не блокирует', async () => {
  const doc = await route<TeamDoc>('PUT', `/api/teams/${T}/projects/r/docs/prd`, { text: PRD });
  assert.equal(doc.status, 200);
  const head = git(alice.repo(T).repoDir, 'rev-parse', 'HEAD');
  const whole = await route<{ error: string }>('PUT', `/api/teams/${T}/projects/r/docs/prd`, { text: `${PRD}- FR-2. Ещё раз\n- NFR-1. И это\n`, base: doc.body.base });
  assert.equal(whole.status, 400);
  assert.match(whole.body.error, /повторяются номера требований: FR-2, NFR-1/);
  assert.match(whole.body.error, /следующий свободный: FR-3, NFR-2/);
  const section = await route<{ error: string }>('PUT', `/api/teams/${T}/projects/r/docs/prd`, { section: 'Требования', text: '## Требования\n\n- FR-1. Выгрузка CSV\n- FR-1. Копия\n' });
  assert.equal(section.status, 400);
  assert.match(section.body.error, /FR-1/);
  assert.equal(git(alice.repo(T).repoDir, 'rev-parse', 'HEAD'), head, 'ничего не записано');
  // архитектура и дизайн требований не ведут — там строки FR не проверяются
  assert.equal((await route('PUT', `/api/teams/${T}/projects/r/docs/architecture`, { text: '# А\n\n- FR-1. ссылка\n- FR-1. ссылка\n' })).status, 200);
  // повтор пришёл слиянием (правка руками в клоне): соседний раздел сохраняется, новый повтор — нет
  const file = path.join(alice.repo(T).repoDir, 'projects/r/prd.md');
  fs.writeFileSync(file, `${PRD}\n## Ещё\n\n- FR-2. Из другой правки\n`);
  const nfr = await alice.writeDoc(T, 'r', 'prd', '## Нефункциональные\n\n- NFR-1. Очень быстро\n', { section: 'Нефункциональные' });
  assert.match(nfr.text, /NFR-1\. Очень быстро/);
  await assert.rejects(alice.writeDoc(T, 'r', 'prd', '## Ещё\n\n- FR-2. Из другой правки\n- FR-2. Третий\n', { section: 'Ещё' }), (e: { status: number; message: string }) => e.status === 400 && /FR-2/.test(e.message));
});

test('team_doc_write: ТЗ из сессии по задаче не пишется вовсе, поэтому повторов номеров оттуда не будет', async () => {
  const hooks = sessionTeamwork(alice, {} as never);
  const link = { team: T, project: 'r', task: ids(alice, 'r')[0] };
  await assert.rejects(hooks.writeDoc(link, 'prd', PRD), /ТЗ из сессии не пишется/);
  await hooks.writeDoc(link, 'design', '# Дизайн\n');
  assert.equal(alice.repo(T).read('projects/r/design.md'), '# Дизайн\n');
});
