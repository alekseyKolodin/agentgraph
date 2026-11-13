// Teamwork: клон репо команды на этом компьютере (spec §6–7). Проверка ссылки (git ls-remote), клон, создание на пустом
// репо из шаблона, подключение, отключение; очередь записей с коммитом на каждую запись API; отправка через 3 с после
// последнего коммита (pull --rebase, затем push), получение по таймеру; конфликты: ребейз с конфликтом всегда откатывается,
// локальные коммиты применяются заново как слияние полей (задачи, YAML) и текстов (git merge-file), нерешённое — в
// local.json → conflicts (список, «оставить команды» и «взять моё» — в teamwork-server.ts); совпавшие номера задач переименовываются (§5.7); нет сети — повторы с нарастающей паузой (§7.5);
// правки руками в клоне коммитятся перед pull (§7.6); формат новее — только чтение. Git только через execFile с массивом
// аргументов и GIT_TERMINAL_PROMPT=0 (exec из git.ts). Перепроигрывание собирает коммит во временном индексе по объектам
// git, а не по тексту: двоичные файлы и файлы, которые менял только я, переносятся байт в байт (D-1, D-6 финального ревью);
// клон, оставшийся посреди rebase или merge, перед записью и синхронизацией возвращается в чистое состояние (D-2).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { exec, type Exec } from './git.js';
import { writeAtomic } from './safe-fs.js';
import { copyTemplate, renderTeamConfig, TEMPLATE_DIR } from './teamwork-template.js';
import {
  maxTaskNumber, mergeTaskTexts, mergeYamlTexts, nextTaskId, parseProject, parseSprint, parseTask, parseTeamConfig, remoteProblem, serializeTask, TEAM_FORMAT,
  TEAM_SLUG_RE, taskNumber, teamSlugFromUrl, teamsDir, textHash, updateTaskText, updateYaml, type FieldConflict, type TeamConfig,
} from './teamwork.js';
import type { TeamConflict, TeamDocName, TeamHistoryItem, TeamMember, TeamRemoteCheck, TeamSync, TeamTaskWork } from './api-types.js';

/** Ошибка с HTTP-кодом и кодом причины для 409 (not_empty, is_team, conflict, unpushed, busy, readonly, rewritten, repo_state). */
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
  /** format — версия формата teamwork.yaml в репо команды после последнего fetch: новее известной — только чтение (§5.9). */
  sync: { lastFetchAt?: string; lastPushAt?: string; error?: string | null; format?: number };
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
export const TASK_FILE_RE = /^projects\/([a-z0-9][a-z0-9-]*)\/tasks\/([A-Z]{2,6}-\d+)\.md$/;
/** Комментарий задачи: projects/<slug>/comments/<ID>/<файл>. */
export const COMMENT_FILE_RE = /^projects\/([a-z0-9][a-z0-9-]*)\/comments\/([A-Z]{2,6}-\d+)\/(.+)$/;
const PROJECT_FILE_RE = /^projects\/([a-z0-9][a-z0-9-]*)\//;
const MANUAL_MESSAGE = 'Правки в папке команды';
const GIT_TIMEOUT = 60_000;
const NET_TIMEOUT = 120_000;
/** Ссылка, которая держит blob моей версии двоичного файла из конфликта, пока конфликт не решён (gc его не уберёт). */
export const CONFLICT_REF = 'refs/agentgraph/conflicts/';
/** Обычные файлы в дереве git; ссылка (120000) и подмодуль (160000) как текст не сливаются. */
const REGULAR_MODES = new Set(['100644', '100755']);
/** Файл в папке git клона: идёт свой rebase, внутри — pid процесса agentgraph (D-2). */
const REBASE_MARKER = 'agentgraph-rebase';
/** Служебные файлы ОС: не уходят команде (.gitignore новой команды и info/exclude каждого клона). */
const OS_JUNK = ['.DS_Store', 'Thumbs.db'];
/** Текст больше этого как текст не сливается (буфер exec — 32 МБ): как двоичный, в конфликт с blob. */
const MAX_MERGE_BYTES = 8 * 1024 * 1024;
/** Жив ли процесс: signal 0 только проверяет; EPERM — жив, но чужой. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** Текст ошибки git без учётных данных из ссылки (https://user:token@host/…). */
export const scrub = (s: string): string => s.replace(/(\/\/)[^/@\s]+@/g, '$1***@');

/** Запись дерева git: режим, объект. */
type TreeEntry = { mode: string; oid: string };
/** Итог перепроигрывания по пути: объект как есть (моя версия байт в байт), текст после слияния, null — удалить. */
type ReplayOut = TreeEntry | { text: string; mode: string } | null;

const eqJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Тот же конфликт уже записан (повтор перепроигрывания после сбоя до сдвига ветки): второй раз не добавляется. */
const sameConflict = (a: TeamConflict, b: TeamConflict): boolean =>
  a.file === b.file && a.kind === b.kind && (a.field ?? '') === (b.field ?? '') && (a.blob ?? '') === (b.blob ?? '') && eqJson(a.ours, b.ours) && eqJson(a.theirs, b.theirs);

/** Запуски и сессии переименованной задачи (local.json → work) переезжают на её новый номер. */
function moveWork(l: LocalData, from: string, to: string): void {
  if (!l.work[from]) return;
  l.work[to] = [...(l.work[to] ?? []), ...l.work[from]];
  delete l.work[from];
}

/** Ошибка: репо команды на формате новее известного, а у меня есть коммиты — их нельзя ни слить, ни отправить (spec §5.9). */
const readonlyError = () =>
  new TeamError(409, 'Формат репо команды новее, чем знает agentgraph: обнови его. Неотправленные изменения ждут в клоне, пока команда только для чтения', 'readonly');

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

