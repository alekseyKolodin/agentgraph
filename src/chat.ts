// Чат запуска: разговор с агентом про один запуск флоу. Сессия Claude продолжается между сообщениями (resume),
// «очистить контекст» начинает новую. Свежее состояние агент берёт инструментами (run_status, run_log), а управляет
// запуском через те же функции сервера, что и кнопки UI, — их передаёт сервер (ChatControls).
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runSession, truncate, type AskAnswers, type LogFn } from './agent.js';
import { canonical, isInside, toolPath, WRITE_TOOLS } from './artifacts.js';
import { nodeProbe } from './artifact-store.js';
import type { BlockReport, QuestionRecord, RunReport } from './runner.js';

export type { ChatLog, ChatMessage } from './api-types.js';
import type { ChatLog, ChatMessage } from './api-types.js';

/** Запуск глазами чата: у идущего — из памяти сервера (статус ждёт ответа / на паузе, текущий шаг, открытые вопросы). */
export type RunView = {
  report: RunReport;
  /** Идёт в этом сервере: им можно управлять. */
  live: boolean;
  /** Как в списке запусков: у идущего waiting / paused / running. */
  status: string;
  current: { block: string; iteration: number; title: string } | null;
  /** Идущие этапы: у параллельной группы их несколько. У запуска не в этом сервере — пусто. */
  running?: { block: string; iteration: number; phase: string; title: string; group?: string }[];
  pending: QuestionRecord[];
};

/** Управление запуском — те же функции, что у кнопок UI. Ошибки бросают с понятным текстом. */
export type ChatControls = {
  view: () => RunView | undefined;
  /** Хвост живого лога; undefined — запуск не идёт в этом сервере. */
  logTail: (lines: number) => string[] | undefined;
  pause: () => void;
  resume: () => void;
  abort: () => void;
  setMaxIterations: (block: string, value: number) => BlockReport;
  answer: (questionId: string, answers: AskAnswers) => void;
  continueRun: () => { id: string; skipped: string[] };
};

export const CHAT_FILE = 'chat.json';
const SERVER = 'run';
const RUN_TOOLS = ['run_status', 'run_log', 'pause_run', 'resume_run', 'abort_run', 'set_max_iterations', 'answer_question', 'continue_run'] as const;
export const CHAT_ALLOWED = RUN_TOOLS.map((t) => `mcp__${SERVER}__${t}`);
/** Встроенные инструменты чата: читать запуск и репозиторий, git и тесты, правки в рабочей директории по просьбе. */
export const CHAT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'];
/** Без Agent: его описание со списком сабагентов почти удваивает контекст каждого хода, а чат должен отвечать быстро и дёшево. */
const CHAT_IMPLICIT = ['Skill'];
const MESSAGE_MAX = 20_000;

const STATUS: Record<string, string> = {
  running: 'выполняется', waiting: 'ждёт ответа на вопрос агента', paused: 'на паузе', done: 'готово',
  max_iterations: 'лимит итераций', failed: 'ошибка', budget_exceeded: 'лимит стоимости', aborted: 'прервано', interrupted: 'оборвался',
};

export function readChat(runDir: string): ChatLog {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(runDir, CHAT_FILE), 'utf8')) as Partial<ChatLog>;
    return { ...c, messages: Array.isArray(c.messages) ? c.messages : [], totalCostUsd: Number(c.totalCostUsd) || 0 };
  } catch {
    return { messages: [], totalCostUsd: 0 };
  }
}

export function saveChat(runDir: string, chat: ChatLog): void {
  fs.writeFileSync(path.join(runDir, CHAT_FILE), JSON.stringify(chat, null, 2));
}

/** Как /clear: новая сессия и пустая история; потраченное остаётся в totalCostUsd. */
export function clearChat(runDir: string): ChatLog {
  const chat: ChatLog = { messages: [], totalCostUsd: readChat(runDir).totalCostUsd };
  saveChat(runDir, chat);
  return chat;
}

