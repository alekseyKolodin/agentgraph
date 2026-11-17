// Общие мелочи видов источников: пути в объекте, строки из настроек, время, пауза с прерыванием.
import os from 'node:os';
import path from 'node:path';
import type { SourceSpec } from '../types.js';

/** Значение по пути через точку: `data.items.0.id`. Нет — undefined. */
export function getPath(obj: unknown, p: string): unknown {
  let cur: unknown = obj;
  for (const key of p.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Строка из config источника, обрезанная; пусто — undefined. */
export function cfgStr(spec: SourceSpec, key: string): string | undefined {
  const v = spec.config?.[key];
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s || undefined;
}

/** Список из строки «a, b; c» или массива. */
export function cfgList(spec: SourceSpec, key: string): string[] {
  const v = spec.config?.[key];
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[,;\n]/) : [];
  return raw.map((s) => s.trim()).filter(Boolean);
}

/** Одна строка для заголовка события: первая непустая строка текста, не длиннее max. */
export function firstLine(text: string, max = 120): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** ISO-время; мусор — now. */
export function isoOf(v: unknown, now: () => Date = () => new Date()): string {
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return now().toISOString();
}

/** Время Slack `1700000000.000200` → ISO. */
export function isoOfSlackTs(ts: string): string {
  return new Date(Math.round(Number(ts) * 1000)).toISOString();
}

/** Пауза, которая прерывается сигналом (резолвится, а не бросает). */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** `~/папка` → абсолютный путь. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Убрать секрет из текста ошибки. */
export function redact(text: string, ...secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

/** JSON-ответ или понятная ошибка вместо SyntaxError. */
export function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what}: ответ не JSON (${truncate(text.trim().replace(/\s+/g, ' '), 120)})`);
  }
}

/** Интервал '30s' | '5m' | '1h' | '2d' → мс; не разобрать — undefined. */
export function parseEvery(every: string | undefined): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/i.exec(every ?? '');
  if (!m) return undefined;
  return Math.round(Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd']);
}
