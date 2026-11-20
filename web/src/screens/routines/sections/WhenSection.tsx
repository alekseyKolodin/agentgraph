// Раздел 1 «Когда» (Editor.dc.html): карточка источника (частота опроса правится на странице источника, здесь — только
// видно) или расписание; «Брать …, если» — условия на поля строками с счётчиками воронки; «Потом спросить ИИ» — условие
// словами, «не уверен», модель и сколько это стоило на прошлой проверке. Порядок «поля → ИИ» — дешёвые проверки раньше.
// В «Новой рутине» (New.dc.html) вместо карточки источника — выбор карточками (SourcePicks): все подключённые источники,
// «По расписанию» и «+ Подключить сервис».
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { HistoryCheck, MatchField, RoutinesOverview } from '@server/routines/types';
import { Field, Input, ModelSelect, NumberField, Select, Seg, TextArea, TokenInput, type SelectOption } from '../../../components/form';
import { useNow } from '../../../components/useNow';
import { modelChip } from '../../../lib/flow/ai-progress';
import { usd } from '../../../lib/format';
import { plural, t } from '../../../lib/i18n';
import { condCounts, condTokens, dropCond, eventWord, opWord, switchSource, tokensValue, type CondCount } from '../../../lib/routines/editor';
import { DEFAULT_CHECK_MODEL } from '../../../lib/routines/graph';
import { opsFor, type Condition } from '../../../lib/routines/match';
import { pickCondition } from '../../../lib/routines/sample';
import { formatNext, nextRuns, parseCron, PRESETS, presetLabel, toCron, type SchedulePreset } from '../../../lib/routines/schedule';
import { everyLabel } from '../../../lib/routines/source';
import { draftRuns, draftUnsavedConds, isSchedule } from '../../../lib/routines/spec';
import { sourceState } from '../../../lib/routines/view';
import { EventSample } from '../EventSample';
import { cx, Dot } from '../parts';
import { leaveClick, Section, useLeave, type DraftProps, type FilledProp, type RoutineSource } from './Section';
import s from './Sections.module.css';

type WhenProps = DraftProps & FilledProp & {
  data: RoutinesOverview;
  src: RoutineSource;
  /** Проверка на истории по правилу как оно есть сейчас (устаревшая — null): по ней счётчики строк и ИИ. */
  hist: HistoryCheck | null;
  /** Выбор источника вместо карточки источника («Новая рутина» — SourcePicks). Пока источник не выбран, условий и ИИ нет. */
  picker?: ReactNode;
};

/** Раздел «Когда» целиком: источник или расписание, условия на поля, ИИ. */
export function WhenSection({ d, set, data, src, hist, picker, filled }: WhenProps) {
  const sched = isSchedule(d);
  return (
    <Section n={1} title={t('Когда')} sub={sched ? t('по расписанию') : t('какие события берём в работу')} filled={filled}>
      {picker}
      {sched ? (
        <ScheduleCard d={d} set={set} />
      ) : picker && !src.source ? null : (
        <>
          {!picker && <SourceCard d={d} set={set} data={data} src={src} />}
          <ConditionsCard d={d} set={set} src={src} hist={hist} />
          <AiCard d={d} set={set} hist={hist} />
        </>
      )}
    </Section>
  );
}

/**
 * Выбор, что запускает рутину, карточками (New.dc.html): подключённые источники (вид и частота опроса), «По расписанию»
 * и пунктирная «+ Подключить сервис». Что поменять в черновике при выборе, решает экран (условия шаблона, ответ).
 */
