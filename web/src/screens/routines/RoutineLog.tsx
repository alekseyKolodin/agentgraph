// Срабатывания рутины (/routines/:slug/log, docs/routines/design/Log.dc.html): событие одной строкой — время, исход,
// заголовок, действие; клик по заголовку раскрывает «почему сработало и как исправить» (LogWhy). Сверху —
// фильтры-чипы по исходу со счётчиками и «за 7 дней · $».
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { LogEntry, RoutineSpec, RoutineWait } from '@server/routines/types';
import { errorText } from '../../api';
import { answerWait, routineKeys, runRoutine, sendFeedback, useRoutine, useRoutineLog, useRoutines } from '../../api/routines';
import { useToast } from '../../components/Toast';
import { useNow } from '../../components/useNow';
import { clock, usd } from '../../lib/format';
import { t } from '../../lib/i18n';
import { chipCounts, chipLabel, chipOf, feedbackLabel, feedbackNote, feedbackOptions, feedbackTitle, logAction, logTime, verdict, weekCost, type LogChip, type RunStatuses, type Verdict, waitButtons } from '../../lib/routines/view';
import { NotAvailable, useRunStatuses } from './RoutinesList';
import { LogWhy } from './LogWhy';
import { cx, RoutineHead } from './parts';
import styles from './Routines.module.css';

export function RoutineLog() {
  const slug = useParams().slug!;
  const one = useRoutine(slug);
  const log = useRoutineLog(slug);
  const waits = useRoutines().data?.waits ?? [];
  const runs = useRunStatuses();
  const now = useNow(60_000);
  const [chip, setChip] = useState<LogChip>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const entries = log.data ?? [];
  const rows = chip === 'all' ? entries : entries.filter((e) => chipOf(e.outcome) === chip);
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };
  return (
    <>
      <RoutineHead r={one.data} slug={slug} title={one.data?.spec.title || slug} />
      {log.isError && <NotAvailable error={log.error} />}
      {log.isPending && <p className="muted">{t('Загрузка…')}</p>}
      {log.data && (
        <>
          <div className={styles.filters}>
            <div className={styles.filters} role="group" aria-label={t('Показать')}>
              {chipCounts(entries).map((c) => (
                <button key={c.chip} type="button" className={styles.chip} aria-pressed={c.chip === chip} onClick={() => setChip(c.chip)}>
                  {chipLabel(c.chip)}
                  <span className={styles.mono}>{c.n}</span>
                </button>
              ))}
            </div>
            <span className={styles.barGap} />
            <span className={styles.mono} title={t('Сумма по срабатываниям за неделю: запуски и проверка словами')}>{t('за 7 дней · {usd}', { usd: usd(weekCost(entries, new Date(now))) })}</span>
          </div>
          <div>
            {rows.map((e) => (
              <Row key={e.id} e={e} slug={slug} spec={one.data?.spec} runs={runs} open={open.has(e.id)} onToggle={() => toggle(e.id)} now={new Date(now)} wait={waits.find((w) => w.routine === slug && w.event.id === e.event.id)} />
            ))}
            {!rows.length && <p className="muted">{entries.length ? t('За 7 дней таких событий не было.') : t('Срабатываний пока не было.')}</p>}
          </div>
        </>
      )}
    </>
  );
}

function Row({ e, slug, spec, runs, open, onToggle, now, wait }: { e: LogEntry; slug: string; spec?: RoutineSpec; runs: RunStatuses; open: boolean; onToggle: () => void; now: Date; wait?: RoutineWait }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const v = verdict(e, runs);
  // отложенное ожидание («Не сейчас») на главной не видно: решить его можно здесь
  const snoozed = e.outcome === 'waiting' && wait?.snoozedAt ? wait : undefined;
  // рутина без flow только заводит дела: запускать по строке нечего
  const act = snoozed ? { kind: 'resume' as const, label: waitButtons(snoozed).run, primary: true } : spec && !spec.run ? null : logAction(e, runs);
  const tone = { ok: styles.tOk, live: styles.tLive, wait: styles.tWait, fail: styles.tFail, off: '', muted: '' }[v.tone];
  const feedback = async (v: Verdict) => {
    setBusy(true);
    try {
      await sendFeedback(slug, e.event.id, v);
      // отметка сразу, не дожидаясь события
      qc.setQueryData<LogEntry[]>(routineKeys.log(slug, ''), (list) => list?.map((x) => (x.id === e.id ? { ...x, feedback: v } : x)));
      void qc.invalidateQueries({ queryKey: routineKeys.all });
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const onAct = async () => {
    if (!act) return;
    if (act.kind === 'open') return void navigate('/');
    if (act.kind === 'run') return void navigate(`/run/${e.runId}`);
    setBusy(true);
    if (act.kind === 'resume' && snoozed) {
      try {
        const res = await answerWait(snoozed.id, { action: 'run' });
        void qc.invalidateQueries({ queryKey: routineKeys.all });
        if (res.runId) void navigate(`/run/${res.runId}`);
      } catch (err) {
        toast(errorText(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const res = await runRoutine(slug, e.event.id);
      void qc.invalidateQueries({ queryKey: routineKeys.all });
      if (res.runId) void navigate(`/run/${res.runId}`);
      else toast(t('Событие ждёт тебя на главной.'), () => void navigate('/'));
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx(styles.lg, e.outcome === 'waiting' && styles.wait)}>
      <span className={styles.mono} title={clock(e.at, now)}>{logTime(e.at, now)}</span>
      <span className={cx(styles.lgV, tone)}>{v.text}</span>
      <button type="button" className={styles.ev} aria-expanded={open} title={e.event.title} onClick={onToggle}>
        {e.event.title || e.event.id}
      </button>
      <span className={styles.lgActs}>
        {/* раскрытая строка показывает их в «Исправить» */}
        {!open && e.feedback && <span className={styles.fbNote}>{feedbackNote(e.feedback)}</span>}
        {!open && feedbackOptions(e).map((v) => (
          <button key={v} type="button" className="btn small ghost" disabled={busy} title={feedbackTitle(v)} onClick={() => void feedback(v)}>
            {feedbackLabel(v)}
          </button>
        ))}
        {act && (
          <button type="button" className={cx('btn small', act.primary ? 'primary' : 'ghost')} disabled={busy} title={act.kind === 'start' ? t('Запустить рутину по этому событию') : undefined} onClick={() => void onAct()}>
            {act.label}
          </button>
        )}
      </span>
      {open && <LogWhy e={e} slug={slug} spec={spec} busy={busy} onFeedback={(v) => void feedback(v)} />}
    </div>
  );
}
