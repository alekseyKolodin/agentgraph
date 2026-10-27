// Чат запуска: разговор с агентом про один запуск флоу. Сессия Claude продолжается между сообщениями (resume),
// «очистить контекст» начинает новую. Свежее состояние агент берёт инструментами (run_status, run_log), а управляет
// запуском через те же функции сервера, что и кнопки UI, — их передаёт сервер (ChatControls). Безопасное (пауза,
// лимит итераций) агент делает сам, опасное и общее (остановить, записать артефакт, сохранить flow, продолжить)
// только предлагает кнопкой: действие выполняет POST …/chat/action после клика и подтверждения (chatAction).
// Второй MCP-сервер ui рисует виджеты под ответом: модель шлёт данные (zod на входе), UI рисует их сам, HTML от модели нет.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runSession, truncate, type AskAnswers, type LogFn, type SessionEvent, type SessionRequest, type SessionResult } from './agent.js';
import type { ApiReply } from './artifact-api.js';
import { canonical, isInside, toolPath, WRITE_TOOLS } from './artifacts.js';
import { ANSWER_MAX, nodeProbe } from './artifact-store.js';
import { parseFlow } from './flows.js';
import { FLOWS_DIR } from './paths.js';
import type { BlockReport, QuestionRecord, RunReport } from './runner.js';

export type { ChatLog, ChatMessage } from './api-types.js';
import type { ArtifactListItem, ArtifactRead, ChatAction, ChatActionKind, ChatEffect, ChatLink, ChatLog, ChatMessage, ChatStep, ChatWidget } from './api-types.js';

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

/** Flow запуска для чата: снимок runs/<id>/flow.yaml и текущий файл в flows/ (у разового его нет). Читаются заново на каждый вызов. */
export type FlowSnapshots = {
  name: string;
  adhoc: boolean;
  run?: { file: string; yaml: string };
  flows?: { file: string; yaml: string };
};

type Via = { via?: 'ui' | 'skill' | 'chat' };

/** Управление запуском — те же функции, что у кнопок UI. Ошибки бросают с понятным текстом (и status, как HttpError сервера). */
export type ChatControls = {
  view: () => RunView | undefined;
  /** Хвост живого лога; undefined — запуск не идёт в этом сервере. */
  logTail: (lines: number) => string[] | undefined;
  pause: () => void;
  resume: () => void;
  abort: () => void;
  setMaxIterations: (block: string, value: number) => BlockReport;
  answer: (questionId: string, answers: AskAnswers) => void;
  continueRun: (o?: { model?: string; maxBudgetUsd?: number }) => { id: string; skipped: string[] };
  /** Новый запуск того же flow с той же задачей, директорией, тегами и вложениями. */
  rerun: (o?: { model?: string; maxBudgetUsd?: number }) => { id: string };
  /** Артефакты — ответы API артефактов как есть (код и тело): 409, 423 и прочие отказы модель получает текстом. Запись — via chat. */
  artifacts: {
    list: () => ApiReply;
    read: (key: string) => ApiReply;
    write: (key: string, text: string, base: string) => ApiReply;
  };
  /** Ответ на паузу по просьбе этапа: в артефакт решений и в отчёт, затем возобновить (via chat). */
  answerPause: (text: string) => ApiReply;
  readFlow: () => FlowSnapshots;
  /** Записать YAML в flows/<flow запуска>.yaml (общий файл: его берут следующие запуски и продолжения). */
  saveFlow: (yaml: string) => { file: string };
  // Правка идущего запуска (сервер умеет её не всегда): нет члена — нет и инструмента или кнопки.
  /** Указание этапам: next — следующему шагу, run — до конца запуска. */
  note?: (text: string, o?: { scope?: 'next' | 'run' } & Via) => unknown;
  /** Только на паузе: 409 not_paused; 400 incompatible + problems. */
  applyRunFlow?: (yaml: string, o?: { saveToFlows?: boolean } & Via) => unknown;
  reloadRunFlow?: (o?: Via) => unknown;
  restartIteration?: (o?: { note?: string } & Via) => { block: string; iteration: number };
};

export const CHAT_FILE = 'chat.json';
const SERVER = 'run';
const UI = 'ui';
const RUN_TOOLS = ['run_status', 'run_log', 'pause_run', 'resume_run', 'set_max_iterations', 'answer_question', 'artifacts', 'flow_read'] as const;
const UI_TOOLS = ['show_table', 'show_links', 'propose_actions', 'offer_replies'] as const;
/** Разрешённые MCP-инструменты чата: run_note — только когда сервер умеет указания этапам. */
export function chatAllowed(ctl: Pick<ChatControls, 'note'>): string[] {
  return [...RUN_TOOLS, ...(ctl.note ? ['run_note'] : [])].map((t) => `mcp__${SERVER}__${t}`).concat(UI_TOOLS.map((t) => `mcp__${UI}__${t}`));
}
/** Встроенные инструменты чата: читать запуск и репозиторий, git и тесты, правки в рабочей директории по просьбе. */
export const CHAT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'];
/** Без Agent: его описание со списком сабагентов почти удваивает контекст каждого хода, а чат должен отвечать быстро и дёшево. */
const CHAT_IMPLICIT = ['Skill'];
const MESSAGE_MAX = 20_000;
/** Больше шагов за ход не пишем: трасса — подсказка, а не транскрипт. */
const STEPS_MAX = 300;
/** Текст артефакта в ответе инструмента: дальше — Read по пути. */
const ARTIFACT_TEXT_MAX = 60_000;

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
    // артефакты коротко: ключ для artifacts и кнопки write_artifact, файл — для Read
    artifacts: r.artifacts?.items.map((a) => ({ key: a.key, title: a.title, file: a.file, ...(a.decisions ? { decisions: true } : {}) })),
    continuedFrom: r.continuedFrom,
    source: r.source,
    worktree: r.worktree,
  };
}

/** Что умеет сервер сверх обязательного: от этого зависят инструменты и строки промпта. */
type Caps = { note?: boolean; runFlow?: boolean };
const capsOf = (ctl: ChatControls): Caps => ({ note: Boolean(ctl.note), runFlow: Boolean(ctl.applyRunFlow || ctl.reloadRunFlow || ctl.restartIteration) });

