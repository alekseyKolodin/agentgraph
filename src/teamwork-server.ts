// Teamwork: сервис команды и маршруты /api/teams (spec §12), по образцу integrationsRoute. Сервис читает клоны через
// TeamRepo и пишет через его очередь (коммит на запись); ответы — типы Teamwork из src/api-types.ts; ошибки — { error } с
// 400, 404, 409 (code: not_empty, is_team, conflict, unpushed, busy, readonly). Конфликты синхронизации (spec §7.4) —
// GET …/conflicts, DELETE …/conflicts/:id («оставить версию команды»), POST …/conflicts/:id/mine («взять мою»: поле, текст
// или удалённый файл одним коммитом; «править вручную» — обычный PUT/PATCH). Черновики агентов (…/drafts*) — объект
// TeamDrafts из teamwork-drafts.ts в deps маршрута; текст задачи для запуска (…/intake) и worktree задачи (…/worktree)
// добавляет сессия work волны 2 — их маршруты не заняты.
import path from 'node:path';
import { parseFlow } from './flows.js';
import { exec, parseRemote, type Exec } from './git.js';
import { describeProjects } from './projects.js';
import { loadSettings } from './settings.js';
import type { FlowSpec } from './schema.js';
import type { TeamDrafts } from './teamwork-drafts.js';
import { PROJECT_TEMPLATE_DIR, projectDocs, TEMPLATE_DIR } from './teamwork-template.js';
import { checkRemote, createTeam, defaultRepoDeps, joinTeam, TASK_FILE_RE, TeamError, TeamRepo, type ChangeEvent, type RepoDeps } from './teamwork-repo.js';
import {
  commentFileName, composeTask, DOC_FILES, docFile, docLabel, docTitle, findSection, FLOW_NAME_RE, isDocName, nextRequirementId, nextTaskId, parseComment,
  parseProject, parseRequirements, parseSprint, parseTask, PROJECT_STATUSES, rankNear, remoteProblem, replaceSection, requirementMax, sectionHash, serializeComment,
  serializeProject, serializeSprint, serializeTask, sortTasks, splitSections, sprintSummary, sprintView, TASK_ID_RE, TASK_STATUSES, TASK_TYPES, taskChangeMessage,
  taskFrontmatter, taskView, TEAM_SLUG_RE, teamsDir, textHash, updateYaml, type ProjectConfig, type ProjectRepo, type SprintFile, type TaskFile, type TeamConfig,
} from './teamwork.js';
import type {
  TeamColumns, TeamComment, TeamConflict, TeamDetail, TeamDoc, TeamDocBrief, TeamDocName, TeamDocRevision, TeamFlow as TeamFlowOf, TeamHistoryItem, TeamLocal, TeamMe, TeamMember,
  TeamProject, TeamProjectBrief, TeamRemoteCheck, TeamRepoRef, TeamSprint, TeamSummary, TeamSync, TeamTask, TeamTaskMove, TeamTaskPatch, TeamTaskStatus, TeamTaskType,
  TeamTaskWork,
} from './api-types.js';

export type Reply = { status: number; body: unknown };

export type TeamServiceDeps = {
  /** Корень команд; по умолчанию teamsDir() при каждом обращении (тесты подменяют AGENTGRAPH_CONFIG_DIR). */
  root?: () => string;
  repo?: Partial<RepoDeps>;
  /** Открыт ли UI (/api/events): получение каждые 30 с, иначе раз в 5 минут. */
  hasSubscribers?: () => boolean;
  /** Таймеры: отправка через 3 с после записи, получение по расписанию, фоновый pull при открытии экрана; false — только явный POST /sync (тесты). */
  timers?: boolean;
  /** Локальная папка репо кода по ссылке: по умолчанию среди проектов дашборда по origin. */
  findLocal?: (url: string) => Promise<string | undefined>;
  /** Живой статус запуска или сессии по задаче (TeamTask.work): сервер сверяет запись local.json с идущими запусками и сессиями. */
  workStatus?: (work: TeamTaskWork) => TeamTaskWork;
};

/** Новая задача (POST …/tasks): dependsOn — ключи соседей по пачке или номера существующих задач, становятся blockedBy. */
export type NewTask = {
  key?: string;
  title: string;
  type?: TeamTaskType;
  body?: string;
  description?: string;
  acceptance?: string[];
  estimate?: number;
  repo?: string;
  assignee?: string;
  sprint?: number;
  blockedBy?: string[];
  dependsOn?: string[];
  covers?: string[];
};

export type WriteDocOptions = { base?: string; section?: string; hash?: string; message?: string };
export type TaskWriteOptions = { message?: string; author?: { name: string; email: string } };
export type NewSprint = { title?: string; goal?: string; start?: boolean; tasks?: string[] };
export type CloseSprint = { next?: string[]; backlog?: string[] };
export type TeamFlow = TeamFlowOf<FlowSpec>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
function bad(msg: string): never {
  throw new TeamError(400, msg);
}
const optStr = (v: unknown, field: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') bad(`Поле ${field} — строка`);
  return (v as string).trim();
};
const reqStr = (v: unknown, field: string, what = `Укажи ${field}`): string => {
  const s = optStr(v, field);
  if (!s) bad(what);
  return s!;
};
const strArr = (v: unknown, field: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) bad(`Поле ${field} — список строк`);
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
};
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
const DOC_UPDATED: Record<string, string> = { prd: 'ТЗ обновлено', architecture: 'архитектура обновлена', design: 'дизайн обновлён' };

/** Локальная папка репо кода среди проектов дашборда по origin (spec §5.3). */
export async function findLocalRepo(url: string, x: Exec = exec): Promise<string | undefined> {
  const r = parseRemote(url);
  if (!r) return undefined;
  const projects = await describeProjects(loadSettings(), x).catch(() => []);
  return projects.find((p) => p.remote && p.remote.host === r.host && p.remote.path === r.path)?.path;
}

/**
 * Сервис команд: открывает клоны по слагу, держит их таймеры, пересылает события изменений (после записи или pull) и
 * собирает ответы API. Методы для сессий work и drafts: readTeamFlow, updateTask, createTasks, writeDoc, recordWork, onChange, stop.
 */
export class TeamService {
  private repos = new Map<string, TeamRepo>();
  private listeners = new Set<(e: ChangeEvent) => void>();
  private readonly repoDeps: RepoDeps;
  private stopped = false;

  constructor(private readonly deps: TeamServiceDeps = {}) {
    this.repoDeps = { ...defaultRepoDeps(), ...(deps.timers === false ? { pushDelayMs: Infinity } : {}), ...(deps.repo ?? {}) };
  }

  root(): string {
    return this.deps.root ? this.deps.root() : teamsDir();
  }

