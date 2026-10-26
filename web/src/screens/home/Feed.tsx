// Главная: лента событий справа (ui/feed.js) — вопросы агентов, паузы по их просьбе и концы запусков, то же, о чём
// приходят уведомления. Источник — GET /api/feed (из run.json): лента переживает перезагрузку вкладки и перезапуск сервера.
// Новые после отметки «прочитано» подсвечены; отметка — удобство одной вкладки, поэтому localStorage.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { FeedItem } from '@server/api-types';
import { useFeed } from '../../api';
import { Badge } from '../../components/Badge';
import { flashQuestion } from '../../components/question/QuestionCard';
import { feedTime, usd, when } from '../../lib/format';
import { FEED_SEEN_KEY, FEED_SHOWN, feedTone, feedWhat, isUnread, unreadCount } from '../../lib/feed';
import { LS } from '../../lib/storage';
import { t } from '../../lib/i18n';
import { useMemoryState } from '../../components/useMemoryState';
import styles from './Feed.module.css';

export function Feed({ now }: { now: number }) {
  const items = useFeed(true).data?.items;
  const [seen, setSeen] = useState(() => LS.get(FEED_SEEN_KEY, ''));
  const [all, setAll] = useMemoryState('feed.all', false);
  const markSeen = (at: string) => {
    setSeen(at);
    LS.set(FEED_SEEN_KEY, at);
  };

  // первая загрузка: прошлое не подсвечиваем, новым считаем то, что придёт дальше
  useEffect(() => {
    if (items && !seen) markSeen(items[0]?.at ?? new Date().toISOString());
  }, [items, seen]);

  const list = items ?? [];
  const unread = unreadCount(list, seen);
  const visible = all ? list : list.slice(0, FEED_SHOWN);
  const more = list.length - visible.length;

  return (
    <aside className={styles.homeFeed}>
      <div className={styles.feedHead}>
        <h2 title={t('Вопросы агентов, паузы и концы запусков — то же, о чём приходят уведомления')}>
          {t('События')} {unread > 0 && <span className={styles.feedUnread} title={t('Новых после последней отметки')}>{unread}</span>}
        </h2>
        {unread > 0 && (
          <button className="btn small ghost" title={t('Снять подсветку новых событий')} onClick={() => list[0] && markSeen(list[0].at)}>
            {t('Отметить прочитанным')}
          </button>
        )}
      </div>
      <ul className={styles.feedList}>
        {list.length ? (
          <>
            {visible.map((x) => <FeedRow key={x.id} x={x} unread={isUnread(x, seen)} now={now} />)}
            {more > 0 && (
              <li>
                <button type="button" className={`btn small ghost ${styles.feedMore}`} onClick={() => setAll(true)}>{t('Ещё {n}', { n: more })}</button>
              </li>
            )}
          </>
        ) : (
          <li className={`${styles.feedEmpty} muted small`}>{t('Пока пусто: здесь появятся вопросы агентов, паузы и концы запусков')}</li>
        )}
      </ul>
    </aside>
  );
}

function FeedRow({ x, unread, now }: { x: FeedItem; unread: boolean; now: number }) {
  const at = new Date(now);
  const w = feedWhat(x, at);
  // вопрос, который ждёт ответа, — на главной: ведём к его карточке, а не на страницу запуска
  const qid = x.kind === 'question' && x.open ? x.id : undefined;
  return (
    <li>
      <Link
        className={[styles.feedItem, x.kind, feedTone(x), unread ? styles.new : ''].filter(Boolean).join(' ')}
        to={`/run/${x.runId}`}
        data-qid={qid}
        onClick={(e) => {
          if (qid && flashQuestion(qid)) e.preventDefault();
        }}
      >
        <span className={styles.feedDot} />
        <span className={styles.feedTop}>
          <span className={styles.feedFlow}>{x.flow}</span>
          <time className={styles.feedTime} title={when(x.at)}>{feedTime(x.at, at)}</time>
        </span>
        <span className={styles.feedWhat} title={w.tip}>
          <span className={styles.feedWhatHead}>{w.head}</span>
          <span className={styles.feedWhatTail}>
            {w.state ? (
              <>
                {'· '}
                {w.state.wait ? <b className={styles.feedWait}>{w.state.text}</b> : w.state.text}
              </>
            ) : (
              <>
                <Badge status={x.status ?? ''} /> <span className="muted">{usd(x.costUsd)}</span>
              </>
            )}
          </span>
        </span>
        {x.text && <span className={styles.feedText} title={x.text}>{x.text}</span>}
      </Link>
    </li>
  );
}