export function SourcePicks({ d, data, onPick, onSchedule, onConnect, hint }: {
  d: Pick<DraftProps['d'], 'source'>;
  data: RoutinesOverview;
  onPick: (slug: string) => void;
  onSchedule: () => void;
  /** «+ Подключить сервис»: черновик при этом не теряется. */
  onConnect: () => void;
  /** Подсказка над карточками: чего не хватает шаблону. */
  hint?: ReactNode;
}) {
  return (
    <>
      {hint && <span className={s.warn}>{hint}</span>}
      <div className={s.picks} role="group" aria-label={t('Что запускает')}>
        {data.sources.map((x) => {
          const k = data.kinds.find((v) => v.kind === x.spec.kind);
          const st = sourceState(x);
          const every = k?.delivery === 'live' ? t('сразу') : everyLabel(x.spec.every ?? k?.minEvery ?? '5m');
          return (
            <button key={x.slug} type="button" className={s.pick} aria-pressed={d.source === x.slug} title={st.note || st.label} onClick={() => onPick(x.slug)}>
              <b>
                {(st.tone === 'fail' || st.tone === 'wait') && <Dot tone={st.tone} title={st.label} />}
                {x.spec.title || x.slug}
              </b>
              <span>{[x.spec.description || k?.summary || k?.title || x.spec.kind, every].filter(Boolean).join(' · ')}</span>
            </button>
          );
        })}
        <button type="button" className={s.pick} aria-pressed={isSchedule(d)} onClick={onSchedule}>
          <b>{t('По расписанию')}</b>
          <span>{t('в заданное время')}</span>
        </button>
        <button type="button" className={cx(s.pick, s.pickAdd)} onClick={onConnect}>
          <b>{t('+ Подключить сервис')}</b>
          <span>{t('Jira, GitHub, Telegram, почта или любой другой. Черновик рутины не потеряется')}</span>
        </button>
      </div>
    </>
  );
}

/**
 * Карточка источника: название, как приходят события, сколько рутин им пользуется, «Источник ›» — его страница (там
 * частота опроса, ключи и ответ), «Сменить» — другой источник; условия старого при этом уходят.
 */
export function SourceCard({ d, set, data, src }: DraftProps & { data: RoutinesOverview; src: RoutineSource }) {
  const { source, kind } = src;
  const leave = useLeave();
  const [changing, setChanging] = useState(!source);
  const options: SelectOption<string>[] = data.sources.map((x) => ({ value: x.slug, label: x.spec.title || x.slug, sub: data.kinds.find((k) => k.kind === x.spec.kind)?.title, keywords: x.slug }));
  const st = source ? sourceState(source) : undefined;
  const how = !source
    ? ''
    : kind?.delivery === 'live'
      ? t('события приходят сразу')
      : t('опрос {every}', { every: everyLabel(source.spec.every ?? kind?.minEvery ?? '5m') }) + (kind?.delivery === 'model' ? ` · ${t('читает модель')}` : '');
  const used = source ? t('им пользуется {n} {w}', { n: source.usedBy.length, w: plural(source.usedBy.length, 'рутина', 'рутины', 'рутин') }) : '';
  return (
    <div className={cx(s.card, s.src)}>
      {st && <Dot tone={st.tone} title={st.label} />}
      <div className={s.srcMain}>
        <b title={source?.slug}>{source ? source.spec.title || source.slug : d.source ? t('Источник «{slug}» не найден', { slug: d.source }) : t('Источник не выбран')}</b>
        {source && <span className={s.meta}>{[how, used].filter(Boolean).join(' · ')}</span>}
        {st?.note && st.tone !== 'off' && st.tone !== 'muted' && <span className={s.warn}>{st.note}</span>}
      </div>
      {source && (
        // уход на страницу источника — через охрану экрана: несохранённое в разделах не теряется молча
        <Link className="btn small" to={`/routines/sources/${encodeURIComponent(source.slug)}`} onClick={leaveClick(leave, `/routines/sources/${encodeURIComponent(source.slug)}`)} title={t('Страница источника: подключение, частота опроса, ключи и ответ')}>
          {t('Источник ›')}
        </Link>
      )}
      {source && (
        <button type="button" className="btn small ghost" aria-expanded={changing} onClick={() => setChanging(!changing)}>
          {t('Сменить')}
        </button>
      )}
      {changing && (
        <Select<string>
          className={s.srcPick}
          aria-label={t('Источник')}
          value={source ? d.source : ''}
          options={options}
          placeholder={t('Выбери источник')}
          title={t('Условия на поля старого источника при смене уйдут')}
          onChange={(slug) => {
            set(switchSource(d, slug, data.sources));
            setChanging(false);
          }}
        />
      )}
    </div>
  );
}