/** teamwork.yaml → lastTask по тексту файла; файла нет или он не читается — 0. */
function lastTaskOf(text: string | undefined): number {
  try {
    return text === undefined ? 0 : (parseTeamConfig(text).lastTask ?? 0);
  } catch {
    return 0;
  }
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
  /** Клон удалён отключением: local.json больше не пишется, иначе папка команды появилась бы снова (D-15). */
  private removed = false;
  /** stop() снаружи (остановка сервиса команд): отказ в отключении клон уже не возвращает в работу. */
  private closed = false;
  private timersOn = false;
  private gitDirPath?: string;
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
    if (this.removed) return l;
    fs.mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.localFile, JSON.stringify(l, null, 2) + '\n');
    return l;
  }

  branch(): string {
    return this.local().branch || 'main';
  }

  // ---------- файлы клона

  /**
   * Абсолютный путь файла клона по относительному; выход за клон — ошибка, в том числе через ссылку: клон делается с
   * core.symlinks=false, но ссылку мог положить в папку человек. Каждая часть пути проверяется lstat: ссылка разрешается
   * и должна вести внутрь клона, висячая ссылка — тоже выход (fs.existsSync шёл бы по ней и пропускал её, S-7).
   */
  abs(rel: string): string {
    const p = path.resolve(this.repoDir, rel);
    const inside = (x: string, root: string) => x === root || x.startsWith(root + path.sep);
    if (!inside(p, this.repoDir)) throw new TeamError(400, `Путь вне репо команды: ${rel}`);
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(this.repoDir);
    } catch {
      return p; // клона ещё нет (создание) — сверять нечего
    }
    const outside = () => new TeamError(400, `Путь ведёт за пределы репо команды: ${rel}`);
    let cur = realRoot;
    for (const part of path.relative(this.repoDir, p).split(path.sep).filter(Boolean)) {
      const next = path.join(cur, part);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(next);
      } catch {
        break; // дальше пути нет: новый файл или папка
      }
      if (st.isSymbolicLink()) {
        let real: string;
        try {
          real = fs.realpathSync(next);
        } catch {
          throw outside(); // висячая ссылка: запись пошла бы по ней наружу
        }
        if (!inside(real, realRoot)) throw outside();
        cur = real;
      } else cur = next;
    }
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

  /**
   * Формат новее известного — только чтение (spec §5.9): в клоне или в репо команды после последнего fetch (у меня могут быть
   * неотправленные коммиты, тогда клон на новый формат не перешёл, но писать в него дальше нельзя — D-8).
   */
  readonly(): boolean {
    if ((this.local().sync.format ?? 0) > TEAM_FORMAT) return true;
    try {
      return this.config().format > TEAM_FORMAT;
    } catch {
      return false;
    }
  }

  // ---------- git

  /** git в клоне: имена файлов без экранирования не-ASCII (core.quotePath), сообщения git — на английском (разбор ошибок). */
  git(args: string[], timeoutMs = GIT_TIMEOUT, env: NodeJS.ProcessEnv = {}): Promise<string> {
    return this.deps.exec('git', ['-c', 'core.quotePath=false', ...args], { cwd: this.repoDir, timeoutMs, env: { LC_ALL: 'C', ...env } });
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

  /** Событие team: что поменялось в клоне. force — и без файлов (отправка или ошибка сети сменили строку синхронизации). */
  private emit(files: string[], force = false): void {
    if (!files.length && !force) return;
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
      if (this.stopped) throw new TeamError(409, 'Команда отключается', 'busy');
      if (this.readonly()) throw new TeamError(409, 'Формат репо команды новее, чем знает agentgraph: обнови его, пока команда только для чтения', 'readonly');
      await this.recover();
      await this.commitManual();
      let gone: string[];
      try {
        await mutate(this);
        gone = await this.rememberTaskNumbers();
      } catch (err) {
        // и индекс тоже: mutate мог положить в него blob (restoreBlob)
        await this.git(['reset', '-q', '--hard', 'HEAD']).catch(() => undefined);
        await this.git(['clean', '-qfd']).catch(() => undefined);
        throw err;
      }
      await this.git(['add', '-A']);
      const files = (await this.git(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
      if (!files.length) return;
      const author = o.author ? ['--author', `${o.author.name} <${o.author.email}>`] : [];
      const msg = typeof message === 'function' ? message() : message;
      const { subject, body } = typeof msg === 'string' ? { subject: msg, body: undefined } : msg;
      try {
        await this.git(['commit', '-q', '--no-verify', ...author, '-m', subject, ...(body ? ['-m', body] : [])]);
      } catch (err) {
        // коммит не удался (подпись коммитов без ключа, нет user.email): рабочая копия возвращается к HEAD, иначе
        // «применённая» правка висела бы без коммита и ломала бы каждую следующую запись
        await this.git(['reset', '-q', '--hard', 'HEAD']).catch(() => undefined);
        await this.git(['clean', '-qfd']).catch(() => undefined);
        throw new TeamError(500, `Коммит в репо команды не удался: ${scrub(errMsg(err))}. Проверь настройки git (user.email, подпись коммитов)`);
      }
      this.forgetWork(gone);
      this.emit(files);
      this.schedulePush();
    });
  }

  /** Двоичная версия файла из объекта git — в рабочую копию и индекс байт в байт («взять моё» у двоичного конфликта). */
  async restoreBlob(rel: string, oid: string): Promise<void> {
    this.abs(rel);
    if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new TeamError(400, `Неверный объект git: ${oid}`);
    const staged = (await this.git(['ls-files', '-s', '-z', '--', rel])).split('\0')[0];
    const mode = staged && REGULAR_MODES.has(staged.split(' ')[0]) ? staged.split(' ')[0] : '100644';
    await this.git(['update-index', '--add', '--cacheinfo', mode, oid, rel]);
    await this.git(['checkout-index', '-f', '--', rel]);
  }

  private async gitDir(): Promise<string> {
    if (this.gitDirPath) return this.gitDirPath;
    const dir = (await this.git(['rev-parse', '--absolute-git-dir'])).trim();
    // служебные файлы ОС не уходят команде и у клонов команд, созданных до .gitignore в шаблоне (D-1): локальное исключение
    try {
      const exclude = path.join(dir, 'info', 'exclude');
      const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      const missing = OS_JUNK.filter((p) => !text.split(/\r?\n/).includes(p));
      if (missing.length) {
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
      }
    } catch {
      // не записалось — не причина не синхронизировать
    }
    return (this.gitDirPath = dir);
  }

  /**
   * Клон после сбоя или выхода посреди своего rebase (spec §7.4 «рабочая копия никогда не остаётся с маркерами конфликта»,
   * D-2): свой rebase помечен файлом REBASE_MARKER с pid процесса — он откатывается, отделённый HEAD возвращается на ветку.
   * Rebase, merge, cherry-pick и revert, начатые человеком руками, файлы с конфликтом в индексе и отделённый HEAD без своего
   * маркера не трогаются: откат стёр бы сведённые руками правки, а add -A закоммитил бы маркеры конфликта и отправил их
   * команде. Тогда — 409 repo_state с подсказкой. Rebase другого живого процесса agentgraph на той же папке данных — 409 busy.
   */
  private async recover(): Promise<void> {
    const dir = await this.gitDir();
    const has = (p: string) => fs.existsSync(path.join(dir, p));
    const repoDir = this.repoDir;
    const stuck = (what: string, fix: string) => new TeamError(409, `В папке команды ${what}. agentgraph его не трогает, чтобы не потерять правки: ${fix}`, 'repo_state');
    const marker = path.join(dir, REBASE_MARKER);
    const ours = fs.existsSync(marker);
    if (ours) {
      const pid = Number(fs.readFileSync(marker, 'utf8').trim());
      if (pid && pid !== process.pid && alive(pid)) throw new TeamError(409, 'Команду сейчас синхронизирует другой процесс agentgraph: попробуй позже', 'busy');
      if (has('rebase-merge') || has('rebase-apply')) {
        await this.git(['rebase', '--abort']).catch(() => this.git(['rebase', '--quit']).catch(() => undefined));
        // состояние rebase битое и git его не снял: убираем сами, дальше — как отделённый HEAD
        for (const p of ['rebase-merge', 'rebase-apply']) if (has(p)) fs.rmSync(path.join(dir, p), { recursive: true, force: true });
      }
    } else if (has('rebase-merge') || has('rebase-apply')) {
      throw stuck('незаконченный rebase', `закончи его или отмени — git -C "${repoDir}" rebase --abort`);
    }
    if (has('MERGE_HEAD')) throw stuck('незаконченное слияние (merge)', `закончи его (git add, git commit) или отмени — git -C "${repoDir}" merge --abort`);
    if (has('CHERRY_PICK_HEAD')) throw stuck('незаконченный cherry-pick', `закончи его или отмени — git -C "${repoDir}" cherry-pick --abort`);
    if (has('REVERT_HEAD')) throw stuck('незаконченный revert', `закончи его или отмени — git -C "${repoDir}" revert --abort`);
    const unmerged = [...new Set((await this.git(['ls-files', '-u', '-z'])).split('\0').filter(Boolean).map((l) => l.slice(l.indexOf('\t') + 1)))];
    if (unmerged.length) throw stuck(`незавершённое слияние: ${unmerged.slice(0, 5).join(', ')}`, `разреши конфликт в файлах или сбрось его — git -C "${repoDir}" reset --merge`);
    if (!(await this.git(['symbolic-ref', '-q', 'HEAD']).then(() => true, () => false))) {
      const head = await this.rev('HEAD');
      const branch = this.branch();
      if (head) {
        if (!ours) throw stuck(`отделённый HEAD (не на ветке ${branch})`, `перейди на ветку — git -C "${repoDir}" checkout ${branch}`);
        const tip = await this.rev(`refs/heads/${branch}`);
        const ancestor = (a: string, b: string) => this.git(['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
        // ветка догоняет HEAD (коммиты отделённого HEAD не теряются), или HEAD отстал от ветки — переходим на неё
        if (!tip || (await ancestor(tip, head))) await this.git(['checkout', '-q', '-B', branch]);
        else if (await ancestor(head, tip)) await this.git(['checkout', '-q', branch]);
        else throw stuck(`отделённый HEAD разошёлся с веткой ${branch}`, `перейди на ветку — git -C "${repoDir}" checkout ${branch}`);
      }
    }
    if (ours) fs.rmSync(marker, { force: true });
  }

  /** Незакоммиченные правки не через agentgraph — отдельным коммитом (spec §7.6). true — что-то было. */
  private async commitManual(): Promise<boolean> {
    const status = (await this.git(['status', '--porcelain', '--untracked-files=all'])).trim();
    if (!status) return false;
    const gone = await this.rememberTaskNumbers().catch(() => []);
    await this.git(['add', '-A']);
    try {
      await this.git(['commit', '-q', '--no-verify', '-m', MANUAL_MESSAGE]);
    } catch (err) {
      // нечего коммитить после add (например, только игнорируемое) — не ошибка
      if (!/nothing to commit|nothing added/.test(errMsg(err))) throw err;
      return false;
    }
    this.forgetWork(gone);
    return true;
  }

  /** Номера задач в рабочей копии, по всем проектам (номер сквозной, spec §5.7). */
  taskIds(): string[] {
    return this.dirs('projects').flatMap((p) => this.list(`projects/${p}/tasks`, (n) => /\.md$/i.test(n)).map((n) => n.replace(/\.md$/i, '')));
  }

  /**
   * Файл задачи исчез из рабочей копии относительно HEAD (удаление через API, руками в папке): наибольший номер команды на
   * этот момент запоминается в teamwork.yaml → lastTask тем же коммитом, и номер удалённой задачи больше не выдаётся
   * (spec §5.7). Создание задачи счётчик не трогает: её номер и так виден среди задач, а teamwork.yaml не становится местом
   * конфликтов при одновременном создании задач. Формат новее известного — файл не трогаем. Возвращает номера исчезнувших.
   */
  private async rememberTaskNumbers(): Promise<string[]> {
    const gone = (await this.git(['diff', '--name-only', '--no-renames', '--diff-filter=D', 'HEAD'])).split('\n').map((f) => f.match(TASK_FILE_RE)?.[2]).filter((x): x is string => Boolean(x));
    if (!gone.length || this.readonly()) return gone;
    const text = this.read('teamwork.yaml');
    if (text === undefined) return gone;
    let prefix: string;
    try {
      prefix = parseTeamConfig(text).prefix;
    } catch {
      // teamwork.yaml правлен руками и не читается: счётчик не пишем, файл не трогаем
      return gone;
    }
    const top = maxTaskNumber([...gone, ...this.taskIds()], prefix);
    if (top > lastTaskOf(text)) this.writeFile('teamwork.yaml', updateYaml(text, { lastTask: top }));
    return gone;
  }

  /**
   * Запуски и сессии удалённых задач (local.json → work) забываются: номер мог совпасть с задачей, которую команда завела
   * одновременно, и чужая задача не должна получить мою работу.
   */
  private forgetWork(ids: string[]): void {
    const known = ids.filter((id) => this.local().work[id]);
    if (known.length) this.saveLocal((l) => known.forEach((id) => delete l.work[id]));
  }

  // ---------- отправка и получение (spec §7.2–7.5)

  schedulePush(delayMs = this.deps.pushDelayMs): void {
    // Infinity — автоматической отправки нет (тесты): push только явный
    if (this.stopped || !Number.isFinite(delayMs)) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.push().catch(() => undefined);
    }, delayMs);
    this.pushTimer.unref();
  }

  /** Отправить сейчас, без ожидания таймера (тесты и кнопка «Повторить»). После stop() — ничего (D-15). */
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

  /** Версия формата teamwork.yaml в репо команды (origin) после fetch; файла нет или не читается — undefined. */
  private async remoteFormat(): Promise<number | undefined> {
    const text = await this.show(`origin/${this.branch()}`, 'teamwork.yaml');
    if (text === undefined) return undefined;
    try {
      const raw = parseYaml(text) as { format?: unknown } | null;
      return typeof raw?.format === 'number' && Number.isInteger(raw.format) ? raw.format : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Внутри очереди: правки руками, fetch, слияние, push при push и неотправленных коммитах. Ошибка сети — в local.sync.error
   * и повтор. Событие team — одно на вызов: fetch принёс изменения, коммиты ушли, ошибка синхронизации появилась или
   * снялась (UI не опрашивает сервер, пока идёт отправка, а ждёт этого события). Смена одного текста ошибки на другой
   * («…after 3 ms» → «…after 4 ms») события не даёт: иначе событие → GET команды → фоновый pull → новая ошибка → событие.
   */
  private async syncNow(push: boolean): Promise<string[]> {
    // остановлен или отключён: операция, вставшая в очередь до stop(), клон и local.json не трогает (D-15)
    if (this.stopped) return [];
    this.busy = true;
    let changed: string[] = [];
    let pushed = false;
    const failedBefore = Boolean(this.local().sync.error);
    try {
      await this.recover();
      await this.commitManual();
      await this.fetch();
      const format = await this.remoteFormat();
      if (format !== this.local().sync.format) this.saveLocal((l) => (format === undefined ? delete l.sync.format : (l.sync.format = format)));
      changed = await this.integrate(format !== undefined && format > TEAM_FORMAT);
      if (push && (await this.unpushed()) > 0) {
        await this.git(['push', '-q', '-u', 'origin', `HEAD:refs/heads/${this.branch()}`], NET_TIMEOUT);
        pushed = true;
        this.saveLocal((l) => {
          l.sync.lastPushAt = this.deps.now().toISOString();
          l.sync.error = null;
        });
      } else if (push) {
        this.saveLocal((l) => (l.sync.error = null));
      }
      this.retryMs = 0;
    } catch (err) {
      const msg = scrub(errMsg(err));
      this.saveLocal((l) => (l.sync.error = msg));
      if (push) {
        this.retryMs = Math.min(Math.max(this.retryMs * 2, this.deps.retryMinMs), this.deps.retryMaxMs);
        this.schedulePush(this.retryMs);
      }
      throw err;
    } finally {
      this.busy = false;
      this.emit(changed, pushed || Boolean(this.local().sync.error) !== failedBefore);
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
   * конфликте откат и перепроигрывание моих коммитов слиянием полей (replay). Возвращает изменившиеся файлы. Нет общей
   * истории (репо команды пересоздан или история переписана) — ошибка без replay и push: иначе «моим» стало бы всё дерево
   * и откатило бы репо команды к моему снимку (D-7). newer — репо команды на формате новее известного: только
   * fast-forward, без replay, переименований и понижения спринтов (D-8); разошлись — ошибка readonly, мои коммиты ждут.
   * Мои коммиты поверх их последнего (правка руками в клоне на новом формате) уходят обычным push: их файлы никто не сливал.
   */
  private async integrate(newer = false): Promise<string[]> {
    const remoteRef = `origin/${this.branch()}`;
    const remote = await this.rev(remoteRef);
    const head = await this.rev('HEAD');
    if (!remote || !head || remote === head) return [];
    const base = (await this.git(['merge-base', 'HEAD', remoteRef]).catch(() => '')).trim();
    if (!base) throw new TeamError(409, 'История репо команды переписана: у клона нет с ней общих коммитов. Отключи команду и подключись заново', 'rewritten');
    if (base === remote) return [];
    if (base === head) await this.git(['merge', '-q', '--ff-only', remoteRef]);
    else {
      if (newer) throw readonlyError();
      // свой rebase помечен: сбой или выход посреди него следующий recover() откатит, а чужой — нет
      const marker = path.join(await this.gitDir(), REBASE_MARKER);
      fs.writeFileSync(marker, String(process.pid));
      try {
        await this.git(['rebase', '-q', remoteRef]);
        fs.rmSync(marker, { force: true });
      } catch {
        await this.git(['rebase', '--abort']).catch(() => undefined);
        // abort не снял состояние rebase — recover() снимет его по маркеру и вернёт HEAD на ветку, иначе ошибка: replay
        // на отделённом HEAD посреди rebase сдвинул бы не ту ветку
        await this.recover();
        await this.replay(base, head, remote);
      }
    }
    if (!newer) await this.afterIntegrate();
    const now = await this.rev('HEAD');
    return (await this.git(['diff', '--name-only', '-z', head, now ?? 'HEAD'])).split('\0').filter(Boolean);
  }

  private show(ref: string, file: string): Promise<string | undefined> {
    return this.git(['show', `${ref}:${file}`]).then(
      (s) => s,
      () => undefined,
    );
  }

  /** Дерево коммита целиком: путь → режим и объект. -z — имена с табом и переводом строки как есть, без кавычек. */
  private async tree(ref: string): Promise<Map<string, TreeEntry>> {
    const map = new Map<string, TreeEntry>();
    for (const rec of (await this.git(['ls-tree', '-r', '-z', '--full-tree', ref])).split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [mode, , oid] = rec.slice(0, tab).split(' ');
      map.set(rec.slice(tab + 1), { mode, oid });
    }
    return map;
  }

  /** Изменения a..b: путь → A, M, D или T (смена типа). -z — имена как есть. */
  private async changes(a: string, b: string): Promise<Map<string, string>> {
    const parts = (await this.git(['diff', '--name-status', '-z', '--no-renames', a, b])).split('\0');
    const map = new Map<string, string>();
    for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) map.set(parts[i + 1], parts[i][0]);
    return map;
  }

  /** Двоичные среди изменённых a..b: git сам решает по содержимому (--numstat даёт «-»). */
  private async binaries(a: string, b: string): Promise<Set<string>> {
    const set = new Set<string>();
    for (const rec of (await this.git(['diff', '--numstat', '-z', '--no-renames', a, b])).split('\0')) {
      const m = rec.match(/^(-|\d+)\t(-|\d+)\t([\s\S]+)$/);
      if (m && m[1] === '-') set.add(m[3]);
    }
    return set;
  }

  /**
   * Текст объекта git; ошибка чтения — исключение, а не «файла нет» (иначе перепроигрывание удалило бы файл, D-1). Не
   * UTF-8 (байты не сходятся после декодирования) или больше MAX_MERGE_BYTES — undefined: такой файл как текст не сливается.
   */
  private async blobText(oid: string): Promise<string | undefined> {
    const size = Number((await this.git(['cat-file', '-s', oid])).trim());
    if (size > MAX_MERGE_BYTES) return undefined;
    const text = await this.git(['cat-file', 'blob', oid]);
    return Buffer.byteLength(text) === size && !text.includes('\uFFFD') ? text : undefined;
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

  /**
   * Перепроигрывание моих коммитов base..head поверх remote (spec §7.4): файл менял только я — моя версия байт в байт
   * (объект git, текст не читается: двоичные, большие, со странными именами и сменившие тип файлы не портятся и не
   * теряются, D-1); только они — их; оба — задача по полям, YAML по полям, текст через merge-file; двоичный или не UTF-8,
   * изменённый обоими, — версия команды, моя — в конфликт с blob. Удалено с одной стороны и изменено с другой — как у
   * команды, моё в конфликт deleted; если команда правила задачу, которую я удалил, остаются и её комментарии, и ссылки
   * соседей, снятые тем же удалением; мой новый комментарий к задаче, которую удалила команда, — в конфликт deleted (D-5).
   * Задача с тем же номером с обеих сторон — моя переименовывается в свободный номер (§5.7) вместе с моими комментариями
   * к ней (D-4) и моими ссылками на неё (D-14). Итог — один коммит с темами моих коммитов, собранный во временном индексе:
   * HEAD и рабочая копия не трогаются, пока коммит не готов и конфликты не записаны (D-6).
   */
  private async replay(base: string, head: string, remote: string): Promise<void> {
    const [mine, theirs, baseTree, headTree, remoteTree] = await Promise.all([this.changes(base, head), this.changes(base, remote), this.tree(base), this.tree(head), this.tree(remote)]);
    const binary = new Set([...(await this.binaries(base, head)), ...(await this.binaries(base, remote))]);
    const subjects = (await this.git(['log', '--reverse', '--format=%s', `${remote}..${head}`])).split('\n').filter(Boolean);
    const at = this.deps.now().toISOString();
    const out = new Map<string, ReplayOut>();
    const conflicts: TeamConflict[] = [];
    const theirAuthor = async (file: string) => (await this.git(['log', '-1', '--format=%ae', remote, '--', file]).catch(() => '')).trim() || undefined;
    const isText = (file: string, ...es: (TreeEntry | undefined)[]) => !binary.has(file) && es.every((e) => !e || REGULAR_MODES.has(e.mode));
    const textAt = async (t: Map<string, TreeEntry>, file: string) => {
      const e = t.get(file);
      return e ? this.blobText(e.oid) : undefined;
    };
    const conflict = async (file: string, kind: TeamConflict['kind'], ours: unknown, theirsV: unknown, o: { field?: string; blob?: string } = {}): Promise<void> => {
      const m = file.match(TASK_FILE_RE) ?? file.match(COMMENT_FILE_RE);
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
        ...(o.field ? { field: o.field } : {}),
        ours,
        theirs: theirsV,
        ...(o.blob ? { blob: o.blob } : {}),
        ...(by ? { theirsBy: by } : {}),
        at,
      });
    };
    /** Сторона конфликта по объекту: текст или, у двоичного, подпись и blob моей версии для «взять моё». */
    const side = async (file: string, e: TreeEntry | undefined): Promise<{ value: unknown; blob?: string }> => {
      if (!e) return { value: null };
      // подмодуль (вложенный репо, добавленный add -A): его коммита в этом репо нет
      if (e.mode === '160000') return { value: `подмодуль ${e.oid}` };
      const text = isText(file, e) ? await this.blobText(e.oid) : undefined;
      if (text !== undefined) return { value: text };
      const size = Number((await this.git(['cat-file', '-s', e.oid])).trim());
      return { value: `двоичный файл, ${size} Б`, blob: e.oid };
    };
    const entryConflict = async (file: string, kind: TeamConflict['kind'], h: TreeEntry | undefined, r: TreeEntry | undefined) => {
      const [m, t] = await Promise.all([side(file, h), side(file, r)]);
      await conflict(file, kind, m.value, t.value, m.blob ? { blob: m.blob } : {});
    };
    // поля спринта — обычные поля с «взять моё»; kind sprint — только у двух активных спринтов (D-13)
    const fieldConflicts = (file: string, list: FieldConflict[]) =>
      Promise.all(list.map((c) => conflict(file, c.field === 'body' || c.field === 'text' ? 'text' : 'field', c.ours, c.theirs, { field: c.field })));
    // номера задач сквозные по команде (§5.7): занятые — в дереве команды (любой проект) и в моём, чтобы свободный номер
    // не совпал и с моей же новой задачей; и за последним выданным с обеих сторон (lastTask)
    const idsIn = (t: Map<string, TreeEntry>) => new Set([...t.keys()].map((f) => f.match(TASK_FILE_RE)?.[2]).filter((x): x is string => Boolean(x)));
    const remoteIds = idsIn(remoteTree);
    const knownIds = new Set([...remoteIds, ...idsIn(headTree)]);
    const last = Math.max(lastTaskOf(await textAt(remoteTree, 'teamwork.yaml')), lastTaskOf(await textAt(headTree, 'teamwork.yaml')));
    // моя новая задача с номером, уже занятым в репо команды (тем же путём или в другом проекте), получает свободный
    // номер: её ещё никто не видел
    const renames = new Map<string, { to: string; slug: string }>();
    for (const [file, st] of mine) {
      const m = file.match(TASK_FILE_RE);
      if (!m || st !== 'A' || !remoteIds.has(m[2]) || remoteTree.get(file)?.oid === headTree.get(file)?.oid) continue;
      const to = nextTaskId(knownIds, m[2].split('-')[0], last);
      knownIds.add(to);
      renames.set(m[2], { to, slug: m[1] });
      subjects.push(`${m[2]} → ${to}: номер уже занят`);
    }
    for (const [file, st] of mine) {
      const h = st === 'D' ? undefined : headTree.get(file);
      const tm = file.match(TASK_FILE_RE);
      const rn = tm && st === 'A' ? renames.get(tm[2]) : undefined;
      if (tm && rn && h) {
        const newFile = `projects/${tm[1]}/tasks/${rn.to}.md`;
        const text = await this.blobText(h.oid);
        if (text === undefined) out.set(newFile, h);
        else {
          const t = parseTask(text, file);
          out.set(newFile, { text: t.error ? text.replace(new RegExp(`^id: ${tm[2]}$`, 'm'), `id: ${rn.to}`) : serializeTask({ ...t, id: rn.to, file: newFile }), mode: h.mode });
        }
        continue;
      }
      // мои комментарии к своей переименованной задаче — за ней (D-4)
      const cm = file.match(COMMENT_FILE_RE);
      const crn = cm && st === 'A' ? renames.get(cm[2]) : undefined;
      if (cm && crn && crn.slug === cm[1] && h) {
        out.set(`projects/${cm[1]}/comments/${crn.to}/${cm[3]}`, h);
        continue;
      }
      const ts = theirs.get(file);
      if (!ts) {
        out.set(file, h ?? null);
        continue;
      }
      const r = ts === 'D' ? undefined : remoteTree.get(file);
      if (!h || !r) {
        if (h || r) await entryConflict(file, 'deleted', h, r);
        continue;
      }
      if (h.oid === r.oid) {
        // содержимое то же, разошёлся только режим (исполняемый, тип): менял его я — мой, иначе команды
        if (h.mode !== r.mode && baseTree.get(file)?.mode === r.mode) out.set(file, h);
        continue;
      }
      const b = st === 'A' ? undefined : baseTree.get(file);
      const texts = isText(file, b, h, r) ? await Promise.all([b ? this.blobText(b.oid) : Promise.resolve(''), this.blobText(h.oid), this.blobText(r.oid)]) : undefined;
      if (!texts || texts.some((x) => x === undefined)) {
        // двоичный (или не UTF-8) и изменён обоими: в репо — версия команды, моя — blob в конфликте
        await entryConflict(file, 'text', h, r);
        continue;
      }
      const [baseText, mineText, theirText] = texts as string[];
      if (tm) {
        const res = await mergeTaskTexts(b ? baseText : undefined, mineText, theirText, file, (x, y, z) => this.mergeText(x, y, z));
        out.set(file, { text: res.text, mode: r.mode });
        await fieldConflicts(file, res.conflicts);
      } else if (/\.ya?ml$/.test(file)) {
        const res = mergeYamlTexts(b ? baseText : undefined, mineText, theirText);
        out.set(file, { text: res.text, mode: r.mode });
        await fieldConflicts(file, res.conflicts);
      } else {
        const merged = await this.mergeText(baseText, mineText, theirText);
        if (merged !== undefined) out.set(file, { text: merged, mode: r.mode });
        else await conflict(file, 'text', mineText, theirText);
      }
    }
    // задача, которую я удалил, а команда правила, остаётся (конфликт deleted): её комментарии, удалённые тем же моим
    // удалением, тоже остаются (D-5)
    const revived = new Set(
      conflicts.flatMap((c) => {
        const m = c.kind === 'deleted' && c.ours === null ? c.file.match(TASK_FILE_RE) : null;
        return m ? [`${m[1]}/${m[2]}`] : [];
      }),
    );
    for (const [file, o] of [...out]) {
      const cm = file.match(COMMENT_FILE_RE);
      if (cm && o === null && revived.has(`${cm[1]}/${cm[2]}`)) out.delete(file);
    }
    if (renames.size || revived.size) {
      const blocked = async (t: Map<string, TreeEntry>, file: string) => {
        const text = await textAt(t, file);
        const x = text === undefined ? undefined : parseTask(text, file);
        return x && !x.error ? x.blockedBy : [];
      };
      for (const [file, o] of [...out]) {
        const tm = file.match(TASK_FILE_RE);
        if (!tm || o === null) continue;
        const text = 'text' in o ? o.text : await this.blobText(o.oid);
        if (text === undefined) continue;
        const t = parseTask(text, file);
        if (t.error) continue;
        const [inBase, inTheirs] = await Promise.all([blocked(baseTree, file), blocked(remoteTree, file)]);
        // моя ссылка на свою переименованную задачу (её нет ни в базе, ни у команды) идёт за новым номером (D-14)
        let next = t.blockedBy.map((x) => (renames.has(x) && !inBase.includes(x) && !inTheirs.includes(x) ? renames.get(x)!.to : x));
        // ссылка на задачу, которую команда оставила: была в базе и у команды, снял её мой коммит удаления (D-5)
        for (const x of inBase) if (revived.has(`${tm[1]}/${x}`) && inTheirs.includes(x) && !next.includes(x)) next = [...next, x];
        if (next.join('\n') !== t.blockedBy.join('\n')) out.set(file, { text: updateTaskText(text, { blockedBy: next }), mode: o.mode });
      }
    }
    // мой новый комментарий к задаче, которую команда удалила, — в конфликт deleted, а не сиротой в репо (D-5)
    for (const [file, o] of [...out]) {
      const cm = file.match(COMMENT_FILE_RE);
      if (!cm || o === null || 'text' in o || mine.get(file) !== 'A') continue;
      const taskFile = `projects/${cm[1]}/tasks/${cm[2]}.md`;
      if (!baseTree.has(taskFile) || theirs.get(taskFile) !== 'D' || out.get(taskFile)) continue;
      out.delete(file);
      await entryConflict(file, 'deleted', o, undefined);
    }
    // файл и папка с одним путём (у меня a стала папкой a/b, а у команды a осталась файлом): такое дерево не собрать —
    // моё в конфликт, а не ошибка синхронизации на каждом повторе
    const parents = (f: string) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
    const files = new Set(remoteTree.keys());
    for (const [f, o] of out) {
      if (o === null) files.delete(f);
      else files.add(f);
    }
    const folders = new Set([...files].flatMap(parents));
    for (const [file, o] of [...out]) {
      if (o === null || !(folders.has(file) || parents(file).some((d) => files.has(d)))) continue;
      out.delete(file);
      files.delete(file);
      if ('text' in o) await conflict(file, 'deleted', o.text, null);
      else await entryConflict(file, 'deleted', o, undefined);
    }
    const commit = await this.replayCommit(remote, out, subjects);
    // конфликты и переезд работы — до сдвига ветки: сбой после них повторит перепроигрывание, а повтор конфликты не задвоит
    const known = this.local().conflicts;
    const fresh = conflicts.filter((c) => !known.some((x) => sameConflict(x, c)));
    for (const c of fresh) if (c.blob) await this.git(['update-ref', `${CONFLICT_REF}${c.id}`, c.blob]);
    if (fresh.length || renames.size) {
      this.saveLocal((l) => {
        l.conflicts.push(...fresh);
        for (const [from, { to }] of renames) moveWork(l, from, to);
      });
    }
    await this.git(['reset', '-q', '--hard', commit]);
  }

  /**
   * Коммит поверх parent из итога перепроигрывания во временном индексе (GIT_INDEX_FILE): объекты — как есть, тексты —
   * hash-object, удалённые — force-remove. HEAD, индекс клона и рабочая копия не трогаются; дерево не изменилось — parent.
   */
  private async replayCommit(parent: string, out: Map<string, ReplayOut>, subjects: string[]): Promise<string> {
    const tmp = fs.mkdtempSync(path.join(this.deps.tmpDir, 'agentgraph-replay-'));
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    try {
      await this.git(['read-tree', parent], GIT_TIMEOUT, env);
      const remove: string[] = [];
      const add: string[] = [];
      let n = 0;
      for (const [file, o] of out) {
        if (o === null) {
          remove.push(file);
          continue;
        }
        let oid = 'oid' in o ? o.oid : '';
        if ('text' in o) {
          const f = path.join(tmp, `blob-${n++}`);
          fs.writeFileSync(f, o.text);
          oid = (await this.git(['hash-object', '-w', '--no-filters', '--', f])).trim();
        }
        add.push('--cacheinfo', o.mode, oid, file);
      }
      for (let i = 0; i < remove.length; i += 200) await this.git(['update-index', '--force-remove', '--', ...remove.slice(i, i + 200)], GIT_TIMEOUT, env);
      for (let i = 0; i < add.length; i += 800) await this.git(['update-index', '--add', ...add.slice(i, i + 800)], GIT_TIMEOUT, env);
      const tree = (await this.git(['write-tree'], GIT_TIMEOUT, env)).trim();
      if (tree === (await this.git(['rev-parse', `${parent}^{tree}`])).trim()) return parent;
      const subject = subjects.length === 1 ? subjects[0] : `Слияние с командой: ${subjects.length} изменений`;
      const body = subjects.length > 1 ? subjects.map((s) => `- ${s}`).join('\n') : '';
      // commit-tree сам commit.gpgSign не читает, а git commit читает: подпись — как у остальных коммитов клона
      const sign = (await this.git(['config', '--bool', '--get', 'commit.gpgsign']).catch(() => '')).trim() === 'true';
      return (await this.git(['commit-tree', ...(sign ? ['-S'] : []), tree, '-p', parent, '-m', subject, ...(body ? ['-m', body] : [])])).trim();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * После слияния: совпавшие номера задач между проектами (§5.7), два активных спринта (§7.4.4), незавершённые задачи
   * закрытых спринтов (D-17).
   */
  private async afterIntegrate(): Promise<void> {
    await this.renameDuplicateIds();
    await this.demoteSecondSprint();
    await this.returnFromClosedSprints();
  }

  /** Пути, которые различаются между a и b, с фильтром git (A, AM…); -z — имена как есть. */
  private async diffNames(a: string, b: string, filter: string): Promise<Set<string>> {
    return new Set((await this.git(['diff', '--name-only', '-z', `--diff-filter=${filter}`, a, b])).split('\0').filter(Boolean));
  }

  /**
   * После слияния своя неотправленная задача получает свободный номер (§5.7), если её номер уже занят в команде: задачей
   * другого проекта (после чистого rebase; общий путь дал бы конфликт и переименование в replay) или выдан там и удалён —
   * файла у команды нет, но её lastTask этот номер помнит. Мою задачу ещё никто не видел: за ней переезжают мои
   * комментарии к ней (D-4) и мои ссылки на неё в моих новых и изменённых задачах, которых нет у команды (D-14).
   */
  private async renameDuplicateIds(): Promise<void> {
    const byId = new Map<string, string[]>();
    for (const slug of this.dirs('projects')) {
      for (const name of this.list(`projects/${slug}/tasks`, (n) => /\.md$/i.test(n))) {
        const file = `projects/${slug}/tasks/${name}`;
        const id = file.match(TASK_FILE_RE)?.[2];
        if (id) byId.set(id, [...(byId.get(id) ?? []), file]);
      }
    }
    const remoteRef = `origin/${this.branch()}`;
    const hasRemote = Boolean(await this.rev(remoteRef));
    // последний номер, выданный командой: моя задача с номером не больше него создана до того, как я его получил
    const teamLast = hasRemote ? lastTaskOf(await this.show(remoteRef, 'teamwork.yaml')) : 0;
    const dups = [...byId].filter(([, files]) => files.length > 1);
    if (!dups.length && !teamLast) return;
    const since = hasRemote ? remoteRef : await this.emptyTree();
    const mineAdded = await this.diffNames(since, 'HEAD', 'A');
    const ids = new Set(byId.keys());
    const last = Math.max(lastTaskOf(this.read('teamwork.yaml')), teamLast);
    const wanted: { id: string; file: string; why: string }[] = [];
    for (const [id, files] of dups) {
      const mine = files.filter((f) => mineAdded.has(f));
      // все мои — оставляем первую; ничья — не трогаем (чужие задачи, их починит автор)
      for (const file of mine.length === files.length ? mine.slice(1) : mine) wanted.push({ id, file, why: 'номер уже занят' });
    }
    for (const [id, files] of byId) {
      // один файл и он мой: у команды такой задачи нет — номер выдан и удалён там, если он не больше её lastTask
      if (files.length === 1 && mineAdded.has(files[0]) && taskNumber(id) <= teamLast) wanted.push({ id, file: files[0], why: 'номер уже выдавался в команде' });
    }
    const renames = new Map<string, string>();
    const subjects: string[] = [];
    for (const { id, file, why } of wanted) {
      const fresh = nextTaskId(ids, id.split('-')[0], last);
      ids.add(fresh);
      const slug = file.match(TASK_FILE_RE)![1];
      const newFile = `projects/${slug}/tasks/${fresh}.md`;
      const text = this.read(file) ?? '';
      const t = parseTask(text, file);
      this.writeFile(newFile, t.error ? text.replace(new RegExp(`^id: ${id}$`, 'm'), `id: ${fresh}`) : serializeTask({ ...t, id: fresh, file: newFile }));
      this.remove(file);
      const dir = `projects/${slug}/comments/${id}`;
      for (const name of this.list(dir)) {
        if (!mineAdded.has(`${dir}/${name}`)) continue;
        const to = this.abs(`projects/${slug}/comments/${fresh}/${name}`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(this.abs(`${dir}/${name}`), to);
      }
      // пустая папка старого номера не нужна (git её и так не хранит)
      if (!fs.existsSync(this.abs(dir)) || !fs.readdirSync(this.abs(dir)).length) this.remove(dir);
      renames.set(id, fresh);
      subjects.push(`${id} → ${fresh}: ${why}`);
    }
    if (!renames.size) return;
    for (const file of await this.diffNames(since, 'HEAD', 'AM')) {
      if (!TASK_FILE_RE.test(file) || !this.exists(file)) continue;
      const text = this.read(file) ?? '';
      const t = parseTask(text, file);
      if (t.error || !t.blockedBy.some((b) => renames.has(b))) continue;
      const theirsText = hasRemote ? await this.show(remoteRef, file) : undefined;
      const theirs = theirsText === undefined ? undefined : parseTask(theirsText, file);
      const theirsBlocked = theirs && !theirs.error ? theirs.blockedBy : [];
      const next = t.blockedBy.map((b) => (renames.has(b) && !theirsBlocked.includes(b) ? renames.get(b)! : b));
      if (next.join('\n') !== t.blockedBy.join('\n')) this.writeFile(file, updateTaskText(text, { blockedBy: next }));
    }
    await this.git(['add', '-A']);
    await this.git(['commit', '-q', '--no-verify', '-m', subjects.length === 1 ? subjects[0] : 'Номера задач заняты', ...(subjects.length > 1 ? ['-m', subjects.map((x) => `- ${x}`).join('\n')] : [])]);
    this.saveLocal((l) => {
      for (const [from, to] of renames) moveWork(l, from, to);
    });
  }

  /**
   * Незавершённая задача в закрытом спринте не видна ни в бэклоге, ни на доске: так бывает, когда закрытие спринта
   * разошлось с одновременным переносом задачи в него. После слияния она возвращается в бэклог (D-17). Снимается только
   * поле sprint, без updatedAt: правка одинакова на всех клонах и конфликтов не даёт.
   */
  private async returnFromClosedSprints(): Promise<void> {
    const moved: string[] = [];
    for (const slug of this.dirs('projects')) {
      const closed = new Set<number>();
      for (const name of this.list(`projects/${slug}/sprints`, (n) => /^\d+\.ya?ml$/.test(n))) {
        try {
          const s = parseSprint(this.read(`projects/${slug}/sprints/${name}`) ?? '', Number(name.split('.')[0]));
          if (s.status === 'closed') closed.add(s.number);
        } catch {
          // битый спринт пропускаем: его покажет экран
        }
      }
      if (!closed.size) continue;
      for (const name of this.list(`projects/${slug}/tasks`, (n) => /\.md$/i.test(n))) {
        const file = `projects/${slug}/tasks/${name}`;
        const text = this.read(file) ?? '';
        const t = parseTask(text, file);
        if (t.error || t.sprint === undefined || !closed.has(t.sprint) || t.status === 'done') continue;
        this.writeFile(file, updateTaskText(text, { sprint: undefined }));
        moved.push(`${t.id}: в бэклог — спринт ${t.sprint} закрыт`);
      }
    }
    if (!moved.length) return;
    await this.git(['add', '-A']);
    await this.git(['commit', '-q', '--no-verify', '-m', moved.length === 1 ? moved[0] : 'Задачи закрытых спринтов — в бэклог', ...(moved.length > 1 ? ['-m', moved.map((x) => `- ${x}`).join('\n')] : [])]);
  }

  private emptyTree(): Promise<string> {
    return this.git(['hash-object', '-t', 'tree', '/dev/null']).then((s) => s.trim());
  }

  /** Два активных спринта в проекте после слияния — активным остаётся более ранний, второй снова запланирован (spec §7.4.4). */
  private async demoteSecondSprint(): Promise<void> {
    const at = this.deps.now().toISOString();
    const me = (await this.identity()).email;
    const demoted: string[] = [];
    const conflicts: TeamConflict[] = [];
    for (const slug of this.dirs('projects')) {
      const dir = `projects/${slug}/sprints`;
      const active: { file: string; text: string; number: number; startedAt: string; startedBy?: string }[] = [];
      for (const name of this.list(dir, (n) => /^\d+\.ya?ml$/.test(n))) {
        const text = this.read(`${dir}/${name}`);
        if (text === undefined) continue;
        try {
          const s = parseSprint(text, Number(name.split('.')[0]));
          if (s.status === 'active') active.push({ file: `${dir}/${name}`, text, number: s.number, startedAt: s.startedAt ?? '', startedBy: s.startedBy });
        } catch {
          // битый спринт пропускаем: его покажет экран
        }
      }
      if (active.length < 2) continue;
      active.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.number - b.number);
      const keep = active[0];
      for (const s of active.slice(1)) {
        this.writeFile(s.file, updateYaml(s.text, { status: 'planned', startedAt: undefined, startedBy: undefined }));
        demoted.push(`спринт ${s.number} → запланирован, активен спринт ${keep.number} (${slug})`);
        // в панель «Конфликты» — только участникам этих спринтов; остальные клоны делают тот же детерминированный фикс молча
        if (me && (s.startedBy === me || keep.startedBy === me)) {
          conflicts.push({ id: randomBytes(6).toString('hex'), file: s.file, project: slug, kind: 'sprint', ours: s.number, theirs: keep.number, at });
        }
      }
    }
    if (!demoted.length) return;
    await this.git(['add', '-A']);
    await this.git(['commit', '-q', '--no-verify', '-m', `Два активных спринта: ${demoted.join('; ')}`]);
    if (conflicts.length) this.saveLocal((l) => l.conflicts.push(...conflicts));
  }

  /**
   * Что не ушло в репо команды: коммиты HEAD и ветки (клон мог остаться посреди rebase с отделённым HEAD, а мои коммиты —
   * только на ветке, D-2), которых нет в origin. Нет origin-ветки (пустой репо до первого push) — все коммиты.
   */
  private async unpushedRange(): Promise<string[]> {
    const branch = this.branch();
    const tips = ['HEAD', ...((await this.rev(`refs/heads/${branch}`)) ? [`refs/heads/${branch}`] : [])];
    return (await this.rev(`origin/${branch}`)) ? [...tips, '--not', `origin/${branch}`] : tips;
  }

  async unpushed(): Promise<number> {
    const n = (await this.git(['rev-list', '--count', ...(await this.unpushedRange())]).catch(() => '0')).trim();
    return Number(n) || 0;
  }

  async unpushedSubjects(): Promise<string[]> {
    return (await this.git(['log', '--format=%s', ...(await this.unpushedRange())]).catch(() => '')).split('\n').filter(Boolean);
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
    const limit = Math.min(Math.max(Number.isFinite(o.limit) ? Math.trunc(o.limit!) : 20, 1), 200);
    const out = await this.git(['log', `-n${limit}`, '--format=%H%x00%an%x00%ae%x00%aI%x00%s', ...(o.path ? ['--', o.path] : [])]).catch(() => '');
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, author, email, at, message] = l.split('\0');
        return { hash, author, email, at, message };
      });
  }

  /**
   * Версия файла клона с этим хэшем текста (textHash) — сейчас или в одном из последних коммитов по нему: base, с которым
   * клиент открыл форму настроек или проекта (D-10). Не нашлась — undefined.
   */
  async versionByHash(rel: string, hash: string, limit = 50): Promise<string | undefined> {
    const now = this.read(rel);
    if (now !== undefined && textHash(now) === hash) return now;
    const commits = (await this.git(['log', `-n${limit}`, '--format=%H', '--', rel]).catch(() => '')).split('\n').filter(Boolean);
    for (const c of commits) {
      const text = await this.show(c, rel);
      if (text !== undefined && textHash(text) === hash) return text;
    }
    return undefined;
  }

  // ---------- таймеры (spec §7.3)

  startTimers(hasSubscribers: () => boolean): void {
    this.hasSubscribers = hasSubscribers;
    this.timersOn = true;
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

  /**
   * Остановить таймеры и дождаться текущей операции; дальше клон только читается: запись отвечает 409 busy, отправка и
   * получение, вставшие в очередь, ничего не делают (D-15).
   */
  async stop(): Promise<void> {
    this.closed = true;
    await this.halt();
  }

  /** Таймеры сняты, очередь дождалась; closed не ставится — отключение после отказа возвращает клон в работу. */
  private async halt(): Promise<void> {
    this.stopped = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pushTimer = undefined;
    this.pollTimer = undefined;
    await this.chain.catch(() => undefined);
  }

  /**
   * Отключить команду: удалить клон (spec §8.2). Сначала остановка и ожидание очереди — считать неотправленное, пока идёт
   * запись или отправка, нельзя (D-11). Неотправленные коммиты или нерешённые конфликты (мои версии в local.json пропадут
   * вместе с ним) без force — 409 unpushed со списком, клон снова работает: таймеры и отложенная отправка возвращаются.
   */
  async disconnect(force: boolean): Promise<void> {
    await this.halt();
    const unpushed = await this.unpushed();
    // «два активных спринта» (sprint без поля) — сообщение без моей версии: терять в нём нечего
    const conflicts = this.local().conflicts.filter((c) => !(c.kind === 'sprint' && !c.field)).length;
    if ((unpushed || conflicts) && !force) {
      const commits = await this.unpushedSubjects();
      // сервис команд за это время остановился (выход): клон остаётся остановленным
      if (!this.closed) {
        this.stopped = false;
        if (this.timersOn) this.schedulePoll();
        if (unpushed) this.schedulePush();
      }
      const what = [unpushed ? `не отправлено: ${unpushed} изменений` : '', conflicts ? `нерешённых конфликтов: ${conflicts}` : ''].filter(Boolean).join('; ');
      throw new TeamError(409, `${what[0].toUpperCase()}${what.slice(1)}. Они пропадут вместе с клоном.`, 'unpushed', { unpushed, commits, conflicts });
    }
    this.removed = true;
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
    return { kind: 'error', error: scrub(errMsg(err)) };
  }
  if (!heads.length) return { kind: 'empty' };
  const branch = pickBranch(heads)!;
  const tmp = fs.mkdtempSync(path.join(deps.tmpDir, 'agentgraph-team-check-'));
  try {
    await deps.exec('git', ['clone', '-q', '-c', 'core.symlinks=false', '--depth', '1', '--single-branch', `--branch=${branch}`, '--', u, tmp], { timeoutMs: NET_TIMEOUT });
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
    return { kind: 'error', error: scrub(errMsg(err)) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Слаги, занятые маршрутами /api/teams/<слово> (GET /api/teams/mine и т. п.): команда с таким слагом получает суффикс. */
const RESERVED_TEAM_SLUGS = new Set(['mine', 'check', 'join']);

/** Свободный слаг папки команды: из ссылки, с суффиксом -2, -3… если занят. */
export function freeTeamSlug(url: string, root = teamsDir()): string {
  const base = teamSlugFromUrl(url);
  let slug = base;
  for (let i = 2; RESERVED_TEAM_SLUGS.has(slug) || fs.existsSync(path.join(root, slug)); i++) slug = `${base}-${i}`;
  return slug;
}

async function cloneInto(url: string, teamDir: string, deps: RepoDeps): Promise<void> {
  fs.mkdirSync(teamDir, { recursive: true });
  const repoDir = path.join(teamDir, REPO_DIR);
  try {
    // core.symlinks=false: ссылка, закоммиченная кем-то в репо команды, станет обычным файлом, а не выходом за клон
    await deps.exec('git', ['clone', '-q', '-c', 'core.symlinks=false', '--', url, repoDir], { timeoutMs: NET_TIMEOUT });
  } catch (err) {
    fs.rmSync(teamDir, { recursive: true, force: true });
    throw new TeamError(400, `Не удалось клонировать репо: ${scrub(errMsg(err))}`);
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
    if (!copyTemplate(repo.repoDir, deps.templateDir).includes('teamwork.yaml')) throw new TeamError(500, `Шаблон репо команды не найден: ${deps.templateDir}`);
    // .gitignore — кодом, а не файлом шаблона: electron-builder не кладёт .gitignore в сборку приложения
    if (!repo.exists('.gitignore')) repo.writeFile('.gitignore', `${OS_JUNK.join('\n')}\n`);
    const member: TeamMember = { name: me.name, email: me.email };
    repo.writeFile('teamwork.yaml', renderTeamConfig(repo.read('teamwork.yaml')!, { title, prefix, member }));
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
    throw err instanceof TeamError ? err : new TeamError(400, `Не удалось создать команду: ${scrub(errMsg(err))}`);
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
          // участники как в файле, с их неизвестными полями (spec §5.9, D-9): я — в конец списка
          const text = r.read('teamwork.yaml') ?? '';
          const raw = (parseYaml(text) as { members?: unknown } | null)?.members;
          r.writeFile('teamwork.yaml', updateYaml(text, { members: [...(Array.isArray(raw) ? raw : []), { name: me.name, email: me.email }] }));
        });
        added = true;
        await repo.push().catch(() => undefined);
      }
    }
    return { repo, added };
  } catch (err) {
    await repo.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    throw err instanceof TeamError ? err : new TeamError(400, `Не удалось подключиться: ${scrub(errMsg(err))}`);
  }
}
