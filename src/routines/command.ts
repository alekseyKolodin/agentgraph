// Вид источника command: любая команда печатает JSON, map говорит, где в нём записи и какие поля — id, заголовок,
// текст… Ключи источника — переменными окружения команды (в файле источника только $ИМЯ). Таймаут — 60 с.
import { spawn } from 'node:child_process';
import type { RunCommand, SourceCtx, SourceKind } from './kind.js';
import { BASE_MATCH, stampAt } from './kind.js';
import { pathGet } from './match.js';
import type { FieldMap, RoutineEvent, SourceSpec } from './types.js';

export const COMMAND_TIMEOUT_MS = 60_000;
const OUT_MAX = 16 * 1024 * 1024;

/** Запуск команды через sh -c: env процесса + ключи, вывод целиком (не больше 16 МБ), убийство по таймауту и signal. */
export const runCommand: RunCommand = (cmd, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let done = false;
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* уже вышел */
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      kill();
      reject(new Error(`Команда не ответила за ${Math.round(opts.timeoutMs / 1000)} с`));
    }, opts.timeoutMs);
    const onAbort = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      kill();
      reject(new Error('Проверка остановлена'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < OUT_MAX) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** Ключи источника, которые есть: имя → значение. */
export function secretEnv(ctx: Pick<SourceCtx, 'spec' | 'secret'>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ctx.spec.secrets ?? []) {
    const v = ctx.secret(name);
    if (v) env[name] = v;
  }
  return env;
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

function isoAt(v: unknown, fallback: string): string {
  if (v === undefined || v === null || v === '') return fallback;
  // секунды или миллисекунды эпохи
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

/** Записи ответа по map → события. Без id запись пропускается; в ответе нет массива — ошибка. */
export function mapItems(json: unknown, map: FieldMap | undefined, source: string, now = new Date()): RoutineEvent[] {
  const m: FieldMap = map ?? { id: 'id' };
  const list = m.items ? pathGet(json, m.items) : json;
  if (!Array.isArray(list)) throw new Error(m.items ? `В ответе нет массива по пути «${m.items}»` : 'Ответ — не массив записей: укажи map.items');
  const out: RoutineEvent[] = [];
  for (const item of list) {
    const id = str(pathGet(item, m.id));
    if (!id) continue;
    const fields = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item };
    const text = m.text ? str(pathGet(item, m.text)) ?? '' : '';
    const author = m.author ? str(pathGet(item, m.author)) : undefined;
    const link = m.link ? str(pathGet(item, m.link)) : undefined;
    const rawAt = m.at ? pathGet(item, m.at) : undefined;
    const at = isoAt(rawAt, '');
    const e: RoutineEvent = {
      source,
      id,
      at: at || now.toISOString(),
      title: (m.title ? str(pathGet(item, m.title)) : undefined)?.split('\n')[0].slice(0, 300) || id,
      text,
      ...(link ? { link } : {}),
      ...(author ? { author } : {}),
      fields,
    };
    out.push(at ? e : stampAt(e));
  }
  return out;
}

/** Разбор вывода команды: JSON целиком или JSON Lines. */
export function parseOutput(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) return [];
  try {
    return JSON.parse(t);
  } catch {
    const lines = t.split('\n').filter((l) => l.trim());
    try {
      return lines.map((l) => JSON.parse(l) as unknown);
    } catch {
      throw new Error(`Команда напечатала не JSON: ${t.slice(0, 200)}`);
    }
  }
}

const command = (spec: SourceSpec): string => (typeof spec.config.command === 'string' ? spec.config.command : '');

export const commandKind: SourceKind = {
  kind: 'command',
  title: 'Своя команда',
  summary: 'Любая команда, которая печатает JSON: каждая новая запись — событие',
  delivery: 'poll',
  minEveryMs: 30_000,
  setup: [
    { key: 'command', label: 'Команда', placeholder: 'curl -s -H "Authorization: Bearer $API_KEY" https://…', hint: 'Печатает JSON. Ключи — как $ИМЯ: значения подставятся переменными окружения' },
    { key: 'cwd', label: 'Папка', optional: true },
  ],
  match: BASE_MATCH,
  async poll(ctx) {
    const cmd = command(ctx.spec);
    if (!cmd.trim()) throw new Error('Не задана команда (config.command)');
    const cwd = typeof ctx.spec.config.cwd === 'string' && ctx.spec.config.cwd ? ctx.spec.config.cwd : undefined;
    const r = await ctx.run(cmd, { env: secretEnv(ctx), cwd, timeoutMs: COMMAND_TIMEOUT_MS, signal: ctx.signal });
    if (r.code !== 0) throw new Error(`Команда завершилась с кодом ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 500)}` : ''}`);
    return mapItems(parseOutput(r.stdout), ctx.spec.map, ctx.slug);
  },
  describe: (spec) => command(spec),
};
