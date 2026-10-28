// Сайдбар (ui/index.html aside.sidebar): бренд, разделы со счётчиком вопросов, «Сейчас», Flow, Запуски.
// Список flow — FlowList.tsx, список запусков — RunList.tsx. Свёрнутость секций, папок и проектов — fold.ts, ключи как в старом UI.
import type { ReactNode } from 'react';
import { Link, NavLink, useMatch, useNavigate } from 'react-router';
import type { SessionView } from '@server/api-types';
import { useFeature, useHome, useRuns } from '../../api';
import { useSessions } from '../../api/sessions';
import { inboxCount, LIVE_STATUSES, liveCount, liveRows, liveRowTitle } from '../../lib/home';
import { getLang, saveLang, t } from '../../lib/i18n';
import { sessionSub } from '../../lib/sessions';
import { isOpen, setOpen, useFold } from './fold';
import { FlowList, FlowSectionActions } from './FlowList';
import { RunList, RunSectionActions } from './RunList';
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
function LiveSection() {
  const home = useHome();
  const runs = useRuns();
  const navigate = useNavigate();
  const activeId = useMatch('/run/:id')?.params.id;
  const homeRuns = home.data?.runs ?? [];
  const src = !home.isError && homeRuns.length ? homeRuns : (runs.data ?? []).filter((r) => LIVE_STATUSES.includes(r.status));
  const rows = liveRows(src);
  const sessions = useLiveSessions();
  if (!rows.length && !sessions.length) return null;
  const count = liveCount(rows);
  const open = (id: string) => void navigate(`/run/${id}`);
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
            tabIndex={0}
            title={liveRowTitle(row)}
            onClick={() => open(row.r.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) open(row.r.id);
            }}
          >
            <span className={styles.lrunDot} aria-hidden="true" />
            <span className={styles.lrunMain}>
              <span className={styles.lrunTitle}>{row.r.title || row.r.flow}</span>
              <span className={styles.lrunSub}>{row.sub}</span>
            </span>
            {row.it && <span className={styles.lrunIt} title={t('Итерация идущего блока / лимит')}>{row.it}</span>}
          </li>
        ))}
      </ul>
      <LiveSessions sessions={sessions} />
    </Section>
  );
}

/** Живые сессии терминала (фича sessions). */
function useLiveSessions(): SessionView[] {
  const on = useFeature('sessions');
  return (useSessions(on).data?.sessions ?? []).filter((s) => s.live);
}

/**
 * Живые сессии терминала в «Сейчас» — под запусками и не в счётчике «ждут»: сессия в простое ждёт человека всегда,
 * и счётчик горел бы без конца. Точка: работает — синяя с ореолом, ждёт тебя — янтарная, запускается — серая.
 */
function LiveSessions({ sessions }: { sessions: SessionView[] }) {
  const navigate = useNavigate();
  const activeId = useMatch('/sessions/:id')?.params.id;
  if (!sessions.length) return null;
  const open = (id: string) => void navigate(`/sessions/${id}`);
  return (
    <ul className={`${styles.sideBody} ${styles.liveList}`} aria-label={t('Сессии терминала')}>
      {sessions.map((s) => (
        <li
          key={s.id}
          className={[styles.lrun, s.status === 'waiting' ? styles.wait : '', s.status === 'working' ? styles.sessionWorking : '', s.status === 'starting' ? styles.sessionStarting : '', s.id === activeId ? styles.active : ''].filter(Boolean).join(' ')}
          tabIndex={0}
          title={`${s.name}\n${sessionSub(s)}`}
          onClick={() => open(s.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target === e.currentTarget) open(s.id);
          }}
        >
          <span className={styles.lrunDot} aria-hidden="true" />
          <span className={styles.lrunMain}>
            <span className={styles.lrunTitle}>{s.name}</span>
            <span className={styles.lrunSub}>{sessionSub(s)}</span>
          </span>
          <span className={styles.lrunIt} title={t('Сессия Claude Code в терминале')}>›_</span>
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

export function Sidebar() {
  const tags = useFeature('tags');
  const context = useFeature('context');
  const sessions = useFeature('sessions');
  const questions = inboxCount(useHome().data?.runs ?? []);
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brandRow}>
        <Link to="/" className={styles.brand} title={t('Главная: вопросы агентов и идущие запуски')}>agentgraph</Link>
        <LangSwitch />
      </div>
      {/* разделы — компактной строкой: главное в сайдбаре — запуски и flow */}
      <ul className={styles.sideNav}>
        <li>
          <NavLink to="/" end title={t('Вопросы агентов и идущие запуски')}>
            {t('Главная')}
            {questions > 0 && <span className={styles.brandCount} title={t('Вопросов ждут ответа')}>{questions}</span>}
          </NavLink>
        </li>
        {tags && (
          <li><NavLink to="/tags" title={t('Теги задач: саммари фичи, заметки, пути и вложения, которые подставляются в запуск')}>{t('Теги')}</NavLink></li>
        )}
        {context && (
          <li><NavLink to="/context" title={t('Что уходит в контекст сессии: CLAUDE.md и правила, скиллы, сабагенты, MCP, токены')}>{t('Контекст')}</NavLink></li>
        )}
        {sessions && (
          <li><NavLink to="/sessions" title={t('Обычная сессия Claude Code в терминале, с контекстом тегов')}>{t('Сессии')}</NavLink></li>
        )}
      </ul>
      <LiveSection />
      <Section title="Flow" secKey="sec:flows" className={styles.secFlows} extra={<FlowSectionActions />}>
        <FlowList />
      </Section>
      <Section title={t('Запуски')} secKey="sec:runs" className={styles.secRuns} extra={<RunSectionActions />}>
        <RunList />
      </Section>
    </aside>
  );
}
