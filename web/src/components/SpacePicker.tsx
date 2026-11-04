// Выбор пространства — один компонент для формы запуска, формы сессии и экрана сессии (.interface-design/system.md →
// Space picker): поле показывает выбранное (заголовок и слаг), фокус или клик открывают список под ним — свежие сверху,
// поиск по слагу, заголовку и началу состояния, внизу «без пространства» и «+ новое пространство» для вписанного слага.
// Клавиатура: ↑ ↓, Enter, Esc (закрыть и вернуть выбор), Tab. ARIA — combobox со listbox и aria-activedescendant.
// Под полем (кроме compact) — строка: что даст выбранное пространство или ошибка слага.
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { SpaceListItem } from '@server/api-types';
import { feedTime } from '../lib/format';
import { t } from '../lib/i18n';
import { pickerRows, spaceFieldNote, spaceLabel, type PickerRow, type SpaceWork } from '../lib/spaces';
import styles from './SpacePicker.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

type Props = {
  /** База id поля и списка: уникальная на странице. */
  id: string;
  /** Слаг или '' — без пространства. */
  value: string;
  onChange: (slug: string) => void;
  options: SpaceListItem[];
  /** Последняя работа в пространствах (lastWork): порядок «свежие сверху» и время в строке. */
  work: Map<string, SpaceWork>;
  label?: string;
  labelTitle?: string;
  /** Без подписи и строки под полем — в строке контекста экрана сессии. */
  compact?: boolean;
  placeholder?: string;
  className?: string;
  /** Класс самого поля: на экране сессии — как у «+ тег». */
  inputClassName?: string;
  autoFocus?: boolean;
  /** compact: выбор сделан или отменён (Esc, уход фокуса) — строка возвращается к чипу. */
  onDone?: () => void;
};

export function SpacePicker({ id, value, onChange, options, work, label = t('Пространство'), labelTitle, compact, placeholder, className, inputClassName, autoFocus, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => pickerRows(query, options, work), [query, options, work]);
  const chosen = options.find((o) => o.slug === value);
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;

  const show = () => {
    if (open) return;
    setQuery('');
    setActive(Math.max(0, value ? rows.findIndex((r) => r.kind === 'space' && r.s.slug === value) : 0));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (r: PickerRow | undefined) => {
    if (!r) return;
    onChange(r.kind === 'space' ? r.s.slug : r.kind === 'new' ? r.slug : '');
    close();
    onDone?.();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return show();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      pick(rows[active]);
    } else if (e.key === 'Escape') {
      if (!open && !compact) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      onDone?.();
    }
  };
  const note = compact ? null : spaceFieldNote(value, options);
  const shown = open ? query : chosen ? spaceLabel(chosen) : value;

  return (
    <div className={cx(styles.picker, compact && styles.compact, className)}>
      {!compact && (
        <label htmlFor={`${id}-input`} className={styles.label}>
          <span title={labelTitle ?? t('Фича или проект: карта (CLAUDE.md) придёт памятью, как CLAUDE.md репозитория; документы — по запросу; состояние «где мы сейчас» — в контексте. После работы состояние перепишет короткая сессия')}>{label}</span>
        </label>
      )}
      <div className={styles.box}>
        <input
          ref={input}
          id={`${id}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && rows[active] ? optId(active) : undefined}
          aria-label={compact ? label : undefined}
          className={cx(styles.input, chosen && !open && styles.withSlug, inputClassName)}
          placeholder={placeholder ?? t('без пространства — выбери или впиши новый слаг')}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={shown}
          onFocus={show}
          onClick={show}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            if (!open) setOpen(true);
          }}
          onKeyDown={onKey}
          onBlur={() => {
            close();
            if (compact) onDone?.();
          }}
        />
        {chosen && !open && chosen.title && <span className={styles.slug} aria-hidden="true">{chosen.slug}</span>}
        {open && (
          <ul id={listId} role="listbox" className={styles.list} aria-label={t('Пространства')}>
            {rows.map((r, i) => (
              <li
                key={r.kind === 'space' ? r.s.slug : r.kind}
                id={optId(i)}
                role="option"
                aria-selected={i === active}
                className={cx(styles.opt, i === active && styles.active, r.kind !== 'space' && styles.extra)}
                // mousedown, а не click: иначе поле потеряло бы фокус и закрыло список раньше выбора
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {r.kind === 'space' ? (
                  <>
                    <span className={styles.title}>{spaceLabel(r.s)}</span>
                    <span className={styles.meta}>{[r.s.title ? r.s.slug : '', r.at ? feedTime(r.at) : ''].filter(Boolean).join(' · ')}</span>
                  </>
                ) : r.kind === 'none' ? (
                  <span className={styles.title}>{t('Без пространства')}</span>
                ) : (
                  <span className={styles.title}>{t('+ Новое пространство «{slug}»', { slug: r.slug })}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {note && <span className={note.tone ? 'msg err small' : 'muted small'}>{note.text}</span>}
    </div>
  );
}
