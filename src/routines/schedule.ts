// Расписание рутин: cron из 5 полей (минута, час, день месяца, месяц, день недели) в локальном времени, свой парсер.
// Тик движка раз в 30 с берёт минуты между прошлой проверкой и сейчас (dueSlots); событие — scheduleEvent.
import type { RoutineEvent } from './types.js';

export type Cron = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** День месяца и день недели заданы оба: совпадение по любому (как в классическом cron). */
  domAny: boolean;
  dowAny: boolean;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const FIELDS: Array<{ name: string; min: number; max: number; names?: string[]; base?: number }> = [
  { name: 'минута', min: 0, max: 59 },
  { name: 'час', min: 0, max: 23 },
  { name: 'день месяца', min: 1, max: 31 },
  { name: 'месяц', min: 1, max: 12, names: MONTHS, base: 1 },
  { name: 'день недели', min: 0, max: 7, names: DAYS, base: 0 },
];

/** Разбор выражения; ошибка — строка с причиной. */
export function parseCron(expr: string): Cron | string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `cron — 5 полей через пробел (минута час день месяц день-недели), а их ${parts.length}`;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const f = FIELDS[i];
    const set = new Set<number>();
    for (const item of parts[i].split(',')) {
      const m = item.match(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i);
      if (!m) return `${f.name}: не понимаю «${item}»`;
      const step = m[2] ? Number(m[2]) : 1;
      if (!step) return `${f.name}: шаг 0`;
      let lo = f.min;
      let hi = f.max;
      if (m[1] !== '*') {
        const [a, b] = m[1].split('-');
        const va = value(a, f);
        const vb = b === undefined ? (m[2] ? f.max : va) : value(b, f);
        if (va === undefined || vb === undefined) return `${f.name}: «${item}» вне ${f.min}–${f.max}`;
        if (va > vb) return `${f.name}: «${item}» — начало больше конца`;
        lo = va;
        hi = vb;
      }
      for (let v = lo; v <= hi; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    sets.push(set);
  }
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow: sets[4],
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

function value(s: string, f: (typeof FIELDS)[number]): number | undefined {
  const idx = f.names?.indexOf(s.toLowerCase()) ?? -1;
  const v = idx >= 0 ? idx + (f.base ?? 0) : /^\d+$/.test(s) ? Number(s) : NaN;
  return Number.isInteger(v) && v >= f.min && v <= f.max ? v : undefined;
}

export function cronMatches(c: Cron, d: Date): boolean {
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) return false;
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

const MINUTE = 60_000;
const floorMinute = (t: number) => {
  const d = new Date(t);
  d.setSeconds(0, 0);
  return d.getTime();
};

/** Ближайшая минута после from (строго позже), не дальше года; нет — undefined. */
export function nextAt(c: Cron, from: Date): Date | undefined {
  let t = floorMinute(from.getTime()) + MINUTE;
  const end = t + 366 * 24 * 60 * MINUTE;
  while (t < end) {
    const d = new Date(t);
    if (!c.month.has(d.getMonth() + 1)) {
      // в начало следующего месяца
      t = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      continue;
    }
    if (!dayOk(c, d)) {
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      continue;
    }
    if (c.minute.has(d.getMinutes())) return d;
    t += MINUTE;
  }
  return undefined;
}

function dayOk(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dow;
  if (c.dowAny) return dom;
  return dom || dow;
}

/** Минуты расписания в (from, to] по порядку, не больше max (самые поздние, если больше). */
export function dueSlots(c: Cron, from: Date, to: Date, max = 1000): Date[] {
  const out: Date[] = [];
  let cur: Date | undefined = from;
  while ((cur = nextAt(c, cur)) && cur.getTime() <= to.getTime()) {
    out.push(cur);
    if (out.length > max) out.shift();
  }
  return out;
}

/** Событие расписания: id — слаг рутины и ISO минуты. */
export function scheduleEvent(routine: string, title: string, at: Date): RoutineEvent {
  const iso = new Date(floorMinute(at.getTime())).toISOString();
  return { source: 'schedule', id: `${routine}@${iso}`, at: iso, title: `${title} — по расписанию`, text: '', fields: { scheduledAt: iso } };
}
