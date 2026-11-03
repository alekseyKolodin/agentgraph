// Выбор пространства в формах запуска и сессии: поле со списком подсказок (datalist) и строка под ним — что даст
// выбранное (карта, документы, состояние) или что вписан новый слаг (заведётся пустым). Пусто — без пространства.
import type { SpaceListItem } from '@server/api-types';
import { t } from '../lib/i18n';
import { spaceFieldNote, spaceOptionLabel } from '../lib/spaces';

type Props = {
  /** id списка подсказок: уникальный на странице. */
  listId: string;
  value: string;
  onChange: (slug: string) => void;
  options: SpaceListItem[];
  label?: string;
  labelTitle?: string;
  className?: string;
};

export function SpaceField({ listId, value, onChange, options, label = t('Пространство'), labelTitle, className }: Props) {
  const note = spaceFieldNote(value, options);
  return (
    <div className={className}>
      <label>
        <span title={labelTitle ?? t('Фича или проект: карта (CLAUDE.md) придёт памятью, как CLAUDE.md репозитория; документы — по запросу; состояние «где мы сейчас» — в контексте. После работы состояние перепишет короткая сессия')}>{label}</span>
        <datalist id={listId}>
          {options.map((s) => <option key={s.slug} value={s.slug}>{spaceOptionLabel(s)}</option>)}
        </datalist>
        <input
          name="space"
          list={listId}
          placeholder={t('без пространства — или выбери из списка, или впиши новый слаг: press-alert')}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <span className={note.tone ? 'msg err small' : 'muted small'}>{note.text}</span>
    </div>
  );
}
