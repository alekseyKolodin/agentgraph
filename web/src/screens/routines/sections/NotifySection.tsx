// Раздел 3 «Как узнаю» (Notify.dc.html): каналы строками. Главная · «Ждёт тебя» — чипы на те же поля черновика, что
// правятся и в других местах (checkAsk, mode suggest, ответ на проверку): своего состояния у строки нет. Уведомление
// macOS — моменты notify.os. Дело на доске — строка с раскрывающимися настройками дела (блок task). Ответ в сервис или
// мне в Slack/Telegram — reply правила: он один, поэтому строка одна, а «+ Канал» меняет, куда он уйдёт. Каналов,
// которых нет в движке (почта), здесь нет. В «Новой рутине» (onConnect) канал «мне в Slack или Telegram», которого ещё
// нет, — строка с «Подключить».
import { useState } from 'react';
import type { NotifyEvent, RoutinesOverview } from '@server/routines/types';
import { useFeature } from '../../../api';
import { useSpaces } from '../../../api/spaces';
import { Chips, ctlClass, Field, Input, ModelSelect, Select, Seg, TextArea } from '../../../components/form';
import { useConfirm } from '../../../components/ConfirmDialog';
import { SpacePicker } from '../../../components/SpacePicker';
import { t } from '../../../lib/i18n';
import { DEFAULT_CHECK_MODEL } from '../../../lib/routines/graph';
import { replyWhere } from '../../../lib/routines/phrase';
import { draftMissing, draftRuns, isCloseText, isSchedule, NOTIFY_EVENTS, NOTIFY_OS_DEFAULT, type RoutineDraft } from '../../../lib/routines/spec';
import { SourceReplyPanel } from '../ReplySetup';
import { MenuButton, Section, useLeave, type DraftProps, type FilledProp, type MenuItem, type RoutineSource } from './Section';
import s from './Sections.module.css';

const OS_LABEL: Record<NotifyEvent, string> = { start: t('начал'), wait: t('жду тебя'), end: t('закончил'), fail: t('ошибка') };
const REPLY_ON: Array<{ value: RoutineDraft['replyOn'][number]; label: string }> = [
  { value: 'start', label: t('начал') },
  { value: 'pause', label: t('жду тебя') },
  { value: 'end', label: t('закончил') },
];

