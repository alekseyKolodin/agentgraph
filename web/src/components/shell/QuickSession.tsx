// Быстрая сессия: «+» на рельсе и ⌘N (Ctrl+N не на Mac; в браузере это сочетание занято самим браузером). Окно со списком наборов —
// пространство с его папками и тегами знаний или просто папка (lib/quick-session.ts): Enter или клик — терминал открыт,
// ★ — закрепить набор наверху (agentgraph.sessionPins), «Настроить…» — полная форма на странице «Сессии» с этим набором.
// Пространство без папки открывает форму: ей нужна папка.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { errorText, keys, useConfig, useFeature, useRecentDirs, useSpaces } from '../../api';
import { createSession, sessionKeys, useSessions } from '../../api/sessions';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import { quickMeta, quickRows, togglePin, type QuickRow } from '../../lib/quick-session';
import { LS } from '../../lib/storage';
import styles from './QuickSession.module.css';

const PINS_KEY = 'agentgraph.sessionPins';
/** Папка последней сессии — та же, что запоминает форма «Новая сессия». */
const CWD_KEY = 'agentgraph.sessionCwd';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

let opener: (() => void) | null = null;
/** Открыть окно быстрой сессии (значок на рельсе). */
export const openQuickSession = () => opener?.();

/** Путь из поиска «~/…» — от домашней папки: сервер тильду не раскрывает. */
const expandHome = (p: string, home: string | undefined) => (p.startsWith('~/') && home ? home + p.slice(1) : p);

/** Строка «настроить»: полная форма с этим набором. */
const formUrl = (r: QuickRow | undefined, home: string | undefined) => {
  const q = new URLSearchParams({ new: '1' });
  if (r?.space) q.set('space', r.space);
  if (r?.cwd) q.set('cwd', expandHome(r.cwd, home));
  return `/sessions?${q}`;
};

/** На macOS Ctrl+N в полях ввода — «строка вниз»: там окно открывает только ⌘N. */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

export function QuickSession() {
  const on = useFeature('sessions');
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!on) return;
    opener = () => setOpen(true);
    // ⌘N / Ctrl+N: в приложении меню его не занимает; в браузере он до страницы не доходит
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'n' || !(MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.shiftKey || e.altKey || e.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      opener = null;
      document.removeEventListener('keydown', onKey);
    };
  }, [on]);
  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal();
  }, [open]);
  if (!on) return null;
  return (
    <dialog
      ref={dialog}
      className={styles.quick}
      aria-label={t('Новая сессия')}
      onClose={() => setOpen(false)}
      // клик по затемнению мимо окна закрывает его
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      {open && <QuickBody close={() => dialog.current?.close()} />}
    </dialog>
  );
}

function QuickBody({ close }: { close: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const home = useConfig().data?.home;
  const spacesOn = useFeature('spaces');
  const spaces = useSpaces(spacesOn).data?.spaces ?? [];
  const list = useSessions(true).data;
  const recent = useRecentDirs(useFeature('recent-dirs')).data ?? [];
  const [pins, setPins] = useState<string[]>(() => LS.get<string[]>(PINS_KEY, []).filter((x) => typeof x === 'string'));
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const rows = quickRows({ spaces, sessions: list?.sessions ?? [], recent, pins, query });
  const cur = rows[Math.min(active, rows.length - 1)];
  const live = list ? list.sessions.filter((s) => s.live).length : 0;
  const full = list ? live >= list.max : false;
  const tilde = (p: string) => tildePath(p, home);

  const pin = (key: string) => {
    const next = togglePin(pins, key);
    setPins(next);
    LS.set(PINS_KEY, next);
  };
  const toForm = (r?: QuickRow) => {
    close();
    void navigate(formUrl(r, home));
  };
  const go = async (r: QuickRow | undefined) => {
    if (!r || busy) return;
    if (!r.cwd) return toForm(r);
    if (full) return setErr(t('Живых сессий уже {n}: заверши одну из них', { n: list!.max }));
    const cwd = expandHome(r.cwd, home);
    setBusy(r.key);
    setErr('');
    try {
      const s = await createSession({
        cwd,
        ...(r.space ? { space: r.space } : {}),
        tags: r.tags,
        saveState: true,
        // примерный размер терминала по окну: claude перерисуется под него при подключении
        cols: Math.max(80, Math.floor((window.innerWidth - 380) / 8)),
        rows: Math.max(24, Math.floor((window.innerHeight - 190) / 17)),
      });
      LS.setRaw(CWD_KEY, s.cwd);
      qc.setQueryData(sessionKeys.one(s.id), s);
      void qc.invalidateQueries({ queryKey: sessionKeys.list, exact: true });
      void qc.invalidateQueries({ queryKey: keys.spaces });
      close();
      void navigate(`/sessions/${s.id}`);
    } catch (e) {
      setErr(errorText(e));
      setBusy('');
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) setActive((i) => (Math.min(i, rows.length - 1) + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) toForm(cur);
      else void go(cur);
    }
  };

  return (
    <div className={styles.body}>
      <input
        className={styles.search}
        autoFocus
        aria-label={t('Пространство или папка')}
        placeholder={t('пространство, папка или путь…')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      {rows.length ? (
        <ul className={styles.list} aria-label={t('Наборы для сессии')}>
          {rows.map((r, i) => (
            <li key={r.key} className={cx(styles.row, cur?.key === r.key && styles.on)} onMouseEnter={() => setActive(i)}>
              <button type="button" className={styles.open} disabled={Boolean(busy)} title={r.cwd ? t('Открыть терминал: {path}', { path: r.cwd }) : t('Открыть форму: у пространства нет рабочей папки')} onClick={() => void go(r)}>
                <span className={styles.mark} aria-hidden="true">{r.space ? '◇' : '›_'}</span>
                <span className={styles.main}>
                  <span className={styles.title}>{r.title}{r.space && r.title !== r.space && <span className={styles.slug}>{r.space}</span>}</span>
                  <span className={styles.meta}>{busy === r.key ? t('Открываю терминал…') : quickMeta(r, tilde)}</span>
                </span>
              </button>
              {r.from !== 'path' && (
                <button
                  type="button"
                  className={cx(styles.star, r.pinned && styles.pinned)}
                  aria-pressed={r.pinned}
                  aria-label={r.pinned ? t('Открепить «{name}»', { name: r.title }) : t('Закрепить «{name}» наверху', { name: r.title })}
                  title={r.pinned ? t('Открепить') : t('Закрепить наверху')}
                  onClick={() => pin(r.key)}
                >
                  {r.pinned ? '★' : '☆'}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={cx('muted small', styles.none)}>{query.trim() ? t('Ничего не нашлось: впиши путь целиком (/… или ~/…) или открой форму') : t('Наборов ещё нет: открой первую сессию формой')}</p>
      )}
      {err && <p className="msg err">{err}</p>}
      <div className={styles.foot}>
        <span className="muted small">{t('↑↓ — выбор · Enter — открыть · ⌘Enter — настроить')}</span>
        <button type="button" className="btn small ghost" onClick={() => toForm(cur)}>{t('Настроить…')}</button>
      </div>
    </div>
  );
}
