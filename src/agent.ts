// Одна фаза = одна свежая сессия Claude Code через Agent SDK.
import { query, type ModelUsage, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { IMPLICIT_TOOLS } from './schema.js';
import type { AskAnswers, AskQuestion, EffortLevel, SessionTokens } from './api-types.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan' | 'auto';

// вопрос агента и ответы — общие с UI: src/api-types.ts
export type { AskAnswers, AskOption, AskQuestion, EffortLevel, SessionTokens } from './api-types.js';
/** preface — текст агента прямо перед вопросом (таблица, список, пояснение); нет — агент ничего не написал. */
export type QuestionHandler = (questions: AskQuestion[], signal: AbortSignal, preface?: string) => Promise<AskAnswers>;

export type SessionRequest = {
  prompt: string;
  cwd: string;
  /** Дополнительные директории, куда сессии можно ходить кроме cwd (как --add-dir). Абсолютные пути. */
  additionalDirectories?: string[];
  /** Обработчик вопросов агента (инструмент AskUserQuestion). Без него вопросы отклоняются. */
  onQuestion?: QuestionHandler;
  system?: string;
  /** Базовый набор инструментов; [] = без инструментов; undefined = все инструменты Claude Code. */
  tools?: string[];
  /** Что добавить к tools неявно; по умолчанию IMPLICIT_TOOLS (Agent и Skill). */
  implicitTools?: readonly string[];
  model?: string;
  effort?: EffortLevel;
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: PermissionMode;
  outputSchema?: Record<string, unknown>;
  /** Сохранять ли сессию в ~/.claude/projects (можно потом открыть через claude --resume). */
  persist?: boolean;
  /** Без фоновых задач: Bash и сабагенты работают синхронно (см. FOREGROUND_ENV). */
  foreground?: boolean;
  /** Продолжить сохранённую сессию с этим id: разговор подгружается. Нужен тот же cwd, что у неё. */
  resume?: string;
  /** Папки локальных плагинов Claude Code (как --plugin-dir), абсолютные пути: скиллы, агенты, хуки и MCP плагина — только этой сессии. */
  plugins?: string[];
  /** MCP-серверы сессии (например, in-process из createSdkMcpServer). Их инструменты разрешаются через allow. */
  mcpServers?: Options['mcpServers'];
  /** Инструменты сверх tools, разрешённые без подтверждений: имена MCP-инструментов (mcp__<сервер>__<инструмент>). */
  allow?: string[];
  /**
   * Проверка перед любым вызовом инструмента, в том числе разрешённого и вызванного сабагентом: строка — отказ с этим
   * объяснением агенту. cwd — рабочая директория сессии из входа хука (от неё считаются относительные пути).
   * Исключение внутри проверки — тоже отказ.
   */
  guard?: (tool: string, input: Record<string, unknown>, ctx: { cwd: string }) => string | undefined;
  /** Вызывается один раз, когда SDK прислал system/init с фактической моделью сессии. */
  onModel?: (model: string) => void;
  /** Вызывается после каждого нового запроса главного цикла к модели: занятость контекста по ходу сессии. */
  onContext?: (c: ContextSnapshot) => void;
  /** Ход сессии событиями (SessionEvent) — рядом с LogFn, а не вместо: строки лога остаются как были. */
  onEvent?: (e: SessionEvent) => void;
  abort?: AbortController;
};

export type SessionResult = {
  ok: boolean;
  subtype: string;
  text: string;
  structured?: unknown;
  costUsd: number;
  turns: number;
  durationMs: number;
  sessionId?: string;
  errors: string[];
  /** Фактическая модель из system/init; нет — init не пришёл (сессия упала до старта). */
  model?: string;
  /** Токены сессии; нет — SDK не прислал usage (сессия упала до первого запроса). */
  tokens?: SessionTokens;
};


/** Занятость контекста по ходу сессии: пик из SessionTokens и окно, если оно уже известно. */
export type ContextSnapshot = { contextPeak: number; requests: number; contextWindow?: number };

/**
 * Счётчик токенов по потоку сообщений SDK; seen — id сообщений модели, чей запрос уже учтён;
 * model — модель главного цикла из system/init; liveWindow — окно из getContextUsage, пока результата нет.
 */
export type TokenTally = { tokens: SessionTokens; seen: Set<string>; model?: string; liveWindow?: number };

export function newTally(): TokenTally {
  return { tokens: { contextStart: 0, contextPeak: 0, requests: 0 }, seen: new Set() };
}

/**
 * Окно по модели из init: SDK присылает окно только с результатом, а идущему этапу процент нужен раньше.
 * Живёт в процессе сервера и переживает запуски: без процента остаётся лишь первый этап модели после рестарта.
 */
const windowCache = new Map<string, number>();

/** Сбросить кэш окон (для тестов). */
export function resetWindowCache(): void {
  windowCache.clear();
}

/**
 * Окно главной модели в modelUsage результата: запись с ключом = модель из init, иначе с canonicalModel = модели
 * из init, иначе единственная запись. Несколько записей без совпадения (главная плюс сабагенты) — окна нет:
 * чужое окно хуже его отсутствия. SDK иногда присылает 0 — это тоже «нет».
 */
export function mainContextWindow(usage: Record<string, ModelUsage>, model?: string): number | undefined {
  const entries = Object.entries(usage);
  const main = (model ? usage[model] ?? entries.find(([, u]) => u.canonicalModel === model)?.[1] : undefined) ?? (entries.length === 1 ? entries[0][1] : undefined);
  return main && main.contextWindow > 0 ? main.contextWindow : undefined;
}

/** Снимок контекста: окно из результата, а пока его нет — из кэша по модели, затем из getContextUsage. */
export function contextSnapshot(t: TokenTally): ContextSnapshot {
  const contextWindow = t.tokens.contextWindow ?? (t.model ? windowCache.get(t.model) : undefined) ?? t.liveWindow;
  return { contextPeak: t.tokens.contextPeak, requests: t.tokens.requests, ...(contextWindow ? { contextWindow } : {}) };
}

/** Учесть сообщение SDK в счётчике. true — счётчик что-то узнал (иначе tokens в отчёт не пишем). */
export function tallyTokens(t: TokenTally, msg: SDKMessage): boolean {
  const init = initModel(msg);
  if (init) {
    t.model ??= init;
    return false;
  }
  if (msg.type === 'assistant') {
    // сабагенты не входят в контекст этапа; их токены придут в modelUsage результата
    if (msg.parent_tool_use_id !== null) return false;
    const m = msg.message as { id?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } };
    // один запрос стримится несколькими сообщениями с общим id; вход у них одинаковый, выход неполный
    if (!m.id || !m.usage || t.seen.has(m.id)) return false;
    t.seen.add(m.id);
    const ctx = (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
    if (!t.tokens.requests) t.tokens.contextStart = ctx;
    t.tokens.contextPeak = Math.max(t.tokens.contextPeak, ctx);
    t.tokens.requests++;
    return true;
  }
  if (msg.type === 'result') {
    const models = Object.values(msg.modelUsage ?? {});
    if (models.length) {
      const window = mainContextWindow(msg.modelUsage, t.model);
      if (window) {
        t.tokens.contextWindow = window;
        if (t.model) windowCache.set(t.model, window);
      }
      t.tokens.input = models.reduce((s, u) => s + u.inputTokens, 0);
      t.tokens.output = models.reduce((s, u) => s + u.outputTokens, 0);
      t.tokens.cacheRead = models.reduce((s, u) => s + u.cacheReadInputTokens, 0);
      t.tokens.cacheCreation = models.reduce((s, u) => s + u.cacheCreationInputTokens, 0);
      return true;
    }
    if (msg.usage) {
      t.tokens.input = msg.usage.input_tokens ?? 0;
      t.tokens.output = msg.usage.output_tokens ?? 0;
      t.tokens.cacheRead = msg.usage.cache_read_input_tokens ?? 0;
      t.tokens.cacheCreation = msg.usage.cache_creation_input_tokens ?? 0;
      return true;
    }
  }
  return false;
}

/** Фактическая модель сессии из сообщения system/init; undefined — другое сообщение или модели в нём нет. */
export function initModel(msg: SDKMessage): string | undefined {
  if (msg.type !== 'system' || msg.subtype !== 'init') return undefined;
  const model = (msg as { model?: unknown }).model;
  return typeof model === 'string' && model ? model : undefined;
}

/**
 * Текст главного агента перед вопросом. Этап часто показывает таблицу или список текстом и сразу спрашивает
 * «что из этого берём?»; без этого текста вопрос на карточке непонятен. Подряд идущие текстовые блоки
 * склеиваются, новый текст после вызова инструмента начинает группу заново: перед вопросом остаётся то,
 * что агент написал последним. Сабагенты не в счёт. После вопроса текст сбрасывается.
 */
export type Preface = { text: string; open: boolean };

/** Максимум текста перед вопросом, символов: больше — хвост, ведь главное агент пишет прямо перед вопросом. */
export const PREFACE_MAX = 20000;

export function trackPreface(p: Preface, msg: SDKMessage): void {
  if (msg.type !== 'assistant' || msg.parent_tool_use_id !== null) return;
  for (const block of blocksOf(msg.message)) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      p.text = p.open ? `${p.text}\n\n${block.text}` : block.text;
      p.open = true;
    } else if (block.type === 'tool_use') {
      p.open = false;
    }
  }
}

