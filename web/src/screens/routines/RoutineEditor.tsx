// Редактор рутины (/routines/:slug, docs/routines/design/Editor.dc.html): правило фразами — когда (источник с условиями
// или расписание), если (проверка словами), запустить (flow в пространстве, задача), ждать меня (перед запуском, перед
// блоком, не ждать); «Дело» — завести дело в «Моих делах»; «Ещё» — где (рабочее дерево, папка), ответить, лимиты, модель,
// YAML вручную. Справа — «Проверить на истории»: что из последних событий источника запустилось бы (и какие дела завелись)
// по правилу как оно есть сейчас, до сохранения.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { HistoryCheck, RoutineView, RoutinesOverview } from '@server/routines/types';
import { ApiError, errorText, useFeature, useFlows } from '../../api';
import { checkHistory, deleteRoutine, routineKeys, runRoutine, saveRoutine, sendFeedback, useRoutine, useRoutines } from '../../api/routines';
import { useSpaces } from '../../api/spaces';
import { useConfirm } from '../../components/ConfirmDialog';
import { SpacePicker } from '../../components/SpacePicker';
import { useToast } from '../../components/Toast';
import { useNow } from '../../components/useNow';
import { plural, t } from '../../lib/i18n';
import { matchFields } from '../../lib/routines/match';
import { replyLabel, replyWhere } from '../../lib/routines/phrase';
import { formatNext, nextRuns, PRESETS, presetLabel, toCron, type SchedulePreset } from '../../lib/routines/schedule';
import { buildSpec, draftFromSpec, draftMissing, draftRuns, isCloseText, isSchedule, REPLY_CHOICES, type ReplyChoice, type RoutineDraft } from '../../lib/routines/spec';
import { estimateText, historyVerdict, isDraft, taskVerdict, type Verdict } from '../../lib/routines/view';
import { NotAvailable } from './RoutinesList';
import { CwdField } from './CwdField';
import { Conditions, cx, RoutineHead, Seg, useFlowBlocks, WaitClause } from './parts';
import styles from './Routines.module.css';

const HISTORY_LIMIT = 30;

export function RoutineEditor() {
  const slug = useParams().slug!;
  const one = useRoutine(slug);
  const all = useRoutines();
  if (one.isError) {
    return (
      <>
        <RoutineHead slug={slug} title={slug} />
        <NotAvailable error={one.error} />
      </>
    );
  }
  if (!one.data || !all.data) return <p className="muted">{t('Загрузка…')}</p>;
  // правка снаружи (YAML, другая вкладка) — форма заново с файла
  return <Editor key={`${slug}:${one.data.yaml}`} r={one.data} data={all.data} />;
}

