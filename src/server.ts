// Локальный HTTP-сервер для UI: флоу (CRUD + генерация), запуски (старт, SSE-события, файлы), главная (вопросы и идущие запуски).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FLOWS_DIR, RUNS_DIR, WEB_DIST_DIR } from './paths.js';
import {
  assertFlowName,
  blankFlowYaml,
  deleteFlow,
  flowExists,
  flowFolder,
  flowToYaml,
  listFlows,
  loadFlow,
  moveFlow,
  parseFlow,
  readFlowYaml,
  resolveFlowFile,
  saveFlowSpec,
  saveFlowYaml,
  summarize,
} from './flows.js';
import { flowBlocks, IMPLICIT_TOOLS, KNOWN_TOOLS, type FlowSpec } from './schema.js';
import { truncate, type AskAnswers } from './agent.js';
import { editBase } from './edit.js';
import { editReply, generateReply, respondFlowAi } from './flow-ai.js';
import { blockMaxIterations, canContinue, continuationFrom, finalPhases, makeRunDir, resolveDirList, runFlow, setBlockMaxIterations, type BlockReport, type Continuation, type PauseReason, type RunWorktree, type QuestionRecord, type RunControl, type RunEvent, type RunReport } from './runner.js';
import { chatTurn, clearChat, readChat, type ChatControls, type ChatLog, type RunView } from './chat.js';
import { osNotify } from './notify.js';
import { pickRunTitle } from './run-title.js';
import { writeDigest } from './run-digest.js';
import { mergeFeed, reportFeed, type FeedItem } from './feed.js';
import { STATUS_LABEL } from './reporters.js';
import { integrationsRoute, runLinks } from './integrations.js';
import { getLimits } from './limits.js';
import { ContextError, getContext, readContextFile, writeContextFile } from './context.js';
import type { ContextFile, ContextFileSaved, ContextView } from './api-types.js';
import { getConnectors } from './connectors.js';
import { canPickDir, pickDir } from './pickdir.js';
import { canReveal, resolveReveal, reveal } from './reveal.js';
import type { RunSource } from './intake.js';
import type { ConfigResponse, ConnectorsView, FeedResponse, FlowListItem, HomeEvent as HomeEventOf, HomeResponse, HomeRun, RecentDir, RunningPhase, RunStarted, RunSummary, RunDetail, RunStreamEvent, ChatPayload, ChatStreamEvent } from './api-types.js';
import { attachmentContentType, copyAttachments, saveAttachments, validateAttachments, type Attachment } from './attachments.js';
import { hideRecentDir, recentDirProblem, recentDirs } from './projects.js';
import { loadSettings, updateSettings, type Settings } from './settings.js';
import { requestProblem } from './server-guard.js';
import { legacyRedirect, resolveWebFile } from './web-static.js';
import { ARTIFACTS_DIR, isInside, type ArtifactLite, type StepDelta } from './artifacts.js';
import { ArtifactStore } from './artifact-store.js';
import { answerPause, homePauseFields, listArtifacts, readArtifact, writeArtifact, type ApiReply, type ArtifactRun } from './artifact-api.js';
import { draftSpec, readRunFlow, RUN_ID_RE, runFlowView, runSpec, saveRunFlow, specFromRunBody } from './adhoc.js';
import { RunFixError, withFlowInput } from './run-fix.js';
import type { RunFix, RunFixVia, RunFlowEdit, RunNote } from './runner.js';
import {
  addTagAttachmentReply,
  createTag,
  createTagReply,
  deleteTagAttachmentReply,
  deleteTagReply,
  readTag,
  resolveKnowledge,
  runTagSlugs,
  splitRunTags,
  stripTagBlocks,
  tagReply,
  tagsListReply,
  tagsRunDirs,
  updateTagReply,
  withTagsInput,
  type Tag,
} from './tags.js';
import { pickAutoTag, type AutoTagReport } from './auto-tag.js';
import { analyzeRun, readAnalysis, type RunAnalysis } from './run-analysis.js';

export type ServerOptions = {
  port: number;
  host: string;
  defaultCwd: string;
  /** Системные уведомления о вопросах и конце запуска, когда UI их сам не покажет. По умолчанию включены. */
  notify?: boolean;
};

type Pending = { resolve: (a: AskAnswers) => void; reject: (e: Error) => void };

type LiveRun = {
  id: string;
  /** События для переигрывания новому подключению, уже в формате SSE. По не-log событиям клиент восстанавливает состояние, их храним все. */
  events: string[];
  /** Хвост лога (не больше LOG_REPLAY_MAX строк): весь лог этапа лежит в его транскрипте. */
  logs: string[];
  clients: Set<http.ServerResponse>;
  abort: AbortController;
  report: RunReport | null;
  /** Вопросы агентов, ждущие ответа пользователя. */
  pending: Map<string, Pending>;
  /** Пауза: requested — текущий шаг доигрывает, paused — раннер стоит в checkpoint. */
  pause: 'requested' | 'paused' | null;
  /** Отпускает раннер, стоящий на паузе. */
  release: (() => void) | null;
  /** Идущий шаг для главной: этап или проверка условия; между шагами null. У группы — первый ещё идущий участник. */
  current: { block: string; iteration: number; title: string } | null;
  /** Все идущие этапы: у параллельной группы их несколько. */
  running: RunningPhase[];
  broadcast: (e: RunEvent) => void;
  /** Хранилище артефактов (только у flow с артефактами): через него API правит артефакты идущего запуска. */
  artifacts?: ArtifactStore;
  /**
   * Событие artifacts — снимок, а не лента: в events оно не копится. Для переигрывания — последний список
   * и итог каждого шага (последний по ключу шага: находки prepareStep заменяют итог того же шага).
   */
  artifactItems: ArtifactLite[] | null;
  artifactSteps: Map<string, StepDelta>;
  /**
   * Последний снимок контекста каждого идущего этапа (phase_context): ключ — этап (contextKey), значение — готовая
   * SSE-строка. По событию на каждый запрос к модели в ленту не копим: переигрывание получает только последний.
   */
  contexts: Map<string, string>;
  /** Указания, ждущие шага: раннер забирает их control.takeNotes(); next уходят одному шагу, run остаются до конца. */
  notes: RunNote[];
  /** Правка запуска на паузе (runner.ts RunFix): flow и повтор итерации. Раннер отдаёт её до первой контрольной точки. */
  fix?: RunFix;
};

/** Событие общего потока /api/events (тип — в src/api-types.ts, общий с UI). */
type HomeEvent = HomeEventOf<RunEvent['type']>;

/** Идущий ход чата запуска: один на запуск. Живёт на сервере: закрыли вкладку или ушли на другой запуск — ответ всё равно ляжет в историю. */
type ChatTurnState = { abort: AbortController; lines: string[]; clients: Set<http.ServerResponse> };

const live = new Map<string, LiveRun>();
const chats = new Map<string, ChatTurnState>();
/** Идущие генерации и правки flow ИИ: живут, пока живо соединение; stopServer прерывает их. */
const generations = new Set<AbortController>();
/** Идущие анализы flow (POST /api/runs/:id/analysis): один на запуск, второй одновременно — 409 busy. */
const analyses = new Set<string>();
/** Подписчики общего потока: главная, счётчик вопросов, уведомления. Значение — вкладка сама показывает уведомления браузера. */
const homeClients = new Map<http.ServerResponse, boolean>();
const LOG_REPLAY_MAX = 3000;
const CHAT_ACTIVITY_MAX = 200;

/** Ошибка с HTTP-кодом: функции управления запуском бросают её, а отвечает обработчик запроса. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Ошибки страницы «Контекст» с кодом (нет flow, этапа, файла вне листинга…) — в ответ с тем же кодом. */
const contextHttp = (err: unknown) => (err instanceof ContextError ? new HttpError(err.status, err.message) : err);

/** Поднятые startServer серверы: их закрывает stopServer. */
const servers = new Set<http.Server>();

export function startServer(opts: ServerOptions): Promise<string> {
  const server = http.createServer((req, res) => {
    handle(req, res, opts).catch((err) => {
      if (!res.headersSent) sendJson(res, err instanceof HttpError ? err.status : 500, { error: errMsg(err) });
      else res.end();
    });
  });
  servers.add(server);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port, opts.host, () => resolve(`http://${opts.host}:${opts.port}`));
  });
}

/**
 * Остановка перед выходом процесса (десктоп, src/desktop/main.ts): идущие запуски останавливаются как кнопкой «Стоп»
 * (агенты гасятся, run.json получает итог aborted), ходы чата обрываются, серверы закрываются вместе с SSE.
 * Ждёт конца запусков и ходов не дольше timeoutMs: завис — процесс всё равно выходит.
 */
