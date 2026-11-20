// Выбор из списка вместо нативного select (Controls.dc.html → «Выбор из списка»): кнопка 32 px со значением и стрелкой,
// по клику — поповер с поиском и listbox. Клавиатура: ↓/Enter/Пробел на кнопке открывают, ↑ ↓ ходят (выключенные
// пропускаются), Enter (и Пробел в списке без поиска) выбирает, буквы в списке без поиска прыгают к строке на них, Esc
// закрывает и возвращает фокус на кнопку. Tab уводит фокус дальше: в footer поповер остаётся открытым, наружу — закрывается;
// клик снаружи тоже закрывает. Приёмы — как у SpacePicker: mousedown по списку не уводит фокус из поиска, активная
// строка — aria-activedescendant.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { filterOptions, stepActive, typeahead, type SelectOption } from '../../lib/form';
import { ctlClass, cx, useFieldCtx, type Tone } from './Field';
import styles from './Form.module.css';

export type { SelectOption };

export type SelectProps<V extends string> = {
  /** Выбранное значение; '' — ничего не выбрано (видно placeholder). */
  value: V | '';
  options: SelectOption<V>[];
  onChange: (value: V) => void;
  /** Текст пустой кнопки. */
  placeholder?: string;
  /** Поле поиска в поповере; по умолчанию — когда вариантов больше 7. */
  searchable?: boolean;
  /** Значение на кнопке моноширинным (имя flow, путь). Строки списка — шрифтом интерфейса. */
  mono?: boolean;
  /** Своя отрисовка значения на кнопке; по умолчанию — label выбранного варианта (или само value, если варианта нет). */
  renderValue?: (o: SelectOption<V> | undefined) => ReactNode;
  /** Нижняя строка поповера: «+ Новый flow» и т. п. */
  footer?: ReactNode;
  tone?: Tone;
  disabled?: boolean;
  id?: string;
  /** Подпись для чтения с экрана, когда Select не внутри Field. */
  'aria-label'?: string;
  title?: string;
  className?: string;
};

