// Выбор модели там, где на человека работает ИИ (docs/ASSISTANTS.md): помощник раздела, узел «ИИ рутины». Модели из
// общего списка (lib/flow/tools.ts), «по умолчанию» с подписью, что это за модель, и «другая…» — произвольный id.
import { useState } from 'react';
import { MODELS } from '../lib/flow/tools';
import { t } from '../lib/i18n';

const OTHER = ':other';

type Props = {
  /** '' — по умолчанию; иначе id или псевдоним модели. */
  value: string;
  onChange: (model: string) => void;
  /** Подпись пункта «по умолчанию»: какая модель за ним стоит («haiku, по умолчанию»). */
  defaultLabel: string;
  /** Подпись для скринридера и подсказка. */
  label: string;
  title?: string;
  disabled?: boolean;
  selectClassName?: string;
  inputClassName?: string;
};

export function ModelPick({ value, onChange, defaultLabel, label, title, disabled, selectClassName, inputClassName }: Props) {
  const known = MODELS.some(([id]) => id === value);
  // «другая…» выбрана, а id ещё не введён: значение пустое, но поле ввода должно остаться
  const [other, setOther] = useState(!known);
  const custom = other || !known;
  return (
    <>
      <select
        className={selectClassName}
        aria-label={label}
        title={title}
        disabled={disabled}
        value={custom ? OTHER : value}
        onChange={(e) => {
          const v = e.target.value;
          setOther(v === OTHER);
          onChange(v === OTHER ? '' : v);
        }}
      >
        {MODELS.map(([id, name]) => <option key={id} value={id}>{id ? name : defaultLabel}</option>)}
        <option value={OTHER}>{t('другая…')}</option>
      </select>
      {custom && (
        <input
          className={inputClassName}
          aria-label={t('id модели')}
          placeholder={t('id модели')}
          spellCheck={false}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      )}
    </>
  );
}
