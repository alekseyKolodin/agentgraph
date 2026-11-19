// «Новая рутина» (/routines/new, docs/routines/design/New.dc.html): четыре шага — что запускает (подключённый источник,
// расписание или «Другой сервис…»), какие записи (условия на поля, проверка словами, что пришло последним) или когда,
// что запустить (flow, пространство, папка, когда ждать меня), сообщать ли о результате. Сбоку — фраза-итог из выбора.
// «Дальше: проверка на истории» сохраняет рутину выключенной (черновиком) и открывает редактор с проверкой на истории.
// ?tpl= — шаблон из пустого списка, ?source= — источник, только что подключённый на «Подключить сервис».
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RoutinesOverview, SourceView } from '@server/routines/types';
import { errorText, useFeature, useFlows } from '../../api';
import { routineKeys, saveRoutine, testSource, useRoutines } from '../../api/routines';
import { useSpaces } from '../../api/spaces';
import { SpacePicker } from '../../components/SpacePicker';
import { useNow } from '../../components/useNow';
import { t } from '../../lib/i18n';
import { matchFields } from '../../lib/routines/match';
import { defaultTitle, eventNoun, replyHint, replyLabel, replyWhere, sentence, step2Title } from '../../lib/routines/phrase';
import { formatNext, nextRuns, PRESETS, presetLabel, toCron, type SchedulePreset } from '../../lib/routines/schedule';
import { foundRow } from '../../lib/routines/source';
import { buildSpec, draftMissing, emptyDraft, isSchedule, REPLY_CHOICES, SCHEDULE, slugify, type ReplyChoice, type RoutineDraft } from '../../lib/routines/spec';
import { NotAvailable } from './RoutinesList';
import { CwdField } from './CwdField';
import { Conditions, cx, Seg, useFlowBlocks, WaitClause } from './parts';
import styles from './Routines.module.css';

const MESSAGE_KINDS = ['slack', 'telegram'];
const CODE_KINDS = ['gitlab', 'github'];
const MEETING_RE = /fireflies|otter|granola|fathom|zoom|meet\b|meeting|transcript|встреч|созвон|транскрипт/i;

/** Источник встреч: Fireflies и подобные — по виду, названию и описанию источника (рецепт кладёт их в title/description). */
const isMeetingSource = (s: SourceView): boolean => MEETING_RE.test(`${s.spec.kind} ${s.spec.title} ${s.spec.description ?? ''}`);

/** Источник под шаблон пустого списка: бaг — чат, MR — код, встреча — сервис, сводка — расписание. */
function sourceForTemplate(tpl: string | null, sources: SourceView[]): string {
  if (tpl === 'digest') return SCHEDULE;
  const pick = (ok: (kind: string) => boolean) => sources.find((s) => ok(s.spec.kind))?.slug ?? '';
  if (tpl === 'bug') return pick((k) => MESSAGE_KINDS.includes(k));
  if (tpl === 'mr') return pick((k) => CODE_KINDS.includes(k));
  if (tpl === 'meeting') return sources.find(isMeetingSource)?.slug ?? '';
  return '';
}

/** Ссылка «Собрать новый flow…»: диалог «Новый flow» живёт в шапке списка Flow сайдбара (как «с чего начать» на главной). */
const sidebarNewFlow = () => document.querySelector<HTMLButtonElement>(`button[title="${CSS.escape(t('Создать flow'))}"]`);

export function NewRoutine() {
  const q = useRoutines();
  if (q.isError) return <NotAvailable error={q.error} />;
  if (!q.data) return <p className="muted">{t('Загрузка…')}</p>;
  return <NewForm data={q.data} />;
}

