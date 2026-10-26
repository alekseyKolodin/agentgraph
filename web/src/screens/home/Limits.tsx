// Главная: лимиты подписки Claude — 5-часовое и недельное окна (GET /api/limits), как в /usage Claude Code (ui/limits.js).
// Сервер кэширует ответ на минуту; обновляем раз в минуту, пока главная на виду и вкладка видна. Клик — мимо кэша.
import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LimitWindow } from '@server/api-types';
import { errorText, fetchLimits, keys } from '../../api';
import { clock, when } from '../../lib/format';
import { limitView } from '../../lib/limits';
import { t } from '../../lib/i18n';
import styles from './Limits.module.css';

const LIMITS_POLL_MS = 60_000;
const BASE_TITLE = t('Лимиты подписки Claude: доля окна, израсходованная всеми сессиями аккаунта');

export function Limits() {
  // клик просит свежие данные: следующий запрос идёт с force=1
  const force = useRef(false);
  const q = useQuery({
    queryKey: keys.limits,
    queryFn: () => {
      const f = force.current;
      force.current = false;
      return fetchLimits(f);
    },
    // интервал React Query сам стоит, пока вкладка скрыта; компонент живёт только на главной
    refetchInterval: LIMITS_POLL_MS,
    retry: false,
  });
  const reload = () => {
    force.current = true;
    void q.refetch();
  };

  const d = q.data;
  const error = q.error ? errorText(q.error) : '';
  // без подписки (ключ API, Bedrock, Vertex) окон нет — блок не показываем
  if (!d?.available && !error) return null;
  if (!d?.available) {
    return (
      <div className={styles.homeLimits} title={BASE_TITLE} onClick={reload}>
        <span className="muted small">{t('Лимиты недоступны: {error}', { error })}</span>
      </div>
    );
  }
  const title = t('Лимиты подписки Claude ({plan}): доля окна, израсходованная всеми сессиями аккаунта. Данные на {time}, клик — обновить', { plan: d.subscription || '—', time: clock(d.at) });
  return (
    <div className={styles.homeLimits} title={title} onClick={reload}>
      <Limit label={t('5 часов')} w={d.fiveHour} />
      <Limit label={t('Неделя')} w={d.weekly} />
      {error && (
        <>
          {' '}
          <span className="muted small" title={error}>· {t('не обновились')}</span>
        </>
      )}
    </div>
  );
}

function Limit({ label, w }: { label: string; w: LimitWindow | null }) {
  const v = limitView(w);
  if (!v) return null;
  return (
    <div className={`${styles.limit} ${v.tone}`}>
      <div className={styles.limitTop}><span>{label}</span><b>{v.percent}%</b></div>
      <div className={styles.limitBar}><span style={{ width: `${v.percent}%` }} /></div>
      <div className="muted small" title={when(w?.resetsAt)}>{v.reset}</div>
    </div>
  );
}
