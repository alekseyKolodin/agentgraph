// Маршруты /api/teams через настоящий HTTP-сервер (startServer), как server.spaces.test.ts: коды 400, 404 и 409, тела
// ответов по типам Teamwork, событие team в /api/events. Git настоящий: временный bare-репо как origin, идентичность —
// свой глобальный git config через exec; таймеры отправки выключены, отправка — только POST /sync. Раннер подменён.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TeamComment, TeamDetail, TeamDoc, TeamDocRevision, TeamProject, TeamProjectBrief, TeamRemoteCheck, TeamSprint, TeamSummary, TeamSync, TeamTask } from './api-types.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-srvteam-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
const proj = path.join(home, 'proj');
for (const d of [path.join(home, 'flows'), path.join(home, 'runs'), proj]) fs.mkdirSync(d, { recursive: true });

const { startServer, stopServer } = await import('./server.js');
const { exec } = await import('./git.js');
const { teamsDir } = await import('./teamwork.js');
const { templateFiles } = await import('./teamwork-template.js');

/** Flow шаблона репо команды: тесты не зависят от того, какие flow в нём лежат. */
const TEMPLATE_FLOWS = templateFiles().flatMap((f) => (f.match(/^flows\/([a-z0-9-]+)\.ya?ml$/)?.[1] ? [f.match(/^flows\/([a-z0-9-]+)\.ya?ml$/)![1]] : [])).sort();
/** Имя flow, которого в шаблоне точно нет. */
const NO_FLOW = 'tw-nope';
/** Flow, который тест добавляет сам. */
const MY_FLOW = 'tw-custom';

const bare = path.join(home, 'team.git');
const gitcfg = path.join(home, 'me.gitconfig');
fs.writeFileSync(gitcfg, '[user]\n\tname = Алексей\n\temail = alex@example.com\n');
const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitcfg };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } }).trim();

let base = '';
before(async () => {
  git(home, 'init', '-q', '--bare', '-b', 'main', bare);
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  await startServer({
    port,
    host: '127.0.0.1',
    defaultCwd: proj,
    notify: false,
    runFlow: (async () => {
      throw new Error('поддельный раннер');
    }) as never,
    teamwork: { timers: false, repo: { exec: (cmd, args, opts = {}) => exec(cmd, args, { ...opts, env: { ...opts.env, ...env } }), pushDelayMs: 3_600_000, retryMinMs: 3_600_000, tmpDir: home } },
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await stopServer(2000);
  if (prevHome === undefined) delete process.env.AGENTGRAPH_HOME;
  else process.env.AGENTGRAPH_HOME = prevHome;
  if (prevCfg === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
  else process.env.AGENTGRAPH_CONFIG_DIR = prevCfg;
  fs.rmSync(home, { recursive: true, force: true });
});

async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}
type Err = { error: string; code?: string; current?: unknown };
const P = '/api/teams/team/projects/export';

test('фича teamwork и пустой список команд; проверка ссылки; создание — 400 на плохие поля, 201 с деталями, второй раз — 409 is_team', async () => {
  const cfg = await call<{ features: string[] }>('GET', '/api/config');
  assert.ok(cfg.body.features.includes('teamwork'));
  assert.deepEqual((await call('GET', '/api/teams')).body, []);
  assert.equal((await call<Err>('POST', '/api/teams/check', {})).status, 400);
  assert.deepEqual((await call<TeamRemoteCheck>('POST', '/api/teams/check', { url: bare })).body, { kind: 'empty' });
  assert.equal((await call<TeamRemoteCheck>('POST', '/api/teams/check', { url: '-x' })).body.kind, 'error');
  assert.equal((await call<Err>('POST', '/api/teams', { url: bare, title: 'Платёжная', prefix: '1' })).status, 400);
  assert.equal((await call<Err>('POST', '/api/teams', { url: 'relative', title: 'Платёжная', prefix: 'PAY' })).status, 400);
  const created = await call<TeamDetail>('POST', '/api/teams', { url: bare, title: 'Платёжная команда', prefix: 'pay' });
  assert.equal(created.status, 201);
  const t = created.body;
  assert.equal(t.slug, 'team');
  assert.equal(t.prefix, 'PAY');
  assert.equal(t.format, 1);
  assert.deepEqual(t.memberList, [{ name: 'Алексей', email: 'alex@example.com' }]);
  assert.deepEqual(t.me, { name: 'Алексей', email: 'alex@example.com', inTeam: true });
  assert.equal(t.sync.state, 'ok');
  assert.deepEqual(t.flows, TEMPLATE_FLOWS);
  assert.equal(t.dir, path.join(teamsDir(), 'team', 'repo'));
  assert.equal(t.columns.in_progress, 'В работе');
  const list = await call<TeamSummary[]>('GET', '/api/teams');
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].members, 1);
  const again = await call<Err>('POST', '/api/teams', { url: bare, title: 'Другая', prefix: 'TWO' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'is_team');
  assert.equal((await call('GET', '/api/teams/nope')).status, 404);
  assert.equal((await call('GET', '/api/teams/..')).status, 404);
});

test('подключение по ссылке к своему же репо — вторая папка team-2; отключение', async () => {
  const joined = await call<TeamDetail>('POST', '/api/teams/join', { url: bare });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.slug, 'team-2');
  assert.equal(joined.body.me.inTeam, true);
  assert.equal((await call('DELETE', '/api/teams/team-2')).status, 200);
  assert.equal((await call('GET', '/api/teams/team-2')).status, 404);
  assert.equal((await call<TeamSummary[]>('GET', '/api/teams')).body.length, 1);
});

