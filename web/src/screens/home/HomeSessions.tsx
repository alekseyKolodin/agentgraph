// Главная: живые сессии терминала строками — как идущие запуски (HomeRuns), но короче: имя, пространство (без него —
// папка), «ждёт N мин» или «работает», «Открыть». Ждущие стоят в «Ждёт тебя», работающие — в «Идут».
import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { SessionView } from '@server/api-types';
import { t } from '../../lib/i18n';
import { homeSessionMeta, sessionTone } from '../../lib/sessions';
import styles from './Home.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

export function HomeSessions({ sessions, now }: { sessions: SessionView[]; now: number }) {
  const navigate = useNavigate();
  return (
    <ul className={styles.homeRuns} aria-label={t('Сессии')}>
      {sessions.map((s) => {
        const to = `/sessions/${encodeURIComponent(s.id)}`;
        const tone = sessionTone(s);
        // клик по строке мимо ссылок — тот же переход; ссылки (Cmd+клик — в новой вкладке) переходят сами
        const open = (e: MouseEvent) => {
          if (!(e.target as HTMLElement).closest('a')) void navigate(to);
        };
        return (
          <li key={s.id} className={cx(styles.hrun, styles.hses, tone === 'wait' && styles.wait, tone === 'off' && styles.off)} onClick={open}>
            <span className={styles.hrunDot} aria-hidden="true" />
            <div className={styles.hrunMain}>
              <div className={styles.hrunTop}>
                <span className={styles.hsesMark} title={t('Сессия терминала')} aria-hidden="true">›_</span>
                {/* с клавиатуры — «Открыть»: у ссылки-имени своей остановки Tab нет */}
                <Link to={to} className={styles.hrunTitle} title={s.name} tabIndex={-1}>{s.name}</Link>
                <span className={styles.hrunMeta} title={s.cwd}>{homeSessionMeta(s, now)}</span>
              </div>
            </div>
            <span className={styles.hrunActs}>
              <Link to={to} className="btn small" aria-label={t('Открыть сессию «{name}»', { name: s.name })}>{t('Открыть')}</Link>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