  onChange(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ChangeEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.repos.values()].map((r) => r.stop()));
    this.repos.clear();
  }

  /** Клон команды; нет такой — 404. Открытый клон подписывается на события и получает таймеры. */
  repo(slug: string): TeamRepo {
    const got = this.repos.get(slug);
    if (got) return got;
    const repo = TeamRepo.open(slug, this.repoDeps, this.root());
    if (!repo) throw new TeamError(404, `Команды ${slug} нет`);
    return this.adopt(repo);
  }

  private adopt(repo: TeamRepo): TeamRepo {
    this.repos.set(repo.slug, repo);
    repo.onChange((e) => this.emit(e));
    if (this.deps.timers !== false && !this.stopped) repo.startTimers(this.deps.hasSubscribers ?? (() => false));
    return repo;
  }

  private forget(slug: string): void {
    this.repos.delete(slug);
  }

  // ---------- команды (spec §8.1–8.2, §12)

  async listTeams(): Promise<TeamSummary[]> {
    const out: TeamSummary[] = [];
    for (const slug of TeamRepo.list(this.root())) {
      const repo = this.repo(slug);
      try {
        out.push(await this.summary(repo));
      } catch (err) {
        // teamwork.yaml не читается: команда в списке остаётся, причина — в строке синхронизации
        out.push({ slug, title: slug, prefix: '', remote: repo.local().remote, members: 0, projects: [], sync: { ...(await repo.syncState()), error: errMsg(err) } });
      }
    }
    return out;
  }

  check(url: string): Promise<TeamRemoteCheck> {
    return checkRemote(url, this.repoDeps);
  }

  async createTeam(body: { url: string; title: string; prefix: string }): Promise<TeamDetail> {
    const repo = await createTeam(body, this.repoDeps, this.root());
    return this.detail(this.adopt(repo));
  }

  async joinTeam(body: { url: string; addMe?: boolean }): Promise<TeamDetail> {
    const { repo } = await joinTeam(body, this.repoDeps, this.root());
    return this.detail(this.adopt(repo));
  }

  async removeTeam(slug: string, force: boolean): Promise<void> {
    const repo = this.repo(slug);
    await repo.disconnect(force);
    this.forget(slug);
  }

  async team(slug: string): Promise<TeamDetail> {
    const repo = this.repo(slug);
    const detail = await this.detail(repo);
    // при открытии экрана — получить в фоне, если давно не получали (spec §7.3); после ответа, чтобы его чтение не шло
    // поверх reset/rebase. Pull пришлёт событие team, и UI перечитает
    if (this.deps.timers !== false) {
      const last = Date.parse(repo.local().sync.lastFetchAt ?? '') || 0;
      if (Date.now() - last > 10_000) void repo.pull().catch(() => undefined);
    }
    return detail;
  }

  async updateTeam(slug: string, body: unknown): Promise<TeamDetail> {
    const repo = this.repo(slug);
    if (!isRecord(body)) bad('Тело запроса — объект');
    const b = body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    if (b.title !== undefined) {
      patch.title = reqStr(b.title, 'title', 'Название не может быть пустым');
      changes.push('название');
    }
    if (b.columns !== undefined) {
      if (!isRecord(b.columns)) bad('Поле columns — объект с названиями колонок');
      const cols = b.columns as Record<string, unknown>;
      const current = repo.config().columns;
      const next: TeamColumns = { ...current };
      for (const k of Object.keys(cols)) {
        if (!TASK_STATUSES.includes(k as TeamTaskStatus)) bad(`Колонки фиксированы: ${TASK_STATUSES.join(', ')}; лишний ключ ${k}`);
        next[k as TeamTaskStatus] = reqStr(cols[k], `columns.${k}`, `Название колонки ${k} не может быть пустым`);
      }
      patch.columns = next;
      changes.push('колонки');
    }
    if (b.members !== undefined) {
      if (!Array.isArray(b.members)) bad('Поле members — список участников');
      const members: TeamMember[] = [];
      for (const m of b.members as unknown[]) {
        if (!isRecord(m)) bad('Участник — объект с name и email');
        const email = reqStr(m.email, 'email', 'У участника нужен email').toLowerCase();
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) bad(`Неверный email: ${email}`);
        if (members.some((x) => x.email === email)) bad(`Email повторяется: ${email}`);
        const github = optStr(m.github, 'github');
        const gitlab = optStr(m.gitlab, 'gitlab');
        members.push({ name: optStr(m.name, 'name') || email, email, ...(github ? { github } : {}), ...(gitlab ? { gitlab } : {}) });
      }
      if (!members.length) bad('В команде должен остаться хотя бы один участник');
      patch.members = members;
      changes.push('участники');
    }
    if (b.defaultFlow !== undefined) {
      if (b.defaultFlow === null || b.defaultFlow === '') patch.defaultFlow = undefined;
      else {
        const f = reqStr(b.defaultFlow, 'defaultFlow');
        if (!FLOW_NAME_RE.test(f)) bad(`Недопустимое имя flow: ${f}`);
        if (!this.flowNames(repo).includes(f)) bad(`Flow ${f} нет в репо команды (flows/${f}.yaml)`);
        patch.defaultFlow = f;
      }
      changes.push('flow по умолчанию');
    }
    if (b.prefix !== undefined && optStr(b.prefix, 'prefix')?.toUpperCase() !== repo.config().prefix) bad('Префикс номеров задач после создания не меняется');
    if (!changes.length) return this.detail(repo);
    await repo.write(`Настройки команды: ${changes.join(', ')}`, (r) => r.writeFile('teamwork.yaml', updateYaml(r.read('teamwork.yaml') ?? '', patch)));
    return this.detail(repo);
  }

  /** Синхронизировать сейчас: ошибка сети остаётся строкой синхронизации, а не кодом ответа. */
  async sync(slug: string): Promise<TeamSync> {
    const repo = this.repo(slug);
    try {
      return await repo.sync();
    } catch {
      return repo.syncState();
    }
  }

  local(slug: string): TeamLocal {
    const l = this.repo(slug).local();
    return { repoPaths: l.repoPaths, projectSpaces: l.projectSpaces };
  }

  updateLocal(slug: string, body: unknown): TeamLocal {
    const repo = this.repo(slug);
    if (!isRecord(body)) bad('Тело запроса — объект');
    const b = body as Record<string, unknown>;
    const merge = (target: Record<string, string>, src: unknown, field: string, check?: (k: string, v: string) => void) => {
      if (src === undefined) return;
      if (!isRecord(src)) bad(`Поле ${field} — объект`);
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (v === null || v === '') delete target[k];
        else {
          if (typeof v !== 'string') bad(`Поле ${field}.${k} — строка`);
          check?.(k, v as string);
          target[k] = v as string;
        }
      }
    };
    repo.saveLocal((l) => {
      merge(l.repoPaths, b.repoPaths, 'repoPaths', (_k, v) => {
        if (!path.isAbsolute(v)) bad(`Путь к репо кода должен быть абсолютным: ${v}`);
      });
      merge(l.projectSpaces, b.projectSpaces, 'projectSpaces');
    });
    // привязки пространств видны в проекте, пути репо — во всех проектах с этим репо: UI сбрасывает кэш команды целиком
    this.emit({ team: slug, projects: isRecord(b.projectSpaces) && b.repoPaths === undefined ? Object.keys(b.projectSpaces as object).sort() : this.repo(slug).dirs('projects') });
    return this.local(slug);
  }

  private async summary(repo: TeamRepo): Promise<TeamSummary> {
    const cfg = repo.config();
    return {
      slug: repo.slug,
      title: cfg.title,
      prefix: cfg.prefix,
      remote: repo.local().remote,
      members: cfg.members.length,
      projects: this.projectBriefs(repo),
      sync: await repo.syncState(),
    };
  }

  private async detail(repo: TeamRepo): Promise<TeamDetail> {
    const cfg = repo.config();
    return {
      ...(await this.summary(repo)),
      format: cfg.format,
      columns: cfg.columns,
      memberList: cfg.members,
      ...(cfg.defaultFlow ? { defaultFlow: cfg.defaultFlow } : {}),
      me: await this.me(repo, cfg),
      flows: this.flowNames(repo),
      dir: repo.repoDir,
    };
  }

  private async me(repo: TeamRepo, cfg: TeamConfig): Promise<TeamMe> {
    const id = await repo.identity();
    return { ...id, inTeam: Boolean(id.email && cfg.members.some((m) => m.email === id.email)) };
  }

  // ---------- конфликты синхронизации (spec §7.4)

  conflicts(slug: string): TeamConflict[] {
    return this.repo(slug).local().conflicts;
  }

  /**
   * Решить конфликт: theirs — оставить версию команды (запись просто снимается); mine — записать моё значение коммитом:
   * поле задачи или YAML, тело задачи, текст документа, удалённый файл. Для двух активных спринтов «моё» нет: задачи
   * переносятся в активный спринт руками.
   */
  async resolveConflict(slug: string, id: string, how: 'theirs' | 'mine'): Promise<TeamConflict[]> {
    const repo = this.repo(slug);
    const c = repo.local().conflicts.find((x) => x.id === id);
    if (!c) throw new TeamError(404, 'Такого конфликта нет: он уже решён');
    if (how === 'mine') {
      if (c.kind === 'sprint') bad('Для двух активных спринтов «взять моё» нет: перенеси задачи в активный спринт');
      const label = c.task ?? c.doc ?? c.file;
      await repo.write(`${label}: взято моё${c.field ? ` (${c.field})` : ''}`, (r) => {
        const current = r.read(c.file);
        if (c.kind === 'deleted') {
          if (c.ours === null || c.ours === undefined) r.remove(c.file);
          else r.writeFile(c.file, String(c.ours));
          return;
        }
        if (current === undefined) throw new TeamError(409, `Файла ${c.file} больше нет в репо команды`, 'conflict');
        if (c.kind === 'text' && (!c.field || c.field === 'text')) return r.writeFile(c.file, String(c.ours));
        if (TASK_FILE_RE.test(c.file)) {
          const t = parseTask(current, c.file);
          if (t.error) throw new TeamError(409, `Задача ${c.task} не читается (${t.error})`, 'conflict');
          if (c.field === 'body') return r.writeFile(c.file, composeTask(taskFrontmatter(t), String(c.ours)));
          const fm = taskFrontmatter(t);
          if (c.ours === undefined || c.ours === null) delete fm[c.field!];
          else fm[c.field!] = c.ours;
          return r.writeFile(c.file, composeTask(fm, t.body));
        }
        if (/\.ya?ml$/.test(c.file) && c.field) return r.writeFile(c.file, updateYaml(current, { [c.field]: c.ours ?? undefined }));
        r.writeFile(c.file, String(c.ours));
      });
    }
    repo.saveLocal((l) => (l.conflicts = l.conflicts.filter((x) => x.id !== id)));
    if (how === 'theirs') this.emit({ team: slug, projects: c.project ? [c.project] : [] });
    return repo.local().conflicts;
  }

  // ---------- проекты (spec §8.3)

  private projectSlug(slug: string): string {
    if (!TEAM_SLUG_RE.test(slug)) bad(`Неверный слаг проекта: ${slug}`);
    return slug;
  }

  private readProjectConfig(repo: TeamRepo, slug: string): ProjectConfig {
    const text = repo.read(`projects/${this.projectSlug(slug)}/project.yaml`);
    if (text === undefined) throw new TeamError(404, `Проекта ${slug} нет`);
    try {
      return parseProject(text, slug);
    } catch (err) {
      throw new TeamError(500, `project.yaml проекта ${slug} не читается: ${errMsg(err)}`);
    }
  }

  private readTasks(repo: TeamRepo, slug: string): TaskFile[] {
    const dir = `projects/${slug}/tasks`;
    const work = repo.local().work;
    return sortTasks(
      repo.list(dir, (n) => /\.md$/i.test(n)).map((name) => {
        const rel = `${dir}/${name}`;
        const t = parseTask(repo.read(rel) ?? '', rel);
        t.comments = repo.list(`projects/${slug}/comments/${t.id}`, (n) => /\.md$/i.test(n)).length;
        if (work[t.id]?.length) t.work = this.deps.workStatus ? work[t.id].map(this.deps.workStatus) : work[t.id];
        return t;
      }),
    );
  }

  /** Все номера задач команды, по всем проектам: номер сквозной (spec §5.7). */
  private allTaskIds(repo: TeamRepo): string[] {
    return repo.dirs('projects').flatMap((p) => repo.list(`projects/${p}/tasks`, (n) => /\.md$/i.test(n)).map((n) => n.replace(/\.md$/i, '')));
  }

  /** Следующий номер спринта — по именам файлов, не по разобранным: битый sprints/3.yaml номер не освобождает. */
  private nextSprintNumberIn(repo: TeamRepo, slug: string): number {
    return repo.list(`projects/${slug}/sprints`, (n) => /^\d+\.ya?ml$/.test(n)).reduce((m, n) => Math.max(m, Number(n.split('.')[0])), 0) + 1;
  }

  private readSprints(repo: TeamRepo, slug: string): SprintFile[] {
    const dir = `projects/${slug}/sprints`;
    const out: SprintFile[] = [];
    for (const name of repo.list(dir, (n) => /^\d+\.ya?ml$/.test(n))) {
      try {
        out.push(parseSprint(repo.read(`${dir}/${name}`) ?? '', Number(name.split('.')[0])));
      } catch {
        // битый спринт: пропускаем, его видно в истории
      }
    }
    return out.sort((a, b) => a.number - b.number);
  }

  private projectBriefs(repo: TeamRepo): TeamProjectBrief[] {
    return repo.dirs('projects').map((slug) => {
      let cfg: ProjectConfig;
      try {
        cfg = this.readProjectConfig(repo, slug);
      } catch (err) {
        return { slug, title: slug, summary: `Не читается: ${errMsg(err)}`, status: 'active', backlog: 0 };
      }
      const tasks = this.readTasks(repo, slug).filter((t) => !t.error);
      const active = this.readSprints(repo, slug).find((s) => s.status === 'active');
      return {
        slug,
        title: cfg.title,
        summary: cfg.summary,
        status: cfg.status,
        ...(active ? { sprint: { number: active.number, title: active.title, ...sprintSummary(tasks, active.number) } } : {}),
        backlog: tasks.filter((t) => t.sprint === undefined).length,
      };
    });
  }

  listProjects(slug: string): TeamProjectBrief[] {
    return this.projectBriefs(this.repo(slug));
  }

  async project(team: string, slug: string): Promise<TeamProject> {
    const repo = this.repo(team);
    return this.projectView(repo, this.readProjectConfig(repo, slug));
  }

  private async projectView(repo: TeamRepo, cfg: ProjectConfig): Promise<TeamProject> {
    const local = repo.local();
    const repos: TeamRepoRef[] = [];
    for (const r of cfg.repos) {
      const found = local.repoPaths[r.url] ?? (await (this.deps.findLocal ?? findLocalRepo)(r.url).catch(() => undefined));
      repos.push({ key: r.key, url: r.url, ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}), ...(found ? { local: found } : {}) });
    }
    const space = local.projectSpaces[cfg.slug];
    return {
      slug: cfg.slug,
      title: cfg.title,
      summary: cfg.summary,
      status: cfg.status,
      repos,
      ...(cfg.createdAt ? { createdAt: cfg.createdAt } : {}),
      ...(cfg.createdBy ? { createdBy: cfg.createdBy } : {}),
      ...(space ? { space } : {}),
      dir: repo.abs(`projects/${cfg.slug}`),
      docs: await this.docBriefs(repo, cfg.slug),
      sprints: this.readSprints(repo, cfg.slug).map(sprintView),
    };
  }

  private parseRepos(v: unknown): ProjectRepo[] {
    if (!Array.isArray(v)) bad('Поле repos — список репо кода');
    const out: ProjectRepo[] = [];
    for (const r of v as unknown[]) {
      if (!isRecord(r)) bad('Репо кода — объект с key и url');
      const key = reqStr(r.key, 'key', 'У репо кода нужен ключ');
      if (!KEY_RE.test(key)) bad(`Ключ репо — латиница, цифры, дефис: ${key}`);
      const url = reqStr(r.url, 'url', 'У репо кода нужна ссылка');
      const problem = remoteProblem(url);
      if (problem) bad(`Репо ${key}: ${problem}`);
      if (out.some((x) => x.key === key)) bad(`Ключ репо повторяется: ${key}`);
      const defaultBranch = optStr(r.defaultBranch, 'defaultBranch');
      out.push({ key, url, ...(defaultBranch ? { defaultBranch } : {}) });
    }
    return out;
  }

  async createProject(team: string, body: unknown): Promise<TeamProject> {
    const repo = this.repo(team);
    if (!isRecord(body)) bad('Тело запроса — объект');
    const b = body as Record<string, unknown>;
    const slug = reqStr(b.slug, 'slug', 'Укажи slug проекта');
    if (!TEAM_SLUG_RE.test(slug)) bad('Slug проекта — латиница в нижнем регистре, цифры и дефис');
    const title = reqStr(b.title, 'title', 'Укажи название проекта');
    const summary = optStr(b.summary, 'summary') ?? '';
    const repos = b.repos === undefined ? [] : this.parseRepos(b.repos);
    const me = await repo.requireIdentity();
    let cfg!: ProjectConfig;
    await repo.write(`${slug}: проект создан`, (r) => {
      if (r.exists(`projects/${slug}`)) throw new TeamError(409, `Проект ${slug} уже есть`, 'not_empty');
      cfg = { slug, title, summary, status: 'active', repos, createdAt: this.repoDeps.now().toISOString(), createdBy: me.email, extra: {} };
      r.writeFile(`projects/${slug}/project.yaml`, serializeProject(cfg));
      const docs = projectDocs({ title, summary }, [r.abs(PROJECT_TEMPLATE_DIR), path.join(this.repoDeps.templateDir ?? TEMPLATE_DIR, PROJECT_TEMPLATE_DIR)]);
      for (const [file, text] of Object.entries(docs)) r.writeFile(`projects/${slug}/${file}`, text);
    });
    return this.projectView(repo, cfg);
  }

  async updateProject(team: string, slug: string, body: unknown): Promise<TeamProject> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    if (!isRecord(body)) bad('Тело запроса — объект');
    const b = body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    if (b.title !== undefined) {
      patch.title = reqStr(b.title, 'title', 'Название не может быть пустым');
      changes.push('название');
    }
    if (b.summary !== undefined) {
      patch.summary = optStr(b.summary, 'summary') ?? '';
      changes.push('суть');
    }
    if (b.status !== undefined) {
      const st = optStr(b.status, 'status');
      if (!PROJECT_STATUSES.includes(st as ProjectConfig['status'])) bad(`Статус проекта: ${PROJECT_STATUSES.join(' | ')}`);
      patch.status = st;
      changes.push(st === 'archived' ? 'в архив' : 'снова активен');
    }
    if (b.repos !== undefined) {
      patch.repos = this.parseRepos(b.repos);
      changes.push('репо кода');
    }
    if (b.slug !== undefined && b.slug !== slug) bad('Slug проекта не меняется');
    if (changes.length) await repo.write(`${slug}: ${changes.join(', ')}`, (r) => r.writeFile(`projects/${slug}/project.yaml`, updateYaml(r.read(`projects/${slug}/project.yaml`) ?? '', patch)));
    return this.projectView(repo, this.readProjectConfig(repo, slug));
  }

  // ---------- документы (spec §8.4)

  private docPath(slug: string, name: string): { name: TeamDocName; rel: string } {
    const file = docFile(name);
    if (!file || !isDocName(name)) throw new TeamError(400, `Недопустимое имя документа: ${name}`);
    return { name, rel: `projects/${slug}/${file}` };
  }

  private async docBriefs(repo: TeamRepo, slug: string): Promise<TeamDocBrief[]> {
    const names: string[] = [...Object.keys(DOC_FILES).filter((n) => repo.exists(`projects/${slug}/${DOC_FILES[n as keyof typeof DOC_FILES]}`)), ...repo.list(`projects/${slug}/docs`, (n) => /\.md$/i.test(n)).map((n) => `docs/${n}`)];
    const out: TeamDocBrief[] = [];
    for (const name of names) {
      if (!isDocName(name)) continue;
      const { rel } = this.docPath(slug, name);
      const text = repo.read(rel) ?? '';
      const [last] = await repo.history({ path: rel, limit: 1 });
      out.push({ name, title: docTitle(text, docLabel(name)), size: Buffer.byteLength(text), ...(last ? { updatedAt: last.at, updatedBy: last.email } : {}) });
    }
    return out;
  }

  async doc(team: string, slug: string, name: string): Promise<TeamDoc> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    const { rel } = this.docPath(slug, name);
    if (!repo.exists(rel)) throw new TeamError(404, `Документа ${name} нет`);
    return this.docView(repo, slug, name);
  }

  private async docView(repo: TeamRepo, slug: string, name: string): Promise<TeamDoc> {
    const { rel } = this.docPath(slug, name);
    const text = repo.read(rel) ?? '';
    const [last] = await repo.history({ path: rel, limit: 1 });
    const cfg = this.readProjectConfig(repo, slug);
    const requirements = parseRequirements(text);
    return {
      name: name as TeamDocName,
      text,
      base: textHash(text),
      sections: docSections(text),
      ...(last ? { updatedAt: last.at, updatedBy: last.email } : {}),
      requirements,
      nextRequirement: { FR: nextRequirementId(text, 'FR', cfg.lastRequirement), NFR: nextRequirementId(text, 'NFR', cfg.lastRequirement) },
    };
  }

  /**
   * Сохранить документ целиком (base — хэш файла) или один раздел (section — заголовок, hash — хэш раздела на момент
   * начала правки): 409 conflict только если менялся этот раздел, правки в других разделах не мешают. Номера требований
   * ТЗ, выданные документом, запоминаются в project.yaml → lastRequirement.
   */
  async writeDoc(team: string, slug: string, name: string, text: string, o: WriteDocOptions = {}): Promise<TeamDoc> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    const { rel } = this.docPath(slug, name);
    if (typeof text !== 'string') bad('Поле text — строка');
    const label = DOC_UPDATED[name] ?? `документ ${docLabel(name)} обновлён`;
    const message = o.message?.trim() || (o.section !== undefined ? `${slug}: ${label}, раздел «${o.section || 'начало'}»` : `${slug}: ${label}`);
    await repo.write(message, async (r) => {
      const current = r.read(rel);
      if (current === undefined && (o.section !== undefined || o.base)) throw new TeamError(404, `Документа ${name} нет`);
      let next: string;
      if (o.section !== undefined) {
        const sec = findSection(current ?? '', o.section);
        if (!sec) throw new TeamError(404, `Раздела «${o.section}» нет в документе`);
        if (o.hash && sectionHash(sec.text) !== o.hash) throw new TeamError(409, `Раздел «${o.section}» уже изменил кто-то другой`, 'conflict', { current: await this.docView(r, slug, name) });
        next = replaceSection(current ?? '', o.section, text);
      } else {
        if (o.base && textHash(current ?? '') !== o.base) throw new TeamError(409, 'Документ уже изменил кто-то другой', 'conflict', { current: await this.docView(r, slug, name) });
        next = text.endsWith('\n') || !text ? text : `${text}\n`;
      }
      r.writeFile(rel, next);
      if (name === 'prd') {
        const cfg = this.readProjectConfig(r, slug);
        const max = requirementMax(next);
        const last = { FR: Math.max(cfg.lastRequirement?.FR ?? 0, max.FR), NFR: Math.max(cfg.lastRequirement?.NFR ?? 0, max.NFR) };
        if (last.FR !== (cfg.lastRequirement?.FR ?? 0) || last.NFR !== (cfg.lastRequirement?.NFR ?? 0)) {
          r.writeFile(`projects/${slug}/project.yaml`, updateYaml(r.read(`projects/${slug}/project.yaml`) ?? '', { lastRequirement: last }));
        }
      }
    });
    return this.docView(repo, slug, name);
  }

  history(team: string, slug: string, o: { doc?: string; limit?: number } = {}): Promise<TeamHistoryItem[]> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    const p = o.doc ? this.docPath(slug, o.doc).rel : `projects/${slug}`;
    return repo.history({ path: p, ...(Number.isFinite(o.limit) ? { limit: o.limit } : {}) });
  }

  /** Документ до и после коммита из истории (spec §8.4 «История» — дифф): файла в одной из версий нет — пустая строка. */
  async docRevision(team: string, slug: string, name: string, hash: string): Promise<TeamDocRevision> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    const { rel } = this.docPath(slug, name);
    if (!/^[0-9a-f]{7,40}$/.test(hash)) bad('hash — номер коммита');
    const show = (ref: string) => repo.git(['show', `${ref}:${rel}`]).catch(() => undefined);
    const after = await show(hash);
    const before = await show(`${hash}^`);
    if (after === undefined && before === undefined) throw new TeamError(404, `В коммите ${hash.slice(0, 7)} нет документа ${name}`);
    return { name: name as TeamDocName, hash, before: before ?? '', after: after ?? '' };
  }

  // ---------- задачи (spec §8.5–8.7)

  private taskId(id: string): string {
    if (!TASK_ID_RE.test(id)) bad(`Неверный номер задачи: ${id}`);
    return id;
  }

  tasks(team: string, slug: string): TeamTask[] {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    return this.readTasks(repo, slug).map(taskView);
  }

  task(team: string, slug: string, id: string): TeamTask {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    return taskView(this.readTask(repo, slug, this.taskId(id)));
  }

  private readTask(repo: TeamRepo, slug: string, id: string): TaskFile {
    const t = this.readTasks(repo, slug).find((x) => x.id === id);
    if (!t) throw new TeamError(404, `Задачи ${id} нет в проекте ${slug}`);
    return t;
  }

  /** Пачка задач одним коммитом: номера сквозные по команде, порядок — в конец бэклога или спринта, dependsOn → blockedBy. */
  async createTasks(team: string, slug: string, items: NewTask[], o: TaskWriteOptions = {}): Promise<TeamTask[]> {
    const repo = this.repo(team);
    const project = this.readProjectConfig(repo, slug);
    if (!Array.isArray(items) || !items.length) bad('Нужна хотя бы одна задача');
    const me = await repo.requireIdentity();
    const prefix = repo.config().prefix;
    const created: TaskFile[] = [];
    const message = () => (created.length === 1 ? `${created[0].id}: создана — ${created[0].title}` : { subject: `${slug}: ${created.length} задач добавлено`, body: created.map((t) => `- ${t.id}: ${t.title}`).join('\n') });
    await repo.write(message, async (r) => {
      const existing = this.readTasks(r, slug);
      const sprints = this.readSprints(r, slug);
      const ids = new Set(this.allTaskIds(r));
      const keys = new Map<string, string>();
      const drafts: { item: NewTask; id: string }[] = [];
      for (const item of items) {
        if (!isRecord(item)) bad('Задача — объект');
        const id = nextTaskId(ids, prefix);
        ids.add(id);
        if (item.key !== undefined) {
          const k = reqStr(item.key, 'key');
          if (keys.has(k)) bad(`Ключ ${k} повторяется`);
          keys.set(k, id);
        }
        drafts.push({ item, id });
      }
      const lastRank = (sprint: number | undefined) => existing.filter((t) => !t.error && t.sprint === sprint).map((t) => t.rank).sort().pop();
      const ranks = new Map<number | undefined, string | undefined>();
      const now = this.repoDeps.now().toISOString();
      for (const { item, id } of drafts) {
        const title = reqStr(item.title, 'title', 'У задачи нужен заголовок');
        const type = item.type === undefined ? 'feature' : item.type;
        if (!TASK_TYPES.includes(type)) bad(`Тип задачи: ${TASK_TYPES.join(' | ')}`);
        const sprint = item.sprint === undefined || item.sprint === null ? undefined : item.sprint;
        if (sprint !== undefined && !sprints.some((s) => s.number === sprint && s.status !== 'closed')) bad(`Спринта ${sprint} нет или он закрыт`);
        const estimate = item.estimate === undefined || item.estimate === null ? undefined : item.estimate;
        if (estimate !== undefined && (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0)) bad('Оценка — число очков');
        const repoKey = optStr(item.repo, 'repo') || undefined;
        if (repoKey && !project.repos.some((x) => x.key === repoKey)) bad(`В проекте нет репо ${repoKey}`);
        const deps = [...(item.blockedBy ? strArr(item.blockedBy, 'blockedBy') : []), ...(item.dependsOn ? strArr(item.dependsOn, 'dependsOn') : [])];
        const blockedBy = [...new Set(deps.map((d) => keys.get(d) ?? d))];
        for (const d of blockedBy) if (d === id || (!existing.some((t) => t.id === d) && ![...keys.values()].includes(d))) bad(`Неизвестная зависимость: ${d}`);
        const body = typeof item.body === 'string' ? item.body : composeBody(item);
        const prev = ranks.has(sprint) ? ranks.get(sprint) : lastRank(sprint);
        const rank = rankNear(prev);
        ranks.set(sprint, rank);
        const file = `projects/${slug}/tasks/${id}.md`;
        const assignee = optStr(item.assignee, 'assignee') || undefined;
        const t: TaskFile = {
          id, title, type, status: 'todo', ...(sprint !== undefined ? { sprint } : {}), rank, ...(assignee ? { assignee } : {}), ...(estimate !== undefined ? { estimate } : {}),
          ...(repoKey ? { repo: repoKey } : {}), blockedBy, covers: item.covers ? strArr(item.covers, 'covers') : [], createdAt: now, createdBy: me.email, body, acceptance: { done: 0, total: 0 },
          comments: 0, base: '', file, extra: {},
        };
        r.writeFile(file, serializeTask(t));
        created.push(t);
      }
    }, o);
    return created.map((t) => taskView(this.readTask(repo, slug, t.id)));
  }

  /** PATCH задачи: изменённые поля и base (409 conflict, если задачу успели поменять); null снимает поле. */
  async updateTask(team: string, slug: string, id: string, patch: TeamTaskPatch, o: TaskWriteOptions = {}): Promise<TeamTask> {
    return this.changeTask(team, slug, this.taskId(id), patch, {}, o);
  }

  /** Перенос: статус, спринт и место между соседями (after — после кого, before — перед кем) одной операцией. */
  async moveTask(team: string, slug: string, id: string, move: TeamTaskMove, o: TaskWriteOptions = {}): Promise<TeamTask> {
    this.taskId(id);
    const patch: TeamTaskPatch = {};
    if (move.status !== undefined) patch.status = move.status;
    if (move.sprint !== undefined) patch.sprint = move.sprint;
    return this.changeTask(team, slug, id, patch, { before: move.before, after: move.after }, o);
  }

  private async changeTask(team: string, slug: string, id: string, patch: TeamTaskPatch, place: { before?: string; after?: string }, o: TaskWriteOptions): Promise<TeamTask> {
    const repo = this.repo(team);
    const project = this.readProjectConfig(repo, slug);
    if (!isRecord(patch)) bad('Тело запроса — объект');
    const columns = repo.config().columns;
    const me = await repo.identity();
    let message = o.message?.trim() || '';
    await repo.write(() => message, (r) => {
      const all = this.readTasks(r, slug);
      const cur = all.find((t) => t.id === id);
      if (!cur) throw new TeamError(404, `Задачи ${id} нет в проекте ${slug}`);
      if (cur.error) throw new TeamError(400, `Задача ${id} не читается (${cur.error}): поправь файл ${cur.file} руками`);
      if (patch.base && patch.base !== cur.base) throw new TeamError(409, `Задачу ${id} уже изменил кто-то другой`, 'conflict', { current: taskView(cur) });
      const next: TaskFile = { ...cur, blockedBy: [...cur.blockedBy], covers: [...cur.covers], extra: { ...cur.extra } };
      const changes: string[] = [];
      if (patch.title !== undefined) {
        next.title = reqStr(patch.title, 'title', 'Заголовок не может быть пустым');
        if (next.title !== cur.title) changes.push(`переименована: ${next.title}`);
      }
      if (patch.type !== undefined) {
        if (!TASK_TYPES.includes(patch.type)) bad(`Тип задачи: ${TASK_TYPES.join(' | ')}`);
        next.type = patch.type;
        if (next.type !== cur.type) changes.push(`тип → ${next.type}`);
      }
      if (patch.status !== undefined) {
        if (!TASK_STATUSES.includes(patch.status)) bad(`Статус: ${TASK_STATUSES.join(' | ')}`);
        next.status = patch.status;
        if (next.status !== cur.status) changes.push(`статус → ${columns[next.status]}`);
      }
      if (patch.sprint !== undefined) {
        if (patch.sprint === null) delete next.sprint;
        else {
          if (!Number.isInteger(patch.sprint) || !this.readSprints(r, slug).some((s) => s.number === patch.sprint && s.status !== 'closed')) bad(`Спринта ${patch.sprint} нет или он закрыт`);
          next.sprint = patch.sprint;
        }
        if (next.sprint !== cur.sprint) changes.push(next.sprint === undefined ? 'в бэклог' : `спринт → ${next.sprint}`);
      }
      if (patch.assignee !== undefined) {
        const a = patch.assignee === null ? undefined : optStr(patch.assignee, 'assignee') || undefined;
        if (a) next.assignee = a;
        else delete next.assignee;
        if (a !== cur.assignee) changes.push(a ? `исполнитель → ${a}` : 'исполнитель снят');
      }
      if (patch.estimate !== undefined) {
        if (patch.estimate === null) delete next.estimate;
        else {
          if (typeof patch.estimate !== 'number' || !Number.isFinite(patch.estimate) || patch.estimate < 0) bad('Оценка — число очков');
          next.estimate = patch.estimate;
        }
        if (next.estimate !== cur.estimate) changes.push(next.estimate === undefined ? 'оценка снята' : `оценка → ${next.estimate}`);
      }
      if (patch.repo !== undefined) {
        const key = patch.repo === null ? undefined : optStr(patch.repo, 'repo') || undefined;
        if (key && !project.repos.some((x) => x.key === key)) bad(`В проекте нет репо ${key}`);
        if (key) next.repo = key;
        else delete next.repo;
        if (key !== cur.repo) changes.push(key ? `репо → ${key}` : 'репо снято');
      }
      if (patch.pr !== undefined) {
        // ссылка на PR и его состояние (spec §10): пишут автоматика статусов и team_task_update; без state — open
        let pr: TaskFile['pr'];
        if (patch.pr !== null) {
          if (!isRecord(patch.pr)) bad('Поле pr — { url, state? } или null');
          const url = reqStr(patch.pr.url, 'pr.url', 'Укажи ссылку на PR');
          // UI рисует её ссылкой: только http(s), без пробелов и управляющих символов
          if (!/^https?:\/\/[^\s\u0000-\u001f\u007f]+$/.test(url)) bad('Поле pr.url — ссылка на PR или MR, https://…');
          const state = patch.pr.state ?? 'open';
          if (!['open', 'merged', 'closed'].includes(state)) bad('Поле pr.state: open | merged | closed');
          pr = { url, state };
        }
        if (pr) next.pr = pr;
        else delete next.pr;
        if (pr?.url !== cur.pr?.url || pr?.state !== cur.pr?.state) changes.push(pr ? `PR ${pr.state === 'open' ? 'открыт' : pr.state === 'merged' ? 'смёржен' : 'закрыт'}: ${pr.url}` : 'PR снят');
      }
      if (patch.branch !== undefined) {
        const br = patch.branch === null ? undefined : optStr(patch.branch, 'branch') || undefined;
        if (br && (br.startsWith('-') || /\s/.test(br))) bad(`Недопустимое имя ветки: ${br}`);
        if (br) next.branch = br;
        else delete next.branch;
        if (br !== cur.branch) changes.push(br ? `ветка → ${br}` : 'ветка снята');
      }
      if (patch.blockedBy !== undefined) {
        const list = [...new Set(strArr(patch.blockedBy, 'blockedBy'))];
        for (const d of list) {
          if (d === id) bad('Задача не может ждать сама себя');
          if (!all.some((t) => t.id === d)) bad(`Неизвестная задача в blockedBy: ${d}`);
        }
        next.blockedBy = list;
        if (list.join() !== cur.blockedBy.join()) changes.push(list.length ? `ждёт ${list.join(', ')}` : 'ничего не ждёт');
      }
      if (patch.covers !== undefined) {
        next.covers = [...new Set(strArr(patch.covers, 'covers'))];
        if (next.covers.join() !== cur.covers.join()) changes.push('требования');
      }
      if (patch.body !== undefined) {
        if (typeof patch.body !== 'string') bad('Поле body — строка');
        next.body = patch.body;
        if (next.body !== cur.body) changes.push('описание');
      }
      if (place.before !== undefined || place.after !== undefined) {
        const neighbour = (ref: string | undefined, what: string) => {
          if (ref === undefined) return undefined;
          const n = all.find((t) => t.id === ref && !t.error);
          if (!n) bad(`Соседа ${ref} (${what}) нет в проекте`);
          return n!;
        };
        const after = neighbour(place.after, 'after');
        const before = neighbour(place.before, 'before');
        // соседи поменялись местами или совпали по rank (одновременные переносы), rank правлен руками — rankNear встаёт после after
        const rank = rankNear(after?.rank, before?.rank);
        if (rank !== cur.rank) {
          next.rank = rank;
          changes.push('порядок');
        }
      }
      if (!changes.length) return;
      next.updatedAt = this.repoDeps.now().toISOString();
      if (me.email) next.updatedBy = me.email;
      else delete next.updatedBy;
      if (!message) message = taskChangeMessage(id, changes);
      r.writeFile(cur.file, serializeTask(next));
    }, o);
    return taskView(this.readTask(repo, slug, id));
  }

  async deleteTask(team: string, slug: string, id: string): Promise<void> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    this.taskId(id);
    await repo.write(`${id}: удалена`, (r) => {
      if (!r.exists(`projects/${slug}/tasks/${id}.md`)) throw new TeamError(404, `Задачи ${id} нет в проекте ${slug}`);
      r.remove(`projects/${slug}/tasks/${id}.md`);
      r.remove(`projects/${slug}/comments/${id}`);
      // ссылки на удалённую задачу в blockedBy соседей снимаются тем же коммитом
      for (const t of this.readTasks(r, slug)) {
        if (t.error || !t.blockedBy.includes(id)) continue;
        r.writeFile(t.file, serializeTask({ ...t, blockedBy: t.blockedBy.filter((b) => b !== id) }));
      }
    });
  }

  /** Запуск или сессия по задаче на этом компьютере — в local.json → work (spec §6); тот же kind и id — обновляется. */
  recordWork(team: string, taskId: string, work: TeamTaskWork): void {
    const repo = this.repo(team);
    this.taskId(taskId);
    repo.saveLocal((l) => {
      const list = (l.work[taskId] ?? []).filter((w) => !(w.kind === work.kind && w.id === work.id));
      l.work[taskId] = [...list, work];
    });
    const project = repo.dirs('projects').find((p) => repo.exists(`projects/${p}/tasks/${taskId}.md`));
    this.emit({ team, projects: project ? [project] : [] });
  }

  // ---------- комментарии (spec §5.6)

  async comments(team: string, slug: string, id: string): Promise<TeamComment[]> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    this.readTask(repo, slug, this.taskId(id));
    const me = (await repo.identity()).email;
    const dir = `projects/${slug}/comments/${id}`;
    return repo
      .list(dir, (n) => /\.md$/i.test(n))
      .flatMap((name) => {
        const c = parseComment(repo.read(`${dir}/${name}`) ?? '', name);
        return c ? [{ id: c.id, author: c.author, at: c.at, text: c.text, mine: c.author === me }] : [];
      })
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  async addComment(team: string, slug: string, id: string, text: unknown): Promise<TeamComment> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    this.readTask(repo, slug, this.taskId(id));
    const body = reqStr(text, 'text', 'Комментарий пустой');
    const me = await repo.requireIdentity();
    const at = this.repoDeps.now().toISOString();
    let file = commentFileName(at, me.email);
    await repo.write(`${id}: комментарий`, (r) => {
      const dir = `projects/${slug}/comments/${id}`;
      for (let i = 2; r.exists(`${dir}/${file}`); i++) file = commentFileName(at, me.email).replace(/\.md$/, `-${i}.md`);
      r.writeFile(`${dir}/${file}`, serializeComment({ author: me.email, name: me.name, at, text: body, extra: {} }));
    });
    return { id: file.replace(/\.md$/, ''), author: me.email, at, text: body, mine: true };
  }

  // ---------- спринты (spec §8.6)

  private sprintNumber(n: string | number): number {
    const num = Number(n);
    if (!Number.isInteger(num) || num <= 0) bad(`Неверный номер спринта: ${n}`);
    return num;
  }

  sprints(team: string, slug: string): TeamSprint[] {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    return this.readSprints(repo, slug).map(sprintView);
  }

  /** Новый спринт: planned (один на проект) или сразу active со списком задач. */
  async createSprint(team: string, slug: string, body: NewSprint): Promise<TeamSprint> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    if (!isRecord(body)) bad('Тело запроса — объект');
    const me = await repo.requireIdentity();
    let out!: SprintFile;
    const start = body.start === true;
    await repo.write(() => `${slug}: спринт ${out.number} ${start ? 'запущен' : 'запланирован'}`, (r) => {
      const sprints = this.readSprints(r, slug);
      if (!start && sprints.some((s) => s.status === 'planned')) throw new TeamError(409, 'Запланированный спринт уже есть: запусти его или перенеси задачи в него', 'busy');
      if (start && sprints.some((s) => s.status === 'active')) throw new TeamError(409, 'Активный спринт уже есть: сначала заверши его', 'busy');
      const number = this.nextSprintNumberIn(r, slug);
      const goal = optStr(body.goal, 'goal');
      out = { number, title: optStr(body.title, 'title') || `Спринт ${number}`, ...(goal ? { goal } : {}), status: 'planned', extra: {} };
      if (start) this.activate(r, slug, out, body.tasks, me.email);
      r.writeFile(`projects/${slug}/sprints/${number}.yaml`, serializeSprint(out));
    });
    return sprintView(out);
  }

  /** Запустить спринт (spec §8.6): запланированный становится активным, его задачи получают «К работе». */
  async startSprint(team: string, slug: string, n: string | number, body: NewSprint = {}): Promise<TeamSprint> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    const number = this.sprintNumber(n);
    const me = await repo.requireIdentity();
    let out!: SprintFile;
    await repo.write(`${slug}: спринт ${number} запущен`, (r) => {
      const sprints = this.readSprints(r, slug);
      const s = sprints.find((x) => x.number === number);
      if (!s) throw new TeamError(404, `Спринта ${number} нет`);
      if (s.status === 'active') throw new TeamError(409, `Спринт ${number} уже активен`, 'busy');
      if (s.status === 'closed') throw new TeamError(409, `Спринт ${number} закрыт`, 'busy');
      const active = sprints.find((x) => x.status === 'active');
      if (active) throw new TeamError(409, `Активен спринт ${active.number}: сначала заверши его`, 'busy');
      const title = optStr(body.title, 'title');
      const goal = optStr(body.goal, 'goal');
      out = { ...s, ...(title ? { title } : {}), ...(goal !== undefined ? (goal ? { goal } : {}) : {}) };
      if (goal === '') delete out.goal;
      this.activate(r, slug, out, body.tasks, me.email);
      r.writeFile(`projects/${slug}/sprints/${number}.yaml`, serializeSprint(out));
    });
    return sprintView(out);
  }

  private activate(r: TeamRepo, slug: string, s: SprintFile, taskIds: unknown, email: string): void {
    s.status = 'active';
    s.startedAt = this.repoDeps.now().toISOString();
    s.startedBy = email;
    const picked = new Set(taskIds === undefined ? [] : strArr(taskIds, 'tasks'));
    const tasks = this.readTasks(r, slug);
    for (const id of picked) if (!tasks.some((t) => t.id === id && !t.error)) bad(`Задачи ${id} нет в проекте`);
    const now = this.repoDeps.now().toISOString();
    for (const t of tasks) {
      if (t.error) continue;
      const inSprint = t.sprint === s.number || picked.has(t.id);
      if (!inSprint || (t.sprint === s.number && t.status === 'todo')) continue;
      r.writeFile(t.file, serializeTask({ ...t, sprint: s.number, status: 'todo', updatedAt: now, updatedBy: email }));
    }
  }

  /** Завершить спринт: готовые остаются в нём, незавершённые — в следующий (next, создаётся при нужде) или в бэклог; итог в result. */
  async closeSprint(team: string, slug: string, n: string | number, body: CloseSprint = {}): Promise<TeamSprint> {
    const repo = this.repo(team);
    this.readProjectConfig(repo, slug);
    const number = this.sprintNumber(n);
    const me = await repo.requireIdentity();
    let out!: SprintFile;
    await repo.write(`${slug}: спринт ${number} завершён`, (r) => {
      const sprints = this.readSprints(r, slug);
      const s = sprints.find((x) => x.number === number);
      if (!s) throw new TeamError(404, `Спринта ${number} нет`);
      if (s.status !== 'active') throw new TeamError(409, `Спринт ${number} не активен`, 'busy');
      const tasks = this.readTasks(r, slug).filter((t) => !t.error && t.sprint === number);
      const toNext = new Set(body.next === undefined ? [] : strArr(body.next, 'next'));
      for (const id of toNext) if (!tasks.some((t) => t.id === id)) bad(`Задачи ${id} нет в спринте ${number}`);
      const now = this.repoDeps.now().toISOString();
      const unfinished = tasks.filter((t) => t.status !== 'done');
      const carried = unfinished.filter((t) => toNext.has(t.id));
      const returned = unfinished.filter((t) => !toNext.has(t.id));
      let nextNumber: number | undefined;
      if (carried.length) {
        const planned = sprints.find((x) => x.status === 'planned');
        if (planned) nextNumber = planned.number;
        else {
          nextNumber = this.nextSprintNumberIn(r, slug);
          r.writeFile(`projects/${slug}/sprints/${nextNumber}.yaml`, serializeSprint({ number: nextNumber, title: `Спринт ${nextNumber}`, status: 'planned', extra: {} }));
        }
      }
      for (const t of carried) r.writeFile(t.file, serializeTask({ ...t, sprint: nextNumber!, updatedAt: now, updatedBy: me.email }));
      for (const t of returned) {
        const { sprint: _s, ...rest } = t;
        r.writeFile(t.file, serializeTask({ ...rest, updatedAt: now, updatedBy: me.email }));
      }
      out = { ...s, status: 'closed', closedAt: now, closedBy: me.email, result: { done: tasks.filter((t) => t.status === 'done').map((t) => t.id), carried: carried.map((t) => t.id), returned: returned.map((t) => t.id) } };
      r.writeFile(`projects/${slug}/sprints/${number}.yaml`, serializeSprint(out));
    });
    return sprintView(out);
  }

  // ---------- flow команды (spec §11 «Процесс команды»)

  private flowNames(repo: TeamRepo): string[] {
    return repo.list('flows', (n) => /\.ya?ml$/.test(n)).map((n) => n.replace(/\.ya?ml$/, '')).filter((n) => FLOW_NAME_RE.test(n));
  }

  private flowFile(repo: TeamRepo, name: string): string {
    if (!FLOW_NAME_RE.test(name)) bad(`Недопустимое имя flow: ${name}`);
    return repo.exists(`flows/${name}.yml`) && !repo.exists(`flows/${name}.yaml`) ? `flows/${name}.yml` : `flows/${name}.yaml`;
  }

  /** Flow команды как есть: YAML и spec, если он проходит схему, иначе error (для редактора «Процесс»). */
  teamFlow(team: string, name: string): TeamFlow {
    const repo = this.repo(team);
    const rel = this.flowFile(repo, name);
    const yaml = repo.read(rel);
    if (yaml === undefined) throw new TeamError(404, `Flow ${name} нет в репо команды`);
    try {
      return { name, yaml, file: repo.abs(rel), spec: parseFlow(yaml) };
    } catch (err) {
      return { name, yaml, file: repo.abs(rel), error: errMsg(err) };
    }
  }

  /** Flow команды для запуска: невалидный — 400. */
  readTeamFlow(team: string, name: string): { spec: FlowSpec; yaml: string; file: string } {
    const f = this.teamFlow(team, name);
    if (!f.spec) throw new TeamError(400, `Flow ${name} не проходит проверку: ${f.error}`);
    return { spec: f.spec, yaml: f.yaml, file: f.file };
  }

  async writeTeamFlow(team: string, name: string, yaml: unknown): Promise<TeamFlow> {
    const repo = this.repo(team);
    const rel = this.flowFile(repo, name);
    if (typeof yaml !== 'string' || !yaml.trim()) bad('Поле yaml — текст flow');
    try {
      parseFlow(yaml as string);
    } catch (err) {
      throw new TeamError(400, errMsg(err));
    }
    const text = (yaml as string).endsWith('\n') ? (yaml as string) : `${yaml}\n`;
    await repo.write(`flow ${name}: ${repo.exists(rel) ? 'обновлён' : 'добавлен'}`, (r) => r.writeFile(rel, text));
    return this.teamFlow(team, name);
  }
}

