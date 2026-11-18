// «Рутины» (/routines, docs/routines/design/Main.dc.html и States.dc.html): список «источник → flow» с полоской последних
// срабатываний и переключателем паузы, сверху — полоса ожидания (рутина ждёт твоего решения на главной), снизу —
// подключённые источники с их состоянием («источник молчит», «нет ключа» — ключ вводится тут же). Рутин нет — что это
// такое и четыре шаблона.
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { RoutineView, RoutinesOverview, SourceKindView, SourceView } from '@server/routines/types';
import { ApiError, errorText, useConfig, useFeature, useRuns } from '../../api';
import { deleteSource, routineKeys, saveSource, setRoutineEnabled, testSource, useRoutines } from '../../api/routines';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { useNow } from '../../components/useNow';
import { ago, clock } from '../../lib/format';
import { plural, t } from '../../lib/i18n';
import { describeSchedule } from '../../lib/routines/schedule';
import { everyLabel, foundText } from '../../lib/routines/source';
import { activeWaits, overviewMeta, pollCostText, routineNote, routineState, routineSub, sourceState, stateLabel, stateTone, strip, type RunStatuses } from '../../lib/routines/view';
import { cx, Dot, EngineOwnerNote, Strip, Switch } from './parts';
import styles from './Routines.module.css';

/** Шаблоны пустого списка: ключ уходит в /routines/new?tpl=…, там выбирается подходящий источник. */
export const TEMPLATES = [
  { tpl: 'bug', title: 'Баг в канале → таска и фикс', sub: 'Сообщение в Slack или Telegram' },
  { tpl: 'mr', title: 'MR на ревью → замечания', sub: 'GitLab или GitHub' },
  { tpl: 'meeting', title: 'Встреча закончилась → задачи и итог', sub: 'Fireflies.ai или другой сервис' },
  { tpl: 'digest', title: 'Каждое утро → сводка', sub: 'Расписание' },
] as const;

/** Статусы запусков по id — для «идёт» и «не довёл» в полоске и журнале. */
export function useRunStatuses(): RunStatuses {
  const runs = useRuns();
  return useMemo(() => new Map((runs.data ?? []).map((r) => [r.id, r.status])), [runs.data]);
}

/**
 * Ошибка загрузки: сервер без рутин (нет фичи `routines`) — совет перезапустить; иначе — текст сервера («Рутина не
 * найдена» у удалённой рутины и т. п.).
 */
export function NotAvailable({ error }: { error: unknown }) {
  const config = useConfig();
  const on = useFeature('routines');
  if (config.isSuccess && !on) return <p className="muted">{t('Этот сервер ещё не умеет рутины — перезапусти UI-сервер.')}</p>;
  return <p className="error">{error instanceof ApiError && error.status === 404 && !error.message ? t('Рутина не найдена.') : errorText(error)}</p>;
}

export function RoutinesList() {
  const q = useRoutines();
  const runs = useRunStatuses();
  const now = useNow(30_000);
  const data = q.data;
  return (
    <>
      <header className="view-head">
        <div>
          <h1>{t('Рутины')}</h1>
          {data && data.routines.length > 0 && <p className={cx(styles.mono, styles.headMeta)}>{overviewMeta(data.routines, new Date(now), data.sources)}</p>}
        </div>
        {data && data.routines.length > 0 && (
          <div className="row">
            <Link className="btn" to="/routines/new">{t('Новая рутина')}</Link>
          </div>
        )}
      </header>
      <EngineOwnerNote />
      {q.isPending && <p className="muted">{t('Загрузка…')}</p>}
      {q.isError && <NotAvailable error={q.error} />}
      {data && (
        <>
          <WaitBand data={data} now={now} />
          {data.routines.length ? <List data={data} runs={runs} /> : <Empty />}
          <Sources sources={data.sources} kinds={data.kinds} />
        </>
      )}
    </>
  );
}

/**
 * Полоса ожидания: самое старое ожидание рутины — открыть его карточку на главной. Отложенные («Не сейчас») на главной
 * не видны: если ждут только они — полоса с пометкой «отложено» ведёт в срабатывания рутины, там их можно запустить.
 */
