// Имя с правкой на месте — для строк списков (сайдбар, таблица) и шапки экрана. Двойной клик по имени или карандаш
// рядом (в строке списка виден при наведении и фокусе) превращают имя в поле. Enter и уход из поля сохраняют, Esc
// отменяет; пустое или прежнее имя ничего не сохраняет. Ошибка сохранения — всплывашкой, имя остаётся прежним.
// Клики и клавиши поля и карандаша до строки не доходят. Имя, которое открывает строку (ссылка to или onOpen),
// открывает её одиночным кликом после паузы на двойной — иначе первый клик двойного открывал бы строку вместо
// переименования; клик мимо имени строка обрабатывает сама, сразу. Что сохранять — lib/rename.ts.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { errorText } from '../api';
import { t } from '../lib/i18n';
import { nameToSave } from '../lib/rename';
import { useToast } from './Toast';
import styles from './InlineRename.module.css';

/**
 * Класс строки списка: при её наведении и фокусе виден карандаш, а с tabIndex она получает фокус после Enter или Esc
 * в поле. Глобальный: строки живут в своих CSS-модулях.
 */
export const RENAME_HOST = 'rename-host';
/** Пауза одиночного клика по имени, которое открывает строку: за неё успевает второй клик двойного. */
const DOUBLE_CLICK_MS = 300;

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
const stop = (e: SyntheticEvent) => e.stopPropagation();
/** Второй клик двойного не выделяет слово: имя сейчас станет полем. */
const noSelect = (e: MouseEvent) => {
  if (e.detail > 1) e.preventDefault();
};

const PENCIL = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);

export type InlineRenameProps = {
  /** Текущее имя. */
  value: string;
  /** Сохранить имя (уже без лишних пробелов и не длиннее max); ошибка — всплывашкой, имя прежнее. */
  onSave: (name: string) => Promise<unknown>;
  /** Не длиннее, символов: как на сервере. */
  max: number;
  /** Подпись поля: «Название сессии». */
  label: string;
  /** Подпись карандаша для экранного диктора: «Переименовать сессию «…»». */
  pencilLabel: string;
  /** Имя — ссылка: одиночный клик открывает её после паузы на двойной; Cmd/Ctrl-клик и Enter — как у ссылки. */
  to?: string;
  /** Имя открывает строку, у которой свой onClick: одиночный клик по имени — после паузы на двойной. */
  onOpen?: () => void;
  /** Элемент имени: h1 в шапке экрана. */
  as?: 'span' | 'h1';
  /** Карандаш виден всегда (шапка); по умолчанию — при наведении и фокусе строки (RENAME_HOST) или самого имени. */
  pencil?: 'hover' | 'always';
  className?: string;
  textClassName?: string;
  /** Подсказка у имени: полное, если обрезано многоточием. */
  title?: string;
};

type Trigger = 'pencil' | 'text';