/** Разделы документа для API: только «## », без текста до первого раздела. */
function docSections(text: string): TeamDoc['sections'] {
  return splitSections(text).flatMap((s) => (s.heading ? [{ heading: s.heading, hash: sectionHash(s.text) }] : []));
}

/** Тело задачи из описания и критериев приёмки черновика разбивки (spec §9.1). */
function composeBody(item: Pick<NewTask, 'description' | 'acceptance'>): string {
  const parts: string[] = [];
  const d = typeof item.description === 'string' ? item.description.trim() : '';
  if (d) parts.push(`## Описание\n\n${d}`);
  const acc = Array.isArray(item.acceptance) ? item.acceptance.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())) : [];
  if (acc.length) parts.push(`## Критерии приёмки\n\n${acc.map((a) => `- [ ] ${a.trim()}`).join('\n')}`);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

// ---------- маршруты (spec §12)

let service: TeamService | undefined;

/** Сервис процесса: один на сервер, создаётся при первом обращении. */
export function teamService(deps?: TeamServiceDeps): TeamService {
  service ??= new TeamService(deps);
  return service;
}

/** Остановить сервис команд (stopServer): таймеры снимаются, текущая операция дожидается. */
export async function stopTeamwork(): Promise<void> {
  const s = service;
  service = undefined;
  await s?.stop();
}