export function chatSystemPrompt(r: RunReport, runDir: string, cwd: string, caps: Caps = {}): string {
  const multi = (r.blocks?.length ?? 0) > 1;
  return `Ты — чат на странице одного запуска agentgraph. Пользователь спрашивает про этот запуск и просит что-то с ним сделать. Всё в разговоре по умолчанию относится к этому запуску.

Как устроен agentgraph. Flow (flow.yaml) — блоки по порядку. Блок — цикл итераций до условия остановки (или один проход). Итерация — этапы по порядку; соседние этапы с одним group (параллельная группа) идут одновременно, следующий за группой этап получает в {{prev}} склейку их выводов. Каждый этап — свежая сессия Claude Code со своим промптом. Вывод этапа уходит в промпты следующих ({{prev}}, {{phases.<этап>}}), а после этапов проверяется условие (команда с кодом 0, судья или маркер в выводе); его замечания попадают в {{feedback}} следующей итерации. Этап может спросить пользователя (вопрос ждёт ответа) или попросить паузу маркером в конце вывода (pauseReason).

Запуск:
- id: ${r.id}
- flow: ${r.flow}${r.description ? ` — ${r.description}` : ''}${r.adhoc ? ' (разовый: файла в flows/ нет)' : ''}
- директория проекта (cwd, здесь же работаешь ты): ${cwd}
- папка запуска: ${runDir}
- задача ({{input}}): ${truncate(r.input ?? '', 1500)}

Файлы папки запуска: run.json (отчёт: статусы блоков, этапы со стоимостью и путями файлов, результаты условий, вопросы), flow.yaml (спецификация, с которой шёл запуск), ${multi ? 'NN-<блок>/' : ''}iter-NN/NN-<этап>.prompt.md (промпт этапа), .transcript.md (ход сессии), .output.md (итоговый вывод), iter-NN/condition.json и condition.command.log или condition.judge.prompt.md (как проверялось условие), artifacts/ (артефакты).

Инструменты запуска:
- run_status — состояние сейчас. Строка [Состояние запуска …] в начале сообщения — снимок на момент отправки; если важны подробности (этапы, замечания условия, вопросы), вызови run_status.
- run_log — хвост живого лога идущего запуска: что агенты делают прямо сейчас.
- pause_run, resume_run, set_max_iterations, answer_question${caps.note ? ', run_note' : ''} — сразу, как кнопки «Пауза», «Возобновить», лимит итераций, ответ на вопрос агента${caps.note ? ', указание этапу' : ''}.
- artifacts — артефакты запуска: список или текст одного; flow_read — flow запуска (снимок, с которым он идёт) и файл в flows/.
- propose_actions — кнопки под ответом для опасного и общего: остановить запуск, записать артефакт, ответить на паузу, сохранить flow в flows/, продолжить с места остановки, запустить заново${caps.runFlow ? ', применить flow к идущему запуску, перезапустить итерацию' : ''}. Действие выполнит сервер, когда пользователь нажмёт кнопку и подтвердит; перед этим он перепроверит состояние запуска.
- show_table, show_links, offer_replies — таблица, ссылки (файлы запуска, артефакты, этапы, пути проекта) и варианты ответа под твоим ответом.
- Read, Grep, Glob — файлы запуска и репозитория; Bash — git status/diff, тесты и т.п.; Edit, Write — правки в директории проекта.

Правила:
1. Отвечай коротко, по делу и на языке пользователя. Называй сущности так же, как в интерфейсе: flow, этап, блок, условие, замечания, задача, запуск, директория проекта, артефакт. Этапы, блоки и итерации называй так, как они в отчёте. Не пересказывай весь отчёт, когда спрашивают об одном.
2. Имена инструментов пользователю не называй: он их не вызывает. Говори, что можешь сделать сам: «могу возобновить запуск», «подниму лимит итераций до 40».
3. Безопасное — пауза, возобновление, лимит итераций, ответ на вопрос агента словами пользователя${caps.note ? ', указание этапу' : ''} — делай сам, когда пользователь об этом попросил. Опасное и общее — остановить запуск, записать артефакт, ответить на паузу, сохранить flow, продолжить или запустить заново${caps.runFlow ? ', поменять flow идущего запуска, перезапустить итерацию' : ''} — сам не делай никогда: предложи кнопку (propose_actions) и одной фразой скажи, что она сделает. Правки файлов проекта и команды, меняющие репозиторий, — только по прямой просьбе. После действия скажи, что сделал и что будет дальше.
4. Инструментами Edit и Write в папку запуска не пиши: run.json, выводы и транскрипты пишут раннер и сервер. Артефакт меняется только кнопкой write_artifact: в том же ответе прочитай его (artifacts) и предложи весь новый текст. Если файл изменится до клика, кнопка устареет.
5. Идущий запуск работает в той же директории проекта. Правка файлов или git-команды посреди этапа столкнутся с ним: предупреди и предложи сначала паузу (текущий этап доработает, следующий не начнётся).
${flowRule(r, caps)}
${pauseRule(r)}
8. На вопрос агента (pendingQuestions) отвечай answer_question, когда пользователь дал ответ: ключ — текст вопроса, значение — label варианта или его текст. Ответ за пользователя не придумывай.
9. Таблицы, списки файлов и выбор из вариантов показывай виджетами (show_table, show_links, offer_replies), а не текстом: они видны под ответом. Их содержимое в тексте не повторяй. Файлы папки запуска давай ссылкой run_file с путём от неё.`;
}

/** Правило 6: flow. Идущий запуск правок flow не видит, файл в flows/ — общий для всех следующих запусков. */
function flowRule(r: RunReport, caps: Caps): string {
  const save = r.adhoc
    ? 'У разового запуска файла в flows/ нет: сохранить его flow можно кнопкой «Сохранить как flow» на странице запуска.'
    : `Правку flow предлагай кнопкой save_flow с полным YAML, прочитав flow_read в том же ответе; name не меняй. Кнопка запишет flows/ — общий файл, правка подействует на все следующие запуски и продолжения flow ${r.flow}; предупреди об этом.`;
  const live = caps.runFlow
    ? ' Идущий запуск на паузе может взять правку кнопкой apply_flow (только в этом запуске) или reload_flow (подхватить файл из flows/).'
    : ' Идущий запуск правок flow не видит.';
  return `6. Flow читай через flow_read.${live} Продолжение и перезапуск берут текущую версию из flows/, а если запуск правили на ходу и последнюю правку в flows/ не сохранили — его снимок. ${save}`;
}