export async function stopServer(timeoutMs = 10_000): Promise<void> {
  for (const id of live.keys()) abortRun(id);
  for (const turn of chats.values()) turn.abort.abort();
  for (const abort of generations) abort.abort();
  const deadline = Date.now() + timeoutMs;
  while ((live.size || chats.size || generations.size) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  servers.clear();
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: ServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method ?? 'GET';
  let m: RegExpMatchArray | null;

  // чужая страница в браузере: имя хоста (DNS rebinding), Origin и тип тела (CSRF) — до любого маршрута, включая статику
  const bad = requestProblem(method, req.headers);
  if (bad) return sendJson(res, bad.status, { error: bad.error });

  // --- конфиг
  if (method === 'GET' && p === '/api/config') {
    return sendJson(res, 200, {
      defaultCwd: opts.defaultCwd,
      home: os.homedir(),
      flowsDir: FLOWS_DIR,
      runsDir: RUNS_DIR,
      tools: KNOWN_TOOLS,
      implicitTools: IMPLICIT_TOOLS,
      // UI новее сервера (фронт отдаётся с диска без перезапуска) прячет то, чего сервер ещё не умеет
      features: ['home', 'run-manage', 'integrations', 'run-chat', 'feed', 'limits', 'context', 'attachments', 'run-add-dirs', 'recent-dirs', 'attention', 'artifacts', 'adhoc-runs', 'run-flow', 'tags', 'tag-kinds', 'recent-dirs-hide', 'auto-tag', 'run-title', 'connectors', 'run-analysis', ...(canPickDir ? ['pick-dir'] : []), ...(canReveal ? ['reveal'] : [])],
    } satisfies ConfigResponse);
  }

  // --- системный диалог выбора папки: { path: null } — пользователь отменил
  if (method === 'POST' && p === '/api/pick-dir') {
    const body = (await readJson(req)) as { prompt?: string; start?: string };
    try {
      return sendJson(res, 200, { path: await pickDir({ prompt: body.prompt, start: body.start }) });
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw new HttpError(code === 'busy' ? 409 : code === 'unsupported' ? 501 : 500, errMsg(err));
    }
  }

  // --- показать путь из интерфейса или вывода агента в Finder; относительный — от cwd и доп. папок запуска, потом от его папки
  // и папки артефактов (агент называет артефакт по имени: ideas.md)
  if (method === 'POST' && p === '/api/reveal') {
    if (!canReveal) throw new HttpError(501, 'Показ в Finder есть только на macOS');
    const body = (await readJson(req)) as { path?: unknown; run?: unknown };
    const runId = typeof body.run === 'string' && RUN_ID_RE.test(body.run) ? body.run : undefined;
    const r = runId ? readReport(runId) : undefined;
    const runDir = runId && path.join(RUNS_DIR, runId);
    const bases = [r?.cwd, ...(r?.addDirs ?? []), runDir, runDir && path.join(runDir, ARTIFACTS_DIR)];
    const abs = typeof body.path === 'string' ? resolveReveal(body.path, bases) : undefined;
    if (!abs) throw new HttpError(404, 'Файл не найден');
    try {
      await reveal(abs);
    } catch (err) {
      // исчез между проверкой и показом
      throw (err as { code?: string }).code === 'ENOENT' ? new HttpError(404, 'Файл не найден') : err;
    }
    return sendJson(res, 200, { path: abs });
  }

  // --- Jira, проекты GitLab, мои MR с причинами, вход из задачи/MR/ветки, worktree
  if (p.startsWith('/api/integrations') || p.startsWith('/api/jira/') || p.startsWith('/api/projects') || p.startsWith('/api/attention') || p === '/api/intake' || p === '/api/worktrees') {
    const r = await integrationsRoute(method, url, () => readJson(req), {
      runCwds: () => listRuns().flatMap((x) => (x.cwd && !x.worktree ? [x.cwd] : [])),
      flowInput: (name) => {
        assertFlowName(name);
        return loadFlow(name).input;
      },
      flows: listFlows,
    });
    if (r) return sendJson(res, r.status, r.body);
  }

  // --- флоу
  if (method === 'GET' && p === '/api/flows') return sendJson(res, 200, listFlows() satisfies FlowListItem[]);

  // save: false — черновик разового запуска: в flows/ ничего не пишется (flowFileName создал бы и папку)
  if (method === 'POST' && p === '/api/flows/generate') {
    const body = (await readJson(req)) as { task?: string; cwd?: string; model?: string; folder?: string; save?: boolean };
    const task = (body.task ?? '').trim();
    if (!task) return sendJson(res, 400, { error: 'Опиши задачу' });
    const cwd = resolveDir(body.cwd, opts.defaultCwd);
    // тело — как было; с Accept: application/x-ndjson — поток хода сессии (src/flow-ai.ts)
    return respondFlowAi(req, res, generations, (ai) =>
      generateReply(task, { cwd, model: body.model || undefined, folder: (body.folder ?? '').trim(), save: body.save !== false }, ai),
    );
  }

  // Проверка черновика разового запуска ({ spec } из конструктора или { yaml }): ничего не пишет.
  if (method === 'POST' && p === '/api/flows/check') {
    const body = (await readJson(req)) as { spec?: unknown; yaml?: unknown };
    try {
      const spec = draftSpec(body);
      return sendJson(res, 200, { name: spec.name, spec, yaml: flowToYaml(spec), summary: summarize(spec.name, '', spec) });
    } catch (err) {
      return sendJson(res, 400, { error: errMsg(err) });
    }
  }

  if (method === 'POST' && p === '/api/flows/blank') {
    const body = (await readJson(req)) as { name?: string; folder?: string };
    const name = (body.name ?? '').trim();
    assertFlowName(name);
    if (flowExists(name)) return sendJson(res, 409, { error: `Flow ${name} уже существует` });
    const yaml = blankFlowYaml(name);
    try {
      saveFlowYaml(name, yaml, (body.folder ?? '').trim());
    } catch (err) {
      return sendJson(res, 400, { error: errMsg(err) });
    }
    return sendJson(res, 201, { name, yaml });
  }

  if ((m = p.match(/^\/api\/flows\/([a-z0-9-]+)\/spec$/)) && method === 'PUT') {
    const name = m[1];
    const body = (await readJson(req)) as { spec?: unknown };
    if (!body.spec || typeof body.spec !== 'object') return sendJson(res, 400, { error: 'Нужно поле spec' });
    try {
      const { spec, yaml, file } = saveFlowSpec(name, body.spec);
      return sendJson(res, 200, { name, yaml, spec, summary: summarize(name, file, spec) });
    } catch (err) {
      return sendJson(res, 400, { error: errMsg(err) });
    }
  }

  // Правка флоу ИИ по описанию. В файл не пишет: результат уходит в конструктор несохранённым, сохраняет пользователь.
  if ((m = p.match(/^\/api\/flows\/([a-z0-9-]+)\/edit$/)) && method === 'POST') {
    const name = m[1];
    const body = (await readJson(req)) as { instruction?: string; spec?: unknown; yaml?: string; cwd?: string; model?: string };
    const instruction = (body.instruction ?? '').trim();
    if (!instruction) return sendJson(res, 400, { error: 'Опиши, что поменять' });
    const base = editBase(name, body.spec || typeof body.yaml === 'string' ? body : { yaml: readFlowYaml(name) });
    // закрыли вкладку или нажали «Прервать» — respondFlowAi останавливает и сессию
    const cwd = path.resolve((body.cwd ?? '').trim() || opts.defaultCwd);
    return respondFlowAi(req, res, generations, (ai) => editReply(name, instruction, base, { cwd, model: body.model || undefined }, ai));
  }

  if ((m = p.match(/^\/api\/flows\/([a-z0-9-]+)\/folder$/)) && method === 'PUT') {
    const body = (await readJson(req)) as { folder?: string };
    if (typeof body.folder !== 'string') return sendJson(res, 400, { error: 'Нужно поле folder (пустая строка — корень)' });
    try {
      return sendJson(res, 200, { name: m[1], folder: moveFlow(m[1], body.folder).folder });
    } catch (err) {
      return sendJson(res, 400, { error: errMsg(err) });
    }
  }

  if ((m = p.match(/^\/api\/flows\/([a-z0-9-]+)$/))) {
    const name = m[1];
    if (method === 'GET') {
      const yaml = readFlowYaml(name);
      let summary;
      let spec;
      let error: string | undefined;
      try {
        spec = parseFlow(yaml);
        summary = summarize(name, resolveFlowFile(name), spec);
      } catch (err) {
        error = errMsg(err);
      }
      return sendJson(res, 200, { name, folder: flowFolder(name), yaml, summary, spec, error });
    }
    if (method === 'PUT') {
      const body = (await readJson(req)) as { yaml?: string };
      if (typeof body.yaml !== 'string') return sendJson(res, 400, { error: 'Нужно поле yaml' });
      try {
        const { spec, file } = saveFlowYaml(name, body.yaml);
        return sendJson(res, 200, { name, spec, summary: summarize(name, file, spec) });
      } catch (err) {
        return sendJson(res, 400, { error: errMsg(err) });
      }
    }
    if (method === 'DELETE') {
      deleteFlow(name);
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- главная: вопросы, ждущие ответа, и идущие запуски этого сервера
  if (method === 'GET' && p === '/api/home') return sendJson(res, 200, { runs: liveRuns() } satisfies HomeResponse);
  if (method === 'GET' && p === '/api/feed') return sendJson(res, 200, { items: feed() } satisfies FeedResponse);
  if (method === 'GET' && p === '/api/limits') return sendJson(res, 200, await getLimits(url.searchParams.get('force') === '1'));
  // коннекторы claude.ai и их инструменты: конструктор подсказывает точные имена для tools этапа
  if (method === 'GET' && p === '/api/connectors') return sendJson(res, 200, (await getConnectors(url.searchParams.get('force') === '1')) satisfies ConnectorsView);

  if (method === 'GET' && p === '/api/events') return streamHome(req, res, url.searchParams.get('notify') === '1');

  // --- контекст сессии этапа: CLAUDE.md и правила, скиллы, сабагенты, MCP, токены. Писать можно только CLAUDE.md и правила из листинга.
  if (method === 'GET' && p === '/api/context') {
    const q = url.searchParams;
    const flow = q.get('flow') || undefined;
    let cwd: string;
    try {
      // только имя flow: путь к файлу у resolveFlowFile открыл бы любой YAML на диске
      if (flow) assertFlowName(flow);
      cwd = resolveDir(q.get('cwd') ?? undefined, opts.defaultCwd);
    } catch (err) {
      throw new HttpError(400, errMsg(err));
    }
    try {
      return sendJson(res, 200, (await getContext({
        cwd,
        flow,
        phase: (flow && q.get('phase')) || undefined,
        model: q.get('model') || undefined,
        force: q.get('force') === '1',
      })) satisfies ContextView);
    } catch (err) {
      throw contextHttp(err);
    }
  }
  if (p === '/api/context/file') {
    try {
      if (method === 'GET') return sendJson(res, 200, readContextFile(url.searchParams.get('path') ?? '') satisfies ContextFile);
      if (method === 'PUT') {
        const body = (await readJson(req)) as { path?: unknown; text?: unknown; mtimeMs?: unknown };
        if (typeof body.path !== 'string' || typeof body.text !== 'string' || typeof body.mtimeMs !== 'number') {
          return sendJson(res, 400, { error: 'Нужны поля path, text и mtimeMs' });
        }
        return sendJson(res, 200, writeContextFile(body.path, body.text, body.mtimeMs) satisfies ContextFileSaved);
      }
    } catch (err) {
      throw contextHttp(err);
    }
  }

  // --- теги: краткое саммари фичи между запусками (src/tags.ts). Слаг берём регэкспом без декодирования:
  // кривой %-escape не уронит сервер 500-й, а неверный слаг ответит 400 из tags.ts
  if (method === 'GET' && p === '/api/tags') return reply(res, tagsListReply());
  if (method === 'POST' && p === '/api/tags') return reply(res, createTagReply((await readJson(req)) as { slug?: unknown; title?: unknown; kind?: unknown }));
  if ((m = p.match(/^\/api\/tags\/([^/]+)$/))) {
    const slug = m[1];
    if (method === 'GET') return reply(res, tagReply(slug));
    if (method === 'PUT') return reply(res, updateTagReply(slug, (await readJson(req)) as Record<string, unknown>));
    if (method === 'DELETE') return reply(res, deleteTagReply(slug));
  }
  if (method === 'POST' && (m = p.match(/^\/api\/tags\/([^/]+)\/attachments$/))) return reply(res, addTagAttachmentReply(m[1], await readJson(req)));
  if (method === 'DELETE' && (m = p.match(/^\/api\/tags\/([^/]+)\/attachments\/([^/]+)$/))) {
    let name: string;
    try {
      name = decodeURIComponent(m[2]);
    } catch {
      return sendJson(res, 400, { error: 'Неверное имя вложения' });
    }
    return reply(res, deleteTagAttachmentReply(m[1], name));
  }

  // --- запуски
  if (method === 'GET' && p === '/api/runs') return sendJson(res, 200, listRuns());

  // Недавние директории для чипов формы запуска и списка проектов «Контекста»: свежие сверху, без worktree.
  // GET и DELETE отдают один и тот же список: DELETE — уже без скрытого пути.
  const recentDirList = (limit?: number) => {
    let settings: Pick<Settings, 'projects' | 'hiddenProjects' | 'hiddenDirs'> = { projects: [] };
    try {
      settings = loadSettings();
    } catch { /* без настроек — только запуски */ }
    return recentDirs({ runs: listRuns(), projects: settings.projects, hidden: settings.hiddenProjects, hiddenDirs: settings.hiddenDirs, defaultCwd: opts.defaultCwd, limit, exists: isDir });
  };
  if (method === 'GET' && p === '/api/dirs/recent') return sendJson(res, 200, recentDirList(numOrUndefined(url.searchParams.get('limit'))) satisfies RecentDir[]);
  // «×» на чипе: путь убирается из недавних до следующего запуска с ним. «Подключения» не трогаются.
  if (method === 'DELETE' && p === '/api/dirs/recent') {
    const dir = url.searchParams.get('path') ?? '';
    const problem = recentDirProblem(dir);
    if (problem) return sendJson(res, 400, { error: problem });
    updateSettings((s) => hideRecentDir(s, dir, new Date().toISOString()));
    return sendJson(res, 200, recentDirList());
  }

  if (method === 'POST' && p === '/api/runs') {
    // base64 раздувает файлы на треть: 25 МБ вложений — около 34 МБ JSON
    const body = (await readJson(req, RUN_BODY_MAX)) as {
      flow?: string;
      /** Черновик разового запуска: spec из конструктора или yaml из скилла, вместо flow. */
      spec?: unknown;
      yaml?: unknown;
      input?: string;
      cwd?: string;
      maxIterations?: number | string;
      maxBudgetUsd?: number | string;
      model?: string;
      source?: unknown;
      worktree?: unknown;
      attachments?: unknown;
      addDirs?: unknown;
      /** Теги любого вида (слаги): несуществующие заводятся тегами задачи; блок тега задачи вставляется во ввод, если его там ещё нет, тег знаний уходит в knowledge запуска. */
      tags?: unknown;
      /** Обновить саммари тегов после запуска; по умолчанию — да. */
      saveTag?: unknown;
      /** Завести новый тег задачи по тексту задачи (auto-tag.ts), если тег задачи не выбран; саммари после done — всегда. */
      autoTag?: unknown;
    };
    let spec: FlowSpec;
    let adhoc: boolean;
    try {
      ({ spec, adhoc } = specFromRunBody(body));
    } catch (err) {
      throw new HttpError(400, errMsg(err));
    }
    if (body.input?.trim()) spec.input = body.input.trim();
    // блоки тегов — не задача: ввод из одних блоков (тег выбран, задача не вписана) — та же ошибка
    if (!stripTagBlocks(spec.input ?? '')) return sendJson(res, 400, { error: spec.input === undefined ? 'Введи задачу: у flow нет поля input' : 'Введи задачу' });
    const cwd = resolveDir(body.cwd, opts.defaultCwd);
    // всё проверяем до startRun: при ошибке папка запуска не создаётся
    let attachments: Attachment[];
    let addDirs: string[];
    let tags: string[];
    try {
      attachments = validateAttachments(body.attachments);
      addDirs = runAddDirs(body.addDirs, cwd);
      tags = runTagSlugs(body.tags);
      if (body.saveTag !== undefined && typeof body.saveTag !== 'boolean') throw new Error('saveTag — true или false');
      if (body.autoTag !== undefined && typeof body.autoTag !== 'boolean') throw new Error('autoTag — true или false');
      // битый tag.json — тоже 400, а не 500
      for (const t of tags) readTag(t);
    } catch (err) {
      throw new HttpError(400, errMsg(err));
    }
    // теги заводятся последними: ошибка 400 выше не оставит пустой тег на диске. Новый слаг — тег задачи
    // (вид «знание» задаётся на странице «Теги»); выбранные делятся по виду
    let tagDirs: string[] = [];
    let taskTags: string[] = [];
    let knowledge: string[] = [];
    let saveTag = body.saveTag !== false;
    if (tags.length) {
      for (const t of tags) createTag(t);
      const split = splitRunTags(tags);
      taskTags = split.task.map((t) => t.slug);
      knowledge = split.knowledge.map((t) => t.slug);
      // скилл и любой клиент API шлют ввод без блоков: вставляем сами; блоки, вставленные руками, не трогаем
      if (split.task.length) {
        spec.input = withTagsInput(spec.input ?? '', split.task);
        tagDirs = tagsRunDirs(split.task, RUNS_DIR);
      }
    }
    // несуществующий тег знаний в knowledge блока — 400 до создания папки запуска, как директории
    try {
      resolveKnowledge(spec, knowledge);
    } catch (err) {
      throw new HttpError(400, errMsg(err));
    }
    const links = runLinks(body, cwd);
    // автотег — после всех проверок: запрос, который получил бы 400, не тратит денег. Выбран тег задачи руками —
    // галочка не действует. Сбой подбора — не ошибка запуска: он идёт без тега, причина — в ответе и run.json
    let autoTag: AutoTagReport | undefined;
    if (body.autoTag === true && !taskTags.length) {
      autoTag = await pickAutoTag(spec.input ?? '', { flow: spec.name, source: links.source });
      const tag = autoTag.slug ? readTag(autoTag.slug) : undefined;
      if (tag) {
        taskTags = [tag.slug];
        spec.input = withTagsInput(spec.input ?? '', [tag]);
        tagDirs = tagsRunDirs([tag], RUNS_DIR);
        // автотег без саммари бесполезен: галочка «Обновить саммари» для него не действует
        saveTag = true;
      }
    }
    const id = startRun(spec, {
      cwd,
      maxIterations: numOrUndefined(body.maxIterations),
      maxBudgetUsd: numOrUndefined(body.maxBudgetUsd),
      model: body.model || undefined,
      ...links,
      addDirs,
      attachments,
      adhoc,
      ...(taskTags.length ? { tags: taskTags, saveTag, tagDirs } : {}),
      ...(knowledge.length ? { knowledge } : {}),
      ...(autoTag ? { autoTag } : {}),
    }, opts);
    const autoTagReply = autoTag && (autoTag.slug ? { slug: autoTag.slug, ...(autoTag.title ? { title: autoTag.title } : {}) } : { error: autoTag.error });
    return sendJson(res, 201, { id, ...(autoTagReply ? { autoTag: autoTagReply } : {}) } satisfies RunStarted);
  }

  // Продолжение завершённого запуска текущей версией флоу: done-блоки не повторяются (continuationFrom).
  // Лимит итераций не принимаем: --max-iterations переопределил бы все циклы, лимит задаёт флоу.
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/continue$/)) && method === 'POST') {
    const body = (await readJson(req)) as { maxBudgetUsd?: number | string; model?: string };
    return sendJson(res, 201, continueRun(m[1], { maxBudgetUsd: numOrUndefined(body.maxBudgetUsd), model: body.model || undefined }, opts));
  }

  // «Сохранить как flow»: снимок запуска — в flows/ под свободным или заданным именем; занятое имя — 409.
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/save-flow$/)) && method === 'POST') {
    const body = (await readJson(req)) as { name?: unknown; folder?: unknown };
    if (!readReport(m[1])) return sendJson(res, 404, { error: 'Запуск не найден' });
    return reply(res, saveRunFlow(RUNS_DIR, m[1], body));
  }

  // --- чат запуска: история, сообщение (ответ потоком NDJSON), остановка ответа, очистка контекста
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/chat$/))) {
    const id = m[1];
    if (!runView(id)) return sendJson(res, 404, { error: 'Запуск не найден' });
    const dir = path.join(RUNS_DIR, id);
    if (method === 'GET') return sendJson(res, 200, chatPayload(id, readChat(dir)));
    if (method === 'POST') return chatPost(req, res, id, opts);
    if (method === 'DELETE') {
      if (chats.has(id)) return sendJson(res, 409, { error: 'Агент ещё отвечает: прерви ответ или дождись его' });
      return sendJson(res, 200, chatPayload(id, clearChat(dir)));
    }
  }

  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/chat\/stop$/)) && method === 'POST') {
    chats.get(m[1])?.abort.abort();
    return sendJson(res, 200, { ok: true });
  }

  // Удаление из истории: вся папка запуска. Идущий запуск не трогаем.
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)$/)) && method === 'DELETE') {
    if (chats.has(m[1])) return sendJson(res, 409, { error: 'В чате запуска агент ещё отвечает: прерви ответ или дождись его' });
    const f = finishedRun(m[1]);
    if ('error' in f) return sendJson(res, f.code, { error: f.error });
    fs.rmSync(f.dir, { recursive: true, force: true });
    return sendJson(res, 200, { ok: true });
  }

  // Скрытие из истории: флаг в run.json, файлы остаются.
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/hidden$/)) && method === 'PUT') {
    const body = (await readJson(req)) as { hidden?: unknown };
    if (typeof body.hidden !== 'boolean') return sendJson(res, 400, { error: 'Нужно поле hidden: true или false' });
    const f = finishedRun(m[1]);
    if ('error' in f) return sendJson(res, f.code, { error: f.error });
    // пишем исходный файл, а не readReport: тот подменяет статус оборвавшегося запуска
    const raw = JSON.parse(fs.readFileSync(f.file, 'utf8')) as RunReport;
    if (body.hidden) raw.hidden = true;
    else delete raw.hidden;
    fs.writeFileSync(f.file, JSON.stringify(raw, null, 2));
    return sendJson(res, 200, { ok: true, hidden: body.hidden });
  }

  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)$/)) && method === 'GET') {
    const id = m[1];
    const lr = live.get(id);
    const report = lr?.report ?? readReport(id);
    if (!report) return sendJson(res, 404, { error: 'Запуск не найден' });
    // continuable — единственный источник для кнопки «Продолжить» и подписей панели артефактов (canContinue)
    return sendJson(res, 200, { ...(lr ? report : withFinal(report)), live: Boolean(lr), ...continuability(report, Boolean(lr)) } satisfies RunDetail);
  }

  // Схема запуска для UI: снимок runs/<id>/flow.yaml, по которому запуск идёт (меняет его только правка на паузе — событие flow). Нет снимка — 404.
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/flow$/)) && method === 'GET') {
    if (!RUN_ID_RE.test(m[1])) return sendJson(res, 400, { error: `Неверный id запуска: ${m[1]}` });
    try {
      return sendJson(res, 200, runFlowView(RUNS_DIR, m[1]));
    } catch (err) {
      return sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Анализ flow по завершённому запуску (run-analysis.ts): GET — сохранённый analysis.json, POST { model? } — новый анализ, ответ — готовый RunAnalysis.
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/analysis$/)) && (method === 'GET' || method === 'POST')) {
    const id = m[1];
    const report = readReport(id);
    if (!report) return sendJson(res, 404, { error: 'Запуск не найден' });
    if (method === 'GET') {
      const saved = readAnalysis(path.join(RUNS_DIR, id));
      return saved ? sendJson(res, 200, saved satisfies RunAnalysis) : sendJson(res, 404, { error: 'Анализа ещё нет', code: 'missing' });
    }
    const body = (await readJson(req)) as { model?: unknown };
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
    // состояние — после чтения тела: проверка занятости и пометка идут синхронно, без await между ними
    if (live.has(id) || readReport(id)?.status === 'running') return sendJson(res, 409, { error: 'Запуск ещё идёт', code: 'live' });
    if (analyses.has(id)) return sendJson(res, 409, { error: 'Анализ этого запуска уже идёт', code: 'busy' });
    analyses.add(id);
    // вкладку закрыли — сессию прерываем, чтобы не тратить деньги на ответ, который некому отдать
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    try {
      return sendJson(res, 200, (await analyzeFinishedRun(id, model, abort)) satisfies RunAnalysis);
    } finally {
      analyses.delete(id);
    }
  }

  // --- артефакты запуска: список, артефакт с версиями, запись пользователем (UI, хелпер скилла)
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/artifacts$/)) && method === 'GET') {
    const run = artifactRun(m[1]);
    return reply(res, run ? listArtifacts(run) : NO_ARTIFACTS);
  }
  // ключ — сегмент адреса как есть, без раскодирования: путь вместо ключа (..%2Frun.json) — неизвестный ключ
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/artifacts\/([^/]+)$/)) && (method === 'GET' || method === 'PUT')) {
    if (method === 'GET') {
      const run = artifactRun(m[1]);
      return reply(res, run ? readArtifact(run, m[2], url.searchParams.get('version')) : NO_ARTIFACTS);
    }
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'Тело — объект { text, base }', code: 'bad_request' });
    // состояние запуска — после чтения тела: проверка блокировки и запись идут синхронно, без await между ними
    const run = artifactRun(m[1]);
    return reply(res, run ? writeArtifact(run, m[2], body as Record<string, unknown>) : NO_ARTIFACTS);
  }

  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/events$/)) && method === 'GET') {
    return streamEvents(req, res, m[1]);
  }

  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/abort$/)) && method === 'POST') {
    abortRun(m[1]);
    return sendJson(res, 200, { ok: true });
  }

  // Пауза мягкая: текущий этап (или проверка условия) доигрывает, следующий шаг ждёт продолжения.
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/pause$/)) && method === 'POST') {
    return sendJson(res, 200, { ok: true, pause: pauseRun(m[1]) });
  }

  // Возобновить; непустой answer — сначала ответ на паузу в артефакт decisions, при ошибке записи пауза остаётся.
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/resume$/)) && method === 'POST') {
    const id = m[1];
    const body = (await readJson(req)) as { answer?: unknown; via?: unknown };
    if (body.answer !== undefined && body.answer !== null && typeof body.answer !== 'string') return sendJson(res, 400, { error: 'answer — строка', code: 'bad_request' });
    const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
    if (answer) {
      const lr = live.get(id);
      if (!lr) {
        if (!readReport(id)) return sendJson(res, 404, { error: 'Запуск не найден' });
        return sendJson(res, 409, { error: 'Запуск не на паузе в этом сервере: ответ не записан', code: 'not_paused' });
      }
      return reply(res, answerPause(lr.pause, artifactRun(id), answer, body.via === 'skill' ? 'skill' : 'ui'));
    }
    resumeRun(id);
    return sendJson(res, 200, { ok: true });
  }

  // Лимит итераций блока на ходу: раннер подхватит его со следующей итерации.
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/max-iterations$/)) && method === 'POST') {
    const id = m[1];
    liveRun(id);
    const body = (await readJson(req)) as { block?: string; value?: number | string };
    const br = changeMaxIterations(id, body.block ?? '', Number(body.value));
    return sendJson(res, 200, { ok: true, block: br.name, maxIterations: br.maxIterations });
  }

  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/answer$/)) && method === 'POST') {
    const id = m[1];
    liveRun(id);
    const body = (await readJson(req)) as { questionId?: string; answers?: Record<string, unknown> };
    answerQuestion(id, body.questionId, body.answers ?? {});
    return sendJson(res, 200, { ok: true });
  }

  // «Починить и продолжить»: указание следующему шагу (идёт или на паузе), правка flow запуска, повтор итерации (на паузе).
  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/note$/)) && method === 'POST') {
    const id = m[1];
    liveRun(id);
    const body = (await readJson(req)) as { text?: unknown; scope?: unknown; via?: unknown };
    if (typeof body.text !== 'string') return sendJson(res, 400, { error: 'text — строка', code: 'bad_request' });
    return fixReply(res, () => ({ note: addRunNote(id, body.text as string, { scope: body.scope as RunNote['scope'] | undefined, via: body.via as RunFixVia | undefined }) }));
  }

  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/flow$/)) && method === 'PUT') {
    const id = m[1];
    liveRun(id);
    const body = (await readJson(req)) as { yaml?: unknown; saveToFlows?: unknown; via?: unknown; base?: unknown };
    if (typeof body.yaml !== 'string') return sendJson(res, 400, { error: 'yaml — строка', code: 'bad_request' });
    if (body.saveToFlows !== undefined && typeof body.saveToFlows !== 'boolean') return sendJson(res, 400, { error: 'saveToFlows — true или false', code: 'bad_request' });
    if (body.base !== undefined && !Number.isInteger(body.base)) return sendJson(res, 400, { error: 'base — число правок снимка (flowEdits.length)', code: 'bad_request' });
    return fixReply(res, () => ({
      edit: applyRunFlow(id, body.yaml as string, { saveToFlows: body.saveToFlows === true, via: body.via as RunFixVia | undefined, base: body.base as number | undefined }),
    }));
  }

  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/flow\/reload$/)) && method === 'POST') {
    const id = m[1];
    liveRun(id);
    const body = (await readJson(req)) as { via?: unknown };
    return fixReply(res, () => ({ edit: reloadRunFlow(id, { via: body.via as RunFixVia | undefined }) }));
  }

  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/restart-iteration$/)) && method === 'POST') {
    const id = m[1];
    liveRun(id);
    const body = (await readJson(req)) as { note?: unknown; via?: unknown };
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return sendJson(res, 400, { error: 'note — строка', code: 'bad_request' });
    return fixReply(res, () => restartIteration(id, { note: (body.note as string | null) ?? undefined, via: body.via as RunFixVia | undefined }));
  }

  if ((m = p.match(/^\/api\/runs\/([A-Za-z0-9_-]+)\/file$/)) && method === 'GET') {
    const id = m[1];
    const rel = url.searchParams.get('path') ?? '';
    const runDir = path.join(RUNS_DIR, id);
    const opened = rel ? openRunFile(runDir, rel) : undefined;
    if (!opened) return sendJson(res, 404, { error: 'Файл не найден' });
    // вложения-картинки и PDF открываются в браузере, остальное — как текст
    const type = path.relative(runDir, opened.file).startsWith(`attachments${path.sep}`) ? attachmentContentType(opened.file) : undefined;
    // nosniff: браузер не угадывает тип и не исполнит вложенный файл как HTML
    res.writeHead(200, { 'Content-Type': type ?? 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    // читаем тот же дескриптор, что проверили: подмена файла после проверки не попадёт в ответ
    fs.createReadStream(opened.file, { fd: opened.fd }).pipe(res);
    return;
  }

  // --- UI (web/): сборка dist/web, маршруты роутера — на index.html; адреса /next/… времён миграции — 308 на /…
  if (method === 'GET') {
    const moved = legacyRedirect(p, url.search);
    if (moved) {
      res.writeHead(308, { Location: moved });
      res.end();
      return;
    }
    const web = resolveWebFile(WEB_DIST_DIR, p);
    if (web.kind === 'bad-path') return sendJson(res, 400, { error: 'Недопустимый путь' });
    if (web.kind === 'not-built') return sendJson(res, 404, { error: 'UI не собран: npm run build:web' });
    if (web.kind === 'file') {
      // открываем до заголовков: пересборка (emptyOutDir) могла убрать файл после проверки — тогда 404, а не падение сервера
      let fd: number;
      try {
        fd = fs.openSync(web.file, 'r');
      } catch {
        return sendJson(res, 404, { error: `Нет файла: ${p}` });
      }
      res.writeHead(200, { 'Content-Type': web.type, 'Cache-Control': web.cache, 'X-Content-Type-Options': 'nosniff', ...web.headers });
      fs.createReadStream(web.file, { fd }).on('error', () => res.destroy()).pipe(res);
      return;
    }
  }

  sendJson(res, 404, { error: `Нет такого маршрута: ${method} ${p}` });
}

function startRun(
  spec: ReturnType<typeof loadFlow>,
  o: {
    cwd: string;
    maxIterations?: number;
    maxBudgetUsd?: number;
    model?: string;
    continueFrom?: Continuation;
    source?: RunSource;
    worktree?: RunWorktree;
    addDirs?: string[];
    /** Новые вложения из формы. */
    attachments?: Attachment[];
    /** Папка запуска, чьи вложения копируются (продолжение). */
    attachmentsFrom?: string;
    /** Продолжение: артефакты копией текущих файлов этого запуска. */
    artifactsFrom?: { runId: string; runDir: string };
    /** Разовый запуск: flow не из flows/ (см. adhoc.ts). */
    adhoc?: boolean;
    /** Теги задачи, галочка обновления их саммари и папки чтения из тегов (см. tags.ts). */
    tags?: string[];
    saveTag?: boolean;
    tagDirs?: string[];
    /** Теги знаний на весь запуск. */
    knowledge?: string[];
    /** Итог автотега: в run.json, стоимость — в итог запуска. */
    autoTag?: AutoTagReport;
    /** Имя исходного запуска (продолжение): без подбора моделью. */
    title?: string;
  },
  srv: ServerOptions,
): string {
  const runDir = makeRunDir(RUNS_DIR, spec.name);
  const id = path.basename(runDir);
  // до live.set: упавшая запись вложений не оставит висящий запуск
  let attachments: string[];
  try {
    attachments = o.attachmentsFrom ? copyAttachments(o.attachmentsFrom, runDir) : saveAttachments(runDir, o.attachments ?? []);
  } catch (err) {
    fs.rmSync(runDir, { recursive: true, force: true });
    throw err;
  }
  const { attachments: _files, attachmentsFrom: _from, ...runOpts } = o;
  const lr: LiveRun = {
    id,
    events: [],
    logs: [],
    clients: new Set(),
    abort: new AbortController(),
    report: null,
    pending: new Map(),
    pause: null,
    release: null,
    current: null,
    running: [],
    broadcast: () => {},
    artifactItems: null,
    artifactSteps: new Map(),
    contexts: new Map(),
    notes: [],
  };
  live.set(id, lr);

  const control: RunControl = {
    checkpoint: async () => {
      if (!lr.pause || lr.abort.signal.aborted) return;
      setPause(lr, 'paused');
      await new Promise<void>((resolve) => { lr.release = resolve; });
    },
    requestPause: () => {
      if (!lr.pause) setPause(lr, 'requested');
      const reason = lr.report?.pauseReason;
      if (reason) notifyPause(srv, id, runLabel(spec.name, lr.report?.title), reason);
    },
    takeNotes: () => {
      const all = lr.notes;
      lr.notes = all.filter((n) => n.scope === 'run');
      return all;
    },
  };

  const onQuestion = (q: QuestionRecord, signal: AbortSignal) =>
    new Promise<AskAnswers>((resolve, reject) => {
      lr.pending.set(q.id, { resolve, reject });
      signal.addEventListener('abort', () => {
        if (lr.pending.delete(q.id)) reject(new Error('запуск остановлен'));
      });
    });

  const broadcast = (e: RunEvent) => {
    if (e.type === 'start' || e.type === 'end') lr.report = e.report;
    if (e.type === 'phase_start') {
      lr.running.push({ block: e.block, iteration: e.iteration, phase: e.phase, title: e.title, ...(e.group ? { group: e.group } : {}) });
      const first = lr.running[0];
      lr.current = { block: first.block, iteration: first.iteration, title: first.title };
    } else if (e.type === 'phase_end') {
      // у группы закончил один участник: остальные ещё идут, и главная не должна показать «между шагами»
      const r = e.report;
      lr.running = lr.running.filter((x) => !(x.block === r.block && x.iteration === r.iteration && x.phase === r.phase));
      const next = lr.running[0];
      lr.current = next ? { block: next.block, iteration: next.iteration, title: next.title } : null;
    } else if (e.type === 'condition_start') lr.current = { block: e.block, iteration: e.iteration, title: 'проверка условия' };
    else if (e.type === 'tag_summary_start') lr.current = { block: '', iteration: 0, title: `саммари тега ${e.tag}` };
    else if (e.type === 'condition' || e.type === 'end') {
      lr.current = null;
      lr.running = [];
    }
    const payload = `data: ${JSON.stringify(e)}\n\n`;
    if (e.type === 'phase_context') {
      // снимок: в ленту переигрывания и в домашний поток не идёт
      lr.contexts.set(contextKey(e), payload);
      for (const client of lr.clients) client.write(payload);
      return;
    }
    if (e.type === 'phase_end') lr.contexts.delete(contextKey(e.report));
    if (e.type === 'end') lr.contexts.clear();
    if (e.type === 'artifacts') {
      // снимок: в ленту переигрывания и в домашний поток не идёт
      lr.artifactItems = e.items;
      if (e.step) lr.artifactSteps.set(stepKey(e.step), e.step);
      for (const client of lr.clients) client.write(payload);
      return;
    }
    if (e.type !== 'log') {
      lr.events.push(payload);
      homeBroadcast({
        type: e.type,
        runId: id,
        flow: spec.name,
        question: e.type === 'question' ? e.question : undefined,
        status: e.type === 'end' ? e.report.status : undefined,
        costUsd: e.type === 'end' ? e.report.totalCostUsd : e.type === 'title' || e.type === 'digest' ? e.totalCostUsd : undefined,
        title: e.type === 'title' ? e.title : undefined,
      });
      if (e.type === 'question' || e.type === 'end') notifyOs(srv, id, runLabel(spec.name, lr.report?.title), e);
    } else if (lr.logs.push(payload) > LOG_REPLAY_MAX * 1.2) lr.logs.splice(0, lr.logs.length - LOG_REPLAY_MAX);
    for (const client of lr.clients) client.write(payload);
    if (e.type === 'end') {
      lr.pause = null;
      for (const client of lr.clients) client.end();
      lr.clients.clear();
      live.delete(id);
    }
  };
  lr.broadcast = broadcast;

  const onArtifactStore = (store: ArtifactStore) => {
    lr.artifacts = store;
  };
  const onFix = (fix: RunFix) => {
    lr.fix = fix;
  };
  // имя придумывает модель, кроме продолжения: оно берёт имя исходного запуска, а без него остаётся с именем flow
  const nameRun = o.continueFrom ? undefined : (input: string, signal: AbortSignal) => pickRunTitle(input, { flow: spec.name, source: o.source }, { signal });
  // итоги итераций и сводка «где мы сейчас» — для UI; у CLI их нет: смотреть их там некому
  const digest = (input: Parameters<typeof writeDigest>[0], signal: AbortSignal) => writeDigest(input, { signal });
  runFlow(spec, { ...runOpts, attachments, runsDir: RUNS_DIR, runDir, abort: lr.abort, onEvent: broadcast, onQuestion, control, onArtifactStore, onFix, digest, ...(nameRun ? { nameRun } : {}) }).catch((err) => {
    const report: RunReport = lr.report ?? {
      id,
      flow: spec.name,
      input: spec.input ?? '',
      cwd: o.cwd,
      status: 'failed',
      iterations: 0,
      maxIterations: flowBlocks(spec).reduce((n, b) => n + blockMaxIterations(b, o), 0),
      totalCostUsd: 0,
      blocks: [],
      phases: [],
      conditions: [],
      questions: [],
      runDir,
      startedAt: new Date().toISOString(),
      ...(o.adhoc ? { adhoc: true as const } : {}),
      ...(o.addDirs?.length ? { addDirs: o.addDirs } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(o.tags?.length ? { tags: o.tags, saveTag: o.saveTag !== false } : {}),
      ...(o.knowledge?.length ? { knowledge: o.knowledge } : {}),
      ...(o.title ? { title: o.title } : {}),
    };
    report.status = 'failed';
    report.error = errMsg(err);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(report, null, 2));
    broadcast({ type: 'end', report });
  });
  return id;
}

/** Меняет состояние паузы, отпускает раннер при продолжении, пишет в отчёт и рассылает событие. */
function setPause(lr: LiveRun, next: 'requested' | 'paused' | null): void {
  lr.pause = next;
  if (lr.report) {
    if (next) lr.report.pause = next;
    else {
      delete lr.report.pause;
      delete lr.report.pauseReason;
    }
  }
  if (!next) {
    lr.release?.();
    lr.release = null;
  }
  lr.broadcast({ type: 'pause', state: next ?? 'resumed', reason: next ? lr.report?.pauseReason : undefined });
}

// --- управление запуском: общее для кнопок UI (HTTP) и чата запуска. Ошибки — HttpError с кодом ответа.

/** Запуск, которым управляет этот сервер. Идущий в другом процессе (CLI, второй UI-сервер) отсюда не трогаем. */
function liveRun(id: string): LiveRun {
  const lr = live.get(id);
  if (lr) return lr;
  if (readReport(id)?.status === 'running') throw new HttpError(409, 'Запуск идёт в другом процессе (CLI или другой UI-сервер): управлять им отсюда нельзя');
  throw new HttpError(404, 'Запуск уже завершён');
}

function abortRun(id: string): void {
  const lr = liveRun(id);
  lr.abort.abort();
  // стоящий на паузе раннер отпускаем: он увидит abort и завершится
  if (lr.pause) setPause(lr, null);
  for (const [qid, pnd] of lr.pending) {
    pnd.reject(new Error('запуск остановлен'));
    lr.pending.delete(qid);
  }
}

function pauseRun(id: string): LiveRun['pause'] {
  const lr = liveRun(id);
  if (lr.abort.signal.aborted) throw new HttpError(409, 'Запуск останавливается');
  if (!lr.pause) setPause(lr, 'requested');
  return lr.pause;
}

function resumeRun(id: string): void {
  const lr = liveRun(id);
  if (lr.pause) setPause(lr, null);
}

function changeMaxIterations(id: string, block: string, value: number): BlockReport {
  const lr = liveRun(id);
  if (!lr.report) throw new HttpError(409, 'Запуск ещё не начался');
  if (lr.abort.signal.aborted) throw new HttpError(409, 'Запуск останавливается');
  let br: BlockReport;
  try {
    br = setBlockMaxIterations(lr.report, block, value);
  } catch (err) {
    throw new HttpError(400, errMsg(err));
  }
  fs.writeFileSync(path.join(lr.report.runDir, 'run.json'), JSON.stringify(lr.report, null, 2));
  lr.broadcast({ type: 'limit', block: br.name, max: br.maxIterations, total: lr.report.maxIterations });
  return br;
}

/** Ответ на вопрос агента: значение — строка или список вариантов (склеивается через ", "). */
function answerQuestion(id: string, questionId: string | undefined, raw: Record<string, unknown>): void {
  const lr = liveRun(id);
  const pnd = questionId ? lr.pending.get(questionId) : undefined;
  if (!pnd) throw new HttpError(404, 'Вопрос не найден или уже отвечен');
  const answers: AskAnswers = {};
  for (const [k, v] of Object.entries(raw)) answers[k] = Array.isArray(v) ? v.map(String).join(', ') : String(v ?? '');
  lr.pending.delete(questionId!);
  pnd.resolve(answers);
}

// --- «починить и продолжить» (run-fix.ts): указания этапам, правка flow запуска на паузе, повтор итерации

/** Ошибка правки запуска с кодом для клиента (not_paused, incompatible + problems…): маршруты отдают её телом целиком. */
class RunFixHttp extends HttpError {
  constructor(status: number, message: string, readonly code: string, readonly problems?: string[]) {
    super(status, message);
  }
}

const FIX_STATUS: Record<RunFixError['code'], number> = { not_paused: 409, incompatible: 400, not_started: 409, limit: 400, restarted: 409 };
const NOTE_MAX = 20_000;

/** Вызов RunFix: его ошибка — в RunFixHttp с тем же кодом. */
function callFix<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RunFixError) throw new RunFixHttp(FIX_STATUS[err.code], err.message, err.code, err.problems);
    throw err;
  }
}

