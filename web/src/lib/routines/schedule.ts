// Расписание рутины (when.schedule — cron из 5 полей, локальное время): пресеты шага «Когда» (по будням, каждый день,
// раз в час) ↔ cron, ближайшие запуски для строки «Ближайшие: …» и фраза «По будням в 09:30». Свой разбор cron —
// тот же синтаксис, что у движка: числа, `*`, диапазоны `1-5`, списки `1,3`, шаг `*/15`.
import { locale, t } from '../i18n';

export type SchedulePreset = 'weekdays' | 'daily' | 'hourly' | 'custom';
export type ScheduleChoice = { preset: SchedulePreset; time: string; cron?: string };

export const DEFAULT_TIME = '09:30';
export const PRESETS: Array<Exclude<SchedulePreset, 'custom'>> = ['weekdays', 'daily', 'hourly'];

export function presetLabel(p: SchedulePreset): string {
  return { weekdays: t('По будням'), daily: t('Каждый день'), hourly: t('Раз в час'), custom: t('Своё расписание') }[p];
}

const hm = (time: string): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const h = m ? Math.min(23, Number(m[1])) : 9;
  const min = m ? Math.min(59, Number(m[2])) : 30;
  return [h, min];
};
const pad = (n: number) => String(n).padStart(2, '0');

/** Пресет и время → cron. custom — как вписан. */
export function toCron(c: ScheduleChoice): string {
  if (c.preset === 'custom') return (c.cron ?? '').trim();
  if (c.preset === 'hourly') return '0 * * * *';
  const [h, m] = hm(c.time);
  return `${m} ${h} * * ${c.preset === 'weekdays' ? '1-5' : '*'}`;
}

/** cron → пресет шага «Когда»; что не пресет — custom с cron как есть. */
export function fromCron(cron: string): ScheduleChoice {
  const f = cron.trim().split(/\s+/);
  if (f.length === 5 && f[0] === '0' && f[1] === '*' && f[2] === '*' && f[3] === '*' && f[4] === '*') return { preset: 'hourly', time: DEFAULT_TIME };
  if (f.length === 5 && /^\d{1,2}$/.test(f[0]!) && /^\d{1,2}$/.test(f[1]!) && f[2] === '*' && f[3] === '*' && (f[4] === '*' || f[4] === '1-5')) {
    return { preset: f[4] === '*' ? 'daily' : 'weekdays', time: `${pad(Number(f[1]))}:${pad(Number(f[0]))}` };
  }
  return { preset: 'custom', time: DEFAULT_TIME, cron: cron.trim() };
}

/** Поле cron → множество подходящих значений; null — ошибка в поле. */
function field(src: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[4] ? Number(m[4]) : 1;
    let lo = min;
    let hi = max;
    if (m[2] !== undefined) {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

type Parsed = { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean };

/** Разбор cron из 5 полей; null — не cron. День недели 7 — то же воскресенье, что 0. */
export function parseCron(cron: string): Parsed | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const min = field(f[0]!, 0, 59);
  const hour = field(f[1]!, 0, 23);
  const dom = field(f[2]!, 1, 31);
  const mon = field(f[3]!, 1, 12);
  const dow = field(f[4]!, 0, 7);
  if (!min || !hour || !dom || !mon || !dow) return null;
  if (dow.has(7)) dow.add(0);
  return { min, hour, dom, mon, dow, domAny: f[2] === '*', dowAny: f[4] === '*' };
}

function matches(p: Parsed, d: Date): boolean {
  if (!p.min.has(d.getMinutes()) || !p.hour.has(d.getHours()) || !p.mon.has(d.getMonth() + 1)) return false;
  const domOk = p.dom.has(d.getDate());
  const dowOk = p.dow.has(d.getDay());
  // как в cron: оба поля заданы — подходит любое из них
  if (!p.domAny && !p.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

/** Ближайшие n запусков после from (не раньше следующей минуты); ищет до 40 дней вперёд. */
export function nextRuns(cron: string, from: Date, n = 3): Date[] {
  const p = parseCron(cron);
  if (!p) return [];
  const out: Date[] = [];
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 40 * 24 * 60 && out.length < n; i++) {
    if (matches(p, d)) out.push(new Date(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
function dayOf(d: Date, now: Date): string {
  if (sameDay(d, now)) return t('сегодня');
  const wd = d.toLocaleDateString(locale(), { weekday: 'short' });
  return `${wd} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

/** «ср 18.11, чт 19.11, пт 20.11 в 09:30» или «сегодня в 13:00, 14:00, 15:00»; пусто — ''. */
export function formatNext(dates: Date[], now: Date): string {
  if (!dates.length) return '';
  const first = dates[0]!;
  if (dates.every((d) => timeOf(d) === timeOf(first))) return t('{days} в {time}', { days: dates.map((d) => dayOf(d, now)).join(', '), time: timeOf(first) });
  if (dates.every((d) => sameDay(d, first))) return t('{days} в {time}', { days: dayOf(first, now), time: dates.map(timeOf).join(', ') });
  return dates.map((d) => `${dayOf(d, now)} ${timeOf(d)}`).join(', ');
}

/** Фраза расписания: «По будням в 09:30», «Каждый день в 09:30», «Раз в час», иначе «По расписанию «…»». */
export function describeSchedule(cron: string): string {
  const c = fromCron(cron);
  if (c.preset === 'hourly') return presetLabel('hourly');
  if (c.preset === 'custom') return t('По расписанию «{cron}»', { cron: cron.trim() });
  return t('{days} в {time}', { days: presetLabel(c.preset), time: c.time });
}
