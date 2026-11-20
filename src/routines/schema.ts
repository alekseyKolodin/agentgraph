// Рутины: схемы файлов (zod), чтение и запись YAML, слаги и проблемы правила (flow не найден, блока нет, источник не
// подключён, плохой cron). Битый файл не валит движок: рутина показывается с problems.
import { z } from 'zod';
import YAML from 'yaml';
import type { RoutineSpec, SourceSpec } from './types.js';
import { parseCron } from './schedule.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error(`Недопустимый слаг: ${slug} (латиница в нижнем регистре, цифры, дефис)`);
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Слаг из заголовка: кириллица транслитом, всё прочее — дефис. Пусто — 'routine'. */
export function slugify(title: string, fallback = 'routine'): string {
  const s = [...title.toLowerCase()]
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return s || fallback;
}

/** Свободный слаг: base, base-2, base-3… */
export function freeSlug(title: string, taken: (slug: string) => boolean, fallback?: string): string {
  const base = slugify(title, fallback);
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

// ---------------------------------------------------------------- интервал

/** '30s' | '5m' | '1h' | '1d' → мс; плохое — undefined. */
export function parseEvery(s: string | undefined): number | undefined {
  const m = s?.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
  if (!m) return undefined;
  const n = Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n > 0 ? n : undefined;
}

// ---------------------------------------------------------------- схемы

const FieldMapSchema = z
  .object({
    items: z.string().optional(),
    id: z.string().min(1),
    title: z.string().optional(),
    text: z.string().optional(),
    link: z.string().optional(),
    at: z.string().optional(),
    author: z.string().optional(),
  })
  .strict();

export const SourceSpecSchema = z
  .object({
    title: z.string().min(1, 'нужен title'),
    kind: z.string().min(1, 'нужен kind'),
    config: z.record(z.string(), z.unknown()).default({}),
    every: z
      .string()
      .refine((s) => parseEvery(s) !== undefined, 'every — число и единица: 30s, 5m, 1h')
      .optional(),
    map: FieldMapSchema.optional(),
    description: z.string().optional(),
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'имя ключа — ЗАГЛАВНЫЕ_БУКВЫ_И_ЦИФРЫ')).optional(),
  })
  .strict();

/**
 * Значение условия. Пустое — '' (в YAML `value:` без значения это null, нет ключа — undefined) — допустимо: условие не
 * дописано и не применяется (matchConditions в match.ts), рутина из-за него не ломается.
 */
const MatchValue = z.preprocess(
  (v) => v ?? '',
  z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))], { error: 'значение условия — строка, число, да/нет или список строк и чисел' }),
);

const MatchConditionSchema = z
  .object({
    // пустое поле — недописанная строка редактора: не применяется, как пустое значение
    field: z.preprocess((v) => v ?? '', z.string().trim()).describe('Поле события (title, text, author, link) или путь в fields через точку: channel, labels.0. Пусто — условие не применяется'),
    op: z.enum(['eq', 'ne', 'contains', 'gt', 'lt'], { error: 'op условия — eq, ne, contains, gt или lt' }).optional().describe('eq — равно (по умолчанию), ne — не равно, contains — содержит, gt / lt — больше / меньше'),
    value: MatchValue.describe('Значение или список: у eq и contains — любое из, у ne — ни одно из. Пусто — условие не применяется'),
  })
  .strict();

const WhenSourceSchema = z
  .object({
    source: z.string().regex(SLUG_RE, 'источник — слаг: латиница в нижнем регистре, цифры, дефис'),
    match: z
      .union([z.array(MatchConditionSchema), z.record(z.string(), MatchValue)], { error: 'match — список условий { field, op, value } (или старый словарь «поле: значение»)' })
      .optional()
      .describe('Условия на поля без модели: список { field, op, value }. Старый словарь «поле+суффикс: значение» тоже читается'),
    match_mode: z.enum(['all', 'any']).optional().describe('Как сочетать условия на поля: all — все (по умолчанию), any — хватает одного'),
    check: z.string().optional(),
    model: z.string().trim().min(1).max(100).optional().describe('Модель узла «ИИ рутины» (проверки словами): псевдоним (haiku, sonnet, opus) или id модели. Нет — модель по умолчанию'),
    ask: z.boolean().optional().describe('Исход «спросить меня»: когда модель не уверена, событие ждёт человека на главной, а не отсеивается. Действует у рутины с flow'),
  })
  .strict();