/**
 * Правило 7: как отвечать на паузу по просьбе этапа. У flow с артефактом decisions ответ кнопкой answer_pause:
 * сервер запишет его в артефакт и в отчёт и возобновит запуск. Без decisions — туда, откуда flow его читает.
 */
function pauseRule(r: RunReport): string {
  const decisions = r.artifacts?.items.find((a) => a.decisions);
  if (decisions) {
    return `7. Пауза по просьбе этапа (pauseReason): этап пишет в pauseReason.text, что ему нужно от пользователя. Ответы на такие паузы у этого flow хранятся в артефакте «${decisions.title}» (${decisions.file}) папки запуска. Когда пользователь дал ответ, предложи кнопку answer_pause с этим текстом: по клику ответ запишется в артефакт и в отчёт запуска, и запуск пойдёт дальше. Пользователь может ответить и сам — в поле «Ответ» карточки паузы. Ответ за пользователя не придумывай. resume_run возобновляет без ответа — вызывай его, только если пользователь хочет продолжить без ответа.`;
  }
  return `7. Пауза по просьбе этапа (pauseReason): этап пишет в pauseReason.text, что ему нужно от пользователя. Следующая итерация увидит ответ, только если он лежит там, откуда flow его читает: чаще всего в файле директории проекта, который назвал этап (сверься с промптами в flow.yaml). Когда пользователь ответил, запиши ответ туда (с его согласия) и возобнови запуск (resume_run). Если место ответа — артефакт, предложи кнопку write_artifact. Если записать некуда — так и скажи: просто возобновлённый запуск ответа не передаст.`;
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): ToolText => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): ToolText => ({ content: [{ type: 'text', text: `Не получилось: ${errText(err)}` }], isError: true });
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const act = (fn: () => string) => async (): Promise<ToolText> => {
  try {
    return ok(fn());
  } catch (err) {
    return fail(err);
  }
};
/** Ответ API (артефакты, ответ на паузу) в текст инструмента: не 2xx — отказ с текстом сервера. */
const replyError = (r: ApiReply) => new Error(String(r.body.error ?? `код ${r.status}`));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Файл flow для людей: flows/<папка>/<имя>.yaml, а не абсолютный путь. */
const flowsRel = (file: string) => {
  const rel = path.relative(FLOWS_DIR, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `flows/${rel.split(path.sep).join('/')}` : file;
};

/** Инструмент MCP-сервера: тип элемента tools у createSdkMcpServer — в нём уживаются инструменты с разными схемами. */
export type ChatTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>[number];
type McpConfig = NonNullable<SessionRequest['mcpServers']>[string];

/** Общее у инструментов одного хода: показанные виджеты, что агент прочёл (хэш — база кнопки), эффекты. */
export type ChatTurnSink = {
  widgets: ChatWidget[];
  /** Что агент видел в этом ходе: artifact:<key> — хэш артефакта, flow — хэш файла в flows/. */
  seen: Map<string, string>;
  onWidget?: (w: ChatWidget) => void;
  onEffect?: (e: ChatEffect) => void;
  /** Id кнопки: уникальный на всю историю — клик из устаревшей вкладки не попадёт в чужую кнопку на том же месте. */
  newId: () => string;
};

export const newSink = (o: Partial<ChatTurnSink> = {}): ChatTurnSink => ({ widgets: [], seen: new Map(), newId: () => `a-${randomUUID().slice(0, 13)}`, ...o });

/** Инструменты сервера run: состояние и управление запуском. Меняющие запуск сообщают эффект run — UI обновит список запусков. */
export function runTools(ctl: ChatControls, sink: ChatTurnSink): ChatTool[] {
  const view = () => {
    const v = ctl.view();
    if (!v) throw new Error('Запуск не найден');
    return v;
  };
  const changed = (fn: () => string) => act(() => {
    const text = fn();
    sink.onEffect?.({ kind: 'run' });
    return text;
  });
  const tools: ChatTool[] = [
    tool('run_status', 'Текущее состояние запуска: статус, блоки, текущий шаг и все идущие этапы (running), пауза и её причина, вопросы, ждущие ответа, последние этапы (с путями файлов), результаты условий, артефакты.', {},
      act(() => JSON.stringify(statusReport(view()), null, 2)), { annotations: { readOnlyHint: true } }),
    tool('run_log', 'Хвост живого лога идущего запуска: текст агентов и вызовы инструментов. У завершённого запуска лога нет — читай транскрипты этапов.', { lines: z.number().int().min(1).max(400).optional().describe('сколько последних строк, по умолчанию 80') },
      async ({ lines }) => {
        const log = ctl.logTail(lines ?? 80);
        if (!log) return ok('Запуск не идёт в этом сервере: живого лога нет. Ход этапов — в их .transcript.md (пути в run_status → lastPhases[].files).');
        return ok(log.length ? log.join('\n') : 'Лог пока пуст.');
      }, { annotations: { readOnlyHint: true } }),
    tool('pause_run', 'Мягкая пауза: идущие этапы или проверка условия доработают, следующий шаг не начнётся до resume_run.', {},
      changed(() => { ctl.pause(); return 'Пауза запрошена: текущий шаг доработает, следующий не начнётся.'; })),
    tool('resume_run', 'Возобновить запуск после паузы без ответа: он пойдёт дальше.', {},
      changed(() => { ctl.resume(); return 'Запуск возобновлён: пауза снята.'; })),
    tool('set_max_iterations', 'Поменять лимит итераций блока с циклом у идущего запуска (1–50, не меньше текущей итерации). Подхватится со следующей итерации.',
      { block: z.string().describe('имя блока (blocks[].name из run_status)'), value: z.number().int().min(1).max(50) },
      async ({ block, value }) => changed(() => {
        const b = ctl.setMaxIterations(block, value);
        return `Лимит итераций блока «${b.title}»: ${b.maxIterations}.`;
      })()),
    tool('answer_question', 'Ответить на вопрос агента (pendingQuestions из run_status) словами пользователя. Сессия этапа продолжится с этим ответом.',
      { question_id: z.string(), answers: z.record(z.string(), z.string()).describe('ключ — текст вопроса (questions[].question), значение — label выбранного варианта, несколько через ", " или свой текст') },
      async ({ question_id, answers }) => changed(() => {
        ctl.answer(question_id, answers);
        return 'Ответ отправлен, этап продолжает работу.';
      })()),
    tool('artifacts', 'Артефакты запуска: без key — список (файл, кто менял последним, можно ли править сейчас), с key — текст одного.',
      { key: z.string().optional().describe('ключ артефакта') },
      async ({ key }) => act(() => (key ? artifactText(ctl, key, sink) : artifactList(ctl)))(), { annotations: { readOnlyHint: true } }),
    tool('flow_read', 'Flow запуска: снимок runs/<id>/flow.yaml, с которым он идёт, и текущий файл в flows/ (его перезаписывает save_flow).', {},
      act(() => flowText(ctl, sink)), { annotations: { readOnlyHint: true } }),
  ];
  const note = ctl.note;
  if (note) {
    tools.push(tool('run_note', 'Указание этапам идущего запуска словами пользователя: попадёт в промпт следующего шага (scope next) или всех до конца запуска (run).',
      { text: z.string().min(1).max(4000), scope: z.enum(['next', 'run']).optional().describe('по умолчанию next') },
      async ({ text, scope }) => changed(() => {
        note(text, { scope: scope ?? 'next', via: 'chat' });
        return scope === 'run' ? 'Указание добавлено до конца запуска.' : 'Указание получит следующий шаг.';
      })()));
  }
  return tools;
}

function artifactList(ctl: ChatControls): string {
  const r = ctl.artifacts.list();
  if (r.status !== 200) throw replyError(r);
  const items = (r.body.items ?? []) as ArtifactListItem[];
  if (!items.length) return 'Артефактов нет.';
  return items
    .map((a) => {
      const edit = a.editable ? 'можно править' : `не правится: ${a.message ?? a.reason}`;
      return `- ${a.key} «${a.title}» · ${a.path ?? a.file}${a.missing ? ' (файла нет)' : ''} · ${a.size} байт · последним менял: ${a.author.kind}${a.decisions ? ' · решения' : ''} · ${edit}`;
    })
    .join('\n');
}

function artifactText(ctl: ChatControls, key: string, sink: ChatTurnSink): string {
  const r = ctl.artifacts.read(key);
  if (r.status !== 200) throw replyError(r);
  const a = r.body as ArtifactRead;
  const head = `«${a.title}» (${a.file}) · ${a.path} · ${a.editable ? 'можно править' : `не правится: ${a.message ?? a.reason}`}`;
  if (a.text === null) return `${head}\nТекста нет: ${a.textMessage ?? 'файл слишком большой'}`;
  // обрезанный текст базой кнопки не становится: «весь новый текст» по первым 60 КБ срезал бы хвост
  if (a.text.length > ARTIFACT_TEXT_MAX) return `${head}\n\n${a.text.slice(0, ARTIFACT_TEXT_MAX)}\n…[обрезано: дальше — Read по пути; переписать такой артефакт кнопкой нельзя]`;
  if (a.hash) sink.seen.set(`artifact:${key}`, a.hash);
  return `${head}\n\n${a.text}`;
}

function flowText(ctl: ChatControls, sink: ChatTurnSink): string {
  const f = ctl.readFlow();
  sink.seen.set('flow', f.flows ? sha(f.flows.yaml) : '');
  const out = [`Flow ${f.name}${f.adhoc ? ' (разовый: файла в flows/ нет)' : ''}.`];
  out.push(f.run ? `Снимок запуска ${f.run.file} — по нему идёт этот запуск:\n\`\`\`yaml\n${f.run.yaml}\n\`\`\`` : 'Снимка flow.yaml у запуска нет (старый запуск).');
  if (!f.adhoc) {
    if (!f.flows) out.push('Файла в flows/ нет: его удалили или переименовали.');
    else if (f.run && f.flows.yaml === f.run.yaml) out.push(`Файл ${f.flows.file} совпадает со снимком.`);
    else out.push(`Файл ${f.flows.file} (текущая версия, её возьмут продолжение и перезапуск):\n\`\`\`yaml\n${f.flows.yaml}\n\`\`\``);
  }
  return out.join('\n\n');
}

/**
 * Пауза, при которой предложено действие: другая пауза (или её нет) при клике — кнопка устарела. У паузы пользователя
 * нет pauseReason, поэтому в ключе ещё и сколько прошло итераций и этапов: пауза через две итерации — уже другая.
 */
function pauseKey(v: RunView): string {
  const r = v.report;
  return v.status === 'paused' ? `paused:${r.pauseReason?.at ?? ''}:${r.pauses?.length ?? 0}:${r.iterations}:${r.phases.length}` : '';
}

/** Вход propose_actions: параметры всех видов в одном плоском объекте (короче схема — меньше токенов в каждом ходе). */
export type ActionInput = { kind: ChatActionKind; label: string; key?: string; text?: string; model?: string; max_budget_usd?: number };

/** Виды кнопок, которые сервер умеет сейчас: правка flow идущего запуска — только с её функциями. */
export function actionKinds(ctl: ChatControls): ChatActionKind[] {
  return [
    'abort', 'write_artifact', 'answer_pause', 'save_flow', 'continue', 'rerun',
    ...(ctl.applyRunFlow ? ['apply_flow' as const] : []),
    ...(ctl.reloadRunFlow ? ['reload_flow' as const] : []),
    ...(ctl.restartIteration ? ['restart_iteration' as const] : []),
  ];
}

/**
 * Кнопка из propose_actions: проверка, что действие сейчас имеет смысл, и база — состояние, при котором оно предложено
 * (хэш артефакта или файла flow, пауза). Ошибка — текстом модели, кнопок нет.
 */
export function proposeAction(ctl: ChatControls, it: ActionInput, seen: Map<string, string>, id: string): ChatAction {
  const v = ctl.view();
  if (!v) throw new Error('Запуск не найден');
  const a: ChatAction = { id, kind: it.kind, label: it.label.trim() || it.kind };
  const text = (what: string) => {
    if (!it.text?.trim()) throw new Error(`${it.kind}: нужен text — ${what}`);
    return it.text;
  };
  const yaml = () => {
    const y = text('весь YAML flow');
    try {
      parseFlow(y);
    } catch (err) {
      throw new Error(`${it.kind}: ${errText(err)}`);
    }
    return y;
  };
  const paused = () => {
    if (v.status !== 'paused') throw new Error(`${it.kind}: только когда запуск стоит на паузе — предложи сначала паузу`);
    return pauseKey(v);
  };
  const newRun = () => {
    if (v.live || v.status === 'running') throw new Error(`${it.kind}: запуск ещё идёт`);
    return { ...(it.model ? { model: it.model } : {}), ...(it.max_budget_usd ? { maxBudgetUsd: it.max_budget_usd } : {}) };
  };
  if (!actionKinds(ctl).includes(it.kind)) throw new Error(`${it.kind}: такого действия сервер сейчас не умеет`);
  switch (it.kind) {
    case 'abort':
      if (!v.live) throw new Error('abort: запуск не идёт в этом сервере');
      return a;
    case 'write_artifact': {
      if (!it.key) throw new Error('write_artifact: нужен key — ключ артефакта');
      if (typeof it.text !== 'string') throw new Error('write_artifact: нужен text — весь новый текст артефакта');
      const r = ctl.artifacts.read(it.key);
      if (r.status !== 200) throw new Error(`write_artifact: ${replyError(r).message}`);
      const cur = r.body as ArtifactRead;
      // пишет этап или ждёт ответа — временно: кнопка подождёт; завершённый запуск, CLI, большой файл — нет
      if (!cur.editable && cur.reason !== 'writing' && cur.reason !== 'asking') throw new Error(`write_artifact: ${cur.message ?? 'артефакт сейчас не правится'}`);
      if (!cur.hash) throw new Error(`write_artifact: ${cur.textMessage ?? 'текст артефакта не читается'}`);
      // база — версия, которую агент прочёл в этом ответе: иначе кнопка молча затёрла бы правку, сделанную после его чтения
      const was = seen.get(`artifact:${it.key}`);
      if (!was) throw new Error(`write_artifact: сначала прочитай «${cur.title}» целиком инструментом artifacts в этом ответе`);
      if (was !== cur.hash) throw new Error(`write_artifact: «${cur.title}» изменился после того, как ты его прочёл, — прочитай заново`);
      return { ...a, key: it.key, text: it.text, base: cur.hash, target: `«${cur.title}» (${cur.file})` };
    }
    case 'answer_pause': {
      const answer = text('ответ пользователя').trim();
      if (Buffer.byteLength(answer) > ANSWER_MAX) throw new Error('answer_pause: ответ больше 64 КБ');
      const dec = v.report.artifacts?.items.find((x) => x.decisions);
      if (!dec) throw new Error('answer_pause: во flow нет артефакта решений (decisions): ответ некуда записать');
      if (!v.report.pauseReason) throw new Error('answer_pause: запуск не на паузе по просьбе этапа');
      return { ...a, text: answer, base: paused(), target: `«${dec.title}» (${dec.file})` };
    }
    case 'save_flow': {
      if (v.report.adhoc) throw new Error('save_flow: у разового запуска нет файла в flows/ — его сохраняют кнопкой «Сохранить как flow» на странице запуска');
      const y = yaml();
      const f = ctl.readFlow();
      // по имени из файла flow находят запуски и продолжения: переименование здесь их потеряло бы
      if (parseFlow(y).name !== f.name) throw new Error(`save_flow: name в YAML должно остаться ${f.name}`);
      const cur = f.flows ? sha(f.flows.yaml) : '';
      const was = seen.get('flow');
      if (was === undefined) throw new Error('save_flow: сначала прочитай flow инструментом flow_read в этом ответе');
      if (was !== cur) throw new Error('save_flow: файл flow изменился после flow_read — прочитай заново');
      return { ...a, text: y, base: cur, target: f.flows ? flowsRel(f.flows.file) : `flows/${f.name}.yaml` };
    }
    case 'continue':
      if (v.status === 'done') throw new Error('continue: запуск завершён успешно — продолжать нечего, предложи rerun');
      return { ...a, ...newRun() };
    case 'rerun':
      return { ...a, ...newRun() };
    case 'apply_flow':
      return { ...a, text: yaml(), base: paused() };
    case 'reload_flow':
      if (v.report.adhoc) throw new Error('reload_flow: у разового запуска нет файла в flows/');
      return { ...a, base: paused() };
    case 'restart_iteration':
      return { ...a, base: paused(), ...(it.text?.trim() ? { text: it.text.trim() } : {}) };
  }
}

/** Ссылка show_links: путь файла запуска — от папки запуска (абсолютный внутри неё укорачивается), выход из неё — ошибка. */
export function normalizeLink(l: ChatLink, runDir: string): ChatLink {
  const out: ChatLink = { kind: l.kind, ref: l.ref.trim(), ...(l.block ? { block: l.block } : {}), ...(l.label?.trim() ? { label: l.label.trim() } : {}) };
  if (l.kind !== 'run_file') return out;
  const abs = path.resolve(runDir, out.ref);
  const rel = path.relative(runDir, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`run_file ${l.ref}: путь не в папке запуска — для файлов проекта kind path`);
  return { ...out, ref: rel.split(path.sep).join('/') };
}

/** Инструменты сервера ui: только данные виджетов, проверенные схемой; рисует их UI. */
export function uiTools(ctl: ChatControls, sink: ChatTurnSink, runDir: string): ChatTool[] {
  const show = (w: ChatWidget, text: string): ToolText => {
    sink.widgets.push(w);
    sink.onWidget?.(w);
    return ok(text);
  };
  const title = z.string().max(200).optional();
  const kinds = actionKinds(ctl);
  const live = [
    ...(ctl.applyRunFlow ? ['apply_flow — применить YAML text к этому запуску на паузе'] : []),
    ...(ctl.reloadRunFlow ? ['reload_flow — подхватить файл из flows/ в этот запуск на паузе'] : []),
    ...(ctl.restartIteration ? ['restart_iteration — перезапустить текущую итерацию на паузе (text — указание этапу)'] : []),
  ];
  return [
    tool('show_table', 'Таблица под ответом. Ячейки — короткий markdown: `код`, **жирный**, пути.',
      { title, columns: z.array(z.string().max(200)).min(1).max(12), rows: z.array(z.array(z.string().max(2000)).max(12)).min(1).max(200) },
      async ({ title, columns, rows }) => show(
        { type: 'table', ...(title ? { title } : {}), columns, rows: rows.map((row) => columns.map((_, i) => row[i] ?? '')) },
        `Таблица показана: ${rows.length} строк.`,
      )),
    tool('show_links', 'Ссылки под ответом. kind: run_file — файл папки запуска (ref — путь от неё), artifact — артефакт (ref — ключ), phase — карточка этапа в «Обзоре» (ref — имя этапа, block — блок), path — файл или папка проекта.',
      {
        title,
        items: z.array(z.object({
          kind: z.enum(['run_file', 'artifact', 'phase', 'path']),
          ref: z.string().min(1).max(1000),
          block: z.string().max(200).optional(),
          label: z.string().max(200).optional(),
        })).min(1).max(50),
      },
      async ({ title, items }) => {
        try {
          return show({ type: 'links', ...(title ? { title } : {}), items: items.map((l) => normalizeLink(l, runDir)) }, `Ссылки показаны: ${items.length}.`);
        } catch (err) {
          return fail(err);
        }
      }),
    tool('propose_actions', `Кнопки под ответом для действий, которые сам не делаешь: выполнятся, когда пользователь нажмёт и подтвердит, один раз. kind: abort — остановить запуск; write_artifact — записать артефакт key целиком текстом text; answer_pause — ответить на паузу этапа текстом text и возобновить; save_flow — записать YAML text в flows/ (общий файл); continue — продолжить с места остановки новым запуском; rerun — запустить flow заново с той же задачей${live.length ? `; ${live.join('; ')}` : ''}. model, max_budget_usd — для continue и rerun.`,
      {
        title,
        items: z.array(z.object({
          kind: z.enum(kinds as [ChatActionKind, ...ChatActionKind[]]),
          label: z.string().min(1).max(80).describe('текст кнопки'),
          key: z.string().optional(),
          text: z.string().max(200_000).optional(),
          model: z.string().max(100).optional(),
          max_budget_usd: z.number().positive().max(1000).optional(),
        })).min(1).max(6),
      },
      async ({ title, items }) => {
        let actions: ChatAction[];
        try {
          // все или ничего: половина кнопок запутает сильнее, чем ошибка, которую модель исправит
          actions = items.map((it) => proposeAction(ctl, it, sink.seen, sink.newId()));
        } catch (err) {
          return fail(err);
        }
        return show({ type: 'actions', ...(title ? { title } : {}), items: actions }, `Кнопки показаны: ${actions.map((x) => `«${x.label}»`).join(', ')}. Сработают после клика пользователя.`);
      }),
    tool('offer_replies', 'Варианты ответа чипами под ответом: клик отправит текст от имени пользователя.',
      { items: z.array(z.string().min(1).max(120)).min(1).max(6) },
      async ({ items }) => show({ type: 'replies', items }, 'Варианты показаны.')),
  ];
}

// ---------- клик по кнопке: POST /api/runs/:id/chat/action

type Outcome = { state: NonNullable<ChatAction['state']>; result: string; openRun?: string; effects: ChatEffect[] };
const done = (result: string, effects: ChatEffect[], openRun?: string): Outcome => ({ state: 'done', result, effects, ...(openRun ? { openRun } : {}) });
const expired = (result: string): Outcome => ({ state: 'expired', result, effects: [] });
const failed = (result: string): Outcome => ({ state: 'failed', result, effects: [] });
/**
 * Ошибка функции сервера: 409 — состояние уже не то (кнопка устарела; кроме adhoc — у разового запуска так нельзя вообще),
 * остальное — не вышло; problems — почему flow не подходит.
 */
function thrown(err: unknown): Outcome {
  const e = err as { status?: number; code?: unknown; problems?: unknown };
  const problems = Array.isArray(e.problems) && e.problems.length ? `: ${e.problems.map(String).join('; ')}` : '';
  return e.status === 409 && e.code !== 'adhoc' ? expired(errText(err)) : failed(errText(err) + problems);
}

/**
 * Выполнить действие кнопки. Сначала сверка: то ли состояние, при котором оно предложено. Всё синхронно — между
 * проверкой и записью итога в chat.json второй клик не вклинится. { keep } вместо итога — отказ, который
 * кнопку не тратит (423: артефакт пишет этап — нажмут ещё раз после шага).
 */
function execute(ctl: ChatControls, a: ChatAction, opts: { saveToFlows?: boolean }): Outcome | { keep: ApiReply } {
  const v = ctl.view();
  if (!v) return failed('Запуск не найден');
  const api = (r: ApiReply, ok: () => Outcome): Outcome | { keep: ApiReply } => {
    if (r.status === 200) return ok();
    if (r.status === 423) return { keep: r };
    return r.status === 409 ? expired(replyError(r).message) : failed(replyError(r).message);
  };
  const samePause = () => pauseKey(v) === a.base;
  try {
    switch (a.kind) {
      case 'abort':
        if (!v.live) return expired('Запуск уже не идёт');
        ctl.abort();
        return done('Запуск останавливается.', [{ kind: 'run' }]);
      case 'write_artifact': {
        const r = ctl.artifacts.write(a.key ?? '', a.text ?? '', a.base ?? '');
        // этапы идущего шага, уже прочитавшие прежнюю версию, правку не увидят — как предупреждает и панель артефактов
        const readers = Array.isArray(r.body.readers) && r.body.readers.length ? ` Прежнюю версию уже прочли этапы ${r.body.readers.join(', ')}: они правку не увидят.` : '';
        return api(r, () => done(`Записан артефакт ${a.target ?? a.key}.${readers}`, [{ kind: 'artifacts' }]));
      }
      case 'answer_pause':
        if (!samePause() || !v.report.pauseReason) return expired('Запуск уже не на той паузе: ответ не записан');
        return api(ctl.answerPause(a.text ?? ''), () => done(`Ответ записан в ${a.target ?? 'артефакт решений'}, запуск возобновлён.`, [{ kind: 'artifacts' }, { kind: 'run' }]));
      case 'save_flow': {
        const f = ctl.readFlow();
        if ((f.flows ? sha(f.flows.yaml) : '') !== a.base) return expired(`Файл flow изменился после предложения: ничего не записано`);
        const { file } = ctl.saveFlow(a.text ?? '');
        return done(`Flow сохранён в ${flowsRel(file)}.`, [{ kind: 'flow' }]);
      }
      case 'continue':
      case 'rerun': {
        if (v.live || v.status === 'running') return expired('Запуск снова идёт');
        const o = { ...(a.model ? { model: a.model } : {}), ...(a.maxBudgetUsd ? { maxBudgetUsd: a.maxBudgetUsd } : {}) };
        const id = a.kind === 'continue' ? ctl.continueRun(o).id : ctl.rerun(o).id;
        return done(`Начат запуск ${id}.`, [{ kind: 'run', runId: id }], id);
      }
      case 'apply_flow':
        if (!ctl.applyRunFlow) return failed('Сервер не умеет менять flow идущего запуска');
        if (!samePause()) return expired('Запуск уже не на той паузе: flow не применён');
        ctl.applyRunFlow(a.text ?? '', { saveToFlows: opts.saveToFlows === true, via: 'chat' });
        return done(opts.saveToFlows ? 'Flow применён к запуску и сохранён в flows/.' : 'Flow применён к этому запуску.', [{ kind: 'flow' }, { kind: 'artifacts' }]);
      case 'reload_flow':
        if (!ctl.reloadRunFlow) return failed('Сервер не умеет менять flow идущего запуска');
        if (!samePause()) return expired('Запуск уже не на той паузе: flow не перечитан');
        ctl.reloadRunFlow({ via: 'chat' });
        return done('Запуск взял flow из flows/.', [{ kind: 'flow' }, { kind: 'artifacts' }]);
      case 'restart_iteration': {
        if (!ctl.restartIteration) return failed('Сервер не умеет перезапускать итерацию');
        if (!samePause()) return expired('Запуск уже не на той паузе: итерация не перезапущена');
        const r = ctl.restartIteration({ ...(a.text ? { note: a.text } : {}), via: 'chat' });
        return done(`Итерация ${r.iteration} блока ${r.block} начнётся заново, когда запуск возобновят: он пока на паузе.`, [{ kind: 'run' }, { kind: 'artifacts' }]);
      }
    }
  } catch (err) {
    return thrown(err);
  }
  return failed(`Неизвестное действие ${String(a.kind)}`);
}

export type ChatActionResult = ApiReply & { action?: ChatAction; chat?: ChatLog; effects?: ChatEffect[] };

/**
 * Клик по кнопке: { msgIndex, actionId, saveToFlows? }. Пока идёт ход чата — 409 busy: ход в конце перезапишет chat.json.
 * Действие одноразовое: итог (done | failed | expired) пишется в историю, второй клик — 409 used.
 */
export function chatAction(o: { runDir: string; controls: ChatControls; busy: boolean; body: Record<string, unknown>; now?: () => string }): ChatActionResult {
  if (o.busy) return { status: 409, body: { error: 'Агент ещё отвечает: дождись ответа или прерви его', code: 'busy' } };
  const chat = readChat(o.runDir);
  const msg: ChatMessage | undefined = typeof o.body.msgIndex === 'number' ? chat.messages[o.body.msgIndex] : undefined;
  const action = msg?.widgets?.flatMap((w) => (w.type === 'actions' ? w.items : [])).find((x) => x.id === o.body.actionId);
  if (!msg || msg.role !== 'assistant' || !action) return { status: 404, body: { error: 'Действие не найдено: история чата изменилась', code: 'not_found' } };
  if (action.state) return { status: 409, body: { error: action.state === 'done' ? 'Действие уже выполнено' : 'Это действие уже нажимали', code: 'used', action }, chat };
  const r = execute(o.controls, action, { saveToFlows: o.body.saveToFlows === true });
  if ('keep' in r) return { status: r.keep.status, body: { ...r.keep.body, action } };
  const at = (o.now ?? (() => new Date().toISOString()))();
  Object.assign(action, { state: r.state, result: r.result, at, ...(r.openRun ? { openRun: r.openRun } : {}) });
  // продолжение и перезапуск — альтернативы: после одного нового запуска остальные такие кнопки чата устаревают,
  // иначе второй клик позже запустил бы второй запуск в той же директории
  if (r.openRun) {
    for (const x of chat.messages.flatMap((m) => m.widgets ?? []).flatMap((w) => (w.type === 'actions' ? w.items : []))) {
      if (!x.state && (x.kind === 'continue' || x.kind === 'rerun')) Object.assign(x, { state: 'expired', result: `Уже начат запуск ${r.openRun}`, at });
    }
  }
  saveChat(o.runDir, chat);
  return { status: 200, body: { action }, action, chat, effects: r.effects };
}

// ---------- трасса хода

/** Путь для подписи шага: файл запуска — от папки запуска (и открывается в окне файла), проекта — от cwd, остальное — с ~. */
function fileRef(file: string, ctx: { runDir: string; cwd: string }): Pick<ChatStep, 'target' | 'runFile' | 'path'> {
  const abs = path.resolve(ctx.cwd, file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
  const inRun = path.relative(ctx.runDir, abs);
  if (inRun && !inRun.startsWith('..') && !path.isAbsolute(inRun)) {
    const rel = inRun.split(path.sep).join('/');
    return { target: rel, runFile: rel };
  }
  const inCwd = path.relative(ctx.cwd, abs);
  const shown = inCwd && !inCwd.startsWith('..') && !path.isAbsolute(inCwd) ? inCwd : abs.startsWith(os.homedir() + path.sep) ? `~${abs.slice(os.homedir().length)}` : abs;
  return { target: shown, path: abs };
}

const clip = (s: unknown, max: number) => (typeof s === 'string' && s.trim() ? truncate(s, max) : undefined);

/** Шаг трассы из вызова инструмента: имя и главный аргумент коротко — подпись по ним строит UI. */
export function chatStep(name: string, input: Record<string, unknown>, ctx: { runDir: string; cwd: string }, sub = false): ChatStep {
  const step: ChatStep = { tool: name, ...(sub ? { sub: true as const } : {}) };
  const file = input.file_path ?? input.notebook_path;
  let target: string | undefined;
  if (typeof file === 'string' && file) Object.assign(step, fileRef(file, ctx));
  else if (name === 'Grep') target = [clip(input.pattern, 80), typeof input.path === 'string' ? fileRef(input.path, ctx).target : undefined].filter(Boolean).join(' · ');
  else if (name === 'Glob') target = clip(input.pattern, 120);
  else if (name === 'Bash') target = clip(String(input.command ?? '').split('\n')[0], 160);
  else if (name === 'Skill') target = clip(input.skill, 80);
  else if (name === `mcp__${SERVER}__set_max_iterations`) target = `${String(input.block)} → ${String(input.value)}`;
  else if (name === `mcp__${SERVER}__artifacts`) target = clip(input.key, 80);
  else if (name === `mcp__${SERVER}__run_note`) target = clip(input.text, 120);
  if (target) step.target = target;
  return step;
}

export type ChatTurnOptions = {
  runDir: string;
  /** Рабочая директория запуска; если её нет на диске — папка запуска. */
  cwd?: string;
  message: string;
  model?: string;
  controls: ChatControls;
  abort?: AbortController;
  /** Шаг хода: новый (index — следующий по счёту) или тот же с ошибкой инструмента. */
  onStep?: (index: number, step: ChatStep) => void;
  /** Текст агента по ходу ответа: последний блок главного агента. */
  onText?: (text: string) => void;
  onWidget?: (w: ChatWidget) => void;
  /** Ход что-то поменял: UI перечитает артефакты, flow или список запусков. */
  onEffect?: (e: ChatEffect) => void;
  /** Сообщение пользователя записано в историю: можно показывать. */
  onSaved?: (chat: ChatLog) => void;
};

/** Зависимости хода: сессия и сборка MCP-сервера. Тест подменяет обе — сервер отдаёт ему определения, чтобы звать обработчики. */
export type ChatDeps = {
  runSession: (req: SessionRequest, log: LogFn) => Promise<SessionResult>;
  mcpServer: (name: string, tools: ChatTool[]) => McpConfig;
};
const DEPS: ChatDeps = { runSession: (req, log) => runSession(req, log), mcpServer: (name, tools) => createSdkMcpServer({ name, tools }) };

/** Один ход чата: сообщение в историю, сессия (продолжение прошлой, если можно), ответ со шагами и виджетами в историю. */
export async function chatTurn(o: ChatTurnOptions, deps: ChatDeps = DEPS): Promise<ChatLog> {
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
  const sink = newSink({ onWidget: o.onWidget, onEffect: o.onEffect });
  const ctx = { runDir: o.runDir, cwd };
  const steps: ChatStep[] = [];
  const stepOf = new Map<string, number>();
  const onEvent = (e: SessionEvent) => {
    if (e.kind === 'tool_use') {
      // виджеты видны сами, в трассе они — шум
      if (e.name.startsWith(`mcp__${UI}__`) || steps.length >= STEPS_MAX) return;
      const step = chatStep(e.name, e.input, ctx, Boolean(e.parent));
      const i = steps.push(step) - 1;
      stepOf.set(e.id, i);
      o.onStep?.(i, step);
    } else if (e.kind === 'tool_result' && e.isError) {
      const i = stepOf.get(e.toolUseId);
      if (i === undefined) return;
      steps[i] = { ...steps[i]!, error: truncate(e.text.replace(/<\/?tool_use_error>/g, ''), 200) || 'ошибка' };
      o.onStep?.(i, steps[i]!);
    } else if (e.kind === 'text' && !e.parent && e.text.trim()) {
      o.onText?.(truncate(e.text, 600));
    }
  };
  const mcpServers = { [SERVER]: deps.mcpServer(SERVER, runTools(o.controls, sink)), [UI]: deps.mcpServer(UI, uiTools(o.controls, sink, o.runDir)) };
  const inside = realpath(o.runDir).startsWith(realpath(cwd) + path.sep) || realpath(o.runDir) === realpath(cwd);
  const ask = (resumeId: string | undefined) =>
    deps.runSession({
      prompt: `${statusLine(v)}\n\n${message}`,
      cwd,
      additionalDirectories: inside ? undefined : [o.runDir],
      system: chatSystemPrompt(v.report, o.runDir, cwd, capsOf(o.controls)),
      tools: CHAT_TOOLS,
      implicitTools: CHAT_IMPLICIT,
      allow: chatAllowed(o.controls),
      mcpServers,
      guard: runDirGuard(o.runDir),
      model: o.model,
      maxTurns: 40,
      persist: true,
      resume: resumeId,
      abort: o.abort,
      onEvent,
    }, () => {});

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
  const answered = r.ok && (r.text.trim() || sink.widgets.length);
  chat.messages.push({
    role: 'assistant',
    text: answered ? r.text.trim() : aborted ? 'Прервано.' : `Ошибка: ${r.errors.join('; ') || r.subtype}`,
    at: now(),
    costUsd: cost,
    ...(r.ok ? {} : { error: true }),
    ...(steps.length ? { steps } : {}),
    ...(sink.widgets.length ? { widgets: sink.widgets } : {}),
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
    return inside ? 'В папку запуска писать нельзя: её файлы пишут раннер и сервер. Артефакт меняется кнопкой write_artifact (propose_actions), правки — только в директории проекта.' : undefined;
  };
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isDir(p: string): boolean {
  return Boolean(fs.statSync(p, { throwIfNoEntry: false })?.isDirectory());
}
