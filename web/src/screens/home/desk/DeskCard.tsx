// Карточка дела (макет DeskPult): вид, метка вещи, проект; заголовок; почему твой ход; что делает агент или сессия;
// срок, возраст в колонке и кто подвинул последним; действия. Перенос — мышью (перетаскивание) и с клавиатуры: ⌥← ⌥→
// на карточке или «Перенести в …» в меню «⋯».
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { RunSummary, SessionView } from '@server/api-types';
import type { DeskColumn, DeskItem } from '@server/desk/types';
import { LIVE_STATUSES } from '../../../lib/home';
import {
  ageLine,
  columnTitle,
  DESK_COLUMNS,
  dueView,
  type DueState,
  itemUrl,
  kindTone,
  movedByText,
  neighborColumn,
  replySignal,
  thingLabel,
} from '../../../lib/desk-board';
import { t } from '../../../lib/i18n';
import styles from './Desk.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

/** Срок: сегодня и скоро — «ждёт», просрочено — сбой, потом — обычный текст. */
const DUE_CLASS: Record<DueState, string | undefined> = { over: styles.dueOver, today: styles.dueToday, soon: styles.dueSoon, later: undefined };

/** Что карточка умеет; нет функции — нет кнопки. */
export type CardActions = {
  /** keyboard — с клавиатуры: фокус пойдёт за карточкой в новую колонку. */
  move: (column: DeskColumn, keyboard: boolean) => void;
  close: (reason: string, keyboard: boolean) => void;
  /** «Начать сессию»: новая сессия по делу. */
  startSession?: () => Promise<void>;
  /** «Продолжить сессию»: живая — открыть, завершённая — продолжить разговор. */
  continueSession?: (s: SessionView) => Promise<void>;
  /** «Запустить flow»: выбор flow у кнопки, вход — из вещи дела. */
  runFlow?: (btn: HTMLElement) => void;
  /** «Привязать вещь»: адрес MR, PR или задачи Jira. */
  link?: (url: string) => Promise<void>;
};

export type CardDrag = { dragging: boolean; start: () => void; end: () => void };

