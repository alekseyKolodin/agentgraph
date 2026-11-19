// Помощник раздела «Рутины» (docs/ASSISTANTS.md §1): знания — templates/knowledge/routines.md, инструменты — здесь.
// Читает сам: что есть у человека, сервисы Claude, образец записей источника, проверку правила на истории, журнал.
// Делает сам (шаг виден в ленте): подключает «Сервис через Claude», меняет частоту опроса, собирает flow, заполняет
// черновик формы. Только человек: включить рутину, ввести ключ, удалить, отправить наружу — таких инструментов тут нет.
// Помощник читает тексты из сервисов, поэтому всё, что он называет сам, проверяется: инструменты — по списку читающих,
// папка — по тому, что назвал человек, права собранного flow — по словам человека. Тексты из сервисов (записи,
// описания инструментов, ошибки, названия от сборщика) уходят модели только данными (wrapData, AssistantFail.data).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AssistantFail, createAssistant, defineTool, type Assistant, type AssistantOptions, type AssistantSection, type AssistantTool, type AssistantToolCtx } from '../assistant.js';
import type { McpServer } from '../connectors.js';
import { flowFileName, flowToYaml } from '../flows.js';
import { generateFlow } from '../generate.js';
import { wrapData } from '../intake.js';
import { APP_DIR } from '../paths.js';
import type { FlowSpec } from '../schema.js';
import { buildSpec, type ComposeContext } from './compose.js';
import { expandDir } from './dir-check.js';
import { RoutineError, type RoutineEngine } from './engine.js';
import { freeSlug, parseEvery } from './schema.js';
import { mcpServices, type ConnectorBuilds } from './sources/connector.js';
import type { DirCheck, HistoryCheck, RoutineAssistantDraft, RoutineEvent, RoutineSpec, WhenSource } from './types.js';

/** Модель по умолчанию; человек выбирает свою в шапке помощника. */
export const ASSISTANT_MODEL = 'sonnet';
const SAMPLE_TEXT = 300;
const TOOL_DESC = 160;
const TOOLS_PER_SERVICE = 40;
const BUILD_TICK_MS = 500;

type Ctx = AssistantToolCtx<RoutineAssistantDraft>;

export type RoutineAssistantDeps = {
  engine: Pick<RoutineEngine, 'testSource' | 'saveSource' | 'history' | 'sourceViews' | 'kindViews' | 'kind' | 'store' | 'logOf' | 'routineView'>;
  /** Что есть у человека: источники, виды, flow, пространства (как у сборки словами). */
  context: () => ComposeContext;
  mcpServers: (force: boolean) => Promise<{ servers: McpServer[]; at: string }>;
  builds: ConnectorBuilds;
  checkDir: (p: string) => Promise<DirCheck>;
  /** Папка сервера по умолчанию: в ней собирается flow, если человек не назвал свою. */
  defaultCwd: string;
  /** Сборка flow; в тестах подменяется. */
  generate?: typeof generateFlow;
  /** Сохранить собранный flow; по умолчанию — файлом в flows/. */
  saveFlow?: (spec: FlowSpec) => { name: string };
  /** Пакет знаний; по умолчанию — templates/knowledge/routines.md. */
  knowledge?: () => string;
};

export const knowledgeFile = (): string => path.join(APP_DIR, 'templates', 'knowledge', 'routines.md');

