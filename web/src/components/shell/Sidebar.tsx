// Левое меню «рельс и панель»: узкий рельс со значками разделов и панель рядом — бренд, «Сейчас» и один список: Flow,
// Запуски или завершённые сессии (какой — значок на рельсе; тот же значок ещё раз скрывает панель, как в VS Code).
// Список сам переключается, когда открыт flow, запуск или сессия (lib/side-panel.ts), выбор и скрытость — panel.ts.
// Список flow — FlowList.tsx, список запусков — RunList.tsx, история сессий — SessionList.tsx. Свёрнутость «Сейчас», папок,
// проектов и пространств — fold.ts, ключи как в старом UI. Строки всех списков — ссылки: Cmd+клик, Tab и Enter.
// На узком экране (≤ 800 px) сайдбар выдвижной: открывает его кнопка «Меню» в Shell.tsx, закрывает × здесь; панель там видна всегда.
import { useEffect, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { Link, NavLink, useLocation, useMatch } from 'react-router';
import type { SessionView } from '@server/api-types';
import { useFeature, useHome, useRuns } from '../../api';
import { useRoutines } from '../../api/routines';
import { activeWaits } from '../../lib/routines/view';
import { inboxCount, LIVE_STATUSES, liveCount, liveRows, liveRowTitle } from '../../lib/home';
import { panelForPath, railClick, validPanel, type SidePanel } from '../../lib/side-panel';
import { useNow } from '../useNow';
import { getLang, saveLang, t } from '../../lib/i18n';
import { sessionSub } from '../../lib/sessions';
import { RENAME_HOST, SessionName } from '../../screens/sessions/SessionName';
import { isOpen, setOpen, useFold } from './fold';
import { FlowList, FlowSectionActions } from './FlowList';
import { RunList, RunSectionActions } from './RunList';
import { SessionList, SessionSectionActions, useAllSessions } from './SessionList';
import { panelState, setPanel, usePanel } from './panel';
import { openQuickSession } from './QuickSession';
import { UpdateBadge } from './UpdateBadge';
import styles from './Sidebar.module.css';

const caret = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4.5 6l3.5 3.5L11.5 6" />
  </svg>
);

/** Свёрнута ли секция: общий со старым UI список ключей (sec:live — «Сейчас»; папки и проекты — в списках). */
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

/** Строки «Сейчас»: данные — /api/home (как строки главной), без неё — статусы из списка запусков. */
function useLiveRows() {
  const home = useHome();
  const runs = useRuns();
  const homeRuns = home.data?.runs ?? [];
  const src = !home.isError && homeRuns.length ? homeRuns : (runs.data ?? []).filter((r) => LIVE_STATUSES.includes(r.status));
  return liveRows(src);
}

