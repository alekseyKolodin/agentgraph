// Страница «Контекст»: что получит сессия этапа — CLAUDE.md и правила, скиллы, сабагенты, MCP, системный промпт, токены.
// Считает сам Agent SDK (getContextUsage на сессии без промпта, к модели не обращается), а опции строятся тем же
// sessionOptions/buildRequest, что у раннера: показанное совпадает с настоящим запуском.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type McpServerStatus, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDEAI_TOOL_PREFIX, NO_CLAUDEAI_CONNECTORS_ENV, sessionOptions } from './agent.js';
import { connectorName, connectorToolName, isConnector, waitForConnectors } from './connectors.js';
import { loadFlow, resolveFlowFile } from './flows.js';
import { buildRequest, dirsTail, handoffTail, resolveAddDirs } from './runner.js';
import { flowBlocks, flowPhases, type Phase } from './schema.js';
import { ARTIFACTS_DIR, artifactAccess, hasArtifacts } from './artifacts.js';
import { RUNS_DIR } from './paths.js';
import { existingTagPaths, knowledgeBlock, knowledgeSection, readTag, type Tag, type TagKind } from './tags.js';
import type { ContextFile, ContextFileSaved, ContextKnowledge, ContextPrompt, ContextPromptPart, ContextView, MemoryFile } from './api-types.js';

export type ContextRequest = {
  /** Директория проекта, абсолютный путь. */
  cwd: string;
  /** Имя flow или путь к файлу (путь — только для тестов: сервер пропускает лишь имя). */
  flow?: string;
  phase?: string;
  /** Модель запуска: этап и defaults flow её перекрывают, как в раннере. */
  model?: string;
};

export type ContextOptions = {
  options: Options;
  addDirs: { path: string; exists: boolean }[];
  knowledge: ContextKnowledge[];
  /** Промпт этапа по источникам; нет — запрос без этапа. */
  prompt?: ContextPrompt;
  warnings: string[];
};

/** Больше этого в промпте этапа ещё до подстановок — предупреждение: справочное лучше отдавать по запросу. */
export const PROMPT_CHARS_WARN = 16_000;
/** Теги знаний целиком занимают больше этой доли промпта (и не меньше PROMPT_INLINE_MIN знаков) — предупреждение. */
export const PROMPT_INLINE_SHARE = 0.5;
export const PROMPT_INLINE_MIN = 2_000;
/** Источников инструкций (файлы памяти, теги целиком, свой системный промпт) от этого числа — предупреждение о противоречиях. */
export const PROMPT_SOURCES_WARN = 4;

export type { ContextFile, ContextFileSaved, ContextKnowledge, ContextView, MemoryFile } from './api-types.js';

export type ContextDeps = {
  query: (args: { prompt: AsyncIterable<never>; options: Options }) => Pick<Query, 'getContextUsage' | 'close'> & Partial<Pick<Query, 'mcpServerStatus'>>;
  /** Сколько ждать листинг; по умолчанию LISTING_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Сколько ждать подключения коннекторов claude.ai, если сессия их получает; по умолчанию CONNECTORS_WAIT_MS. */
  connectorsWaitMs?: number;
};

/**
 * Ошибка с HTTP-кодом: 400 — неверный ввод, 403 — файла нет среди листинга (или он не редактируется),
 * 404 — нет flow, этапа или пропал файл из листинга, 409 — файл изменён снаружи.
 */
export class ContextError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

