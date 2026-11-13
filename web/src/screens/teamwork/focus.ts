// Фокус окон Teamwork. Закрытие возвращает фокус туда, откуда окно открыли (кнопка, карточка, строка): <dialog>, снятый
// размонтированием без close(), и панель задачи браузер сам не возвращает — фокус падал в body. У панели задачи нет
// <dialog> (aria-modal), поэтому Tab и Shift+Tab в ней ходят по кругу; нативный showModal() держит фокус сам.
import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import { trapStep } from '../../lib/teamwork/focus';

/**
 * Вернуть фокус после закрытия окна. Элемент запоминается на первой отрисовке — до showModal() и autoFocus; фокус
 * возвращается, только когда окна уже нет в документе (StrictMode «размонтирует» понарошку, DOM остаётся) и фокус никто
 * не поставил сам (окно открыло следующее: панель задачи, форму).
 */
export function useReturnFocus(box: RefObject<HTMLElement | null>): void {
  const [opener] = useState(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && el !== document.body ? el : null;
  });
  useEffect(() => {
    const el = box.current;
    return () => {
      setTimeout(() => {
        if (el?.isConnected || !opener?.isConnected) return;
        const now = document.activeElement;
        if (now && now !== document.body) return;
        opener.focus();
      });
    };
  }, []);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Обработчик keydown панели: Tab с последнего элемента — на первый, Shift+Tab с первого — на последний. */
export function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  const box = e.currentTarget;
  // события из порталов (форма «В работу») приходят по дереву React, но фокус там не наш
  if (!(e.target instanceof Node) || !box.contains(e.target)) return;
  const list = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
  const next = trapStep(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
  if (next === undefined) return;
  e.preventDefault();
  (next < 0 ? box : list[next]!).focus();
}