function readKnowledge(): string {
  try {
    return fs.readFileSync(knowledgeFile(), 'utf8');
  } catch {
    return 'Пакет знаний раздела не найден: работай по описаниям инструментов и спискам человека, чего не знаешь — спрашивай.';
  }
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const short = (tool: string): string => tool.split('__').slice(2).join('__') || tool;

function sampleText(events: RoutineEvent[]): string {
  if (!events.length) return '(записей нет)';
  return events
    .map((e, i) => `${i + 1}. ${clip(e.title, 160)}${e.author ? ` — ${clip(String(e.author), 60)}` : ''} (${e.at})\n   ${clip(e.text.replace(/\s+/g, ' '), SAMPLE_TEXT)}${e.link ? `\n   ${e.link}` : ''}`)
    .join('\n');
}

const OUTCOME: Record<HistoryCheck['events'][number]['outcome'], string> = { started: 'запустил бы', waiting: 'ждал бы «Запустить?»', filtered: 'не прошло условия по полям', check_no: 'ИИ рутины пропустил бы', duplicate: 'повтор' };

function everyOf(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Правило для проверки на истории: недостающий flow историю не меняет (flow она не запускает), а схему ломает. */
function historyProbe(spec: RoutineSpec, flows: ComposeContext['flows']): RoutineSpec {
  const probe: RoutineSpec = JSON.parse(JSON.stringify(spec));
  if (probe.run && !probe.run.flow) {
    if (probe.task) delete probe.run;
    else probe.run.flow = flows[0]?.name ?? 'x';
  }
  return probe;
}

/** Форма, как её видит человек сейчас: экран присылает правило с каждым сообщением ({ spec }); не то — undefined. */
export function formOf(client: unknown): RoutineSpec | undefined {
  const spec = client && typeof client === 'object' ? (client as { spec?: unknown }).spec : undefined;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return undefined;
  const when = (spec as { when?: unknown }).when;
  return when && typeof when === 'object' && !Array.isArray(when) ? (spec as RoutineSpec) : undefined;
}

/** Путь без «~», точек и хвостового слэша: «~/» и домашняя папка — одно и то же. */
const normDir = (p: string): string => path.resolve(expandDir(p));

/** Абсолютные пути из сообщений человека: «/…» и «~/…» отдельным словом, без хвостовой пунктуации. */
export function saidDirs(said: string[]): string[] {
  const out = new Set<string>();
  for (const t of said) {
    for (const m of t.matchAll(/(?:^|[\s"'«(`])((?:~\/|\/)[^\s"'«»`<>()]*)/g)) {
      const raw = m[1]!.replace(/[.,;:!?]+$/, '');
      if (raw) out.add(normDir(raw));
    }
  }
  return [...out];
}

/**
 * Можно ли помощнику взять эту папку: только абсолютный путь, в точности равный папке по умолчанию, папке пространства,
 * папке из формы человека или названной им в разговоре. Корень диска и домашняя папка целиком не годятся никогда:
 * в них ключи и чужие репозитории. Подстрока не подходит — «/» есть в любом «и/или».
 */
export function dirProblem(dir: string, allowed: string[]): string | undefined {
  const raw = dir.trim();
  if (!raw.startsWith('/') && !raw.startsWith('~/')) return 'нужен абсолютный путь к папке проекта';
  const abs = normDir(raw);
  if (abs === path.parse(abs).root || abs === path.resolve(os.homedir())) return 'корень диска и домашняя папка целиком не подходят: нужна папка проекта';
  return allowed.includes(abs) ? undefined : 'эту папку человек не называл, и это не папка его пространства';
}

/** Что есть у человека сейчас: то же видит помощник в начале хода и отдаёт get_state. */
export function routineState(deps: Pick<RoutineAssistantDeps, 'engine' | 'context' | 'defaultCwd'>, chat: { result?: RoutineAssistantDraft; client?: unknown } = {}): string {
  const { engine } = deps;
  const ctx = deps.context();
  const views = new Map(engine.sourceViews().map((s) => [s.slug, s]));
  const kinds = new Map(engine.kindViews().map((k) => [k.kind, k]));
  // форма человека свежее черновика помощника: он мог поправить её руками после set_draft
  const form = formOf(chat.client) ?? chat.result?.spec;
  return JSON.stringify(
    {
      sources: ctx.sources.map((s) => {
        const v = views.get(s.slug);
        const k = kinds.get(s.kind);
        return { ...s, status: v?.status, ...(v?.error ? { error: clip(v.error, 200) } : {}), ...(v?.spec.every ? { every: v.spec.every } : {}), ...(k ? { delivery: k.delivery } : {}), ...(v?.missingSecrets.length ? { missing_keys: v.missingSecrets } : {}), ...(v?.detail ? { detail: true } : {}), used_by: v?.usedBy ?? [] };
      }),
      kinds: ctx.kinds,
      flows: ctx.flows,
      spaces: ctx.spaces,
      routines: engine.store.routines().flatMap((r) => (r.spec ? [{ slug: r.slug, title: r.spec.title, enabled: r.spec.enabled !== false, draft: r.spec.draft === true, when: r.spec.when, flow: r.spec.run?.flow, mode: r.spec.mode }] : [])),
      default_dir: deps.defaultCwd,
      ...(form ? { form } : {}),
      ...(chat.result && !formOf(chat.client) ? { form_needs: chat.result.needs } : {}),
    },
    null,
    1,
  );
}

const STR = z.string().trim();

export function routineTools(deps: RoutineAssistantDeps): AssistantTool<RoutineAssistantDraft>[] {
  const { engine } = deps;
  const generate = deps.generate ?? generateFlow;
  const saveFlow =
    deps.saveFlow ??
    ((spec: FlowSpec) => {
      const { name, file } = flowFileName(spec.name);
      spec.name = name;
      fs.writeFileSync(file, flowToYaml(spec));
      return { name };
    });

  /** Папки, которые помощнику можно брать в этом разговоре. */
  const allowedDirs = (ctx: Ctx): string[] => {
    const form = formOf(ctx.client())?.run?.cwd;
    return [deps.defaultCwd, ...deps.context().spaces.map((s) => s.cwd ?? ''), form ?? '', ...(ctx.result()?.spec.run?.cwd ? [ctx.result()!.spec.run!.cwd!] : [])].filter(Boolean).map(normDir).concat(saidDirs(ctx.said()));
  };
  /** Правило, с которым работает человек: его форма, а если он её не присылал — последний черновик помощника. */
  const currentSpec = (ctx: Ctx): RoutineSpec | undefined => formOf(ctx.client()) ?? ctx.result()?.spec;

  return [
    defineTool({
      name: 'get_state',
      label: 'Посмотреть твои источники, flow и рутины',
      level: 'read',
      description: 'Свежие списки человека: подключённые источники (слаг, вид, статус, частота опроса), виды источников с полями для условий, flow с блоками, пространства, рутины и form — текущая форма новой рутины. Вызывай после своих действий, чтобы увидеть результат.',
      input: {},
      run: async (_input, ctx) => {
        const c = deps.context();
        return { text: wrapData(routineState(deps, { result: ctx.result(), client: ctx.client() })), detail: `источников: ${c.sources.length}, flow: ${c.flows.length}, пространств: ${c.spaces.length}` };
      },
    }),
    defineTool({
      name: 'list_connectors',
      label: 'Посмотреть сервисы, подключённые к Claude',
      level: 'read',
      description: 'Сервисы, подключённые к Claude (коннекторы claude.ai и MCP-серверы Claude Code), и их читающие инструменты — из них собирается источник «Сервис через Claude» (connect_service). refresh: true — перечитать список, если человек только что подключил сервис.',
      input: { refresh: z.boolean().optional().describe('Перечитать список сервисов, а не брать сохранённый') },
      run: async (input) => {
        const v = await deps.mcpServers(input.refresh === true);
        const services = mcpServices(v.servers);
        if (!services.length) return { text: 'К Claude не подключено ни одного сервиса. Человек подключает их в Claude (коннекторы claude.ai или MCP-серверы Claude Code).', detail: 'сервисов нет' };
        const body = services
          .map((s) => {
            const tools = s.tools.slice(0, TOOLS_PER_SERVICE).map((t) => `  - ${t.name}${t.description ? ` — ${clip(t.description.replace(/\s+/g, ' '), TOOL_DESC)}` : ''}`);
            const more = s.tools.length > TOOLS_PER_SERVICE ? [`  … и ещё ${s.tools.length - TOOLS_PER_SERVICE}`] : [];
            return [`${s.title} (${s.origin === 'claudeai' ? 'коннектор claude.ai' : 'MCP-сервер Claude Code'}), статус: ${s.status}, читающих инструментов: ${s.tools.length}`, ...tools, ...more].join('\n');
          })
          .join('\n\n');
        return { text: wrapData(body), detail: `сервисов: ${services.length} — ${clip(services.map((s) => s.title).join(', '), 200)}` };
      },
    }),
    defineTool({
      name: 'connect_service',
      label: 'Подключить сервис через Claude как источник',
      level: 'act',
      description:
        'Собрать и сохранить источник «Сервис через Claude»: модель один раз смотрит сервис выбранными читающими инструментами и собирает скрипт, agentgraph прогоняет его без модели и возвращает образец записей. Идёт до пары минут. Поправить уже собранное — тот же вызов с from (id сборки из прошлого ответа) и note (что не так).',
      input: {
        tools: z.array(STR.min(1)).min(1).max(10).describe('Полные имена читающих инструментов сервиса из list_connectors (mcp__сервер__инструмент), которыми достаются нужные записи'),
        request: STR.min(1).max(2000).describe('Что нужно получать, словами человека: «новые сообщения в #bugs, где упоминают меня»'),
        title: STR.max(80).optional().describe('Название источника: «Slack · #bugs»'),
        every: STR.optional().describe('Частота опроса, если человек её назвал: 1m, 5m, 30m, 1h. По умолчанию 5m'),
        from: STR.optional().describe('id прошлой сборки — когда поправляешь её результат'),
        note: STR.max(2000).optional().describe('Что поправить в прошлой сборке'),
        allow_model_polling: z.boolean().optional().describe('true — только если человек согласился на опрос моделью (каждая проверка тратит лимит, не чаще раза в 30 минут)'),
      },
      say: (i) => `Подключить источник (${clip(i.tools.map(short).join(', '), 80)}): ${clip(i.request, 100)}`,
      run: async (input, ctx) => {
        const v = await deps.mcpServers(false);
        const readable = new Set(mcpServices(v.servers).flatMap((s) => s.tools.map((t) => t.name)));
        const unknown = input.tools.filter((t) => !readable.has(t));
        if (unknown.length) throw new AssistantFail(`Таких читающих инструментов нет: ${unknown.join(', ')}. Возьми имена из list_connectors.`);
        const asked = input.every ? parseEvery(input.every) : undefined;
        if (input.every && asked === undefined) throw new AssistantFail('every — число и единица: 1m, 5m, 30m, 1h');
        if (ctx.signal.aborted) throw new AssistantFail('Остановлено');
        const started = deps.builds.start({ tools: input.tools, request: input.request, ...(input.title ? { title: input.title } : {}), ...(input.note ? { note: input.note } : {}), ...(input.from ? { from: input.from } : {}), model: ctx.model });
        const done = deps.builds.done(started.id);
        if (!done) throw new AssistantFail('Сборка не началась');
        const stop = (): void => deps.builds.cancel(started.id);
        ctx.signal.addEventListener('abort', stop, { once: true });
        let build = started;
        try {
          for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const tick = new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), BUILD_TICK_MS);
            });
            const r = await Promise.race([done, tick]);
            clearTimeout(timer);
            if (r) {
              build = r;
              break;
            }
            const cur = deps.builds.get(started.id);
            if (cur?.state === 'working') ctx.note(cur.step);
          }
        } finally {
          ctx.signal.removeEventListener('abort', stop);
        }
        if (build.state !== 'working' && build.costUsd) ctx.spend(build.costUsd);
        if (ctx.signal.aborted) throw new AssistantFail('Сборка остановлена');
        if (build.state === 'error') throw new AssistantFail(`Собрать источник не вышло (сборка ${build.id}).`, build.error);
        if (build.state !== 'ready') throw new AssistantFail('Сборка не закончилась');
        if (build.mode === 'model' && input.allow_model_polling !== true) {
          throw new AssistantFail(
            `Проверку без модели собрать не вышло. Источник НЕ сохранён (сборка ${build.id}). Попробуй ещё раз с from и note — другим инструментом или уточнив, что брать. Если человек согласен на опрос моделью (каждая проверка тратит лимит, не чаще раза в 30 минут) — повтори с allow_model_polling: true.`,
            build.problem ?? 'ответ сервиса не разобрался',
          );
        }
        const kind = engine.kind(build.spec.kind);
        const min = kind ? (kind.minEveryFor?.(build.spec) ?? kind.minEveryMs) : 0;
        const every = asked === undefined ? build.spec.every : everyOf(Math.max(asked, min));
        const spec = { ...build.spec, ...(every ? { every } : {}) };
        // поправка сборки перезаписывает её источник, только пока он тот же, что помощник сохранил в этом разговоре, и на нём
        // нет включённой рутины: источник, который человек уже поправил или пустил в работу, остаётся как есть
        const prev = input.from ? (ctx.memo.get(`build:${input.from}`) as { slug: string; saved: string } | undefined) : undefined;
        const cur = prev ? engine.store.source(prev.slug)?.spec : undefined;
        const live = prev ? (engine.sourceViews().find((s) => s.slug === prev.slug)?.usedBy ?? []).some((r) => engine.store.routine(r)?.spec?.enabled !== false) : false;
        const same = Boolean(prev && cur && JSON.stringify(cur) === prev.saved && !live);
        const slug = same ? prev!.slug : freeSlug(spec.title, (s) => Boolean(engine.store.source(s)), 'source');
        engine.saveSource(slug, spec);
        ctx.memo.set(`build:${build.id}`, { slug, saved: JSON.stringify(engine.store.source(slug)?.spec) });
        const steps = ((spec.config.script as { steps?: Array<{ say?: string; tool: string }> } | undefined)?.steps ?? []).map((s, i) => `${i + 1}. ${s.say ?? short(s.tool)}`);
        const clamped = asked !== undefined && asked < min ? ` (чаще, чем раз в ${everyOf(min)}, этот источник проверять нельзя)` : '';
        const how = build.mode === 'script' ? `без модели, по скрипту, раз в ${spec.every}${clamped}` : `моделью, раз в ${spec.every}${clamped} — каждая проверка тратит лимит`;
        const test = build.test;
        return {
          text: [
            `Источник сохранён${same ? ' (перезаписан)' : ''}: слаг «${slug}». Проверка: ${how}.`,
            `Название и шаги проверки от сборщика (данные):\n${wrapData([spec.title, ...steps].join('\n'))}`,
            test ? `Прогон без модели: записей в сервисе сейчас — ${test.total}. Образец (данные):\n${wrapData(sampleText(test.sample))}` : 'Прогона без модели нет: проверь образец через source_sample.',
            `id сборки: ${build.id} — для from, если образец не тот.`,
          ].join('\n\n'),
          detail: `источник «${spec.title}» (${slug}): ${build.mode === 'script' ? 'без модели' : 'опрос моделью'}, раз в ${spec.every}${test ? `, записей сейчас: ${test.total}` : ''}`,
        };
      },
    }),
    defineTool({
      name: 'source_sample',
      label: 'Проверить источник: что он отдаёт сейчас',
      level: 'read',
      description: 'Пробная проверка подключённого источника: сколько записей он отдаёт сейчас и до трёх свежих. Так проверяется, что источник работает и приносит то, о чём просит человек. У источника с опросом моделью такая проверка тратит лимит.',
      input: { source: STR.min(1).describe('Слаг подключённого источника') },
      say: (i) => `Проверить источник «${i.source}»`,
      run: async (input) => {
        const src = engine.store.source(input.source);
        if (!src?.spec) throw new AssistantFail('Такого источника нет среди подключённых: возьми слаг из списка sources.');
        const r = await engine.testSource(src.spec);
        if (!r.ok) throw new AssistantFail('Источник не отвечает.', r.error ?? 'проверка не удалась');
        return { text: `Источник отвечает. Записей сейчас: ${r.total}. Что выполняется при проверке и свежие записи (данные):\n${wrapData(`${clip(r.request, 600)}\n\n${sampleText(r.sample)}`)}`, detail: `источник отвечает, записей сейчас: ${r.total}` };
      },
    }),
    defineTool({
      name: 'set_source_every',
      label: 'Поменять частоту опроса источника',
      level: 'act',
      description: 'Поменять частоту опроса подключённого источника (как часто agentgraph ходит в сервис за новыми записями). Это свойство источника, а не расписание рутины. Только когда человек назвал частоту.',
      input: { source: STR.min(1).describe('Слаг подключённого источника'), every: STR.min(1).describe('Частота: 1m, 5m, 30m, 1h') },
      say: (i) => `Частота опроса «${i.source}»: раз в ${i.every}`,
      run: async (input) => {
        const src = engine.store.source(input.source);
        if (!src?.spec) throw new AssistantFail('Такого источника нет среди подключённых: возьми слаг из списка sources.');
        const ms = parseEvery(input.every);
        if (ms === undefined) throw new AssistantFail('every — число и единица: 1m, 5m, 30m, 1h');
        const kind = engine.kind(src.spec.kind);
        if (kind?.delivery === 'live') throw new AssistantFail('Этот источник держит соединение и получает записи сразу: частоты опроса у него нет');
        const min = kind ? (kind.minEveryFor?.(src.spec) ?? kind.minEveryMs) : 0;
        if (ms < min) throw new AssistantFail(`Чаще, чем раз в ${everyOf(min)}, этот источник проверять нельзя`);
        engine.saveSource(input.source, { ...src.spec, every: everyOf(ms) });
        return `Источник «${input.source}» теперь проверяется раз в ${everyOf(ms)}.`;
      },
    }),
    defineTool({
      name: 'build_flow',
      label: 'Собрать новый flow под задачу',
      level: 'act',
      description: 'Собрать и сохранить новый flow, когда подходящего в списке нет. Модель смотрит папку проекта (только чтение) и проектирует этапы. Идёт пару минут. Возвращает имя flow и его блоки — их и ставь в черновик.',
      input: {
        task: STR.min(1).max(4000).describe('Что flow делает с одним событием рутины, словами: вход, шаги, чем заканчивается'),
        cwd: STR.optional().describe('Абсолютная папка проекта — только названная человеком или папка его пространства; не указана — папка по умолчанию'),
      },
      say: (i) => `Собрать flow: ${clip(i.task, 120)}`,
      run: async (input, ctx) => {
        if (input.cwd) {
          const problem = dirProblem(input.cwd, allowedDirs(ctx));
          if (problem) throw new AssistantFail(`Эту папку взять нельзя: ${problem}. Спроси человека, в каком проекте собирать flow, или собери в папке по умолчанию.`);
        }
        const d = await deps.checkDir(input.cwd || deps.defaultCwd);
        if (!d.exists || !d.isDir) throw new AssistantFail('Такой папки нет: спроси человека путь к проекту.');
        if (ctx.signal.aborted) throw new AssistantFail('Остановлено');
        const abort = new AbortController();
        const stop = (): void => abort.abort();
        ctx.signal.addEventListener('abort', stop, { once: true });
        ctx.note('Модель смотрит проект и проектирует этапы…');
        try {
          // права без подтверждений, доп. папки и плагины остаются во flow, только если о них писал сам человек: задачу
          // здесь формулирует модель, а она читала тексты из сервисов
          const r = await generate(input.task, { cwd: d.path, model: ctx.model, abort, asked: ctx.said().join('\n') });
          ctx.spend(r.result.costUsd);
          if (ctx.signal.aborted) throw new AssistantFail('Сборка flow остановлена');
          const { name } = saveFlow(r.spec);
          const blocks = (r.spec.blocks ?? []).map((b) => b.name);
          return {
            text: `Flow собран и сохранён: имя «${name}», папка проекта ${d.path}. Описание и блоки от сборщика (данные):\n${wrapData(`${clip(r.spec.description ?? '', 300)}\nБлоки: ${blocks.join(', ') || '(один блок)'}`)}`,
            detail: `flow «${name}»${blocks.length ? `, блоки: ${clip(blocks.join(', '), 200)}` : ''}`,
          };
        } finally {
          ctx.signal.removeEventListener('abort', stop);
        }
      },
    }),
    defineTool({
      name: 'set_draft',
      label: 'Заполнить черновик рутины',
      level: 'act',
      description:
        'Заполнить (целиком заменить) форму новой рутины у человека. Ничего не включает и не запускает: человек видит черновик, правит и включает сам. Форма заменяется целиком, поэтому, меняя одно поле, остальные перенеси из form как есть — человек мог поправить их руками. Значения проверяются по спискам человека; не прошло — вернётся, что поправить.',
      input: {
        title: STR.min(1).max(80).describe('Короткое название по-русски'),
        trigger: z.enum(['source', 'schedule', 'new_source']).describe('source — запись из подключённого источника; schedule — по времени; new_source — нужного источника нет и подключить его можешь не ты'),
        source: STR.optional().describe('Слаг подключённого источника (trigger: source)'),
        new_source: z.object({ description: STR.min(1).describe('Что должно запускать рутину, словами'), kind: STR.optional().describe('Готовый вид источника, если подходит: gitlab, slack, rss…') }).optional().describe('Чего не хватает (trigger: new_source)'),
        match: z
          .array(z.object({ key: STR.min(1).describe('Поле из полей вида источника'), op: z.enum(['is', 'contains', 'not', 'gt', 'lt']).describe('is — равно, contains — содержит, not — не равно, gt/lt — больше/меньше'), values: z.array(STR).min(1).describe('Значения; для да/нет-поля — ["true"] или ["false"]') }))
          .optional()
          .describe('Условия по полям без модели — только названные человеком'),
        check: STR.max(2000).optional().describe('Условие словами для узла «ИИ рутины»: критерий, по которому модель решает, запускать ли'),
        check_model: STR.max(100).optional().describe('Модель узла «ИИ рутины», только если человек её назвал: haiku, sonnet, opus или id модели'),
        ask: z.boolean().optional().describe('ИИ рутины не уверен — спросить человека, а не пропустить. По умолчанию true'),
        schedule: STR.optional().describe('cron из 5 полей, локальное время (trigger: schedule)'),
        flow: STR.optional().describe('Имя flow из списка; подходящего нет и собрать его не вышло — пусто и flow_wanted'),
        flow_wanted: STR.max(2000).optional().describe('Что должен делать flow, которого нет'),
        input: STR.max(4000).optional().describe('Задача flow словами человека'),
        space: STR.optional().describe('Слаг пространства'),
        cwd: STR.optional().describe('Абсолютная папка проекта — только названная человеком, из его формы или папка пространства'),
        worktree: z.enum(['new', 'none']).optional().describe('new — запуск в отдельной git-ветке'),
        mode: z.enum(['suggest', 'until_pause', 'auto']).describe('suggest — ждать «Запустить?»; until_pause — идти до блока из pause_before; auto — без остановок'),
        pause_before: z.array(STR).optional().describe('Блоки flow, перед которыми ждать человека (mode: until_pause)'),
        reply: z.object({ to: STR.describe('none или source'), draft: z.boolean().optional().describe('true — после проверки человеком') }).optional().describe('Сообщить о результате в источник'),
        task: z.object({ kind: STR.min(1).describe('Вид дела: «Ревью», «Баг»'), from: z.enum(['event', 'flow']).optional(), column: z.enum(['new', 'plan']).optional(), close: STR.optional() }).optional().describe('Дело на доске «Мои дела»'),
        limits: z.object({ usd: z.number().positive().optional(), per_day: z.number().int().positive().optional(), parallel: z.number().int().positive().optional() }).optional().describe('Лимиты, только названные человеком'),
        notes: z.array(STR).max(6).optional().describe('Короткие фразы для человека: что выбрано и что ты предположил'),
      },
      say: (i) => `Заполнить черновик «${clip(i.title, 80)}»`,
      run: async (input, ctx) => {
        const c = deps.context();
        const dropped: string[] = [];
        let cwd = input.cwd;
        // папка — как у сборки flow: модель не может сама выбрать, где рутина будет работать
        if (cwd && dirProblem(cwd, allowedDirs(ctx))) {
          dropped.push(`Папка проекта ${cwd} не взята: человек её не называл — пусть выберет в форме сам`);
          cwd = undefined;
        }
        const built = await buildSpec({ ...input, cwd, feasible: true, notes: input.notes ?? [] }, c, deps.checkDir, input.flow_wanted || input.input || input.title);
        if (built.fix.length) throw new AssistantFail(`Черновик не прошёл проверку — поправь и вызови снова:\n${built.fix.map((f) => `- ${f}`).join('\n')}`);
        const spec = built.spec;
        if ('source' in spec.when && spec.when.check?.trim()) {
          const when: WhenSource = { ...spec.when, ask: input.ask !== false };
          if (input.check_model) when.model = input.check_model;
          spec.when = when;
        }
        const adjusted = [...built.adjusted, ...dropped];
        if (ctx.signal.aborted) throw new AssistantFail('Остановлено');
        ctx.setResult({ spec, notes: [...built.notes, ...adjusted], problems: [], needs: built.needs });
        const needs = [built.needs.source ? `источник нужно подключить человеку: ${built.needs.source.description}` : '', built.needs.flow ? `flow нужно собрать: ${built.needs.flow}` : ''].filter(Boolean);
        const when = 'schedule' in spec.when ? `по расписанию ${spec.when.schedule}` : spec.when.source ? `источник ${spec.when.source}` : 'источник не выбран';
        return {
          text: [`Черновик в форме человека заполнен:\n${wrapData(JSON.stringify(spec, null, 1))}`, ...(adjusted.length ? [`Поправлено по спискам:\n${adjusted.map((a) => `- ${a}`).join('\n')}`] : []), ...(needs.length ? [`Остаётся за человеком:\n${needs.map((n) => `- ${n}`).join('\n')}`] : [])].join('\n\n'),
          detail: `«${spec.title}»: ${when} → ${spec.run?.flow ? `flow ${spec.run.flow}` : spec.task ? 'только дело' : 'flow не выбран'}, режим ${spec.mode}`,
        };
      },
    }),
    defineTool({
      name: 'check_history',
      label: 'Проверить черновик на последних записях',
      level: 'read',
      description: 'Как текущая форма (form: правки человека или твой последний set_draft) отработала бы на последних записях источника: что запустила бы, что пропустила и почему. Если в правиле есть условие для ИИ рутины, каждую запись читает модель узла — это стоит денег, поэтому не больше 10 записей без просьбы человека.',
      input: { limit: z.number().int().min(1).max(30).optional().describe('Сколько последних записей проверить; по умолчанию 10') },
      run: async (input, ctx) => {
        const spec = currentSpec(ctx);
        if (!spec) throw new AssistantFail('Черновика ещё нет: сначала set_draft');
        if ('schedule' in spec.when) return { text: 'У рутины по расписанию истории нет: событие — само время, проверять нечего.', detail: 'расписание: проверять нечего' };
        if (!spec.when.source) throw new AssistantFail('В черновике не выбран источник: проверять не на чем');
        let h: HistoryCheck;
        try {
          h = await engine.history('assistant-draft', { spec: historyProbe(spec, deps.context().flows), limit: input.limit ?? 10, signal: ctx.signal });
        } catch (err) {
          const problems = err instanceof RoutineError ? (err.body?.problems as unknown) : undefined;
          if (Array.isArray(problems) && problems.length) throw new AssistantFail('Правило в форме не проходит проверку — поправь через set_draft.', problems.map(String).join('\n'));
          throw err;
        }
        if (h.check?.costUsd) ctx.spend(h.check.costUsd);
        if (!h.events.length) return { text: 'У источника пока нет записей: проверить правило не на чем. Скажи это человеку.', detail: 'записей у источника нет' };
        const n = (f: (e: HistoryCheck['events'][number]) => boolean): number => h.events.filter(f).length;
        const run = n((e) => (e.outcome === 'started' || e.outcome === 'waiting') && !e.unsure);
        const ask = n((e) => e.unsure === true);
        const skip = h.events.length - run - ask;
        const lines = h.events.map((e, i) => `${i + 1}. ${clip(e.event.title, 140)} — ${e.unsure ? 'ИИ рутины не уверен: спросил бы человека' : OUTCOME[e.outcome]}${e.reason ? ` (${clip(e.reason, 200)})` : ''}`);
        const summary = `из ${h.events.length} последних: подошло ${run}, пропущено ${skip}${ask ? `, спросил бы ${ask}` : ''}`;
        return { text: `Проверка на истории — ${summary}.${h.check ? ` Читала модель ${h.check.model ?? 'по умолчанию'}.` : ' Модель не участвовала.'}\nПо записям (данные):\n${wrapData(lines.join('\n'))}`, detail: summary };
      },
    }),
    defineTool({
      name: 'read_routine',
      label: 'Открыть существующую рутину',
      level: 'read',
      description: 'Правило существующей рутины целиком и её проблемы (flow не найден, источник не подключён). Нужно, когда человек спрашивает про уже созданную рутину или просит сделать похожую.',
      input: { routine: STR.min(1).describe('Слаг рутины из списка routines') },
      say: (i) => `Открыть рутину «${i.routine}»`,
      run: async (input) => {
        const v = engine.routineView(input.routine);
        if (!v) throw new AssistantFail('Такой рутины нет: возьми слаг из списка routines.');
        return { text: `Правило и его проблемы (данные):\n${wrapData(`${v.yaml}\n${v.problems.length ? `Проблемы: ${v.problems.join('; ')}` : 'Проблем нет.'}`)}\nСегодня срабатываний: ${v.stats.today}, запусков: ${v.stats.started}, ждёт: ${v.stats.waiting}.`, detail: `«${v.spec.title}»${v.problems.length ? `, проблем: ${v.problems.length}` : ''}` };
      },
    }),
    defineTool({
      name: 'read_log',
      label: 'Прочитать журнал срабатываний рутины',
      level: 'read',
      description: 'Последние срабатывания рутины: что пришло, что с этим стало и почему (не прошло условия, ИИ рутины пропустил, запущено, ошибка).',
      input: { routine: STR.min(1).describe('Слаг рутины'), limit: z.number().int().min(1).max(50).optional().describe('Сколько строк; по умолчанию 20') },
      say: (i) => `Прочитать журнал «${i.routine}»`,
      run: async (input) => {
        if (!engine.routineView(input.routine)) throw new AssistantFail('Такой рутины нет: возьми слаг из списка routines.');
        const log = engine.logOf(input.routine, { limit: input.limit ?? 20 });
        if (!log.length) return { text: 'Журнал пуст: рутина ещё ни разу не срабатывала.', detail: 'журнал пуст' };
        const lines = log.map((e) => `${e.at} · ${e.outcome}${e.unsure ? ' (ИИ не уверен)' : ''} · ${clip(e.event.title, 120)}${e.reason ? ` — ${clip(e.reason, 200)}` : e.why ? ` — ${clip(e.why, 200)}` : ''}${e.checkModel ? ` [${e.checkModel}]` : ''}`);
        return { text: `Журнал (данные):\n${wrapData(lines.join('\n'))}`, detail: `строк: ${log.length}` };
      },
    }),
  ];
}