const fixVia = (via: unknown): RunFixVia => {
  if (via === undefined || via === null) return 'ui';
  if (via === 'ui' || via === 'skill' || via === 'chat') return via;
  throw new RunFixHttp(400, 'via — ui, skill или chat', 'bad_request');
};

/** Текст указания: строка, не пустая и не длиннее NOTE_MAX. */
function noteText(text: unknown): string {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) throw new RunFixHttp(400, 'Пустое указание', 'bad_request');
  if (t.length > NOTE_MAX) throw new RunFixHttp(400, `Указание длиннее ${NOTE_MAX} знаков`, 'bad_request');
  return t;
}

const ADHOC_FLOWS = 'Разовый запуск: его flow нет в flows/ — правь снимок запуска, а в flows/ его кладёт «Сохранить как flow»';

/** Запуск на паузе в этом сервере: раннер стоит в контрольной точке. Иначе — 409 not_paused. */
function pausedRun(id: string): { lr: LiveRun; report: RunReport; fix: RunFix } {
  const lr = liveRun(id);
  if (lr.pause !== 'paused' || !lr.fix || !lr.report || lr.abort.signal.aborted) {
    throw new RunFixHttp(409, 'Запуск не на паузе: править flow и повторять итерацию можно только на паузе', 'not_paused');
  }
  return { lr, report: lr.report, fix: lr.fix };
}