/** Расписание вместо источника: как часто, время или cron, ближайшие запуски, что делать с пропущенным. */
export function ScheduleCard({ d, set }: DraftProps) {
  const now = useNow(60_000);
  const custom = d.schedule.preset === 'custom';
  const cron = toCron(d.schedule);
  const next = formatNext(nextRuns(cron, new Date(now), 3), new Date(now));
  const bad = custom && !parseCron(d.schedule.cron ?? '');
  return (
    <div className={cx(s.card, s.fields)}>
      <Field label={t('Как часто')}>
        <Seg<SchedulePreset>
          value={d.schedule.preset}
          onChange={(preset) => set({ schedule: { ...d.schedule, preset, cron: preset === 'custom' ? toCron(d.schedule) : d.schedule.cron } })}
          options={[...PRESETS, 'custom' as const].map((p) => ({ value: p, label: presetLabel(p) }))}
        />
      </Field>
      <div className={s.grid2}>
        {custom ? (
          <Field label="cron" help={t('Пять полей: минута час день месяц день-недели. Например, 30 9 * * 1-5 — по будням в 9:30.')} issue={bad ? { tone: 'err', text: t('Расписание не разобрать: нужно 5 полей') } : undefined} hint={next ? t('Ближайшие: {list}', { list: next }) : undefined}>
            <Input mono placeholder="30 9 * * 1-5" value={d.schedule.cron ?? ''} onChange={(e) => set({ schedule: { ...d.schedule, cron: e.target.value } })} />
          </Field>
        ) : (
          d.schedule.preset !== 'hourly' && (
            <Field label={t('Время')} hint={next ? t('Ближайшие: {list}', { list: next }) : undefined}>
              <Input mono type="time" value={d.schedule.time} onChange={(e) => set({ schedule: { ...d.schedule, time: e.target.value || '09:30' } })} />
            </Field>
          )
        )}
        <Field label={t('Пропущенное, пока приложение закрыто')}>
          <Seg<'ask' | 'skip'>
            value={d.missed}
            onChange={(missed) => set({ missed })}
            options={[
              { value: 'ask', label: t('спросить один раз') },
              { value: 'skip', label: t('пропустить') },
            ]}
          />
        </Field>
      </div>
      {d.schedule.preset === 'hourly' && next && <span className={s.meta}>{t('Ближайшие: {list}', { list: next })}</span>}
    </div>
  );
}

/**
 * «Брать …, если»: условия на поля строками. Значения — токенами («a, b» — любое из, у «не равно» — ни одно из), у
 * «больше»/«меньше» — число. Незаполненная строка подсвечена: в правило она не попадёт. Справа у строки — сколько событий
 * дошло до неё и сколько прошло на проверке на истории.
 */
