// Автообновление из git: checkout agentgraph следит за upstream своей ветки (нет upstream — origin/<ветка>). Сервер
// раз в час делает fetch и сравнивает; обновление — fast-forward, npm install при смене зависимостей, пересборка того,
// что запускается из сборки (dist/, dist/web), и перезапуск процесса через restart хоста (execve у CLI, relaunch у Electron).
// Не git checkout (упакованное приложение, архив share.sh) — обновлений нет. Локальные правки и свои коммиты не трогаем.
import fs from 'node:fs';
import path from 'node:path';
import { exec as realExec, type Exec } from './git.js';
import type { UpdateStatus, UpdateStep } from './api-types.js';

const FETCH_MS = 60_000;
/** npm install и сборки на медленной машине идут минутами. */
const BUILD_MS = 10 * 60_000;
const MAX_COMMITS = 30;
const LOCK = 'package-lock.json';

export type UpdateCheck = {
  version: string;
  latest?: string;
  upstream: string;
  /** Проверенный коммит upstream: вливается он, а не то, что окажется на ветке к моменту merge. */
  sha: string;
  /** Новых коммитов на upstream без merge-коммитов; pending — с ними (есть ли что вливать). */
  behind: number;
  pending: number;
  /** Своих коммитов, которых нет на upstream: fast-forward невозможен. */
  ahead: number;
  commits: { sha: string; subject: string }[];
  /** Изменённые отслеживаемые файлы: fast-forward их не перезапишет. */
  dirty: string[];
};

const git = (x: Exec, dir: string, args: string[], timeoutMs = 15_000) => x('git', args, { cwd: dir, timeoutMs });

