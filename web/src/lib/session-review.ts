// «Не доделано» на главной: что показать из разбора сессий моделью (итог на сервере, /api/session-review). Чистая логика без React.
import type { SessionReviewItem, SessionReviewReply, SessionReviewVerdict, SessionView } from '@server/api-types';
import { feedTime } from './format';
import { t } from './i18n';

export const VERDICT_LABEL: Record<SessionReviewVerdict, string> = {
  continue: t('не доделано'),
  wrap: t('последний шаг'),
  done: t('готово'),
};

/** Порядок: сначала то, к чему вернуться, потом последний шаг; внутри — как вернула модель (свежие сверху). */
const RANK: Record<SessionReviewVerdict, number> = { continue: 0, wrap: 1, done: 2 };

/**
 * Строки разбора: open — к чему вернуться (не скрытые и не готовые), done — готовые (их можно отпустить разом).
 * Сессия, которой больше нет в списке (удалили), и та, что сейчас работает, — пропускаются: разбор про неё устарел.
 */
export function reviewRows(
  reply: SessionReviewReply | undefined,
  hidden: string[],
  sessions: (Pick<SessionView, 'id' | 'status' | 'lastActivityAt'> & Partial<Pick<SessionView, 'turns'>>)[] | undefined,
): { open: SessionReviewItem[]; done: SessionReviewItem[]; stale: string[] } {
  if (!reply) return { open: [], done: [], stale: [] };
  const byId = sessions ? new Map(sessions.map((s) => [s.id, s])) : undefined;
  const stale: string[] = [];
  const fresh = reply.items.filter((x) => {
    if (hidden.includes(reviewHideKey(x))) return false;
    const s = byId?.get(x.id);
    if (byId && (!s || s.status === 'working')) return false;
    // после разбора в сессии были новые ходы — разбор про неё мог устареть: строка показывается с пометкой. Итог копится
    // разборами: у строки своя активность, на которой её разобрали (старый итог без неё — время разбора)
    if (s && (x.turns !== undefined && s.turns !== undefined ? s.turns > x.turns : s.lastActivityAt > (x.activityAt ?? x.at ?? reply.at))) stale.push(x.id);
    return true;
  });
  const open = fresh.filter((x) => x.verdict !== 'done').sort((a, b) => RANK[a.verdict] - RANK[b.verdict]);
  return { open, done: fresh.filter((x) => x.verdict === 'done'), stale };
}

/**
 * Ключ скрытой строки: сессия и разбор, который скрыли. Новый разбор той же сессии (кнопкой или по расписанию источника
 * «Проекты») — строка снова видна; старые скрытые (только id) больше не совпадают.
 */
export const reviewHideKey = (x: Pick<SessionReviewItem, 'id' | 'at'>): string => (x.at ? `${x.id}@${x.at}` : x.id);

/** Строка под заголовком: когда разобрано, сколько сессий и цена. */
export function reviewMeta(reply: SessionReviewReply): string {
  return [
    t('разобрано {when}', { when: feedTime(reply.at) }),
    t('сессий: {n}', { n: reply.reviewed }),
    reply.skipped ? t('ещё не разобрано: {n}', { n: reply.skipped }) : '',
    reply.costUsd ? `$${reply.costUsd.toFixed(2)}` : '',
  ].filter(Boolean).join(' · ');
}

/** Цена до запуска: «≈ $0.04–0.09 · потолок $0.60». */
export const costRange = (low: number, high: number, ceiling: number): string =>
  t('≈ ${low}–{high} · потолок ${ceiling}', { low: low.toFixed(2), high: high.toFixed(2), ceiling: ceiling.toFixed(2) });