/**
 * Указание идущему запуску (идёт или на паузе): хвостом в промпт следующего шага (next) или каждого до конца (run).
 * Сразу в run.json и событием note; где применено, допишет раннер.
 */
function addRunNote(id: string, text: string, o: { scope?: 'next' | 'run'; via?: RunFixVia } = {}): RunNote {
  const lr = liveRun(id);
  if (!lr.report) throw new HttpError(409, 'Запуск ещё не начался');
  if (lr.abort.signal.aborted) throw new HttpError(409, 'Запуск останавливается');
  const body = noteText(text);
  const scope = o.scope ?? 'next';
  if (scope !== 'next' && scope !== 'run') throw new RunFixHttp(400, 'scope — next или run', 'bad_request');
  const note: RunNote = { id: randomUUID(), text: body, scope, at: new Date().toISOString(), via: fixVia(o.via) };
  lr.notes.push(note);
  (lr.report.notes ??= []).push(note);
  fs.writeFileSync(path.join(lr.report.runDir, 'run.json'), JSON.stringify(lr.report, null, 2));
  lr.broadcast({ type: 'note', note });
  return note;
}

/**
 * Правка flow запуска на паузе (снимок, поправленный в YamlEditor): действует в этом запуске, в flows/<имя>.yaml — только
 * с saveToFlows. Несовместимая правка — 400 incompatible с problems, запуск идёт по-старому. base — сколько правок было у
 * снимка, который правили (flowEdits.length): с тех пор его сменили — 409 stale, чтобы не откатить чужую правку молча.
 */
