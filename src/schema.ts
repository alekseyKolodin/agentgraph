// Схема flow-спецификации: что генерирует генератор и что исполняет раннер.
import { z } from 'zod';

/** Инструменты, которые можно выдать фазе. */
export const KNOWN_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'AskUserQuestion'] as const;
/** Добавляются в каждую сессию автоматически: сабагенты и скиллы. В tools их не перечисляют. */
export const IMPLICIT_TOOLS = ['Agent', 'Skill'] as const;

export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const PermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'plan',
  'auto',
]);

export const PhaseSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9_-]+$/)
    .describe('Идентификатор этапа (латиница, цифры, - или _). Доступен как {{phases.NAME}}.'),
  title: z.string().optional().describe('Человекочитаемое название этапа.'),
  prompt: z
    .string()
    .describe(
      'Промпт этапа. Шаблонные переменные: {{input}}, {{prev}}, {{feedback}}, {{iteration}}, {{max_iterations}}, {{phases.NAME}}, {{history}}, {{artifacts.KEY}} (содержимое артефакта на старте шага; подстановка даёт право чтения), {{artifacts.KEY.path}} (абсолютный путь к нему).',
    ),
  handoff: z
    .string()
    .optional()
    .describe(
      'Что этап передаёт дальше: чем закончить ответ, например «раздел "## Результат": список изменённых файлов, команды, открытые вопросы». Добавляется в конец промпта как инструкция.',
    ),
  system: z
    .string()
    .optional()
    .describe('Кастомный системный промпт. Если не задан, используется стандартный системный промпт Claude Code.'),
  tools: z
    .array(z.string())
    .describe(
      'Инструменты этапа, все они автоматически разрешены без подтверждений: Read, Grep, Glob, Edit, Write, Bash, WebSearch, WebFetch, AskUserQuestion (задать вопрос пользователю и дождаться ответа). Пустой массив = без инструментов (чистое рассуждение). Инструменты Agent (сабагенты) и Skill (скиллы) добавляются в любую сессию автоматически.',
    ),
  reads: z
    .array(z.string())
    .optional()
    .describe('Ключи артефактов запуска, которые этап читает (см. artifacts). Читать свои артефакты этап может и без Read в tools.'),
  writes: z
    .array(z.string())
    .optional()
    .describe(
      'Ключи артефактов, которые этап правит (включает чтение). Даёт запись только в эти файлы, даже без Edit и Write в tools; правка остального по-прежнему требует Edit или Write.',
    ),
  add_dirs: z
    .array(z.string())
    .optional()
    .describe(
      'Дополнительные директории, куда этап может ходить кроме директории проекта (как --add-dir), например отдельный проект с правилами QA. Пути абсолютные, от ~ или относительно директории проекта. Из них подхватываются CLAUDE.md и скиллы (.claude/skills); список директорий дописывается в конец промпта этапа.',
    ),
  plugins: z
    .array(z.string())
    .optional()
    .describe(
      'Локальные плагины Claude Code, которые получает только этот этап (как --plugin-dir): папки плагинов, абсолютные, от ~ или относительно директории проекта. Плагин приносит свои скиллы, агентов, команды, хуки и MCP-серверы; в остальных этапах и у судьи его нет. Несуществующая папка — ошибка до старта.',
    ),
  model: z.string().optional().describe('Модель, например claude-opus-5-5. По умолчанию модель CLI.'),
  effort: EffortSchema.optional(),
  max_turns: z.number().int().positive().optional().describe('Лимит ходов (user->assistant) в сессии.'),
  permission_mode: PermissionModeSchema.optional(),
  max_budget_usd: z.number().positive().optional().describe('Лимит стоимости одной сессии этого этапа в USD.'),
  output_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('JSON Schema. Если задана, этап возвращает структурированный JSON, он же попадает в {{prev}}.'),
  group: z
    .string()
    .regex(/^[a-z0-9_-]+$/)
    .optional()
    .describe(
      'Параллельная группа: соседние этапы одного блока с одинаковым group идут одновременно. В группе от двух этапов, пишущий (Edit или Write) не больше одного, без AskUserQuestion. Все участники видят один {{prev}} — вывод до группы — и не ссылаются друг на друга через {{phases.NAME}}; следующий этап получает в {{prev}} склейку их выводов в порядке объявления.',
    ),
});
export type Phase = z.output<typeof PhaseSchema>;

