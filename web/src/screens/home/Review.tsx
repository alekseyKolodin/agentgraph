// «Не доделано» на главной: недавние сессии разбирает модель (sonnet, POST /api/session-review) — по каждой «не доделано»,
// «последний шаг» или «готово», что осталось и с чего продолжить. Только по кнопке и с ценой заранее. Разбор идёт в модуле,
// а не в компоненте: уход с главной его не прерывает (деньги уже тратятся), вернулся — результат на месте. Результат и
// скрытые строки переживают перезагрузку (agentgraph.sessionReview). «Продолжить» — тот же разговор (--resume) или
// открытая сессия; «С чего продолжить» копируется — вставить первым сообщением.
import { useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionReviewEstimate, SessionReviewItem, SessionReviewReply } from '@server/api-types';
import { DraftError, errorText } from '../../api';
import { continueSession, estimateReview, putSession, reviewSessions, useSessions } from '../../api/sessions';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { costRange, reviewMeta, reviewRows, VERDICT_LABEL } from '../../lib/session-review';
import { LS } from '../../lib/storage';
import styles from './Home.module.css';

const KEY = 'agentgraph.sessionReview';
const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

type Phase = { kind: 'idle' } | { kind: 'estimating' } | { kind: 'confirm'; est: SessionReviewEstimate } | { kind: 'running'; since: number } | { kind: 'error'; text: string };
type Saved = { reply?: SessionReviewReply; hidden: string[] };

// ---------- модуль: разбор переживает уход с главной
const read = (): Saved => {
  const v = LS.get<Partial<Saved>>(KEY, {});
  return { ...(v.reply && Array.isArray(v.reply.items) ? { reply: v.reply } : {}), hidden: Array.isArray(v.hidden) ? v.hidden.filter((x) => typeof x === 'string') : [] };
};
let saved: Saved = read();
let phase: Phase = { kind: 'idle' };
let abort: AbortController | null = null;
let snap: { saved: Saved; phase: Phase } = { saved, phase };
const subs = new Set<() => void>();
const emit = () => {
  snap = { saved, phase };
  for (const fn of subs) fn();
};
const set = (p: Phase, s?: Saved) => {
  phase = p;
  if (s) {
    saved = s;
    LS.set(KEY, s);
  }
  emit();
};
const useReview = () =>
  useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => snap,
  );

async function estimate() {
  set({ kind: 'estimating' });
  try {
    set({ kind: 'confirm', est: await estimateReview() });
  } catch (err) {
    set({ kind: 'error', text: errorText(err) });
  }
}

async function run() {
  abort = new AbortController();
  set({ kind: 'running', since: Date.now() });
  try {
    const reply = await reviewSessions(() => {}, abort.signal);
    // новый разбор — скрытое прежде снова видно: модель посмотрела на сессии заново
    set({ kind: 'idle' }, { reply, hidden: [] });
  } catch (err) {
    const spent = err instanceof DraftError && err.failure.costUsd ? ` ${t('Потрачено: ${cost}', { cost: err.failure.costUsd.toFixed(2) })}` : '';
    set(abort?.signal.aborted ? { kind: 'idle' } : { kind: 'error', text: errorText(err) + spent });
  } finally {
    abort = null;
  }
}

const hide = (ids: string[]) => set(phase, { ...saved, hidden: [...new Set([...saved.hidden, ...ids])] });

