// Статистика и версии flow на его экране без React и DOM (ответ GET /api/flows/:name/history, src/flow-history.ts):
// строка в шапке «12 запусков за 30 дней · последний 18.11, 20:59» и подписи строк вкладки «Версии».
import type { FlowHistory, FlowVersion } from '@server/api-types';
import { clock, plural, statusLabel, when } from '../format';
import { locale, t } from '../i18n';

const runsWord = (n: number) => `${n} ${plural(n, 'запуск', 'запуска', 'запусков')}`;

/**
 * Строка в шапке flow: month — «5 запусков за 30 дней», last — «последний 18.11, 20:59» (ссылкой на запуск); запусков
 * не было — month «ещё не запускался», last пусто.
 */
export function usageLine(h: Pick<FlowHistory, 'total' | 'runs30d' | 'last'>, now: Date = new Date()): { month: string; last: string; title: string } {
  if (!h.total || !h.last) return { month: t('ещё не запускался'), last: '', title: t('У flow нет ни одного запуска в runs/') };
  return {
    month: h.runs30d ? t('{runs} за 30 дней', { runs: runsWord(h.runs30d) }) : t('за 30 дней не запускался'),
    last: t('последний {when}', { when: clock(h.last.startedAt, now) }),
    title: [t('Всего запусков: {n}', { n: h.total }), `${h.last.title ? `«${h.last.title}» · ` : ''}${statusLabel(h.last.status)} · ${when(h.last.startedAt)}`].join('\n'),
  };
}

/** День коротко: «18.11»; другой год — «18.11.2025». */
const day = (iso: string, now: Date): string => {
  const d = new Date(iso);
  return d.toLocaleDateString(locale(), d.getFullYear() === now.getFullYear() ? { day: '2-digit', month: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
};

/**
 * Подпись версии: запуски и когда — «5 запусков · 12.11 – 18.11»; день один — «3 запуска · 18.11», один запуск — его
 * время (clock: сегодня — «20:59»).
 */
export function versionMeta(v: Pick<FlowVersion, 'runs' | 'firstAt' | 'lastAt'>, now: Date = new Date()): string {
  if (v.runs === 1) return `${runsWord(1)} · ${clock(v.lastAt, now)}`;
  const a = day(v.firstAt, now);
  const b = day(v.lastAt, now);
  return `${runsWord(v.runs)} · ${a === b ? b : `${a} – ${b}`}`;
}

/** Строка под списком версий: что в нём не видно. */
export function versionsNote(h: Pick<FlowHistory, 'versions' | 'noSnapshot' | 'currentUnrun' | 'total'>): string {
  return [
    ...(h.currentUnrun ? [t('Файл flow поправили после последнего запуска: текущая версия ещё не запускалась.')] : []),
    ...(h.noSnapshot ? [t('Без снимка flow.yaml — {runs}: их версия неизвестна.', { runs: runsWord(h.noSnapshot) })] : []),
  ].join(' ');
}
