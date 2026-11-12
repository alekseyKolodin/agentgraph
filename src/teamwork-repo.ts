// Teamwork: клон репо команды на этом компьютере (spec §6–7). Проверка ссылки (git ls-remote), клон, создание на пустом
// репо из шаблона, подключение, отключение; очередь записей с коммитом на каждую запись API; отправка через 3 с после
// последнего коммита (pull --rebase, затем push), получение по таймеру; конфликты: ребейз с конфликтом всегда откатывается,
// локальные коммиты применяются заново как слияние полей (задачи, YAML) и текстов (git merge-file), нерешённое — в
// local.json → conflicts; совпавшие номера задач переименовываются (§5.7); нет сети — повторы с нарастающей паузой (§7.5);
// правки руками в клоне коммитятся перед pull (§7.6); формат новее — только чтение. Git только через execFile с массивом
// аргументов и GIT_TERMINAL_PROMPT=0 (exec из git.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { exec, type Exec } from './git.js';
import { writeAtomic } from './safe-fs.js';
import { copyTemplate, renderTeamConfig, TEMPLATE_DIR } from './teamwork-template.js';
import {
  mergeTaskTexts, mergeYamlTexts, nextTaskId, parseProject, parseSprint, parseTask, parseTeamConfig, remoteProblem, serializeTask, TEAM_FORMAT, TEAM_SLUG_RE,
  teamSlugFromUrl, teamsDir, updateYaml, type FieldConflict, type TeamConfig,
} from './teamwork.js';
import type { TeamConflict, TeamDocName, TeamHistoryItem, TeamMember, TeamRemoteCheck, TeamSync, TeamTaskWork } from './api-types.js';

/** Ошибка с HTTP-кодом и кодом причины для 409 (not_empty, is_team, conflict, unpushed, busy, readonly). */
export class TeamError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
  body(): Record<string, unknown> {
    return { error: this.message, ...(this.code ? { code: this.code } : {}), ...(this.extra ?? {}) };
  }
}

/** local.json: только мои данные (spec §6), в репо не попадают. */
export type LocalData = {
  remote: string;
  /** Ветка репо команды (main). */
  branch?: string;
  repoPaths: Record<string, string>;
  projectSpaces: Record<string, string>;
  work: Record<string, TeamTaskWork[]>;
  sync: { lastFetchAt?: string; lastPushAt?: string; error?: string | null };
  conflicts: TeamConflict[];
};

export type RepoDeps = {
  exec: Exec;
  now: () => Date;
  /** Пауза от последнего коммита до push (spec §7.2). */
  pushDelayMs: number;
  /** Повторы при неудачном push: от retryMinMs с удвоением до retryMaxMs (spec §7.5). */
  retryMinMs: number;
  retryMaxMs: number;
  /** Получение: пока открыт UI и когда закрыт (spec §7.3). */
  pollOpenMs: number;
  pollIdleMs: number;
  /** Папка для временных файлов git merge-file. */
  tmpDir: string;
  templateDir: string;
};

export const defaultRepoDeps = (): RepoDeps => ({
  exec,
  now: () => new Date(),
  pushDelayMs: 3_000,
  retryMinMs: 5_000,
  retryMaxMs: 300_000,
  pollOpenMs: 30_000,
  pollIdleMs: 300_000,
  tmpDir: os.tmpdir(),
  templateDir: TEMPLATE_DIR,
});

export type ChangeEvent = { team: string; projects: string[] };
/** Сообщение коммита: тема или тема с телом. */
export type CommitMessage = string | { subject: string; body?: string };

export const LOCAL_FILE = 'local.json';
export const REPO_DIR = 'repo';
const TASK_FILE_RE = /^projects\/([a-z0-9][a-z0-9-]*)\/tasks\/([A-Z]{2,6}-\d+)\.md$/;
const PROJECT_FILE_RE = /^projects\/([a-z0-9][a-z0-9-]*)\//;
const MANUAL_MESSAGE = 'Правки в папке команды';
const GIT_TIMEOUT = 60_000;
const NET_TIMEOUT = 120_000;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function emptyLocal(remote: string): LocalData {
  return { remote, repoPaths: {}, projectSpaces: {}, work: {}, sync: {}, conflicts: [] };
}

function readLocal(file: string): LocalData | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Partial<LocalData>;
  if (typeof r.remote !== 'string') return undefined;
  const rec = (v: unknown) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, never>) : {});
  return {
    remote: r.remote,
    ...(typeof r.branch === 'string' ? { branch: r.branch } : {}),
    repoPaths: rec(r.repoPaths),
    projectSpaces: rec(r.projectSpaces),
    work: rec(r.work),
    sync: rec(r.sync),
    conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
  };
}

