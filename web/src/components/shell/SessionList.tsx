// Секция «Завершённые сессии» сайдбара: история сессий терминала группами по пространству — как запуски по проекту.
// Живые сессии — в «Сейчас», сюда они попадают, когда завершатся. Строка — ссылка на экран сессии (Cmd+клик — в новом
// окне), имя переименовывается на месте (двойной клик или карандаш). Логика — lib/session-history.ts; свёрнутость
// групп — fold.ts (sspace:<слаг>), «ещё N» — в памяти вкладки.
import { useEffect, useSyncExternalStore } from 'react';
import { useMatch } from 'react-router';
import type { SessionView } from '@server/api-types';
import { useFeature } from '../../api';
import { useSessions } from '../../api/sessions';
import { t } from '../../lib/i18n';
import { historySub, historyTitle, sessionHistory } from '../../lib/session-history';
import { RENAME_HOST, SessionName } from '../../screens/sessions/SessionName';
import { isOpen, reveal, setOpen, useFold } from './fold';
import { useNow } from '../useNow';
import { ICON } from './FlowList';
import styles from './Sidebar.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

// раскрытые хвосты «ещё N» — общие для всех копий списка, только в памяти вкладки
const showAll = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const showMore = (key: string) => {
  showAll.add(key);
  version++;
  for (const fn of listeners) fn();
};

/** Все сессии (фича sessions): один запрос с «Сейчас» и страницей «Сессии». */
export function useAllSessions(): SessionView[] {
  const on = useFeature('sessions');
  return useSessions(on).data?.sessions ?? [];
}

const useActiveSession = () => useMatch('/sessions/:id')?.params.id ?? null;

function useGroups(sessions: SessionView[]) {
  useSyncExternalStore(subscribe, () => version);
  const activeId = useActiveSession();
  return { activeId, groups: sessionHistory(sessions, activeId, showAll) };
}

/** Кнопка в шапке секции: свернуть или развернуть все пространства. */
export function SessionSectionActions({ sessions }: { sessions: SessionView[] }) {
  useFold();
  const { groups } = useGroups(sessions);
  if (groups.length < 2) return null;
  const anyOpen = groups.some((g) => isOpen(g.key));
  const label = anyOpen ? t('Свернуть все пространства') : t('Развернуть все пространства');
  return (
    <div className={styles.sideActions}>
      <button
        className={cx('btn small ghost icon-btn', styles.fold)}
        title={label}
        aria-label={label}
        onClick={() => {
          for (const g of groups) setOpen(g.key, !anyOpen);
        }}
      >
        {anyOpen ? ICON.foldAll : ICON.unfoldAll}
      </button>
    </div>
  );
}

export function SessionList({ sessions }: { sessions: SessionView[] }) {
  useFold();
  // «5 мин назад» в мете: у завершённых данные не меняются — перерисовка раз в минуту
  const now = new Date(useNow(60_000));
  const { activeId, groups } = useGroups(sessions);

  // открыли завершённую сессию (по ссылке, из таблицы): раздел и её пространство раскрыты, как у запусков
  const activeKey = groups.find((g) => g.sessions.some((s) => s.id === activeId))?.key;
  useEffect(() => {
    if (activeKey) reveal('sec:sessions', activeKey);
  }, [activeId, activeKey]);

  return (
    <div className={styles.sideBody}>
      {groups.map((g) => {
        const open = isOpen(g.key);
        return (
          <div key={g.key} className={cx(styles.grp, !open && styles.collapsed)}>
            <button className={styles.grpHead} aria-expanded={open} title={g.title} onClick={() => setOpen(g.key, !open)}>
              <span className={styles.caret}>{ICON.caret}</span>
              <span className={styles.grpName}>{g.label}</span>
              <span className={styles.grpCount}>{g.count}</span>
            </button>
            <ul className={styles.list}>
              {g.sessions.map((s) => {
                const sub = historySub(s, !g.space, now);
                return (
                  <li key={s.id} className={cx(styles.histRow, s.id === activeId && styles.active, RENAME_HOST)}>
                    <SessionName s={s} to={`/sessions/${s.id}`} textClassName={cx(styles.name, styles.rowLink)} title={historyTitle(s)} />
                    <span className={styles.sub}>
                      {sub.outcome && (
                        <>
                          <span className={styles.fail}>{sub.outcome}</span>
                          {' · '}
                        </>
                      )}
                      {sub.rest}
                    </span>
                  </li>
                );
              })}
              {g.more > 0 && (
                <li className={styles.more}>
                  <button type="button" className={styles.moreBtn} onClick={() => showMore(g.key)}>
                    {t('ещё {n}', { n: g.more })}
                  </button>
                </li>
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
