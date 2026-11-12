// Мелочи экранов задач: меню у кнопки (клавиатура: стрелки, Esc, фокус обратно на кнопку), ссылка на панель задачи
// (?task=ID поверх текущей вкладки), исполнитель по email, подпись статуса названием колонки команды.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import type { TeamColumns, TeamMember, TeamTaskStatus } from '@server/api-types';
import { columnName } from '../../../lib/teamwork/board';
import { cx, Who } from '../parts';
import { TASK_PARAM } from '../shell';
import styles from './Tasks.module.css';

export type MenuEntry =
  | { key: string; label: string; small?: string; hint?: string; danger?: boolean; disabled?: boolean; title?: string; onSelect: () => void }
  | { sep: string }
  | { cap: string }
  | { note: string };

/**
 * Кнопка с выпадающим меню: открывается кликом, Enter или ↓; стрелки ходят по пунктам, Esc и клик мимо закрывают, фокус
 * возвращается на кнопку. Пункт выбран — меню закрыто до его действия (действие может перерисовать список).
 */
export function MenuButton({ label, text, items, className, right, up, onOpen, title }: {
  label: string; text: ReactNode; items: MenuEntry[] | (() => MenuEntry[]); className?: string; right?: boolean; up?: boolean; onOpen?: (open: boolean) => void; title?: string;
}) {
  const [open, setOpenState] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpen?.(v);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    menu.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const list = open ? (typeof items === 'function' ? items() : items) : [];
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // панель задачи тоже ловит Esc — меню закрывается первым
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
      return;
    }
    // стрелки (и с ⌥) в открытом меню — только меню: до карточки или строки они не доходят и её не двигают
    if (e.key.startsWith('Arrow')) e.stopPropagation();
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
  };
  return (
    <div className={styles.mw} ref={wrap} onKeyDown={open ? onKey : undefined}>
      <button
        ref={btn}
        type="button"
        className={className ?? 'btn ghost small'}
        aria-label={label}
        title={title ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {text}
      </button>
      {open && (
        <div ref={menu} className={cx(styles.menu, right && styles.right, up && styles.up)} role="menu" aria-label={label}>
          {list.map((it, i) => {
            if ('sep' in it) return <div key={`s${i}`} className={styles.menuSep} role="separator" />;
            if ('cap' in it) return <div key={`c${i}`} className={styles.menuCap}>{it.cap}</div>;
            if ('note' in it) return <div key={`n${i}`} className={styles.menuHint}>{it.note}</div>;
            return (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                className={cx(styles.mi, it.danger && styles.danger)}
                disabled={it.disabled}
                title={it.title}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  btn.current?.focus();
                  it.onSelect();
                }}
              >
                <span className={styles.miRow}><b>{it.label}</b>{it.hint && <span className={styles.k}>{it.hint}</span>}</span>
                {it.small && <small>{it.small}</small>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Адрес панели задачи поверх текущей вкладки: остальные параметры адреса остаются. */
export function useTaskHref(): (id: string) => string {
  const loc = useLocation();
  return (id: string) => {
    const s = new URLSearchParams(loc.search);
    s.set(TASK_PARAM, id);
    return `${loc.pathname}?${s.toString()}`;
  };
}

/** Кружок исполнителя по email: участник команды — с именем, чужой email — две буквы. */
export function Assignee({ email, members, className }: { email?: string; members: readonly TeamMember[]; className?: string }) {
  const m = email ? members.find((x) => x.email === email) : undefined;
  return <Who member={m} email={email} className={className} />;
}

/** Статус названием колонки команды (teamwork.yaml → columns), без названий — словами по умолчанию. */
export const columnText = (s: TeamTaskStatus, columns?: Partial<TeamColumns>): string => columnName(s, columns);

/** Имя участника коротко: имя, без имени — email. */
export const memberName = (email: string | undefined, members: readonly TeamMember[]): string => {
  if (!email) return '';
  const m = members.find((x) => x.email === email);
  return m?.name || email;
};