export function ConditionsCard({ d, set, src, hist }: DraftProps & { src: RoutineSource; hist: HistoryCheck | null }) {
  const [sampleOpen, setSampleOpen] = useState(false);
  const fields = src.condFields;
  const unsaved = new Set(draftUnsavedConds(d));
  const counts = condCounts(d.conds, hist?.funnel);
  const setRow = (i: number, patch: Partial<Condition>) => set({ conds: d.conds.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const add = (c?: Condition) => {
    const f = fields[0];
    const v = c ? c.value : f?.type === 'bool' ? 'false' : '';
    // значение из примера — одно, даже с запятой внутри
    set({ conds: [...d.conds, { ...(c ?? { field: f?.key ?? 'title', op: 'eq' as const }), value: v, values: v ? [v] : [] }] });
  };
  const word = eventWord(src.source?.spec.kind);
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <b>{t('Брать {what}, если', { what: word })}</b>
        {d.conds.length > 1 && (
          <Seg<'all' | 'any'>
            className={s.segSm}
            label={t('Как сочетать условия')}
            value={d.condsMode}
            onChange={(condsMode) => set({ condsMode })}
            options={[
              { value: 'all', label: t('все условия') },
              { value: 'any', label: t('любое') },
            ]}
          />
        )}
        <span className={s.gap} />
        <span className={s.meta}>{t('без модели · бесплатно')}</span>
      </div>
      {d.conds.length > 0 ? (
        <div className={cx(s.crow, s.crowHead)} aria-hidden="true">
          <span className={s.lbl}>{t('Поле')}</span>
          <span className={s.lbl}>{t('Условие')}</span>
          <span className={s.lbl}>{t('Значения')}</span>
          <span className={cx(s.lbl, s.cnt)}>{t('прошло')}</span>
          <span />
        </div>
      ) : (
        <span className={s.meta}>{t('Условий нет: подходит любое событие.')}</span>
      )}
      {d.conds.map((c, i) => (
        <CondRow key={i} c={c} fields={fields} count={counts[i] ?? null} unsaved={unsaved.has(i)} onChange={(patch) => setRow(i, patch)} onRemove={() => set(dropCond(d, i))} />
      ))}
      <div className={s.btns}>
        <button type="button" className="btn small" title={t('Условие на поле события — без модели: канал, автор, поле равно или содержит')} onClick={() => add()}>
          {t('+ условие')}
        </button>
        {src.source && (
          <button type="button" className="btn small ghost" aria-expanded={sampleOpen} onClick={() => setSampleOpen(!sampleOpen)}>
            {sampleOpen ? t('Скрыть пример события') : t('Взять из последнего события ▾')}
          </button>
        )}
      </div>
      {sampleOpen && src.source && <EventSample key={src.source.slug} source={src.source} kind={src.kind} sample={src.sample} onPick={(f) => add(pickCondition(f))} />}
    </div>
  );
}

/** Одна строка условия: поле · условие · значения · сколько прошло · ×. */
export function CondRow({ c, fields, count, unsaved, onChange, onRemove }: {
  c: Condition;
  fields: MatchField[];
  count: CondCount | null;
  /** Строка не дописана: в правило не попадёт. */
  unsaved: boolean;
  onChange: (patch: Partial<Condition>) => void;
  onRemove: () => void;
}) {
  const field = fields.find((f) => f.key === c.field);
  const type = field?.type;
  const fieldOpts: SelectOption<string>[] = fields.map((f) => ({ value: f.key, label: f.label, sub: f.label !== f.key ? f.key : undefined, keywords: f.key }));
  if (c.field && !field) fieldOpts.push({ value: c.field, label: c.field });
  const tone = unsaved ? ('warn' as const) : undefined;
  // значения — явным списком (Condition.values): токен «Ошибка, срочно» не делится по запятой. Правка снимает raw —
  // правило пишется по списку, а не тем, что было в файле
  const list = c.values && tokensValue(c.values) === c.value ? c.values : condTokens(c.value);
  const setList = (next: string[]) => onChange({ value: tokensValue(next), values: next, raw: undefined, pending: undefined });
  let value;
  if (type === 'bool') {
    value = <Select<'true' | 'false'> aria-label={t('Значение')} tone={tone} value={c.value === 'true' ? 'true' : 'false'} options={[{ value: 'true', label: t('да') }, { value: 'false', label: t('нет') }]} onChange={(v) => onChange({ value: v, values: [v], raw: undefined })} />;
  } else if (c.op === 'gt' || c.op === 'lt' || (type === 'number' && list.length <= 1)) {
    // число — одно, «1,5» — полтора; список чисел из файла ([100, 200]) остаётся токенами ниже
    const n = Number((list[0] ?? '').replace(',', '.'));
    value = <NumberField aria-label={t('Значение')} tone={tone} value={list.length && Number.isFinite(n) ? n : null} placeholder={t('число')} onChange={(v) => setList(v === null ? [] : [String(v)])} />;
  } else {
    value = (
      <TokenInput
        aria-label={t('Значения')}
        tone={tone}
        value={list}
        suggestions={type === 'enum' ? field?.options : undefined}
        placeholder={t('значение; Enter — ещё одно')}
        // набранное без Enter — уже значение строки: «Сохранить» видит правку, строка не пишет «Пустое условие»
        text={c.pending ?? ''}
        onChange={(next, pending) => onChange(next === list ? { pending } : { value: tokensValue(next), values: next, raw: undefined, pending })}
      />
    );
  }
  return (
    <>
      <div className={s.crow}>
        <Select<string>
          aria-label={t('Поле')}
          value={c.field}
          options={fieldOpts}
          onChange={(key) => {
            const f = fields.find((x) => x.key === key);
            const ops = opsFor(f?.type);
            onChange(f?.type === 'bool' ? { field: key, op: 'eq', value: 'false', values: ['false'], pending: undefined } : type === 'bool' ? { field: key, op: ops[0]!, value: '', values: [] } : { field: key, op: ops.includes(c.op) ? c.op : ops[0]!, ...(f?.type === 'number' ? { pending: undefined } : {}) });
          }}
        />
        <Select aria-label={t('Условие')} value={c.op} options={opsFor(type).map((op) => ({ value: op, label: opWord(op) }))} onChange={(op) => onChange(op === 'gt' || op === 'lt' ? { op, value: list[0] ?? '', values: list.slice(0, 1), raw: undefined, pending: undefined } : { op })} />
        {value}
        <span className={s.cnt} title={count ? t('На проверке на истории до условия дошло {from}, прошло {n}', { from: count.from, n: count.passed }) : undefined}>
          {count ? `${count.from} → ${count.passed}` : '—'}
        </span>
        <button type="button" className={s.x} aria-label={t('Убрать условие')} title={t('Убрать условие')} onClick={onRemove}>×</button>
      </div>
      {unsaved && <span className={cx(s.warn, s.rowIssue)}>{t('Пустое условие не сохранится. Впиши значение или убери строку.')}</span>}
    </>
  );
}

/**
 * «Потом спросить ИИ»: модель читает событие, прошедшее условия по полям, и решает словами. Пусто — шага нет. «Не
 * уверен» — спросить меня (ждёт на главной) или пропустить; без flow спрашивать не о чем.
 */
export function AiCard({ d, set, hist }: DraftProps & { hist: HistoryCheck | null }) {
  const on = Boolean(d.check.trim());
  const runs = draftRuns(d);
  const check = hist?.check;
  const f = hist?.funnel;
  const count = on && f && f.check !== undefined ? `${f.fields.length ? f.matched : f.total} → ${f.check}${check ? ` · ${usd(check.costUsd)}` : ''}` : '';
  const countTitle = check
    ? t('На проверке на истории ИИ прочитал {n} {w}: {usd}{model}', { n: check.events, w: plural(check.events, 'событие', 'события', 'событий'), usd: usd(check.costUsd), model: check.model ? ` · ${modelChip(check.model)}` : '' }) +
      (check.cached ? ` ${t('Из них {n} — ответы прошлой проверки: то же событие по тому же условию модель не перечитывает.', { n: check.cached })}` : '')
    : undefined;
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <svg className={s.aiMark} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M7 1.5l1.3 3.2 3.2 1.3-3.2 1.3L7 10.5 5.7 7.3 2.5 6l3.2-1.3z" stroke="currentColor" fill="none" strokeWidth="1.2" />
        </svg>
        <b>{t('Потом спросить ИИ')}</b>
        <span className={s.meta}>{t('то, что полями не отобрать')}</span>
        <span className={s.gap} />
        {count && <span className={s.cnt} title={countTitle}>{count}</span>}
      </div>
      <TextArea
        className={s.checkText}
        rows={2}
        aria-label={t('Условие для ИИ')}
        title={t('Пиши как коллеге. Пусто — ИИ не спрашивается, дальше идёт всё, что прошло условия по полям')}
        placeholder={t('Например: это запрос на ревью именно мне. Обсуждение чужого MR, где меня просто упомянули, не подходит.')}
        value={d.check}
        onChange={(e) => set({ check: e.target.value })}
      />
      <div className={s.row}>
        <span className={s.lbl}>{t('Не уверен')}</span>
        <Seg<'ask' | 'skip'>
          label={t('Если ИИ не уверен')}
          value={d.checkAsk && runs ? 'ask' : 'skip'}
          disabled={!on || !runs}
          onChange={(v) => set({ checkAsk: v === 'ask' })}
          options={[
            { value: 'ask', label: t('спросить меня'), title: t('Событие ждёт тебя на главной с сомнением ИИ') },
            { value: 'skip', label: t('пропустить'), title: t('Неуверенный ответ — пропуск: лишний запуск стоит денег') },
          ]}
        />
        <span className={s.gap} />
        <span className={s.lbl}>{t('Модель')}</span>
        <ModelSelect
          aria-label={t('Модель ИИ')}
          className={s.aiModel}
          value={d.checkModel}
          disabled={!on}
          defaultLabel={DEFAULT_CHECK_MODEL}
          title={t('Быстрая модель дешевле и обычно справляется; на спорных событиях точнее сильная. Сменишь — проверь на истории снова')}
          onChange={(checkModel) => set({ checkModel })}
        />
      </div>
      {on && !runs && <span className={s.meta}>{t('Рутина без flow только заводит дела: неуверенный ответ считается «пропустить».')}</span>}
    </div>
  );
}
