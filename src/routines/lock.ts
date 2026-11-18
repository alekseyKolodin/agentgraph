// Один движок рутин на папку настроек. И `agentgraph ui`, и десктопное приложение запускают RoutineEngine над общей
// ~/.agentgraph: без замка оба опрашивали бы источники и запускали flow на одно и то же событие. Замок — файл
// routines-state/engine.lock (pid, время, кто), создаётся атомарно (open с 'wx'). Живой владелец — движок не стартует,
// остальной сервер работает; мёртвый (или pid уже у чужого процесса, src/pid.ts) — замок перехватывается.
import fs from 'node:fs';
import path from 'node:path';
import { runnerAlive } from '../pid.js';

/** Кто ведёт рутины: процесс agentgraph ui или десктопное приложение. */
export type EngineOwner = { pid: number; who: string; at: string };

export type LockDeps = {
  pid: number;
  /** Жив ли владелец замка: pid существует и стартовал не позже, чем взял замок. */
  alive: (pid: number, at: string) => boolean;
  now: () => Date;
};

const defaultDeps = (): LockDeps => ({ pid: process.pid, alive: (pid, at) => runnerAlive(pid, at), now: () => new Date() });

export type EngineLock = { ok: true; release: () => void } | { ok: false; owner: EngineOwner };

function readOwner(file: string): EngineOwner | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<EngineOwner>;
    return typeof o.pid === 'number' && typeof o.at === 'string' ? { pid: o.pid, who: String(o.who ?? ''), at: o.at } : undefined;
  } catch {
    return undefined;
  }
}

/** Взять замок; занят живым другим процессом — owner. Свой процесс (второй движок в тестах) замок перехватывает. */
export function acquireEngineLock(file: string, who: string, deps: Partial<LockDeps> = {}): EngineLock {
  const d = { ...defaultDeps(), ...deps };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine: EngineOwner = { pid: d.pid, who, at: d.now().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(mine));
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, release: () => release(file, mine) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const owner = readOwner(file);
    // файл пишется прямо сейчас (пустой) — считаем занятым: следующая попытка движка разберётся
    if (!owner) {
      let empty = false;
      try {
        empty = fs.statSync(file).size === 0 && d.now().getTime() - fs.statSync(file).mtimeMs < 5_000;
      } catch {
        continue;
      }
      if (empty) return { ok: false, owner: { pid: 0, who: '', at: '' } };
    } else if (owner.pid !== d.pid && d.alive(owner.pid, owner.at)) return { ok: false, owner };
    // владелец мёртв или замок битый — перехватываем
    fs.rmSync(file, { force: true });
  }
  const owner = readOwner(file);
  return { ok: false, owner: owner ?? { pid: 0, who: '', at: '' } };
}

/** Снять замок, только если он всё ещё наш: его мог перехватить другой процесс, пока этот спал. */
function release(file: string, mine: EngineOwner): void {
  const cur = readOwner(file);
  if (cur && cur.pid === mine.pid && cur.at === mine.at) fs.rmSync(file, { force: true });
}