/** Пишущий этап: может править файлы проекта своими инструментами. Bash сюда не входит. */
export function isWriter(phase: Phase): boolean {
  return phase.tools.includes('Edit') || phase.tools.includes('Write');
}

export const UntilSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('judge'),
    prompt: z
      .string()
      .describe('Рубрика для LLM-судьи (читает файлы через Read/Grep/Glob, может звать сабагентов). Переменные: {{input}}, {{outputs}} (все выводы текущей итерации блока), {{prev}}, {{phases.NAME}}, {{artifacts.KEY}}, {{artifacts.KEY.path}}. Судья читает все артефакты запуска.'),
    model: z.string().optional(),
  }),
  z.object({
    type: z.literal('command'),
    run: z.string().describe('Shell-команда; код выхода 0 = условие выполнено. Её вывод попадает в {{feedback}}.'),
    timeout_sec: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('marker'),
    marker: z.string().describe('Литерал, например <DONE>. Условие выполнено, когда этап закончил им вывод: последняя непустая строка ровно маркер.'),
    phase: z.string().optional().describe('Имя этапа блока, чей вывод проверяем. По умолчанию последний этап блока.'),
  }),
  z.object({ type: z.literal('none') }).describe('Без условия: выполнить ровно max_iterations итераций.'),
]);
export type Until = z.output<typeof UntilSchema>;

export const LoopSchema = z.object({
  max_iterations: z.number().int().min(1).max(50).describe('Максимум итераций цикла.'),
  until: UntilSchema,
  pause_marker: z
    .string()
    .optional()
    .describe(
      'Литерал, например <NEEDS_USER>. Этап, которому дальше нельзя без решения пользователя, заканчивает им вывод (последняя непустая строка), а над ним пишет вопросы. Если условие не выполнено, запуск встаёт на паузу после итерации и не тратит итерации вхолостую. Без UI-сервера (CLI) блок завершается ошибкой.',
    ),
});
export type Loop = z.output<typeof LoopSchema>;

export const OnFailSchema = z.enum(['stop', 'continue']);

/** Слаг тега, как TAG_SLUG_RE в tags.ts (дубль: схема не тянет fs). */
const TAG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const BlockSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9_-]+$/)
    .describe('Идентификатор блока (латиница, цифры, - или _).'),
  title: z.string().optional().describe('Человекочитаемое название блока.'),
  loop: LoopSchema.optional().describe('Цикл блока: этапы повторяются, пока не выполнено условие. Без loop блок проходит один раз.'),
  on_fail: OnFailSchema.optional().describe(
    'Что делать, если цикл исчерпал max_iterations, а условие не выполнено: stop (по умолчанию) — остановить запуск, continue — перейти к следующему блоку.',
  ),
  knowledge: z
    .array(z.string().regex(TAG_SLUG_RE))
    .optional()
    .describe('Теги области знаний блока: слаги тегов вида knowledge со страницы «Теги»; их заметки, пути и вложения получают все этапы блока. Несуществующий тег или тег задачи — ошибка до старта.'),
  plugins: z
    .array(z.string())
    .optional()
    .describe('Локальные плагины Claude Code для всех этапов блока (складываются с plugins этапа): папки плагинов, абсолютные, от ~ или относительно директории проекта. Несуществующая папка — ошибка до старта.'),
  phases: z.array(PhaseSchema).min(1),
});
export type Block = z.output<typeof BlockSchema>;

/** Артефакт запуска: именованный текстовый файл в runs/<id>/artifacts/, переживает итерации и блоки. */
export const ArtifactSchema = z.object({
  title: z.string().optional().describe('Название артефакта; по умолчанию ключ.'),
  file: z
    .string()
    .optional()
    .describe('Имя файла без каталогов: латиница, цифры, . _ -, расширение md, txt, json, yaml или yml. По умолчанию <ключ>.md.'),
  initial: z.string().optional().describe('Начальное содержимое как есть, без подстановок. Без него файл создаётся пустым.'),
  decisions: z
    .boolean()
    .optional()
    .describe('Сюда UI и скилл дописывают ответы пользователя на паузу по просьбе агента. Не больше одного артефакта во flow.'),
});
export type Artifact = z.output<typeof ArtifactSchema>;

const FlowBaseSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/).describe('Slug flow, латиницей через дефис.'),
  description: z.string().optional(),
  input: z.string().optional().describe('Исходная задача пользователя дословно. Доступна как {{input}}.'),
  defaults: z
    .object({
      model: z.string().optional(),
      effort: EffortSchema.optional(),
      max_turns: z.number().int().positive().optional(),
      permission_mode: PermissionModeSchema.optional(),
      max_budget_usd: z.number().positive().optional(),
    })
    .optional(),
  artifacts: z
    .record(z.string(), ArtifactSchema)
    .optional()
    .describe(
      'Артефакты запуска: ключ (латиница, цифры, - и _) -> артефакт. Этапы получают их через reads, writes и {{artifacts.KEY}}, судья читает все, пользователь правит их между шагами.',
    ),
});

/**
 * Флоу в двух формах:
 * - короткая: loop + phases наверху = один блок;
 * - полная: blocks — блоки идут друг за другом, у каждого свой цикл и условие.
 */
export const FlowSchema = FlowBaseSchema.extend({
  loop: LoopSchema.optional(),
  phases: z.array(PhaseSchema).min(1).optional(),
  blocks: z.array(BlockSchema).min(1).optional(),
}).superRefine((spec, ctx) => {
  if (spec.blocks && (spec.phases || spec.loop)) {
    ctx.addIssue({ code: 'custom', path: ['blocks'], message: 'Либо blocks, либо loop + phases наверху: в полной форме цикл и этапы задаются внутри блоков' });
  } else if (!spec.blocks && !spec.phases) {
    ctx.addIssue({ code: 'custom', path: ['phases'], message: 'Нужны phases (один блок) или blocks' });
  }
});
export type FlowSpec = z.output<typeof FlowSchema>;

/** Что генерирует генератор: всегда полная форма. */
export const GeneratedFlowSchema = FlowBaseSchema.extend({
  blocks: z.array(BlockSchema).min(1),
});

/** Имя единственного блока короткой формы. */
export const MAIN_BLOCK = 'main';

/** Блоки флоу независимо от формы записи. */
export function flowBlocks(spec: FlowSpec): Block[] {
  if (spec.blocks) return spec.blocks;
  return [{ name: MAIN_BLOCK, loop: spec.loop, phases: spec.phases ?? [] }];
}

/** Все этапы флоу по порядку. */
export function flowPhases(spec: FlowSpec): Phase[] {
  return flowBlocks(spec).flatMap((b) => b.phases);
}

/** Шаг блока: один этап или параллельная группа. index — номер этапа в блоке. */
export type PhaseStep = { group?: string; phases: { phase: Phase; index: number }[] };

/** Этапы блока по шагам: соседние этапы с одинаковым group — один шаг, остальные — по шагу на этап. */
export function phaseSteps(block: Block): PhaseStep[] {
  const steps: PhaseStep[] = [];
  block.phases.forEach((phase, index) => {
    const last = steps.at(-1);
    if (phase.group && last?.group === phase.group) last.phases.push({ phase, index });
    else steps.push({ ...(phase.group ? { group: phase.group } : {}), phases: [{ phase, index }] });
  });
  return steps;
}

/** Один блок без названия, on_fail и тегов знаний записываем короткой формой (у неё этих полей нет). */
export function compactSpec(spec: FlowSpec): FlowSpec {
  const only = spec.blocks?.length === 1 ? spec.blocks[0] : undefined;
  if (!only || only.title || only.on_fail || only.knowledge?.length || only.plugins?.length) return spec;
  const { blocks: _, ...rest } = spec;
  return { ...rest, ...(only.loop ? { loop: only.loop } : {}), phases: only.phases };
}

/** JSON Schema для structured output генератора. */
export function flowJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(GeneratedFlowSchema, { target: 'draft-7' }) as Record<string, unknown>;
}
