// Рутины на главной (docs/routines/design/Home.dc.html): карточка ожидания — рутина ждёт решения («Чинить: …?»): событие,
// где стоит запуск, черновик ответа наружу с галочкой (уходит вместе с решением), «Чинить / Не сейчас / Это не баг».
// Над кнопками — что агент уже сделал (context: тикет, критерии, причина). Решение уходит через 5 секунд: до этого строка
// решения и всплывашка с «Отменить» (routineDecisions.ts). Строка «догнать»: что пришло, пока приложение было закрыто.
// Над карточками — сломанные источники рутин (не отвечает, молчит дольше обычного, нет ключа): рутины их не видят.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { CatchUp, RoutineView, RoutineWait, SourceView } from '@server/routines/types';
import { errorText } from '../../api';
import { answerCatchUp, routineKeys } from '../../api/routines';
import { MdText } from '../../components/MdText';
import { useToast } from '../../components/Toast';
import { ago, clock, excerpt } from '../../lib/format';
import { plural, t } from '../../lib/i18n';
import { brokenSources, catchUpLine, catchUpRunLabel, catchUpText, decisionText, replySent, waitButtons, type BrokenSource } from '../../lib/routines/view';
import { bindDecisions, decide, dismiss, isSent, undo, useDecisions } from './routineDecisions';
import styles from './RoutineWaits.module.css';

export function RoutineHome({ waits, catchUp, sources = [], routines = [], now }: { waits: RoutineWait[]; catchUp: CatchUp[]; sources?: SourceView[]; routines?: RoutineView[]; now: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => bindDecisions(qc, toast), [qc, toast]);
  const { lines, hidden } = useDecisions();
  // решённые карточки прячем сразу: решение ждёт 5 секунд или уже ушло
  const shown = waits.filter((w) => !hidden.has(w.id));
  const broken = brokenSources(sources, new Date(now), routines);
  if (!shown.length && !lines.length && !catchUp.length && !broken.length) return null;
  return (
    <div className={styles.routines}>
      {broken.map((b) => (
        <BrokenRow key={b.slug} b={b} />
      ))}
      {shown.map((w) => (
        <WaitCard key={w.id} w={w} now={now} />
      ))}
      {lines.map((d) => (
        <div key={d.id} className={styles.decided} role="status">
          <span className={`${styles.dot} ${d.run ? styles.live : styles.off}`} aria-hidden="true" />
          <span>{d.text}</span>
          <span className={styles.gap} />
          {d.state === 'pending' ? (
            <button type="button" className="btn small ghost" title={t('Решение уйдёт через несколько секунд — до этого его можно отменить')} onClick={() => undo(d.id)}>{t('Отменить', undefined, 'undo')}</button>
          ) : (
            <button type="button" className="btn small ghost" aria-label={t('Скрыть')} title={t('Скрыть')} onClick={() => dismiss(d.id)}>×</button>
          )}
        </div>
      ))}
      {catchUp.length > 0 && <CatchUpRow list={catchUp} />}
    </div>
  );
}

/** Источник рутин сломан: строка с причиной и переходом к источникам — пока он не починен, рутины его событий не видят. */
function BrokenRow({ b }: { b: BrokenSource }) {
  const fail = b.tone === 'fail';
  return (
    <div className={`${styles.broken} ${fail ? styles.brokenFail : ''}`} role="status">
      <span className={`${styles.dot} ${fail ? styles.fail : styles.wait}`} aria-hidden="true" />
      <span className={styles.brokenText}>
        <span className={styles.brokenName}>{b.text}</span>
        {b.detail && <span className={styles.brokenDetail}> · {b.detail}</span>}
      </span>
      <span className={styles.brokenMeta} title={t('Рутины на этом источнике не получают событий, пока его не починить')}>
        {b.routines} {plural(b.routines, 'рутина', 'рутины', 'рутин')}
      </span>
      <Link className="btn small ghost" to="/routines" title={t('Открыть рутины и источники')}>{t('Источники')}</Link>
    </div>
  );
}