/** Опции сессии без промпта: без flow — как у любой сессии, с этапом — как у раннера для этого этапа. */
export function contextOptions(req: ContextRequest): ContextOptions {
  const warnings: string[] = [];
  if (!req.flow) return { options: sessionOptions({ cwd: req.cwd, prompt: '', model: req.model, foreground: true }), addDirs: [], knowledge: [], warnings };
  let file: string;
  try {
    file = resolveFlowFile(req.flow);
  } catch (err) {
    throw new ContextError(404, (err as Error).message);
  }
  const spec = loadFlow(file);
  // имена этапов уникальны во всём flow: ищем по всем блокам
  const phase = req.phase ? flowPhases(spec).find((p) => p.name === req.phase) : undefined;
  if (req.phase && !phase) throw new ContextError(404, `В flow ${spec.name} нет этапа ${req.phase}`);
  if (!phase) {
    // flow без этапа: от него только модель по умолчанию
    return { options: sessionOptions({ cwd: req.cwd, prompt: '', model: spec.defaults?.model ?? req.model, foreground: true }), addDirs: [], knowledge: [], warnings };
  }
  // раннер до запуска падает в checkAddDirs; здесь показываем, что этап получит, и предупреждаем
  const addDirs = resolveAddDirs(phase, req.cwd).map((d) => ({ path: d, exists: Boolean(fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) }));
  for (const d of addDirs) if (!d.exists) warnings.push(`Нет директории из add_dirs: ${d.path}. Запуск этого этапа упадёт до старта.`);
  // теги знаний блока этапа — так же: раннер падает в resolveKnowledge, здесь предупреждаем; пути тегов — в доп. директории
  const block = flowBlocks(spec).find((b) => b.phases.includes(phase));
  const known: Tag[] = [];
  const knowledge: ContextKnowledge[] = (block?.knowledge ?? []).map((slug) => {
    let tag: Tag | undefined;
    try {
      tag = readTag(slug);
    } catch {
      tag = undefined;
    }
    if (!tag) warnings.push(`Нет тега знаний ${slug} (блок ${block!.name}): запуск упадёт до старта. Заведи его на странице «Теги» с видом «знание».`);
    else if (tag.kind !== 'knowledge') warnings.push(`${slug} в knowledge блока ${block!.name} — тег задачи, а не области знаний: запуск упадёт до старта.`);
    else known.push(tag);
    return { slug, exists: Boolean(tag), ...(tag ? { kind: tag.kind } : {}), ...(tag?.kind === 'knowledge' ? knowledgeView(tag) : {}) };
  });
  // права на артефакты: неявные Read/Edit/Write — как у раннера; папка артефактов появится только у запуска,
  // поэтому её путь условный и в листинг не идёт (там нет ни CLAUDE.md, ни скиллов — их уносит карантин)
  const access = hasArtifacts(spec) ? artifactAccess(phase) : undefined;
  const artDir = path.join(RUNS_DIR, '<id запуска>', ARTIFACTS_DIR);
  // инструмент чтения по ключу — тот же MCP-сервер, что у раннера (без файлов: на странице только его описание)
  const request = buildRequest(spec, phase, '', { cwd: req.cwd, runsDir: '', model: req.model }, access ? { dir: artDir, access, sources: [] } : undefined, known);
  const options = sessionOptions({ ...request, additionalDirectories: request.additionalDirectories.filter((d) => d !== artDir) });
  if (access?.read.length) {
    const read = access.read.filter((k) => !access.write.includes(k));
    warnings.push(
      `Этап получит папку артефактов запуска ${artDir}${read.length ? `; читает: ${read.join(', ')}` : ''}${access.write.length ? `; пишет: ${access.write.join(', ')}` : ''}` +
        (access.implicit.length ? `. Только для своих артефактов добавлены ${access.implicit.join(', ')}.` : '.'),
    );
  }
  const prompt = promptParts(phase, addDirs.map((d) => d.path), known);
  warnings.push(...promptWarnings(prompt));
  return { options, addDirs, knowledge, prompt, warnings };
}

const VAR_RE = /\{\{\s*([a-z_]+(?:\.[A-Za-z0-9_.-]+)*)\s*\}\}/g;

/**
 * Промпт этапа по источникам тем же кодом, что собирает его раннер (renderPhasePrompt), но без подстановок: шаблон,
 * handoff, доп. директории, строки тегов по запросу одной частью, каждый тег целиком — своей. Раздел артефактов и
 * вложения появляются только у запуска и сюда не входят.
 */
export function promptParts(phase: Phase, dirs: string[], known: Tag[]): ContextPrompt {
  const parts: ContextPromptPart[] = [{ name: 'Промпт этапа (шаблон)', kind: 'prompt', chars: phase.prompt.length }];
  if (phase.handoff?.trim()) parts.push({ name: 'Чем закончить ответ (handoff)', kind: 'handoff', chars: handoffTail(phase.handoff).length });
  if (dirs.length) parts.push({ name: 'Список доп. директорий', kind: 'dirs', chars: dirsTail(dirs).length });
  const onDemand = known.filter((t) => !t.inline);
  if (onDemand.length) parts.push({ name: `Теги знаний по запросу: ${onDemand.map((t) => t.slug).join(', ')}`, kind: 'knowledge-lines', chars: knowledgeBlock(onDemand).length });
  for (const t of known.filter((t) => t.inline)) parts.push({ name: `Тег знаний ${t.slug} целиком`, kind: 'knowledge-inline', chars: knowledgeSection(t).length });
  const vars = [...new Set([...`${phase.prompt}\n${phase.handoff ?? ''}`.matchAll(VAR_RE)].map((m) => m[1]))];
  return { parts, vars, chars: parts.reduce((n, p) => n + p.chars, 0) };
}

