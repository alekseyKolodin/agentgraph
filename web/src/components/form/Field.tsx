// Поле общей системы (Controls.dc.html, system.md → Fields): подпись сверху 12px/500, контрол высотой var(--ctl-h), под ним
// одна строка — подсказка или то, что не так («Пустое условие не сохранится»). Field раздаёт контролам внутри id, связь с
// подписью и подсказкой и тон через контекст: <Field label="Название"><Input value… /></Field> — без ручных id.
import { createContext, useContext, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import styles from './Form.module.css';

export const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

/** Тон контрола: warn — не сохранится или спорно (рамка --st-wait), err — ошибка (рамка --st-fail). */
export type Tone = 'warn' | 'err';

type FieldCtx = { id: string; labelId: string; hintId: string | undefined; tone: Tone | undefined; disabled: boolean };
const Ctx = createContext<FieldCtx | null>(null);

/** Что контрол берёт из окружающего Field: id, подпись, подсказку и тон (свои пропсы важнее). */
export function useFieldCtx(own: { id?: string; tone?: Tone; disabled?: boolean } = {}) {
  const c = useContext(Ctx);
  return {
    id: own.id ?? c?.id,
    labelId: c?.labelId,
    describedBy: c?.hintId,
    tone: own.tone ?? c?.tone,
    disabled: own.disabled ?? c?.disabled ?? false,
  };
}

/** Классы контрола: рамка по тону, моноширинный по флагу. */
export const ctlClass = (o: { tone?: Tone; mono?: boolean; className?: string }) => cx(styles.ctl, o.mono && styles.mono, o.tone && styles[o.tone], o.className);

export type FieldProps = {
  /** Подпись над контролом. */
  label: ReactNode;
  /** Пояснение на «?» рядом с подписью (title). Для того, что не нужно читать каждый раз. */
  help?: string;
  /**
   * Одна строка под контролом — только там, где без неё ошибёшься: пусто, общее для источника, стоит денег.
   * При issue не показывается.
   */
  hint?: ReactNode;
  /** Что не так со значением: строка под контролом цветом тона и рамка контрола того же тона. */
  issue?: { tone: Tone; text: ReactNode };
  /** Выключить контролы поля (контекстом); строка подсказки остаётся — в ней обычно причина. */
  disabled?: boolean;
  /** id контрола; по умолчанию свой (useId). */
  id?: string;
  className?: string;
  children: ReactNode;
};

/** Подпись сверху, контрол, одна строка подсказки или предупреждения. */
export function Field({ label, help, hint, issue, disabled = false, id, className, children }: FieldProps) {
  const own = useId();
  const base = id ?? `f${own.replace(/[^\w-]/g, '')}`;
  const line = issue?.text ?? hint;
  const ctx: FieldCtx = { id: base, labelId: `${base}-label`, hintId: line ? `${base}-hint` : undefined, tone: issue?.tone, disabled };
  return (
    <div className={cx(styles.field, className)}>
      <span className={styles.label}>
        <label id={ctx.labelId} htmlFor={base}>{label}</label>
        {help && <span className={styles.help} title={help} aria-label={help} role="img">?</span>}
      </span>
      <Ctx.Provider value={ctx}>{children}</Ctx.Provider>
      {line && <span id={ctx.hintId} className={cx(styles.hint, issue && styles[issue.tone])}>{line}</span>}
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Моноширинный: путь, cron, ключ поля. Обычный текст — шрифтом интерфейса. */
  mono?: boolean;
  tone?: Tone;
};

/** Однострочное поле 32 px. Внутри Field id, подпись и тон приходят сами. */
export function Input({ mono, tone, id, disabled, className, ...rest }: InputProps) {
  const f = useFieldCtx({ id, tone, disabled });
  return <input id={f.id} aria-describedby={f.describedBy} aria-invalid={f.tone === 'err' || undefined} disabled={f.disabled} className={ctlClass({ tone: f.tone, mono, className })} {...rest} />;
}

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean; tone?: Tone };

/** Многострочное поле: та же рамка и фон, растягивается по вертикали. Команды и JSON — mono. */
export function TextArea({ mono, tone, id, disabled, className, ...rest }: TextAreaProps) {
  const f = useFieldCtx({ id, tone, disabled });
  return <textarea id={f.id} aria-describedby={f.describedBy} aria-invalid={f.tone === 'err' || undefined} disabled={f.disabled} className={ctlClass({ tone: f.tone, mono, className })} {...rest} />;
}
