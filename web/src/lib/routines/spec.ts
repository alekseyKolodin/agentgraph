// Сборка RoutineSpec из шагов «Новой рутины» и обратно — для редактора: источник или расписание, условия и проверка
// словами, flow с пространством, папкой и «ждать меня», ответ наружу (шаг 4), лимиты. Слаг файла — из названия.
import type { MatchField, MatchMode, NotifyEvent, ReplySpec, RoutineMode, RoutineSpec, TaskRule, WhenSchedule, WhenSource } from '@server/routines/types';
import { buildMatch, incompleteConds, parseMatch, type Condition } from './match';
import { fromCron, toCron, type ScheduleChoice, DEFAULT_TIME } from './schedule';

/** Шаг 1 «Расписание»: не слаг источника (у источника слаг из [a-z0-9-], двоеточия в нём нет). */
export const SCHEDULE = ':schedule';

/** Шаг 4: «После моей проверки» (по умолчанию), «Сразу», «Не сообщать». */
export type ReplyChoice = 'draft' | 'auto' | 'off';

export type RoutineDraft = {
  title: string;
  enabled: boolean;
  /** Черновик (spec.draft): уходит в правило, только пока рутина выключена. */
  draft?: boolean;
  /** Слаг источника или SCHEDULE; '' — ещё не выбран. */
  source: string;
  conds: Condition[];
  /** Сочетание условий (when.match_mode): all — все, any — хватает одного. В правило пишется только any. */
  condsMode: MatchMode;
  check: string;
  /** Модель узла «ИИ рутины» (when.model); '' — по умолчанию. Пишется в правило, только когда у узла есть условие. */
  checkModel: string;
  /** Исход «спросить меня» узла «ИИ рутины» (when.ask). У нового узла включён. */
  checkAsk: boolean;
  schedule: ScheduleChoice;
  missed: 'ask' | 'skip';
  flow: string;
  input: string;
  space: string;
  cwd: string;
  worktree: 'new' | 'none';
  pauseBefore: string[];
  mode: RoutineMode;
  reply: ReplyChoice;
  /** Куда: 'source' — туда, откуда событие; слаг источника с canReply — в его чат. */
  replyTo: string;
  /** Когда писать: старт, пауза, конец. */
  replyOn: Array<'start' | 'pause' | 'end'>;
  usd: string;
  perDay: string;
  parallel: string;
  model: string;
  knowledge: string[];
  /** Шаг «Дело»: рутина заводит дела (блок task). Без flow при taskOn — только заводит дела. */
  taskOn: boolean;
  taskKind: string;
  taskColumn: 'new' | 'plan';
  taskFrom: 'event' | 'flow';
  /** '' — само: вещь, если распознана, иначе нить, иначе событие. */
  taskSame: '' | 'thing' | 'thread' | 'event';
  taskRepeat: 'plan' | 'keep';
  /** 'thing' | 'never' | условие словами. */
  taskClose: string;
  /** Проверка перед делом словами (task.merge): пусто — дело заводится без неё. */
  taskMerge: string;
  /** Модель проверки перед делом (task.merge_model); пусто — по умолчанию. */
  taskMergeModel: string;
  /** О чём слать системное уведомление (notify.os). В правило пишется, только если отличается от NOTIFY_OS_DEFAULT. */
  notifyOs: NotifyEvent[];
};

/** Уведомления рутины без настройки (как NOTIFY_OS_DEFAULT в src/routines/engine.ts): всё, кроме старта. */
export const NOTIFY_OS_DEFAULT: readonly NotifyEvent[] = ['wait', 'end', 'fail'];
/** Порядок пунктов настройки уведомлений. */
export const NOTIFY_EVENTS: readonly NotifyEvent[] = ['start', 'wait', 'end', 'fail'];

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** Закрытие дела условием словами: в форме — отдельное поле (taskClose хранит сам текст). */
export const isCloseText = (close: string): boolean => close !== 'thing' && close !== 'never';

export function emptyDraft(): RoutineDraft {
  return {
    title: '',
    enabled: false,
    source: '',
    conds: [],
    condsMode: 'all',
    check: '',
    checkModel: '',
    checkAsk: true,
    schedule: { preset: 'weekdays', time: DEFAULT_TIME },
    missed: 'ask',
    flow: '',
    input: '',
    space: '',
    cwd: '',
    worktree: 'none',
    pauseBefore: [],
    mode: 'suggest',
    reply: 'draft',
    replyTo: 'source',
    replyOn: ['pause', 'end'],
    usd: '',
    perDay: '',
    parallel: '',
    model: '',
    knowledge: [],
    taskOn: false,
    taskKind: '',
    taskColumn: 'new',
    taskFrom: 'event',
    taskSame: '',
    taskRepeat: 'plan',
    taskClose: 'thing',
    taskMerge: '',
    taskMergeModel: '',
    notifyOs: [...NOTIFY_OS_DEFAULT],
  };
}

