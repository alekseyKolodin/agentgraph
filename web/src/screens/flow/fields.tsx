// Поля конструктора, которые в старом UI жили своим DOM: правка пишется в этап на ввод или по change (blur, Enter),
// а значение поля не перерисовывается, пока в нём фокус (иначе id-слаг, «Лимит итераций» → 1 и пустые строки путей сбивали бы ввод).
import { useEffect, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Common = {
  value: string;
  /** Каждый ввод (событие input). */
  onInput?: (v: string) => void;
  /** Значение принято: blur или Enter (событие change). */
  onCommit?: (v: string) => void;
};

/** Текст поля: свой, пока в поле фокус; без фокуса — из value. */
function useDraft(value: string) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  /** После blur — значение из данных: отклонённая правка (занятый id) возвращается, как после перерисовки в старом. */
  const resync = () => setTimeout(() => {
    if (!focused.current) setText(latest.current);
  });
  return { text, setText, focused, resync };
}

export function DraftInput({ value, onInput, onCommit, onFocus, onBlur, onKeyDown, ...rest }: Common & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onInput'>) {
  const { text, setText, focused, resync } = useDraft(value);
  // как событие change: только если текст отличается от значения в данных (отклонённая правка при повторе — снова в onCommit)
  const commit = (v: string) => {
    if (v !== value) onCommit?.(v);
  };
  return (
    <input
      {...rest}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onInput?.(e.target.value);
      }}
      onFocus={(e) => {
        focused.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        commit(e.target.value);
        resync();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(e.currentTarget.value);
        onKeyDown?.(e);
      }}
    />
  );
}

export function DraftTextarea({ value, onInput, onFocus, onBlur, ...rest }: Omit<Common, 'onCommit'> & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onInput'>) {
  const { text, setText, focused, resync } = useDraft(value);
  return (
    <textarea
      {...rest}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onInput?.(e.target.value);
      }}
      onFocus={(e) => {
        focused.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        resync();
        onBlur?.(e);
      }}
    />
  );
}
