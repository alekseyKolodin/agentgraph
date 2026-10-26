// Лимиты подписки Claude на главной (ui/limits.js): доля окна, тон полоски и подпись сброса. Без React и DOM.
import type { LimitWindow } from '@server/api-types';
import { locale, t } from './i18n';

export type LimitTone = 'ok' | 'warn' | 'err';

export type LimitView = {
  /** Целый процент 0–100. */
  percent: number;
  tone: LimitTone;
  /** «сброс в 20:59»; пусто, если сервер не знает времени сброса. */
  reset: string;
};

/** Окно для показа; null — окна нет или процент неизвестен, плитку не рисуем. */
export function limitView(w: LimitWindow | null | undefined, now: Date = new Date()): LimitView | null {
  if (!w || w.percent == null) return null;
  const percent = Math.max(0, Math.min(100, Math.round(w.percent)));
  const tone: LimitTone = percent >= 90 ? 'err' : percent >= 70 ? 'warn' : 'ok';
  return { percent, tone, reset: w.resetsAt ? t('сброс {time}', { time: resetTime(w.resetsAt, now) }) : '' };
}

/** Сегодня — «в 20:59», в ближайшую неделю — «пн 06:59», дальше — дата. */
export function resetTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t('в {time}', { time });
  if (d.getTime() - now.getTime() < 6 * 86_400_000) return `${d.toLocaleDateString(locale(), { weekday: 'short' })} ${time}`;
  return d.toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