function readVersion(json: string): string | undefined {
  try {
    const v = (JSON.parse(json) as { version?: unknown }).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Папка — git checkout. Проверка по файлу, без вызова git: на macOS без Command Line Tools /usr/bin/git показывает
 * системный диалог установки — раз в час на каждую проверку.
 */
export const isCheckout = (dir: string) => fs.existsSync(path.join(dir, '.git'));

/** Ветка upstream и её remote; строка — почему обновляться не с чего. */
export async function updateTarget(dir: string, x: Exec = realExec): Promise<{ upstream: string; remote: string } | string> {
  if (!isCheckout(dir)) return 'agentgraph запущен не из git checkout';
  let branch: string;
  try {
    branch = (await git(x, dir, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
  } catch {
    return 'HEAD отсоединён: нет ветки, за которой следить';
  }
  try {
    const upstream = (await git(x, dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    const remote = (await git(x, dir, ['config', '--get', `branch.${branch}.remote`])).trim();
    // upstream — локальная ветка (remote «.»): обновлять не с чего
    if (remote && remote !== '.') return { upstream, remote };
  } catch {
    // нет upstream: ветка с тем же именем на origin
  }
  try {
    await git(x, dir, ['remote', 'get-url', 'origin']);
  } catch {
    return `у ветки ${branch} нет upstream и нет remote origin`;
  }
  return { upstream: `origin/${branch}`, remote: 'origin' };
}

/**
 * Окружение фонового fetch: ssh без вопросов в терминал (пароль ключа, незнакомый host key) — GIT_TERMINAL_PROMPT
 * действует только на https. Свой GIT_SSH_COMMAND пользователя не трогаем.
 */
const FETCH_ENV = () => (process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' });

/** fetch и сравнение с upstream; строка — почему обновляться не с чего. */
export async function checkUpdate(dir: string, x: Exec = realExec, fetch = true): Promise<UpdateCheck | string> {
  const target = await updateTarget(dir, x);
  if (typeof target === 'string') return target;
  const { upstream, remote } = target;
  if (fetch) await x('git', ['fetch', '--quiet', '--no-tags', remote], { cwd: dir, timeoutMs: FETCH_MS, env: FETCH_ENV() });
  let sha: string;
  try {
    sha = (await git(x, dir, ['rev-parse', '--verify', '--quiet', `${upstream}^{commit}`])).trim();
  } catch {
    return `ветки ${upstream} нет`;
  }
  const count = async (...args: string[]) => Number((await git(x, dir, ['rev-list', '--count', ...args])).trim()) || 0;
  const pending = await count(`HEAD..${sha}`);
  const behind = pending ? await count('--no-merges', `HEAD..${sha}`) : 0;
  const ahead = await count(`${sha}..HEAD`);
  const log = pending ? await git(x, dir, ['log', '--no-merges', `-n${MAX_COMMITS}`, '--format=%h%x1f%s', `HEAD..${sha}`]) : '';
  const commits = log.split('\n').filter(Boolean).map((l) => {
    const [short, subject = ''] = l.split('\x1f');
    return { sha: short, subject };
  });
  const status = await git(x, dir, ['status', '--porcelain', '--untracked-files=no']);
  const dirty = status.split('\n').filter(Boolean).map((l) => l.slice(3));
  const version = readVersion(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) ?? '?';
  const latest = pending ? readVersion(await git(x, dir, ['show', `${sha}:package.json`]).catch(() => '')) : version;
  return { version, latest, upstream, sha, behind, pending, ahead, commits, dirty };
}

/** Почему обновление нельзя сделать автоматически; undefined — можно. */
export function blockedReason(c: UpdateCheck): string | undefined {
  if (c.ahead) return `ветка разошлась с ${c.upstream}: своих коммитов ${c.ahead} — обновите вручную (git pull)`;
  if (c.dirty.length) {
    const list = c.dirty.slice(0, 5).join(', ') + (c.dirty.length > 5 ? ` и ещё ${c.dirty.length - 5}` : '');
    return `в checkout есть незакоммиченные изменения: ${list}`;
  }
  return undefined;
}

type Rebuild = 'install' | 'build' | 'web';

/**
 * Что сделать после fast-forward по списку изменённых файлов: install — сменились зависимости; build — код сервера, когда
 * есть сборка dist/ (из неё запускаются десктоп и bin/agentgraph); web — UI, когда сменился web/ или его сборки нет.
 */
export function rebuildPlan(changed: string[], has: { dist: boolean; web: boolean }): Rebuild[] {
  const deps = changed.some((f) => f === 'package.json' || f === LOCK);
  const plan: Rebuild[] = [];
  if (deps) plan.push('install');
  if (has.dist && (deps || changed.some((f) => f.startsWith('src/') || f === 'tsconfig.json'))) plan.push('build');
  if (!has.web || deps || changed.some((f) => f.startsWith('web/'))) plan.push('web');
  return plan;
}

const NPM_ARGS: Record<Rebuild, string[]> = {
  install: ['install', '--no-audit', '--no-fund'],
  build: ['run', 'build'],
  web: ['run', 'build:web'],
};

/**
 * Обновление checkout: свежий fetch, fast-forward на проверенный коммит upstream, npm install и сборки по rebuildPlan.
 * npm install другой версии npm переписывает package-lock.json — его возвращаем к закоммиченному, иначе следующая
 * проверка увидит «незакоммиченные изменения». Сбой после fast-forward откатывает checkout к прежнему коммиту (правок нет,
 * их проверили) и повторяет уже начатые шаги — зависимости и сборки снова от прежней версии. Не откатилось — в ошибке.
 */
export async function applyUpdate(dir: string, onStep: (s: UpdateStep) => void, x: Exec = realExec): Promise<void> {
  onStep('fetch');
  const c = await checkUpdate(dir, x);
  if (typeof c === 'string') throw new Error(c);
  if (!c.pending) throw new Error('обновлять нечего: это последняя версия');
  const blocked = blockedReason(c);
  if (blocked) throw new Error(blocked);
  const old = (await git(x, dir, ['rev-parse', 'HEAD'])).trim();
  const restoreLock = () => git(x, dir, ['checkout', '--', LOCK]).catch(() => '');
  const npm = (step: Rebuild) => x('npm', NPM_ARGS[step], { cwd: dir, timeoutMs: BUILD_MS });
  onStep('merge');
  await git(x, dir, ['merge', '--ff-only', '--quiet', c.sha], FETCH_MS);
  const started: Rebuild[] = [];
  try {
    const changed = (await git(x, dir, ['diff', '--name-only', old, 'HEAD'])).split('\n').filter(Boolean);
    const plan = rebuildPlan(changed, {
      dist: fs.existsSync(path.join(dir, 'dist', 'cli.js')),
      web: fs.existsSync(path.join(dir, 'dist', 'web', 'index.html')),
    });
    for (const step of plan) {
      onStep(step);
      started.push(step);
      await npm(step);
      if (step === 'install') await restoreLock();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await restoreLock();
    try {
      await git(x, dir, ['reset', '--keep', old]);
    } catch (resetErr) {
      throw new Error(`${msg}; откатить checkout к ${old.slice(0, 7)} не удалось (${resetErr instanceof Error ? resetErr.message : resetErr}) — проверьте git status`);
    }
    const redo = await started.reduce<Promise<string[]>>(async (acc, step) => {
      const failed = await acc;
      try {
        await npm(step);
        if (step === 'install') await restoreLock();
      } catch {
        failed.push(`npm ${NPM_ARGS[step].join(' ')}`);
      }
      return failed;
    }, Promise.resolve([]));
    throw new Error(redo.length ? `${msg}; checkout откатан, но не прошло: ${redo.join(', ')} — запустите вручную` : msg);
  }
}

/** Перезапуск хостом; false — отменён (окно с несохранёнными правками осталось открытым), процесс работает дальше. */
export type Restart = () => void | boolean | Promise<void | boolean>;

export type UpdaterDeps = {
  dir: string;
  exec?: Exec;
  /** Перезапуск процесса; сервер он останавливает сам. Нет — после обновления «перезапустите вручную». */
  restart?: Restart;
  /** Почему проверка выключена (AGENTGRAPH_NO_UPDATE_CHECK); undefined — включена. */
  disabled?: string;
  /** Пауза перед перезапуском: UI успевает увидеть restarting. */
  restartDelayMs?: number;
};

type Self = Omit<UpdateStatus, 'busy'>;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Состояние обновления процесса: проверка по таймеру и по запросу, одно обновление за раз, перезапуск после него. */
export class Updater {
  private st: Self;
  private checking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly x: Exec;
  /** Выключено навсегда: AGENTGRAPH_NO_UPDATE_CHECK или не git checkout. Остальные причины off проверка пересматривает. */
  private readonly never?: string;

  constructor(private readonly deps: UpdaterDeps) {
    this.x = deps.exec ?? realExec;
    const version = readVersion(fs.readFileSync(path.join(deps.dir, 'package.json'), 'utf8')) ?? '?';
    this.never = deps.disabled ?? (isCheckout(deps.dir) ? undefined : 'agentgraph запущен не из git checkout');
    this.st = this.never ? { state: 'off', reason: this.never, version, canRestart: !!deps.restart } : { state: 'unknown', version, canRestart: !!deps.restart };
  }

  status(): Self {
    return { ...this.st };
  }

  /** Первая проверка через delayMs, дальше раз в everyMs. Таймер не держит процесс; повторный вызов ничего не делает. */
  start(delayMs = 10_000, everyMs = 60 * 60_000): void {
    if (this.never || this.timer) return;
    const tick = () => {
      void this.check();
      this.timer = setTimeout(tick, everyMs);
      this.timer.unref();
    };
    this.timer = setTimeout(tick, delayMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Проверка с fetch; одновременные вызовы ждут одну. Во время обновления и после него — ничего не делает. */
  check(): Promise<void> {
    if (this.never || this.busy()) return Promise.resolve();
    this.checking ??= (async () => {
      try {
        const c = await checkUpdate(this.deps.dir, this.x);
        if (this.busy()) return;
        const base = { version: this.st.version, canRestart: this.st.canRestart, checkedAt: new Date().toISOString() };
        if (typeof c === 'string') this.st = { ...base, state: 'off', reason: c };
        else if (!c.pending) this.st = { ...base, state: 'current', upstream: c.upstream };
        else this.st = { ...base, state: 'available', upstream: c.upstream, latest: c.latest, behind: c.behind, commits: c.commits, blocked: blockedReason(c) };
      } catch (err) {
        if (!this.busy()) this.st = { ...this.st, checkError: errText(err), checkedAt: new Date().toISOString() };
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  private busy(): boolean {
    return ['updating', 'restarting', 'updated'].includes(this.st.state);
  }

  /**
   * Начать обновление: ответ сразу, ход — в status(). Строка — почему нельзя начать. Идущая проверка сначала
   * доигрывает: два fetch разом не делят ref. После обновления — пауза, чтобы UI успел увидеть restarting, и restart;
   * без restart, при его отмене или ошибке — updated («перезапустите вручную»).
   */
  apply(): string | undefined {
    if (this.st.state === 'off') return this.st.reason ?? 'обновления выключены';
    if (this.busy()) return 'обновление уже идёт';
    if (this.st.state !== 'available' && this.st.state !== 'failed') return 'новой версии нет';
    if (this.st.blocked) return this.st.blocked;
    this.st = { ...this.st, state: 'updating', step: 'fetch', error: undefined };
    const waitCheck = this.checking ?? Promise.resolve();
    void waitCheck
      .then(() => applyUpdate(this.deps.dir, (step) => (this.st = { ...this.st, step }), this.x))
      .then(
        () => {
          const { restart } = this.deps;
          if (!restart) {
            this.st = { ...this.st, state: 'updated', step: undefined };
            return;
          }
          this.st = { ...this.st, state: 'restarting', step: 'restart' };
          setTimeout(() => {
            Promise.resolve()
              .then(restart)
              .then(
                (ok) => {
                  if (ok === false) this.st = { ...this.st, state: 'updated', step: undefined };
                },
                (err: unknown) => {
                  console.error('agentgraph: перезапуск после обновления не удался —', err);
                  this.st = { ...this.st, state: 'updated', step: undefined, error: `перезапуск не удался: ${errText(err)}` };
                },
              );
          }, this.deps.restartDelayMs ?? 1500);
        },
        (err: unknown) => {
          this.st = { ...this.st, state: 'failed', step: undefined, error: errText(err) };
        },
      );
    return undefined;
  }
}

/**
 * Перезапуск CLI-процесса на месте (`agentgraph ui`, `npm run ui`): остановка сервера, затем execve с теми же
 * аргументами и флагами Node (у tsx — его загрузчик): тот же PID и терминал, Ctrl+C работает как прежде. Нет execve
 * (Node до 22.15) — undefined. execve упал — сервер уже остановлен: процесс выходит с подсказкой перезапустить вручную.
 */
export function execveRestart(stop: () => Promise<void>): Restart | undefined {
  const execve = (process as { execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never }).execve;
  if (typeof execve !== 'function') return undefined;
  return async () => {
    await stop().catch((err) => console.error('agentgraph: остановка перед перезапуском —', err));
    try {
      execve.call(process, process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], process.env);
    } catch (err) {
      console.error('agentgraph обновлён, но перезапуститься не смог — запустите его снова:', err);
      process.exit(1);
    }
  };
}
