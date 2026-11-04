// Сайдбар (ui/index.html aside.sidebar): бренд, разделы со счётчиком вопросов, «Сейчас», Flow, Запуски, Завершённые сессии.
// Список flow — FlowList.tsx, список запусков — RunList.tsx, история сессий — SessionList.tsx. Свёрнутость секций, папок,
// проектов и пространств — fold.ts, ключи как в старом UI. Строки всех списков — ссылки: Cmd+клик, Tab и Enter.
// На узком экране (≤ 800 px) сайдбар выдвижной: открывает его кнопка «Меню» в Shell.tsx, закрывает × здесь.
import { type ReactNode, type Ref } from 'react';
import { Link, NavLink, useMatch } from 'react-router';
import type { SessionView } from '@server/api-types';
import { useFeature, useHome, useRuns } from '../../api';
import { inboxCount, LIVE_STATUSES, liveCount, liveRows, liveRowTitle } from '../../lib/home';
import { useNow } from '../useNow';
import { getLang, saveLang, t } from '../../lib/i18n';
import { sessionSub } from '../../lib/sessions';
import { RENAME_HOST, SessionName } from '../../screens/sessions/SessionName';
import { isOpen, setOpen, useFold } from './fold';
import { FlowList, FlowSectionActions } from './FlowList';
import { RunList, RunSectionActions } from './RunList';
import { SessionList, SessionSectionActions, useAllSessions } from './SessionList';
import { UpdateBadge } from './UpdateBadge';
import styles from './Sidebar.module.css';

const caret = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4.5 6l3.5 3.5L11.5 6" />
  </svg>
);

/** Свёрнута ли секция: общий со старым UI список ключей (sec:live, sec:flows, sec:runs, папки, проекты). */
function useCollapsed(key: string): [boolean, (v: boolean) => void] {
  useFold();
  return [!isOpen(key), (v: boolean) => setOpen(key, !v)];
}

