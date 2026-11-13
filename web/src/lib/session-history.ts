// История завершённых сессий в сайдбаре без React и DOM: группы по пространству (как запуски — по проекту), первые
// SESSION_GROUP_LIMIT и «ещё N», подпись строки. Живые сессии стоят в «Сейчас» и сюда не попадают.
import type { SessionView } from '@server/api-types';
import { baseName, feedTime, plural, when } from './format';
import { t } from './i18n';

export const SESSION_GROUP_LIMIT = 5;

/** Ключ свёрнутости группы в fold.ts: открыта, пока её не свернули (как проекты запусков). */
export const sessionGroupKey = (space: string | undefined): string => 'sspace:' + (space || '');

export type HistorySession = Pick<SessionView, 'id' | 'name' | 'cwd' | 'live' | 'space' | 'lastActivityAt' | 'turns'> &
  Partial<Pick<SessionView, 'endedAt' | 'outcome'>>;

export type SessionGroup<S extends HistorySession = HistorySession> = {
  key: string;
  /** Слаг; '' — без пространства. */
  space: string;
  label: string;
  title: string;
  count: number;
  /** Видимые строки: первые SESSION_GROUP_LIMIT, все — если раскрыт хвост или открытая сессия дальше. */
  sessions: S[];
  more: number;
};

/** Когда сессия была последний раз: завершённая — момент выхода. */
const lastAt = (s: HistorySession): string => s.endedAt || s.lastActivityAt;

/**
 * Завершённые сессии группами по пространству: группы и строки — от свежих, «без пространства» — на общих правах.
 * activeId — открытая сессия: её группа показана целиком, если она за лимитом.
 */
export function sessionHistory<S extends HistorySession>(all: S[], activeId: string | null, showAll: Set<string>): SessionGroup<S>[] {
  const ended = all.filter((s) => !s.live).sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
  const bySpace = new Map<string, S[]>();
  for (const s of ended) {
    const k = s.space || '';
    if (!bySpace.has(k)) bySpace.set(k, []);
    bySpace.get(k)!.push(s);
  }
  return [...bySpace].map(([space, list]) => {
    const key = sessionGroupKey(space);
    const activeIdx = list.findIndex((s) => s.id === activeId);
    const shown = showAll.has(key) || activeIdx >= SESSION_GROUP_LIMIT ? list : list.slice(0, SESSION_GROUP_LIMIT);
    return {
      key,
      space,
      label: space ? `◇ ${space}` : t('без пространства'),
      title: space ? t('Пространство {slug}: завершённые сессии', { slug: space }) : t('Завершённые сессии без пространства'),
      count: list.length,
      sessions: shown,
      more: list.length - shown.length,
    };
  });
}

/**
 * Подпись строки истории: «не запустилась» (если так), папка (у сессий без пространства — ей они и различаются),
 * когда была последний раз, ходы. fail — подпись исхода красным.
 */
export function historySub(s: HistorySession, withFolder: boolean, now: Date = new Date()): { outcome: string; rest: string } {
  const outcome = s.outcome === 'failed' ? t('не запустилась') : s.outcome === 'untrusted' ? t('папка не доверена') : '';
  const turns = `${s.turns} ${plural(s.turns, 'ход', 'хода', 'ходов')}`;
  return { outcome, rest: [...(withFolder ? [baseName(s.cwd)] : []), feedTime(lastAt(s), now), turns].join(' · ') };
}

/** Подсказка строки: имя, пространство, папка целиком и дата. */
export const historyTitle = (s: HistorySession): string =>
  [s.name, s.space ? `◇ ${s.space}` : '', s.cwd, t('последняя активность {date}', { date: when(lastAt(s)) })].filter(Boolean).join('\n');
