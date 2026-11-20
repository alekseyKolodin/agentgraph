// Сегменты 32 px и чипы 24 px (Controls.dc.html → «Один из 2–4 вариантов», «Отметить несколько»). Вариантов больше 4 —
// лучше Select: сегменты в строку перестают читаться. Внутри Field группа подписывается подписью поля.
import type { ReactNode } from 'react';
import { cx, useFieldCtx } from './Field';
import styles from './Form.module.css';

export type ChoiceOption<V extends string> = {
  value: V;
  label: ReactNode;
  /** Подсказка на наведение: что значит вариант или почему он выключен. */
  title?: string;
  disabled?: boolean;
};

export type SegProps<V extends string> = {
  /** Варианты: рассчитано на 2–4; больше — Select (не проверяется, решает экран). */
  options: ChoiceOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Подпись группы для чтения с экрана, когда Seg не внутри Field. */
  label?: string;
  disabled?: boolean;
  className?: string;
};

/** Один из нескольких: кнопки с aria-pressed в группе. */
export function Seg<V extends string>({ options, value, onChange, label, disabled, className }: SegProps<V>) {
  const f = useFieldCtx({ disabled });
  return (
    <div className={cx(styles.seg, className)} role="group" aria-label={label} aria-labelledby={label ? undefined : f.labelId} aria-describedby={f.describedBy}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={f.disabled || o.disabled} title={o.title} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type ChipsProps<V extends string> = {
  options: ChoiceOption<V>[];
  /** Отмеченные значения; порядок наружу — как в options. */
  value: V[];
  onChange: (value: V[]) => void;
  /** Подпись группы для чтения с экрана, когда Chips не внутри Field. */
  label?: string;
  disabled?: boolean;
  className?: string;
};

/** Отметить несколько: чипы-переключатели 24 px. Для моментов и меток, не для выбора одного. */
export function Chips<V extends string>({ options, value, onChange, label, disabled, className }: ChipsProps<V>) {
  const f = useFieldCtx({ disabled });
  const toggle = (v: V) => {
    const on = value.includes(v);
    onChange(options.map((o) => o.value).filter((x) => (x === v ? !on : value.includes(x))));
  };
  return (
    <div className={cx(styles.chips, className)} role="group" aria-label={label} aria-labelledby={label ? undefined : f.labelId} aria-describedby={f.describedBy}>
      {options.map((o) => (
        <button key={o.value} type="button" className={styles.chip} aria-pressed={value.includes(o.value)} disabled={f.disabled || o.disabled} title={o.title} onClick={() => toggle(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
