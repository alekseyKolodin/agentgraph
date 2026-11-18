// Жив ли процесс раннера, записанный в run.json. Одного «pid существует» мало: ОС раздаёт номера заново, и через дни
// тот же pid бывает у чужого процесса — тогда брошенный запуск висел бы «идущим». Поэтому процесс ещё и должен
// стартовать не позже самого запуска. Время старта берём из ps (macOS, Linux); на Windows его нет — там, как раньше,
// верим одному сигналу.
import { spawnSync } from 'node:child_process';

/**
 * Запас на сравнение времени: ps отдаёт прошедшее время с точностью до секунды, а часы после сна ноутбука
 * или резюма VM прыгают. Ошибка в сторону «мёртв» опаснее: снимает защиту живого запуска от удаления и
 * продолжения, — а номер переиспользуется через часы и дни, так что минута ничего не стоит.
 */
const START_SLACK_MS = 60_000;
/** Сколько помнить вердикт «жив»: readReport зовётся на каждом опросе списка, ps не нужен каждый раз. */
const ALIVE_TTL_MS = 30_000;

export type PidDeps = {
  /** Есть ли процесс с таким pid (сигнал 0). */
  exists: (pid: number) => boolean;
  /** Когда процесс стартовал, мс эпохи; 'gone' — процесса уже нет; undefined — узнать не вышло. */
  startedMs: (pid: number) => number | 'gone' | undefined;
  now: () => number;
  /** pid:startedAt → false (чужой процесс — навсегда: настоящий раннер уже не вернётся) или срок вердикта «жив». */
  cache: Map<string, number | false>;
};

export const pidDeps: PidDeps = { exists: pidExists, startedMs: processStartedMs, now: Date.now, cache: new Map() };

/** Процесс pid — раннер запуска, начатого в startedAt (ISO): существует и стартовал не позже запуска. */
export function runnerAlive(pid: number, startedAt: string | undefined, deps: PidDeps = pidDeps): boolean {
  if (!deps.exists(pid)) return false;
  const key = `${pid}:${startedAt}`;
  const hit = deps.cache.get(key);
  if (hit === false) return false;
  if (hit !== undefined && hit > deps.now()) return true;
  const runMs = startedAt ? Date.parse(startedAt) : NaN;
  const procMs = deps.startedMs(pid);
  if (procMs === 'gone') return false;
  // время старта неизвестно (нет ps, старый отчёт без startedAt) — верим сигналу, как раньше
  if (procMs === undefined || Number.isNaN(runMs)) return true;
  const alive = procMs <= runMs + START_SLACK_MS;
  deps.cache.set(key, alive ? deps.now() + ALIVE_TTL_MS : false);
  return alive;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Время старта процесса по `ps -o etime=`: [[дд-]чч:]мм:сс назад от момента до вызова (ошибка — только в сторону «раньше»). */
function processStartedMs(pid: number): number | 'gone' | undefined {
  if (process.platform === 'win32') return undefined;
  const now = Date.now();
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
  if (r.error) return undefined;
  // ps без строки и с кодом 1 — процесс завершился между сигналом и ps
  if (r.status === 1 && !r.stdout.trim()) return 'gone';
  const sec = r.status === 0 ? parseEtime(r.stdout) : undefined;
  return sec === undefined ? undefined : now - sec * 1000;
}

/** «1-02:03:04» → секунды; не тот формат — undefined. */
export function parseEtime(s: string): number | undefined {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return undefined;
  const [, d = '0', h = '0', min, sec] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec);
}