/** Шаг «Дело» → блок task. Значения по умолчанию не пишутся; проект — пространство формы, если flow нет (иначе run.space). */
export function taskRule(d: RoutineDraft): TaskRule | undefined {
  if (!d.taskOn) return undefined;
  const close = d.taskClose.trim();
  return {
    kind: d.taskKind.trim(),
    ...(d.taskColumn !== 'new' ? { column: d.taskColumn } : {}),
    ...(d.taskFrom === 'flow' ? { from: 'flow' as const } : {}),
    ...(d.taskSame ? { same: d.taskSame } : {}),
    ...(d.taskRepeat !== 'plan' ? { on_repeat: d.taskRepeat } : {}),
    ...(close && close !== 'thing' ? { close } : {}),
    // проверка перед делом — только у дел из события: дела flow заводит сам
    ...(d.taskFrom === 'event' && !isSchedule(d) && d.taskMerge.trim() ? { merge: d.taskMerge.trim(), ...(d.taskMergeModel.trim() ? { merge_model: d.taskMergeModel.trim() } : {}) } : {}),
    ...(!draftRuns(d) && d.space ? { project: d.space } : {}),
  };
}

/** Рутина запускает flow: без шага «Дело» — всегда, с ним — если flow выбран (или дела заводит flow). */
export const draftRuns = (d: Pick<RoutineDraft, 'taskOn' | 'taskFrom' | 'flow'>): boolean => !d.taskOn || d.taskFrom === 'flow' || Boolean(d.flow);

export const isSchedule = (d: Pick<RoutineDraft, 'source'>): boolean => d.source === SCHEDULE;

/** Шаг 4 → reply правила (types.ts → ReplySpec). */
export function replySpec(choice: ReplyChoice, to: string, on: RoutineDraft['replyOn'] = ['pause', 'end']): ReplySpec {
  if (choice === 'off') return { to: 'none' };
  return { to: to || 'source', on: on.length ? on : ['pause', 'end'], draft: choice === 'draft' };
}

/** reply правила → выбор шага 4. Нет reply — «Не сообщать». */
export function replyChoice(reply: ReplySpec | undefined): ReplyChoice {
  if (!reply || reply.to === 'none') return 'off';
  return reply.draft === false ? 'auto' : 'draft';
}

const num = (s: string): number | undefined => {
  const n = Number(s.replace(',', '.').replace(/^\$/, '').trim());
  return s.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Шаги → RoutineSpec. fields — поля условий выбранного источника (типы значений). Пустое не пишется. */
export function buildSpec(d: RoutineDraft, fields: MatchField[]): RoutineSpec {
  let when: WhenSource | WhenSchedule;
  if (isSchedule(d)) when = { schedule: toCron(d.schedule), missed: d.missed };
  else {
    const match = buildMatch(d.conds, fields);
    // модель и «спросить меня» — настройки узла «ИИ рутины»: без условия словами узла нет, и в правило они не идут
    const node = d.check.trim() ? { check: d.check.trim(), ...(d.checkModel.trim() ? { model: d.checkModel.trim() } : {}), ...(d.checkAsk ? { ask: true } : {}) } : {};
    // «любое» — только когда сочетать есть что: у одного условия режим скрыт в форме и в правило не уходит
    when = { source: d.source, ...(match ? { match } : {}), ...(match && match.length > 1 && d.condsMode === 'any' ? { match_mode: 'any' as const } : {}), ...node };
  }
  const mode = d.mode;
  const limits = { usd: num(d.usd), per_day: num(d.perDay), parallel: num(d.parallel) };
  const hasLimits = Object.values(limits).some((v) => v !== undefined);
  const task = taskRule(d);
  const runs = draftRuns(d);
  const run: RoutineSpec['run'] = {
    flow: d.flow,
    ...(d.input.trim() ? { input: d.input.trim() } : {}),
    ...(d.space ? { space: d.space } : {}),
    ...(d.cwd.trim() ? { cwd: d.cwd.trim() } : {}),
    ...(d.worktree === 'new' ? { worktree: 'new' as const } : {}),
    ...(mode === 'until_pause' && d.pauseBefore.length ? { pause_before: d.pauseBefore } : {}),
    ...(d.knowledge.length ? { knowledge: d.knowledge } : {}),
    ...(d.model.trim() ? { model: d.model.trim() } : {}),
  };
  return {
    title: d.title.trim(),
    enabled: d.enabled,
    ...(d.draft && !d.enabled ? { draft: true } : {}),
    when,
    ...(runs ? { run } : {}),
    mode,
    // без flow отвечать в источник нечему: ответ уходит на старт, паузу и конец запуска
    reply: runs ? replySpec(d.reply, d.replyTo, d.replyOn) : { to: 'none' },
    ...(hasLimits ? { limits: Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined)) } : {}),
    ...(task ? { task } : {}),
    // по умолчанию не пишется: старые правила и новые без настройки ведут себя одинаково
    ...(sameSet([...new Set(d.notifyOs)], NOTIFY_OS_DEFAULT) ? {} : { notify: { os: NOTIFY_EVENTS.filter((x) => d.notifyOs.includes(x)) } }),
  };
}

