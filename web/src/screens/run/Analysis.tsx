// Карточка «Анализ flow» на вкладке «Обзор» завершённого запуска: кнопка запускает сессию модели (POST /api/runs/:id/analysis),
// результат — вердикт, рекомендации по серьёзности и таблица фактов по этапам; сохранённый анализ подгружается при открытии (GET).
// Состояние — на модуль, по id запуска: идущий анализ переживает уход со страницы, вернувшись, человек видит «Анализирую…».
import { useEffect, useState } from 'react';
import type { AnalysisSuggestion, RunAnalysis } from '@server/api-types';
import { ApiError, errorText, fetchAnalysis, runAnalysis, useFeature } from '../../api';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { analysisMeta, groupSuggestions, KIND_LABEL, phaseRows, VERDICT } from '../../lib/run/analysis';
import runStyles from './Run.module.css';
import styles from './Analysis.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

const HINT = t('Модель по фактам запуска предложит, какие этапы объединить, какие разбить, что поменять в условиях и инструментах.');

type Entry = { analysis: RunAnalysis | null; busy: boolean; loaded: boolean };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const entry = (id: string): Entry => entries.get(id) ?? { analysis: null, busy: false, loaded: false };
function patch(id: string, p: Partial<Entry>): void {
  entries.set(id, { ...entry(id), ...p });
  for (const fn of listeners) fn();
}

function useEntry(id: string): Entry {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return entry(id);
}

/** Раз в POLL_MS спрашиваем сохранённый анализ, пока он не появится (анализ идёт в другой вкладке) или не кончатся попытки. */
const POLL_MS = 3000;
const POLL_MAX = 100;
async function waitForAnalysis(runId: string): Promise<void> {
  const before = entry(runId).analysis?.at;
  for (let i = 0; i < POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const a = await fetchAnalysis(runId);
      if (a.at !== before) {
        patch(runId, { analysis: a, busy: false, loaded: true });
        return;
      }
    } catch {
      // ещё нет или сеть: пробуем дальше
    }
  }
  patch(runId, { busy: false });
}

export function Analysis({ runId }: { runId: string }) {
  const on = useFeature('run-analysis');
  const toast = useToast();
  const e = useEntry(runId);
  // сохранённый анализ — один раз на запуск; 404 missing — анализа ещё не было, это не ошибка
  useEffect(() => {
    if (!on || e.loaded || e.busy) return;
    patch(runId, { loaded: true });
    fetchAnalysis(runId)
      .then((a) => patch(runId, { analysis: a }))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) return;
        // сеть или 500: при следующем заходе на страницу спросим снова
        patch(runId, { loaded: false });
        toast(errorText(err));
      });
  }, [on, runId, e.loaded, e.busy, toast]);
  if (!on) return null;

  const start = async () => {
    patch(runId, { busy: true });
    try {
      const a = await runAnalysis(runId);
      patch(runId, { analysis: a, busy: false, loaded: true });
      if (a.error) toast(t('Анализ не удался: {error}', { error: a.error }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'busy') {
        // анализ запущен из другой вкладки: ждём его результат опросом, кнопка остаётся занятой
        toast(t('Анализ этого запуска уже идёт: покажу результат, когда он будет готов'));
        void waitForAnalysis(runId);
        return;
      }
      patch(runId, { busy: false });
      toast(errorText(err));
    }
  };

  const a = e.analysis;
  const groups = a ? groupSuggestions(a.suggestions) : [];
  return (
    <section className={cx(runStyles.card, styles.box)}>
      <div className={runStyles.head}>
        <span className={runStyles.title}>{t('Анализ flow')}</span>
        {a?.verdict && <span className={`badge ${VERDICT[a.verdict].cls}`} title={VERDICT[a.verdict].title}>{VERDICT[a.verdict].label}</span>}
        {a && <span className={runStyles.stats}>{analysisMeta(a)}</span>}
        <button type="button" className={cx('btn small', styles.headBtn, !a && !e.busy && 'primary')} disabled={e.busy} title={HINT} onClick={() => void start()}>
          {e.busy ? t('Анализирую…') : a ? t('Повторить') : t('Анализ flow')}
        </button>
      </div>
      {!a && !e.busy && <p className={styles.hint}>{HINT}</p>}
      {e.busy && <div className={styles.wait}><span className={styles.dot} />{t('Анализирую… модель читает факты запуска и flow, обычно это полминуты.')}</div>}
      {a?.error && <div className="error">{t('Модель не ответила: {error}. Факты по этапам ниже посчитаны без неё.', { error: a.error })}</div>}
      {a?.summary && <div className={styles.summary}>{a.summary}</div>}
      {groups.map((g) => (
        <div key={g.severity} className={styles.group}>
          <div className={styles.groupHead}>{g.label}</div>
          {g.items.map((s, i) => <Suggestion key={i} s={s} />)}
        </div>
      ))}
      {a?.verdict === 'keep' && !a.suggestions.length && <div className="muted small">{t('Правок не нужно: границы между этапами оправданы фактами запуска.')}</div>}
      {a && <Facts a={a} />}
    </section>
  );
}

function Suggestion({ s }: { s: AnalysisSuggestion }) {
  return (
    <div className={cx(styles.sug, styles[s.severity])}>
      <div className={styles.sugHead}>
        <span className={styles.kind}>{KIND_LABEL[s.kind]}</span>
        <span className={styles.sugTitle}>{s.title}</span>
        {s.phases.length > 0 && <span className={styles.phases}>{s.phases.map((p) => <code key={p}>{p}</code>)}</span>}
      </div>
      {s.why && <div className={styles.text}><b>{`${t('Почему:')} `}</b>{s.why}</div>}
      {s.how && <div className={styles.text}><b>{`${t('Как:')} `}</b>{s.how}</div>}
    </div>
  );
}

function Facts({ a }: { a: RunAnalysis }) {
  const rows = phaseRows(a.facts);
  const multi = a.facts.blockCount > 1;
  return (
    <details className={styles.facts}>
      <summary>{t('Факты по этапам · {n}', { n: rows.length })}</summary>
      <table>
        <thead>
          <tr>
            <th>{t('Этап')}</th>
            <th>{t('Инструменты')}</th>
            <th className={styles.num} title={t('Сколько раз этап выполнялся за запуск (по итерациям)')}>{t('Запусков')}</th>
            <th className={styles.num} title={t('Ходов в среднем / максимум, из лимита max_turns')}>{t('Ходов')}</th>
            <th className={styles.num} title={t('Максимум пика контекста по запускам этапа, доля окна модели')}>{t('Контекст')}</th>
            <th className={styles.num}>{t('Стоимость')}</th>
            <th className={styles.num}>{t('Время')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.block}/${r.name}`}>
              <td>
                <code>{r.name}</code>
                {r.title !== r.name && <span className="muted">{` ${r.title}`}</span>}
                {multi && <span className={styles.notes}>{` · ${r.block}`}</span>}
                {r.notes.length > 0 && <div className={styles.notes}>{r.notes.join(' · ')}</div>}
              </td>
              <td className={styles.tools}>{r.tools}{r.writer && <span title={t('Пишущий этап: Edit, Write или writes')}> ✎</span>}</td>
              <td className={styles.num}>{r.runs}</td>
              <td className={styles.num}>{r.turns}</td>
              <td className={cx(styles.num, r.ctx.level && styles[r.ctx.level])} title={r.ctx.title}>{r.ctx.text}</td>
              <td className={styles.num}>{r.cost}</td>
              <td className={styles.num}>{r.time}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