/** Предупреждения по составу промпта: теги целиком раздувают его, промпт велик ещё до подстановок. */
export function promptWarnings(p: ContextPrompt): string[] {
  const out: string[] = [];
  const inline = p.parts.filter((x) => x.kind === 'knowledge-inline');
  const inlineChars = inline.reduce((n, x) => n + x.chars, 0);
  if (inlineChars >= PROMPT_INLINE_MIN && inlineChars > p.chars * PROMPT_INLINE_SHARE) {
    out.push(
      `Теги знаний целиком (${inline.map((x) => x.name.replace(/^Тег знаний | целиком$/g, '')).join(', ')}) занимают ${Math.round((inlineChars / p.chars) * 100)}% промпта этапа ` +
        `(${inlineChars} знаков) и уйдут в каждую итерацию. Сними у них «Всегда вставлять заметки в промпт целиком» на странице «Теги»: этап получит строку с описанием и откроет тег инструментом knowledge_read, когда понадобится.`,
    );
  }
  if (p.chars > PROMPT_CHARS_WARN) {
    out.push(`Промпт этапа — ${p.chars} знаков ещё до подстановок (${p.vars.map((v) => `{{${v}}}`).join(', ') || 'без переменных'}). Справочное вынеси в тег знаний по запросу или в файл, который этап прочитает сам.`);
  }
  return out;
}

/**
 * Инструкции этапу приходят из нескольких мест: файлы памяти (CLAUDE.md и правила, в том числе из доп. директорий),
 * теги знаний целиком, свой системный промпт. От PROMPT_SOURCES_WARN источников — предупреждение: правило из одного
 * молча перебивает другое, и никто не видит противоречия целиком.
 */
export function sourcesWarning(memoryFiles: number, inlineTags: number, customSystem: boolean): string | undefined {
  const total = memoryFiles + inlineTags + (customSystem ? 1 : 0);
  if (total < PROMPT_SOURCES_WARN) return undefined;
  const what = [
    memoryFiles ? `${memoryFiles} файл(ов) CLAUDE.md и правил` : '',
    inlineTags ? `${inlineTags} тег(ов) знаний целиком` : '',
    customSystem ? 'свой системный промпт' : '',
  ].filter(Boolean);
  return `Инструкции этапу приходят из ${total} источников: ${what.join(', ')}. Проверь, что они не противоречат друг другу: правило из одного файла молча перебивает другое, а этап видит их все сразу.`;
}

/** Как тег знаний попадает в промпт этапа (заметки целиком или строка + knowledge_read) и его объём. */
function knowledgeView(tag: Tag): Omit<ContextKnowledge, 'slug' | 'exists' | 'kind'> {
  return {
    ...(tag.title ? { title: tag.title } : {}),
    ...(tag.description ? { description: tag.description } : {}),
    mode: tag.inline ? 'inline' : 'on-demand',
    notesChars: tag.notes.trim().length,
    attachments: tag.attachments.length,
    dirs: existingTagPaths(tag).listed.length,
  };
}

/** Чаще раза в минуту не спрашиваем: каждый листинг — запуск процесса Claude Code. */
const TTL_MS = 60_000;
/** Завис процесс Claude Code — листинг падает, иначе запись в inflight осталась бы навсегда и «Обновить» не помог бы. */
const LISTING_TIMEOUT_MS = 30_000;
/** Коннекторы claude.ai подключаются 2–4 секунды после старта сессии; в листинг без ожидания они не попадают. */
const CONNECTORS_WAIT_MS = 12_000;
const cache = new Map<string, ContextView>();
const inflight = new Map<string, Promise<ContextView>>();
/** Memory-файлы из листингов этого процесса (realpath): читать можно любой, писать — только editable. */
const listed = new Set<string>();
/** Пути из листингов как их вернул SDK: пропавший файл отсюда — 404, любой другой отсутствующий путь — 403. */
const seen = new Set<string>();
const editable = new Set<string>();
/** Поколение данных: запись файла его меняет, и листинг, начатый до записи, в кэш уже не попадёт. */
let gen = 0;