function WaitBand({ data, now }: { data: RoutinesOverview; now: number }) {
  const byAge = [...data.waits].sort((a, b) => a.at.localeCompare(b.at));
  const active = activeWaits(byAge);
  const w = active[0] ?? byAge[0];
  if (!w) return null;
  const snoozed = byAge.length - active.length;
  const more = active.length - 1;
  return (
    <div className={cx(styles.band, w.snoozedAt && styles.bandSnoozed)} role="status">
      <Dot tone={w.snoozedAt ? 'off' : 'wait'} />
      <span className={styles.bandText} title={w.question}>{w.question}</span>
      <span className={styles.mono}>
        {w.routineTitle} · {ago(w.at, now)}
        {w.snoozedAt ? ` · ${t('отложено')}` : more > 0 ? ` · ${t('ещё {n}', { n: more })}` : ''}
        {!w.snoozedAt && snoozed > 0 ? ` · ${t('отложено: {n}', { n: snoozed })}` : ''}
      </span>
      {w.snoozedAt ? (
        <Link className="btn" to={`/routines/${encodeURIComponent(w.routine)}/log`}>{t('Срабатывания')}</Link>
      ) : (
        <Link className="btn primary" to="/">{t('Открыть')}</Link>
      )}
    </div>
  );
}

function List({ data, runs }: { data: RoutinesOverview; runs: RunStatuses }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = async (r: RoutineView, on: boolean) => {
    setBusy(r.slug);
    try {
      const next = await setRoutineEnabled(r.slug, on);
      qc.setQueryData<RoutinesOverview>(routineKeys.overview, (d) => (d ? { ...d, routines: d.routines.map((x) => (x.slug === r.slug ? next : x)) } : d));
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: routineKeys.all });
    }
  };
  return (
    <ul className={styles.list} aria-label={t('Рутины')}>
      {data.routines.map((r) => {
        const st = routineState(r, data.sources, data.waits, runs);
        const src = 'source' in r.spec.when ? data.sources.find((s) => s.slug === (r.spec.when as { source: string }).source) : undefined;
        const on = r.spec.enabled !== false;
        const sub = routineSub(r, data.sources, describeSchedule);
        const rn = routineNote(st, r, src);
        const noteCls = rn?.tone === 'fail' ? styles.bad : rn?.tone === 'wait' ? styles.ask : styles.mute;
        const note = rn ? <span className={noteCls}> · {rn.text}</span>
          : st === 'paused' ? ` · ${t('на паузе')}`
          : st === 'draft' ? ` · ${t('черновик')}`
          : st === 'waiting' ? <span className={styles.ask}> · {t('ждёт тебя')}</span>
          : '';
        return (
          <li key={r.slug} className={cx(styles.rrow, !on && styles.paused)}>
            <Dot tone={stateTone(st)} title={stateLabel(st)} />
            <span className={styles.rmain}>
              <Link className={styles.rname} to={`/routines/${encodeURIComponent(r.slug)}`} title={`${r.spec.title}\n${stateLabel(st)}${r.stats.lastAt ? `\n${t('Последнее событие: {at}', { at: clock(r.stats.lastAt) })}` : ''}`}>
                {r.spec.title || r.slug}
              </Link>
              <span className={styles.rsub}>
                {sub}
                {note}
              </span>
            </span>
            <Link to={`/routines/${encodeURIComponent(r.slug)}/log`} className={styles.racts} title={t('Срабатывания')} tabIndex={-1}>
              <Strip ticks={strip(r.recent, runs)} />
            </Link>
            <Switch
              on={on}
              disabled={busy === r.slug}
              label={on ? t('Поставить на паузу «{name}»', { name: r.spec.title }) : t('Включить «{name}»', { name: r.spec.title })}
              onChange={(v) => void toggle(r, v)}
            />
          </li>
        );
      })}
    </ul>
  );
}

function Empty() {
  return (
    <section className={styles.empty} aria-label={t('Пустой список')}>
      <p>{t('Рутина запускает flow, когда что-то происходит: пришло сообщение, в сервисе появилось новое, наступило время.')}</p>
      <div className={styles.tpls}>
        {TEMPLATES.map((x) => (
          <Link key={x.tpl} className={styles.tpl} to={`/routines/new?tpl=${x.tpl}`}>
            <b>{t(x.title)}</b>
            <span>{t(x.sub)}</span>
          </Link>
        ))}
      </div>
      <Link className="btn primary" to="/routines/new">{t('Новая рутина')}</Link>
    </section>
  );
}

