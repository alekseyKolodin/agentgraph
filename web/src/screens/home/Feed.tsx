// Главная: журнал справа (ui/feed.js) — вопросы агентов, паузы по их просьбе и концы запусков. Это история, а не входящие:
// отвечают на доске (вопросы — над ней), поэтому ни счётчика непрочитанного, ни отметки «прочитано», ни выделения ждущего.
// Источник — GET /api/feed (из run.json): журнал переживает перезагрузку вкладки и перезапуск сервера.
import { Link } from 'react-router';
import type { FeedItem } from '@server/api-types';
import { useFeed } from '../../api';
import { Badge } from '../../components/Badge';
import { flashQuestion } from '../../components/question/QuestionCard';
import { feedTime, usd, when } from '../../lib/format';
import { FEED_SHOWN, feedTone, feedWhat } from '../../lib/feed';
import { t } from '../../lib/i18n';
import { projectHint, projectLabel } from '../../lib/spaces';
import { useMemoryState } from '../../components/useMemoryState';
import styles from './Feed.module.css';

export function Feed({ now }: { now: number }) {
  const items = useFeed(true).data?.items;
  const [all, setAll] = useMemoryState('feed.all', false);
  const list = items ?? [];
  const visible = all ? list : list.slice(0, FEED_SHOWN);
  const more = list.length - visible.length;

  return (
    <aside className={styles.homeFeed}>
      <div className={styles.feedHead}>
        <h2 title={t('Что было: вопросы агентов, паузы и концы запусков. Отвечать — на доске')}>{t('Журнал')}</h2>
      </div>
      <ul className={styles.feedList}>
        {list.length ? (
          <>
            {visible.map((x) => <FeedRow key={x.id} x={x} now={now} />)}
            {more > 0 && (
              <li>
                <button type="button" className={`btn small ghost ${styles.feedMore}`} onClick={() => setAll(true)}>{t('Ещё {n}', { n: more })}</button>
              </li>
            )}
          </>
        ) : (
          <li className={`${styles.feedEmpty} muted small`}>{t('Пока пусто: здесь будут вопросы агентов, паузы и концы запусков')}</li>
        )}
      </ul>
    </aside>
  );
}

function FeedRow({ x, now }: { x: FeedItem; now: number }) {
  const at = new Date(now);
  const w = feedWhat(x, at);
  // вопрос, который ждёт ответа, — над доской: ведём к его карточке, а не на страницу запуска
  const qid = x.kind === 'question' && x.open ? x.id : undefined;
  return (
    <li>
      <Link
        className={[styles.feedItem, x.kind, feedTone(x)].filter(Boolean).join(' ')}
        to={`/run/${x.runId}`}
        data-qid={qid}
        onClick={(e) => {
          if (qid && flashQuestion(qid)) e.preventDefault();
        }}
      >
        <span className={styles.feedDot} />
        <span className={styles.feedTop}>
          <span className={styles.feedFlow}>{x.flow}</span>
          {/* проект запуска — как в сайдбаре; без проекта журнал не шумим */}
          {x.projectRef?.space && <span className={styles.feedProject} title={projectHint(x.projectRef)}>{projectLabel(x.projectRef)}</span>}
          <time className={styles.feedTime} title={when(x.at)}>{feedTime(x.at, at)}</time>
        </span>
        <span className={styles.feedWhat} title={w.tip}>
          <span className={styles.feedWhatHead}>{w.head}</span>
          <span className={styles.feedWhatTail}>
            {w.state ? (
              `· ${w.state.text}`
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