const str = (n: number | undefined) => (n === undefined ? '' : String(n));

/** RoutineSpec → шаги (редактор правит то же состояние, что и создание). */
export function draftFromSpec(spec: RoutineSpec): RoutineDraft {
  const d = emptyDraft();
  const w = spec.when;
  const sched = 'schedule' in w;
  const run = spec.run;
  const task = spec.task;
  return {
    ...d,
    title: spec.title,
    enabled: spec.enabled !== false,
    ...(spec.draft ? { draft: true } : {}),
    source: sched ? SCHEDULE : w.source,
    conds: sched ? [] : parseMatch(w.match),
    condsMode: !sched && w.match_mode === 'any' ? 'any' : 'all',
    check: sched ? '' : (w.check ?? ''),
    checkModel: sched ? '' : (w.model ?? ''),
    // у правила с условием — как записано (старые правила без поля не спрашивают); узла ещё нет — новый будет спрашивать
    checkAsk: sched || !w.check?.trim() ? true : w.ask === true,
    schedule: sched ? fromCron(w.schedule) : d.schedule,
    missed: sched ? (w.missed ?? 'ask') : 'ask',
    flow: run?.flow ?? '',
    input: run?.input ?? '',
    space: run?.space ?? task?.project ?? '',
    cwd: run?.cwd ?? '',
    worktree: run?.worktree === 'new' ? 'new' : 'none',
    pauseBefore: run?.pause_before ?? [],
    mode: spec.mode,
    reply: replyChoice(spec.reply),
    replyTo: spec.reply && spec.reply.to !== 'none' ? spec.reply.to : 'source',
    replyOn: spec.reply?.on?.length ? spec.reply.on : ['pause', 'end'],
    usd: str(spec.limits?.usd),
    perDay: str(spec.limits?.per_day),
    parallel: str(spec.limits?.parallel),
    model: run?.model ?? '',
    knowledge: run?.knowledge ?? [],
    ...(task
      ? {
          taskOn: true,
          taskKind: task.kind,
          taskColumn: task.column ?? 'new',
          taskFrom: task.from ?? 'event',
          taskSame: task.same ?? '',
          taskRepeat: task.on_repeat ?? 'plan',
          taskClose: task.close ?? 'thing',
          taskMerge: task.merge ?? '',
          taskMergeModel: task.merge_model ?? '',
        }
      : {}),
    notifyOs: [...(spec.notify?.os ?? NOTIFY_OS_DEFAULT)],
  };
}

/** Чего не хватает, чтобы сохранить: источник, flow (не нужен, если рутина только заводит дела), блок у «перед блоком», вид дела, условие закрытия. */
export function draftMissing(d: RoutineDraft): Array<'source' | 'flow' | 'block' | 'kind' | 'close'> {
  const out: Array<'source' | 'flow' | 'block' | 'kind' | 'close'> = [];
  if (!d.source) out.push('source');
  if (!d.flow && (!d.taskOn || d.taskFrom === 'flow')) out.push('flow');
  if (d.flow && d.mode === 'until_pause' && !d.pauseBefore.length) out.push('block');
  if (d.taskOn && !d.taskKind.trim()) out.push('kind');
  // «условие словами» выбрано, а условия нет — иначе молча сохранилось бы закрытие по вещи
  if (d.taskOn && d.taskFrom === 'event' && !d.taskClose.trim()) out.push('close');
  return out;
}

/**
 * Строки условий, которые не сохранятся, пока не дописаны (индексы d.conds): остальное правило сохраняется, а эти
 * строки buildSpec пропускает. draftMissing их не считает — иначе одна пустая строка держала бы всё сохранение. Экран
 * подсвечивает строки и не пишет «черновик сохранён» без оговорки, пока список не пуст: spec с такой строкой и без неё
 * одинаков, и по сравнению spec её не видно.
 */
export function draftUnsavedConds(d: Pick<RoutineDraft, 'source' | 'conds'>): number[] {
  return isSchedule(d) ? [] : incompleteConds(d.conds);
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
/** Адреса экранов /routines/new и /routines/connect: такие слаги заняли бы маршрут. */
const RESERVED = new Set(['new', 'connect', 'waits', 'catchup', 'sources', 'recipes', 'flow-templates', 'compose', 'check-dir', 'form-draft', 'assistant', 'assistant-draft', 'mcp-tools']);

/** Слаг файла из названия: [a-z0-9-], не длиннее 48, свободный среди taken («-2», «-3»…). */
export function slugify(title: string, taken: Iterable<string> = []): string {
  const base =
    [...title.toLowerCase()]
      .map((ch) => TRANSLIT[ch] ?? ch)
      .join('')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'routine';
  const used = new Set(taken);
  let slug = RESERVED.has(base) ? `${base}-routine` : base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}
