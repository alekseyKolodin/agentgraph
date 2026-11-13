// «Черновик с агентом…» (весь документ) и «С агентом…» (один раздел): задание, модель, для архитектуры — какие документы
// писать; «Запустить» стартует черновик POST …/drafts (spec §9.2). Черновик — обычный запуск flow команды: вопросы агента
// и ход работы — на странице запуска, по готовности правки приходят в документ режимом рецензии.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDraft, TeamDraftStart } from '@server/api-types';
import { errorText } from '../../../api';
import { t } from '../../../lib/i18n';
import { docLabel } from '../../../lib/teamwork/docs';
import { sectionName } from '../../../lib/teamwork/doc-view';
import { cx } from '../parts';
import { draftKeys, startDraft } from './api';
import styles from './Docs.module.css';

export type DraftDoc = 'prd' | 'architecture' | 'design';

type Props = {
  team: string;
  project: string;
  doc: DraftDoc;
  /** Раздел: агент правит только его. */
  section?: string;
  /** Текст и вид кнопки. */
  children: ReactNode;
  buttonClass?: string;
  /** Почему нельзя: кнопка неактивна с подсказкой. */
  disabledReason?: string;
  /** Подсказка о несохранённой правке: агент работает с версией из репо. */
  note?: string;
  onStarted?: (d: TeamDraft) => void;
  /** Панель открывается от левого края кнопки (кнопка слева на экране). */
  left?: boolean;
};

const MODELS = ['', 'haiku', 'sonnet', 'opus'] as const;

/** Flow команды, которым пойдёт черновик. */
export const draftFlow = (doc: DraftDoc): string => (doc === 'prd' ? 'teamwork-prd' : 'teamwork-architecture');

export function AgentAsk({ team, project, doc, section, children, buttonClass, disabledReason, note, onStarted, left }: Props) {
  const qc = useQueryClient();
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState('');
  const [model, setModel] = useState<(typeof MODELS)[number]>('');
  const [both, setBoth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', away);
    wrap.current?.addEventListener('keydown', key);
    const el = wrap.current;
    return () => {
      document.removeEventListener('mousedown', away);
      el?.removeEventListener('keydown', key);
    };
  }, [open]);

  const other: DraftDoc = doc === 'design' ? 'architecture' : 'design';
  const run = async () => {
    setBusy(true);
    setErr('');
    const body: TeamDraftStart = { kind: doc === 'prd' ? 'prd' : 'architecture' };
    if (brief.trim()) body.brief = brief.trim();
    if (section !== undefined) body.section = section;
    if (doc !== 'prd') body.what = both && section === undefined ? 'both' : doc;
    if (model) body.model = model;
    try {
      const d = await startDraft(team, project, body);
      await qc.invalidateQueries({ queryKey: draftKeys.list(team, project) });
      setOpen(false);
      setBrief('');
      onStarted?.(d);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const placeholder = section !== undefined ? t('Например: добавь требование про права доступа') : doc === 'prd' ? t('Написать ТЗ по коду') : t('Написать по ТЗ');
  return (
    <div className={styles.popWrap} ref={wrap}>
      <button
        type="button"
        className={buttonClass ?? 'btn small'}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={Boolean(disabledReason)}
        title={disabledReason ?? (section !== undefined ? t('Агент предложит правку этого раздела — вы примете её по правкам') : t('Агент напишет черновик документа — вы примете его по правкам'))}
        onClick={() => setOpen((v) => !v)}
      >
        {children}
      </button>
      {open && (
        <div className={cx(styles.pop, left && styles.left)} role="dialog" id={id} aria-label={section !== undefined ? t('Правка с агентом') : t('Черновик с агентом')}>
          <label htmlFor={`${id}-brief`}>{section !== undefined ? t('Что поменять в разделе «{section}»?', { section: sectionName(section) }) : t('Что сделать?')}</label>
          <textarea
            id={`${id}-brief`}
            value={brief}
            autoFocus
            placeholder={placeholder}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) {
                e.preventDefault();
                void run();
              }
            }}
          />
          {doc !== 'prd' && section === undefined && (
            <div className={styles.opts} role="radiogroup" aria-label={t('Что писать')}>
              <label><input type="radio" name={`${id}-what`} checked={!both} onChange={() => setBoth(false)} />{t('Только {doc}', { doc: docLabel(doc).toLowerCase() })}</label>
              <label><input type="radio" name={`${id}-what`} checked={both} onChange={() => setBoth(true)} />{t('{doc} и {other}', { doc: docLabel(doc), other: docLabel(other).toLowerCase() })}</label>
            </div>
          )}
          <p>{section !== undefined ? t('Агент предложит правку прямо в этом разделе. Остальные разделы он не тронет.') : t('Агент пишет черновик в запуске flow и задаёт вопросы там же. Готовый черновик вы примете по правкам — без кнопки в репо ничего не попадёт.')}</p>
          {note && <p className={styles.tWait}>{note}</p>}
          <div className={styles.r}>
            <span className={styles.meta}>{draftFlow(doc)} ·</span>
            <select aria-label={t('Модель')} value={model} onChange={(e) => setModel(e.target.value as (typeof MODELS)[number])}>
              {MODELS.map((m) => <option key={m} value={m}>{m || t('модель flow')}</option>)}
            </select>
            <span className={styles.grow} />
            <button type="button" className={cx('btn small', 'primary')} disabled={busy} onClick={() => void run()}>{busy ? t('Запускаю…') : section !== undefined ? t('Предложить') : t('Запустить')}</button>
          </div>
          {err && <p className="msg err">{err}</p>}
        </div>
      )}
    </div>
  );
}
