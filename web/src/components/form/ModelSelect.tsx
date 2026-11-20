// Выбор модели на общем Select: модели общего списка (lib/flow/tools.ts), «по умолчанию» с подписью, свои id и «другая…» —
// поле для произвольного id. Свой id, однажды записанный (в файле или вписанный здесь), остаётся пунктом и после
// переключения на модель из списка: вернуть его — один выбор, а не набор заново. Нативный вариант — components/ModelPick.tsx.
import { useId, useState } from 'react';
import { MODELS } from '../../lib/flow/tools';
import { t } from '../../lib/i18n';
import { cx, Input } from './Field';
import { Select, type SelectOption } from './Select';
import styles from './Form.module.css';

const OTHER = ':other';
const known = (id: string) => MODELS.some(([m]) => m === id);

export type ModelSelectProps = {
  /** '' — по умолчанию; иначе id или псевдоним модели. */
  value: string;
  onChange: (model: string) => void;
  /** Подпись пункта «по умолчанию»: что за ним стоит («haiku», «как в flow»). */
  defaultLabel: string;
  /** Подпись для чтения с экрана, когда ModelSelect не внутри Field. */
  'aria-label'?: string;
  title?: string;
  disabled?: boolean;
  /** Класс обёртки (список и поле id модели рядом). */
  className?: string;
};

export function ModelSelect({ value, onChange, defaultLabel, 'aria-label': ariaLabel, title, disabled, className }: ModelSelectProps) {
  const custom = Boolean(value) && !known(value);
  /** Свои id, с которых уже переключились: остаются в списке. */
  const [own, setOwn] = useState<string[]>(() => (custom ? [value] : []));
  /** Выбрано «другая…»: поле id видно, даже пока оно пустое. */
  const [other, setOther] = useState(false);
  const inputId = `m${useId().replace(/[^\w-]/g, '')}`;
  const ids = custom && !own.includes(value) ? [...own, value] : own;
  const options: SelectOption<string>[] = [
    ...MODELS.map(([id, name]) => ({ value: id, label: id ? name : defaultLabel })),
    ...ids.map((id) => ({ value: id, label: id, sub: t('свой id') })),
    { value: OTHER, label: t('другая…') },
  ];
  return (
    <span className={cx(styles.modelPick, className)}>
      <Select<string>
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        mono={custom}
        value={other ? OTHER : value}
        options={options}
        onChange={(v) => {
          // уходим со своего id — он остаётся пунктом списка
          if (custom && !own.includes(value)) setOwn([...own, value]);
          setOther(v === OTHER);
          // «другая…» со своего id — правим его же; с модели из списка — поле пустое, пока не впишешь (как в ModelPick)
          if (v !== OTHER) onChange(v);
          else if (!custom) onChange('');
        }}
      />
      {other && (
        <Input
          id={inputId}
          mono
          className={styles.modelId}
          aria-label={t('id модели')}
          placeholder={t('id модели')}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          value={custom ? value : ''}
          onChange={(e) => {
            const v = e.target.value.trim();
            // вписали модель из списка — список показывает её, а не «другая…»
            if (known(v) && v) setOther(false);
            onChange(v);
          }}
        />
      )}
    </span>
  );
}
