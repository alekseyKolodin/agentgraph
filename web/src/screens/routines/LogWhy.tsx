// Раскрытая строка «Срабатываний»: почему сработало (или пропущено) и как исправить. Событие целиком, условия на поля
// по текущему правилу — каждое с тем, что было в событии, — «Если» и ответ проверки словами. Ниже — «Если» можно
// поправить и проверить на этом же событии до сохранения, затем сохранить правило; «Зря запустилась» — пример для
// следующих проверок. «Спросить Claude» — когда причина не в условиях, а в источнике: сервер собирает стартовый запрос
// (событие данными, проверка, YAML рутины и источника), UI открывает с ним обычную сессию в ручном режиме.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LogEntry, LogRecheck, RoutineSpec } from '@server/routines/types';
import { errorText, useConfig, useFeature } from '../../api';
import { askLog, explainLog, recheckLog, routineKeys, saveRoutine } from '../../api/routines';
import { createSession, defaultSessionCwd, sessionKeys } from '../../api/sessions';
import { useToast } from '../../components/Toast';
import { usd } from '../../lib/format';
import { t } from '../../lib/i18n';
import { feedbackLabel, feedbackNote, feedbackOptions, feedbackTitle, type Verdict } from '../../lib/routines/view';
import { cx } from './parts';
import styles from './Routines.module.css';

const TEXT_MAX = 600;

export function LogWhy({ e, slug, spec, busy, onFeedback }: { e: LogEntry; slug: string; spec?: RoutineSpec; busy: boolean; onFeedback: (v: Verdict) => void }) {
  const q = useQuery({ queryKey: ['routines', 'explain', slug, e.id], queryFn: () => explainLog(slug, e.id) });
  const qc = useQueryClient();
  const toast = useToast();
  const x = q.data;
  const [check, setCheck] = useState('');
  const [result, setResult] = useState<LogRecheck | null>(null);
  const [work, setWork] = useState<'' | 'check' | 'save'>('');
  useEffect(() => {
    if (x) setCheck(x.check ?? '');
  }, [x]);
  const ran = e.outcome === 'started' || e.outcome === 'waiting';
  const changed = check.trim() !== (x?.check ?? '');
  const recheck = async () => {
    setWork('check');
    setResult(null);
    try {
      setResult(await recheckLog(slug, e.id, check.trim()));
    } catch (err) {
      toast(errorText(err));
    } finally {
      setWork('');
    }
  };
  const save = async () => {
    if (!spec || !('source' in spec.when)) return;
    setWork('save');
    try {
      const text = check.trim();
      const { check: _, ...when } = spec.when;
      await saveRoutine(slug, { spec: { ...spec, when: text ? { ...when, check: text } : when } });
      await qc.invalidateQueries({ queryKey: routineKeys.all });
      toast(t('Правило сохранено: следующие события проверяются по новому «Если».'));
    } catch (err) {
      toast(errorText(err));
    } finally {
      setWork('');
    }
  };
  const fb = feedbackOptions(e);
  const askOn = useFeature('routine-ask');
  const sessionsOn = useFeature('sessions');
  const canAsk = askOn && sessionsOn;
  return (
    <div className={styles.lgDetail}>
      {q.isPending && <span className="muted">{t('Загрузка…')}</span>}
      {q.isError && <span className={styles.err}>{errorText(q.error)}</span>}
      {x && (
        <div className={styles.why}>
          <section aria-label={t('Событие')}>
            <span className={styles.lbl}>{t('Событие')}</span>
            <div className={styles.whyEvent}>
              <b>{x.event?.title || e.event.title || e.event.id}</b>
              {x.event?.author && <span className="muted">{` · ${x.event.author}`}</span>}
              {e.event.link && (
                <>
                  {' · '}
                  <a href={e.event.link} target="_blank" rel="noreferrer">{t('Открыть в источнике')} ↗</a>
                </>
              )}
              {x.event?.text && x.event.text !== x.event.title && <p className={styles.whyText}>{x.event.text.length > TEXT_MAX ? `${x.event.text.slice(0, TEXT_MAX)}…` : x.event.text}</p>}
              {!x.event && <p className="muted">{t('Текст события уже не хранится: видно только заголовок.')}</p>}
            </div>
          </section>

          <section aria-label={ran ? t('Почему сработало') : t('Почему пропущено')}>
            <span className={styles.lbl}>{ran ? t('Почему сработало') : t('Почему пропущено')}</span>
            {x.schedule ? (
              <p>{t('По расписанию: условий на события нет.')}</p>
            ) : (
              <>
                {x.conditions.length ? (
                  <ul className={styles.whyConds}>
                    {x.conditions.map((c) => (
                      <li key={c.key}>
                        <span className={c.ok ? styles.tOk : styles.tFail} aria-label={c.ok ? t('совпало') : t('не совпало')}>{c.ok ? '✓' : '✗'}</span>{' '}
                        <span className={styles.mono}>{`${c.key} ${c.op} «${c.want}»`}</span>
                        <span className="muted">{c.got ? t(' — в событии «{got}»', { got: c.got }) : t(' — в событии поля нет')}</span>
                      </li>
                    ))}
                  </ul>
                ) : x.event ? (
                  <p>{t('Условий на поля нет: подходит любое событие источника.')}</p>
                ) : null}
                {x.check ? (
                  <p>
                    {t('Если: «{check}»', { check: x.check })}
                    <br />
                    {x.answer ? t('Ответ проверки: {answer}', { answer: x.answer }) : <span className="muted">{t('Ответ проверки при срабатывании не сохранился — проверь событие ещё раз ниже.')}</span>}
                  </p>
                ) : (
                  <p className={styles.warn}>{t('Проверки словами нет: запускается всё, что прошло условия. Напиши ниже, какие события запускать.')}</p>
                )}
              </>
            )}
            {e.reason && e.reason !== x.answer && <p className="muted">{e.reason}</p>}
            {e.costUsd ? <p className="muted">{t('Потрачено {usd}.', { usd: usd(e.costUsd) })}</p> : null}
          </section>

          {canAsk && <AskClaude slug={slug} logId={e.id} />}

          {!x.schedule && (
            <section aria-label={t('Исправить')}>
              <span className={styles.lbl}>{t('Исправить')}</span>
              <textarea
                className={styles.inp}
                rows={2}
                aria-label={t('Если')}
                placeholder={t('Запускать, только если… Например: в сообщении есть ссылка на MR и упомянут я')}
                value={check}
                onChange={(ev) => {
                  setCheck(ev.target.value);
                  setResult(null);
                }}
              />
              <div className={styles.inline}>
                <button type="button" className="btn small" disabled={!check.trim() || !x.event || work !== ''} title={t('Спросить проверку словами по этому тексту на этом событии; немного тратит модель')} onClick={() => void recheck()}>
                  {work === 'check' ? t('Проверяю…') : t('Проверить на этом событии')}
                </button>
                <button type="button" className={cx('btn small', changed && 'primary')} disabled={!changed || !spec || work !== ''} onClick={() => void save()}>
                  {work === 'save' ? t('Сохраняю…') : t('Сохранить «Если» в правило')}
                </button>
                {fb.map((v) => (
                  <button key={v} type="button" className="btn small ghost" disabled={busy} title={feedbackTitle(v)} onClick={() => onFeedback(v)}>
                    {feedbackLabel(v)}
                  </button>
                ))}
                {e.feedback && <span className={styles.fbNote}>{feedbackNote(e.feedback)}</span>}
                <span className={styles.barGap} />
                <Link to={`/routines/${encodeURIComponent(slug)}`}>{t('Условия на поля — в правиле')}</Link>
              </div>
              {result && (
                <p className={result.match && !result.duplicate ? styles.tOk : styles.tFail}>
                  {result.match && !result.duplicate ? t('С этим текстом запустилась бы: {why}', { why: result.reason }) : result.duplicate ? t('С этим текстом — повтор, не запустилась бы: {why}', { why: result.reason }) : t('С этим текстом не запустилась бы: {why}', { why: result.reason })}
                  {result.costUsd >= 0.005 && <span className="muted">{` · ${usd(result.costUsd)}`}</span>}
                </p>
              )}
              {!x.check && fb.length > 0 && <p className="muted">{t('Без «Если» отметка «Зря запустилась» ничего не изменит: она служит примером только для проверки словами.')}</p>}
            </section>
          )}
          {e.replied?.link && (
            <a href={e.replied.link} target="_blank" rel="noreferrer">{t('Ответ')}</a>
          )}
        </div>
      )}
    </div>
  );
}