export function Review() {
  const { saved: s, phase: p } = useReview();
  const list = useSessions(true).data;
  const rows = reviewRows(s.reply, s.hidden, list?.sessions);
  const busy = p.kind === 'estimating' || p.kind === 'running';
  // разбора ещё не было и сессий нет — блок не нужен
  if (!s.reply && list && !list.sessions.some((x) => x.turns > 0)) return null;

  return (
    <section className={styles.homeSec} aria-label={t('Не доделано')}>
      <div className={styles.reviewHead}>
        <h2 title={t('Модель читает последние ходы твоих сессий за две недели и говорит, где работа не доведена и с чего продолжить. Только по кнопке; ничего не меняет')}>
          {t('Не доделано')}
          {s.reply && <span className="muted small">{' · '}{reviewMeta(s.reply)}</span>}
        </h2>
        {p.kind === 'confirm' ? (
          <span className={styles.reviewAsk}>
            <span className="muted small">{t('сессий: {n} · sonnet · {cost}', { n: p.est.sessions, cost: costRange(p.est.low, p.est.high, p.est.ceiling) })}</span>
            {p.est.sessions > 0 ? (
              <button type="button" className="btn small primary" onClick={() => void run()}>{t('Разобрать')}</button>
            ) : (
              <span className="muted small">{t('разбирать нечего')}</span>
            )}
            <button type="button" className="btn small ghost" onClick={() => set({ kind: 'idle' })}>{t('Отмена')}</button>
          </span>
        ) : p.kind === 'running' ? (
          <span className={styles.reviewAsk}>
            <span className="muted small">{t('Модель читает сессии…')}</span>
            <button type="button" className="btn small ghost" onClick={() => abort?.abort()}>{t('Остановить')}</button>
          </span>
        ) : (
          <button type="button" className="btn small" disabled={busy} title={t('Сначала покажу цену; модель позовётся только после «Разобрать»')} onClick={() => void estimate()}>
            {s.reply ? t('Разобрать заново…') : t('Разобрать сессии…')}
          </button>
        )}
      </div>
      {p.kind === 'error' && <p className="msg err">{p.text}</p>}
      {!s.reply && p.kind === 'idle' && <p className="muted small">{t('Забыл, где остановился? Модель пройдёт по недавним сессиям и скажет, что не доделано и с чего продолжить.')}</p>}
      {rows.open.length > 0 && (
        <ul className={styles.homeRuns}>
          {rows.open.map((x) => <ReviewRow key={x.id} x={x} live={Boolean(list?.sessions.find((v) => v.id === x.id)?.live)} stale={rows.stale.includes(x.id)} />)}
        </ul>
      )}
      {s.reply && !rows.open.length && <p className="muted small">{t('Всё доделано — или уже скрыто.')}</p>}
      {rows.done.length > 0 && (
        <p className={cx('muted small', styles.reviewDone)}>
          {t('Готово: {names}', { names: rows.done.map((x) => `«${x.name}»`).join(', ') })}{' '}
          <button type="button" className="btn small ghost" onClick={() => hide(rows.done.map((x) => x.id))}>{t('Убрать')}</button>
        </p>
      )}
    </section>
  );
}

function ReviewRow({ x, live, stale }: { x: SessionReviewItem; live: boolean; stale: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const to = `/sessions/${encodeURIComponent(x.id)}`;
  const resume = async () => {
    if (x.next) void navigator.clipboard?.writeText(x.next).catch(() => {});
    if (live) return void navigate(to);
    setBusy(true);
    try {
      putSession(qc, await continueSession(x.id));
      void navigate(to);
    } catch (err) {
      toast(errorText(err));
      setBusy(false);
    }
  };
  return (
    <li className={cx(styles.hrun, styles.review, x.verdict === 'continue' && styles.wait)}>
      <span className={styles.hrunDot} aria-hidden="true" />
      <div className={styles.hrunMain}>
        <div className={styles.hrunTop}>
          <Link to={to} className={styles.hrunTitle} title={x.name}>{x.name}</Link>
          <span className={cx(styles.verdict, x.verdict === 'continue' ? styles.vContinue : styles.vWrap)}>{VERDICT_LABEL[x.verdict]}</span>
          {x.space && <span className={styles.hrunMeta}>{x.space}</span>}
          {stale && <span className={styles.hrunMeta} title={t('После разбора в сессии были новые ходы: разбор мог устареть — «Разобрать заново…»')}>{t('после разбора были ходы')}</span>}
        </div>
        {x.left && <span className={styles.reviewLine}><span className="muted">{t('Осталось:')}</span> {x.left}</span>}
        {x.next && <span className={cx(styles.reviewLine, styles.reviewNext)} title={t('Скопируется при «Продолжить» — вставь первым сообщением')}>› {x.next}</span>}
        {!x.left && x.done && <span className={styles.reviewLine}>{x.done}</span>}
      </div>
      <span className={styles.reviewActs}>
        <button type="button" className="btn small" disabled={busy} title={live ? t('Сессия открыта — перейти в неё') : t('Тот же разговор (claude --resume); «с чего продолжить» — в буфере обмена')} onClick={() => void resume()}>
          {live ? t('Открыть') : t('Продолжить')}
        </button>
        <button type="button" className="btn small ghost" aria-label={t('Скрыть «{name}» из «Не доделано»', { name: x.name })} title={t('Скрыть до следующего разбора')} onClick={() => hide([x.id])}>×</button>
      </span>
    </li>
  );
}