export function Select<V extends string>({ value, options, onChange, placeholder, searchable, mono, renderValue, footer, tone, disabled, id, 'aria-label': ariaLabel, title, className }: SelectProps<V>) {
  const f = useFieldCtx({ id, tone, disabled });
  const base = useId().replace(/[^\w-]/g, '');
  const listId = `${base}-list`;
  const optId = (i: number) => `${base}-o${i}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  /** Набранные первые буквы и когда набор сбросится. */
  const typed = useRef<{ text: string; timer?: ReturnType<typeof setTimeout> }>({ text: '' });
  const withSearch = searchable ?? options.length > 7;
  const rows = useMemo(() => filterOptions(options, withSearch ? query : ''), [options, query, withSearch]);
  const chosen = options.find((o) => o.value === value);
  // по содержимому, а не по ссылке: родитель может собирать массив на каждой отрисовке
  const optionsKey = options.map((o) => `${o.value}${o.disabled ? '!' : ''}`).join('\n');

  const show = () => {
    if (f.disabled) return;
    setQuery('');
    // выбранное подсвечено сразу; ничего не выбрано — ничего не подсвечено до первой стрелки
    setActive(options.findIndex((o) => o.value === value && !o.disabled));
    setOpen(true);
  };
  const close = (focusBack: boolean) => {
    setOpen(false);
    setQuery('');
    if (focusBack) trigger.current?.focus();
  };
  const pick = (o: SelectOption<V> | undefined) => {
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close(true);
  };

  // открытый поповер: фокус в поиск (или в список), клик снаружи закрывает
  useEffect(() => {
    if (!open) return;
    (withSearch ? search.current : list.current)?.focus();
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && active >= 0) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
  }, [open, active]); // eslint-disable-line react-hooks/exhaustive-deps
  // варианты сменились при открытом поповере: старый номер активной строки указывал бы на другую — снова на выбранное
  useEffect(() => {
    if (open) setActive(rows.findIndex((o) => o.value === value && !o.disabled));
  }, [optionsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => clearTimeout(typed.current.timer), []);

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => stepActive(rows, i, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      if (withSearch) return; // в поиске Home/End двигают курсор
      e.preventDefault();
      setActive(stepActive(rows, -1, e.key === 'Home' ? 1 : -1));
    } else if (e.key === 'Enter' || (e.key === ' ' && !withSearch && !typed.current.text)) {
      // Пробел в поиске — буква запроса; в списке без поиска — выбор (если не идёт набор первых букв)
      e.preventDefault();
      if (active < 0) return close(true);
      pick(rows[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (!withSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const tp = typed.current;
      clearTimeout(tp.timer);
      tp.text += e.key;
      tp.timer = setTimeout(() => (tp.text = ''), 600);
      const i = typeahead(rows, active, tp.text);
      if (i >= 0) setActive(i);
    }
  };
  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show();
    }
  };

  const activeId = open && active >= 0 && rows[active] ? optId(active) : undefined;
  return (
    <div ref={root} className={cx(styles.select, className)}>
      <button
        ref={trigger}
        type="button"
        id={f.id}
        className={cx(ctlClass({ tone: f.tone, mono }), styles.trigger)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={ariaLabel ? undefined : f.labelId ? `${f.labelId} ${f.id}` : undefined}
        aria-label={ariaLabel ? `${ariaLabel}: ${chosen?.label ?? (value || placeholder || '')}` : undefined}
        aria-describedby={f.describedBy}
        disabled={f.disabled}
        title={title}
        // открытый: mousedown не уводит фокус из поповера — иначе его onBlur закрыл бы поповер, а click открыл снова
        onMouseDown={(e) => {
          if (open) e.preventDefault();
        }}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={onTriggerKey}
      >
        <span className={cx(styles.value, !chosen && !value && styles.placeholder)}>{renderValue ? renderValue(chosen) : (chosen?.label ?? (value || placeholder || t('Выбери')))}</span>
        <svg className={styles.chev} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" fill="none" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        <div
          ref={pop}
          className={styles.pop}
          // фокус ушёл из поповера (Tab мимо footer, Shift+Tab на кнопку) — закрыть; в footer — остаётся открытым
          onBlur={(e) => {
            if (!pop.current?.contains(e.relatedTarget as Node | null)) close(false);
          }}
          // mousedown по тексту и отступам поповера не уводит фокус в body (иначе onBlur выше закрыл бы поповер)
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest('input, button, a, select, textarea, [tabindex]')) e.preventDefault();
          }}
          // Esc из footer — как из списка
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close(true);
            }
          }}
        >
          {withSearch && (
            <input
              ref={search}
              className={cx(ctlClass({}), styles.search)}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              aria-label={t('Поиск')}
              placeholder={t('Поиск')}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(stepActive(filterOptions(options, e.target.value), -1, 1));
              }}
              onKeyDown={onListKey}
            />
          )}
          <ul
            ref={list}
            id={listId}
            role="listbox"
            tabIndex={withSearch ? undefined : -1}
            aria-activedescendant={withSearch ? undefined : activeId}
            aria-labelledby={f.labelId}
            aria-label={f.labelId ? undefined : ariaLabel}
            className={styles.list}
            onKeyDown={withSearch ? undefined : onListKey}
            // mousedown по полосе прокрутки и отступам не уводит фокус из поиска
            onMouseDown={(e) => e.preventDefault()}
          >
            {rows.map((o, i) => (
              <li
                key={o.value}
                id={optId(i)}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                className={cx(styles.opt, i === active && styles.active)}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
              >
                <span className={styles.optLabel}>{o.label}</span>
                {o.sub && <span className={styles.optSub}>{o.sub}</span>}
              </li>
            ))}
          </ul>
          {/* вне listbox (там только option): живой регион всегда в DOM, пустой не виден — чтение с экрана скажет «ничего» */}
          <div className={styles.empty} role="status">{rows.length ? '' : t('Ничего не нашлось')}</div>
          {footer}
        </div>
      )}
    </div>
  );
}