/** Раздел «Как узнаю» целиком. */
export function NotifySection({ d, set, data, src, filled, onConnect }: DraftProps & FilledProp & {
  data: RoutinesOverview;
  src: RoutineSource;
  /** Подключить сервис, который пишет мне (Slack, Telegram), не теряя черновик; нет — переход на «Подключить сервис». */
  onConnect?: () => void;
}) {
  const leave = useLeave();
  const [taskOpen, setTaskOpen] = useState(false);
  const runs = draftRuns(d);
  const source = src.source;
  const targets = data.sources.filter((x) => x.slug !== d.source && x.canReply);
  const canSource = Boolean(source?.canReply);
  // «Сервис через Claude» без инструмента ответа: ответить в источник нечем, но можно настроить
  const connector = !isSchedule(d) && source?.spec.kind === 'connector' && !source.canReply;
  const missing = draftMissing(d);
  const replyRow = runs && d.reply !== 'off';
  // писать мне некуда: ни источник, ни другой сервис не умеют отвечать — строка канала с «Подключить» (только «Новая
  // рутина»); источник отвечать умеет — подключить ещё один можно из «+ Канал»
  const connectRow = Boolean(onConnect) && runs && !targets.length && !canSource;
  // ответ у правила один: новый канал ответа заменяет нынешний — подпись говорит, что именно заменится
  const now = replyRow ? (d.replyTo === 'source' ? replyWhere(source?.spec.kind, 'source', data.sources) : replyWhere(undefined, d.replyTo, data.sources)) : '';
  const items: MenuItem[] = [
    ...(d.notifyOs.length ? [] : [{ key: 'os', label: t('Уведомление macOS'), onClick: () => set({ notifyOs: [...NOTIFY_OS_DEFAULT] }) }]),
    ...(runs
      ? targets
          .filter((x) => !(replyRow && d.replyTo === x.slug))
          .map((x) => ({
            key: `reply:${x.slug}`,
            label: replyRow ? t('Отвечать мне в «{title}» вместо «{now}»', { title: x.spec.title, now }) : t('Сообщение мне в «{title}»', { title: x.spec.title }),
            title: t('Ответ уйдёт в чат этого источника, а не туда, откуда пришло событие'),
            onClick: () => set({ reply: d.reply === 'off' ? 'draft' : d.reply, replyTo: x.slug }),
          }))
      : []),
    ...(runs && !targets.length && !connectRow ? [{ key: 'connect', label: t('Подключить Slack или Telegram…'), title: t('Сообщения себе идут через источник, который умеет отвечать'), onClick: () => (onConnect ? onConnect() : leave('/routines/connect')) }] : []),
  ];
  const canSourceBtn = runs && !(replyRow && d.replyTo === 'source') && !connector;
  const noSourceWhy = isSchedule(d) ? t('У расписания нет источника: отвечать некуда') : t('Источник «{title}» ответить не умеет', { title: source?.spec.title ?? d.source });
  return (
    <Section n={3} title={t('Как узнаю')} sub={t('куда придёт результат и где решаю я')} last filled={filled}>
      <div className={s.card + ' ' + s.chans}>
        <HomeRow d={d} set={set} />
        {d.notifyOs.length > 0 && (
          <div className={s.chan}>
            <div className={s.chanName}>
              <b>{t('Уведомление macOS')}</b>
              <span className={s.meta}>{t('клик открывает запуск')}</span>
            </div>
            <Chips<NotifyEvent> label={t('Когда уведомлять')} value={d.notifyOs} options={NOTIFY_EVENTS.map((v) => ({ value: v, label: OS_LABEL[v] }))} onChange={(notifyOs) => set({ notifyOs })} />
            <button type="button" className={s.x} aria-label={t('Убрать уведомления macOS')} title={t('Убрать уведомления macOS')} onClick={() => set({ notifyOs: [] })}>×</button>
          </div>
        )}
        {d.taskOn && (
          <div className={s.chan}>
            <div className={s.chanName}>
              <b>{t('Дело на доске «Мои дела»')}</b>
              <span className={missing.includes('kind') || missing.includes('close') ? s.warn : s.meta}>{taskSummary(d)}</span>
            </div>
            <button type="button" className="btn small ghost" aria-expanded={taskOpen} onClick={() => setTaskOpen(!taskOpen)}>
              {taskOpen ? t('Свернуть') : t('Настроить ›')}
            </button>
            <button type="button" className={s.x} aria-label={t('Не заводить дело')} title={t('Не заводить дело')} onClick={() => set({ taskOn: false })}>×</button>
            {taskOpen && (
              <div className={s.chanMore}>
                <TaskSettings d={d} set={set} />
              </div>
            )}
          </div>
        )}
        {replyRow && <ReplyRow d={d} set={set} data={data} src={src} />}
        {runs && d.reply === 'off' && connector && source && <ConnectReplyRow d={d} set={set} src={src} />}
        {connectRow && (
          <div className={s.chan}>
            <div className={s.chanName}>
              <b className={s.off}>{t('Мне в Slack или Telegram')}</b>
              <span className={s.meta}>{t('нет подключённого сервиса, который умеет писать тебе')}</span>
            </div>
            <button type="button" className="btn small" title={t('Подключить Slack или Telegram. Черновик рутины не потеряется, а новый сервис станет каналом ответа')} onClick={onConnect}>
              {t('Подключить')}
            </button>
            <span />
          </div>
        )}
      </div>
      <div className={s.btns}>
        {!d.taskOn && (
          <button type="button" className="btn small" title={t('Событие станет делом в «Моих делах»: одно дело на вещь, сколько бы событий о ней ни пришло')} onClick={() => (set({ taskOn: true, taskKind: d.taskKind || KINDS[0]! }), setTaskOpen(true))}>
            {t('+ Дело на доске')}
          </button>
        )}
        {canSourceBtn && (
          <button
            type="button"
            className="btn small"
            disabled={!canSource}
            title={canSource ? (replyRow ? t('Ответ у рутины один: он уйдёт туда, откуда пришло событие, а не «{now}»', { now }) : t('Ответ туда, откуда пришло событие: тред, чат, MR')) : noSourceWhy}
            onClick={() => set({ reply: d.reply === 'off' ? 'draft' : d.reply, replyTo: 'source' })}
          >
            {replyRow ? t('Отвечать {where} вместо «{now}»', { where: replyWhere(source?.spec.kind, 'source', data.sources), now }) : t('+ Ответ в сервис')}
          </button>
        )}
        {items.length > 0 && <MenuButton left className="btn small" text={t('+ Канал')} title={t('Добавить канал: уведомление macOS или сообщение тебе')} items={items} />}
      </div>
      {/* почему «+ Ответ в сервис» выключен — словами рядом, не только в подсказке */}
      {canSourceBtn && !canSource && <span className={s.meta}>{noSourceWhy}</span>}
    </Section>
  );
}

