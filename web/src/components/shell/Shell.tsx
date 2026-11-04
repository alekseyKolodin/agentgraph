// Оболочка: сайдбар и область экрана. Без /api/config интерфейс не стартует, как и старый (ui/app.js init): пока он
// грузится дольше 300 мс — «Загружаю…», не ответил — экран «AgentGraph не отвечает» с «Повторить».
// Здесь же — общий поток событий, заголовок вкладки (число вопросов, имя открытого запуска), окно файла, диалог
// несохранённой правки артефакта перед «Возобновить» и клик по путям к файлам: они нужны на любом экране.
// Первой стоит скрытая до фокуса ссылка «К содержимому». На узком экране (≤ 800 px) сверху — полоса с «Меню», брендом и
// счётчиком вопросов, `main` идёт первым, а сайдбар выдвигается поверх и закрывается переходом, Esc, × или кликом мимо;
// пока он открыт, остальное inert. У main и сайдбара нет постоянного tabindex: с ним клик по тексту экрана уводил бы
// фокус с body, а Esc конструктора (screens/flow/Builder.tsx) смотрит именно на body.
import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { errorText, useConfig, useHome } from '../../api';
import { docTitle, inboxCount } from '../../lib/home';
import { t } from '../../lib/i18n';
import { FileDialog } from '../file/FileDialog';
import { PathLinks } from '../PathLink';
import { DraftsDialog } from '../../screens/run/DraftsDialog';
import { useDocRunTitle } from './docTitle';
import { Sidebar } from './Sidebar';
import { useHomeEvents } from './useHomeEvents';
import styles from './Shell.module.css';

/** Пауза перед «Загружаю…»: быстрый ответ не мигает надписью. */
const LOADING_DELAY_MS = 300;
/** Ширина, на которой сайдбар выдвижной: как @media в Shell.module.css. */
const NARROW = '(max-width: 800px)';

/**
 * Фокус на элемент без своего tabindex (main): tabindex ставится на время фокуса и снимается при уходе или при первом
 * же нажатии мыши — клик по тексту внутри должен отдать фокус body, а не оставить его на main. Не взял фокус (inert) —
 * снимается сразу.
 */
function focusOnce(el: HTMLElement | null): void {
  if (!el) return;
  if (el.hasAttribute('tabindex')) {
    el.focus();
    return;
  }
  el.setAttribute('tabindex', '-1');
  el.focus();
  if (document.activeElement !== el) {
    el.removeAttribute('tabindex');
    return;
  }
  const drop = () => {
    el.removeAttribute('tabindex');
    el.removeEventListener('blur', drop);
    document.removeEventListener('pointerdown', drop, true);
  };
  el.addEventListener('blur', drop);
  document.addEventListener('pointerdown', drop, true);
}

export function Shell() {
  const config = useConfig();
  // повтор после ошибки React Query начинает с чистого листа (error: null, pending): карточка «не отвечает» остаётся с
  // «Проверяю…» на кнопке, а не сменяется пустым экраном и «Загружаю…»
  const [lastError, setLastError] = useState('');
  useEffect(() => {
    if (config.error) setLastError(errorText(config.error));
    else if (config.data) setLastError('');
  }, [config.error, config.data]);
  const error = config.error ? errorText(config.error) : lastError;
  const slow = useDelayed(!config.data && !error, LOADING_DELAY_MS);
  if (error && !config.data) return <Offline error={error} busy={config.isFetching} retry={() => void config.refetch()} />;
  if (!config.data) return slow ? <div className={styles.boot}><p className={styles.bootNote} role="status">{t('Загружаю…')}</p></div> : null;
  return <Ready />;
}

/** true, если on держится дольше ms. */
function useDelayed(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!on) {
      setLate(false);
      return;
    }
    const id = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(id);
  }, [on, ms]);
  return on && late;
}

/** Сервер не ответил на /api/config: без него интерфейсу нечего показать. */
function Offline({ error, busy, retry }: { error: string; busy: boolean; retry: () => void }) {
  return (
    <div className={styles.boot}>
      <div className={styles.bootCard} role="alert">
        <h1>{t('AgentGraph не отвечает')}</h1>
        <p>{t('Сервер не запущен или перезапускается. Подожди несколько секунд и нажми «Повторить»; не помогло — запусти его заново (npm run ui или приложение AgentGraph).')}</p>
        <p className={styles.bootError}>{error}</p>
        <button type="button" className="btn primary" disabled={busy} onClick={retry}>{busy ? t('Проверяю…') : t('Повторить')}</button>
      </div>
    </div>
  );
}

function Ready() {
  useHomeEvents();
  const questions = inboxCount(useHome().data?.runs ?? []);
  const run = useDocRunTitle();
  useEffect(() => {
    document.title = docTitle(questions, run);
  }, [questions, run]);

  const main = useRef<HTMLElement>(null);
  const side = useRef<HTMLElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const [navOpen, setNavOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = navOpen;
  /** Куда вернуть фокус, когда сайдбар закроется: inert снимается только после перерисовки. */
  const focusAfter = useRef<'menu' | 'main' | null>(null);
  const close = (to: 'menu' | 'main') => {
    focusAfter.current = to;
    setNavOpen(false);
  };
  // выдвижной сайдбар закрывается переходом (и на тот же адрес): человек выбрал, куда идти, — смотрит на main
  const { key } = useLocation();
  useEffect(() => {
    if (openRef.current) close('main');
  }, [key]);
  // окно стало шире — сайдбар снова на месте, выдвинутым (и inert вокруг) ему не быть
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const onChange = () => {
      if (!mq.matches) setNavOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    if (!navOpen) {
      const to = focusAfter.current;
      focusAfter.current = null;
      if (to === 'menu') menu.current?.focus();
      else if (to === 'main') focusOnce(main.current);
      return;
    }
    // фокус — в сайдбар (диктор объявит его), Esc закрывает и возвращает фокус на «Меню»
    side.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Esc открытого диалога (подтверждение, обновление) — его, а не сайдбара
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
      close('menu');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div className={[styles.app, navOpen ? styles.navOpen : ''].filter(Boolean).join(' ')}>
      <a
        href="#main"
        className={styles.skip}
        onClick={(e) => {
          e.preventDefault();
          focusOnce(main.current);
        }}
      >
        {t('К содержимому')}
      </a>
      <header className={styles.topbar} inert={navOpen}>
        <button
          ref={menu}
          type="button"
          className={`btn small ${styles.menuBtn}`}
          aria-expanded={navOpen}
          aria-controls="sidebar"
          title={t('Разделы, flow, запуски и сессии')}
          onClick={() => setNavOpen((v) => !v)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>
          {t('Меню')}
        </button>
        <Link to="/" className={styles.topBrand}>AgentGraph</Link>
        {questions > 0 && (
          <Link to="/" className={styles.topCount} title={t('Вопросов ждут ответа')} aria-label={t('Вопросов ждут ответа: {n}', { n: questions })}>
            {questions}
          </Link>
        )}
      </header>
      <Sidebar id="sidebar" ref={side} className={styles.side} drawerOpen={navOpen} onClose={() => close('menu')} />
      {navOpen && <div className={styles.scrim} aria-hidden="true" onClick={() => close('menu')} />}
      <main id="main" ref={main} className={styles.main} inert={navOpen}>
        <Outlet />
      </main>
      <FileDialog />
      <DraftsDialog />
      <PathLinks />
    </div>
  );
}