function NewForm({ data }: { data: RoutinesOverview }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const tpl = params.get('tpl');
  const [d, setD] = useState<RoutineDraft>(() => {
    const base = emptyDraft();
    const source = params.get('source') ?? sourceForTemplate(tpl, data.sources);
    return { ...base, source, mode: source === SCHEDULE ? 'auto' : 'suggest', input: tpl === 'digest' ? t('Что в моих MR требует ответа сегодня') : '' };
  });
  const [titleEdited, setTitleEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<RoutineDraft>) => setD((x) => ({ ...x, ...patch }));

  const source = data.sources.find((s) => s.slug === d.source);
  // шаблон «Встреча…», а источника встреч нет: не подсовываем чужой сервис, зовём подключить Fireflies
  const needFireflies = tpl === 'meeting' && !d.source && !data.sources.some(isMeetingSource);
  const kind = source ? data.kinds.find((k) => k.kind === source.spec.kind) : undefined;
  const fields = useMemo(() => matchFields(kind), [kind]);
  const replyTargets = data.sources.filter((s) => s.canReply);
  const canReplySource = Boolean(source?.canReply);
  const srcInfo = source ? { title: source.spec.title, kind: source.spec.kind } : undefined;

  // куда отвечать: в источник, если он умеет; иначе — первый источник с ответом; некуда — «Не сообщать». «Не сообщать»,
  // поставленное здесь, а не человеком, снимается, как только отвечать снова есть куда
  const autoOff = useRef(false);
  useEffect(() => {
    if (!d.source) return;
    const back = autoOff.current && d.reply === 'off' ? { reply: 'draft' as const } : {};
    if (canReplySource || replyTargets[0]) {
      autoOff.current = false;
      set({ replyTo: canReplySource ? 'source' : replyTargets[0]!.slug, ...back });
    } else if (d.reply !== 'off') {
      autoOff.current = true;
      set({ reply: 'off' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.source]);

  const title = titleEdited ? d.title : defaultTitle(d, source?.spec.title);
  const missing = draftMissing(d);
  const missingText = missing.map((m) => ({ source: t('выбери, что запускает'), flow: t('выбери flow'), block: t('выбери блок, перед которым ждать'), kind: t('назови вид дела') })[m]).join(', ');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const spec = buildSpec({ ...d, title, enabled: false, draft: true }, fields);
      const slug = slugify(title, data.routines.map((r) => r.slug));
      await saveRoutine(slug, { spec });
      void qc.invalidateQueries({ queryKey: routineKeys.all });
      void navigate(`/routines/${encodeURIComponent(slug)}`);
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  return (
    <>
      <Link to="/routines" className={styles.back}>‹ {t('Рутины')}</Link>
      <header className="view-head">
        <h1>{t('Новая рутина')}</h1>
      </header>
      <div className={styles.newGrid}>
        <div>
          <Step n={1} id="s1" title={t('Что запускает')}>
            {needFireflies && (
              <span className={styles.hint}>
                {t('Источника встреч пока нет.')} <Link to="/routines/connect?from=new">{t('Подключить Fireflies.ai')}</Link> {t('(готовый рецепт, нужен ключ API) или выбери другой источник.')}
              </span>
            )}
            <div className={styles.picks} role="group" aria-labelledby="s1">
              {data.sources.map((s) => {
                const k = data.kinds.find((x) => x.kind === s.spec.kind);
                return (
                  <button key={s.slug} type="button" className={styles.pick} aria-pressed={d.source === s.slug} onClick={() => set({ source: s.slug, conds: [], check: '', mode: d.mode === 'auto' && isSchedule(d) ? 'suggest' : d.mode })}>
                    <b>{s.spec.title}</b>
                    <span>{s.spec.description || k?.summary || s.spec.kind}</span>
                  </button>
                );
              })}
              <button type="button" className={styles.pick} aria-pressed={isSchedule(d)} onClick={() => set({ source: SCHEDULE, conds: [], check: '', mode: 'auto' })}>
                <b>{t('Расписание')}</b>
                <span>{t('в заданное время')}</span>
              </button>
              <Link className={cx(styles.pick, styles.dashed)} to="/routines/connect?from=new">
                <b>{t('Другой сервис…')}</b>
                <span>{t('Опиши словами, что должно запускать')}</span>
              </Link>
            </div>
          </Step>
          <Step n={2} id="s2" title={isSchedule(d) ? t('Когда') : step2Title(source?.spec.kind)}>
            {isSchedule(d) ? <ScheduleStep d={d} set={set} /> : source ? <SourceStep d={d} set={set} source={source} fields={fields} kindTitle={kind?.title} /> : <span className={styles.hint}>{t('Сначала выбери, что запускает.')}</span>}
          </Step>
          <Step n={3} id="s3" title={t('Что запустить')}>
            <FlowStep d={d} set={set} />
          </Step>
          <Step n={4} id="s4" title={t('Сообщать о результате')}>
            <Seg<ReplyChoice> label={t('Сообщать о результате')} value={d.reply} onChange={(reply) => set({ reply })} options={REPLY_CHOICES.map((c) => ({ value: c, label: replyLabel(c), disabled: c !== 'off' && !canReplySource && !replyTargets.length }))} />
            {d.reply !== 'off' && (
              <div className={styles.sentence}>
                {t('Писать')}{' '}
                <select className={styles.slot} aria-label={t('Куда писать')} value={d.replyTo} onChange={(e) => set({ replyTo: e.target.value })}>
                  {canReplySource && <option value="source">{replyWhere(source?.spec.kind, 'source', data.sources)}</option>}
                  {replyTargets.filter((s) => s.slug !== d.source).map((s) => (
                    <option key={s.slug} value={s.slug}>{replyWhere(undefined, s.slug, data.sources)}</option>
                  ))}
                </select>
              </div>
            )}
            <span className={styles.hint}>{!canReplySource && !replyTargets.length && d.source ? (source?.spec.kind === 'connector' ? t('Отвечать некуда: у этого источника не выбран инструмент ответа. Ответить можно из flow — дай этапу инструмент коннектора; или подключи сервис заново с шагом «Как отвечать».') : t('Отвечать некуда: подключи Telegram или Slack, и рутина сможет писать туда.')) : replyHint(d.reply)}</span>
          </Step>
        </div>
        <aside className={styles.summary} aria-label={t('Что получится')}>
          <span className={styles.lbl}>{t('Получится')}</span>
          <p>{sentence(d, srcInfo, fields)}</p>
          <label className={styles.field}>
            <span className={styles.lbl}>{t('Название')}</span>
            <input
              className={styles.inp}
              value={title}
              onChange={(e) => {
                setTitleEdited(true);
                set({ title: e.target.value });
              }}
            />
          </label>
          <button type="button" className="btn primary" disabled={saving || missing.length > 0 || !title.trim()} title={missingText || undefined} onClick={() => void save()}>
            {t('Дальше: проверка на истории')}
          </button>
          {missing.length > 0 && <span className={styles.hint}>{missingText[0]!.toUpperCase() + missingText.slice(1)}.</span>}
          {error && <span className={styles.err}>{error}</span>}
          <span className={styles.hint}>{t('Рутина сохранится выключенным черновиком. На следующем экране — проверка на истории, остановки и лимиты, и там её можно включить.')}</span>
        </aside>
      </div>
    </>
  );
}

function Step({ n, id, title, children }: { n: number; id: string; title: string; children: ReactNode }) {
  return (
    <section className={styles.step} aria-labelledby={id}>
      <span className={styles.num}>{n}</span>
      <div className={styles.stepBody}>
        <h2 className={styles.sh} id={id}>{title}</h2>
        {children}
      </div>
    </section>
  );
}

type StepProps = { d: RoutineDraft; set: (p: Partial<RoutineDraft>) => void };

function ScheduleStep({ d, set }: StepProps) {
  const now = useNow(60_000);
  const next = formatNext(nextRuns(toCron(d.schedule), new Date(now), 3), new Date(now));
  return (
    <>
      <div className={styles.inline}>
        <Seg<SchedulePreset> label={t('Как часто')} value={d.schedule.preset} onChange={(preset) => set({ schedule: { ...d.schedule, preset } })} options={PRESETS.map((p) => ({ value: p, label: presetLabel(p) }))} />
        {d.schedule.preset !== 'hourly' && (
          <label className={styles.inline}>
            <span className={styles.lbl}>{t('Время')}</span>
            <input className={cx(styles.inp, styles.mono, styles.inlineSel)} type="time" value={d.schedule.time} onChange={(e) => set({ schedule: { ...d.schedule, time: e.target.value || '09:30' } })} />
          </label>
        )}
      </div>
      {next && <span className={styles.mono}>{t('Ближайшие: {list}', { list: next })}</span>}
      <label className={styles.field}>
        <span className={styles.lbl}>{t('Задача для flow')}</span>
        <input className={styles.inp} value={d.input} onChange={(e) => set({ input: e.target.value })} />
      </label>
      <span className={styles.hint}>{t('Работает, пока открыто приложение. Пропущенное время спросит один раз после запуска.')}</span>
    </>
  );
}

function SourceStep({ d, set, source, fields, kindTitle }: StepProps & { source: SourceView; fields: ReturnType<typeof matchFields>; kindTitle: string | undefined }) {
  const [checkOpen, setCheckOpen] = useState(Boolean(d.check));
  // что пришло последним: пробная проверка источника (без модели), раз на источник
  // ключ вне ['routines']: событие `routines` в общем потоке снимает весь префикс, а пробная проверка — это опрос
  // сервиса (у connector — сессия модели), повторять её на каждое событие нельзя
  const sample = useQuery({ queryKey: ['routine-sample', source.slug], queryFn: () => testSource(source.spec), staleTime: 5 * 60_000, retry: false });
  return (
    <>
      <Conditions conds={d.conds} fields={fields} onChange={(conds) => set({ conds })} lead={<>{t('Запускать')} {eventNoun(source.spec.kind)}</>} />
      {checkOpen ? (
        <label className={styles.field}>
          <span className={styles.lbl}>{t('Если')}</span>
          <textarea className={styles.inp} rows={3} value={d.check} placeholder={t('Например: это баг-репорт — описано, что сломалось. Вопросы и обсуждения не считаются.')} onChange={(e) => set({ check: e.target.value })} />
          <span className={styles.hint}>{t('Своими словами, необязательно. Повторы одного и того же отсеиваются сами.')}</span>
        </label>
      ) : (
        <div>
          <button type="button" className={cx(styles.slot, styles.add)} title={t('Отбор по смыслу: дешёвая модель читает текст события по этому условию')} onClick={() => setCheckOpen(true)}>
            {t('+ проверка словами')}
          </button>
        </div>
      )}
      <div className={styles.field}>
        <span className={styles.lbl}>{t('Последнее, что пришло из источника')}</span>
        {sample.isPending && <span className={styles.hint}>{t('Проверяю {source}…', { source: kindTitle ?? source.spec.title })}</span>}
        {sample.isError && <span className={styles.err}>{errorText(sample.error)}</span>}
        {sample.data && !sample.data.ok && <span className={styles.err}>{sample.data.error ?? t('Источник не ответил')}</span>}
        {sample.data?.ok && (
          <div className={styles.foundList}>
            {sample.data.sample.length ? (
              sample.data.sample.map((e) => {
                const r = foundRow(e);
                return (
                  <div key={e.id} className={styles.found}>
                    <span title={e.text}>{r.title}</span>
                    <span className={styles.mono}>{r.meta}</span>
                  </div>
                );
              })
            ) : (
              <span className={styles.hint}>{t('Пока пусто.')}</span>
            )}
          </div>
        )}
      </div>
      <span className={styles.hint}>{t('Эти записи не запустятся. Рутина начнёт с тех, что появятся после включения.')}</span>
    </>
  );
}

function FlowStep({ d, set }: StepProps) {
  const flows = useFlows();
  const spacesOn = useFeature('spaces');
  const spaces = useSpaces(spacesOn);
  const blocks = useFlowBlocks(d.flow);
  const [query, setQuery] = useState('');
  const valid = (flows.data ?? []).filter((f) => f.valid);
  const q = query.trim().toLowerCase();
  const shown = valid.filter((f) => !q || f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q));
  // выбранный flow всегда виден, даже вне первых шести
  const top = shown.slice(0, 6);
  const chosen = valid.find((f) => f.name === d.flow);
  if (chosen && !top.includes(chosen)) top.unshift(chosen);
  const openNewFlow = () => sidebarNewFlow()?.click();
  return (
    <>
      {valid.length > 6 && <input className={cx(styles.inp, styles.flowSearch)} type="search" placeholder={t('Найти flow')} aria-label={t('Найти flow')} value={query} onChange={(e) => setQuery(e.target.value)} />}
      <div className={styles.picks} role="group" aria-labelledby="s3">
        {top.map((f) => (
          <button key={f.name} type="button" className={styles.pick} aria-pressed={f.name === d.flow} onClick={() => set({ flow: f.name, pauseBefore: [], mode: d.mode === 'until_pause' ? 'suggest' : d.mode })}>
            <b>{f.name}</b>
            <span>{f.description || (f.blocks?.length ? t('{n} блоков', { n: f.blocks.length }) : t('без описания'))}</span>
          </button>
        ))}
        {flows.isPending && <span className={styles.hint}>{t('Загрузка…')}</span>}
        {flows.data && !shown.length && <span className={styles.hint}>{t('Ничего не нашлось.')}</span>}
      </div>
      <div className={styles.inline}>
        {spacesOn && <span>{t('в пространстве')}</span>}
        {spacesOn && <SpacePicker id="routine-space" value={d.space} onChange={(space) => set({ space })} options={spaces.data?.spaces ?? []} loading={spaces.isPending} label={t('в пространстве')} compact placeholder={t('без пространства')} className={styles.flowSearch} inputClassName={styles.slot} />}
        <span className={styles.barGap} />
        <button type="button" className="btn small ghost" title={t('Описать задачу словами — ИИ соберёт flow')} onClick={openNewFlow}>{t('Собрать новый flow…')}</button>
      </div>
      {!isSchedule(d) && (
        <div className={styles.field}>
          <span className={styles.lbl}>{t('Задача для flow')}</span>
          <textarea className={styles.inp} rows={2} aria-label={t('Задача для flow')} placeholder={t('Задача flow; событие дописывается к ней как данные')} value={d.input} onChange={(e) => set({ input: e.target.value })} />
          <span className={styles.hint}>{t('К задаче flow получит событие: заголовок, автора, ссылку, текст и поля. Передавать их отдельно не нужно: что именно придёт — «Что получит flow» в проверке справа.')}</span>
        </div>
      )}
      <div className={styles.field}>
        <span className={styles.lbl}>{t('Папка проекта')}</span>
        <CwdField value={d.cwd} onChange={(cwd) => set({ cwd })} />
      </div>
      <div className={styles.field}>
        <span className={styles.lbl}>{t('Ждать меня')}</span>
        <WaitClause mode={d.mode} blocks={blocks} pauseBefore={d.pauseBefore} onChange={(mode, pauseBefore) => set({ mode, pauseBefore })} />
      </div>
    </>
  );
}