/**
 * Главная · «Ждёт тебя»: когда событие ждёт решения на главной. Чипы — те же поля, что «Не уверен» у ИИ (checkAsk),
 * «Запускать: после моего «да»» (mode suggest) и «после проверки» у ответа (reply draft). Снять «перед запуском» или
 * «перед блоком» — запуск сразу, снять «ответ на проверку» — ответ уходит сам (с подтверждением): что идёт без тебя,
 * строка говорит словами.
 */
export function HomeRow({ d, set }: DraftProps) {
  const { askConfirm } = useConfirm();
  const runs = draftRuns(d);
  const sched = isSchedule(d);
  const ai = !sched && Boolean(d.check.trim());
  type Moment = 'unsure' | 'before' | 'block' | 'reply';
  const value: Moment[] = [
    ...(ai && runs && d.checkAsk ? ['unsure' as const] : []),
    ...(runs && d.mode === 'suggest' ? ['before' as const] : []),
    ...(runs && d.mode === 'until_pause' ? ['block' as const] : []),
    ...(runs && d.reply === 'draft' ? ['reply' as const] : []),
  ];
  const onChange = async (next: Moment[]) => {
    const has = (m: Moment) => next.includes(m);
    const patch: Partial<RoutineDraft> = {};
    if (has('unsure') !== value.includes('unsure')) patch.checkAsk = has('unsure');
    if (has('before') !== value.includes('before')) patch.mode = has('before') ? 'suggest' : 'auto';
    if (has('block') !== value.includes('block') && !has('block')) patch.mode = 'auto';
    if (has('reply') !== value.includes('reply')) patch.reply = has('reply') ? 'draft' : 'auto';
    // ответ без проверки уходит людям сам: такое — только с подтверждением
    if (patch.reply === 'auto' && !(await askConfirm(t('Ответ будет уходить в сервис сразу, без твоей проверки. Снять проверку?'), { ok: t('Снять проверку'), danger: true }))) return;
    set(patch);
  };
  const runAlone = runs && d.mode === 'auto';
  const replyAlone = runs && d.reply === 'auto';
  const alone = runAlone && replyAlone ? t('запуск и ответ — сразу, без тебя') : runAlone ? t('запуск — сразу, без тебя') : replyAlone ? t('ответ — сразу, без тебя') : '';
  // почему чипы выключены — словами в строке, не только в подсказке
  const why = [
    !runs ? t('без flow ждать решения на главной нечего') : '',
    runs && !sched && !ai ? t('«ИИ не уверен» — нет условия для ИИ') : '',
    runs && d.reply === 'off' ? t('«ответ на проверку» — ответа в сервис нет') : '',
  ].filter(Boolean);
  return (
    <div className={s.chan}>
      <div className={s.chanName}>
        <b>{t('Главная · «Ждёт тебя»')}</b>
        <span className={s.meta}>{t('карточка с кнопками, когда нужно твоё решение')}</span>
        {alone && <span className={s.warn}>{alone}</span>}
        {why.length > 0 && <span className={s.meta}>{why.join(' · ')}</span>}
      </div>
      <Chips<Moment>
        label={t('Когда ждать на главной')}
        value={value}
        onChange={(next) => void onChange(next)}
        options={[
          ...(sched ? [] : [{ value: 'unsure' as const, label: t('ИИ не уверен'), disabled: !ai || !runs, title: ai ? t('ИИ не уверен — событие ждёт тебя, а не отсеивается молча') : t('Нет условия для ИИ: сомневаться некому') }]),
          { value: 'before' as const, label: t('перед запуском'), disabled: !runs, title: t('То же, что «Запускать: после моего «да»». Снять — запуск сразу, без тебя') },
          ...(d.mode === 'until_pause' ? [{ value: 'block' as const, label: t('перед блоком'), disabled: !runs, title: t('То же, что «Запускать: сразу, но стоп перед блоком». Снять — запуск сразу, без тебя') }] : []),
          { value: 'reply' as const, label: t('ответ на проверку'), disabled: !runs || d.reply === 'off', title: d.reply === 'off' ? t('Ответа в сервис нет') : t('Текст ответа ждёт на главной и уходит после твоего одобрения. Снять — ответ уходит сразу, без тебя') },
        ]}
      />
      <span />
    </div>
  );
}