/** Забрать текст перед вопросом: следующий вопрос без нового текста получит пустой. */
export function takePreface(p: Preface): string | undefined {
  const text = p.text.trim();
  p.text = '';
  p.open = false;
  if (!text) return undefined;
  return text.length > PREFACE_MAX ? '…' + text.slice(-PREFACE_MAX) : text;
}

export type LogFn = (line: string) => void;

/**
 * Ход сессии структурно, для UI, которому мало строк LogFn (чат, генератор): текст агента, вызов инструмента
 * и его результат целиком, повтор запроса к API. Сабагенты тоже присылают сообщения — parent у них id вызова Agent.
 */
export type SessionEvent =
  | { kind: 'text'; text: string; parent?: string }
  | { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown>; parent?: string }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; text: string; parent?: string }
  | { kind: 'retry'; attempt: number; maxRetries: number; delayMs: number; status: number | null };

/**
 * Headless-сессия заканчивается вместе с ответом агента, и фоновая задача погибает с ней. Агент,
 * ответивший «жду уведомления о push», оставляет push недоделанным. Поэтому фоновые задачи
 * отключаем, а таймауты Bash поднимаем, чтобы долгие проверки (pre-push хук, сборка, ожидание CI)
 * влезали без фона: без фона команду, не уложившуюся в таймаут, убивают, а не уводят в фон.
 * По умолчанию команда живёт 30 минут вместо 2, с явным timeout — до часа вместо 10 минут.
 */