function applyRunFlow(id: string, yaml: string, o: { saveToFlows?: boolean; via?: RunFixVia; base?: number } = {}): RunFlowEdit {
  const { report, fix } = pausedRun(id);
  const via = fixVia(o.via);
  if (o.saveToFlows && report.adhoc) throw new RunFixHttp(409, ADHOC_FLOWS, 'adhoc');
  const version = report.flowEdits?.length ?? 0;
  if (o.base !== undefined && o.base !== version) {
    throw new RunFixHttp(409, `Снимок flow запуска сменился, пока его правили (версия ${version}, а правили ${o.base}): перечитай и повтори`, 'stale');
  }
  let next: FlowSpec;
  try {
    if (typeof yaml !== 'string') throw new Error('yaml — строка');
    next = draftSpec({ yaml });
  } catch (err) {
    throw new RunFixHttp(400, errMsg(err), 'incompatible', [errMsg(err)]);
  }
  // задача — запуска: без input в правке берётся она, другая — несовместимая правка (run-fix.ts)
  next.input ??= report.input;
  return applyRunSpec(report, fix, next, 'edit', via, o.saveToFlows ? yaml : undefined);
}

/** «Починил в Claude Code»: flow запуска на паузе — текущая версия flows/<имя>.yaml, задача остаётся своя. */
function reloadRunFlow(id: string, o: { via?: RunFixVia } = {}): RunFlowEdit {
  const { report, fix } = pausedRun(id);
  const via = fixVia(o.via);
  if (report.adhoc) throw new RunFixHttp(409, ADHOC_FLOWS, 'adhoc');
  let next: FlowSpec;
  try {
    assertFlowName(report.flow);
    next = loadFlow(report.flow);
  } catch (err) {
    throw new RunFixHttp(400, `Flow ${report.flow} не загружается: ${errMsg(err)}`, 'incompatible', [errMsg(err)]);
  }
  next.input = report.input;
  return applyRunSpec(report, fix, next, 'reload', via);
}