const WhenScheduleSchema = z
  .object({
    schedule: z.string().min(1, 'нужно расписание cron: «30 9 * * 1-5»'),
    missed: z.enum(['ask', 'skip']).optional(),
  })
  .strict();

/** Блок task: рутина заводит дела (docs/desk/SPEC.md, этап 3). */
export const TaskRuleSchema = z
  .object({
    kind: z.string().trim().min(1, 'нужен task.kind — вид дела словом: Ревью, Jira, Встреча').describe('Вид дела свободным текстом: «Ревью», «Jira», «Встреча»'),
    column: z.enum(['new', 'plan']).optional().describe('Куда класть новое дело: new — «Новое» (по умолчанию), plan — «В плане»'),
    from: z.enum(['event', 'flow']).optional().describe('event — событие и есть дело (по умолчанию); flow — дела заводит flow инструментом desk_put'),
    same: z.enum(['thing', 'thread', 'event']).optional().describe('Что считать тем же делом: thing — та же вещь (MR, задача), thread — тот же разговор, event — каждое событие отдельно. По умолчанию — вещь, если распознана, иначе нить, иначе событие'),
    on_repeat: z.enum(['plan', 'keep']).optional().describe('Пришло новое по тому же делу: plan — вернуть в «В плане» (по умолчанию), keep — оставить колонку'),
    close: z.string().trim().min(1).optional().describe('Когда закрывать: thing — когда вещь закрыта (по умолчанию), never — только руками, или условие словами'),
    project: z.string().trim().min(1).optional().describe('Проект дела — слаг пространства; нет — пространство из run'),
  })
  .strict();

export const RoutineSpecSchema = z
  .object({
    title: z.string().min(1, 'нужен title'),
    enabled: z.boolean().optional(),
    draft: z.boolean().optional(),
    when: z.union([WhenSourceSchema, WhenScheduleSchema], { error: 'when — источник { source, match, … } или расписание { schedule }' }),
    run: z
      .object({
        flow: z.string().min(1, 'нужен run.flow'),
        input: z.string().optional(),
        space: z.string().optional(),
        cwd: z.string().optional(),
        worktree: z.enum(['new', 'none']).optional(),
        pause_before: z.array(z.string()).optional(),
        knowledge: z.array(z.string()).optional(),
        model: z.string().optional(),
      })
      .strict()
      .optional(),
    mode: z.enum(['suggest', 'until_pause', 'auto']),
    reply: z
      .object({
        to: z.string().refine((v) => v === 'none' || v === 'source' || SLUG_RE.test(v), 'reply.to — none, source или слаг источника'),
        on: z.array(z.enum(['start', 'pause', 'end'])).optional(),
        draft: z.boolean().optional(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        usd: z.number().positive().optional(),
        per_day: z.number().int().positive().optional(),
        parallel: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    task: TaskRuleSchema.optional(),
    notify: z
      .object({
        os: z
          .array(z.enum(['start', 'wait', 'end', 'fail']))
          .optional()
          .describe('О чём слать системное уведомление: start — запуск начался, wait — ждёт решения, end — ответ ждёт проверки, fail — запуск не удался. Нет — wait, end, fail; [] — молчать'),
      })
      .strict()
      .optional()
      .describe('Уведомления по рутине; уведомления об источниках от них не зависят'),
  })
  .strict()
  .superRefine((spec, ctx) => {
    // рутина либо запускает flow, либо заводит дела событием; дела «из flow» без flow заводить некому
    if (!spec.run && !spec.task) ctx.addIssue({ code: 'custom', path: ['run'], message: 'нужен run.flow или блок task' });
    else if (!spec.run && spec.task?.from === 'flow') ctx.addIssue({ code: 'custom', path: ['run'], message: 'task.from: flow — дела заводит flow, нужен run.flow' });
  });

type Issue = z.core.$ZodIssue;

/** Насколько глубоко ушла ветка union: чем глубже, тем ближе она к тому, что имел в виду автор. */
const depthOf = (list: Issue[]): number => Math.max(0, ...list.map((i) => i.path.length + (i.code === 'invalid_union' ? Math.max(0, ...i.errors.map(depthOf)) : 0)));

/**
 * Ошибки zod → строки «путь: что не так». union (when — источник или расписание, match — список или словарь) при
 * неудаче всех веток zod называет одной строкой («Invalid input» или error union); здесь вместо неё — ошибки той ветки,
 * что прошла дальше всех. Все ветки упали на самом значении (не тот тип) — сообщение union.
 */
function flatIssues(list: Issue[], base: PropertyKey[] = []): Array<{ path: PropertyKey[]; message: string }> {
  const out: Array<{ path: PropertyKey[]; message: string }> = [];
  for (const i of list) {
    const path = [...base, ...i.path];
    if (i.code === 'invalid_union' && i.errors.length) {
      const deep = i.errors.filter((b) => depthOf(b) > 0);
      if (deep.length) {
        const best = deep.reduce((a, b) => (depthOf(b) > depthOf(a) ? b : a));
        out.push(...flatIssues(best, path));
        continue;
      }
    }
    out.push({ path, message: i.message });
  }
  return out;
}

function issues(err: z.ZodError): string[] {
  return flatIssues(err.issues).map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message));
}

export type Parsed<T> = { spec?: T; problems: string[] };

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): Parsed<T> {
  const r = schema.safeParse(raw);
  return r.success ? { spec: r.data, problems: [] } : { problems: issues(r.error) };
}