export const FOREGROUND_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  BASH_DEFAULT_TIMEOUT_MS: String(30 * 60 * 1000),
  BASH_MAX_TIMEOUT_MS: String(60 * 60 * 1000),
};

/** Префикс инструментов коннекторов claude.ai (Atlassian, Slack, Docs из аккаунта пользователя). */
export const CLAUDEAI_TOOL_PREFIX = 'mcp__claude_ai_';

/**
 * Коннекторы claude.ai подключаются к каждой сессии и после первого вызова инструмента приносят в контекст
 * определения всех своих инструментов — около 45K токенов на каждом следующем запросе. Оставляем их только
 * сессии, которая может их вызвать: без списка tools, с mcp__claude_ai_* в tools или allow, или в режиме,
 * где разрешения не спрашивают. Остальным canUseTool всё равно отказал бы. Локальные MCP это не трогает.
 */
export function wantsClaudeAiConnectors(req: Pick<SessionRequest, 'tools' | 'allow' | 'permissionMode'>): boolean {
  if (!req.tools) return true;
  if (req.permissionMode === 'bypassPermissions' || req.permissionMode === 'auto') return true;
  return [...req.tools, ...(req.allow ?? [])].some((t) => t.startsWith(CLAUDEAI_TOOL_PREFIX));
}

export const NO_CLAUDEAI_CONNECTORS_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };

/** Как долго ждём окно у getContextUsage: оно только украшает чип, сессию из-за него не задерживаем. */
const WINDOW_PROBE_MS = 5000;

/** Зависимости runSession: поддельный query для тестов цикла (как ContextDeps в context.ts). */
export type SessionDeps = {
  query: (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & Partial<Pick<Query, 'getContextUsage'>>;
};

/** Окно модели у идущей сессии: rawMaxTokens из getContextUsage (разведка: равно contextWindow). true — окно узнали. */
async function probeWindow(usage: () => Promise<{ rawMaxTokens: number }>, t: TokenTally): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('таймаут')), WINDOW_PROBE_MS);
    });
    const u = await Promise.race([usage(), timeout]);
    if (u.rawMaxTokens > 0) {
      t.liveWindow = u.rawMaxTokens;
      return true;
    }
  } catch {
    // окно не узнали — процента у идущего этапа не будет до результата
  } finally {
    clearTimeout(timer);
  }
  return false;
}