function WaitCard({ w, now }: { w: RoutineWait; now: number }) {
  const toast = useToast();
  const [reply, setReply] = useState(true);
  const [draft, setDraft] = useState(w.replyDraft?.text ?? '');
  const [editing, setEditing] = useState(false);
  const b = waitButtons(w);
  const e = w.event;
  const choose = (action: 'run' | 'later' | 'reject') => {
    // «Ответ готов»: отправка — это и есть решение; иначе ответ уходит с решением, если галочка стоит
    const send = replySent(action, w, reply);
    const text = decisionText(action, w, send);
    decide(w, { action, ...(w.replyDraft ? { reply: { send, ...(send && draft !== w.replyDraft.text ? { text: draft } : {}) } } : {}) }, text);
    toast(`${text} ${t('Отменить?')}`, () => {
      if (!undo(w.id) && isSent(w.id)) toast(t('Решение уже ушло.'));
    });
  };
  const said = excerpt(e.text, 400);
  return (
    <section className={styles.card} aria-label={t('Ждёт тебя')}>
      <div className={styles.head}>
        <Link className={styles.src} to={`/routines/${encodeURIComponent(w.routine)}/log`} title={t('Открыть срабатывания рутины')}>↯ {w.routineTitle}</Link>
        <span className={styles.gap} />
        <span className={styles.waited}>{t('ждёт {t}', { t: ago(w.at, now) })}</span>
      </div>
      <div className={styles.body}>
        <h2 className={styles.q}>{w.question}</h2>
        {said && (
          <p className={styles.said}>
            {[e.author, clock(e.at, new Date(now))].filter(Boolean).join(', ')}: {t('«{text}»', { text: said })}
            {e.link && (
              <>
                {' '}
                <a href={e.link} target="_blank" rel="noreferrer">{t('открыть')}</a>
              </>
            )}
          </p>
        )}
        {w.kind === 'reply' && w.runId && (
          <p className={styles.where}>
            {t('Запуск закончился, ответ ждёт твоей проверки.')} <Link to={`/run/${w.runId}`}>{t('Открыть запуск')}</Link>
          </p>
        )}
        {w.kind === 'pause' && w.runId && (
          <p className={styles.where}>
            {w.block ? t('Запуск стоит перед блоком «{block}».', { block: w.block }) : t('Запуск стоит на паузе.')}{' '}
            <Link to={`/run/${w.runId}`}>{t('Открыть запуск')}</Link>
          </p>
        )}
      </div>
      {w.context && (
        <div className={styles.context}>
          <MdText text={w.context} />
        </div>
      )}
      {w.replyDraft && (
        <div className={styles.reply}>
          <label className={styles.check}>
            {w.kind !== 'reply' && <input type="checkbox" checked={reply} onChange={() => setReply(!reply)} />}
            <span>
              <span className={styles.replyLbl}>{t('Ответить {where}:', { where: w.replyDraft.where })}</span>{' '}
              {!editing && <span className={styles.replyText}>{t('«{text}»', { text: draft })}</span>}
            </span>
          </label>
          {/* правка не схлопывается по blur: иначе кнопки под ней уезжают между mousedown и mouseup, и клик «Чинить» теряется */}
          {editing ? (
            <>
              <textarea className={styles.edit} rows={3} aria-label={t('Текст ответа')} value={draft} autoFocus onChange={(ev) => setDraft(ev.target.value)} />
              <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>{t('Готово')}</button>
            </>
          ) : (
            <button type="button" className="btn small ghost" onClick={() => setEditing(true)}>{t('Поправить')}</button>
          )}
        </div>
      )}
      <div className="row">
        <button type="button" className="btn primary" onClick={() => choose('run')}>{b.run}</button>
        <button type="button" className="btn" title={t('Запуск подождёт в срабатываниях рутины')} onClick={() => choose('later')}>{b.later}</button>
        <button type="button" className="btn ghost" title={t('Рутина запомнит и учтёт в проверке словами')} onClick={() => choose('reject')}>{b.reject}</button>
      </div>
    </section>
  );
}

function CatchUpRow({ list }: { list: CatchUp[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const all = async (action: 'run' | 'skip') => {
    setBusy(true);
    try {
      for (const c of list) await answerCatchUp(c.id, action);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: routineKeys.all });
    }
  };
  return (
    <div className={styles.catch}>
      <div className={styles.catchHead}>
        <span>{catchUpText(list)}</span>
        <span className={styles.gap} />
        <button type="button" className="btn small ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('Скрыть') : t('Показать')}</button>
        <button type="button" className="btn small" disabled={busy} onClick={() => void all('run')}>{catchUpRunLabel(list)}</button>
        <button type="button" className="btn small ghost" disabled={busy} aria-label={t('Не запускать')} title={t('Не запускать: в журнал как пропущенное')} onClick={() => void all('skip')}>×</button>
      </div>
      {open && (
        <div className={styles.catchList}>
          {list.map((c) => (
            <div key={c.id} className={styles.catchRow}>
              <span className={styles.mono}>{c.missedAt ? clock(c.missedAt) : `${c.matching}/${c.events}`}</span>
              <span>{catchUpLine(c, (iso) => clock(iso))}</span>
              <Link to={`/routines/${encodeURIComponent(c.routine)}/log`} className={styles.catchSrc}>{c.routineTitle}</Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