function parseYaml(text: string): { raw?: unknown; problem?: string } {
  try {
    return { raw: YAML.parse(text) };
  } catch (err) {
    return { problem: `YAML не читается: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
}

export function parseRoutine(raw: unknown): Parsed<RoutineSpec> {
  return parseWith(RoutineSpecSchema, raw) as Parsed<RoutineSpec>;
}

export function parseRoutineYaml(text: string): Parsed<RoutineSpec> {
  const y = parseYaml(text);
  return y.problem ? { problems: [y.problem] } : parseRoutine(y.raw);
}

export function parseSource(raw: unknown): Parsed<SourceSpec> {
  return parseWith(SourceSpecSchema, raw) as Parsed<SourceSpec>;
}

export function parseSourceYaml(text: string): Parsed<SourceSpec> {
  const y = parseYaml(text);
  return y.problem ? { problems: [y.problem] } : parseSource(y.raw);
}

export const toYaml = (spec: RoutineSpec | SourceSpec): string => YAML.stringify(spec, { lineWidth: 0 });

export const isSchedule = (when: RoutineSpec['when']): when is Extract<RoutineSpec['when'], { schedule: string }> => 'schedule' in when;

// ---------------------------------------------------------------- проблемы правила

export type ProblemCtx = {
  /** Блоки flow по имени; нет flow — undefined. */
  flowBlocks: (name: string) => string[] | undefined;
  /** Источник подключён (файл есть и читается). */
  sourceExists: (slug: string) => boolean;
};

/** Проблемы сохранённого правила: схема прошла, а сослаться не на что. Пусто — правило рабочее. */
export function routineProblems(spec: RoutineSpec, ctx: ProblemCtx): string[] {
  const out: string[] = [];
  const run = spec.run;
  if (run) {
    let blocks: string[] | undefined;
    try {
      blocks = ctx.flowBlocks(run.flow);
    } catch (err) {
      out.push(`flow ${run.flow} не читается: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!blocks && !out.length) out.push(`flow ${run.flow} не найден`);
    if (blocks) for (const b of run.pause_before ?? []) if (!blocks.includes(b)) out.push(`во flow ${run.flow} нет блока «${b}» из pause_before`);
  } else {
    if (spec.reply && spec.reply.to !== 'none') out.push('ответ: рутина без flow только заводит дела — отвечать в источник нечему');
    if (isSchedule(spec.when)) out.push('расписание без flow: заводить дело по часам не из чего — выбери источник или flow');
  }
  if (isSchedule(spec.when)) {
    const c = parseCron(spec.when.schedule);
    if (typeof c === 'string') out.push(`расписание: ${c}`);
  } else if (!ctx.sourceExists(spec.when.source)) out.push(`источник ${spec.when.source} не подключён`);
  if (spec.reply && spec.reply.to !== 'none' && spec.reply.to !== 'source' && !ctx.sourceExists(spec.reply.to)) out.push(`ответ: источник ${spec.reply.to} не подключён`);
  if (spec.reply?.to === 'source' && isSchedule(spec.when)) out.push('ответ «в источник» у расписания некуда: выбери источник с чатом');
  // 7: черновик ждёт решения человека, а на старте решения нет — «Взял в работу» при draft не уходит
  if (spec.reply?.draft && spec.reply.to !== 'none' && (spec.reply.on ?? ['start']).includes('start')) out.push('ответ: при draft «Взял в работу» на старте не отправляется — черновик уходит на паузе или в конце');
  return out;
}
