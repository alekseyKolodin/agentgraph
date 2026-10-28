// ИИ над flow по HTTP: ответы POST /api/flows/generate и /api/flows/:name/edit (разбор запроса — в server.ts).
// Без Accept: application/x-ndjson ответ — одно JSON-тело, как всегда: на нём работают скилл /agentgraph и CLI.
// С ним — поток FlowAiStreamEvent: модель, повторы запроса к API, шаг правки, строки хода и в конце то же тело.
import fs from 'node:fs';
import type http from 'node:http';
import type { FlowAiStage, FlowAiStreamEvent } from './api-types.js';
import { runSession, truncate, type LogFn, type SessionEvent } from './agent.js';
import { generateFlow } from './generate.js';
import { editFlow, type EditBase } from './edit.js';
import { flowFileName, flowToYaml, summarize } from './flows.js';

export const NDJSON = 'application/x-ndjson';

/** Ответ маршрута: код и тело — те же, что без потока; model и durationMs уходят только в done потока. */
export type FlowAiReply = { status: number; body: Record<string, unknown>; model?: string; durationMs: number };

/** Ход сессии для маршрута: в поток или никуда; abort — соединение закрыто или сервер останавливается. */
export type FlowAiHooks = {
  abort: AbortController;
  log: LogFn;
  onEvent: (e: SessionEvent) => void;
  onModel: (model: string) => void;
  onStage: (stage: FlowAiStage) => void;
};

/** Подмена сессии в тестах. */
export type FlowAiDeps = { session?: typeof runSession };

const LINE_MAX = 400;

export const wantsStream = (req: http.IncomingMessage): boolean => (req.headers.accept ?? '').includes(NDJSON);

/**
 * Ответ ИИ-маршрута. Сессия живёт, пока живо соединение: закрыли вкладку или прервали запрос — abort, траты кончаются.
 * Контроллер лежит в active, пока идёт work: stopServer прерывает и такие. Без потока ошибка уходит наверх
 * (обработчик запроса ответит 500 { error }, как раньше), в потоке — событием error.
 */
export async function respondFlowAi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  active: Set<AbortController>,
  work: (hooks: FlowAiHooks) => Promise<FlowAiReply>,
): Promise<void> {
  const abort = new AbortController();
  active.add(abort);
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });
  // клиент ушёл ещё во время чтения тела: close уже прошёл, слушатель его не услышит
  if (res.destroyed || req.socket.destroyed) abort.abort();
  const stream = wantsStream(req);
  const send = (e: FlowAiStreamEvent) => {
    if (stream && !res.writableEnded) res.write(JSON.stringify(e) + '\n');
  };
  const hooks: FlowAiHooks = {
    abort,
    log: (line) => send({ type: 'log', line: truncate(line, LINE_MAX) }),
    onEvent: (e) => {
      if (e.kind === 'retry') send({ type: 'progress', retry: { attempt: e.attempt, maxRetries: e.maxRetries, delayMs: e.delayMs } });
    },
    onModel: (model) => send({ type: 'progress', model }),
    onStage: (stage) => send({ type: 'progress', stage }),
  };
  try {
    if (!stream) {
      const r = await work(hooks);
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(200, { 'Content-Type': `${NDJSON}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    try {
      const r = await work(hooks);
      send({ type: 'done', body: { ...r.body, model: r.model, durationMs: r.durationMs } });
    } catch (err) {
      send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    }
    res.end();
  } finally {
    active.delete(abort);
  }
}

export type GenerateRequest = { cwd: string; model?: string; folder: string; save: boolean };

/** Генерация: save — flow записан в flows/ (201), иначе черновик разового запуска со spec, в flows/ ничего не пишется. */
export async function generateReply(task: string, req: GenerateRequest, hooks: FlowAiHooks, deps: FlowAiDeps = {}): Promise<FlowAiReply> {
  hooks.onStage({ kind: 'generate' });
  const { spec, result, model, durationMs } = await generateFlow(task, {
    cwd: req.cwd,
    model: req.model,
    abort: hooks.abort,
    log: hooks.log,
    onEvent: hooks.onEvent,
    onModel: hooks.onModel,
    ...(deps.session ? { deps: { session: deps.session } } : {}),
  });
  if (!req.save) {
    return { status: 200, body: { name: spec.name, spec, yaml: flowToYaml(spec), summary: summarize(spec.name, '', spec), costUsd: result.costUsd }, model, durationMs };
  }
  const { name, file } = flowFileName(spec.name, req.folder);
  spec.name = name;
  fs.writeFileSync(file, flowToYaml(spec));
  return { status: 201, body: { name, yaml: flowToYaml(spec), summary: summarize(name, file, spec), costUsd: result.costUsd }, model, durationMs };
}

/** Правка: в файл не пишет, результат уходит в конструктор несохранённым. */
export async function editReply(
  name: string,
  instruction: string,
  base: EditBase,
  req: { cwd: string; model?: string },
  hooks: FlowAiHooks,
  deps: FlowAiDeps = {},
): Promise<FlowAiReply> {
  const r = await editFlow(name, instruction, base, {
    cwd: req.cwd,
    model: req.model,
    abort: hooks.abort,
    log: hooks.log,
    onEvent: hooks.onEvent,
    onModel: hooks.onModel,
    onStage: hooks.onStage,
    ...(deps.session ? { deps: { session: deps.session } } : {}),
  });
  return { status: 200, body: { name, spec: r.spec, summary: r.summary, changed: r.changed, costUsd: r.costUsd }, model: r.model, durationMs: r.durationMs };
}