/**
 * Подменить flow запуска; flowsYaml — текст правки, который ляжет и в flows/. Сначала запуск, потом flows/: неподходящая
 * или упавшая правка flows/ не трогает. Сбой записи в flows/ правку запуска не отменяет — он в edit.saveError.
 */
function applyRunSpec(report: RunReport, fix: RunFix, next: FlowSpec, source: RunFlowEdit['source'], via: RunFixVia, flowsYaml?: string): RunFlowEdit {
  const problems = callFix(() => fix.checkFlow(next));
  if (problems.length) throw new RunFixHttp(400, `Правка не подходит идущему запуску:\n${problems.join('\n')}`, 'incompatible', problems);
  const edit = callFix(() => fix.applyFlow(next, { source, via }));
  if (flowsYaml === undefined) return edit;
  // в flows/ — без задачи этого запуска: input — как у сохранённого flow
  let base: string | undefined;
  try {
    base = loadFlow(report.flow).input;
  } catch {
    base = undefined;
  }
  try {
    saveFlowYaml(report.flow, withFlowInput(flowsYaml, base), flowFolder(report.flow));
    edit.savedToFlows = true;
  } catch (err) {
    edit.saveError = `flows/${report.flow}.yaml не записан: ${errMsg(err)}`;
  }
  // edit — тот же объект, что в report.flowEdits (если правка что-то поменяла): дописываем отметку и в run.json
  fs.writeFileSync(path.join(report.runDir, 'run.json'), JSON.stringify(report, null, 2));
  return edit;
}

/**
 * Повторить итерацию на паузе: остаток шагов отбрасывается, следующая — N+1, лимит блока +1. note — в {{feedback}} и
 * указанием next первому шагу новой итерации. Запуск остаётся на паузе: дальше — resumeRun.
 */
function restartIteration(id: string, o: { note?: string; via?: RunFixVia } = {}): { block: string; iteration: number } {
  const { fix } = pausedRun(id);
  const via = fixVia(o.via);
  const note = o.note?.trim() ? noteText(o.note) : '';
  const r = callFix(() => fix.restart({ note }));
  if (note) addRunNote(id, note, { scope: 'next', via });
  return r;
}

/** Ответ маршрута правки: ошибка с кодом (RunFixHttp) — телом { error, code, problems? }, остальные — как обычно. */
function fixReply(res: http.ServerResponse, fn: () => unknown): void {
  let body: unknown;
  try {
    body = fn();
  } catch (err) {
    if (!(err instanceof RunFixHttp)) throw err;
    return sendJson(res, err.status, { error: err.message, code: err.code, ...(err.problems ? { problems: err.problems } : {}) });
  }
  sendJson(res, 200, body);
}

/**
 * Flow запуска: у разового — снимок из его папки; у запуска, чей flow правили на ходу (flowEdits, и у его продолжений), —
 * тоже снимок; у обычного — текущая версия из flows/ по имени.
 */
function specOf(report: RunReport): FlowSpec {
  return runSpec(report, {
    flow: (name) => {
      assertFlowName(name);
      return loadFlow(name);
    },
    snapshot: (id) => readRunFlow(RUNS_DIR, id),
    report: readReport,
  });
}

/**
 * Анализ flow по завершённому запуску (занятость проверяет маршрут). Flow — снимок runs/<id>/flow.yaml, по которому
 * запуск шёл; нет снимка (старый запуск) — текущая версия из flows/ через specOf.
 */
async function analyzeFinishedRun(id: string, model: string | undefined, abort?: AbortController): Promise<RunAnalysis> {
  const report = readReport(id);
  if (!report) throw new HttpError(404, 'Запуск не найден');
  const runDir = path.join(RUNS_DIR, id);
  const hasSnapshot = fs.existsSync(path.join(runDir, 'flow.yaml'));
  const spec = hasSnapshot ? readRunFlow(RUNS_DIR, id) : specOf(report);
  const flowYaml = hasSnapshot ? fs.readFileSync(path.join(runDir, 'flow.yaml'), 'utf8') : flowToYaml(spec);
  return analyzeRun(withFinal(report), spec, flowYaml, { runDir, model, abort });
}

