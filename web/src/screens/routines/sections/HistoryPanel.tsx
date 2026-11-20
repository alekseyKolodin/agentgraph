// Липкая панель «Проверка на N последних событиях» справа от разделов (Editor.dc.html): последние события источника
// против правила как оно есть в форме. Сверху — «14 из 30 запустилось бы» и оценка в неделю, под ним воронка полосками
// (пришло → условия по полям → ИИ), «правило поменялось — проверь снова», строки запуск/пропуск с причинами, «Учесть»
// при расхождении с прошлым ответом, «Показать все» и «Что получит flow». Пока проверка идёт, проверенные события
// видны сразу, ниже — «смотрю дальше»: модель читает события по несколько, это минуты.
// Без slug — проверка черновика «Новой рутины» до сохранения (/api/routines/form-draft/history/runs): по spec формы, без
// «Учесть» — прошлых ответов у несохранённой рутины нет.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HistoryCheck, HistoryRun } from '@server/routines/types';
import { errorText } from '../../../api';
import { fetchHistoryRun, FORM_DRAFT_HISTORY, sendFeedback, startHistory } from '../../../api/routines';
import { useToast } from '../../../components/Toast';
import { plural, t } from '../../../lib/i18n';
import type { CheckedHistory } from '../../../lib/routines/editor';
import type { buildSpec } from '../../../lib/routines/spec';
import { estimateText, historyVerdict, taskVerdict, type Verdict } from '../../../lib/routines/view';
import { cx } from '../parts';
import r from '../Routines.module.css';
import s from './Sections.module.css';

const HISTORY_LIMIT = 30;
/** Как часто экран спрашивает, что проверка на истории уже проверила. */
const HISTORY_POLL_MS = 700;

/** Вкладка браузера: проверка черновика из соседней вкладки не останавливает эту (ключ черновика на сервере общий). */
const TAB = Math.random().toString(36).slice(2, 12) || 'tab';

/** Ключ итога проверки в кэше запросов; без slug — черновик «Новой рутины». */
export const historyCacheKey = (slug?: string) => ['routine-history', slug ?? FORM_DRAFT_HISTORY];

type Props = {
  /** Рутина; нет — черновик «Новой рутины», правило ещё не сохранено. */
  slug?: string;
  spec: ReturnType<typeof buildSpec>;
  /** «Fireflies.ai · записи встреч» или «расписания» — в подсказке шапки и в строке хода. */
  sourceTitle: string;
  /**
   * Последний итог проверки и правило, по которому она сделана (нет итога — null). Свежий ли он, экран считает сам при
   * отрисовке (freshHistory): так у счётчиков в разделах нет кадра с числами от прошлого правила.
   */
  onResult?: (r: CheckedHistory | null) => void;
  className?: string;
  /** Проверить самой при первом показе. Нет — только по кнопке (проверка словами тратит модель). */
  auto?: boolean;
  /** Проверять пока не на чем: вместо проверки — эта подсказка. */
  empty?: string;
  /** Строка под итогом: что значат эти числа. */
  note?: ReactNode;
};

export function HistoryPanel({ slug, spec, sourceTitle, onResult, className, auto = true, empty, note }: Props) {
  if (empty) {
    return (
      <aside className={cx(s.card, s.hist, className)} aria-label={t('Проверка на истории')}>
        <span className={s.lbl}>{t('Проверка на истории')}</span>
        <span className={s.meta}>{empty}</span>
      </aside>
    );
  }
  return <Check slug={slug} spec={spec} sourceTitle={sourceTitle} onResult={onResult} className={className} auto={auto} note={note} />;
}