/** Одна строка состояния в начале каждого сообщения: разговор продолжается, а запуск за это время мог уйти вперёд. */
export function statusLine(v: RunView, now = new Date()): string {
  const r = v.report;
  const blocks = r.blocks ?? [];
  const parts = [STATUS[v.status] ?? v.status];
  const cur = blocks.find((b) => b.status === 'running');
  if (cur) {
    if (blocks.length > 1) parts.push(`блок ${cur.index + 1}/${blocks.length} «${cur.title}»`);
    if (cur.looped) parts.push(`итерация ${cur.iterations}/${cur.maxIterations}`);
  } else {
    parts.push(`итераций ${r.iterations}`);
  }
  const running = v.running ?? [];
  if (running.length > 1) parts.push(`сейчас параллельно: ${running.map((x) => `«${x.title}»`).join(', ')}`);
  else if (v.current) parts.push(`сейчас: «${v.current.title}»`);
  if (v.pending.length) parts.push(`вопросов ждут ответа: ${v.pending.length}`);
  if (r.pause === 'requested') parts.push('пауза после текущего шага');
  parts.push(`$${r.totalCostUsd.toFixed(2)}`);
  if (r.error) parts.push(`ошибка: ${truncate(r.error, 200)}`);
  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `[Состояние запуска на ${time}: ${parts.join(' · ')}]`;
}

const tail = (s: string | undefined, max: number) => (s && s.length > max ? '…' + s.slice(-max) : s);

/** Ответ run_status: всё, что нужно, чтобы рассказать о запуске, без содержимого выводов (их агент читает по путям). */
export function statusReport(v: RunView): Record<string, unknown> {
  const r = v.report;
  return {
    id: r.id,
    flow: r.flow,
    status: v.status,
    statusLabel: STATUS[v.status] ?? v.status,
    liveHere: v.live,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    totalCostUsd: Number(r.totalCostUsd.toFixed(4)),
    iterations: `${r.iterations}/${r.maxIterations}`,
    error: r.error,
    pause: r.pause,
    pauseReason: r.pauseReason,
    current: v.current,
    running: v.running?.length ? v.running : undefined,
    blocks: (r.blocks ?? []).map((b) => ({
      name: b.name, title: b.title, status: b.status, iterations: b.iterations, maxIterations: b.maxIterations,
      condition: b.condition, looped: b.looped, onFail: b.onFail, ...(b.skipped ? { skipped: true } : {}),
    })),
    pendingQuestions: v.pending.map((q) => ({ id: q.id, phase: q.phase, block: q.block, iteration: q.iteration, ...(q.preface ? { preface: q.preface } : {}), questions: q.questions })),
    // последние этапы и проверки: на 50 итерациях полный список раздул бы ответ; остальное — в run.json
    lastPhases: r.phases.slice(-12).map((p) => ({
      block: p.block, iteration: p.iteration, phase: p.phase, ok: p.ok, subtype: p.subtype, costUsd: Number(p.costUsd.toFixed(4)),
      turns: p.turns, durationSec: Math.round(p.durationMs / 1000), model: p.model, effort: p.effort, errors: p.errors.length ? p.errors : undefined, files: p.files,
    })),
    lastConditions: r.conditions.slice(-6).map((c) => ({
      block: c.block, iteration: c.iteration, type: c.type, done: c.done, detail: tail(c.detail, 500), feedback: tail(c.feedback, 1500), logFile: c.logFile,
    })),
    continuedFrom: r.continuedFrom,
    source: r.source,
    worktree: r.worktree,
  };
}