export function InlineRename({ value, onSave, max, label, pencilLabel, to, onOpen, as = 'span', pencil = 'hover', className, textClassName, title }: InlineRenameProps) {
  const toast = useToast();
  const navigate = useNavigate();
  /** Набранное; null — поле закрыто. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Имя сохраняется: показываем новое, пока не пришёл ответ, — без мигания старого. */
  const [pending, setPending] = useState<string | null>(null);
  /** Шрифт имени — полю: текст не прыгает. */
  const [font, setFont] = useState<CSSProperties>();
  const from = useRef('');
  /** Поле уже закрыли Enter или Esc: blur после этого — не повод сохранять ещё раз. */
  const closed = useRef(false);
  /** Чем начали правку: туда и вернуть фокус, если строка его не берёт. */
  const startedBy = useRef<Trigger>('text');
  /** После Enter или Esc вернуть фокус; ушли из поля мышью или Tab — не трогаем. */
  const refocus = useRef(false);
  const saving = useRef(0);
  const wrap = useRef<HTMLElement | null>(null);
  const text = useRef<HTMLElement | null>(null);
  /** Снять отложенное открытие по одиночному клику (таймер и его слушатель нажатий); нечего снимать — пустая. */
  const cancelOpen = useRef(() => {});
  const setWrap = useCallback((el: HTMLElement | null) => {
    wrap.current = el;
  }, []);
  const setText = useCallback((el: HTMLElement | null) => {
    text.current = el;
  }, []);
  useEffect(() => () => cancelOpen.current(), []);
  useEffect(() => {
    if (draft !== null || !refocus.current) return;
    refocus.current = false;
    // строка списка, которая берёт фокус, — она; иначе то, чем начали: карандаш или ссылка имени
    const row = wrap.current?.closest<HTMLElement>(`.${RENAME_HOST}[tabindex]`);
    const own = wrap.current?.querySelector<HTMLElement>(startedBy.current === 'pencil' ? 'button' : 'a') ?? wrap.current?.querySelector<HTMLElement>('button');
    (row ?? own)?.focus();
  }, [draft]);

  const shown = pending ?? value;
  const start = (by: Trigger) => {
    cancelOpen.current();
    const cs = text.current ? getComputedStyle(text.current) : undefined;
    setFont(cs && { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing });
    from.current = shown;
    startedBy.current = by;
    closed.current = false;
    setDraft(shown);
  };
  const close = (save: boolean, focusBack: boolean) => {
    if (closed.current || draft === null) return;
    closed.current = true;
    refocus.current = focusBack;
    setDraft(null);
    const name = save ? nameToSave(draft, from.current, max) : null;
    if (name === null) return;
    const n = ++saving.current;
    setPending(name);
    onSave(name)
      .catch((err: unknown) => toast(errorText(err)))
      .finally(() => {
        if (saving.current === n) setPending(null);
      });
  };
  // div для h1: блочный заголовок внутри span — невалидная разметка; тип обёртки один в обоих режимах
  const frame = (cls: string, children: ReactNode) =>
    as === 'h1' ? <div ref={setWrap} className={cls}>{children}</div> : <span ref={setWrap} className={cls}>{children}</span>;

  if (draft !== null) {
    return frame(
      cx(styles.wrap, styles.editing, className),
      <input
        className={styles.input}
        style={font}
        aria-label={label}
        value={draft}
        maxLength={max}
        size={Math.min(max, Math.max(16, draft.length + 2))}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // клавиши поля — только ему: строка с onKeyDown не откроется, Esc не закроет меню или диалог вокруг
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            close(true, true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close(false, true);
          }
        }}
        onBlur={() => close(true, false)}
        onClick={stop}
        onDoubleClick={stop}
      />,
    );
  }

  const open = to ? () => void navigate(to) : onOpen;
  /**
   * Открыть после паузы. Любое следующее нажатие (второй клик двойного, другая строка, другой раздел) паузу снимает:
   * сайдбар живёт и после перехода, и таймер открыл бы эту строку поверх более позднего клика.
   */
  const openLater = (go: () => void) => {
    cancelOpen.current();
    let id: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      clearTimeout(id);
      document.removeEventListener('pointerdown', cancel, true);
      cancelOpen.current = () => {};
    };
    document.addEventListener('pointerdown', cancel, true);
    id = setTimeout(() => {
      cancel();
      go();
    }, DOUBLE_CLICK_MS);
    cancelOpen.current = cancel;
  };
  // одиночный клик по имени, которое открывает строку, — после паузы: второй клик двойного должен успеть переименовать
  const onTextClick = (e: MouseEvent) => {
    if (!open || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.detail === 0) return;
    e.preventDefault();
    e.stopPropagation();
    cancelOpen.current();
    if (e.detail === 1) openLater(open);
  };
  const onDouble = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    start('text');
  };
  const textProps = { ref: setText, className: cx(styles.text, textClassName), title, onClick: onTextClick, onDoubleClick: onDouble, onMouseDown: noSelect };
  return frame(
    cx(styles.wrap, pencil === 'always' && styles.always, className),
    <>
      {to ? <Link {...textProps} to={to}>{shown}</Link> : as === 'h1' ? <h1 {...textProps}>{shown}</h1> : <span {...textProps}>{shown}</span>}
      <button
        type="button"
        className={styles.pencil}
        aria-label={pencilLabel}
        title={t('Переименовать — или двойной клик по имени')}
        onClick={(e) => {
          e.stopPropagation();
          start('pencil');
        }}
        onKeyDown={stop}
      >
        {PENCIL}
      </button>
    </>,
  );
}
