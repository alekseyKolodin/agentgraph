// Карточка вопроса агента (ui/app.js questionCardHtml, wireQuestionCard, submitAnswer): варианты-кнопки без предвыбора,
// свой ответ рядом, ⌘↵ — отправить. Поля неуправляемые, как в старом UI: события запусков перерисовывают главную,
// а недописанный ответ и выбор должны пережить перерисовку — ключ карточки — id вопроса.
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { AskAnswers, HomeRun, QuestionRecord } from '@server/api-types';
import { api, errorText } from '../../api';
import { useConfirm } from '../ConfirmDialog';
import { MdText } from '../MdText';
import { ago, excerpt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { collectAnswers, ignoredConfirmText, optionView, OTHER, PREFACE_INLINE_MAX, questionLastCond, questionWhere } from '../../lib/home';
import styles from './QuestionCard.module.css';

/** Что карточке нужно от запуска: имя, задача, сводка и вердикты для контекста на главной. */
export type QuestionRun = Pick<HomeRun, 'id' | 'flow'> & Partial<Pick<HomeRun, 'title' | 'input' | 'digest' | 'conds' | 'blocks'>>;

type Props = {
  q: QuestionRecord;
  run: QuestionRun;
  /** На главной: имя запуска, «ждёт N мин», «Открыть запуск» и контекст — задача, «где мы», итог прошлой итерации. */
  onHome?: boolean;
  /** Время для «ждёт N мин»: главная перерисовывает его раз в 30 секунд. */
  now?: number;
  onOpenRun?: () => void;
  /** Ответ принят сервером. */
  onAnswered: (answers: AskAnswers) => void;
  /** Сервер ответ не принял: на вопрос могли ответить в другой вкладке или из чата — входящие стоит обновить. */
  onFailed?: () => void;
};

/**
 * Недописанные ответы по id вопроса: в старом UI карточка жила в скрытом DOM главной и переживала уход на другой экран;
 * здесь экран размонтируется, поэтому выбор и свой текст держим в памяти вкладки до ответа.
 */
type Draft = { checked: string[]; other: Record<string, string> };
const drafts = new Map<string, Draft>();

function saveDraft(qid: string, f: HTMLFormElement) {
  const checked = [...f.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => `${i.name}=${i.value}`);
  const other = Object.fromEntries([...f.querySelectorAll('textarea')].map((t) => [t.name, t.value]));
  drafts.set(qid, { checked, other });
}

function restoreDraft(qid: string, f: HTMLFormElement) {
  const d = drafts.get(qid);
  if (!d) return;
  for (const i of f.querySelectorAll<HTMLInputElement>('input')) i.checked = d.checked.includes(`${i.name}=${i.value}`);
  for (const t of f.querySelectorAll('textarea')) {
    t.value = d.other[t.name] ?? '';
    if (t.value) {
      t.style.height = 'auto';
      t.style.height = `${t.scrollHeight + 2}px`;
    }
  }
}

/** Подсветить карточку вопроса на экране (клик по вопросу в ленте): прокрутить к ней и мигнуть. false — карточки нет. */
export function flashQuestion(qid: string): boolean {
  const card = document.querySelector<HTMLFormElement>(`form[data-qid="${CSS.escape(qid)}"]`);
  if (!card) return false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove(styles.flash!);
  void card.offsetWidth;
  card.classList.add(styles.flash!);
  return true;
}

export function QuestionCard({ q, run, onHome = false, now = Date.now(), onOpenRun, onAnswered, onFailed }: Props) {
  const { askConfirm } = useConfirm();
  const form = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => restoreDraft(q.id, form.current!), [q.id]);
  const [msg, setMsg] = useState<{ text: string; err: boolean }>({ text: '', err: false });
  const [sending, setSending] = useState(false);
  const where = questionWhere(q, run);
  const last = onHome ? questionLastCond(q, run) : null;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const f = form.current!;
    const picked = q.questions.map((_, qi) => [...f.querySelectorAll<HTMLInputElement>(`input[name=q${qi}]:checked`)].map((i) => i.value));
    const other = q.questions.map((_, qi) => f.querySelector<HTMLTextAreaElement>(`[name=other${qi}]`)?.value || '');
    const { answers, missing, ignored } = collectAnswers(q.questions, picked, other);
    if (missing) {
      setMsg({ text: t('Ответь на все вопросы'), err: true });
      return;
    }
    if (ignored.length && !(await askConfirm(ignoredConfirmText(ignored), { ok: t('Продолжить') }))) return;
    try {
      setSending(true);
      await api('POST', `/api/runs/${run.id}/answer`, { questionId: q.id, answers });
      drafts.delete(q.id);
      onAnswered(answers);
    } catch (err) {
      setMsg({ text: errorText(err), err: true });
      setSending(false);
      onFailed?.();
    }
  };

  // Ввод своего варианта сам отмечает «Свой ответ»: иначе текст теряется. Любой выбор или ввод снимает прошлую ошибку.
  const onInput = (e: FormEvent<HTMLFormElement>) => {
    if (msg.err) setMsg({ text: '', err: false });
    const t = e.target as HTMLTextAreaElement;
    const m = t.name?.match(/^other(\d+)$/);
    if (!m) return saveDraft(q.id, form.current!);
    // поле растёт по тексту; непустой свой ответ сам становится выбранным
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight + 2}px`;
    const pick = form.current!.querySelector<HTMLInputElement>(`input[name=q${m[1]}][value=${OTHER}]`);
    if (pick) pick.checked = Boolean(t.value.trim());
    saveDraft(q.id, form.current!);
  };

  return (
    <form
      ref={form}
      className={styles.qcard}
      data-qid={q.id}
      data-run={run.id}
      onSubmit={submit}
      onInput={onInput}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          form.current!.requestSubmit();
        }
      }}
    >
      {onHome ? (
        <div className={styles.qhead}>
          <span className={styles.qrun}>{run.title || run.flow}</span>
          <span className={styles.qwhere}>{where}</span>
          <span className={styles.qwait}>{t('ждёт {time}', { time: ago(q.askedAt, now) })}</span>
          <button type="button" className="btn small ghost" onClick={onOpenRun}>{t('Открыть запуск')}</button>
        </div>
      ) : (
        <div className={styles.qhead}>
          <span className={styles.qrun}>{t('Вопрос агента')}</span>
          <span className={styles.qwhere}>{where} · {t('сессия ждёт ответа')}</span>
        </div>
      )}
      {/* на главной — то, что на странице запуска и так видно: задача, сводка «где мы» и итог прошлой итерации */}
      {onHome && (
        <div className={styles.qctx}>
          {run.input && (
            <div>
              <span className={styles.qctxK}>{t('Задача')}</span>
              <span className={styles.qctxV} title={run.input}>{excerpt(run.input, 220)}</span>
            </div>
          )}
          {run.digest?.text && (
            <div>
              <span className={styles.qctxK}>{t('Где мы')}</span>
              <span className={styles.qctxV}>{run.digest.text}</span>
            </div>
          )}
          {last && (
            <div>
              <span className={styles.qctxK}>{t('Итерация {n}', { n: last.iteration })}</span>
              <span className={styles.qctxV}>
                <span className="err">✕</span> {last.summary || excerpt(last.text, 200) || t('условие не выполнено')}
              </span>
            </div>
          )}
        </div>
      )}
      <Preface text={q.preface} />
      {q.questions.map((item, qi) => (
        <div key={qi} className={styles.qitem}>
          {item.header && <div className={styles.qhdr}>{item.header}</div>}
          <div className={styles.qtext}><MdText text={item.question} /></div>
          <div className={styles.qopts}>
            {item.options.map((o, oi) => {
              const { label, rec } = optionView(o.label);
              return (
                <label key={oi} className={`${styles.opt}${rec ? ' rec' : ''}`}>
                  <input type={item.multiSelect ? 'checkbox' : 'radio'} name={`q${qi}`} value={o.label} />
                  <span>
                    <span className={styles.ol}>
                      {label}
                      {rec && <span className={styles.qrec}>{t('рекомендует агент')}</span>}
                    </span>
                    {o.description && <span className={styles.od}><MdText text={o.description} /></span>}
                  </span>
                </label>
              );
            })}
          </div>
          <div className={styles.qown}>
            <input type={item.multiSelect ? 'checkbox' : 'radio'} name={`q${qi}`} value={OTHER} className={styles.qownPick} aria-label={t('Свой ответ')} tabIndex={-1} />
            <textarea name={`other${qi}`} rows={1} placeholder={item.options.length ? t('Или ответь своими словами') : t('Твой ответ')} />
          </div>
        </div>
      ))}
      <div className={`row ${styles.qsend}`}>
        <button type="submit" className="btn primary" disabled={sending}>{t('Ответить')}</button>
        <span className="muted small">⌘↵</span>
        <span className={`msg${msg.err ? ' err' : ''}`}>{msg.text}</span>
      </div>
    </form>
  );
}

/** Текст агента прямо перед вопросом: таблица или список, о которых спрашивают. Длинный — свёрнут до начала. */
function Preface({ text }: { text: string | undefined }) {
  if (!text) return null;
  const body = <div className={styles.qpreface}><MdText text={text} /></div>;
  if (text.length <= PREFACE_INLINE_MAX) return body;
  return (
    <details className={styles.qprefaceWrap}>
      <summary>
        <span className={styles.qprefaceLead}>{excerpt(text, 180)}</span> <span className="muted">{t('развернуть')}</span>
      </summary>
      {body}
    </details>
  );
}

/** Отвеченный вопрос в ленте этапов страницы запуска (ui/app.js answeredCardHtml): вступление свёрнуто, вопросы и ответы. */
export function AnsweredCard({ q }: { q: QuestionRecord }) {
  return (
    <div className={`${styles.qcard} ${styles.answered}`}>
      <div className={styles.qhead}>{t('💬 Вопрос от «{phase}» и ответ', { phase: q.title || q.phase })}</div>
      {q.preface && (
        <details className={styles.qprefaceWrap}>
          <summary>{t('Что агент написал перед вопросом')}</summary>
          <div className={styles.qpreface}><MdText text={q.preface} /></div>
        </details>
      )}
      {q.questions.map((item, i) => (
        <div key={i} className={styles.qa}>
          {item.header && <div className={styles.qhdr}>{item.header}</div>}
          <div className={styles.qaQ}><MdText text={item.question} /></div>
          <div className={styles.qaA}><span className="muted">{t('Ответ:')}</span> {q.answers?.[item.question] ?? ''}</div>
        </div>
      ))}
    </div>
  );
}