export function chatSystemPrompt(r: RunReport, runDir: string, cwd: string): string {
  const multi = (r.blocks?.length ?? 0) > 1;
  return `Ты — чат на странице одного запуска agentgraph. Пользователь спрашивает про этот запуск и просит что-то с ним сделать. Всё в разговоре по умолчанию относится к этому запуску.

Как устроен agentgraph. Flow (flow.yaml) — блоки по порядку. Блок — цикл итераций до условия остановки (или один проход). Итерация — этапы по порядку; соседние этапы с одним group (параллельная группа) идут одновременно, следующий за группой этап получает в {{prev}} склейку их выводов. Каждый этап — свежая сессия Claude Code со своим промптом. Вывод этапа уходит в промпты следующих ({{prev}}, {{phases.<этап>}}), а после этапов проверяется условие (команда с кодом 0, судья или маркер в выводе); его замечания попадают в {{feedback}} следующей итерации. Этап может спросить пользователя (вопрос ждёт ответа) или попросить паузу маркером в конце вывода (pauseReason).

Запуск:
- id: ${r.id}
- flow: ${r.flow}${r.description ? ` — ${r.description}` : ''}
- директория проекта (cwd, здесь же работаешь ты): ${cwd}
- папка запуска: ${runDir}
- задача ({{input}}): ${truncate(r.input ?? '', 1500)}

Файлы папки запуска: run.json (отчёт: статусы блоков, этапы со стоимостью и путями файлов, результаты условий, вопросы), flow.yaml (спецификация, с которой шёл запуск), ${multi ? 'NN-<блок>/' : ''}iter-NN/NN-<этап>.prompt.md (промпт этапа), .transcript.md (ход сессии), .output.md (итоговый вывод), iter-NN/condition.json и condition.command.log или condition.judge.prompt.md (как проверялось условие).

Инструменты запуска:
- run_status — состояние сейчас. Строка [Состояние запуска …] в начале сообщения — снимок на момент отправки; если важны подробности (этапы, замечания условия, вопросы), вызови run_status.
- run_log — хвост живого лога идущего запуска: что агенты делают прямо сейчас.
- pause_run, resume_run, abort_run, set_max_iterations, answer_question, continue_run — то же, что кнопки на странице запуска: «Пауза», «Возобновить», «Остановить запуск», лимит итераций, ответ на вопрос, «Продолжить с места остановки».
- Read, Grep, Glob — файлы запуска и репозитория; Bash — git status/diff, тесты и т.п.; Edit, Write — правки в директории проекта.

Правила:
1. Отвечай коротко, по делу и на языке пользователя. Называй сущности так же, как в интерфейсе: flow, этап, блок, условие, замечания, задача, запуск, директория проекта. Этапы, блоки и итерации называй так, как они в отчёте. Не пересказывай весь отчёт, когда спрашивают об одном.
2. Имена инструментов пользователю не называй: он их не вызывает. Говори, что можешь сделать сам: «могу возобновить запуск», «подниму лимит итераций до 40».
3. Действия с запуском, правки файлов и команды, меняющие репозиторий, — только когда пользователь прямо об этом попросил. abort_run — только по явной просьбе остановить запуск; если не уверен, переспроси. После действия скажи, что сделал и что будет дальше.
4. В папку запуска ничего не пиши: run.json, выводы и транскрипты этапов пишут раннер и сервер, правка там ни на что не повлияет.
5. Идущий запуск работает в той же директории проекта. Правка файлов или git-команды посреди этапа столкнутся с ним: предупреди и предложи сначала паузу (текущий этап доработает, следующий не начнётся).
6. Flow здесь не правится: это делается во вкладке «Конструктор» flow. Идущий запуск правок flow не видит; продолжение (continue_run) берёт текущую версию flow.
${pauseRule(r)}
8. На вопрос агента (pendingQuestions) отвечай answer_question: ключ — текст вопроса, значение — label варианта или свой текст.`;
}

/**
 * Правило 7: как отвечать на паузу по просьбе этапа. У flow с артефактом decisions ответ даёт сам пользователь
 * в карточке паузы (сервер запишет его в артефакт и в отчёт) или правкой артефакта: чат в папку запуска не пишет.
 */