/** Ответ в сервис или мне в чат: куда (если есть из чего выбрать), моменты и как уходит. */
export function ReplyRow({ d, set, data, src }: DraftProps & { data: RoutinesOverview; src: RoutineSource }) {
  const [setupOpen, setSetupOpen] = useState(false);
  const source = src.source;
  const kindName = source?.spec.kind;
  const targets = data.sources.filter((x) => x.slug !== d.source && x.canReply);
  const toSource = d.replyTo === 'source';
  // «Сервис через Claude» без инструмента ответа, а ответ — «в источник»: ответить нечем
  const notSet = toSource && !isSchedule(d) && kindName === 'connector' && !source?.canReply;
  const where = toSource ? (source ? `${source.spec.title} · ${replyWhere(kindName, 'source', data.sources)}` : replyWhere(undefined, 'source', data.sources)) : replyWhere(undefined, d.replyTo, data.sources);
  const options = [...(source?.canReply ? [{ value: 'source', label: replyWhere(kindName, 'source', data.sources) }] : []), ...targets.map((x) => ({ value: x.slug, label: replyWhere(undefined, x.slug, data.sources) }))];
  if (!options.some((o) => o.value === d.replyTo)) options.push({ value: d.replyTo, label: d.replyTo === 'source' ? t('туда, откуда пришло') : d.replyTo });
  /** Отмечен один момент: его не снять — пустой набор правило поняло бы как «жду тебя и закончил». */
  const lastOn = d.replyOn.length === 1;
  return (
    <div className={s.chan}>
      <div className={s.chanName}>
        <b>{where}</b>
        <span className={notSet ? s.warn : s.meta}>
          {notSet ? t('Ответ в источник не настроен: у источника нет инструмента ответа') : d.reply === 'draft' ? t('черновиком, уйдёт после твоей проверки') : t('сразу, без твоей проверки')}
        </span>
      </div>
      {/* пустой набор правило понимает как «жду тебя и закончил» — последний отмеченный момент не снимается */}
      <Chips<RoutineDraft['replyOn'][number]>
        label={t('Когда отвечать')}
        value={d.replyOn}
        options={REPLY_ON.map((o) => (lastOn && d.replyOn[0] === o.value ? { ...o, disabled: true, title: t('Хоть один момент нужен; не отвечать — ×') } : o))}
        onChange={(replyOn) => set({ replyOn })}
      />
      <button type="button" className={s.x} aria-label={t('Не отвечать')} title={t('Не отвечать')} onClick={() => set({ reply: 'off' })}>×</button>
      <div className={s.chanLine}>
        {options.length > 1 && <Select<string> className={s.model} aria-label={t('Куда отвечать')} value={d.replyTo} options={options} onChange={(replyTo) => set({ replyTo })} />}
        <Seg<'draft' | 'auto'>
          label={t('Как уходит ответ')}
          className={s.segSm}
          value={d.reply === 'auto' ? 'auto' : 'draft'}
          onChange={(reply) => set({ reply })}
          options={[
            { value: 'draft', label: t('после проверки') },
            { value: 'auto', label: t('сразу') },
          ]}
        />
        {lastOn && <span className={s.meta}>{t('Хоть один момент нужен; не отвечать — ×')}</span>}
        {notSet && source && !setupOpen && (
          <button type="button" className="btn small" onClick={() => setSetupOpen(true)}>{t('Настроить ответ')}</button>
        )}
      </div>
      {notSet && setupOpen && source && (
        <div className={s.chanMore}>
          <SourceReplyPanel source={source} mode={d.reply} onClose={() => setSetupOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** «Сервис через Claude» без инструмента ответа: строка с «Настроить ответ» — инструмент выбирается для источника. */
function ConnectReplyRow({ d, src }: DraftProps & { src: RoutineSource }) {
  const [open, setOpen] = useState(false);
  const source = src.source!;
  return (
    <div className={s.chan}>
      <div className={s.chanName}>
        <b>{t('Ответ в «{title}»', { title: source.spec.title })}</b>
        <span className={s.meta}>{t('источник пока не умеет отвечать')}</span>
      </div>
      {!open ? (
        <button type="button" className="btn small" title={t('Выбрать инструмент сервиса, которым отвечать. Сохраняется в источнике — для всех его рутин')} onClick={() => setOpen(true)}>
          {t('Настроить ответ ›')}
        </button>
      ) : (
        <span />
      )}
      <span />
      {open && (
        <div className={s.chanMore}>
          <SourceReplyPanel source={source} mode={d.reply} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

const KINDS = ['Ревью', 'Jira', 'Встреча', 'Задача', 'Своё'];
/** Засев дел по текущему списку — не больше стольких записей (SEED_MAX в src/routines/engine.ts). */
const SEED_MAX = 50;

/** Дело одной строкой: «вид «Встреча» · в «Новое» · закрыть, когда закрою сам». */
function taskSummary(d: RoutineDraft): string {
  const col = d.taskColumn === 'plan' ? t('В плане') : t('Новое');
  const close = d.taskClose === 'thing' ? t('закрыть, когда вещь закрыта') : d.taskClose === 'never' ? t('закрою сам') : d.taskClose.trim() ? t('закрыть: {text}', { text: d.taskClose.trim() }) : t('не сказано, когда закрыть');
  return [
    d.taskKind.trim() ? t('вид «{kind}»', { kind: d.taskKind.trim() }) : t('вид дела не назван'),
    t('в «{col}»', { col }),
    d.taskFrom === 'flow' ? t('заводит flow') : close,
    ...(d.taskFrom === 'event' && !isSchedule(d) && d.taskMerge.trim() ? [t('с проверкой перед делом')] : []),
  ].join(' · ');
}

/**
 * Настройки дела (блок task, docs/desk/design/RulePult.dc.html): вид и колонка, кто заводит, что считать тем же делом,
 * что делать с повтором и когда закрыть. Дела из flow заводит сам flow (desk_put).
 */
export function TaskSettings({ d, set }: DraftProps) {
  const closeChoice = isCloseText(d.taskClose) ? 'text' : d.taskClose;
  const spacesOn = useFeature('spaces');
  // у рутины без flow проект дела выбирается здесь (с flow — пространство запуска в «Дополнительно»)
  const ownProject = spacesOn && !draftRuns(d);
  const spaces = useSpaces(ownProject);
  const missing = draftMissing(d);
  return (
    <>
      <div className={s.grid2}>
        <Field label={t('Вид дела')} issue={missing.includes('kind') ? { tone: 'warn', text: t('Назови вид дела') } : undefined}>
          <Input list="routine-task-kinds" value={d.taskKind} onChange={(e) => set({ taskKind: e.target.value })} />
        </Field>
        <datalist id="routine-task-kinds">
          {KINDS.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <Field label={t('Колонка')}>
          <Seg<RoutineDraft['taskColumn']>
            value={d.taskColumn}
            onChange={(taskColumn) => set({ taskColumn })}
            options={[
              { value: 'new', label: t('Новое') },
              { value: 'plan', label: t('В плане') },
            ]}
          />
        </Field>
        <Field label={t('Кто заводит')} help={t('flow заводит дела инструментом desk_put — по одному на вещь, о которой он узнал')}>
          <Seg<RoutineDraft['taskFrom']>
            value={d.taskFrom}
            onChange={(taskFrom) => set({ taskFrom })}
            options={[
              { value: 'event', label: t('само событие') },
              { value: 'flow', label: t('flow') },
            ]}
          />
        </Field>
        {ownProject && (
          <SpacePicker id="routine-task-space" label={t('Проект дела')} value={d.space} onChange={(space) => set({ space })} options={spaces.data?.spaces ?? []} loading={spaces.isPending} placeholder={t('без проекта')} inputClassName={ctlClass({})} />
        )}
        {d.taskFrom === 'event' && (
          <>
            <Field label={t('Тем же делом считать')} help={t('Одно дело на вещь: сколько бы сигналов о ней ни пришло из этой и других рутин, дело одно')}>
              <Select<RoutineDraft['taskSame']>
                value={d.taskSame}
                onChange={(taskSame) => set({ taskSame })}
                options={[
                  { value: '', label: t('ту же вещь, иначе тот же разговор') },
                  { value: 'thing', label: t('ту же вещь (MR, задачу)') },
                  { value: 'thread', label: t('тот же разговор (тред)') },
                  { value: 'event', label: t('ничего — каждое событие отдельно') },
                ]}
              />
            </Field>
            <Field label={t('Пришло новое по тому же')}>
              <Seg<RoutineDraft['taskRepeat']>
                value={d.taskRepeat}
                onChange={(taskRepeat) => set({ taskRepeat })}
                options={[
                  { value: 'plan', label: t('вернуть в план') },
                  { value: 'keep', label: t('оставить, где лежит') },
                ]}
              />
            </Field>
            <Field label={t('Закрыть, когда')}>
              <Select<string>
                value={closeChoice}
                onChange={(v) => set({ taskClose: v === 'text' ? '' : v })}
                options={[
                  { value: 'thing', label: t('вещь закрыта (MR смержен, задача готова)') },
                  { value: 'never', label: t('закрою сам') },
                  { value: 'text', label: t('условие словами…') },
                ]}
              />
            </Field>
            {closeChoice === 'text' && (
              <Field label={t('Условие закрытия')} issue={missing.includes('close') ? { tone: 'warn', text: t('Напиши, когда закрыть дело') } : undefined} hint={t('Условие словами пока не проверяется само: такое дело закроешь руками.')}>
                <Input placeholder={t('Например: в треде ответили «готово»')} value={d.taskClose} onChange={(e) => set({ taskClose: e.target.value })} />
              </Field>
            )}
          </>
        )}
      </div>
      {d.taskFrom === 'event' && !isSchedule(d) && (
        <div className={s.col}>
          <Field
            label={t('Проверить перед делом')}
            help={t('ИИ смотрит событие и открытые дела на доске. Решит, что это продолжение одного из них, — событие допишется в историю того дела: колонка не меняется, flow не запускается. Пусто — дело заводится без проверки')}
            hint={d.taskMerge.trim() ? t('Вызов модели на каждое событие, пока на доске есть открытые дела. Прошлое решение по той же вещи повторяется без модели.') : undefined}
          >
            <TextArea
              rows={2}
              maxLength={2000}
              aria-label={t('Условие проверки перед делом')}
              placeholder={t('Например: если в задаче есть ссылка на MR и по этому MR уже есть дело — это то же дело, нового не заводи.')}
              value={d.taskMerge}
              onChange={(e) => set({ taskMerge: e.target.value })}
            />
          </Field>
          {d.taskMerge.trim() && (
            <div className={s.row}>
              <span className={s.lbl}>{t('Модель')}</span>
              <ModelSelect
                aria-label={t('Модель проверки перед делом')}
                value={d.taskMergeModel}
                defaultLabel={DEFAULT_CHECK_MODEL}
                title={t('Быстрая модель дешевле и обычно справляется; на спорных событиях точнее сильная')}
                onChange={(taskMergeModel) => set({ taskMergeModel })}
              />
            </div>
          )}
        </div>
      )}
      {d.taskFrom === 'event' && !isSchedule(d) && (d.check.trim() || d.taskMerge.trim()) && (
        <span className={s.warn}>{t('Первый опрос заведёт дела по текущему списку источника: до {n} записей, и каждую проверит словами — это расход модели.', { n: SEED_MAX })}</span>
      )}
    </>
  );
}
