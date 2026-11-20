// Несколько значений токенами (Controls.dc.html → «Несколько значений»): Enter или запятая добавляют вписанное (запятые
// делят на несколько), уход с поля — тоже, × у токена убирает его, Backspace в пустом поле убирает последний. С text —
// набранное без Enter ведёт родитель: оно уже часть значения (черновик, «есть правки»), а не теряется до Enter.
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../../lib/i18n';
import { addTokens } from '../../lib/form';
import { ctlClass, cx, useFieldCtx, type Tone } from './Field';
import styles from './Form.module.css';

export type TokenInputProps = {
  /** Значения по порядку добавления. Повторы (без регистра) не добавляются. */
  value: string[];
  /** Токены и (при text) набранное, ещё не ставшее токеном. */
  onChange: (value: string[], text: string) => void;
  /**
   * Набранное без Enter — у родителя: тогда onChange зовётся и на каждый набранный символ. Нет — набранное живёт в поле
   * и onChange зовётся, только когда меняются токены.
   */
  text?: string;
  /** Подсказка в пустом поле. */
  placeholder?: string;
  /** Токены и ввод моноширинным (пути, ключи полей). */
  mono?: boolean;
  /** Подсказки при вводе (datalist): каналы, участники из примера события. */
  suggestions?: string[];
  tone?: Tone;
  disabled?: boolean;
  id?: string;
  /** Подпись для чтения с экрана, когда TokenInput не внутри Field. */
  'aria-label'?: string;
  className?: string;
};

export function TokenInput({ value, onChange, text: outer, placeholder, mono, suggestions, tone, disabled, id, 'aria-label': ariaLabel, className }: TokenInputProps) {
  const f = useFieldCtx({ id, tone, disabled });
  const [typed, setTyped] = useState('');
  const controlled = outer !== undefined;
  const text = controlled ? outer : typed;
  /** Новые токены и набранное — одним вызовом: родитель правит их одной правкой. */
  const update = (tokens: string[], rest: string) => {
    if (!controlled) setTyped(rest);
    if (tokens !== value || (controlled && rest !== text)) onChange(tokens, rest);
  };
  const input = useRef<HTMLInputElement>(null);
  const own = useId().replace(/[^\w-]/g, '');
  const listId = suggestions?.length ? `tok${own}-sugg` : undefined;
  const take = (raw: string, commit: boolean) => {
    const r = addTokens(value, raw, commit);
    update(r.tokens.length !== value.length ? r.tokens : value, r.rest);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // Enter с текстом — добавить, а не отправить форму; пустой — как обычно
      if (!text.trim()) return;
      e.preventDefault();
      take(text, true);
    } else if (e.key === 'Backspace' && !text && value.length) {
      e.preventDefault();
      update(value.slice(0, -1), text);
    }
  };
  return (
    <div
      className={ctlClass({ tone: f.tone, mono, className: cx(styles.tokens, f.disabled && styles.disabled, className) })}
      // клик по пустому месту коробки — фокус в поле ввода
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          input.current?.focus();
        }
      }}
    >
      {value.map((v, i) => (
        // ключ — значение и его номер среди одинаковых: повторы (старые данные) не путают React
        <span key={`${v}\u0000${value.slice(0, i).filter((x) => x === v).length}`} className={styles.tok}>
          <span className={styles.tokText} title={v}>{v}</span>
          <button type="button" className={styles.tokX} disabled={f.disabled} aria-label={t('Убрать «{value}»', { value: v })} title={t('Убрать «{value}»', { value: v })} onClick={() => {
              // убирается эта копия; кнопка исчезает — фокус возвращается в поле ввода, а не уходит в body
              update(value.filter((_, j) => j !== i), text);
              input.current?.focus();
            }}>
            ×
          </button>
        </span>
      ))}
      <input
        ref={input}
        id={f.id}
        className={styles.bare}
        list={listId}
        aria-label={ariaLabel}
        aria-describedby={f.describedBy}
        aria-invalid={f.tone === 'err' || undefined}
        disabled={f.disabled}
        placeholder={value.length ? '' : placeholder}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => (e.target.value.includes(',') ? take(e.target.value, false) : update(value, e.target.value))}
        onKeyDown={onKey}
        onBlur={() => text.trim() && take(text, true)}
      />
      {listId && (
        <datalist id={listId}>
          {suggestions!.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}