export function DeskCard({ item, n, now, project, sessions, runs, act, drag }: {
  item: DeskItem;
  /** Номер в «В плане». */
  n?: number;
  now: number;
  project?: { title: string; tone: number };
  sessions: SessionView[];
  runs: RunSummary[];
  act: CardActions;
  drag: CardDrag;
}) {
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = item.column === 'done';
  const tone = kindTone(item);
  const label = thingLabel(item);
  const url = itemUrl(item);
  const due = done ? undefined : dueView(item.due, now);
  const reply = done ? undefined : replySignal(item);
  const session = sessions[0];
  const liveRun = runs.find((r) => LIVE_STATUSES.includes(r.status));
  const canLink = !done && !item.thing && item.key.startsWith('own:') && act.link;

  const onKey = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.target !== e.currentTarget) return;
    e.preventDefault();
    const to = neighborColumn(item.column, e.key === 'ArrowLeft' ? -1 : 1);
    if (to) act.move(to, true);
  };
  /** Клик с клавиатуры (Enter, пробел) — detail 0: фокус пойдёт за карточкой; мышью — не трогаем, доска не прыгает. */
  const byKey = (e: { detail: number }) => e.detail === 0;
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn().catch(() => undefined).finally(() => setBusy(false));
  };

  const menu: MenuEntry[] = [
    ...(act.runFlow && !done ? [{ key: 'flow', label: t('Запустить flow…'), data: 'to-flow', onSelect: (btn: HTMLElement) => act.runFlow!(btn) }] : []),
    // у «Нового» на карточке только «В план» и «Не моё» (макет): сессия — из меню
    ...(act.startSession && !done && (session || item.column === 'new') ? [{ key: 'new-session', label: session ? t('Начать новую сессию') : t('Начать сессию'), onSelect: () => run(act.startSession!) }] : []),
    ...(canLink ? [{ key: 'link', label: t('Привязать вещь…'), onSelect: () => setLinking(true) }] : []),
    { sep: 'm' },
    { cap: t('Перенести в') },
    ...DESK_COLUMNS.filter((c) => c !== item.column).map((c) => ({
      key: `to-${c}`,
      label: columnTitle(c),
      hint: c === neighborColumn(item.column, -1) ? '⌥←' : c === neighborColumn(item.column, 1) ? '⌥→' : undefined,
      onSelect: (_btn: HTMLElement, keyboard: boolean) => act.move(c, keyboard),
    })),
    ...(!done ? [{ sep: 'c' }, { key: 'close', label: t('Закрыть'), danger: true, onSelect: (_btn: HTMLElement, keyboard: boolean) => act.close('закрыто вручную', keyboard) }] : []),
  ];

  return (
    <li
      data-desk-key={item.key}
      tabIndex={0}
      aria-label={[item.kind, label, item.title].filter(Boolean).join(' ')}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      title={t('⌥← ⌥→ — в соседнюю колонку')}
      className={cx(styles.card, done && styles.done, drag.dragging && styles.dragging)}
      // поле ссылки внутри карточки: протяжка по тексту — выделение, а не перетаскивание
      draggable={!linking}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-desk-key', item.key);
        drag.start();
      }}
      onDragEnd={drag.end}
      onKeyDown={onKey}
    >
      <div className={styles.top}>
        {n !== undefined && <span className={styles.no} title={t('Очередь «Начни с этого»')}>{n}</span>}
        <span className={cx(styles.kind, styles[tone])} title={item.kind}>{item.kind}</span>
        {label && <span className={styles.id} title={label}>{label}</span>}
        <span className={styles.grow} />
        {project && (
          <span className={styles.project} title={project.title} style={{ ['--pc' as string]: `var(--cat-${project.tone})` }}>
            <span className={styles.sq} aria-hidden="true" />
            <span>{project.title}</span>
          </span>
        )}
      </div>
      {url ? (
        <a className={styles.title} href={url} target="_blank" rel="noreferrer" draggable={false}>{item.title}</a>
      ) : (
        <span className={styles.title}>{item.title}</span>
      )}
      {item.why && <div className={cx(styles.why, item.column === 'work' && liveRun && styles.live)}>{item.why}</div>}
      <Activity run={liveRun} session={session?.live ? session : undefined} />
      <div className={styles.meta}>
        {due && <span className={DUE_CLASS[due.state]} title={due.title}>{due.text}</span>}
        <span title={new Date(done && item.closed ? item.closed.at : item.movedAt).toLocaleString()}>{ageLine(item, now)}</span>
        {done && item.closed ? <span className={styles.by}>{item.closed.reason}</span> : <span className={styles.by}>{movedByText(item)}</span>}
      </div>
      {linking && act.link ? (
        <LinkForm onCancel={() => setLinking(false)} onLink={act.link} />
      ) : (
        <div className={styles.acts}>
          {item.column === 'new' && (
            <>
              <button type="button" className="btn small" onClick={(e) => act.move('plan', byKey(e))}>{t('В план')}</button>
              <button type="button" className="btn small ghost" title={t('Закрыть дело: оно не твоё')} onClick={(e) => act.close('не моё', byKey(e))}>{t('Не моё')}</button>
            </>
          )}
          {done && <button type="button" className="btn small ghost" onClick={(e) => act.move('plan', byKey(e))}>{t('Вернуть в план')}</button>}
          {!done && session && act.continueSession && (
            <button type="button" className="btn small" disabled={busy} title={session.name} onClick={() => run(() => act.continueSession!(session))}>
              {busy ? t('Открываю…') : session.live ? t('Открыть сессию') : t('Продолжить сессию')}
            </button>
          )}
          {!done && !session && item.column !== 'new' && act.startSession && (
            <button type="button" className="btn small" disabled={busy} title={t('Сессия Claude по этому делу: оно перейдёт в «В работе»')} onClick={() => run(act.startSession!)}>
              {busy ? t('Открываю…') : t('Начать сессию')}
            </button>
          )}
          {reply && (
            <a className="btn small ghost" href={reply.link} target="_blank" rel="noreferrer" draggable={false} title={t('Открыть разговор, где спросили: {who}', { who: reply.author || reply.source })}>{t('Ответить')}</a>
          )}
          <CardMenu label={t('Ещё действия: {title}', { title: item.title })} items={menu} />
        </div>
      )}
    </li>
  );
}