/** Что менялось в клоне: projects/<slug> → slug; корень (teamwork.yaml, flows/) — пустой список проектов, но событие есть. */
export function projectsOf(files: string[]): string[] {
  return [...new Set(files.map((f) => f.match(PROJECT_FILE_RE)?.[1]).filter((s): s is string => Boolean(s)))].sort();
}

/**
 * Клон репо команды: все операции git идут через одну очередь на команду, как записи в одно пространство (spec §7.1).
 * Записи — write(); отправка и получение — push(), pull(), sync(); таймеры — startTimers()/stop().
 */
export class TeamRepo {
  readonly repoDir: string;
  readonly localFile: string;
  private chain: Promise<unknown> = Promise.resolve();
  private pushTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private retryMs = 0;
  private stopped = false;
  private busy = false;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private hasSubscribers: () => boolean = () => false;

  constructor(
    readonly slug: string,
    readonly dir: string,
    readonly deps: RepoDeps = defaultRepoDeps(),
  ) {
    this.repoDir = path.join(dir, REPO_DIR);
    this.localFile = path.join(dir, LOCAL_FILE);
  }

  /** Команда на диске: папка с local.json и клоном; иначе undefined. */
  static open(slug: string, deps: RepoDeps = defaultRepoDeps(), root = teamsDir()): TeamRepo | undefined {
    if (!TEAM_SLUG_RE.test(slug)) return undefined;
    const dir = path.join(root, slug);
    if (!readLocal(path.join(dir, LOCAL_FILE)) || !fs.existsSync(path.join(dir, REPO_DIR, '.git'))) return undefined;
    return new TeamRepo(slug, dir, deps);
  }