/** drafts — черновики агентов (teamwork-drafts.ts); без него маршруты …/drafts* отвечают 501. */
export type TeamworkRouteDeps = { service: TeamService; drafts?: TeamDrafts };

const ok = (body: unknown, status = 200): Reply => ({ status, body });

/** Маршрут не наш — undefined. Ошибки TeamError — их код и тело; прочие — 500. */
export async function teamworkRoute(method: string, url: URL, readBody: () => Promise<unknown>, deps: TeamworkRouteDeps): Promise<Reply | undefined> {
  const p = url.pathname;
  if (p !== '/api/teams' && !p.startsWith('/api/teams/')) return undefined;
  const svc = deps.service;
  const body = async <T = Record<string, unknown>>(): Promise<T> => {
    const b = await readBody();
    return (isRecord(b) ? b : {}) as T;
  };
  let m: RegExpMatchArray | null;
  try {
    if (p === '/api/teams' && method === 'GET') return ok(await svc.listTeams());
    if (p === '/api/teams' && method === 'POST') {
      const b = await body<{ url?: unknown; title?: unknown; prefix?: unknown }>();
      return ok(await svc.createTeam({ url: reqStr(b.url, 'url', 'Укажи ссылку на репо'), title: optStr(b.title, 'title') ?? '', prefix: optStr(b.prefix, 'prefix') ?? '' }), 201);
    }
    if (p === '/api/teams/check' && method === 'POST') {
      const b = await body<{ url?: unknown }>();
      return ok(await svc.check(reqStr(b.url, 'url', 'Укажи ссылку на репо')));
    }
    if (p === '/api/teams/join' && method === 'POST') {
      const b = await body<{ url?: unknown; addMe?: unknown }>();
      return ok(await svc.joinTeam({ url: reqStr(b.url, 'url', 'Укажи ссылку на репо'), addMe: b.addMe !== false }), 201);
    }
    const seg = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return bad(`Неверный путь: ${s}`);
      }
    };
    if ((m = p.match(/^\/api\/teams\/([^/]+)$/))) {
      const t = seg(m[1]);
      if (method === 'GET') return ok(await svc.team(t));
      if (method === 'PUT') return ok(await svc.updateTeam(t, await readBody()));
      if (method === 'DELETE') {
        const b = await body<{ force?: unknown }>();
        await svc.removeTeam(t, url.searchParams.get('force') === 'true' || b.force === true);
        return ok({ ok: true });
      }
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/sync$/)) && method === 'POST') return ok(await svc.sync(seg(m[1])));
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/conflicts$/)) && method === 'GET') return ok(svc.conflicts(seg(m[1])));
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/conflicts\/([a-f0-9]+)$/)) && method === 'DELETE') return ok(await svc.resolveConflict(seg(m[1]), m[2], 'theirs'));
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/conflicts\/([a-f0-9]+)\/mine$/)) && method === 'POST') return ok(await svc.resolveConflict(seg(m[1]), m[2], 'mine'));
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/local$/))) {
      if (method === 'GET') return ok(svc.local(seg(m[1])));
      if (method === 'PUT') return ok(svc.updateLocal(seg(m[1]), await readBody()));
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/flows\/([^/]+)$/))) {
      if (method === 'GET') return ok(svc.teamFlow(seg(m[1]), seg(m[2])));
      if (method === 'PUT') return ok(await svc.writeTeamFlow(seg(m[1]), seg(m[2]), (await body<{ yaml?: unknown }>()).yaml));
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects$/))) {
      if (method === 'GET') return ok(svc.listProjects(seg(m[1])));
      if (method === 'POST') return ok(await svc.createProject(seg(m[1]), await readBody()), 201);
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)$/))) {
      if (method === 'GET') return ok(await svc.project(seg(m[1]), seg(m[2])));
      if (method === 'PUT') return ok(await svc.updateProject(seg(m[1]), seg(m[2]), await readBody()));
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/docs\/(.+)$/))) {
      const [t, pr, name] = [seg(m[1]), seg(m[2]), m[3].split('/').map(seg).join('/')];
      if (method === 'GET') return ok(await svc.doc(t, pr, name));
      if (method === 'PUT') {
        const b = await body<{ text?: unknown; base?: unknown; section?: unknown; hash?: unknown; message?: unknown }>();
        if (typeof b.text !== 'string') bad('Поле text — строка');
        return ok(await svc.writeDoc(t, pr, name, b.text as string, { base: optStr(b.base, 'base'), section: typeof b.section === 'string' ? b.section : undefined, hash: optStr(b.hash, 'hash'), message: optStr(b.message, 'message') }));
      }
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/history$/)) && method === 'GET') {
      const limit = url.searchParams.get('limit');
      return ok(await svc.history(seg(m[1]), seg(m[2]), { doc: url.searchParams.get('doc') ?? undefined, limit: limit ? Number(limit) : undefined }));
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/history\/([^/]+)$/)) && method === 'GET') {
      const doc = url.searchParams.get('doc');
      if (!doc) bad('Нужен doc — какой документ показать');
      return ok(await svc.docRevision(seg(m[1]), seg(m[2]), doc as string, seg(m[3])));
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/tasks$/))) {
      if (method === 'GET') return ok(svc.tasks(seg(m[1]), seg(m[2])));
      if (method === 'POST') {
        const b = await readBody();
        const items = isRecord(b) && Array.isArray(b.tasks) ? (b.tasks as NewTask[]) : isRecord(b) ? [b as NewTask] : [];
        const created = await svc.createTasks(seg(m[1]), seg(m[2]), items);
        return ok(isRecord(b) && Array.isArray(b.tasks) ? { tasks: created } : created[0], 201);
      }
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/tasks\/([^/]+)$/))) {
      const [t, pr, id] = [seg(m[1]), seg(m[2]), seg(m[3])];
      if (method === 'GET') return ok(svc.task(t, pr, id));
      if (method === 'PATCH') return ok(await svc.updateTask(t, pr, id, (await body<TeamTaskPatch>()) as TeamTaskPatch));
      if (method === 'DELETE') {
        await svc.deleteTask(t, pr, id);
        return ok({ ok: true });
      }
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/tasks\/([^/]+)\/move$/)) && method === 'POST') {
      return ok(await svc.moveTask(seg(m[1]), seg(m[2]), seg(m[3]), (await body<TeamTaskMove>()) as TeamTaskMove));
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/tasks\/([^/]+)\/comments$/))) {
      const [t, pr, id] = [seg(m[1]), seg(m[2]), seg(m[3])];
      if (method === 'GET') return ok(await svc.comments(t, pr, id));
      if (method === 'POST') return ok(await svc.addComment(t, pr, id, (await body<{ text?: unknown }>()).text), 201);
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/sprints$/))) {
      if (method === 'GET') return ok(svc.sprints(seg(m[1]), seg(m[2])));
      if (method === 'POST') return ok(await svc.createSprint(seg(m[1]), seg(m[2]), (await body<NewSprint>()) as NewSprint), 201);
    }
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/sprints\/(\d+)\/(start|close)$/)) && method === 'POST') {
      const [t, pr, n] = [seg(m[1]), seg(m[2]), m[3]];
      if (m[4] === 'start') return ok(await svc.startSprint(t, pr, n, (await body<NewSprint>()) as NewSprint));
      return ok(await svc.closeSprint(t, pr, n, (await body<CloseSprint>()) as CloseSprint));
    }
    // черновики агентов (spec §9.2–9.3): список и старт, черновик с текстами, принятие
    if ((m = p.match(/^\/api\/teams\/([^/]+)\/projects\/([^/]+)\/drafts(?:\/([^/]+)(\/accept)?)?$/))) {
      const drafts = deps.drafts;
      if (!drafts) return { status: 501, body: { error: 'Черновики агентов не подключены' } };
      const [t, pr, run, accept] = [seg(m[1]), seg(m[2]), m[3] ? seg(m[3]) : undefined, Boolean(m[4])];
      if (run === undefined) {
        if (method === 'GET') return ok(drafts.list(t, pr));
        if (method === 'POST') return ok(await drafts.start(t, pr, await readBody()), 201);
      } else if (accept) {
        if (method === 'POST') return ok(await drafts.accept(t, pr, run, await readBody()));
      } else if (method === 'GET') return ok(await drafts.draft(t, pr, run));
    }
    return undefined;
  } catch (err) {
    if (err instanceof TeamError) return { status: err.status, body: err.body() };
    // ошибка чтения тела с кодом (413 от readJson сервера) — с её кодом
    const status = (err as { status?: unknown }).status;
    return { status: typeof status === 'number' && status >= 400 && status < 600 ? status : 500, body: { error: errMsg(err) } };
  }
}