export function routineSection(deps: RoutineAssistantDeps): AssistantSection<RoutineAssistantDraft> {
  const knowledge = deps.knowledge ?? readKnowledge;
  return {
    id: 'routines',
    defaultModel: ASSISTANT_MODEL,
    system: () => `Ты — помощник раздела «Рутины» в agentgraph. Человек описывает, что хочет автоматизировать, — ты собираешь рутину целиком: находишь или подключаешь источник, проверяешь, что он отдаёт нужное, выбираешь или собираешь flow, заполняешь черновик и проверяешь его на истории. Ниже — всё, что нужно знать о разделе.\n\n${knowledge()}`,
    // те же списки, что отдаёт get_state: помощник видит их сразу, без первого вызова
    context: (chat) => routineState(deps, chat),
    tools: routineTools(deps),
    about: {
      knows: ['Как устроена рутина: триггер, условия по полям, ИИ рутины, flow, ожидание, ответ', 'Все поля правила, примеры готовых рутин и рецепты по шагам', 'Твои источники, сервисы в Claude, flow, пространства, рутины и форму ниже — с твоими правками'],
      onlyYou: ['Включить рутину', 'Ввести ключ или токен', 'Удалить источник, рутину или flow', 'Отправить что-то наружу'],
    },
    maxTurns: 40,
    maxBudgetUsd: 3,
  };
}

export type RoutineAssistant = Assistant<RoutineAssistantDraft>;

export function createRoutineAssistant(deps: RoutineAssistantDeps, opts: AssistantOptions = {}): RoutineAssistant {
  return createAssistant(routineSection(deps), opts);
}