const cacheKey = (r: ContextRequest) => [r.cwd, r.flow ?? '', r.phase ?? '', r.model ?? ''].join('|');

export function getContext(req: ContextRequest & { force?: boolean }, deps: ContextDeps = { query }): Promise<ContextView> {
  const key = cacheKey(req);
  const hit = cache.get(key);
  if (!req.force && hit && Date.now() - new Date(hit.at).getTime() < TTL_MS) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    const started = gen;
    const next: Promise<ContextView> = fetchContext(req, deps)
      .then((v) => {
        if (gen === started) cache.set(key, v);
        return v;
      })
      // после записи на этом ключе может идти уже новый запрос: его не трогаем
      .finally(() => inflight.get(key) === next && inflight.delete(key));
    inflight.set(key, next);
    p = next;
  }
  return p;
}

/** Сброс кэша и белого списка — для тестов. */
export function resetContextState(): void {
  cache.clear();
  inflight.clear();
  listed.clear();
  seen.clear();
  editable.clear();
}

async function* noPrompt(): AsyncGenerator<never> {
  // потоковый ввод, который ничего не присылает: сессия ждёт, пока мы спрашиваем usage контекста
  await new Promise(() => {});
}

async function fetchContext(req: ContextRequest, deps: ContextDeps): Promise<ContextView> {
  const { options, addDirs, knowledge, prompt, warnings } = contextOptions(req);
  // persistSession после спреда: buildRequest просит сохранять сессию, листинг сохранять незачем
  const q = deps.query({ prompt: noPrompt(), options: { ...options, persistSession: false } });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Claude Code не ответил за 30 секунд: нажми «Обновить»')), deps.timeoutMs ?? LISTING_TIMEOUT_MS);
  });
  try {
    // этапу, который получает коннекторы, они придут уже после старта: ждём их, чтобы листинг и токены были как в запуске
    const connectors = options.env?.ENABLE_CLAUDEAI_MCP_SERVERS !== NO_CLAUDEAI_CONNECTORS_ENV.ENABLE_CLAUDEAI_MCP_SERVERS;
    if (connectors && q.mcpServerStatus) {
      await Promise.race([waitForConnectors(q.mcpServerStatus.bind(q), { waitMs: deps.connectorsWaitMs ?? CONNECTORS_WAIT_MS }), timeout]);
    }
    const u = await Promise.race([q.getContextUsage({ detail: 'summary' }), timeout]);
    const memoryFiles = u.memoryFiles.map((f) => ({ ...f, editable: remember(f.path, f.type) }));
    const mcpTools = u.mcpTools.map((t) => ({ name: t.name, server: t.serverName, tokens: t.tokens }));
    // Отложенные MCP-инструменты (загружаются по требованию) листинг не перечисляет: берём их у подключённых серверов
    // с нулём токенов — в контексте их описания нет, пока агент их не позовёт (так приходит инструмент чтения артефактов).
    const status = q.mcpServerStatus ? await Promise.race([q.mcpServerStatus(), timeout]).catch(() => []) : [];
    if (connectors && Array.isArray(options.tools)) warnings.push(...connectorWarnings(status, options.tools));
    for (const srv of status) {
      if (srv.status !== 'connected') continue;
      for (const t of srv.tools ?? []) {
        const name = connectorToolName(srv.name, t.name);
        if (!mcpTools.some((x) => x.name === name || (x.server === srv.name && x.name === t.name))) mcpTools.push({ name, server: srv.name, tokens: 0 });
      }
    }
    const sp = options.systemPrompt;
    const custom = typeof sp === 'object' && !Array.isArray(sp) && sp.type === 'custom';
    if (prompt) {
      const w = sourcesWarning(memoryFiles.length, prompt.parts.filter((p) => p.kind === 'knowledge-inline').length, custom);
      if (w) warnings.push(w);
    }
    return {
      cwd: req.cwd,
      flow: req.flow,
      phase: req.phase,
      model: u.model,
      totalTokens: u.totalTokens,
      maxTokens: u.maxTokens,
      percentage: u.percentage,
      categories: u.categories.map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
      memoryFiles,
      skills: (u.skills?.skillFrontmatter ?? []).map((s) => ({ name: s.name, source: s.source, tokens: s.tokens })),
      agents: u.agents.map((a) => ({ name: a.agentType, source: a.source, tokens: a.tokens })),
      mcpTools,
      tools: options.tools && Array.isArray(options.tools) ? options.tools : null,
      systemPrompt: custom ? 'custom' : 'preset',
      systemPromptText: custom ? [sp.prompt].flat().join('\n\n') : undefined,
      addDirs,
      knowledge,
      ...(prompt ? { prompt } : {}),
      warnings,
      at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

/** Этап со списком tools и коннекторами: в контексте описания всех их инструментов, а вызвать он может только свои. */
function connectorWarnings(status: McpServerStatus[], tools: string[]): string[] {
  const ai = status.filter(isConnector);
  // запись mcp__claude_ai_<Коннектор> разрешает весь коннектор, mcp__claude_ai_<Коннектор>__<инструмент> — один инструмент
  const whole = (s: McpServerStatus) => tools.includes(connectorName(s.name));
  const listed = (s: McpServerStatus) => whole(s) || tools.some((t) => t.startsWith(connectorToolName(s.name, '')));
  const connected = ai.filter((s) => s.status === 'connected');
  const loaded = connected.reduce((n, s) => n + (s.tools?.length ?? 0), 0);
  const own = connected.reduce((n, s) => n + (whole(s) ? (s.tools?.length ?? 0) : (s.tools ?? []).filter((t) => tools.includes(connectorToolName(s.name, t.name))).length), 0);
  // неподключённые — только те, что этап просил: остальные коннекторы аккаунта ему не нужны
  const off = ai.filter((s) => s.status !== 'connected' && listed(s)).map((s) => `${s.name} (${s.status})`);
  return [
    ...(loaded ? [`Коннекторы claude.ai подключены: в контексте описания всех их инструментов (${loaded}), вызвать этап может только перечисленные в tools (${own}).`] : []),
    ...(!loaded && tools.some((t) => t.startsWith(CLAUDEAI_TOOL_PREFIX)) ? ['Коннекторы claude.ai этапу выданы, но ни один не подключился: проверь вход в claude.ai и нажми «Обновить».'] : []),
    ...(off.length ? [`Не подключены коннекторы этапа: ${off.join(', ')}.`] : []),
  ];
}

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function realpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

const under = (file: string, dir: string) => file.startsWith(dir + path.sep);

/** Запоминает файл листинга. Редактируемый: .md, не managed-политика, не из плагинов и кэша Claude Code. */
function remember(file: string, type: string): boolean {
  seen.add(path.resolve(file));
  const real = realpath(file);
  if (!real) return false;
  listed.add(real);
  const base = claudeDir();
  const ro = [path.join(base, 'plugins'), path.join(base, 'cache')].flatMap((d) => [d, realpath(d) ?? d]);
  const ok = real.endsWith('.md') && type !== 'Managed' && !ro.some((d) => under(real, d));
  if (ok) editable.add(real);
  return ok;
}

function allowed(file: string, set: Set<string>): string {
  const real = realpath(file);
  if (real && set.has(real)) return real;
  // 404 — только файлу из листинга, иначе по ответу можно было бы проверить, есть ли на диске произвольный путь
  if (!real && file && seen.has(path.resolve(file))) throw new ContextError(404, `Файла уже нет: ${file}. Нажми «Обновить»`);
  throw new ContextError(403, set === editable && real && listed.has(real)
    ? 'Этот файл не редактируется со страницы «Контекст»'
    : 'Файла нет в листинге контекста: нажми «Обновить» на странице «Контекст»');
}

export function readContextFile(file: string): ContextFile {
  const real = allowed(file, listed);
  return { path: file, text: fs.readFileSync(real, 'utf8'), mtimeMs: fs.statSync(real).mtimeMs, editable: editable.has(real) };
}

/** Запись с проверкой: только редактируемый файл из листинга и только если его не меняли с момента чтения (mtimeMs). */
export function writeContextFile(file: string, text: string, mtimeMs: number): ContextFileSaved {
  const real = allowed(file, editable);
  if (fs.statSync(real).mtimeMs !== mtimeMs) throw new ContextError(409, 'Файл изменили снаружи, пока ты его правил: перечитай и внеси правку заново');
  fs.writeFileSync(real, text);
  // токены поменялись; белый список не трогаем, иначе вторая правка без нового листинга получила бы 403.
  // Идущие листинги считали файл до правки: следующий getContext спросит заново, а их результат не ляжет в кэш
  gen++;
  cache.clear();
  inflight.clear();
  return { mtimeMs: fs.statSync(real).mtimeMs };
}
