// Лента событий главной (ui/feed.js): вопросы агентов, паузы по их просьбе и концы запусков. Без React и DOM.
import type { FeedItem } from '@server/api-types';
import { clock } from './format';

/** Сколько событий видно сразу; остальные — по «Ещё N». */
export const FEED_SHOWN = 20;
/** События общего потока, после которых в ленте появляется или меняется событие. */
export const FEED_EVENTS = new Set(['question', 'answer', 'pause', 'end']);
/** localStorage: время самого нового прочитанного события. */
export const FEED_SEEN_KEY = 'agentgraph.feedSeen';

/** Новых после отметки «прочитано»: время события позже seen. */
export const isUnread = (x: FeedItem, seen: string): boolean => x.at > seen;
export const unreadCount = (items: FeedItem[], seen: string): number => items.filter((x) => isUnread(x, seen)).length;

/** Цвет точки: ждёт пользователя — waiting, итог запуска — по статусу, остальное приглушено. */
export function feedTone(x: FeedItem): string {
  if (x.kind === 'end') return x.status ?? '';
  return x.open ? 'waiting' : 'closed';
}

/**
 * Что случилось. state — хвост после «·»: wait — выделить янтарным («ждёт ответа», «запуск на паузе»).
 * У конца запуска хвоста-текста нет: там бейдж статуса и стоимость.
 */
export type FeedWhat = { head: string; state: { text: string; wait: boolean } | null; tip: string };

export function feedWhat(x: FeedItem, now: Date = new Date()): FeedWhat {
  if (x.kind === 'question') {
    const state = x.open ? { text: 'ждёт ответа', wait: true } : { text: x.doneAt ? `отвечен ${clock(x.doneAt, now)}` : 'остался без ответа', wait: false };
    const head = `Вопрос от «${x.title}»`;
    return { head, state, tip: `${head} · ${state.text}` };
  }
  if (x.kind === 'pause') {
    const state = x.open ? { text: 'запуск на паузе', wait: true } : { text: x.doneAt ? `возобновлён ${clock(x.doneAt, now)}` : 'не возобновлён', wait: false };
    const head = `«${x.title}» просит решения`;
    return { head, state, tip: `${head} · ${state.text}` };
  }
  return { head: 'Запуск завершён', state: null, tip: 'Запуск завершён' };
}