function pauseRule(r: RunReport): string {
  const decisions = r.artifacts?.items.find((a) => a.decisions);
  if (decisions) {
    return `7. Пауза по просьбе этапа (pauseReason): этап пишет в pauseReason.text, что ему нужно от пользователя. Ответы на такие паузы у этого flow хранятся в артефакте «${decisions.title}» (${decisions.file}) папки запуска. Ответ пользователь даёт сам: в поле «Ответ» карточки паузы на странице запуска и кнопкой «Возобновить с ответом» (ответ запишется в артефакт и в отчёт запуска) или правкой артефакта в панели «Артефакты». Ответ за пользователя не записывай ни туда, ни в файлы проекта; подскажи, где ответить. resume_run возобновляет без ответа — вызывай его, только если пользователь хочет продолжить без ответа.`;
  }
  return `7. Пауза по просьбе этапа (pauseReason): этап пишет в pauseReason.text, что ему нужно от пользователя. Следующая итерация увидит ответ, только если он лежит там, откуда flow его читает: чаще всего в файле директории проекта, который назвал этап (сверься с промптами в flow.yaml). Когда пользователь ответил, запиши ответ туда (с его согласия) и возобнови запуск (resume_run). Если записать некуда — так и скажи: просто возобновлённый запуск ответа не передаст.`;
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): ToolText => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): ToolText => ({ content: [{ type: 'text', text: `Не получилось: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
const act = (fn: () => string) => async (): Promise<ToolText> => {
  try {
    return ok(fn());
  } catch (err) {
    return fail(err);
  }
};

/** MCP-сервер с инструментами запуска; onContinue — чат начал новый запуск-продолжение. */
export function chatServer(ctl: ChatControls, onContinue: (id: string) => void) {
  const view = () => {
    const v = ctl.view();
    if (!v) throw new Error('Запуск не найден');
    return v;
  };
  return createSdkMcpServer({
    name: SERVER,
    tools: [
      tool('run_status', 'Текущее состояние запуска: статус, блоки, текущий шаг и все идущие этапы (running), пауза и её причина, вопросы, ждущие ответа, последние этапы (с путями файлов) и результаты условий.', {},
        act(() => JSON.stringify(statusReport(view()), null, 2)), { annotations: { readOnlyHint: true } }),
      tool('run_log', 'Хвост живого лога идущего запуска: текст агентов и вызовы инструментов. У завершённого запуска лога нет — читай транскрипты этапов.', { lines: z.number().int().min(1).max(400).optional().describe('сколько последних строк, по умолчанию 80') },
        async ({ lines }) => {
          const log = ctl.logTail(lines ?? 80);
          if (!log) return ok('Запуск не идёт в этом сервере: живого лога нет. Ход этапов — в их .transcript.md (пути в run_status → lastPhases[].files).');
          return ok(log.length ? log.join('\n') : 'Лог пока пуст.');
        }, { annotations: { readOnlyHint: true } }),
      tool('pause_run', 'Мягкая пауза: идущие этапы или проверка условия доработают, следующий шаг не начнётся до resume_run.', {},
        act(() => { ctl.pause(); return 'Пауза запрошена: текущий шаг доработает, следующий не начнётся.'; })),
      tool('resume_run', 'Возобновить запуск после паузы (кнопка «Возобновить»): он пойдёт дальше.', {},
        act(() => { ctl.resume(); return 'Запуск возобновлён: пауза снята.'; })),
      tool('abort_run', 'Остановить запуск сразу (кнопка «Остановить запуск»): идущая сессия прерывается. Только по явной просьбе пользователя.', {},
        act(() => { ctl.abort(); return 'Запуск останавливается.'; }), { annotations: { destructiveHint: true } }),
      tool('set_max_iterations', 'Поменять лимит итераций блока с циклом у идущего запуска (1–50, не меньше текущей итерации). Подхватится со следующей итерации.',
        { block: z.string().describe('имя блока (blocks[].name из run_status)'), value: z.number().int().min(1).max(50) },
        async ({ block, value }) => {
          try {
            const b = ctl.setMaxIterations(block, value);
            return ok(`Лимит итераций блока «${b.title}»: ${b.maxIterations}.`);
          } catch (err) {
            return fail(err);
          }
        }),
      tool('answer_question', 'Ответить на вопрос агента (pendingQuestions из run_status). Сессия этапа продолжится с этим ответом.',
        { question_id: z.string(), answers: z.record(z.string(), z.string()).describe('ключ — текст вопроса (questions[].question), значение — label выбранного варианта, несколько через ", " или свой текст') },
        async ({ question_id, answers }) => {
          try {
            ctl.answer(question_id, answers);
            return ok('Ответ отправлен, этап продолжает работу.');
          } catch (err) {
            return fail(err);
          }
        }),
      tool('continue_run', 'Продолжить завершённый не done запуск текущей версией flow: новый запуск, блоки, прошедшие целиком, не повторяются. Вернёт id нового запуска.', {},
        act(() => {
          const r = ctl.continueRun();
          onContinue(r.id);
          return `Начат новый запуск ${r.id}; пропущены блоки: ${r.skipped.join(', ') || '—'}. Ссылка на него появится под ответом.`;
        })),
    ],
  });
}

/**
 * Запрет записи в папку запуска: run.json и файлы этапов пишут раннер и сервер. Пути сравниваются канонически (~, относительные
 * от cwd сессии, симлинки, регистр на APFS), как в guard артефактов. Bash не разбираем — правило в системном промпте.
 */
export function runDirGuard(runDir: string): (tool: string, input: Record<string, unknown>, ctx?: { cwd: string }) => string | undefined {
  const root = canonical(runDir, process.cwd(), nodeProbe);
  return (tool, input, ctx) => {
    if (!WRITE_TOOLS.includes(tool)) return undefined;
    const file = toolPath(tool, input);
    if (typeof file !== 'string' || !file) return undefined;
    const inside = isInside(canonical(file, ctx?.cwd ?? process.cwd(), nodeProbe), root);
    return inside ? 'В папку запуска писать нельзя: её файлы пишут раннер и сервер. Правки — только в директории проекта.' : undefined;
  };
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export type ChatTurnOptions = {
  runDir: string;
  /** Рабочая директория запуска; если её нет на диске — папка запуска. */
  cwd?: string;
  message: string;
  model?: string;
  controls: ChatControls;
  abort?: AbortController;
  /** Ход ответа: текст и вызовы инструментов, для живого показа. */
  log?: LogFn;
  /** Сообщение пользователя записано в историю: можно показывать. */
  onSaved?: (chat: ChatLog) => void;
};

/** Один ход чата: сообщение в историю, сессия (продолжение прошлой, если можно), ответ в историю. Возвращает историю после хода. */
export async function chatTurn(o: ChatTurnOptions): Promise<ChatLog> {
  const v = o.controls.view();
  if (!v) throw new Error('Запуск не найден');
  const message = o.message.trim().slice(0, MESSAGE_MAX);
  if (!message) throw new Error('Пустое сообщение');
  const chat = readChat(o.runDir);
  const now = () => new Date().toISOString();
  chat.messages.push({ role: 'user', text: message, at: now() });
  saveChat(o.runDir, chat);
  o.onSaved?.(chat);

  const cwd = o.cwd && isDir(o.cwd) ? o.cwd : o.runDir;
  let resume = chat.sessionId;
  if (resume && chat.cwd !== cwd) {
    chat.messages.push({ role: 'note', text: 'Прошлый контекст не продолжить: директория проекта запуска изменилась или пропала. Начат новый разговор.', at: now() });
    resume = undefined;
  }
  let continued: string | undefined;
  const server = chatServer(o.controls, (id) => { continued = id; });
  const inside = realpath(o.runDir).startsWith(realpath(cwd) + path.sep) || realpath(o.runDir) === realpath(cwd);
  const ask = (resumeId: string | undefined) =>
    runSession({
      prompt: `${statusLine(v)}\n\n${message}`,
      cwd,
      additionalDirectories: inside ? undefined : [o.runDir],
      system: chatSystemPrompt(v.report, o.runDir, cwd),
      tools: CHAT_TOOLS,
      implicitTools: CHAT_IMPLICIT,
      allow: CHAT_ALLOWED,
      mcpServers: { [SERVER]: server },
      guard: runDirGuard(o.runDir),
      model: o.model,
      maxTurns: 40,
      persist: true,
      resume: resumeId,
      abort: o.abort,
    }, o.log ?? (() => {}));

  let r = await ask(resume);
  if (resume && !r.ok && r.turns === 0 && !o.abort?.signal.aborted) {
    // сохранённой сессии нет (стёрли ~/.claude/projects или сессия не дописалась) — не молчим, начинаем заново
    chat.messages.push({ role: 'note', text: `Прошлый контекст не нашёлся (${truncate(r.errors[0] || r.subtype, 200)}). Начат новый разговор.`, at: now() });
    resume = undefined;
    r = await ask(undefined);
  }
  // SDK при resume отдаёт стоимость с начала сессии: за ход — разница с прошлым значением
  const prev = resume ? chat.sessionCostUsd ?? 0 : 0;
  const cost = r.costUsd >= prev ? r.costUsd - prev : r.costUsd;
  const aborted = Boolean(o.abort?.signal.aborted);
  chat.messages.push({
    role: 'assistant',
    text: r.ok && r.text.trim() ? r.text.trim() : aborted ? 'Прервано.' : `Ошибка: ${r.errors.join('; ') || r.subtype}`,
    at: now(),
    costUsd: cost,
    ...(r.ok ? {} : { error: true }),
    ...(continued ? { openRun: continued } : {}),
  });
  if (r.sessionId) {
    chat.sessionId = r.sessionId;
    chat.cwd = cwd;
    chat.sessionCostUsd = r.costUsd;
  }
  chat.totalCostUsd += cost;
  saveChat(o.runDir, chat);
  return chat;
}

function isDir(p: string): boolean {
  return Boolean(fs.statSync(p, { throwIfNoEntry: false })?.isDirectory());
}