/** Секция сайдбара со сворачиванием по заголовку; extra — справа в заголовке, children — тело (со своим side-body). */
function Section({ title, secKey, className, extra, children }: { title: string; secKey: string; className: string | undefined; extra?: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useCollapsed(secKey);
  return (
    <section className={[styles.sideSection, className, collapsed ? styles.collapsed : ''].filter(Boolean).join(' ')}>
      <div className={styles.sideHead}>
        <button className={styles.secToggle} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          <span className={styles.caret}>{caret}</span>
          <h2>{title}</h2>
        </button>
        {extra}
      </div>
      {children}
    </section>
  );
}

/** «Сейчас»: идущие запуски, ждущие тебя — первыми. Данные — /api/home (как строки главной), без неё — статусы из списка запусков. */
function LiveSection({ all }: { all: SessionView[] }) {
  const home = useHome();
  const runs = useRuns();
  const activeId = useMatch('/run/:id')?.params.id;
  const homeRuns = home.data?.runs ?? [];
  const src = !home.isError && homeRuns.length ? homeRuns : (runs.data ?? []).filter((r) => LIVE_STATUSES.includes(r.status));
  const rows = liveRows(src);
  const sessions = all.filter((s) => s.live);
  if (!rows.length && !sessions.length) return null;
  const count = liveCount(rows);
  return (
    <Section
      title={t('Сейчас')}
      secKey="sec:live"
      className={styles.sideLive}
      extra={rows.length > 0 && <span className={`${styles.sideCount} ${count.wait ? styles.wait : ''}`}>{count.text}</span>}
    >
      <ul className={`${styles.sideBody} ${styles.liveList}`}>
        {rows.map((row) => (
          <li
            key={row.r.id}
            className={[styles.lrun, styles[row.tone], row.r.id === activeId ? styles.active : ''].filter(Boolean).join(' ')}
            title={`${liveRowTitle(row)}${row.it ? `\n${t('Итерация идущего блока / лимит')}: ${row.it}` : ''}`}
          >
            <span className={styles.lrunDot} aria-hidden="true" />
            <span className={styles.lrunMain}>
              <Link className={`${styles.lrunTitle} ${styles.rowLink}`} to={`/run/${row.r.id}`} aria-current={row.r.id === activeId ? 'page' : undefined}>
                {row.r.title || row.r.flow}
              </Link>
              <span className={styles.lrunSub}>{row.sub}</span>
            </span>
            {/* подсказка «2/5» — в подсказке строки: ссылка строки лежит поверх */}
            {row.it && <span className={styles.lrunIt}>{row.it}</span>}
          </li>
        ))}
      </ul>
      <LiveSessions sessions={sessions} />
    </Section>
  );
}

/**
 * Живые сессии терминала в «Сейчас» — под запусками и не в счётчике «ждут»: сессия в простое ждёт человека всегда,
 * и счётчик горел бы без конца. Точка: работает — синяя с ореолом, ждёт тебя — янтарная, запускается — серая.
 */
function LiveSessions({ sessions }: { sessions: SessionView[] }) {
  const activeId = useMatch('/sessions/:id')?.params.id;
  // «5 мин назад» во второй строке: у ждущей сессии данные не меняются — перерисовка раз в 30 секунд
  const now = new Date(useNow(30_000));
  if (!sessions.length) return null;
  return (
    <ul className={`${styles.sideBody} ${styles.liveList}`} aria-label={t('Сессии терминала')}>
      {sessions.map((s) => (
        <li
          key={s.id}
          className={[styles.lrun, s.status === 'waiting' ? styles.wait : '', s.status === 'working' ? styles.sessionWorking : '', s.status === 'starting' ? styles.sessionStarting : '', s.id === activeId ? styles.active : '', RENAME_HOST].filter(Boolean).join(' ')}
        >
          <span className={styles.lrunDot} aria-hidden="true" />
          <span className={styles.lrunMain}>
            {/* имя — ссылка на всю строку; одиночный клик открывает после паузы на двойной (двойной — переименовать) */}
            <SessionName s={s} to={`/sessions/${s.id}`} textClassName={`${styles.lrunTitle} ${styles.rowLink}`} title={`${s.name}\n${sessionSub(s, now)}\n${t('Сессия Claude Code в терминале')}`} />
            <span className={styles.lrunSub}>{sessionSub(s, now)}</span>
          </span>
          <span className={styles.lrunIt} aria-hidden="true">›_</span>
        </li>
      ))}
    </ul>
  );
}

/** Переключатель языка: запоминает выбор и перезагружает страницу — тексты берутся при загрузке. */
function LangSwitch() {
  const next = getLang() === 'ru' ? 'en' : 'ru';
  return (
    <button
      type="button"
      className={styles.langSwitch}
      title={next === 'en' ? 'Switch the interface to English' : 'Переключить интерфейс на русский'}
      onClick={() => {
        saveLang(next);
        location.reload();
      }}
    >
      {next === 'en' ? 'EN' : 'RU'}
    </button>
  );
}

type SidebarProps = {
  id?: string;
  /** Класс выдвижного сайдбара на узком экране (Shell.module.css). */
  className?: string;
  /** Выдвижной сайдбар открыт: сам берёт фокус (tabindex только на это время — иначе клик по пустому месту уводил бы фокус с body). */
  drawerOpen?: boolean;
  /** Закрыть выдвижной сайдбар: кнопка × видна только на узком экране. */
  onClose?: () => void;
  ref?: Ref<HTMLElement>;
};

export function Sidebar({ id, className, drawerOpen = false, onClose, ref }: SidebarProps) {
  const spaces = useFeature('spaces');
  const tags = useFeature('tags');
  const context = useFeature('context');
  const sessions = useFeature('sessions');
  const questions = inboxCount(useHome().data?.runs ?? []);
  const allSessions = useAllSessions();
  const ended = allSessions.filter((s) => !s.live);
  return (
    <aside id={id} ref={ref} tabIndex={drawerOpen ? -1 : undefined} className={[styles.sidebar, className].filter(Boolean).join(' ')} aria-label={t('Боковая панель')}>
      <div className={styles.brandRow}>
        <Link to="/" className={styles.brand} title={t('Главная: вопросы агентов и идущие запуски')}>AgentGraph</Link>
        <span className={styles.brandTools}>
          <UpdateBadge />
          <LangSwitch />
          {onClose && (
            <button type="button" className={`btn small ghost ${styles.sideClose}`} aria-label={t('Закрыть меню')} title={t('Закрыть меню (Esc)')} onClick={onClose}>
              ×
            </button>
          )}
        </span>
      </div>
      {/* разделы — компактной сеткой в две колонки (работа: главная, пространства, сессии; справка: знания, контекст), по
          колонкам: счётчик вопросов не переносит пункты, а главное в сайдбаре — запуски и flow */}
      <nav className={styles.sideNavWrap} aria-label={t('Разделы')}>
      <ul className={styles.sideNav}>
        <li className={styles.navWork}>
          <NavLink to="/" end title={t('Вопросы агентов и идущие запуски')}>
            {t('Главная')}
            {questions > 0 && <span className={styles.brandCount} title={t('Вопросов ждут ответа')}>{questions}</span>}
          </NavLink>
        </li>
        {spaces && (
          <li className={styles.navWork}><NavLink to="/spaces" title={t('Пространства: фича или проект — карта (CLAUDE.md), документы, состояние «где мы сейчас», все их сессии и запуски')}>{t('Пространства')}</NavLink></li>
        )}
        {sessions && (
          <li className={styles.navWork}><NavLink to="/sessions" title={t('Обычная сессия Claude Code в терминале, в пространстве и с тегами знаний')}>{t('Сессии')}</NavLink></li>
        )}
        {tags && (
          <li className={styles.navRef}><NavLink to="/tags" title={t('Теги знаний: правила и справка для этапов flow и сессий — строка в промпте, полный текст по запросу')}>{t('Знания')}</NavLink></li>
        )}
        {context && (
          <li className={styles.navRef}><NavLink to="/context" title={t('Что уходит в контекст сессии: CLAUDE.md и правила, скиллы, сабагенты, MCP, токены')}>{t('Контекст')}</NavLink></li>
        )}
      </ul>
      </nav>
      <LiveSection all={allSessions} />
      <Section title="Flow" secKey="sec:flows" className={styles.secFlows} extra={<FlowSectionActions />}>
        <FlowList />
      </Section>
      <Section title={t('Запуски')} secKey="sec:runs" className={styles.secRuns} extra={<RunSectionActions />}>
        <RunList />
      </Section>
      {/* живые сессии — в «Сейчас», здесь — завершённые, группами по пространству */}
      {sessions && ended.length > 0 && (
        <Section title={t('Завершённые сессии')} secKey="sec:sessions" className={styles.secSessions} extra={<SessionSectionActions sessions={ended} />}>
          <SessionList sessions={ended} />
        </Section>
      )}
    </aside>
  );
}