function Check({ slug, spec, sourceTitle, onResult, className, auto, note }: Omit<Props, 'empty'>) {
  const toast = useToast();
  const qc = useQueryClient();
  // итог живёт в кэше запросов (ключ вне ['routines']): «Сохранить» монтирует редактор заново, и проверка не должна
  // уходить ещё раз — с проверкой словами это до 30 вызовов модели
  const cacheKey = historyCacheKey(slug);
  const target = slug ?? FORM_DRAFT_HISTORY;
  const cached = qc.getQueryData<{ res: HistoryCheck; spec: string }>(cacheKey);
  const [res, setRes] = useState<HistoryCheck | null>(cached?.res ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [all, setAll] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [checkedSpec, setCheckedSpec] = useState(cached?.spec ?? '');
  const key = JSON.stringify(spec);
  useEffect(() => {
    onResult?.(res ? { res, spec: checkedSpec } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, checkedSpec]);
  /** Идущая проверка: что уже проверено. */
  const [progress, setProgress] = useState<HistoryRun | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const run = async () => {
    setBusy(true);
    setError('');
    setProgress(null);
    try {
      // ушли с экрана — проверка на сервере идёт дальше; вернулись — startHistory отдаёт её же, а не начинает вторую
      let job = await startHistory(target, spec, HISTORY_LIMIT, slug ? undefined : TAB);
      while (job.state === 'working') {
        if (!alive.current) return;
        setProgress(job);
        await new Promise((ok) => window.setTimeout(ok, HISTORY_POLL_MS));
        job = await fetchHistoryRun(target, job.id);
      }
      if (!job.result) throw new Error(job.error || t('Проверка не удалась'));
      setRes(job.result);
      setCheckedSpec(key);
      qc.setQueryData(cacheKey, { res: job.result, spec: key });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  const learn = async (eventId: string, verdict: Verdict) => {
    if (!slug) return;
    setBusy(true);
    try {
      await sendFeedback(slug, eventId, verdict);
    } catch (e) {
      toast(errorText(e));
      setBusy(false);
      return;
    }
    await run();
  };
  // сама — только при первом открытии рутины; дальше — по кнопке
  useEffect(() => {
    if (!cached && auto) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  const live = busy ? progress : null;
  const events = live ? live.events : (res?.events ?? []);
  const withAi = 'check' in spec.when && Boolean(spec.when.check?.trim());
  const rows = events.map((e) => {
    const tv = taskVerdict(e.task);
    return { e, v: historyVerdict(e), task: tv && { ...tv, closed: e.task?.action === 'closed' } };
  });
  const runs = rows.filter((x) => x.v.run).length;
  const asks = rows.filter((x) => x.e.unsure).length;
  // запуски, «спросит» и расхождения видны всегда, остальные пропуски — по «Показать все»
  const hidden = rows.filter((x) => !x.v.run && !x.v.disagrees && !x.e.unsure);
  const shown = all ? rows : rows.filter((x) => x.v.run || x.v.disagrees || x.e.unsure);
  const stale = res && !live && checkedSpec !== key;
  const est = estimateText(res?.estimate);
  // рутина с делом: главное — сколько дел было бы на доске; запуски — рядом, если рутина ещё и запускает flow
  const tasks = res?.tasks;
  const f = !live ? res?.funnel : undefined;
  const steps = f
    ? [
        { label: t('пришло'), n: f.total, tone: '' },
        ...(f.fields.length ? [{ label: t('условия по полям'), n: f.matched, tone: s.fCond }] : []),
        ...(f.check !== undefined ? [{ label: t('ИИ: запустить'), n: Math.max(0, f.check - asks), tone: s.fRun }, ...(asks ? [{ label: t('ИИ: спросит тебя'), n: asks, tone: s.fAsk }] : [])] : []),
      ]
    : [];
  const previewTitle = res?.preview ? (events.find((e) => e.event.id === res.preview!.eventId)?.event.title ?? res.preview.eventId) : '';
  return (
    <aside className={cx(s.card, s.hist, className)} aria-label={t('Проверка на истории')}>
      <div className={s.row}>
        <span className={s.lbl} title={sourceTitle}>
          {live ? t('Проверяю на последних событиях') : res ? t('Проверка на {n} последних событиях', { n: events.length }) : t('Проверка на истории')}
        </span>
        <span className={s.gap} />
        <button type="button" className={cx('btn small', !stale && res ? 'ghost' : '')} disabled={busy} title={t('Прогнать правило по последним событиям источника. Проверка словами тратит немного модели')} onClick={() => void run()}>
          {busy ? t('Проверяю…') : res ? t('Проверить снова') : t('Проверить на истории')}
        </button>
      </div>
      {error && <span className={s.err}>{error}</span>}
      {(live ? live.total > 0 : res) && (
        <>
          <div className={s.row}>
            {live ? (
              <>
                <span className={s.big}>{t('{k} из {n}', { k: runs, n: events.length })}</span>
                <span className={s.meta}>{t('пока запустилось бы; проверено {k} из {n}', { k: events.length, n: live.total })}</span>
              </>
            ) : tasks !== undefined ? (
              <>
                <span className={s.big}>{t('{n} {w}', { n: tasks, w: plural(tasks, 'новое дело', 'новых дела', 'новых дел') })}</span>
                <span className={s.meta}>{t('было бы на доске')}</span>
                {spec.run && <span className={s.meta}>{t('запустилось бы {k} из {n}', { k: runs, n: events.length })}</span>}
              </>
            ) : (
              <>
                <span className={s.big}>{t('{k} из {n}', { k: runs, n: events.length })}</span>
                <span className={s.meta}>{t('запустилось бы')}</span>
              </>
            )}
            <span className={s.gap} />
            {!live && est && <span className={cx(s.meta, s.numText)} title={t('По средней стоимости прошлых запусков рутины или flow')}>{est}</span>}
          </div>
          {steps.length > 1 && (
            <div className={s.funnel} role="img" aria-label={steps.map((x) => `${x.label}: ${x.n}`).join(', ')}>
              {steps.map((x) => (
                <div key={x.label} className={s.fstep}>
                  <span>{x.label}</span>
                  <span className={cx(s.fbar, x.tone)} style={{ width: `${f!.total ? Math.max(1, Math.round((x.n / f!.total) * 100)) : 0}%` }} />
                  <span>{x.n}</span>
                </div>
              ))}
            </div>
          )}
          {!steps.length && asks > 0 && <span className={s.warn} title={t('События, в которых ИИ не уверен: они ждали бы тебя на главной')}>{t('спросит тебя: {n}', { n: asks })}</span>}
          {stale && <span className={s.warn}>{t('Правило поменялось после проверки: проверь снова')}</span>}
          {note && !live && <span className={s.meta}>{note}</span>}
          {!live && res && res.disagreements > 0 && (
            <span className={s.err}>{t('С твоими прошлыми ответами расходится {n} {w}.', { n: res.disagreements, w: plural(res.disagreements, 'событие', 'события', 'событий') })}</span>
          )}
          <div>
            {shown.map(({ e, v, task }) => (
              <div key={e.event.id} className={cx(r.dr, v.disagrees && r.bad)}>
                <span className={cx(r.drV, v.run && r.run, e.unsure && r.ask, task?.closed && r.closed)}>{e.unsure ? v.text : (task?.text ?? v.text)}</span>
                <span title={e.event.text}>{e.event.title || e.event.text}</span>
                {v.disagrees && e.past && slug && (
                  <button type="button" className={cx('btn small', r.drAct)} disabled={busy} title={t('Взять твой прошлый ответ в примеры проверки словами и проверить снова')} onClick={() => void learn(e.event.id, e.past!)}>
                    {t('Учесть')}
                  </button>
                )}
                {(task?.why || v.why) && <span className={cx(r.drWhy, v.disagrees && r.bad)}>{[task?.why, v.why].filter(Boolean).join(' · ')}</span>}
              </div>
            ))}
            {!live && !events.length && <span className={s.meta}>{t('Событий из источника пока нет: проверить не на чем.')}</span>}
          </div>
          <div className={s.btns}>
            {hidden.length > 0 && (
              <button type="button" className="btn small ghost" aria-expanded={all} onClick={() => setAll(!all)}>
                {all ? t('Скрыть пропущенные') : t('Показать все {n}', { n: rows.length })}
              </button>
            )}
            {!live && res?.preview && (
              <button type="button" className="btn small ghost" aria-expanded={previewOpen} title={t('Что получит flow — на событии «{title}»', { title: previewTitle })} onClick={() => setPreviewOpen(!previewOpen)}>
                {t('Что получит flow')}
              </button>
            )}
          </div>
          {previewOpen && !live && res?.preview && (
            <>
              <span className={s.meta}>{t('На событии «{title}»:', { title: previewTitle })}</span>
              <pre className={r.previewText}>{[res.preview.task ?? t('(задача из input flow)'), res.preview.event].join('\n\n')}</pre>
            </>
          )}
        </>
      )}
      {live && (
        <div className={s.progress} role="status">
          <span className={s.spinner} aria-hidden="true" />
          <span>
            {live.total === 0
              ? t('Читаю последние события {source}…', { source: sourceTitle })
              : withAi
                ? t('Смотрю дальше: осталось {n} из {total}. «ИИ рутины» читает события по несколько сразу; прочитанные раньше не перечитывает.', { n: live.total - events.length, total: live.total })
                : t('Смотрю дальше: осталось {n} из {total}.', { n: live.total - events.length, total: live.total })}
          </span>
        </div>
      )}
    </aside>
  );
}