export async function runSession(req: SessionRequest, log: LogFn, deps: SessionDeps = { query }): Promise<SessionResult> {
  const preface: Preface = { text: '', open: false };
  const options = sessionOptions(req, preface);
  const started = Date.now();
  const result: SessionResult = { ok: false, subtype: 'no_result', text: '', costUsd: 0, turns: 0, durationMs: 0, errors: [] };
  const tally = newTally();
  let counted = false;
  let done = false;
  const emitContext = () => req.onContext?.(contextSnapshot(tally));
  try {
    const q = deps.query({ prompt: req.prompt, options });
    for await (const msg of q) {
      trackPreface(preface, msg);
      handle(msg, result, log);
      if (req.onEvent) for (const e of sessionEvents(msg)) req.onEvent(e);
      const model = initModel(msg);
      if (model && !result.model) {
        result.model = model;
        req.onModel?.(model);
        const probe = q.getContextUsage;
        // окно уже в кэше по модели — лишний вызов не нужен
        if (req.onContext && probe && !windowCache.has(model)) {
          void probeWindow(() => probe.call(q, { detail: 'summary' }), tally).then((known) => {
            if (known && !done && tally.tokens.requests) emitContext();
          });
        }
      }
      const requests = tally.tokens.requests;
      counted = tallyTokens(tally, msg) || counted;
      if (tally.tokens.requests !== requests) emitContext();
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }
  done = true;
  result.durationMs = Date.now() - started;
  if (counted) result.tokens = tally.tokens;
  return result;
}

/**
 * CLI Claude Code для SDK. Обычно SDK находит его сам, в пакете под платформу; упакованное десктопное приложение
 * (src/desktop/main.ts) задаёт путь явно: SDK нашёл бы его внутри app.asar, а оттуда запустить процесс нельзя.
 */
export function claudeExecutable(): Pick<Options, 'pathToClaudeCodeExecutable'> {
  const p = process.env.AGENTGRAPH_CLAUDE_EXECUTABLE;
  return p ? { pathToClaudeCodeExecutable: p } : {};
}

/** Опции Agent SDK для сессии: инструменты, разрешения, env, вопросы пользователю (preface — текст агента перед ними). */
export function sessionOptions(req: SessionRequest, preface?: Preface): Options {
  const options: Options = {
    ...claudeExecutable(),
    cwd: req.cwd,
    persistSession: req.persist ?? true,
    permissionMode: req.permissionMode ?? 'default',
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'agentgraph/0.1.0',
      // CLAUDE.md из доп. директорий без этого флага не грузится (скиллы из них грузятся и так).
      ...(req.additionalDirectories?.length ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } : {}),
      ...(req.foreground ? FOREGROUND_ENV : {}),
      ...(wantsClaudeAiConnectors(req) ? {} : NO_CLAUDEAI_CONNECTORS_ENV),
    },
    systemPrompt: req.system
      ? { type: 'custom', prompt: req.system }
      : { type: 'preset', preset: 'claude_code' },
  };
  if (options.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
  if (req.additionalDirectories?.length) options.additionalDirectories = req.additionalDirectories;
  if (req.model) options.model = req.model;
  if (req.effort) options.effort = req.effort;
  if (req.maxTurns) options.maxTurns = req.maxTurns;
  if (req.maxBudgetUsd) options.maxBudgetUsd = req.maxBudgetUsd;
  if (req.abort) options.abortController = req.abort;
  if (req.tools) {
    // Сабагенты (Agent) и скиллы (Skill) доступны любой сессии. Сабагент получает только
    // инструменты родителя, так что least-privilege фазы сохраняется.
    const own = req.tools;
    const tools = [...own, ...(req.implicitTools ?? IMPLICIT_TOOLS).filter((t) => !own.includes(t))];
    options.tools = tools;
    // Перечисленные инструменты разрешаем без подтверждений: в headless-режиме
    // любой permission prompt автоматически превращается в отказ.
    // AskUserQuestion не пре-одобряем: он должен дойти до canUseTool, где мы соберём ответы.
    const auto = tools.filter((t) => t !== 'AskUserQuestion');
    if (auto.length > 0) options.allowedTools = auto;
  }
  if (req.resume) options.resume = req.resume;
  if (req.plugins?.length) options.plugins = req.plugins.map((p) => ({ type: 'local', path: p }));
  if (req.mcpServers) options.mcpServers = req.mcpServers;
  if (req.allow?.length) options.allowedTools = [...(options.allowedTools ?? []), ...req.allow];
  if (req.guard) {
    const guard = req.guard;
    // хук, а не canUseTool: разрешённые инструменты до canUseTool не доходят
    options.hooks = {
      PreToolUse: [{
        hooks: [async (input) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          let why: string | undefined;
          try {
            why = guard(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, { cwd: input.cwd });
          } catch (err) {
            // fail-closed: упавшая проверка не должна пропустить вызов
            why = `Проверка доступа не удалась (${err instanceof Error ? err.message : String(err)}): вызов отклонён.`;
          }
          return why ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } } : {};
        }],
      }],
    };
  }
  if (req.onQuestion) {
    const onQuestion = req.onQuestion;
    options.canUseTool = async (toolName, input, { signal, blockedPath, decisionReason }) => {
      if (toolName === 'AskUserQuestion') {
        const questions = Array.isArray(input.questions) ? (input.questions as AskQuestion[]) : [];
        // запрос разрешения и сообщение с текстом идут разными путями: даём циклу сообщений дочитать очередь
        if (preface) await new Promise((resolve) => setImmediate(resolve));
        const said = preface ? takePreface(preface) : undefined;
        try {
          const answers = await onQuestion(questions, signal, said);
          return { behavior: 'allow', updatedInput: { questions, answers } };
        } catch (err) {
          return { behavior: 'deny', message: `Пользователь не ответил: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      // Инструмент из списка фазы всё равно может запросить подтверждение (например, запись
      // в защищённый .claude/ или вне рабочего каталога) — не выдаём это за запрет инструмента.
      if (options.allowedTools?.includes(toolName)) {
        const where = blockedPath ? ` (путь ${blockedPath})` : '';
        const why = decisionReason ? `: ${decisionReason}` : '';
        return {
          behavior: 'deny',
          message: `${toolName} разрешён этапу, но это действие${where} требует подтверждения${why}; в headless-режиме подтвердить некому. Выбери другой путь (не .claude/, внутри директории проекта или add_dirs).`,
        };
      }
      return { behavior: 'deny', message: `Инструмент ${toolName} не разрешён для этого этапа` };
    };
  }
  if (req.outputSchema) options.outputFormat = { type: 'json_schema', schema: req.outputSchema };
  return options;
}

type Block = Record<string, unknown>;

function blocksOf(message: unknown): Block[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof (b as Block).text === 'string' ? String((b as Block).text) : ''))
      .join('');
  }
  return '';
}

function handle(msg: SDKMessage, result: SessionResult, log: LogFn): void {
  if (msg.type === 'assistant') {
    for (const block of blocksOf(msg.message)) {
      if (block.type === 'text' && typeof block.text === 'string') log(block.text);
      else if (block.type === 'tool_use') log(`▸ ${String(block.name)} ${truncate(JSON.stringify(block.input), 300)}`);
    }
  } else if (msg.type === 'user') {
    for (const block of blocksOf(msg.message)) {
      if (block.type === 'tool_result') log(`  ↳ ${truncate(contentToText(block.content), 200)}`);
    }
  } else if (msg.type === 'result') {
    result.subtype = msg.subtype;
    result.costUsd = msg.total_cost_usd;
    result.turns = msg.num_turns;
    result.sessionId = msg.session_id;
    if (msg.subtype === 'success') {
      result.ok = !msg.is_error;
      result.text = msg.result;
      result.structured = msg.structured_output;
    } else {
      result.errors.push(...msg.errors);
    }
  }
}

/** События SessionEvent из одного сообщения SDK; служебное и результат сессии — ничего. */
export function sessionEvents(msg: SDKMessage): SessionEvent[] {
  const parentOf = (m: { parent_tool_use_id?: string | null }) => (m.parent_tool_use_id ? { parent: m.parent_tool_use_id } : {});
  if (msg.type === 'assistant') {
    const out: SessionEvent[] = [];
    for (const block of blocksOf(msg.message)) {
      if (block.type === 'text' && typeof block.text === 'string') out.push({ kind: 'text', text: block.text, ...parentOf(msg) });
      else if (block.type === 'tool_use') {
        const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
        out.push({ kind: 'tool_use', id: String(block.id), name: String(block.name), input, ...parentOf(msg) });
      }
    }
    return out;
  }
  if (msg.type === 'user') {
    return blocksOf(msg.message)
      .filter((block) => block.type === 'tool_result')
      .map((block) => ({ kind: 'tool_result', toolUseId: String(block.tool_use_id), isError: block.is_error === true, text: contentToText(block.content), ...parentOf(msg) }));
  }
  if (msg.type === 'system' && msg.subtype === 'api_retry') {
    return [{ kind: 'retry', attempt: msg.attempt, maxRetries: msg.max_retries, delayMs: msg.retry_delay_ms, status: msg.error_status }];
  }
  return [];
}

export function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}
