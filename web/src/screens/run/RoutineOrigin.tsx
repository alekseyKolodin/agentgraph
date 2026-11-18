// Запуск начат рутиной: какая рутина, по какому событию (ссылка на него в сервисе), почему подошло — ответ проверки
// словами из журнала рутины — и «Зря запустилась»: пример для следующих проверок, как кнопка в журнале.
import { useState } from 'react';
import { Link } from 'react-router';
import type { RunSource } from '@server/api-types';
import type { LogEntry } from '@server/routines/types';
import { errorText, useFeature } from '../../api';
import { routineKeys, sendFeedback, useRoutineLog, useRoutines } from '../../api/routines';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { feedbackLabel, feedbackNote, feedbackTitle } from '../../lib/routines/view';
import styles from './Run.module.css';

export function RoutineOrigin({ runId, source }: { runId: string; source: RunSource }) {
  const on = useFeature('routines');
  const slug = source.key;
  const title = useRoutines(on).data?.routines.find((r) => r.slug === slug)?.spec.title ?? slug;
  const log = useRoutineLog(on ? slug : undefined).data;
  const entry = log?.find((e) => e.runId === runId);
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const link = source.url || entry?.event.link;
  const event = source.title || entry?.event.title || '';
  const why = entry?.why?.trim() || (entry ? t('событие подошло под условия правила') : '');
  const mark = async (e: LogEntry) => {
    setBusy(true);
    try {
      await sendFeedback(slug, e.event.id, 'no_match');
      qc.setQueryData<LogEntry[]>(routineKeys.log(slug, ''), (list) => list?.map((x) => (x.id === e.id ? { ...x, feedback: 'no_match' } : x)));
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.routineOrigin} role="note" aria-label={t('Откуда запуск')}>
      <span>
        {t('Запустила рутина')}{' '}
        <Link to={`/routines/${encodeURIComponent(slug)}/log`} title={t('Журнал срабатываний рутины')}>{title}</Link>
      </span>
      {event && (
        <span className={styles.originEvent}>
          {t('по событию')}{' '}
          {link ? (
            <a href={link} target="_blank" rel="noopener" title={t('Открыть событие в сервисе: {link}', { link })}>«{event}» ↗</a>
          ) : (
            <span title={t('Источник не отдаёт ссылку на событие')}>«{event}»</span>
          )}
        </span>
      )}
      {why && <span className={styles.originWhy}>{t('Почему: {why}', { why })}</span>}
      {entry?.feedback ? (
        <span className="muted">{feedbackNote(entry.feedback)}</span>
      ) : (
        entry && (
          <button type="button" className="btn small ghost" disabled={busy} title={feedbackTitle('no_match')} onClick={() => void mark(entry)}>
            {feedbackLabel('no_match')}
          </button>
        )
      )}
    </div>
  );
}
