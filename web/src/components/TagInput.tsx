// Ввод тегов: поле с подсказками (datalist) и чипы выбранных с ×. Общий для формы запуска (RunForm) и сессий терминала.
// Тег добавляется по Enter, выбором из списка и уходом с поля; что делать со слагом (проверить, завести, подтянуть
// вид), решает владелец в onAdd — ему приходит текст поля.
import type { TagKind, TagListItem } from '@server/api-types';
import { KIND_LABEL, tagOptionLabel } from '../lib/run-form';
import { TagBadge } from './Badge';

type FieldProps = {
  /** id списка подсказок: уникальный на странице. */
  listId: string;
  options: TagListItem[];
  text: string;
  onText: (text: string) => void;
  onAdd: (text: string) => void;
  placeholder: string;
  className?: string;
  'aria-label'?: string;
};

/** Поле ввода тега со списком подсказок. */
export function TagField({ listId, options, text, onText, onAdd, placeholder, className, 'aria-label': ariaLabel }: FieldProps) {
  return (
    <>
      <datalist id={listId}>
        {options.map((tag) => <option key={tag.slug} value={tag.slug}>{tagOptionLabel(tag)}</option>)}
      </datalist>
      <input
        name="tag"
        list={listId}
        className={className}
        aria-label={ariaLabel}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          onText(e.target.value);
          // выбор из списка (datalist): как change старого поля — сразу добавить
          if ((e.nativeEvent as InputEvent).inputType === 'insertReplacementText' || !(e.nativeEvent instanceof InputEvent)) onAdd(e.target.value);
        }}
        // уход с поля — как change; input не берём, чтобы не дёргать сервер на каждую букву
        onBlur={(e) => onAdd(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          onAdd(e.currentTarget.value);
        }}
      />
    </>
  );
}

type Props = FieldProps & {
  label: string;
  labelTitle?: string;
  tags: string[];
  kindOf: (slug: string) => TagKind;
  onRemove: (slug: string) => void;
  removeTitle: string;
};

/** Подпись, поле и чипы выбранных тегов (тег задачи — залитый, тег знаний — пунктирный) с видом и ×. */
export function TagInput({ label, labelTitle, tags, kindOf, onRemove, removeTitle, ...field }: Props) {
  return (
    <>
      <label>
        <span title={labelTitle}>{label}</span>
        <TagField {...field} />
      </label>
      <div className="chips">
        {tags.map((tag) => (
          <span key={tag} className="chip attach-chip">
            <TagBadge slug={tag} kind={kindOf(tag)} />
            <span className="muted small">{KIND_LABEL[kindOf(tag)]}</span>
            <button type="button" className="attach-x" title={removeTitle} onClick={() => onRemove(tag)}>×</button>
          </span>
        ))}
      </div>
    </>
  );
}