/** «Спросить Claude»: вопрос по срабатыванию → сессия Claude со стартовым запросом от сервера, режим manual. */
function AskClaude({ slug, logId }: { slug: string; logId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const serverCwd = useConfig().data?.defaultCwd;
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ask = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await askLog(slug, logId, question.trim());
      const s = await createSession({ cwd: r.cwd ?? defaultSessionCwd(serverCwd), prompt: r.prompt, name: r.name, tags: [], saveState: false, permissionMode: 'manual' });
      qc.setQueryData(sessionKeys.one(s.id), s);
      void qc.invalidateQueries({ queryKey: sessionKeys.list });
      void navigate(`/sessions/${encodeURIComponent(s.id)}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <section aria-label={t('Спросить Claude')}>
      <span className={styles.lbl}>{t('Спросить Claude')}</span>
      <textarea
        className={styles.inp}
        rows={2}
        aria-label={t('Вопрос Claude')}
        placeholder={t('Например: почему это событие запустило рутину?')}
        value={question}
        maxLength={2000}
        onChange={(ev) => setQuestion(ev.target.value)}
      />
      <div className={styles.inline}>
        <button type="button" className="btn small" disabled={!question.trim() || busy} onClick={() => void ask()}>
          {busy ? t('Открываю…') : t('Спросить в сессии')}
        </button>
        <span className={styles.hint}>{t('Откроется сессия Claude с этим событием, рутиной и источником. Правки она только предложит.')}</span>
      </div>
      {error && <p className={styles.err}>{error}</p>}
    </section>
  );
}
