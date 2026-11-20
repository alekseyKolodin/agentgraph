// Число с префиксом и суффиксом (Controls.dc.html → «Бюджет на запуск», «Запусков в день»): «$ 0.50 не больше»,
// «30 мин». Пусто — null («без лимита» плейсхолдером). Пока вписанное не число или вне границ, рамка — ошибка, а наружу
// остаётся прошлое значение; уход с поля возвращает текст к нему.
import { useEffect, useRef, useState } from 'react';
import { parseNumber } from '../../lib/form';
import { ctlClass, cx, useFieldCtx, type Tone } from './Field';
import styles from './Form.module.css';

export type NumberFieldProps = {
  /** Значение; null — пусто (лимита нет). */
  value: number | null;
  onChange: (value: number | null) => void;
  /** Слева от числа, тихим цветом: «$». */
  prefix?: string;
  /** Справа, тихим цветом: «мин», «не больше». */
  suffix?: string;
  /** В пустом поле: «без лимита». */
  placeholder?: string;
  min?: number;
  max?: number;
  /** Только целые (запуски, минуты). */
  integer?: boolean;
  /** Число моноширинным: по умолчанию да — деньги и счётчики. */
  mono?: boolean;
  /** Как показать значение в поле: деньги — value.toFixed(2). По умолчанию String(value). */
  format?: (value: number) => string;
  tone?: Tone;
  disabled?: boolean;
  id?: string;
  /** Подпись для чтения с экрана, когда NumberField не внутри Field. */
  'aria-label'?: string;
  className?: string;
};

export function NumberField({ value, onChange, prefix, suffix, placeholder, min, max, integer, mono = true, format = String, tone, disabled, id, 'aria-label': ariaLabel, className }: NumberFieldProps) {
  const f = useFieldCtx({ id, tone, disabled });
  const shown = value === null ? '' : format(value);
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  // значение поменялось снаружи (сброс формы) — показать его, если человек сейчас не печатает
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  const parsed = parseNumber(text, { min, max, integer });
  const bad = parsed !== null && Number.isNaN(parsed);
  return (
    <span className={ctlClass({ tone: bad ? 'err' : f.tone, className: cx(f.disabled && styles.disabled, className) })}>
      {prefix && <span className={cx(styles.affix, mono && styles.mono)} aria-hidden="true">{prefix}</span>}
      <input
        id={f.id}
        className={cx(styles.bare, mono && styles.mono)}
        inputMode={integer ? 'numeric' : 'decimal'}
        aria-label={ariaLabel}
        aria-describedby={f.describedBy}
        aria-invalid={bad || f.tone === 'err' || undefined}
        disabled={f.disabled}
        placeholder={placeholder}
        autoComplete="off"
        value={text}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseNumber(e.target.value, { min, max, integer });
          if (n === null || !Number.isNaN(n)) {
            if (n !== value) onChange(n);
          }
        }}
        onBlur={() => {
          focused.current = false;
          setText(shown);
        }}
      />
      {suffix && <span className={cx(styles.affix, styles.end)} aria-hidden="true">{suffix}</span>}
    </span>
  );
}