function Editor({ r, data }: { r: RoutineView; data: RoutinesOverview }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const [d, setD] = useState<RoutineDraft>(() => draftFromSpec(r.spec));
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const set = (patch: Partial<RoutineDraft>) => setD((x) => ({ ...x, ...patch }));

  const source = data.sources.find((s) => s.slug === d.source);
  const kind = source ? data.kinds.find((k) => k.kind === source.spec.kind) : undefined;
  const fields = useMemo(() => matchFields(kind), [kind]);
  const spec = buildSpec(d, fields);
  const initial = useMemo(() => JSON.stringify(buildSpec(draftFromSpec(r.spec), fields)), [r.spec, fields]);
  const dirty = JSON.stringify(spec) !== initial;
  const draft = isDraft(r);
  const missing = draftMissing(d);
  const runs = draftRuns(d);

  // сменили источник: ответ «туда, откуда пришло» возможен, только если новый источник умеет отвечать; иначе — первый
  // источник с ответом или «Не сообщать» (сырое «source» у источника без reply давало бы ошибку в журнале на каждом событии)
  const replyFor = (slug: string): Partial<RoutineDraft> => {
    if (d.reply === 'off') return {};
    const k = data.kinds.find((x) => x.kind === data.sources.find((s) => s.slug === slug)?.spec.kind);
    if (k?.canReply) return { replyTo: 'source' };
    if (d.replyTo !== 'source' && d.replyTo !== slug) return {};
    const target = data.sources.find((s) => s.slug !== slug && data.kinds.find((x) => x.kind === s.spec.kind)?.canReply);
    return target ? { replyTo: target.slug } : { reply: 'off' };
  };
  const done = () => void qc.invalidateQueries({ queryKey: routineKeys.all });
  const save = async (enabled?: boolean) => {
    setSaving(true);
    setProblems([]);
    try {
      // «Включить» снимает признак черновика; «Сохранить черновик» его оставляет (buildSpec)
      const { draft: _draft, ...rest } = spec;
      const next = await saveRoutine(r.slug, { spec: enabled ? { ...rest, enabled } : spec });
      qc.setQueryData(routineKeys.one(r.slug), next);
      done();
      if (enabled && !r.spec.enabled) void navigate(`/routines/${encodeURIComponent(r.slug)}/log`);
    } catch (e) {
      const list = e instanceof ApiError ? (e.data as { problems?: string[] } | undefined)?.problems : undefined;
      setProblems(list?.length ? list : [errorText(e)]);
    } finally {
      setSaving(false);
    }
  };
  const runNow = async () => {
    try {
      const res = await runRoutine(r.slug);
      done();
      if (res.runId) void navigate(`/run/${res.runId}`);
      else toast(t('Событие ждёт тебя на главной.'), () => void navigate('/'));
    } catch (e) {
      toast(errorText(e));
    }
  };
  const remove = async () => {
    if (!(await askConfirm(t('Удалить рутину «{name}»? Журнал срабатываний тоже удалится.', { name: r.spec.title }), { ok: t('Удалить'), danger: true }))) return;
    try {
      await deleteRoutine(r.slug);
      done();
      void navigate('/routines');
    } catch (e) {
      toast(errorText(e));
    }
  };

  const moreSummary = [
    d.worktree === 'new' ? t('новое рабочее дерево') : d.cwd ? d.cwd : '',
    !runs ? '' : d.reply === 'off' ? t('без ответа') : `${t('ответ')} ${replyWhere(source?.spec.kind, d.replyTo, data.sources)} ${d.reply === 'draft' ? t('после твоей проверки') : t('сразу')}`,
    d.usd ? t('до {usd} за запуск', { usd: `$${d.usd}` }) : '',
    d.perDay ? t('{n} в день', { n: d.perDay }) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <RoutineHead
        r={r}
        slug={r.slug}
        title={r.spec.title || r.slug}
        actions={
          <>
            {r.spec.run && (
              <button type="button" className="btn" title={isSchedule(d) ? t('Запустить по расписанию сейчас, не дожидаясь времени') : t('Запустить flow сейчас, без события')} onClick={() => void runNow()}>
                {t('Запустить сейчас')}
              </button>
            )}
            <button type="button" className="btn ghost danger" onClick={() => void remove()}>{t('Удалить')}</button>
          </>
        }
      />
      {(problems.length > 0 || r.problems.length > 0) && (
        <div className={styles.problems} role="alert">
          {t('Правило не проходит проверку:')}
          <ul>
            {(problems.length ? problems : r.problems).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={styles.editGrid}>
        <div className={styles.rule}>
          <div className={styles.clause}>
            <span className={styles.k}>{t('Когда')}</span>
            <div className={styles.clauseBody}>
              {isSchedule(d) ? (
                <ScheduleClause d={d} set={set} />
              ) : (
                <Conditions
                  conds={d.conds}
                  fields={fields}
                  onChange={(conds) => set({ conds })}
                  lead={
                    <>
                      {t('в')}{' '}
                      <select className={styles.slot} aria-label={t('Источник')} value={d.source} onChange={(e) => set({ source: e.target.value, conds: [], ...replyFor(e.target.value) })}>
                        {data.sources.map((s) => (
                          <option key={s.slug} value={s.slug}>{s.spec.title}</option>
                        ))}
                        {!source && <option value={d.source}>{d.source}</option>}
                      </select>{' '}
                      {t('приходит событие,')}
                    </>
                  }
                />
              )}
            </div>
          </div>
          {!isSchedule(d) && (
            <div className={styles.clause}>
              <label className={styles.k} htmlFor="cond">{t('Если')}</label>
              <div className={styles.clauseBody}>
                <textarea id="cond" className={styles.inp} rows={3} value={d.check} onChange={(e) => set({ check: e.target.value })} />
                <span className={styles.hint}>{t('Своими словами, необязательно. Повторы одного и того же отсеиваются сами.')}</span>
              </div>
            </div>
          )}
          <RunClause d={d} set={set} />
          <TaskClause d={d} set={set} />
          {runs && (
            <div className={styles.clause}>
              <span className={styles.k}>{t('Ждать меня')}</span>
              <div className={styles.clauseBody}>
                <WaitBlocks d={d} set={set} />
              </div>
            </div>
          )}
          <button type="button" className={styles.more} aria-expanded={more} onClick={() => setMore(!more)}>
            <span>{more ? '▾' : '▸'} {t('Ещё')}</span>
            {!more && <span className={styles.moreSum}>{moreSummary}</span>}
          </button>
          {more && <More d={d} set={set} r={r} data={data} kindCanReply={Boolean(kind?.canReply)} onYamlSaved={done} />}
        </div>
        <History slug={r.slug} spec={spec} sourceTitle={isSchedule(d) ? t('расписания') : (source?.spec.title ?? d.source)} />
      </div>
      <div className={styles.bar}>
        {dirty && <span className="warn small">{t('есть несохранённые изменения')}</span>}
        <span className={styles.barGap} />
        {missing.includes('block') && <span className="warn small">{t('Выбери блок, перед которым ждать.')}</span>}
        {missing.includes('kind') && <span className="warn small">{t('Назови вид дела.')}</span>}
        {draft || r.spec.enabled === false ? (
          <>
            <button type="button" className="btn" disabled={saving || !dirty || missing.length > 0} onClick={() => void save(false)}>
              {draft ? t('Сохранить черновик') : t('Сохранить')}
            </button>
            <button type="button" className="btn primary" disabled={saving || missing.length > 0} onClick={() => void save(true)}>{t('Включить')}</button>
          </>
        ) : (
          <button type="button" className="btn primary" disabled={saving || !dirty || missing.length > 0} onClick={() => void save()}>{t('Сохранить')}</button>
        )}
      </div>
    </>
  );
}

type ClauseProps = { d: RoutineDraft; set: (p: Partial<RoutineDraft>) => void };

function ScheduleClause({ d, set }: ClauseProps) {
  const now = useNow(60_000);
  const next = formatNext(nextRuns(toCron(d.schedule), new Date(now), 3), new Date(now));
  const custom = d.schedule.preset === 'custom';
  return (
    <>
      <div className={styles.inline}>
        <Seg<SchedulePreset>
          label={t('Как часто')}
          value={d.schedule.preset}
          onChange={(preset) => set({ schedule: { ...d.schedule, preset, cron: preset === 'custom' ? toCron(d.schedule) : d.schedule.cron } })}
          options={[...PRESETS, 'custom' as const].map((p) => ({ value: p, label: presetLabel(p) }))}
        />
        {!custom && d.schedule.preset !== 'hourly' && (
          <input className={cx(styles.inp, styles.mono, styles.inlineSel)} type="time" aria-label={t('Время')} value={d.schedule.time} onChange={(e) => set({ schedule: { ...d.schedule, time: e.target.value || '09:30' } })} />
        )}
        {custom && <input className={cx(styles.inp, styles.mono, styles.flowSearch)} aria-label="cron" placeholder="30 9 * * 1-5" value={d.schedule.cron ?? ''} onChange={(e) => set({ schedule: { ...d.schedule, cron: e.target.value } })} />}
      </div>
      <span className={styles.mono}>{next ? t('Ближайшие: {list}', { list: next }) : t('Расписание не разобрать: cron из 5 полей, «минута час день месяц день-недели».')}</span>
      <div className={styles.sentence}>
        {t('Пропущенное, пока приложение закрыто,')}{' '}
        <select className={styles.slot} aria-label={t('Пропущенное время')} value={d.missed} onChange={(e) => set({ missed: e.target.value as 'ask' | 'skip' })}>
          <option value="ask">{t('спросить один раз')}</option>
          <option value="skip">{t('пропустить молча')}</option>
        </select>
      </div>
    </>
  );
}

function RunClause({ d, set }: ClauseProps) {
  const flows = useFlows();
  const spacesOn = useFeature('spaces');
  const spaces = useSpaces(spacesOn);
  const list = (flows.data ?? []).filter((f) => f.valid);
  // рутина с делом из события может ничего не запускать: событие только заводит дело
  const taskOnly = d.taskOn && d.taskFrom === 'event';
  const runs = draftRuns(d);
  return (
    <div className={styles.clause}>
      <span className={styles.k}>{t('Запустить')}</span>
      <div className={styles.clauseBody}>
        <div className={styles.inline}>
          <select className={styles.slot} aria-label="Flow" value={d.flow} onChange={(e) => set({ flow: e.target.value, pauseBefore: [], mode: d.mode === 'until_pause' ? 'suggest' : d.mode })}>
            {taskOnly && <option value="">{t('ничего — только завести дело')}</option>}
            {!list.some((f) => f.name === d.flow) && (d.flow || !taskOnly) && <option value={d.flow}>{d.flow || t('выбери flow')}</option>}
            {list.map((f) => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
          </select>
          {spacesOn && runs && (
            <>
              <span>{t('в')}</span>
              <SpacePicker id="routine-edit-space" value={d.space} onChange={(space) => set({ space })} options={spaces.data?.spaces ?? []} loading={spaces.isPending} compact placeholder={t('без пространства')} className={styles.flowSearch} inputClassName={styles.slot} />
            </>
          )}
        </div>
        {runs && (
          <label className={styles.clauseBody}>
            <span className={styles.lbl}>{t('Что поручить flow')}</span>
            <textarea className={styles.inp} rows={2} placeholder={t('Например: сделай ревью MR и оставь замечания. Пусто — задача из самого flow')} value={d.input} onChange={(e) => set({ input: e.target.value })} />
          </label>
        )}
        {runs && !isSchedule(d) && (
          <span className={styles.hint}>
            {t('К задаче flow получит событие: заголовок, автора, ссылку, текст и поля. Передавать их отдельно не нужно: что именно придёт — «Что получит flow» в проверке справа.')}
          </span>
        )}
      </div>
    </div>
  );
}

const KINDS = ['Ревью', 'Jira', 'Встреча', 'Задача', 'Своё'];

/**
 * «Дело» (блок task, docs/desk/design/RulePult.dc.html): «Завести дело как Ревью в Новое. Тем же делом считать ту же
 * вещь; пришло новое — вернуть в план. Закрыть, когда вещь закрыта». Дела из flow заводит сам flow (desk_put).
 */
function TaskClause({ d, set }: ClauseProps) {
  const closeChoice = isCloseText(d.taskClose) ? 'text' : d.taskClose;
  return (
    <div className={styles.clause}>
      <span className={styles.k}>{t('Дело')}</span>
      <div className={styles.clauseBody}>
        <Seg<'off' | 'on'>
          label={t('Заводить дело')}
          value={d.taskOn ? 'on' : 'off'}
          onChange={(v) => set(v === 'on' ? { taskOn: true, taskKind: d.taskKind || KINDS[0]! } : { taskOn: false })}
          options={[
            { value: 'off', label: t('не заводить') },
            { value: 'on', label: t('завести дело'), title: t('Событие становится делом в «Моих делах»: одно дело на вещь, сколько бы событий о ней ни пришло') },
          ]}
        />
        {d.taskOn && (
          <>
            <div className={styles.sentence}>
              {t('Завести дело как')}{' '}
              <input
                className={cx(styles.slot, styles.taskKind)}
                list="routine-task-kinds"
                size={Math.max(d.taskKind.length, 6)}
                aria-label={t('Вид дела')}
                value={d.taskKind}
                onChange={(e) => set({ taskKind: e.target.value })}
              />
              <datalist id="routine-task-kinds">
                {KINDS.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>{' '}
              {t('в')}{' '}
              <select className={styles.slot} aria-label={t('Колонка')} value={d.taskColumn} onChange={(e) => set({ taskColumn: e.target.value as RoutineDraft['taskColumn'] })}>
                <option value="new">{t('Новое')}</option>
                <option value="plan">{t('В плане')}</option>
              </select>
              {'. '}
              {t('Заводит')}{' '}
              <select className={styles.slot} aria-label={t('Кто заводит дело')} value={d.taskFrom} onChange={(e) => set({ taskFrom: e.target.value as RoutineDraft['taskFrom'] })}>
                <option value="event">{t('само событие')}</option>
                <option value="flow">{t('flow, инструментом desk_put')}</option>
              </select>
            </div>
            {d.taskFrom === 'event' && (
              <>
                <div className={styles.sentence}>
                  {t('Тем же делом считать')}{' '}
                  <select className={styles.slot} aria-label={t('Что считать тем же делом')} value={d.taskSame} onChange={(e) => set({ taskSame: e.target.value as RoutineDraft['taskSame'] })}>
                    <option value="">{t('ту же вещь, иначе тот же разговор')}</option>
                    <option value="thing">{t('ту же вещь (MR, задачу)')}</option>
                    <option value="thread">{t('тот же разговор (тред)')}</option>
                    <option value="event">{t('ничего — каждое событие отдельно')}</option>
                  </select>
                  {'; '}
                  {t('пришло новое по тому же —')}{' '}
                  <select
                    className={styles.slot}
                    aria-label={t('Пришло новое по тому же делу')}
                    value={d.taskRepeat}
                    onChange={(e) => set({ taskRepeat: e.target.value as RoutineDraft['taskRepeat'] })}
                  >
                    <option value="plan">{t('вернуть в план')}</option>
                    <option value="keep">{t('оставить, где лежит')}</option>
                  </select>
                </div>
                <div className={styles.sentence}>
                  {t('Закрыть, когда')}{' '}
                  <select className={styles.slot} aria-label={t('Когда закрыть дело')} value={closeChoice} onChange={(e) => set({ taskClose: e.target.value === 'text' ? '' : e.target.value })}>
                    <option value="thing">{t('вещь закрыта (MR смержен, задача готова)')}</option>
                    <option value="never">{t('закрою сам')}</option>
                    <option value="text">{t('условие словами…')}</option>
                  </select>
                </div>
                {closeChoice === 'text' && (
                  <>
                    <input
                      className={styles.inp}
                      aria-label={t('Условие закрытия')}
                      placeholder={t('Например: в треде ответили «готово»')}
                      value={d.taskClose}
                      onChange={(e) => set({ taskClose: e.target.value })}
                    />
                    <span className={styles.hint}>{t('Условие словами пока не проверяется само: такое дело закроешь руками.')}</span>
                  </>
                )}
              </>
            )}
            <span className={styles.hint}>
              {d.taskFrom === 'flow'
                ? t('Дела заводит flow инструментом desk_put — по одному на вещь, о которой он узнал.')
                : t('Одно дело на вещь: сколько бы сигналов о ней ни пришло из этой и других рутин, дело одно.')}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function WaitBlocks({ d, set }: ClauseProps) {
  const blocks = useFlowBlocks(d.flow);
  return <WaitClause mode={d.mode} blocks={blocks} pauseBefore={d.pauseBefore} onChange={(mode, pauseBefore) => set({ mode, pauseBefore })} />;
}

const ON: Array<{ v: 'start' | 'pause' | 'end'; label: string }> = [
  { v: 'start', label: t('когда начал') },
  { v: 'pause', label: t('когда жду тебя') },
  { v: 'end', label: t('в конце') },
];

function More({ d, set, r, data, kindCanReply, onYamlSaved }: ClauseProps & { r: RoutineView; data: RoutinesOverview; kindCanReply: boolean; onYamlSaved: () => void }) {
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yaml, setYaml] = useState(r.yaml);
  const [yamlErr, setYamlErr] = useState('');
  const qc = useQueryClient();
  const targets = data.sources.filter((s) => s.slug !== d.source && data.kinds.find((k) => k.kind === s.spec.kind)?.canReply);
  const kind = data.sources.find((s) => s.slug === d.source)?.spec.kind;
  const saveYaml = async () => {
    setYamlErr('');
    try {
      const next = await saveRoutine(r.slug, { yaml });
      qc.setQueryData(routineKeys.one(r.slug), next);
      onYamlSaved();
    } catch (e) {
      const list = e instanceof ApiError ? (e.data as { problems?: string[] } | undefined)?.problems : undefined;
      setYamlErr(list?.length ? list.join('\n') : errorText(e));
    }
  };
  const toggleOn = (v: 'start' | 'pause' | 'end') => set({ replyOn: d.replyOn.includes(v) ? d.replyOn.filter((x) => x !== v) : [...d.replyOn, v] });
  return (
    <>
      <div className={styles.clause}>
        <span className={styles.k}>{t('Где')}</span>
        <div className={styles.clauseBody}>
          <div className={styles.sentence}>
            {t('в')}{' '}
            <select className={styles.slot} aria-label={t('Рабочее дерево')} value={d.worktree} onChange={(e) => set({ worktree: e.target.value as 'new' | 'none' })}>
              <option value="none">{t('рабочей папке')}</option>
              <option value="new">{t('новом рабочем дереве')}</option>
            </select>
          </div>
          <CwdField value={d.cwd} onChange={(cwd) => set({ cwd })} />
        </div>
      </div>
      {draftRuns(d) && (
        <div className={styles.clause}>
          <span className={styles.k}>{t('Ответить')}</span>
          <div className={styles.clauseBody}>
            <Seg<ReplyChoice> label={t('Сообщать о результате')} value={d.reply} onChange={(reply) => set({ reply })} options={REPLY_CHOICES.map((c) => ({ value: c, label: replyLabel(c), disabled: c !== 'off' && !kindCanReply && !targets.length }))} />
            {d.reply !== 'off' && (
              <div className={styles.sentence}>
                <select className={styles.slot} aria-label={t('Куда писать')} value={d.replyTo} onChange={(e) => set({ replyTo: e.target.value })}>
                  {kindCanReply && <option value="source">{replyWhere(kind, 'source', data.sources)}</option>}
                  {targets.map((s) => (
                    <option key={s.slug} value={s.slug}>{replyWhere(undefined, s.slug, data.sources)}</option>
                  ))}
                  {!kindCanReply && !targets.some((s) => s.slug === d.replyTo) && <option value={d.replyTo}>{d.replyTo}</option>}
                </select>
                ,{' '}
                <span className={styles.chipsInline}>
                  {ON.map((o) => (
                    <button key={o.v} type="button" className={styles.chip} aria-pressed={d.replyOn.includes(o.v)} onClick={() => toggleOn(o.v)}>{o.label}</button>
                  ))}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
      <div className={styles.clause}>
        <span className={styles.k}>{t('Лимит')}</span>
        <div className={styles.inline}>
          <label className={styles.inline}>
            <input className={cx(styles.inp, styles.mono, styles.inlineSel)} size={5} inputMode="decimal" aria-label={t('Бюджет на запуск, $')} placeholder="$" value={d.usd} onChange={(e) => set({ usd: e.target.value })} />
            <span>{t('на запуск,')}</span>
          </label>
          <label className={styles.inline}>
            <input className={cx(styles.inp, styles.mono, styles.inlineSel)} size={3} inputMode="numeric" aria-label={t('Запусков в день')} value={d.perDay} onChange={(e) => set({ perDay: e.target.value })} />
            <span>{t('запусков в день,')}</span>
          </label>
          <label className={styles.inline}>
            <input className={cx(styles.inp, styles.mono, styles.inlineSel)} size={3} inputMode="numeric" aria-label={t('Одновременно')} value={d.parallel} onChange={(e) => set({ parallel: e.target.value })} />
            <span>{t('одновременно')}</span>
          </label>
        </div>
      </div>
      <div className={styles.clause}>
        <span className={styles.k}>{t('Модель')}</span>
        <input className={cx(styles.inp, styles.mono, styles.flowSearch)} placeholder={t('как в flow')} value={d.model} onChange={(e) => set({ model: e.target.value })} />
      </div>
      <div className={styles.clause}>
        <span className={styles.k}>YAML</span>
        <div className={styles.clauseBody}>
          <div>
            <button type="button" className="btn small ghost" aria-expanded={yamlOpen} onClick={() => setYamlOpen(!yamlOpen)}>
              {yamlOpen ? '▾' : '▸'} {t('Открыть YAML')}
            </button>
          </div>
          {yamlOpen && (
            <>
              <textarea className={cx(styles.inp, styles.yaml)} spellCheck={false} aria-label="YAML" value={yaml} onChange={(e) => setYaml(e.target.value)} />
              <div className="row">
                <button type="button" className="btn small" disabled={yaml === r.yaml} onClick={() => void saveYaml()}>{t('Сохранить YAML')}</button>
                <span className={styles.hint}>{t('Файл ~/.agentgraph/routines/{slug}.yaml. Правка формы выше при этом теряется.', { slug: r.slug })}</span>
              </div>
              {yamlErr && <span className={styles.err} role="alert">{yamlErr}</span>}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * «Проверить на истории»: последние события источника против правила как оно есть в форме. Строки, где правило решило
 * бы иначе, чем человек раньше («расходится»), видны всегда, с «Учесть» — ответ человека уходит в примеры проверки
 * словами, и проверка идёт заново. Сверху — «Запустилось бы N из M» и оценка в неделю.
 */
function History({ slug, spec, sourceTitle }: { slug: string; spec: ReturnType<typeof buildSpec>; sourceTitle: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  // итог живёт в кэше запросов (ключ вне ['routines']): «Сохранить» монтирует редактор заново, и проверка не должна
  // уходить ещё раз — с проверкой словами это до 30 вызовов модели
  const cacheKey = ['routine-history', slug];
  const cached = qc.getQueryData<{ res: HistoryCheck; spec: string }>(cacheKey);
  const [res, setRes] = useState<HistoryCheck | null>(cached?.res ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [skips, setSkips] = useState(false);
  const [checkedSpec, setCheckedSpec] = useState(cached?.spec ?? '');
  const key = JSON.stringify(spec);
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await checkHistory(slug, spec, HISTORY_LIMIT);
      setRes(next);
      setCheckedSpec(key);
      qc.setQueryData(cacheKey, { res: next, spec: key });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const learn = async (eventId: string, verdict: Verdict) => {
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
    if (!cached) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  const events = res?.events ?? [];
  const rows = events.map((e) => {
    const tv = taskVerdict(e.task);
    return { e, v: historyVerdict(e), task: tv && { ...tv, closed: e.task?.action === 'closed' } };
  });
  const runs = rows.filter((r) => r.v.run).length;
  // запуски и расхождения видны всегда, остальные пропуски — по кнопке
  const hidden = rows.filter((r) => !r.v.run && !r.v.disagrees);
  const shown = skips ? rows : rows.filter((r) => r.v.run || r.v.disagrees);
  const stale = res && checkedSpec !== key;
  const est = estimateText(res?.estimate);
  // рутина с делом: главное — сколько дел было бы на доске; запуски — рядом, если рутина ещё и запускает flow
  const tasks = res?.tasks;
  return (
    <section className={styles.history} aria-label={t('Проверка на истории')}>
      <div className={styles.histHead}>
        <span className={styles.lbl}>{res ? t('Проверка на последних {n} событиях {source}', { n: events.length, source: sourceTitle }) : t('Проверить на истории')}</span>
        <span className={styles.barGap} />
        <button type="button" className={cx('btn small', !stale && res ? 'ghost' : '')} disabled={busy} title={t('Прогнать правило по последним событиям источника. Проверка словами тратит немного модели')} onClick={() => void run()}>
          {busy ? t('Проверяю…') : res ? t('Проверить снова') : t('Проверить на истории')}
        </button>
      </div>
      {error && <span className={styles.err}>{error}</span>}
      {res && (
        <>
          <div className={styles.histHead}>
            {tasks !== undefined ? (
              <>
                <span className={styles.histBig}>{t('На доске было бы {n} {w}', { n: tasks, w: plural(tasks, 'дело', 'дела', 'дел') })}</span>
                {spec.run && <span className={styles.mono}>{t('запустилось бы {k} из {n}', { k: runs, n: events.length })}</span>}
              </>
            ) : (
              <span className={styles.histBig}>{t('Запустилось бы {k} из {n}', { k: runs, n: events.length })}</span>
            )}
            {est && <span className={styles.mono} title={t('По средней стоимости прошлых запусков рутины или flow')}>{est}</span>}
            {stale && <span className="warn small">{t('правило поменялось — проверь снова')}</span>}
          </div>
          {res.disagreements > 0 && (
            <span className="err small">
              {t('С твоими прошлыми ответами расходится {n} {w}.', { n: res.disagreements, w: plural(res.disagreements, 'событие', 'события', 'событий') })}
            </span>
          )}
          <div>
            {shown.map(({ e, v, task }) => (
              <div key={e.event.id} className={cx(styles.dr, v.disagrees && styles.bad)}>
                <span className={cx(styles.drV, v.run && styles.run, task?.closed && styles.closed)}>{task?.text ?? v.text}</span>
                <span title={e.event.text}>{e.event.title || e.event.text}</span>
                {v.disagrees && e.past && (
                  <button type="button" className={cx('btn small', styles.drAct)} disabled={busy} title={t('Взять твой прошлый ответ в примеры проверки словами и проверить снова')} onClick={() => void learn(e.event.id, e.past!)}>
                    {t('Учесть')}
                  </button>
                )}
                {(task?.why || v.why) && <span className={cx(styles.drWhy, v.disagrees && styles.bad)}>{[task?.why, v.why].filter(Boolean).join(' · ')}</span>}
              </div>
            ))}
            {!events.length && <span className={styles.hint}>{t('Событий из источника пока нет: проверить не на чем.')}</span>}
          </div>
          {hidden.length > 0 && (
            <button type="button" className={cx('btn small ghost', styles.selfStart)} aria-expanded={skips} onClick={() => setSkips(!skips)}>
              {skips ? t('Скрыть пропущенные') : t('Показать {n} пропущенных', { n: hidden.length })}
            </button>
          )}
          {res.preview && (
            <details className={styles.preview}>
              <summary>{t('Что получит flow — на событии «{title}»', { title: events.find((e) => e.event.id === res.preview!.eventId)?.event.title ?? res.preview.eventId })}</summary>
              <pre className={styles.previewText}>{[res.preview.task ?? t('(задача из input flow)'), res.preview.event].join('\n\n')}</pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}