/** «Сейчас»: идущие запуски, ждущие тебя — первыми. */
function LiveSection({ all }: { all: SessionView[] }) {
  const activeId = useMatch('/run/:id')?.params.id;
  const rows = useLiveRows();
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

/** Значки рельса: 16×16, линией, как остальные значки «Пульта». */
const ico = (children: ReactNode) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">{children}</svg>
);
const RAIL_ICON = {
  home: ico(<path d="M2.5 7.5L8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5" />),
  flows: ico(
    <>
      <circle cx="4" cy="4" r="1.7" />
      <circle cx="12" cy="8" r="1.7" />
      <circle cx="4" cy="12" r="1.7" />
      <path d="M5.6 4.8l4.8 2.4M5.6 11.2l4.8-2.4" />
    </>,
  ),
  runs: ico(<path d="M2.8 6.2A5.5 5.5 0 1 1 2.5 8M2.5 3v3.2h3.2M8 5v3.2l2.2 1.4" />),
  sessions: ico(<path d="M2 3.5h12v9H2zM4.5 6.5L6.5 8l-2 1.5M8 10h3" />),
  spaces: ico(<path d="M8 2l5.5 3v6L8 14l-5.5-3V5zM2.5 5L8 8l5.5-3M8 8v6" />),
  teamwork: ico(
    <>
      <circle cx="6" cy="5.5" r="2" />
      <path d="M2.5 13c0-2 1.6-3.5 3.5-3.5S9.5 11 9.5 13" />
      <circle cx="11.3" cy="6" r="1.6" />
      <path d="M10.6 9.6c1.7 0 2.9 1.4 2.9 3.4" />
    </>,
  ),
  code: ico(<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10" />),
  // рутина — молния «когда → делай», как ↯ у запусков рутин на главной
  routines: ico(<path d="M9 1.8L3.5 9h4L6.8 14.2 12.5 7h-4z" />),
  tags: ico(<path d="M3 3h3.5A1.5 1.5 0 0 1 8 4.5a1.5 1.5 0 0 1 1.5-1.5H13v9.5H9.5A1.5 1.5 0 0 0 8 14a1.5 1.5 0 0 0-1.5-1.5H3zM8 4.5V14" />),
  context: ico(<path d="M8 2.5l5.5 2.75L8 8 2.5 5.25zM2.5 8L8 10.75 13.5 8M2.5 10.75L8 13.5l5.5-2.75" />),
  panel: ico(<path d="M2.5 3h11v10h-11zM6.5 3v10" />),
  plus: ico(<path d="M8 3.5v9M3.5 8h9" />),
};

/** Списки панели: значок, подпись и подсказка. */
const PANELS: Record<SidePanel, { icon: ReactNode; label: string; tip: string }> = {
  flows: { icon: RAIL_ICON.flows, label: 'Flow', tip: t('Flow: цепочки этапов по папкам — открыть, запустить, создать') },
  runs: { icon: RAIL_ICON.runs, label: t('Запуски'), tip: t('Запуски flow: идущие и прошедшие, по проектам, с фильтром по статусу') },
  sessions: { icon: RAIL_ICON.sessions, label: t('Сессии'), tip: t('Сессии Claude Code в терминале: новая и завершённые') },
};

/** Значок раздела на рельсе — ссылка на экран; подпись — в подсказке и для диктора. */
function RailLink({ to, end, icon, label, tip, children }: { to: string; end?: boolean; icon: ReactNode; label: string; tip: string; children?: ReactNode }) {
  return (
    <NavLink to={to} end={end} className={styles.railBtn} title={`${label}\n${tip}`} aria-label={label}>
      {icon}
      {children}
    </NavLink>
  );
}

/** Узкий экран, как @media в Shell.module.css: меню там выдвижное, и панель в нём видна всегда. */
const NARROW = window.matchMedia('(max-width: 800px)');
const subscribeNarrow = (fn: () => void) => {
  NARROW.addEventListener('change', fn);
  return () => NARROW.removeEventListener('change', fn);
};
const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => NARROW.matches);

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
  const teamwork = useFeature('teamwork');
  const code = useFeature('integrations');
  const routinesOn = useFeature('routines');
  // ожидания рутин — тоже «ждёт тебя» на главной: в счётчике значка вместе с вопросами агентов
  const routineWaits = activeWaits(useRoutines(routinesOn).data?.waits ?? []).length;
  const questions = inboxCount(useHome().data?.runs ?? []) + routineWaits;
  const allSessions = useAllSessions();
  const ended = allSessions.filter((s) => !s.live);
  const saved = usePanel();
  const narrow = useNarrow();
  // на узком экране панель не скрывается: сохранённое «скрыта» ждёт широкого окна
  const state = { panel: validPanel(saved.panel, sessions), hidden: saved.hidden && !narrow };
  const pick = (p: SidePanel) => setPanel(narrow ? { ...panelState(), panel: p } : railClick(state, p));
  const tabs: SidePanel[] = sessions ? ['flows', 'runs', 'sessions'] : ['flows', 'runs'];

  // открыли flow, запуск или сессию — панель показывает их список; скрытая остаётся скрытой
  const { pathname } = useLocation();
  useEffect(() => {
    const p = panelForPath(pathname);
    // только по смене адреса: выбор руками держится, пока не открыли другое
    if (p && (p !== 'sessions' || sessions)) setPanel({ ...panelState(), panel: p });
  }, [pathname, sessions]);

  // панель скрыта — «Сейчас» не видно: точка на значке «Запуски» (янтарная — ждут тебя, синяя — идут)
  const rows = useLiveRows();
  const live = rows.length ? liveCount(rows) : null;

  return (
    <aside
      id={id}
      ref={ref}
      tabIndex={drawerOpen ? -1 : undefined}
      className={[styles.sidebar, state.hidden ? styles.panelHidden : '', className].filter(Boolean).join(' ')}
      aria-label={t('Боковая панель')}
    >
      <nav className={styles.rail} aria-label={t('Разделы')}>
        <RailLink
          to="/"
          end
          icon={RAIL_ICON.home}
          label={questions > 0 ? `${t('Главная')}. ${t('Вопросов ждут ответа: {n}', { n: questions })}` : t('Главная')}
          tip={t('Вопросы агентов и идущие запуски')}
        >
          {questions > 0 && <span className={styles.railCount} aria-hidden="true">{questions}</span>}
        </RailLink>
        {sessions && (
          <button type="button" className={styles.railBtn} aria-haspopup="dialog" aria-label={t('Новая сессия')} title={`${t('Новая сессия (⌘N)')}\n${t('Пространство или папка — и терминал открыт')}`} onClick={openQuickSession}>
            {RAIL_ICON.plus}
          </button>
        )}
        <span className={styles.railSep} aria-hidden="true" />
        {tabs.map((p) => {
          const on = state.panel === p && !state.hidden;
          return (
            <button
              key={p}
              type="button"
              className={[styles.railBtn, on ? styles.railOn : ''].filter(Boolean).join(' ')}
              aria-pressed={on}
              aria-controls="side-panel"
              aria-label={PANELS[p].label}
              title={`${PANELS[p].label}\n${PANELS[p].tip}${on && !narrow ? `\n${t('Ещё раз — скрыть панель')}` : ''}`}
              onClick={() => pick(p)}
            >
              {PANELS[p].icon}
              {p === 'runs' && state.hidden && live && <span className={`${styles.railDot} ${live.wait ? styles.wait : ''}`} aria-hidden="true" />}
            </button>
          );
        })}
        {(spaces || tags || teamwork || code || routinesOn) && <span className={styles.railSep} aria-hidden="true" />}
        {spaces && <RailLink to="/spaces" icon={RAIL_ICON.spaces} label={t('Пространства')} tip={t('Пространства: фича или проект — карта (CLAUDE.md), документы, состояние «где мы сейчас», все их сессии и запуски')} />}
        {/* знания — рядом с пространствами: у пространства свои теги знаний (вкладка «Знания») */}
        {tags && <RailLink to="/tags" icon={RAIL_ICON.tags} label={t('Знания')} tip={t('Теги знаний: правила и справка для этапов flow и сессий — строка в промпте, полный текст по запросу')} />}
        {teamwork && <RailLink to="/teamwork" icon={RAIL_ICON.teamwork} label="Teamwork" tip={t('Teamwork: команда ведёт проекты в общем git-репо — ТЗ, архитектура, задачи и спринты')} />}
        {code && <RailLink to="/code" icon={RAIL_ICON.code} label={t('Код')} tip={t('Задачи Jira, MR и ветки подключённых проектов — запустить flow по любой из них')} />}
        {routinesOn && <RailLink to="/routines" icon={RAIL_ICON.routines} label={t('Рутины')} tip={t('Рутины: событие из сервиса, чата или расписания само запускает flow')} />}
        <span className={styles.railGap} />
        {context && <RailLink to="/context" icon={RAIL_ICON.context} label={t('Контекст')} tip={t('Что уходит в контекст сессии: CLAUDE.md и правила, скиллы, сабагенты, MCP, токены')} />}
        {/* панель скрыта — плашка обновления и язык переезжают на рельс: о новой версии и ошибке обновления видно и так */}
        {state.hidden && <UpdateBadge compact />}
        {state.hidden && <LangSwitch />}
        <button
          type="button"
          className={`${styles.railBtn} ${styles.railToggle}`}
          aria-expanded={!state.hidden}
          aria-controls="side-panel"
          aria-label={t('Панель')}
          title={state.hidden ? t('Показать панель: «Сейчас» и список') : t('Скрыть панель: больше места экрану')}
          onClick={() => setPanel({ ...state, hidden: !state.hidden })}
        >
          {RAIL_ICON.panel}
        </button>
      </nav>
      <div id="side-panel" className={styles.panel}>
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
        <LiveSection all={allSessions} />
        {/* все списки смонтированы, видим один: при переключении не теряются прокрутка и идущая генерация «Нового flow»
            (её диалог — в шапке списка Flow) */}
        <PanelList title="Flow" hidden={state.panel !== 'flows'} extra={<FlowSectionActions />}>
          <FlowList />
        </PanelList>
        <PanelList title={t('Запуски')} hidden={state.panel !== 'runs'} extra={<RunSectionActions />}>
          <RunList />
        </PanelList>
        {/* живые сессии — в «Сейчас», здесь — новая и завершённые, группами по пространству */}
        {sessions && (
          <PanelList
            hidden={state.panel !== 'sessions'}
            title={t('Сессии')}
            extra={
              <div className={styles.sideActions}>
                <SessionSectionActions sessions={ended} />
                <Link to="/sessions" className="btn small" title={t('Новая сессия Claude Code в терминале, в пространстве и с тегами знаний')}>{t('Новая')}</Link>
              </div>
            }
          >
            {ended.length ? <SessionList sessions={ended} /> : <p className={`muted ${styles.sideEmpty}`}>{t('Завершённых сессий нет. Идущие — в «Сейчас».')}</p>}
          </PanelList>
        )}
      </div>
    </aside>
  );
}

/** Список панели: заголовок с кнопками и тело на всю оставшуюся высоту — сворачивать нечего, он один. */
function PanelList({ title, hidden, extra, children }: { title: string; hidden: boolean; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className={`${styles.sideSection} ${styles.panelList}`} aria-label={title} hidden={hidden}>
      <div className={styles.sideHead}>
        <h2 className={styles.panelTitle}>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}