/** Подключённые источники: состояние, ошибка, ключ на месте, проверка и удаление. */
function Sources({ sources, kinds }: { sources: SourceView[]; kinds: SourceKindView[] }) {
  const navigate = useNavigate();
  return (
    <section className={styles.sec} id="sources" aria-labelledby="sources-h">
      <div className={styles.secHead}>
        <h2 id="sources-h">{t('Источники')}</h2>
        <button type="button" className="btn small" onClick={() => void navigate('/routines/connect')}>{t('Подключить сервис')}</button>
      </div>
      {sources.length ? (
        <ul className={styles.list}>
          {sources.map((s) => (
            <SourceRow key={s.slug} s={s} kind={kinds.find((k) => k.kind === s.spec.kind)} />
          ))}
        </ul>
      ) : (
        <p className="muted small">{t('Источников пока нет. Расписанию источник не нужен.')}</p>
      )}
    </section>
  );
}

function SourceRow({ s, kind }: { s: SourceView; kind: SourceKindView | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const missing = s.missingSecrets;
  const cost = pollCostText(s);
  const ss = sourceState(s);
  const tone = ss.tone;
  const meta = [kind?.title ?? s.spec.kind, s.spec.every ? everyLabel(s.spec.every) : kind?.delivery === 'live' ? t('сразу') : '', s.check?.ok ? t('проверен {at}, {n} {w}', { at: clock(s.check.at), n: s.check.total, w: plural(s.check.total, 'запись', 'записи', 'записей') }) : s.lastCheckAt && !s.check ? t('проверен {at}', { at: clock(s.lastCheckAt) }) : '', s.usedBy.length ? t('рутин: {n}', { n: s.usedBy.length }) : '', cost]
    .filter(Boolean)
    .join(' · ');
  const done = () => void qc.invalidateQueries({ queryKey: routineKeys.all });
  const saveKey = async () => {
    const name = missing[0];
    if (!name || !key.trim()) return;
    setBusy(true);
    try {
      await saveSource(s.slug, s.spec, { [name]: key.trim() });
      setKey('');
      done();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    try {
      const r = await testSource(s.spec);
      toast(r.ok ? `${s.spec.title}: ${foundText(r.total)}` : `${s.spec.title}: ${r.error ?? t('не отвечает')}`);
      done();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await askConfirm(t('Удалить источник «{name}»? Файл источника удалится, ключи останутся.', { name: s.spec.title }), { ok: t('Удалить'), danger: true }))) return;
    try {
      await deleteSource(s.slug);
      done();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? t('Источник используют рутины: {list}', { list: s.usedBy.join(', ') }) : errorText(e));
    }
  };
  return (
    <li className={styles.srow}>
      <Dot tone={tone} />
      <span className={styles.rmain}>
        <span className={styles.rname}>{s.spec.title}</span>
        <span className={styles.rsub}>
          {meta}
          {ss.note && <span className={ss.tone === 'fail' ? styles.bad : ss.tone === 'wait' ? styles.ask : styles.mute}> · {ss.note}</span>}
        </span>
      </span>
      <span className="row">
        <button type="button" className="btn small ghost" disabled={busy} title={t('Проверить источник сейчас: без модели')} onClick={() => void check()}>{t('Проверить')}</button>
        <button type="button" className="btn small ghost danger" title={t('Удалить источник')} onClick={() => void remove()}>{t('Удалить')}</button>
      </span>
      {missing.length > 0 && (
        <form
          className={styles.skey}
          onSubmit={(e) => {
            e.preventDefault();
            void saveKey();
          }}
        >
          <span className={styles.warn}>{t('Нужен ключ {name}', { name: missing[0]! })}</span>
          <input className={cx(styles.inp, styles.mono)} type="password" autoComplete="off" placeholder={t('Вставь ключ')} aria-label={t('Ключ {name}', { name: missing[0]! })} value={key} onChange={(e) => setKey(e.target.value)} />
          <button type="submit" className="btn small" disabled={busy || !key.trim()}>{t('Сохранить и проверить')}</button>
        </form>
      )}
    </li>
  );
}