/** Продолжение завершённого запуска текущей версией флоу: done-блоки не повторяются (continuationFrom). */
function continueRun(prevId: string, o: { maxBudgetUsd?: number; model?: string }, srv: ServerOptions): { id: string; skipped: string[] } {
  const prev = readReport(prevId);
  if (!prev) throw new HttpError(404, 'Запуск не найден');
  if (live.has(prevId) || prev.status === 'running') throw new HttpError(409, 'Запуск ещё идёт: продолжить можно только завершённый');
  if (!prev.cwd) throw new HttpError(400, 'В отчёте запуска нет директории проекта');
  const spec = specOf(prev);
  spec.input = prev.input;
  let cont: Continuation;
  try {
    cont = continuationFrom(prev, spec, {
      report: readReport,
      output: (runId, rel) => {
        const dir = path.resolve(RUNS_DIR, runId);
        const f = path.resolve(dir, rel);
        return f.startsWith(dir + path.sep) && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined;
      },
    });
  } catch (err) {
    throw new HttpError(400, errMsg(err));
  }
  // директорию могли удалить после прошлого запуска: проверяем заново, а не роняем запуск на первом этапе
  let addDirs: string[];
  try {
    addDirs = runAddDirs(prev.addDirs, prev.cwd);
  } catch (err) {
    throw new HttpError(400, errMsg(err));
  }
  const id = startRun(spec, {
    cwd: prev.cwd,
    maxBudgetUsd: o.maxBudgetUsd,
    model: o.model,
    continueFrom: cont,
    source: prev.source,
    worktree: prev.worktree,
    addDirs,
    attachmentsFrom: path.join(RUNS_DIR, prevId),
    // у flow без артефактов раннер это поле не читает; убранные из flow артефакты не переносятся
    artifactsFrom: { runId: prevId, runDir: path.join(RUNS_DIR, prevId) },
    // продолжение разового запуска тоже разовое: его снимок — тот же flow
    adhoc: prev.adhoc,
    // теги и галочка наследуются; ввод уже с блоками тегов. Папки чтения пересчитываются по нынешним тегам: старые могли удалить
    ...(prev.tags?.length ? { tags: prev.tags, saveTag: prev.saveTag !== false, tagDirs: tagsRunDirs(readTagsSafe(prev.tags), RUNS_DIR) } : {}),
    // теги знаний тоже наследуются; их разделы раннер пересчитает по нынешнему состоянию тегов
    ...(prev.knowledge?.length ? { knowledge: prev.knowledge } : {}),
    // имя наследуется, модель заново не зовётся
    ...(prev.title ? { title: prev.title } : {}),
  }, srv);
  return { id, skipped: cont.skipBlocks };
}

// --- чат запуска (src/chat.ts): сервер даёт ему состояние запуска и те же функции управления, что у кнопок

/** Запуск глазами чата: у идущего здесь — из памяти (статус ждёт ответа / на паузе, текущий шаг, открытые вопросы). */
function runView(id: string): RunView | undefined {
  const lr = live.get(id);
  const report = lr?.report ?? readReport(id);
  if (!report) return undefined;
  return {
    report,
    live: Boolean(lr),
    status: lr ? liveStatus(lr) : report.status,
    current: lr?.current ?? null,
    running: lr?.running ?? [],
    pending: lr ? report.questions.filter((q) => lr.pending.has(q.id)) : [],
  };
}

function chatControls(id: string, srv: ServerOptions): ChatControls {
  return {
    view: () => runView(id),
    logTail: (n) => {
      const lr = live.get(id);
      if (!lr) return undefined;
      return lr.logs.slice(-n).map((payload) => {
        const e = JSON.parse(payload.slice('data: '.length)) as Extract<RunEvent, { type: 'log' }>;
        return `[${e.phase}] ${e.line.length > 1000 ? e.line.slice(0, 1000) + '…' : e.line}`;
      });
    },
    pause: () => { pauseRun(id); },
    resume: () => resumeRun(id),
    abort: () => abortRun(id),
    setMaxIterations: (block, value) => changeMaxIterations(id, block, value),
    answer: (questionId, answers) => answerQuestion(id, questionId, answers),
    continueRun: () => continueRun(id, {}, srv),
  };
}

/** История чата для UI; busy и activity — идущий ход (его видно и из другой вкладки, и после возврата на запуск). */
function chatPayload(id: string, chat: ChatLog): ChatPayload {
  const turn = chats.get(id);
  return {
    messages: chat.messages,
    totalCostUsd: chat.totalCostUsd,
    sessionId: chat.sessionId,
    busy: Boolean(turn),
    activity: turn?.lines.slice(-30) ?? [],
  };
}

/**
 * Сообщение в чат запуска. Ответ — поток NDJSON: saved (сообщение записано), log (ход ответа), done (история после ответа) или error.
 * Ход не зависит от соединения: закрыли вкладку — агент доотвечает, ответ ляжет в историю. Остановка — POST …/chat/stop.
 */
async function chatPost(req: http.IncomingMessage, res: http.ServerResponse, id: string, srv: ServerOptions): Promise<void> {
  const body = (await readJson(req)) as { message?: string; model?: string };
  const message = (body.message ?? '').trim();
  if (!message) return sendJson(res, 400, { error: 'Пустое сообщение' });
  if (chats.has(id)) return sendJson(res, 409, { error: 'Агент ещё отвечает на прошлое сообщение' });
  const view = runView(id);
  if (!view) return sendJson(res, 404, { error: 'Запуск не найден' });

  const turn: ChatTurnState = { abort: new AbortController(), lines: [], clients: new Set([res]) };
  chats.set(id, turn);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.on('close', () => turn.clients.delete(res));
  const send = (o: ChatStreamEvent) => {
    const line = JSON.stringify(o) + '\n';
    for (const c of turn.clients) c.write(line);
  };
  const dir = path.join(RUNS_DIR, id);
  try {
    const chat = await chatTurn({
      runDir: dir,
      cwd: view.report.cwd,
      message,
      model: body.model || undefined,
      controls: chatControls(id, srv),
      abort: turn.abort,
      log: (line) => {
        const l = truncate(line, 400);
        if (turn.lines.push(l) > CHAT_ACTIVITY_MAX) turn.lines.splice(0, turn.lines.length - CHAT_ACTIVITY_MAX / 2);
        send({ type: 'log', line: l });
      },
      onSaved: (chat) => send({ type: 'saved', chat: chatPayload(id, chat) }),
    });
    // до done: в истории, которую он несёт, ответ уже не «идёт»
    chats.delete(id);
    send({ type: 'done', chat: chatPayload(id, chat) });
  } catch (err) {
    send({ type: 'error', error: errMsg(err) });
  } finally {
    chats.delete(id);
    for (const c of turn.clients) c.end();
  }
}

function streamEvents(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const lr = live.get(id);
  if (!lr) {
    const report = readReport(id);
    const e: RunStreamEvent = report ? { type: 'end', report: withFinal(report) } : { type: 'error', message: 'Запуск не найден' };
    res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.end();
    return;
  }
  // строки лога клиенту нужны только для окна лога, порядок относительно событий состояния не важен;
  // снимок артефактов — после событий: итоги шагов дополняют отчёты этапов из phase_end
  res.write(lr.events.join('') + artifactsReplay(lr) + [...lr.contexts.values()].join('') + lr.logs.join(''));
  lr.clients.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    lr.clients.delete(res);
  });
}

/** Ключ этапа в снимках контекста: блок, итерация, этап. */
function contextKey(x: { block: string; iteration: number; phase: string }): string {
  return `${x.block}\u0000${x.iteration}\u0000${x.phase}`;
}

/** Ключ шага для итогов артефактов: блок, итерация, участники или условие; до первого шага — run. */
function stepKey(d: StepDelta): string {
  if (d.block === undefined) return 'run';
  return `${d.block}\u0000${d.iteration}\u0000${d.condition ? 'condition' : d.phases.map((x) => x.phase).join(',')}`;
}

/** Переигрывание артефактов одним событием: последний список и итоги всех шагов (steps — только при переигрывании). */
function artifactsReplay(lr: LiveRun): string {
  if (!lr.artifactItems) return '';
  const e: RunEvent = { type: 'artifacts', items: lr.artifactItems, steps: [...lr.artifactSteps.values()] };
  return `data: ${JSON.stringify(e)}\n\n`;
}

function homeBroadcast(e: HomeEvent): void {
  const payload = `data: ${JSON.stringify(e)}\n\n`;
  for (const client of homeClients.keys()) client.write(payload);
}

/** Подпись запуска в уведомлениях: «имя (flow)», без имени — flow. */
const runLabel = (flow: string, title?: string): string => (title ? `${title} (${flow})` : flow);

/**
 * Системное уведомление — когда ни одна открытая вкладка не покажет своё (UI закрыт или уведомления браузера не включены).
 * Остановку руками не объявляем: её только что нажали.
 */
function notifyOs(srv: ServerOptions, id: string, flow: string, e: Extract<RunEvent, { type: 'question' | 'end' }>): void {
  if (srv.notify === false || [...homeClients.values()].some(Boolean)) return;
  const base = `http://${srv.host}:${srv.port}/`;
  if (e.type === 'question') {
    const q = e.question;
    osNotify({ title: `${flow}: вопрос от «${q.title || q.phase}»`, body: q.questions.map((x) => x.question).join(' · '), url: base, group: q.id, sound: true });
    return;
  }
  const r = e.report;
  if (r.status === 'aborted') return;
  const body = `${STATUS_LABEL[r.status]} · итераций ${r.iterations} · $${r.totalCostUsd.toFixed(2)}${r.error ? ` · ${r.error}` : ''}`;
  osNotify({ title: `${flow}: запуск завершён`, body, url: `${base}run/${id}`, group: id, sound: r.status !== 'done' });
}

/** Агент сам поставил запуск на паузу: ему нужен ответ пользователя, это как вопрос. */
function notifyPause(srv: ServerOptions, id: string, flow: string, r: PauseReason): void {
  if (srv.notify === false || [...homeClients.values()].some(Boolean)) return;
  const body = r.text.replace(/\s+/g, ' ').slice(0, 300);
  osNotify({ title: `${flow}: «${r.phase}» ждёт решения`, body, url: `http://${srv.host}:${srv.port}/run/${id}`, group: id, sound: true });
}

/** Общий поток без переигрывания: при (пере)подключении UI сам забирает состояние из /api/home и /api/runs. */
function streamHome(req: http.IncomingMessage, res: http.ServerResponse, notifies: boolean): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  homeClients.set(res, notifies);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    homeClients.delete(res);
  });
}

const liveStatus = (lr: LiveRun): string => (lr.pending.size > 0 ? 'waiting' : lr.pause === 'paused' ? 'paused' : 'running');