test('настройки команды: названия колонок, участники, flow по умолчанию; лишняя колонка и смена префикса — 400', async () => {
  const bad = await call<Err>('PUT', '/api/teams/team', { columns: { backlog: 'Бэклог' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /фиксированы/);
  assert.equal((await call('PUT', '/api/teams/team', { prefix: 'NEW' })).status, 400);
  assert.equal((await call('PUT', '/api/teams/team', { prefix: 'pay' })).status, 200);
  assert.equal((await call('PUT', '/api/teams/team', { members: [] })).status, 400);
  const noFlow = await call<Err>('PUT', '/api/teams/team', { defaultFlow: NO_FLOW });
  assert.equal(noFlow.status, 400);
  assert.match(noFlow.body.error, /нет в репо команды/);
  // %E0 в пути — 400, а не 500
  assert.equal((await call('GET', '/api/teams/%E0')).status, 400);
  const r = await call<TeamDetail>('PUT', '/api/teams/team', { title: 'Платежи', columns: { todo: 'Очередь' }, defaultFlow: null, members: [{ name: 'Алексей', email: 'alex@example.com', github: 'alex' }, { email: 'Bob@Example.com' }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'Платежи');
  assert.equal(r.body.columns.todo, 'Очередь');
  assert.equal(r.body.columns.done, 'Готово');
  assert.equal(r.body.defaultFlow, undefined);
  assert.deepEqual(r.body.memberList.map((m) => m.email), ['alex@example.com', 'bob@example.com']);
  assert.equal(r.body.members, 2);
  // комментарии шаблона в teamwork.yaml остались
  assert.match(fs.readFileSync(path.join(r.body.dir, 'teamwork.yaml'), 'utf8'), /# версия формата/);
  await call('PUT', '/api/teams/team', { columns: { todo: 'К работе' } });
});

test('проекты: 400 на slug, 201 с документами из заготовок, 409 на повтор, список кратко, архив', async () => {
  assert.equal((await call('POST', '/api/teams/team/projects', { slug: 'Bad Slug', title: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/teams/team/projects', { slug: 'export', title: '' })).status, 400);
  assert.equal((await call('POST', '/api/teams/team/projects', { slug: 'export', title: 'x', repos: [{ key: 'billing', url: '-bad' }] })).status, 400);
  const r = await call<TeamProject>('POST', '/api/teams/team/projects', { slug: 'export', title: 'Экспорт счетов', summary: 'CSV за период', repos: [{ key: 'billing', url: 'git@github.com:acme/billing.git', defaultBranch: 'main' }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.slug, 'export');
  assert.equal(r.body.createdBy, 'alex@example.com');
  assert.deepEqual(r.body.repos, [{ key: 'billing', url: 'git@github.com:acme/billing.git', defaultBranch: 'main' }]);
  assert.deepEqual(r.body.docs.map((d) => [d.name, d.title]), [['prd', 'ТЗ: Экспорт счетов'], ['architecture', 'Архитектура: Экспорт счетов'], ['design', 'Дизайн: Экспорт счетов']]);
  assert.equal(r.body.docs[0].updatedBy, 'alex@example.com');
  assert.deepEqual(r.body.sprints, []);
  assert.equal(r.body.dir, path.join(teamsDir(), 'team', 'repo', 'projects', 'export'));
  const dup = await call<Err>('POST', '/api/teams/team/projects', { slug: 'export', title: 'Ещё' });
  assert.equal(dup.status, 409);
  const list = await call<TeamProjectBrief[]>('GET', '/api/teams/team/projects');
  assert.deepEqual(list.body, [{ slug: 'export', title: 'Экспорт счетов', summary: 'CSV за период', status: 'active', backlog: 0 }]);
  assert.equal((await call('GET', `${P}-nope`)).status, 404);
  const arch = await call<TeamProject>('PUT', P, { status: 'archived', summary: 'Выгрузка CSV и 1С' });
  assert.equal(arch.body.status, 'archived');
  assert.equal(arch.body.summary, 'Выгрузка CSV и 1С');
  assert.equal((await call('PUT', P, { status: 'gone' })).status, 400);
  await call('PUT', P, { status: 'active' });
});

test('разделы ТЗ: сохранение раздела не трогает остальные, параллельная правка того же раздела — 409, другого — сливается; номера требований не переиспользуются', async () => {
  const doc = await call<TeamDoc>('GET', `${P}/docs/prd`);
  assert.equal(doc.status, 200);
  assert.match(doc.body.text, /^# ТЗ: Экспорт счетов\n\nCSV за период/);
  assert.ok(doc.body.sections.some((s) => s.heading === 'Требования'));
  assert.deepEqual(doc.body.requirements, []);
  assert.deepEqual(doc.body.nextRequirement, { FR: 'FR-1', NFR: 'NFR-1' });
  const sec = (d: TeamDoc, h: string) => d.sections.find((s) => s.heading === h)!;
  const reqHash = sec(doc.body, 'Требования').hash;
  const goalHash = sec(doc.body, 'Цель и проблема').hash;
  // кто-то сохранил другой раздел
  const other = await call<TeamDoc>('PUT', `${P}/docs/prd`, { text: '## Цель и проблема\n\nБухгалтерия вручную собирает счета.', section: 'Цель и проблема', hash: goalHash });
  assert.equal(other.status, 200);
  // мой раздел с хэшем, взятым до этого, сохраняется: менялся не он
  const mine = await call<TeamDoc>('PUT', `${P}/docs/prd`, { text: '## Требования\n\n- FR-1. Выгрузка CSV\n- FR-2. Выгрузка в 1С\n', section: 'Требования', hash: reqHash });
  assert.equal(mine.status, 200);
  assert.match(mine.body.text, /Бухгалтерия вручную[\s\S]*- FR-1\. Выгрузка CSV\n- FR-2\. Выгрузка в 1С\n\n## Нефункциональные требования/);
  assert.deepEqual(mine.body.requirements!.map((r) => r.id), ['FR-1', 'FR-2']);
  assert.equal(mine.body.nextRequirement!.FR, 'FR-3');
  // тот же раздел со старым хэшем — 409 и текущая версия в ответе
  const stale = await call<Err>('PUT', `${P}/docs/prd`, { text: '## Требования\n\n- FR-9. мимо\n', section: 'Требования', hash: reqHash });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'conflict');
  assert.equal((stale.body.current as TeamDoc).base, mine.body.base);
  assert.equal((await call('PUT', `${P}/docs/prd`, { text: 'x', section: 'Нет такого' })).status, 404);
  // удалённый номер не возвращается: FR-2 убрали, следующий всё равно FR-3
  const removed = await call<TeamDoc>('PUT', `${P}/docs/prd`, { text: '## Требования\n\n- FR-1. Выгрузка CSV\n', section: 'Требования' });
  assert.deepEqual(removed.body.requirements!.map((r) => r.id), ['FR-1']);
  assert.equal(removed.body.nextRequirement!.FR, 'FR-3');
  assert.match(fs.readFileSync(path.join(teamsDir(), 'team', 'repo', 'projects', 'export', 'project.yaml'), 'utf8'), /lastRequirement:\n {2}FR: 2\n {2}NFR: 0/);
  // документ целиком: со старым base — 409, со свежим — 200; история по файлу
  const whole = await call<Err>('PUT', `${P}/docs/prd`, { text: '# ТЗ\n', base: doc.body.base });
  assert.equal(whole.status, 409);
  const fresh = await call<TeamDoc>('PUT', `${P}/docs/prd`, { text: `${removed.body.text}\n## Открытые вопросы\n\n- Нужен ли XLSX?`, base: removed.body.base, message: 'export: вопрос про XLSX' });
  assert.equal(fresh.status, 200);
  assert.ok(fresh.body.text.endsWith('- Нужен ли XLSX?\n'));
  const hist = await call<{ message: string; email: string }[]>('GET', `${P}/history?doc=prd&limit=3`);
  assert.deepEqual(hist.body.map((h) => h.message), ['export: вопрос про XLSX', 'export: ТЗ обновлено, раздел «Требования»', 'export: ТЗ обновлено, раздел «Требования»']);
  assert.equal(hist.body[0].email, 'alex@example.com');
  // прочие документы в docs/: нет — 404, создаётся PUT без base; плохое имя — 400
  assert.equal((await call('GET', `${P}/docs/docs/notes.md`)).status, 404);
  const notes = await call<TeamDoc>('PUT', `${P}/docs/docs/notes.md`, { text: '# Заметки\n\nвстреча' });
  assert.equal(notes.status, 200);
  assert.equal(notes.body.name, 'docs/notes.md');
  assert.equal((await call('GET', `${P}/docs/docs/.hidden.md`)).status, 400);
  assert.equal((await call('GET', `${P}/docs/readme`)).status, 400);
  const p = await call<TeamProject>('GET', P);
  assert.deepEqual(p.body.docs.map((d) => d.name), ['prd', 'architecture', 'design', 'docs/notes.md']);
});

test('история документа: версия до и после коммита для диффа; без doc и с плохим хэшем — 400, нет такого коммита — 404', async () => {
  const hist = await call<{ hash: string; message: string }[]>('GET', `${P}/history?doc=prd&limit=2`);
  const [last, prev] = hist.body;
  const rev = await call<TeamDocRevision>('GET', `${P}/history/${last.hash}?doc=prd`);
  assert.equal(rev.status, 200);
  assert.equal(rev.body.hash, last.hash);
  assert.ok(rev.body.after.endsWith('- Нужен ли XLSX?\n'));
  assert.ok(!rev.body.before.includes('Нужен ли XLSX?'));
  const older = await call<TeamDocRevision>('GET', `${P}/history/${prev.hash}?doc=prd`);
  assert.equal(older.body.after, rev.body.before);
  // первый коммит документа: до него файла не было
  const all = await call<{ hash: string }[]>('GET', `${P}/history?doc=prd&limit=50`);
  const first = await call<TeamDocRevision>('GET', `${P}/history/${all.body[all.body.length - 1].hash}?doc=prd`);
  assert.equal(first.body.before, '');
  assert.match(first.body.after, /^# ТЗ/);
  assert.equal((await call('GET', `${P}/history/${last.hash}`)).status, 400);
  assert.equal((await call('GET', `${P}/history/HEAD~1?doc=prd`)).status, 400);
  assert.equal((await call('GET', `${P}/history/deadbeef0?doc=prd`)).status, 404);
});

test('задачи: создание одной и пачкой с dependsOn → blockedBy, PATCH с base (409), move между соседями, 404 и удаление', async () => {
  assert.equal((await call('POST', `${P}/tasks`, { title: '' })).status, 400);
  assert.equal((await call('POST', `${P}/tasks`, { title: 'x', repo: 'nope' })).status, 400);
  const one = await call<TeamTask>('POST', `${P}/tasks`, { title: 'Выгрузка CSV', estimate: 3, repo: 'billing', covers: ['FR-1'] });
  assert.equal(one.status, 201);
  assert.equal(one.body.id, 'PAY-1');
  assert.equal(one.body.rank, 'V');
  assert.equal(one.body.status, 'todo');
  assert.equal(one.body.createdBy, 'alex@example.com');
  assert.deepEqual(one.body.covers, ['FR-1']);
  assert.equal(one.body.file, 'projects/export/tasks/PAY-1.md');
  const batch = await call<{ tasks: TeamTask[] }>('POST', `${P}/tasks`, {
    tasks: [
      { key: 't1', title: 'Экспорт в 1С', description: 'Файл для 1С', acceptance: ['CP1251', 'Проверено на тестовой базе'], dependsOn: ['PAY-1'] },
      { key: 't2', title: 'Кнопка в интерфейсе', type: 'chore', dependsOn: ['t1'] },
    ],
  });
  assert.equal(batch.status, 201);
  assert.deepEqual(batch.body.tasks.map((t) => [t.id, t.blockedBy, t.rank]), [['PAY-2', ['PAY-1'], 'l'], ['PAY-3', ['PAY-2'], 't']]);
  assert.match(batch.body.tasks[0].body, /## Описание\n\nФайл для 1С\n\n## Критерии приёмки\n\n- \[ \] CP1251\n- \[ \] Проверено/);
  assert.deepEqual(batch.body.tasks[0].acceptance, { done: 0, total: 2 });
  const unknown = await call<Err>('POST', `${P}/tasks`, { tasks: [{ title: 'x', dependsOn: ['zzz'] }] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Неизвестная зависимость/);
  // пачка — один коммит
  const hist = await call<{ message: string }[]>('GET', `${P}/history?limit=2`);
  assert.deepEqual(hist.body.map((h) => h.message), ['export: 2 задач добавлено', 'PAY-1: создана — Выгрузка CSV']);
  const list = await call<TeamTask[]>('GET', `${P}/tasks`);
  assert.deepEqual(list.body.map((t) => t.id), ['PAY-1', 'PAY-2', 'PAY-3']);
  // PATCH: устаревший base — 409 с текущей задачей; свежий — 200 и понятное сообщение коммита
  const stale = await call<Err>('PATCH', `${P}/tasks/PAY-1`, { status: 'in_progress', base: 'deadbeef' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'conflict');
  assert.equal((stale.body.current as TeamTask).id, 'PAY-1');
  const patched = await call<TeamTask>('PATCH', `${P}/tasks/PAY-1`, { status: 'in_progress', assignee: 'alex@example.com', base: one.body.base });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, 'in_progress');
  assert.equal(patched.body.updatedBy, 'alex@example.com');
  assert.notEqual(patched.body.base, one.body.base);
  assert.equal((await call<{ message: string }[]>('GET', `${P}/history?limit=1`)).body[0].message, 'PAY-1: статус → В работе, исполнитель → alex@example.com');
  assert.equal((await call('PATCH', `${P}/tasks/PAY-1`, { status: 'later' })).status, 400);
  assert.equal((await call('PATCH', `${P}/tasks/PAY-1`, { blockedBy: ['PAY-1'] })).status, 400);
  assert.equal((await call('PATCH', `${P}/tasks/PAY-1`, { sprint: 7 })).status, 400);
  // ничего не поменялось — коммита нет
  await call('PATCH', `${P}/tasks/PAY-1`, { status: 'in_progress' });
  assert.equal((await call<{ message: string }[]>('GET', `${P}/history?limit=1`)).body[0].message, 'PAY-1: статус → В работе, исполнитель → alex@example.com');
  // move: PAY-3 между PAY-1 и PAY-2
  const moved = await call<TeamTask>('POST', `${P}/tasks/PAY-3/move`, { after: 'PAY-1', before: 'PAY-2' });
  assert.equal(moved.status, 200);
  assert.ok(moved.body.rank > 'V' && moved.body.rank < 'l', moved.body.rank);
  assert.deepEqual((await call<TeamTask[]>('GET', `${P}/tasks`)).body.map((t) => t.id), ['PAY-1', 'PAY-3', 'PAY-2']);
  assert.equal((await call('POST', `${P}/tasks/PAY-3/move`, { after: 'PAY-77' })).status, 400);
  assert.equal((await call('GET', `${P}/tasks/PAY-9`)).status, 404);
  assert.equal((await call('GET', `${P}/tasks/bad`)).status, 400);
  assert.equal((await call('PATCH', `${P}/tasks/PAY-9`, { title: 'x' })).status, 404);
  // удаление снимает ссылки blockedBy у соседей тем же коммитом
  await call('PATCH', `${P}/tasks/PAY-2`, { blockedBy: ['PAY-1', 'PAY-3'] });
  assert.equal((await call('DELETE', `${P}/tasks/PAY-3`)).status, 200);
  assert.equal((await call('DELETE', `${P}/tasks/PAY-3`)).status, 404);
  assert.deepEqual((await call<TeamTask[]>('GET', `${P}/tasks`)).body.map((t) => [t.id, t.blockedBy]), [['PAY-1', []], ['PAY-2', ['PAY-1']]]);
  assert.equal((await call<unknown[]>('GET', `${P}/history?limit=abc`)).status, 200);
  // битый файл задачи — карточка с error, а не 500
  fs.writeFileSync(path.join(teamsDir(), 'team', 'repo', 'projects', 'export', 'tasks', 'PAY-4.md'), 'мусор');
  const broken = (await call<TeamTask[]>('GET', `${P}/tasks`)).body.find((t) => t.id === 'PAY-4');
  assert.match(broken?.error ?? '', /frontmatter/);
  assert.equal((await call<Err>('PATCH', `${P}/tasks/PAY-4`, { title: 'x' })).status, 400);
  fs.rmSync(path.join(teamsDir(), 'team', 'repo', 'projects', 'export', 'tasks', 'PAY-4.md'));
});

test('комментарии: 201 и mine, список по времени, пустой — 400', async () => {
  assert.equal((await call('POST', `${P}/tasks/PAY-1/comments`, { text: '  ' })).status, 400);
  const c = await call<TeamComment>('POST', `${P}/tasks/PAY-1/comments`, { text: 'Проверь BOM' });
  assert.equal(c.status, 201);
  assert.equal(c.body.author, 'alex@example.com');
  assert.equal(c.body.mine, true);
  assert.match(c.body.id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-alex$/);
  const list = await call<TeamComment[]>('GET', `${P}/tasks/PAY-1/comments`);
  assert.deepEqual(list.body.map((x) => [x.text, x.mine]), [['Проверь BOM', true]]);
  assert.equal((await call<TeamTask>('GET', `${P}/tasks/PAY-1`)).body.comments, 1);
  assert.equal((await call('GET', `${P}/tasks/PAY-9/comments`)).status, 404);
});

test('спринты: один planned и один active, запуск переводит задачи в «К работе», закрытие пишет итог и разносит незавершённые', async () => {
  const planned = await call<TeamSprint>('POST', `${P}/sprints`, { title: 'Первый', goal: 'CSV на проде' });
  assert.equal(planned.status, 201);
  assert.deepEqual(planned.body, { number: 1, title: 'Первый', goal: 'CSV на проде', status: 'planned' });
  const second = await call<Err>('POST', `${P}/sprints`, {});
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'busy');
  assert.equal((await call('POST', `${P}/sprints/1/start`, { tasks: ['PAY-9'] })).status, 400);
  assert.equal((await call('POST', `${P}/sprints/5/start`)).status, 404);
  const started = await call<TeamSprint>('POST', `${P}/sprints/1/start`, { tasks: ['PAY-1', 'PAY-2'] });
  assert.equal(started.status, 200);
  assert.equal(started.body.status, 'active');
  assert.equal(started.body.startedBy, 'alex@example.com');
  const tasks = (await call<TeamTask[]>('GET', `${P}/tasks`)).body;
  // PAY-1 была «В работе» — при запуске спринта снова «К работе»
  assert.deepEqual(tasks.map((t) => [t.id, t.sprint, t.status]), [['PAY-1', 1, 'todo'], ['PAY-2', 1, 'todo']]);
  assert.equal((await call<Err>('POST', `${P}/sprints/1/start`)).body.code, 'busy');
  assert.equal((await call<Err>('POST', `${P}/sprints`, { start: true })).body.code, 'busy');
  const team = await call<TeamDetail>('GET', '/api/teams/team');
  assert.deepEqual(team.body.projects[0].sprint, { number: 1, title: 'Первый', done: 0, total: 2, counts: { todo: 2, in_progress: 0, review: 0, done: 0 } });
  assert.equal(team.body.projects[0].backlog, 0);
  await call('PATCH', `${P}/tasks/PAY-1`, { status: 'done' });
  assert.equal((await call('POST', `${P}/sprints/2/close`)).status, 404);
  const closed = await call<TeamSprint>('POST', `${P}/sprints/1/close`, { next: ['PAY-2'] });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.status, 'closed');
  assert.equal(closed.body.closedBy, 'alex@example.com');
  assert.deepEqual(closed.body.result, { done: ['PAY-1'], carried: ['PAY-2'], returned: [] });
  const after = (await call<TeamTask[]>('GET', `${P}/tasks`)).body;
  assert.deepEqual(after.map((t) => [t.id, t.sprint]), [['PAY-1', 1], ['PAY-2', 2]]);
  const sprints = (await call<TeamProject>('GET', P)).body.sprints;
  assert.deepEqual(sprints.map((s) => [s.number, s.status]), [[1, 'closed'], [2, 'planned']]);
  assert.equal((await call<Err>('POST', `${P}/sprints/1/close`)).status, 409);
  // снова закрыть с возвратом в бэклог
  await call('POST', `${P}/sprints/2/start`);
  const back = await call<TeamSprint>('POST', `${P}/sprints/2/close`, {});
  assert.deepEqual(back.body.result, { done: [], carried: [], returned: ['PAY-2'] });
  assert.equal((await call<TeamTask>('GET', `${P}/tasks/PAY-2`)).body.sprint, undefined);
});

test('flow команды: нет — 404, невалидный YAML — 400, валидный сохраняется и появляется в списке; местные папки и привязки; синхронизация', async () => {
  assert.equal((await call('GET', `/api/teams/team/flows/${NO_FLOW}`)).status, 404);
  assert.equal((await call('GET', '/api/teams/team/flows/Bad_Name')).status, 400);
  const bad = await call<Err>('PUT', `/api/teams/team/flows/${MY_FLOW}`, { yaml: `name: ${MY_FLOW}\nphases: []\n` });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /flow/i);
  const yaml = `name: ${MY_FLOW}\ndescription: Задача в работу\nphases:\n  - name: work\n    tools: [Read, Edit]\n    prompt: "{{input}}"\n`;
  const saved = await call<{ name: string; yaml: string; spec: { name: string } }>('PUT', `/api/teams/team/flows/${MY_FLOW}`, { yaml });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.spec.name, MY_FLOW);
  assert.equal((await call<{ yaml: string }>('GET', `/api/teams/team/flows/${MY_FLOW}`)).body.yaml, yaml);
  assert.deepEqual((await call<TeamDetail>('GET', '/api/teams/team')).body.flows, [...TEMPLATE_FLOWS, MY_FLOW].sort());
  assert.equal((await call<TeamDetail>('PUT', '/api/teams/team', { defaultFlow: MY_FLOW })).body.defaultFlow, MY_FLOW);
  // flow шаблона читается и проходит схему
  for (const name of TEMPLATE_FLOWS) {
    const f = await call<{ spec?: unknown; error?: string }>('GET', `/api/teams/team/flows/${name}`);
    assert.equal(f.status, 200, name);
    assert.ok(f.body.spec, `${name}: ${f.body.error}`);
  }
  // local.json: пути репо кода и привязки пространств
  assert.equal((await call('PUT', '/api/teams/team/local', { repoPaths: { 'git@github.com:acme/billing.git': 'relative' } })).status, 400);
  const local = await call<{ repoPaths: Record<string, string>; projectSpaces: Record<string, string> }>('PUT', '/api/teams/team/local', { repoPaths: { 'git@github.com:acme/billing.git': proj }, projectSpaces: { export: 'billing-export' } });
  assert.deepEqual(local.body, { repoPaths: { 'git@github.com:acme/billing.git': proj }, projectSpaces: { export: 'billing-export' } });
  const p = await call<TeamProject>('GET', P);
  assert.equal(p.body.repos[0].local, proj);
  assert.equal(p.body.space, 'billing-export');
  await call('PUT', '/api/teams/team/local', { projectSpaces: { export: null } });
  assert.equal((await call<TeamProject>('GET', P)).body.space, undefined);
  // всё это время ничего не отправлялось (таймеры выключены): sync отправляет
  const before = (await call<TeamDetail>('GET', '/api/teams/team')).body.sync;
  assert.equal(before.state, 'pending');
  assert.ok(before.unpushed > 5);
  const sync = await call<TeamSync>('POST', '/api/teams/team/sync');
  assert.equal(sync.status, 200);
  assert.equal(sync.body.state, 'ok');
  assert.equal(sync.body.unpushed, 0);
  assert.deepEqual(git(bare, 'log', '-2', '--format=%s', 'main').split('\n'), ['Настройки команды: flow по умолчанию', `flow ${MY_FLOW}: добавлен`]);
});

test('конфликты: после sync одно поле с двух сторон даёт запись в списке, «взять моё» пишет коммит, «оставить команды» снимает запись', async () => {
  // коллега: отдельный клон bare меняет оценку PAY-2 и отправляет
  const work = path.join(home, 'colleague');
  git(home, 'clone', '-q', bare, work);
  const file = path.join(work, 'projects', 'export', 'tasks', 'PAY-2.md');
  const edit = (from: RegExp, to: string, msg: string) => {
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to));
    git(work, '-c', 'user.name=Боб', '-c', 'user.email=bob@example.com', 'commit', '-q', '-am', msg);
    git(work, 'push', '-q', 'origin', 'main');
  };
  edit(/^status: todo$/m, 'status: review', 'PAY-2: статус ревью');
  await call('PATCH', `${P}/tasks/PAY-2`, { status: 'in_progress' });
  const sync = await call<TeamSync>('POST', '/api/teams/team/sync');
  assert.equal(sync.body.state, 'conflict');
  assert.equal(sync.body.conflicts, 1);
  assert.equal((await call<TeamTask>('GET', `${P}/tasks/PAY-2`)).body.status, 'review');
  const list = await call<{ id: string; kind: string; field?: string; task?: string; ours: unknown; theirs: unknown; theirsBy?: string }[]>('GET', '/api/teams/team/conflicts');
  assert.equal(list.body.length, 1);
  const c = list.body[0];
  assert.deepEqual([c.kind, c.field, c.task, c.ours, c.theirs, c.theirsBy], ['field', 'status', 'PAY-2', 'in_progress', 'review', 'bob@example.com']);
  assert.equal((await call('POST', '/api/teams/team/conflicts/ffffff/mine')).status, 404);
  const mine = await call<unknown[]>('POST', `/api/teams/team/conflicts/${c.id}/mine`);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body, []);
  assert.equal((await call<TeamTask>('GET', `${P}/tasks/PAY-2`)).body.status, 'in_progress');
  assert.equal((await call<{ message: string }[]>('GET', `${P}/history?limit=1`)).body[0].message, 'PAY-2: взято моё (status)');
  assert.equal((await call<TeamSync>('POST', '/api/teams/team/sync')).body.state, 'ok');
  // второй конфликт — «оставить версию команды»: запись снимается, задача как у команды
  git(work, 'pull', '-q', '--rebase', 'origin', 'main');
  edit(/^title: .*$/m, 'title: От Боба', 'PAY-2: имя');
  await call('PATCH', `${P}/tasks/PAY-2`, { title: 'От меня' });
  await call('POST', '/api/teams/team/sync');
  const second = (await call<{ id: string }[]>('GET', '/api/teams/team/conflicts')).body;
  assert.equal(second.length, 1);
  assert.deepEqual((await call<unknown[]>('DELETE', `/api/teams/team/conflicts/${second[0].id}`)).body, []);
  assert.equal((await call<TeamTask>('GET', `${P}/tasks/PAY-2`)).body.title, 'От Боба');
  assert.equal((await call<TeamSync>('POST', '/api/teams/team/sync')).body.state, 'ok');
});

test('событие team в /api/events после записи; отключение с неотправленными — 409 unpushed, с force — удаление', async () => {
  const res = await fetch(`${base}/api/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const next = async (): Promise<Record<string, unknown>> => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('поток закрылся');
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/^data: (.+)$/m);
      if (m) return JSON.parse(m[1]) as Record<string, unknown>;
    }
  };
  const pending = Promise.race([next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('события team не было 10 с')), 10_000).unref())]);
  const patched = await call<TeamTask>('PATCH', `${P}/tasks/PAY-2`, { title: 'Экспорт в 1С (CP1251)' });
  assert.equal(patched.status, 200);
  assert.deepEqual(await pending, { type: 'team', runId: '', flow: '', team: 'team', projects: ['export'] });
  await reader.cancel();
  const refused = await call<Err & { unpushed: number; commits: string[] }>('DELETE', '/api/teams/team');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'unpushed');
  assert.deepEqual(refused.body.commits, ['PAY-2: переименована: Экспорт в 1С (CP1251)']);
  assert.equal((await call('GET', '/api/teams/team')).status, 200);
  assert.equal((await call('DELETE', '/api/teams/team?force=true')).status, 200);
  assert.equal((await call('GET', '/api/teams/team')).status, 404);
  assert.deepEqual((await call('GET', '/api/teams')).body, []);
  assert.equal(fs.existsSync(path.join(teamsDir(), 'team')), false);
});