/** Что идёт по делу прямо сейчас: запуск flow (и ждёт ли он тебя) или открытая сессия. */
function Activity({ run, session }: { run?: RunSummary; session?: SessionView }) {
  if (run) {
    const wait = run.status === 'waiting' || run.status === 'paused';
    return (
      <div className={cx(styles.agent, wait ? styles.wait : styles.live)}>
        <b>{wait ? t('Запуск ждёт тебя:') : t('Агент работает:')}</b>
        <Link to={`/run/${encodeURIComponent(run.id)}`} draggable={false} title={run.title || run.flow}>{run.title || run.flow}</Link>
      </div>
    );
  }
  if (session) {
    return (
      <div className={cx(styles.agent, session.waitingSince ? styles.wait : undefined)}>
        <b>{session.waitingSince ? t('Сессия ждёт тебя:') : t('Сессия открыта:')}</b>
        <Link to={`/sessions/${encodeURIComponent(session.id)}`} draggable={false} title={session.name}>{session.name}</Link>
      </div>
    );
  }
  return null;
}

function LinkForm({ onLink, onCancel }: { onLink: (url: string) => Promise<void>; onCancel: () => void }) {
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = () => {
    if (!url.trim()) return;
    setBusy(true);
    setErr('');
    onLink(url.trim())
      .then(onCancel)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className={styles.linkForm}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onCancel();
      }}
    >
      <input ref={input} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('Ссылка на MR, PR или задачу Jira')} aria-label={t('Ссылка на MR, PR или задачу Jira')} spellCheck={false} />
      {err && <span className={styles.linkErr} role="alert">{err}</span>}
      <div className={styles.linkRow}>
        <button type="submit" className="btn small" disabled={busy || !url.trim()}>{busy ? t('Привязываю…') : t('Привязать')}</button>
        <button type="button" className="btn small ghost" onClick={onCancel}>{t('Отмена')}</button>
      </div>
    </form>
  );
}

type MenuEntry =
  | { key: string; label: string; hint?: string; danger?: boolean; data?: string; onSelect: (btn: HTMLElement, keyboard: boolean) => void }
  | { sep: string }
  | { cap: string };

/**
 * Меню «⋯» (как MenuButton экранов Teamwork): клик, Enter или ↓ открывают; стрелки, Home и End ходят; Esc, клик мимо,
 * уход фокуса (Tab) и прокрутка закрывают.
 */
function CardMenu({ label, items }: { label: string; items: MenuEntry[] }): ReactNode {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // меню — position: fixed у кнопки: прокрутка доски вбок (overflow) иначе обрезает его у края колонки. Не влезает
  // вниз — вверх; прокрутка страницы или доски закрывает его
  useLayoutEffect(() => {
    const el = menu.current;
    const b = btn.current;
    if (!open || !el || !b) return;
    const r = b.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    el.style.top = `${r.bottom + 4 + h > window.innerHeight - 8 && r.top - 4 - h > 8 ? r.top - 4 - h : r.bottom + 4}px`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const scrolled = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('scroll', scrolled, true);
    menu.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('scroll', scrolled, true);
    };
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    // стрелки и ⌥-стрелки в открытом меню — только меню: карточку они не двигают
    if (e.key.startsWith('Arrow') || e.key === 'Escape') e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      btn.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const all = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
    all[to]?.focus();
  };
  return (
    <div
      className={styles.mw}
      ref={wrap}
      onKeyDown={open ? onKey : undefined}
      onBlur={(e) => {
        // Tab из меню — меню закрыто (фокус ушёл за пределы кнопки и пунктов)
        if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={btn}
        type="button"
        className="btn small ghost"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        ⋯
      </button>
      {open && (
        <div ref={menu} className={styles.menu} role="menu" aria-label={label}>
          {items.map((it, i) => {
            if ('sep' in it) return <div key={`s${i}`} className={styles.menuSep} role="separator" />;
            if ('cap' in it) return <div key={`c${i}`} className={styles.menuCap} role="presentation">{it.cap}</div>;
            return (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className={cx(styles.mi, it.danger && styles.danger)}
                {...(it.data === 'to-flow' ? { 'data-to-flow': '' } : {})}
                onClick={(e) => {
                  const keyboard = e.detail === 0;
                  setOpen(false);
                  // фокус — на «⋯» до действия: перенос с клавиатуры потом уведёт его за карточкой
                  if (it.data !== 'to-flow') btn.current?.focus();
                  // выбор flow встаёт у кнопки «⋯», а не у пункта, который сейчас исчезнет
                  it.onSelect(btn.current ?? document.body, keyboard);
                }}
              >
                <span>{it.label}</span>
                {it.hint && <span className={styles.miK}>{it.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