  /** Слаги команд: папки с local.json (spec §6). */
  static list(root = teamsDir()): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return [];
    }
    return names.filter((n) => TEAM_SLUG_RE.test(n) && readLocal(path.join(root, n, LOCAL_FILE)) && fs.existsSync(path.join(root, n, REPO_DIR, '.git'))).sort();
  }

  // ---------- local.json

  local(): LocalData {
    return readLocal(this.localFile) ?? emptyLocal('');
  }

  saveLocal(mutate: (l: LocalData) => void): LocalData {
    const l = this.local();
    mutate(l);
    fs.mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.localFile, JSON.stringify(l, null, 2) + '\n');
    return l;
  }

  branch(): string {
    return this.local().branch || 'main';
  }

  // ---------- файлы клона

  /** Абсолютный путь файла клона по относительному; выход за клон — ошибка. */
  abs(rel: string): string {
    const p = path.resolve(this.repoDir, rel);
    if (p !== this.repoDir && !p.startsWith(this.repoDir + path.sep)) throw new TeamError(400, `Путь вне репо команды: ${rel}`);
    return p;
  }

  read(rel: string): string | undefined {
    try {
      return fs.readFileSync(this.abs(rel), 'utf8');
    } catch {
      return undefined;
    }
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.abs(rel));
  }

  writeFile(rel: string, text: string): void {
    const p = this.abs(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }

  remove(rel: string): void {
    fs.rmSync(this.abs(rel), { force: true, recursive: true });
  }

  /** Имена файлов папки клона; нет папки — пусто. */
  list(rel: string, filter?: (name: string) => boolean): string[] {
    try {
      return fs
        .readdirSync(this.abs(rel), { withFileTypes: true })
        .filter((e) => e.isFile() && (!filter || filter(e.name)))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  dirs(rel: string): string[] {
    try {
      return fs
        .readdirSync(this.abs(rel), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** teamwork.yaml клона; не разбирается — ошибка 500 с причиной. */
  config(): TeamConfig {
    const text = this.read('teamwork.yaml');
    if (text === undefined) throw new TeamError(500, 'В репо команды нет teamwork.yaml');
    try {
      return parseTeamConfig(text);
    } catch (err) {
      throw new TeamError(500, errMsg(err));
    }
  }

  /** Формат новее известного — только чтение (spec §5.9). */
  readonly(): boolean {
    try {
      return this.config().format > TEAM_FORMAT;
    } catch {
      return false;
    }
  }

  // ---------- git

  git(args: string[], timeoutMs = GIT_TIMEOUT): Promise<string> {
    return this.deps.exec('git', args, { cwd: this.repoDir, timeoutMs });
  }

  /** Я по git config клона (глобальный конфиг тоже действует). */
  async identity(): Promise<{ name?: string; email?: string }> {
    const get = (key: string) => this.git(['config', '--get', key], 10_000).then((s) => s.trim() || undefined, () => undefined);
    const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
    return { ...(name ? { name } : {}), ...(email ? { email: email.toLowerCase() } : {}) };
  }

  async requireIdentity(): Promise<{ name: string; email: string }> {
    const me = await this.identity();
    if (!me.email) throw new TeamError(400, 'git не знает твой email: задай его командой git config --global user.email you@example.com (и user.name)');
    return { name: me.name ?? me.email, email: me.email };
  }

  onChange(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(files: string[]): void {
    if (!files.length) return;
    const e = { team: this.slug, projects: projectsOf(files) };
    for (const fn of this.listeners) fn(e);
  }

  /** Очередь операций с клоном: записи, pull и push не пересекаются. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------- запись (spec §7.1)

  /**
   * Одна запись API — один коммит: правки руками коммитятся отдельно до неё, mutate меняет файлы клона, итог коммитится с
   * message (строка или функция, которую зовут после mutate: номера задач известны только тогда; автор — git config, или
   * author). Бросила mutate — рабочая копия возвращается к HEAD, коммита нет. После коммита — событие team и отправка
   * через pushDelayMs.
   */
  write(message: CommitMessage | (() => CommitMessage), mutate: (repo: TeamRepo) => void | Promise<void>, o: { author?: { name: string; email: string } } = {}): Promise<void> {
    return this.enqueue(async () => {
      if (this.readonly()) throw new TeamError(409, 'Формат репо команды новее, чем знает agentgraph: обнови его, пока команда только для чтения', 'readonly');
      await this.commitManual();
      try {
        await mutate(this);
      } catch (err) {
        await this.git(['checkout', '-q', '--', '.']).catch(() => undefined);
        await this.git(['clean', '-qfd']).catch(() => undefined);
        throw err;
      }
      await this.git(['add', '-A']);
      const files = (await this.git(['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
      if (!files.length) return;
      const author = o.author ? ['--author', `${o.author.name} <${o.author.email}>`] : [];
      const msg = typeof message === 'function' ? message() : message;
      const { subject, body } = typeof msg === 'string' ? { subject: msg, body: undefined } : msg;
      await this.git(['commit', '-q', '--no-verify', ...author, '-m', subject, ...(body ? ['-m', body] : [])]);
      this.emit(files);
      this.schedulePush();
    });
  }

  /** Незакоммиченные правки не через agentgraph — отдельным коммитом (spec §7.6). true — что-то было. */
  private async commitManual(): Promise<boolean> {
    const status = (await this.git(['status', '--porcelain', '--untracked-files=all'])).trim();
    if (!status) return false;
    await this.git(['add', '-A']);
    try {
      await this.git(['commit', '-q', '--no-verify', '-m', MANUAL_MESSAGE]);
    } catch (err) {
      // нечего коммитить после add (например, только игнорируемое) — не ошибка
      if (!/nothing to commit|nothing added/.test(errMsg(err))) throw err;
      return false;
    }
    return true;
  }

  // ---------- отправка и получение (spec §7.2–7.5)

  schedulePush(delayMs = this.deps.pushDelayMs): void {
    if (this.stopped) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.push().catch(() => undefined);
    }, delayMs);
    this.pushTimer.unref();
  }

  /** Отправить сейчас, без ожидания таймера (тесты и кнопка «Повторить»). */
  push(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
    return this.enqueue(() => this.syncNow(true)).then(() => undefined);
  }

  /** Получить: fetch и слияние; что поменялось — событием team. */
  pull(): Promise<string[]> {
    return this.enqueue(() => this.syncNow(false));
  }

  /** Получить и отправить, итог — строка синхронизации. */
  async sync(): Promise<TeamSync> {
    await this.enqueue(() => this.syncNow(true));
    return this.syncState();
  }

  /** Внутри очереди: правки руками, fetch, слияние, push при push и неотправленных коммитах. Ошибка сети — в local.sync.error и повтор. */
  private async syncNow(push: boolean): Promise<string[]> {
    this.busy = true;
    let changed: string[] = [];
    try {
      await this.commitManual();
      await this.fetch();
      changed = await this.integrate();
      if (push && (await this.unpushed()) > 0) {
        await this.git(['push', '-q', '-u', 'origin', `HEAD:refs/heads/${this.branch()}`], NET_TIMEOUT);
        this.saveLocal((l) => {
          l.sync.lastPushAt = this.deps.now().toISOString();
          l.sync.error = null;
        });
      } else if (push) {
        this.saveLocal((l) => (l.sync.error = null));
      }
      this.retryMs = 0;
    } catch (err) {
      const msg = errMsg(err);
      this.saveLocal((l) => (l.sync.error = msg));
      if (push) {
        this.retryMs = Math.min(Math.max(this.retryMs * 2, this.deps.retryMinMs), this.deps.retryMaxMs);
        this.schedulePush(this.retryMs);
      }
      throw err;
    } finally {
      this.busy = false;
      if (changed.length) this.emit(changed);
    }
    return changed;
  }

  private async fetch(): Promise<void> {
    await this.git(['fetch', '-q', 'origin'], NET_TIMEOUT);
    this.saveLocal((l) => (l.sync.lastFetchAt = this.deps.now().toISOString()));
  }

  rev(ref: string): Promise<string | undefined> {
    return this.git(['rev-parse', '--verify', '--quiet', ref], 10_000).then((s) => s.trim() || undefined, () => undefined);
  }

  /**
   * Слить origin в клон: ничего нового — пусто; у меня нет своих коммитов — fast-forward; расхождение — rebase, а при его
   * конфликте откат и перепроигрывание моих коммитов слиянием полей (replay). Возвращает изменившиеся файлы.
   */
  private async integrate(): Promise<string[]> {
    const remoteRef = `origin/${this.branch()}`;
    const remote = await this.rev(remoteRef);
    const head = await this.rev('HEAD');
    if (!remote || !head || remote === head) return [];
    const base = (await this.git(['merge-base', 'HEAD', remoteRef]).catch(() => '')).trim();
    if (base === remote) return [];
    if (base === head) await this.git(['merge', '-q', '--ff-only', remoteRef]);
    else {
      try {
        await this.git(['rebase', '-q', remoteRef]);
      } catch {
        await this.git(['rebase', '--abort']).catch(() => undefined);
        await this.replay(base || remote, head, remote);
      }
    }
    await this.afterIntegrate();
    const now = await this.rev('HEAD');
    const files = (await this.git(['diff', '--name-only', head, now ?? 'HEAD'])).split('\n').filter(Boolean);
    return files;
  }

  private show(ref: string, file: string): Promise<string | undefined> {
    return this.git(['show', `${ref}:${file}`]).then(
      (s) => s,
      () => undefined,
    );
  }

  /** Три текста через git merge-file; конфликт (ненулевой код) — undefined. */
  async mergeText(base: string, mine: string, theirs: string): Promise<string | undefined> {
    const tmp = fs.mkdtempSync(path.join(this.deps.tmpDir, 'agentgraph-merge-'));
    try {
      const f = (n: string, t: string) => {
        const p = path.join(tmp, n);
        fs.writeFileSync(p, t);
        return p;
      };
      const [m, b, t] = [f('mine', mine), f('base', base), f('theirs', theirs)];
      return await this.deps.exec('git', ['merge-file', '-p', '-L', 'моё', '-L', 'база', '-L', 'команда', m, b, t], { cwd: tmp, timeoutMs: 10_000 });
    } catch {
      return undefined;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async nameStatus(a: string, b: string): Promise<Map<string, 'A' | 'M' | 'D'>> {
    const out = await this.git(['diff', '--name-status', '--no-renames', a, b]);
    const map = new Map<string, 'A' | 'M' | 'D'>();
    for (const line of out.split('\n')) {
      const m = line.match(/^([AMD])\t(.+)$/);
      if (m) map.set(m[2], m[1] as 'A' | 'M' | 'D');
    }
    return map;
  }

  /**
   * Перепроигрывание моих коммитов base..head поверх remote (spec §7.4): файл менял только я — моё; только они — их;
   * оба — задача по полям, YAML по полям, текст через merge-file; не слилось — значение команды, моё в конфликты.
   * Удалено с одной стороны и изменено с другой — остаётся как у команды, моё в конфликт deleted. Задача с тем же
   * номером с обеих сторон — моя переименовывается в свободный номер (§5.7). Итог — один коммит с темами моих коммитов.
   */
  private async replay(base: string, head: string, remote: string): Promise<void> {
    const mine = await this.nameStatus(base, head);
    const theirs = await this.nameStatus(base, remote);
    const subjects = (await this.git(['log', '--reverse', '--format=%s', `${remote}..${head}`])).split('\n').filter(Boolean);
    const at = this.deps.now().toISOString();
    const results = new Map<string, string | null>();
    const conflicts: TeamConflict[] = [];
    const renames = new Map<string, string>();
    const theirAuthor = async (file: string) => (await this.git(['log', '-1', '--format=%ae', remote, '--', file]).catch(() => '')).trim() || undefined;
    const conflict = async (file: string, kind: TeamConflict['kind'], ours: unknown, theirsV: unknown, field?: string): Promise<void> => {
      const m = file.match(TASK_FILE_RE);
      const project = file.match(PROJECT_FILE_RE)?.[1];
      const doc = file.match(/^projects\/[^/]+\/(prd|architecture|design)\.md$/)?.[1] ?? (file.match(/^projects\/[^/]+\/(docs\/[^/]+\.md)$/)?.[1] as TeamDocName | undefined);
      const by = await theirAuthor(file);
      conflicts.push({
        id: randomBytes(6).toString('hex'),
        file,
        ...(project ? { project } : {}),
        ...(m ? { task: m[2] } : {}),
        ...(doc ? { doc: doc as TeamDocName } : {}),
        kind,
        ...(field ? { field } : {}),
        ours,
        theirs: theirsV,
        ...(by ? { theirsBy: by } : {}),
        at,
      });
    };
    const fieldConflicts = (file: string, list: FieldConflict[], kind: TeamConflict['kind'] = 'field') => Promise.all(list.map((c) => conflict(file, c.field === 'body' || c.field === 'text' ? 'text' : kind, c.ours, c.theirs, c.field)));
    // занятые номера — в дереве команды и в моём: свободный номер не должен совпасть и с моей же новой задачей
    let knownIds: Set<string> | undefined;
    const allKnownIds = async () => {
      if (knownIds) return knownIds;
      const names = [...(await this.git(['ls-tree', '-r', '--name-only', remote])).split('\n'), ...(await this.git(['ls-tree', '-r', '--name-only', head])).split('\n')];
      knownIds = new Set(names.map((n) => n.match(TASK_FILE_RE)?.[2]).filter((x): x is string => Boolean(x)));
      return knownIds;
    };
    for (const [file, st] of mine) {
      const ts = theirs.get(file);
      const mineText = st === 'D' ? undefined : await this.show(head, file);
      if (!ts) {
        results.set(file, mineText ?? null);
        continue;
      }
      const theirText = ts === 'D' ? undefined : await this.show(remote, file);
      const baseText = st === 'A' ? undefined : await this.show(base, file);
      if (mineText === undefined || theirText === undefined) {
        if (mineText === undefined && theirText === undefined) continue;
        await conflict(file, 'deleted', mineText ?? null, theirText ?? null);
        continue;
      }
      if (mineText === theirText) continue;
      const task = file.match(TASK_FILE_RE);
      if (task && st === 'A' && ts === 'A') {
        // один номер с двух сторон: моя задача получает свободный номер, её ещё никто не видел
        const prefix = task[2].split('-')[0];
        const ids = await allKnownIds();
        const fresh = nextTaskId(ids, prefix);
        ids.add(fresh);
        renames.set(task[2], fresh);
        const t = parseTask(mineText, file);
        const newFile = `projects/${task[1]}/tasks/${fresh}.md`;
        results.set(newFile, t.error ? mineText.replace(new RegExp(`^id: ${task[2]}$`, 'm'), `id: ${fresh}`) : serializeTask({ ...t, id: fresh, file: newFile }));
        subjects.push(`${task[2]} → ${fresh}: номер уже занят`);
        continue;
      }
      if (task) {
        const r = await mergeTaskTexts(baseText, mineText, theirText, file, (b, m, t) => this.mergeText(b, m, t));
        results.set(file, r.text);
        await fieldConflicts(file, r.conflicts);
      } else if (/\.ya?ml$/.test(file)) {
        const r = mergeYamlTexts(baseText, mineText, theirText);
        results.set(file, r.text);
        await fieldConflicts(file, r.conflicts, /\/sprints\//.test(file) ? 'sprint' : 'field');
      } else {
        const merged = await this.mergeText(baseText ?? '', mineText, theirText);
        if (merged !== undefined) results.set(file, merged);
        else await conflict(file, 'text', mineText, theirText);
      }
    }
    // ссылки blockedBy моих же неотправленных задач на переименованный номер
    if (renames.size) {
      for (const [file, text] of results) {
        if (text === null || !TASK_FILE_RE.test(file)) continue;
        const t = parseTask(text, file);
        if (t.error || !t.blockedBy.some((b) => renames.has(b))) continue;
        results.set(file, serializeTask({ ...t, blockedBy: t.blockedBy.map((b) => renames.get(b) ?? b) }));
      }
    }
    await this.git(['reset', '-q', '--hard', remote]);
    for (const [file, text] of results) {
      if (text === null) this.remove(file);
      else this.writeFile(file, text);
    }
    await this.git(['add', '-A']);
    const staged = (await this.git(['diff', '--cached', '--name-only'])).trim();
    if (staged) {
      const subject = subjects.length === 1 ? subjects[0] : `Слияние с командой: ${subjects.length} изменений`;
      const body = subjects.length > 1 ? subjects.map((s) => `- ${s}`).join('\n') : '';
      await this.git(['commit', '-q', '--no-verify', '-m', subject, ...(body ? ['-m', body] : [])]);
    }
    if (conflicts.length || renames.size) {
      this.saveLocal((l) => {
        l.conflicts.push(...conflicts);
        for (const [from, to] of renames) {
          if (l.work[from]) {
            l.work[to] = [...(l.work[to] ?? []), ...l.work[from]];
            delete l.work[from];
          }
        }
      });
    }
  }

  /** Два активных спринта в проекте после слияния — активным остаётся более ранний, второй снова запланирован (spec §7.4.4). */
  private async afterIntegrate(): Promise<void> {
    const at = this.deps.now().toISOString();
    let changed = false;
    const conflicts: TeamConflict[] = [];
    for (const slug of this.dirs('projects')) {
      const dir = `projects/${slug}/sprints`;
      const active: { file: string; text: string; number: number; startedAt: string }[] = [];
      for (const name of this.list(dir, (n) => /^\d+\.ya?ml$/.test(n))) {
        const text = this.read(`${dir}/${name}`);
        if (text === undefined) continue;
        try {
          const s = parseSprint(text, Number(name.split('.')[0]));
          if (s.status === 'active') active.push({ file: `${dir}/${name}`, text, number: s.number, startedAt: s.startedAt ?? '' });
        } catch {
          // битый спринт пропускаем: его покажет экран
        }
      }
      if (active.length < 2) continue;
      active.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.number - b.number);
      const keep = active[0];
      for (const s of active.slice(1)) {
        this.writeFile(s.file, updateYaml(s.text, { status: 'planned', startedAt: undefined, startedBy: undefined }));
        conflicts.push({ id: randomBytes(6).toString('hex'), file: s.file, project: slug, kind: 'sprint', ours: s.number, theirs: keep.number, at });
        changed = true;
      }
    }
    if (!changed) return;
    await this.git(['add', '-A']);
    await this.git(['commit', '-q', '--no-verify', '-m', `Два активных спринта: остался ${conflicts.map((c) => `спринт ${c.theirs}`).join(', ')}`]);
    this.saveLocal((l) => l.conflicts.push(...conflicts));
  }

  /** Локальные коммиты, которых нет в репо команды. Нет origin-ветки (пустой репо до первого push) — все коммиты. */
  async unpushed(): Promise<number> {
    const remoteRef = `origin/${this.branch()}`;
    const range = (await this.rev(remoteRef)) ? `${remoteRef}..HEAD` : 'HEAD';
    const n = (await this.git(['rev-list', '--count', range]).catch(() => '0')).trim();
    return Number(n) || 0;
  }

  async unpushedSubjects(): Promise<string[]> {
    const remoteRef = `origin/${this.branch()}`;
    const range = (await this.rev(remoteRef)) ? `${remoteRef}..HEAD` : 'HEAD';
    return (await this.git(['log', '--format=%s', range]).catch(() => '')).split('\n').filter(Boolean);
  }

  async syncState(): Promise<TeamSync> {
    const l = this.local();
    const unpushed = await this.unpushed();
    const conflicts = l.conflicts.length;
    const state: TeamSync['state'] = this.readonly() ? 'readonly' : this.busy ? 'pushing' : conflicts ? 'conflict' : unpushed ? 'pending' : 'ok';
    return {
      state,
      unpushed,
      conflicts,
      ...(l.sync.lastFetchAt ? { lastFetchAt: l.sync.lastFetchAt } : {}),
      ...(l.sync.lastPushAt ? { lastPushAt: l.sync.lastPushAt } : {}),
      ...(l.sync.error ? { error: l.sync.error } : {}),
    };
  }

  /** Последние коммиты по файлу или папке клона (spec §8.4 «История», обзор проекта). */
  async history(o: { path?: string; limit?: number } = {}): Promise<TeamHistoryItem[]> {
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 200);
    const out = await this.git(['log', `-n${limit}`, '--format=%H%x00%an%x00%ae%x00%aI%x00%s', ...(o.path ? ['--', o.path] : [])]).catch(() => '');
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, author, email, at, message] = l.split('\0');
        return { hash, author, email, at, message };
      });
  }

  // ---------- таймеры (spec §7.3)

  startTimers(hasSubscribers: () => boolean): void {
    this.hasSubscribers = hasSubscribers;
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.enqueue(() => this.syncNow(true))
        .catch(() => undefined)
        .finally(() => this.schedulePoll());
    }, this.hasSubscribers() ? this.deps.pollOpenMs : this.deps.pollIdleMs);
    this.pollTimer.unref();
  }

  /** Остановить таймеры и дождаться текущей операции; дальше клон только читается. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pushTimer = undefined;
    this.pollTimer = undefined;
    await this.chain.catch(() => undefined);
  }

  /** Отключить команду: удалить клон. С неотправленными изменениями без force — 409 unpushed со списком (spec §8.2). */
  async disconnect(force: boolean): Promise<void> {
    const unpushed = await this.unpushed();
    if (unpushed && !force) {
      throw new TeamError(409, `Не отправлено: ${unpushed} изменений. Они пропадут вместе с клоном.`, 'unpushed', { unpushed, commits: await this.unpushedSubjects() });
    }
    await this.stop();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

// ---------- проверка ссылки, создание, подключение (spec §8.1–8.2)

/** Ветка репо по его веткам: main, master, иначе первая. */
function pickBranch(heads: string[]): string | undefined {
  return heads.find((h) => h === 'main') ?? heads.find((h) => h === 'master') ?? heads[0];
}

async function remoteHeads(url: string, x: Exec): Promise<string[]> {
  const out = await x('git', ['ls-remote', '--heads', '--', url], { timeoutMs: NET_TIMEOUT });
  return out
    .split('\n')
    .map((l) => l.split('\t')[1])
    .filter((r): r is string => Boolean(r))
    .map((r) => r.replace(/^refs\/heads\//, ''));
}

function assertRemote(url: string): string {
  const u = url.trim();
  const problem = remoteProblem(u);
  if (problem) throw new TeamError(400, problem);
  return u;
}

/**
 * Что по ссылке: пустой репо (можно создать команду), репо команды (предложить подключение, с названием и проектами),
 * непустой чужой репо или ошибка доступа. Репо команды читается через временный неглубокий клон одной ветки.
 */
export async function checkRemote(url: string, deps: RepoDeps = defaultRepoDeps()): Promise<TeamRemoteCheck> {
  const u = url.trim();
  const problem = remoteProblem(u);
  if (problem) return { kind: 'error', error: problem };
  let heads: string[];
  try {
    heads = await remoteHeads(u, deps.exec);
  } catch (err) {
    return { kind: 'error', error: errMsg(err) };
  }
  if (!heads.length) return { kind: 'empty' };
  const branch = pickBranch(heads)!;
  const tmp = fs.mkdtempSync(path.join(deps.tmpDir, 'agentgraph-team-check-'));
  try {
    await deps.exec('git', ['clone', '-q', '--depth', '1', '--single-branch', '--branch', branch, '--', u, tmp], { timeoutMs: NET_TIMEOUT });
    const cfgText = fs.readFileSync(path.join(tmp, 'teamwork.yaml'), 'utf8');
    const cfg = parseTeamConfig(cfgText);
    const projects: { slug: string; title: string; repos: string[] }[] = [];
    const pdir = path.join(tmp, 'projects');
    if (fs.existsSync(pdir)) {
      for (const slug of fs.readdirSync(pdir).sort()) {
        const f = path.join(pdir, slug, 'project.yaml');
        if (!fs.existsSync(f)) continue;
        try {
          const p = parseProject(fs.readFileSync(f, 'utf8'), slug);
          projects.push({ slug: p.slug, title: p.title, repos: p.repos.map((r) => r.url) });
        } catch {
          projects.push({ slug, title: slug, repos: [] });
        }
      }
    }
    return { kind: 'team', title: cfg.title, prefix: cfg.prefix, format: cfg.format, members: cfg.members, projects };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'not_empty' };
    return { kind: 'error', error: errMsg(err) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Свободный слаг папки команды: из ссылки, с суффиксом -2, -3… если занят. */
export function freeTeamSlug(url: string, root = teamsDir()): string {
  const base = teamSlugFromUrl(url);
  let slug = base;
  for (let i = 2; fs.existsSync(path.join(root, slug)); i++) slug = `${base}-${i}`;
  return slug;
}

async function cloneInto(url: string, teamDir: string, deps: RepoDeps): Promise<void> {
  fs.mkdirSync(teamDir, { recursive: true });
  const repoDir = path.join(teamDir, REPO_DIR);
  try {
    await deps.exec('git', ['clone', '-q', '--', url, repoDir], { timeoutMs: NET_TIMEOUT });
  } catch (err) {
    fs.rmSync(teamDir, { recursive: true, force: true });
    throw new TeamError(400, `Не удалось клонировать репо: ${errMsg(err)}`);
  }
}

export type CreateTeamRequest = { url: string; title: string; prefix: string };

/**
 * Создать команду на пустом репо: клон, шаблон целиком, я — первый участник, коммит, push в main. Репо с teamwork.yaml —
 * 409 is_team (подключайся), непустой без него — 409 not_empty.
 */
export async function createTeam(req: CreateTeamRequest, deps: RepoDeps = defaultRepoDeps(), root = teamsDir()): Promise<TeamRepo> {
  const url = assertRemote(req.url);
  const title = req.title.trim();
  const prefix = req.prefix.trim().toUpperCase();
  if (!title) throw new TeamError(400, 'Укажи название команды');
  if (!/^[A-Z]{2,6}$/.test(prefix)) throw new TeamError(400, 'Префикс номеров задач — латиница, 2–6 букв');
  const check = await checkRemote(url, deps);
  if (check.kind === 'error') throw new TeamError(400, `Репо недоступен: ${check.error}`);
  if (check.kind === 'team') throw new TeamError(409, `По ссылке уже есть команда «${check.title}»: подключись к ней`, 'is_team', { check });
  if (check.kind === 'not_empty') throw new TeamError(409, 'Репо не пустой: для новой команды нужен пустой репо', 'not_empty');
  const slug = freeTeamSlug(url, root);
  const dir = path.join(root, slug);
  await cloneInto(url, dir, deps);
  const repo = new TeamRepo(slug, dir, deps);
  try {
    const me = await repo.requireIdentity();
    await repo.git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    copyTemplate(repo.repoDir, deps.templateDir);
    const member: TeamMember = { name: me.name, email: me.email };
    repo.writeFile('teamwork.yaml', renderTeamConfig(repo.read('teamwork.yaml') ?? 'format: 1\n', { title, prefix, member }));
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-q', '--no-verify', '-m', `Команда «${title}» создана`]);
    repo.saveLocal((l) => {
      Object.assign(l, emptyLocal(url));
      l.branch = 'main';
    });
    await repo.git(['push', '-q', '-u', 'origin', 'main'], NET_TIMEOUT);
    repo.saveLocal((l) => {
      l.sync.lastPushAt = deps.now().toISOString();
      l.sync.error = null;
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err instanceof TeamError ? err : new TeamError(400, `Не удалось создать команду: ${errMsg(err)}`);
  }
  return repo;
}

export type JoinTeamRequest = { url: string; addMe?: boolean };

/** Подключиться по ссылке: клон, проверка teamwork.yaml, при addMe — отдельный коммит с участником и push. */
export async function joinTeam(req: JoinTeamRequest, deps: RepoDeps = defaultRepoDeps(), root = teamsDir()): Promise<{ repo: TeamRepo; added: boolean }> {
  const url = assertRemote(req.url);
  const slug = freeTeamSlug(url, root);
  const dir = path.join(root, slug);
  await cloneInto(url, dir, deps);
  const repo = new TeamRepo(slug, dir, deps);
  try {
    // remote HEAD может указывать на несуществующую ветку (bare-репо с HEAD master, а команда в main): выгружаем ветку сами
    let branch = (await repo.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim().replace(/^origin\//, '');
    if (!branch || !(await repo.rev('HEAD'))) {
      const heads = (await repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/']))
        .split('\n')
        .map((s) => s.trim().replace(/^origin\//, ''))
        .filter((s) => s && s !== 'HEAD');
      branch = pickBranch(heads) ?? '';
      if (!branch) throw new TeamError(409, 'Репо пустой: здесь нет команды. Создай её', 'not_empty');
      await repo.git(['checkout', '-q', '-B', branch, '--track', `origin/${branch}`]);
    }
    const cfgText = repo.read('teamwork.yaml');
    if (cfgText === undefined) throw new TeamError(409, 'В репо нет teamwork.yaml: это не репо команды', 'not_empty');
    let cfg: TeamConfig;
    try {
      cfg = parseTeamConfig(cfgText);
    } catch (err) {
      throw new TeamError(400, `teamwork.yaml не читается: ${errMsg(err)}`);
    }
    repo.saveLocal((l) => {
      Object.assign(l, emptyLocal(url));
      l.branch = branch;
      l.sync.lastFetchAt = deps.now().toISOString();
    });
    let added = false;
    if (req.addMe !== false && cfg.format <= TEAM_FORMAT) {
      const me = await repo.requireIdentity();
      if (!cfg.members.some((m) => m.email === me.email)) {
        await repo.write(`Участник добавлен: ${me.name}`, (r) => {
          const fresh = parseTeamConfig(r.read('teamwork.yaml') ?? '');
          r.writeFile('teamwork.yaml', updateYaml(r.read('teamwork.yaml') ?? '', { members: [...fresh.members, { name: me.name, email: me.email }] }));
        });
        added = true;
        await repo.push().catch(() => undefined);
      }
    }
    return { repo, added };
  } catch (err) {
    await repo.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    throw err instanceof TeamError ? err : new TeamError(400, `Не удалось подключиться: ${errMsg(err)}`);
  }
}
