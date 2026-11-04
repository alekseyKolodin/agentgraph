// Выбор пространства — один компонент для формы запуска, формы сессии и экрана сессии (.interface-design/system.md →
// Space picker): поле показывает выбранное (заголовок и слаг), фокус или клик открывают список под ним — свежие сверху,
// поиск по слагу, заголовку и началу состояния, «+ новое пространство» для вписанного слага и «без пространства».
// Клавиатура: ↑ ↓, Enter, Esc (закрыть и вернуть выбор), Tab. ARIA — combobox со listbox и aria-activedescendant.
// Без выбранного пространства открытый список ничего не подсвечивает до первой стрелки: Enter «для подтверждения» не
// выберет чужое пространство. Enter в закрытом поле формы не отправляет её — это выбор, а не ввод.
// Под полем (кроме compact) — строка: что даст выбранное пространство или ошибка слага.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { SpaceListItem } from '@server/api-types';
import { feedTime } from '../lib/format';
import { t } from '../lib/i18n';
import { pickerRows, spaceFieldNote, spaceLabel, type PickerRow } from '../lib/spaces';
import styles from './SpacePicker.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
/** Ключ строки: служебные строки не совпадут с пространством со слагом «none» или «new». */
const rowKey = (r: PickerRow) => (r.kind === 'space' ? `s:${r.s.slug}` : `:${r.kind}`);

type Props = {
  /** База id поля и списка: уникальная на странице. */
  id: string;
  /** Слаг или '' — без пространства. */
  value: string;
  onChange: (slug: string) => void;
  options: SpaceListItem[];
  /** Список пространств ещё грузится: «новое пространство» под полем не показываем, пока не ясно, есть ли такое. */
  loading?: boolean;
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

export function SpacePicker({ id, value, onChange, options, loading, label = t('Пространство'), labelTitle, compact, placeholder, className, inputClassName, autoFocus, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const rows = useMemo(() => pickerRows(query, options), [query, options]);
  const chosen = options.find((o) => o.slug === value);
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;

  // активная строка — в видимой части списка (↑ ↓ по длинному списку)
  useEffect(() => {
    if (open) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const show = () => {
    if (open) return;
    const all = pickerRows('', options);
    setQuery('');
    setActive(value ? Math.max(0, all.findIndex((r) => r.kind === 'space' && r.s.slug === value)) : -1);
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
      setActive((i) => (i < 0 ? (step > 0 ? 0 : rows.length - 1) : (i + step + rows.length) % rows.length));
    } else if (e.key === 'Enter') {
      if (!open) {
        if (!compact) e.preventDefault();
        return;
      }
      e.preventDefault();
      if (active < 0) return close();
      pick(rows[active]);
    } else if (e.key === 'Escape') {
      if (!open && !compact) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      onDone?.();
    }
  };
  const note = compact ? null : loading && value && !chosen ? { text: '', tone: '' as const } : spaceFieldNote(value, options);
  const shown = open ? query : chosen ? spaceLabel(chosen) : value;
  // пока список открыт и запрос пуст, в поле видно выбранное — плейсхолдером, а не «без пространства»
  const hint = open && chosen ? spaceLabel(chosen) : placeholder ?? t('без пространства — выбери или впиши новый слаг');

  return (
    <div className={cx(styles.picker, compact && styles.compact, className)}>
      {!compact && (
        <label htmlFor={`${id}-input`} className={styles.label}>
          <span title={labelTitle ?? t('Фича или проект: карта (CLAUDE.md) придёт памятью, как CLAUDE.md репозитория; документы — по запросу; состояние «где мы сейчас» — в контексте. После работы состояние перепишет короткая сессия')}>{label}</span>
        </label>
      )}
      <div className={styles.box}>
        <input
          id={`${id}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 && rows[active] ? optId(active) : undefined}
          aria-label={compact ? label : undefined}
          className={cx(styles.input, chosen && !open && styles.withSlug, inputClassName)}
          placeholder={hint}
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
            // вписанный слаг не пропадает молча: уход из поля в форме выбирает существующее с таким слагом, а новое — только
            // если совпадений нет (иначе это был поиск). На экране сессии — нет: там выбор сразу меняет пространство сессии
            const typed = query.trim();
            if (open && !compact && typed) {
              const exact = options.find((o) => o.slug === typed);
              const fresh = rows.find((r) => r.kind === 'new');
              if (exact && exact.slug !== value) onChange(exact.slug);
              else if (!exact && fresh && !rows.some((r) => r.kind === 'space')) onChange(typed);
            }
            close();
            if (compact) onDone?.();
          }}
        />
        {chosen && !open && chosen.title && <span className={styles.slug} aria-hidden="true">{chosen.slug}</span>}
        {open && (
          // mousedown по самому списку (полоса прокрутки, отступы) не уводит фокус из поля и не закрывает список
          <ul ref={list} id={listId} role="listbox" className={styles.list} aria-label={t('Пространства')} onMouseDown={(e) => e.preventDefault()}>
            {rows.map((r, i) => (
              <li
                key={rowKey(r)}
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