/** Идущие запуски для главной, с открытыми вопросами. От новых к старым. */
function liveRuns(): HomeRun[] {
  const out: HomeRun[] = [];
  for (const lr of live.values()) {
    const r = lr.report;
    if (!r) continue;
    out.push({
      id: lr.id,
      flow: r.flow,
      ...(r.title ? { title: r.title } : {}),
      cwd: r.cwd,
      input: stripTagBlocks(r.input ?? '').slice(0, 200),
      status: liveStatus(lr),
      pause: lr.pause,
      startedAt: r.startedAt,
      totalCostUsd: r.totalCostUsd,
      iterations: r.iterations,
      maxIterations: r.maxIterations,
      blocks: r.blocks.map((b) => ({ name: b.name, title: b.title, status: b.status, iterations: b.iterations, maxIterations: b.maxIterations, looped: b.looped })),
      current: lr.current,
      running: lr.running,
      questions: r.questions.filter((q) => lr.pending.has(q.id)),
      conds: homeConds(r),
      // сводка «где мы сейчас» от модели; нет — UI собирает строку из этапа и вердикта
      ...(r.digest ? { digest: r.digest } : {}),
      // «Ответить на странице запуска» на главной: пауза по просьбе агента и артефакт решений
      ...homePauseFields(lr.pause, r.pauseReason, lr.artifacts?.hasDecisions() ?? false),
    });
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Вердикты проверок блока, который идёт (или последнего начатого), — для строки запуска на главной:
 * мини-лента итераций, «итерация N не прошла: …» и «буксует». text — начало замечаний (разметку чистит UI, «буксует»
 * сравнивает по нему), summary — итог итерации от модели, если он уже есть.
 */
function homeConds(r: RunReport) {
  const cur = r.blocks.find((b) => b.status === 'running') ?? [...r.blocks].reverse().find((b) => b.status !== 'pending');
  const sole = r.blocks.length <= 1;
  return r.conditions
    .filter((c) => sole || c.block === cur?.name)
    .slice(-50)
    .map((c) => ({
      iteration: c.iteration,
      type: c.type,
      done: c.done || c.type === 'none',
      text: (c.done ? c.detail ?? '' : c.feedback || c.detail || '').slice(0, 300),
      ...(c.summary ? { summary: c.summary } : {}),
    }));
}

const FEED_RUNS = 50;

/** Лента главной: события последних запусков и всех идущих, от новых к старым. */
function feed(): FeedItem[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  // имя папки начинается с даты старта: последние по имени — последние запуски
  const ids = new Set(fs.readdirSync(RUNS_DIR).filter((d) => RUN_ID_RE.test(d)).sort().slice(-FEED_RUNS));
  for (const id of live.keys()) ids.add(id);
  const items: FeedItem[] = [];
  for (const id of ids) {
    const lr = live.get(id);
    const r = lr?.report ?? readReport(id);
    if (r) items.push(...reportFeed(id, r, lr && { pending: (qid) => lr.pending.has(qid) }));
  }
  return mergeFeed(items);
}


function listRuns(): RunSummary[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const out: RunSummary[] = [];
  for (const dir of fs.readdirSync(RUNS_DIR)) {
    if (!RUN_ID_RE.test(dir)) continue;
    const r = readReport(dir);
    if (!r) continue;
    const lr = live.get(dir);
    out.push({
      id: dir,
      flow: r.flow,
      ...(r.title ? { title: r.title } : {}),
      status: lr ? liveStatus(lr) : r.status,
      iterations: r.iterations,
      totalCostUsd: r.totalCostUsd,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      input: stripTagBlocks(r.input ?? '').slice(0, 200),
      cwd: r.cwd,
      hidden: Boolean(r.hidden),
      source: r.source,
      worktree: r.worktree,
      addDirs: r.addDirs,
      ...(r.adhoc ? { adhoc: r.adhoc } : {}),
      ...(r.tags?.length ? { tags: r.tags } : {}),
      ...(r.knowledge?.length ? { knowledge: r.knowledge } : {}),
    });
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Папка завершённого запуска для скрытия и удаления. Идущий (здесь или процессом CLI) не отдаём; без run.json — не запуск. */
function finishedRun(id: string): { dir: string; file: string } | { code: number; error: string } {
  const r = readReport(id);
  if (!r) return { code: 404, error: 'Запуск не найден' };
  if (live.has(id) || r.status === 'running') return { code: 409, error: 'Запуск ещё идёт: сначала останови его' };
  const dir = path.resolve(RUNS_DIR, id);
  if (path.dirname(dir) !== path.resolve(RUNS_DIR)) return { code: 400, error: 'Неверный id запуска' };
  return { dir, file: path.join(dir, 'run.json') };
}

/** Теги по слагам из отчёта; испорченный или удалённый тег пропускается. */
function readTagsSafe(slugs: string[]): Tag[] {
  return slugs.flatMap((slug) => {
    try {
      return readTag(slug) ?? [];
    } catch {
      return [];
    }
  });
}

function readReport(id: string): RunReport | undefined {
  if (!RUN_ID_RE.test(id)) return undefined;
  const file = path.join(RUNS_DIR, id, 'run.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as RunReport;
    return markInterrupted({ ...r, id: r.id ?? id });
  } catch {
    return undefined;
  }
}

// --- артефакты запуска

const NO_ARTIFACTS: ApiReply = { status: 404, body: { error: 'У запуска нет артефактов', code: 'no_artifacts' } };

function reply(res: http.ServerResponse, r: ApiReply): void {
  sendJson(res, r.status, r.body);
}

/**
 * Можно ли продолжить запуск — canContinue по текущей версии flow (у разового — по снимку). Идущий нельзя; flow удалён или не разбирается — нельзя.
 * report — глазами сервера (readReport): у оборвавшегося запуска статус interrupted.
 */
function continuability(report: RunReport, isLive: boolean): { continuable: boolean; continueReason?: string } {
  if (isLive) return { continuable: false, continueReason: 'Запуск ещё идёт' };
  if (!report.cwd) return { continuable: false, continueReason: 'В отчёте запуска нет директории проекта' };
  try {
    const c = canContinue(report, specOf(report));
    return c.ok ? { continuable: true } : { continuable: false, continueReason: c.reason };
  } catch (err) {
    return { continuable: false, continueReason: report.adhoc ? `Снимок flow разового запуска не загружается: ${errMsg(err)}` : `Flow ${report.flow} не загружается: ${errMsg(err)}` };
  }
}

/**
 * Запуск глазами API артефактов; undefined — у запуска нет артефактов. Живой — его хранилище и блокировка.
 * Неживой — хранилище на этот запрос: для чтения open(readonly) без записи run.json (у запуска из CLI его пишет чужой процесс),
 * для записи — open() со сверкой с диском, только после проверки «можно ли править».
 */
function artifactRun(id: string): ArtifactRun | undefined {
  const lr = live.get(id);
  if (lr) {
    const store = lr.artifacts;
    if (!store) return undefined;
    return {
      status: 'running',
      live: true,
      cliAlive: false,
      continuable: false,
      pendingQuestion: (lr.report?.questions ?? []).filter((q) => lr.pending.has(q.id)).map((q) => q.phase),
      pause: lr.pause,
      view: store,
      writable: () => store,
      resume: () => resumeRun(id),
    };
  }
  const report = readReport(id);
  if (!report) throw new HttpError(404, 'Запуск не найден');
  if (!report.artifacts) return undefined;
  const runDir = path.join(RUNS_DIR, id);
  const open = (readonly: boolean) => {
    try {
      return ArtifactStore.open(runDir, { readonly });
    } catch (err) {
      throw new HttpError(409, `Артефакты запуска не читаются: ${errMsg(err)}`);
    }
  };
  const view = open(true);
  if (!view) return undefined;
  return {
    status: report.status,
    live: false,
    cliAlive: report.status === 'running',
    ...continuability(report, false),
    pendingQuestion: [],
    pause: null,
    view,
    writable: () => {
      const store = open(false);
      if (!store) throw new HttpError(404, 'У запуска нет артефактов');
      return store;
    },
  };
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
// именованный канал без O_NONBLOCK повесил бы open, а с ним и весь сервер
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/**
 * Файл папки запуска для /file: открыт без следования ссылке (O_NOFOLLOW), обычный с одной жёсткой ссылкой,
 * его realpath внутри realpath папки запуска (ссылка на промежуточный каталог) и это тот же файл, что открыт.
 */
function openRunFile(runDir: string, rel: string): { fd: number; file: string } | undefined {
  const file = path.resolve(runDir, rel);
  if (!file.startsWith(runDir + path.sep)) return undefined;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = fs.fstatSync(fd);
    const real = fs.realpathSync.native(file);
    const root = fs.realpathSync.native(runDir);
    const rs = fs.statSync(real);
    if (st.isFile() && st.nlink === 1 && real !== root && isInside(real, root) && rs.ino === st.ino && rs.dev === st.dev) return { fd, file };
  } catch {
    /* исчез между open и realpath */
  }
  fs.closeSync(fd);
  return undefined;
}

/** Итог у завершённого запуска: старые отчёты (до поля final) его не пишут, досчитываем по этапам. */
function withFinal(r: RunReport): RunReport {
  if (r.status === 'running' || r.final) return r;
  return { ...r, final: finalPhases(r) };
}

/**
 * running в run.json, а раннера нет: ни среди живых запусков сервера, ни процессом (CLI).
 * Значит, процесс умер, не дописав отчёт, — показываем запуск прерванным. Файл не трогаем.
 */
function markInterrupted(r: RunReport): RunReport {
  if (r.status !== 'running' || live.has(r.id) || (r.pid && r.pid !== process.pid && pidAlive(r.pid))) return r;
  return {
    ...r,
    status: 'interrupted',
    blocks: (r.blocks ?? []).map((b) => (b.status === 'running' ? { ...b, status: 'interrupted' } : b)),
    error: r.error ?? 'Запуск прервался: процесс раннера завершился, не дописав отчёт (сервер перезапущен или упал). Продолжить с первого незавершённого блока: POST /api/runs/:id/continue.',
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const isDir = (d: string) => Boolean(fs.statSync(d, { throwIfNoEntry: false })?.isDirectory());

/** Доп. директории запуска из запроса: строка по пути на строку или список; ~ раскрывается, относительные — от cwd. Все должны существовать. */
function runAddDirs(raw: unknown, cwd: string): string[] {
  if (raw === undefined || raw === null) return [];
  const list = typeof raw === 'string' ? raw.split('\n') : Array.isArray(raw) ? raw : undefined;
  if (!list || list.some((d) => typeof d !== 'string')) throw new Error('addDirs — список путей');
  const dirs = resolveDirList(list as string[], cwd).filter((d) => d !== cwd);
  const missing = dirs.filter((d) => !isDir(d));
  if (missing.length) throw new Error(`Директория не найдена: ${missing.join(', ')}`);
  return dirs;
}

function resolveDir(dir: string | undefined, fallback: string): string {
  const resolved = path.resolve((dir ?? '').trim() || fallback);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Директория не найдена: ${resolved}`);
  return resolved;
}

function numOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const JSON_BODY_MAX = 5 * 1024 * 1024;
const RUN_BODY_MAX = 40 * 1024 * 1024;

function readJson(req: http.IncomingMessage, maxBytes = JSON_BODY_MAX): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // тело уже отклонено: остаток дочитываем вхолостую, чтобы ответ с ошибкой дошёл до клиента
      if (size > maxBytes) return reject(new HttpError(413, `Слишком большое тело запроса (больше ${Math.round(maxBytes / 1024 / 1024)} МБ)`));
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > maxBytes) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Невалидный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
