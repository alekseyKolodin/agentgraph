// Сессии терминала на сервере: реестр, маршруты /api/sessions*, хуки и MCP дочернего claude, WebSocket экрана.
// server.ts отдаёт сюда всё, что начинается с /api/sessions, событие upgrade и остановку. Логика текста и аргументов —
// sessions.ts, процессы и зеркало — sessions-pty.ts, JSON-RPC — sessions-mcp.ts.
// Безопасность. Терминал — это shell: WebSocket не подчиняется CORS, а upgrade обходит handle() с server-guard, поэтому
// здесь свои проверки Host и Origin (строго http://<Host>, без Origin — отказ). Хуки и MCP приходят от claude без Origin:
// их пускает только случайный токен сессии в заголовке, сравнение по времени постоянное, чужой токен — 404.
import { STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  SessionList, SessionPermissionMode, SessionStatus, SessionSummary, SessionTagChip, SessionView, SessionWsClient, SessionWsServer, TagKind,
} from './api-types.js';
import { runSession, type SessionRequest, type SessionResult } from './agent.js';
import { ROOT, RUNS_DIR } from './paths.js';
import { requestProblem } from './server-guard.js';
import { createTag, queueTagSummary, readTag, runTagSlugs, writeTagSummary } from './tags.js';
import { dropRunPaths, parseTagSummary, sessionTagSummaryRequest, type SessionTurn } from './tag-summary.js';
import { isInside } from './artifacts.js';
import { dedupeNames, validateAttachments } from './attachments.js';
import {
  findClaude, handleHook, idleAgents, launchDirs, LIVE_SESSIONS_MAX, parseClaudeVersion, parseHookInput, readSessionTags, resumeTarget, safeRealpath, sessionArgs, sessionEnv,
  sessionFlags, sessionName, sessionReadTargets, sessionTagDirs, SESSION_TOKEN_HEADER, TRUST_PROMPT_RE, type HookState,
} from './sessions.js';
import { mcpReply } from './sessions-mcp.js';
import { loadPtyKit, PtySession, ptyKitError, type PtyKit, type ScreenClient } from './sessions-pty.js';

/** Что лежит в <AGENTGRAPH_HOME>/sessions/<id>/session.json. */
export type SessionRecord = {
  id: string;
  name: string;
  cwd: string;
  tags: string[];
  model?: string;
  permissionMode?: SessionPermissionMode;
  saveTag: boolean;
  /** Разговоры Claude этой сессии по порядку: /clear и /resume начинают новый, «Продолжить» берёт последний. */
  claudeSessionIds: string[];
  transcriptPath?: string;
  createdAt: string;
  lastActivityAt: string;
  endedAt?: string;
  exitCode?: number;
  outcome?: 'untrusted' | 'failed';
  turns: number;
  claudeVersion?: string;
  /** Ходов (из turns), уже ушедших в саммари тегов задач. */
  summarizedTurns?: number;
  summary?: SessionSummary;
  /** Саммари при выходе не записано: приложение закрыли (Cmd+Q) или сервер остановился, пока сессия шла. */
  summaryPending?: 'app-closed';
};

/** Подключённый экран: сокет, к какому процессу он подцеплен и его размер (с ним же — к новому процессу). */
type Conn = { client: ScreenClient; attached: PtySession | null; size?: { cols: number; rows: number }; snapSent: boolean };

/** Сессия в памяти сервера. */
type Live = {
  rec: SessionRecord;
  token: string;
  /** Процесс claude с зеркалом; после выхода — null, остаётся снимок последнего экрана (screen). */
  pty: PtySession | null;
  screen?: { d: string; cols: number; rows: number };
  status: SessionStatus;
  injected: string[] | null;
  started: boolean;
  /** Диалог доверия сейчас на экране; был ли он хоть раз. */
  trustNow: boolean;
  sawTrust: boolean;
  spawnedAt: number;
  lastHookAt: number;
  sockets: Map<WebSocket, Conn>;
  watch?: ReturnType<typeof setInterval>;
  summarizing: boolean;
  /** Процесс гасит остановка сервера: саммари не пишем, ставим пометку. */
  appClosed?: boolean;
  /** «Перезапустить с тегами»: выход старого процесса — не конец сессии, саммари не нужно. */
  restarting?: boolean;
};

export type SessionDeps = {
  kit: () => Promise<PtyKit | null>;
  findClaude: () => string | undefined;
  version: (bin: string) => Promise<string | undefined>;
  /** stdout `claude agents --json`. */
  agents: (bin: string) => Promise<string>;
  /** Папка сессий: <AGENTGRAPH_HOME>/sessions. */
  dir: string;
  runsDir: string;
  env: () => NodeJS.ProcessEnv;
  /** Через сколько без SessionStart показывать «теги не доставлены». */
  deliveryAfterMs: number;
  /** Сессия саммари тега (Agent SDK). */
  summarize: (req: SessionRequest) => Promise<SessionResult>;
};

const run = (bin: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) => execFile(bin, args, { timeout: 8000, env, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out)))));

export const defaultSessionDeps = (): SessionDeps => ({
  kit: loadPtyKit,
  findClaude: () => findClaude(),
  version: (bin) => run(bin, ['--version'], sessionEnv(process.env, false)).then(parseClaudeVersion, () => undefined),
  agents: (bin) => run(bin, ['agents', '--json'], sessionEnv(process.env, false)),
  dir: path.join(ROOT, 'sessions'),
  runsDir: RUNS_DIR,
  env: () => process.env,
  deliveryAfterMs: 15_000,
  summarize: (req) => runSession(req, () => {}),
});

/** Ошибка с HTTP-кодом для ответа маршрута. */
export class SessionError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_SIZE = { cols: 120, rows: 36 };
/** Сколько ждать claude при остановке сервера: SessionEnd должен успеть дойти до живого сервера. */
const STOP_WAIT_MS = 5000;
const AGENTS_POLL_MS = 10_000;
/** Хуков нет дольше — статус «работает» сверяем с `claude agents --json`. */
const AGENTS_STALE_MS = 15_000;
const FILE_BODY_MAX = 16 * 1024 * 1024;
/** Тело хука PostToolBatch несёт ответы инструментов, картинки в них — base64: 5 МБ общего лимита мало. */
const HOOK_BODY_MAX = 64 * 1024 * 1024;

const sha = (s: string) => createHash('sha256').update(s).digest();

export class SessionManager {
  readonly sessions = new Map<string, Live>();
  private wss: WebSocketServer | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  /** Сервер останавливается: новых сессий и подключений не принимаем — их claude никто бы не погасил. */
  private stopping = false;
  private loaded = false;
  /** Идущие саммари тегов: остановка сервера прерывает их и ждёт, пока запишется пометка. */
  private readonly summaries = new Map<Promise<void>, AbortController>();

  constructor(readonly deps: SessionDeps) {}

  /** Фича есть, если node-pty и зеркало загрузились. Заодно — сессии прошлых запусков сервера с диска. */
  async available(): Promise<boolean> {
    const ok = (await this.deps.kit()) !== null;
    if (ok) {
      try {
        this.load();
      } catch (err) {
        console.error('сессии: не прочитались с диска —', errMsg(err));
      }
    }
    return ok;
  }

  /**
   * Сессии с диска: после перезапуска сервера они завершены. Шедшая в момент остановки (session.json без endedAt —
   * сервер упал или его погасили) — завершена сейчас, а её ходы без саммари — с пометкой «приложение закрыли».
   */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!ID_RE.test(name) || this.sessions.has(name)) continue;
      const rec = readRecord(path.join(this.deps.dir, name, 'session.json'), name);
      if (!rec) continue;
      const s = newLive(rec, 'ended');
      if (!rec.endedAt) {
        rec.endedAt = rec.lastActivityAt;
        if (this.wantsSummary(s)) rec.summaryPending = 'app-closed';
        // не записалось (нет прав, нет места) — сессия всё равно в списке, остальные тоже
        try {
          this.save(s);
        } catch (err) {
          console.error(`сессия ${name}: не записалась —`, errMsg(err));
        }
      }
      this.sessions.set(name, s);
    }
  }

  liveCount(): number {
    return [...this.sessions.values()].filter((s) => s.pty?.alive).length;
  }

  /** Названия живых сессий: десктоп спрашивает подтверждение выхода. */
  liveNames(): string[] {
    return [...this.sessions.values()].filter((s) => s.pty?.alive).map((s) => s.rec.name);
  }

  list(): SessionList {
    const kinds = kindCache();
    const views = [...this.sessions.values()].map((s) => this.view(s, kinds));
    views.sort((a, b) => Number(b.live) - Number(a.live) || b.lastActivityAt.localeCompare(a.lastActivityAt));
    return { sessions: views, max: LIVE_SESSIONS_MAX };
  }

  get(id: string): Live {
    const s = ID_RE.test(id) ? this.sessions.get(id) : undefined;
    if (!s) throw new SessionError(404, 'Сессия не найдена');
    return s;
  }

  view(s: Live, kinds = kindCache()): SessionView {
    const r = s.rec;
    const live = Boolean(s.pty?.alive);
    const chips: SessionTagChip[] = r.tags.map((slug) => ({ slug, kind: kinds(slug), state: live && !s.injected?.includes(slug) ? 'pending' : 'on' }));
    if (live && s.injected) for (const slug of s.injected.filter((x) => !r.tags.includes(x))) chips.push({ slug, kind: kinds(slug), state: 'removed' });
    const delivery = this.delivery(s);
    return {
      id: r.id,
      name: r.name,
      cwd: r.cwd,
      status: live ? s.status : 'ended',
      live,
      tags: r.tags,
      chips,
      ...(r.model ? { model: r.model } : {}),
      ...(r.permissionMode ? { permissionMode: r.permissionMode } : {}),
      saveTag: r.saveTag,
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
      ...(r.endedAt ? { endedAt: r.endedAt } : {}),
      ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
      turns: r.turns,
      ...(r.outcome ? { outcome: r.outcome } : {}),
      ...(delivery ? { delivery } : {}),
      ...(r.claudeVersion ? { claudeVersion: r.claudeVersion } : {}),
      ...(r.transcriptPath ? { transcriptPath: r.transcriptPath } : {}),
      newTurns: newTurns(r),
      ...(r.summary ? { summary: r.summary } : {}),
      ...(s.summarizing ? { summarizing: true as const } : {}),
      ...(r.summaryPending ? { summaryPending: r.summaryPending } : {}),
      ...(live ? {} : { resumable: resumeTarget(r) !== undefined }),
    };
  }

  /** Живая сессия, чьи теги ещё не доставлены: диалог доверия на экране — сразу, иначе — через deliveryAfterMs. */
  private delivery(s: Live): SessionView['delivery'] {
    if (!s.pty?.alive || s.injected !== null) return undefined;
    if (s.trustNow) return 'trust';
    return Date.now() - s.spawnedAt >= this.deps.deliveryAfterMs ? 'missing' : undefined;
  }

  // --- создание и запуск

  async create(body: Record<string, unknown>, port: number, defaultCwd: string): Promise<SessionView> {
    const kit = await this.deps.kit();
    if (!kit) throw new SessionError(501, `Терминал недоступен: node-pty не загрузился (${ptyKitError()})`, 'no_pty');
    if (this.stopping) throw new SessionError(503, 'Сервер останавливается');
    if (this.liveCount() >= LIVE_SESSIONS_MAX) throw new SessionError(409, `Живых сессий уже ${LIVE_SESSIONS_MAX}: заверши одну из них`, 'limit');
    const cwd = path.resolve(typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : defaultCwd);
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new SessionError(400, `Директория не найдена: ${cwd}`);
    let tags: string[];
    let flags: ReturnType<typeof sessionFlags>;
    try {
      tags = runTagSlugs(body.tags);
      for (const t of tags) readTag(t);
      flags = sessionFlags(body);
      if (body.saveTag !== undefined && typeof body.saveTag !== 'boolean') throw new Error('saveTag — true или false');
    } catch (err) {
      throw new SessionError(400, errMsg(err));
    }
    const bin = this.deps.findClaude();
    if (!bin) throw new SessionError(400, 'claude не найден: установи Claude Code (claude.ai/code) и проверь, что он есть в PATH', 'no_claude');
    // теги — последними: ошибка выше не оставит пустой тег на диске. Новый слаг — тег задачи
    for (const t of tags) createTag(t);
    const id = randomUUID();
    const now = new Date().toISOString();
    const rec: SessionRecord = {
      id,
      name: sessionName(body.name, tags, cwd),
      cwd,
      tags,
      ...flags,
      saveTag: body.saveTag !== false,
      claudeSessionIds: [],
      createdAt: now,
      lastActivityAt: now,
      turns: 0,
    };
    const s = newLive(rec, 'starting');
    this.sessions.set(id, s);
    try {
      this.spawn(s, kit, bin, port, { claudeSessionId: id, resume: false }, sizeOf(body));
    } catch (err) {
      this.sessions.delete(id);
      throw new SessionError(500, `claude не запустился: ${errMsg(err)}`);
    }
    return this.view(s);
  }

  /** Новый процесс claude для сессии: новый токен, папки и запреты по текущим тегам. */
  private spawn(s: Live, kit: PtyKit, bin: string, port: number, conv: { claudeSessionId: string; resume: boolean }, size: { cols: number; rows: number }): void {
    const r = s.rec;
    const filesDir = this.filesDir(r.id);
    fs.mkdirSync(filesDir, { recursive: true });
    const tags = readSessionTags(r.tags, readTag);
    const artifacts = sessionReadTargets(tags, this.deps.runsDir).dirs.filter((d) => isInside(d, this.deps.runsDir));
    const dirs = launchDirs(sessionTagDirs(tags, this.deps.runsDir), r.cwd, filesDir, artifacts);
    s.token = randomBytes(32).toString('hex');
    const args = sessionArgs({ id: r.id, token: s.token, port, ...conv, name: r.name, ...dirs, model: r.model, permissionMode: r.permissionMode });
    // CLAUDE.md ищется только в папках тегов: папка перетащенных файлов — не повод
    const proc = kit.spawn(bin, args, { name: 'xterm-256color', ...size, cwd: r.cwd, env: sessionEnv(this.deps.env(), dirs.addDirs.length > 1) });
    const pty = new PtySession(proc, kit.mirror(size.cols, size.rows), size);
    Object.assign(s, { pty, status: 'starting', injected: null, started: false, trustNow: false, sawTrust: false, spawnedAt: Date.now(), lastHookAt: Date.now() });
    delete r.endedAt;
    delete r.exitCode;
    delete r.outcome;
    this.save(s);
    // «Продолжить» и перезапуск: открытые экраны переходят к новому процессу сами
    for (const conn of s.sockets.values()) {
      if (!conn.size) continue;
      conn.attached?.detach(conn.client);
      conn.attached = pty;
      pty.attach(conn.client, conn.size);
    }
    // пока нет SessionStart: следим за диалогом доверия на экране и за «теги не доставлены»
    s.watch = setInterval(() => this.watchStart(s), 2000);
    s.watch.unref();
    // сбой записи на диск (папку удалили, нет места) не должен уронить сервер с идущими запусками
    void pty.done.then((e) => this.exited(s, pty, e.exitCode)).catch((err: unknown) => console.error('сессия: выход claude —', errMsg(err)));
    // версию — на каждом запуске: claude обновляется сам, пока сервер живёт
    void this.deps.version(bin)
      .then((v) => {
        if (v && s.rec.claudeVersion !== v) {
          s.rec.claudeVersion = v;
          this.save(s);
          this.changed(s);
        }
      })
      .catch((err: unknown) => console.error('сессия: версия claude —', errMsg(err)));
    this.pollAgents(bin);
  }

  private watchStart(s: Live): void {
    if (!s.pty?.alive || s.injected !== null) {
      clearInterval(s.watch);
      return;
    }
    const before = this.delivery(s);
    s.trustNow = TRUST_PROMPT_RE.test(s.pty.mirror.text());
    if (s.trustNow) s.sawTrust = true;
    if (this.delivery(s) !== before) this.changed(s);
  }

  /**
   * Выход процесса — единственный источник «завершена». Без единого SessionStart — отдельный исход. Зеркало отпускаем:
   * остаётся снимок последнего экрана, его получает и новое подключение.
   */
  private exited(s: Live, pty: PtySession, code: number): void {
    if (s.pty !== pty) return;
    clearInterval(s.watch);
    if (!s.started && TRUST_PROMPT_RE.test(pty.mirror.text())) s.sawTrust = true;
    s.screen = { d: pty.mirror.serialize(), cols: pty.cols, rows: pty.rows };
    s.pty = null;
    s.status = 'ended';
    s.rec.endedAt = new Date().toISOString();
    s.rec.lastActivityAt = s.rec.endedAt;
    s.rec.exitCode = code;
    if (!s.started && s.injected === null) {
      const outcome = s.sawTrust ? 'untrusted' : code !== 0 ? 'failed' : undefined;
      if (outcome) s.rec.outcome = outcome;
    }
    if (!s.restarting && this.wantsSummary(s)) {
      // при остановке сервера сессия саммари не успела бы и тратила бы деньги без спроса: пометка и кнопка
      if (s.appClosed) s.rec.summaryPending = 'app-closed';
      else void this.summarize(s).catch((err: unknown) => console.error('сессия: саммари —', errMsg(err)));
    }
    pty.broadcast({ t: 'x', code });
    this.changed(s);
    this.save(s);
    this.saveScreen(s);
  }

  // --- правки

  setTags(id: string, body: Record<string, unknown>): SessionView {
    const s = this.get(id);
    let tags: string[];
    try {
      tags = runTagSlugs(body.tags);
      for (const t of tags) readTag(t);
    } catch (err) {
      throw new SessionError(400, errMsg(err));
    }
    for (const t of tags) createTag(t);
    s.rec.tags = tags;
    this.save(s);
    this.changed(s);
    return this.view(s);
  }

  rename(id: string, body: Record<string, unknown>): SessionView {
    const s = this.get(id);
    if (typeof body.name !== 'string') throw new SessionError(400, 'name — строка');
    s.rec.name = sessionName(body.name, s.rec.tags, s.rec.cwd);
    this.save(s);
    this.changed(s);
    return this.view(s);
  }

  /** «Завершить»: SIGHUP, claude отправляет SessionEnd и выходит. */
  async end(id: string): Promise<SessionView> {
    const s = this.get(id);
    await s.pty?.stop();
    return this.view(s);
  }

  /**
   * «Продолжить»: новый процесс claude в той же папке с текущими тегами (папки и запреты — заново). Транскрипт последнего
   * разговора есть — --resume, нет (не было ни одного сообщения) — новый разговор. Адрес /sessions/<id> тот же.
   */
  async resume(id: string, port: number, size?: { cols: number; rows: number }): Promise<SessionView> {
    const s = this.get(id);
    if (s.pty?.alive) throw new SessionError(409, 'Сессия ещё идёт');
    const kit = await this.deps.kit();
    if (!kit) throw new SessionError(501, `Терминал недоступен: node-pty не загрузился (${ptyKitError()})`, 'no_pty');
    if (this.stopping) throw new SessionError(503, 'Сервер останавливается');
    if (this.liveCount() >= LIVE_SESSIONS_MAX) throw new SessionError(409, `Живых сессий уже ${LIVE_SESSIONS_MAX}: заверши одну из них`, 'limit');
    if (!fs.statSync(s.rec.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new SessionError(400, `Папки сессии больше нет: ${s.rec.cwd}`);
    const bin = this.deps.findClaude();
    if (!bin) throw new SessionError(400, 'claude не найден: установи Claude Code (claude.ai/code) и проверь, что он есть в PATH', 'no_claude');
    const target = resumeTarget(s.rec);
    try {
      this.spawn(s, kit, bin, port, target ? { claudeSessionId: target, resume: true } : { claudeSessionId: randomUUID(), resume: false }, size ?? s.screen ?? DEFAULT_SIZE);
    } catch (err) {
      throw new SessionError(500, `claude не запустился: ${errMsg(err)}`);
    }
    return this.view(s);
  }

  /**
   * «Перезапустить с тегами»: --add-dir в живом claude не меняется, а папки тегов, добавленных на ходу, нужны ему без
   * вопросов. Процесс гасится и поднимается заново тем же разговором (--resume) с пересчитанными папками; экран
   * переходит к новому процессу, саммари на этом выходе не пишется.
   */
  async restart(id: string, port: number): Promise<SessionView> {
    const s = this.get(id);
    if (!s.pty?.alive) throw new SessionError(409, 'Сессия не идёт: её можно продолжить');
    const size = { cols: s.pty.cols, rows: s.pty.rows };
    s.restarting = true;
    try {
      await s.pty.stop();
    } finally {
      s.restarting = false;
    }
    return this.resume(id, port, size);
  }

  /** Удалить запись сессии agentgraph (папку с журналом и файлами); транскрипт Claude остаётся. Живую — нельзя. */
  remove(id: string): void {
    const s = this.get(id);
    if (s.pty?.alive || s.summarizing) throw new SessionError(409, s.summarizing ? 'Пишется саммари: дождись его' : 'Сессия ещё идёт: сначала заверши её');
    for (const ws of s.sockets.keys()) ws.terminate();
    fs.rmSync(path.join(this.deps.dir, s.rec.id), { recursive: true, force: true });
    this.sessions.delete(s.rec.id);
  }

  // --- саммари тегов задач

  /** Есть что записать: галочка, ходы после прошлого саммари и хоть один тег задачи. */
  private wantsSummary(s: Live): boolean {
    return s.rec.saveTag && newTurns(s.rec) > 0 && readSessionTags(s.rec.tags, readTag).task.length > 0;
  }

  /** «Обновить саммари»: в любой момент, только ходы после прошлого саммари. Ответ — сразу, саммари пишется в фоне. */
  startSummary(id: string): SessionView {
    const s = this.get(id);
    if (s.summarizing) throw new SessionError(409, 'Саммари уже пишется');
    if (this.stopping) throw new SessionError(503, 'Сервер останавливается');
    if (!newTurns(s.rec)) throw new SessionError(409, 'Новых ходов с прошлого саммари нет');
    if (!readSessionTags(s.rec.tags, readTag).task.length) throw new SessionError(409, 'У сессии нет тегов задач: саммари есть только у них');
    void this.summarize(s).catch((err: unknown) => console.error('сессия: саммари —', errMsg(err)));
    return this.view(s);
  }

  /**
   * Сессия haiku на каждый тег задачи, по очереди: прошлое саммари тега и ходы с прошлого саммари → новое саммари.
   * Записи тега идут через queueTagSummary: две сессии одного тега не затрут друг друга. Ошибка одного тега не мешает
   * остальным; ходы считаются учтёнными, только если записались все теги.
   */
  private summarize(s: Live): Promise<void> {
    const abort = new AbortController();
    const p: Promise<void> = this.runSummary(s, abort).finally(() => this.summaries.delete(p));
    this.summaries.set(p, abort);
    return p;
  }

  /**
   * Прерывание (остановка сервера): идущая сессия саммари гасится, ждущие в очереди тега не начинаются; ходы не
   * считаются учтёнными, у сессии — пометка «приложение закрыли».
   */
  private async runSummary(s: Live, abort: AbortController): Promise<void> {
    if (s.summarizing) return;
    const all = readTurns(this.turnsFile(s.rec.id));
    const from = Math.min(s.rec.summarizedTurns ?? 0, all.length);
    const turns = all.slice(from);
    const task = readSessionTags(s.rec.tags, readTag).task;
    if (!turns.length || !task.length) return;
    s.summarizing = true;
    this.changed(s);
    const summary: SessionSummary = { at: '', tags: [], costUsd: 0 };
    const errors: Record<string, string> = {};
    try {
      for (const tag of task) {
        if (abort.signal.aborted) break;
        try {
          // в очереди тега могли ждать долго: за это время сервер начал останавливаться
          summary.costUsd += await queueTagSummary(tag.slug, () => (abort.signal.aborted ? Promise.reject(new Error('остановлено')) : this.summarizeTag(s, tag.slug, turns, abort)));
          summary.tags.push(tag.slug);
        } catch (err) {
          if (!abort.signal.aborted) errors[tag.slug] = errMsg(err);
        }
      }
    } finally {
      s.summarizing = false;
      summary.at = new Date().toISOString();
      if (abort.signal.aborted) {
        s.rec.summaryPending = 'app-closed';
        if (summary.tags.length) s.rec.summary = summary;
      } else {
        if (Object.keys(errors).length) summary.errors = errors;
        else {
          s.rec.summarizedTurns = from + turns.length;
          delete s.rec.summaryPending;
        }
        s.rec.summary = summary;
      }
      try {
        this.save(s);
      } finally {
        this.changed(s);
      }
    }
  }

  /** Одно саммари тега; пока шла сессия, саммари переписал запуск — считаем ещё раз от нового. Возвращает стоимость. */
  private async summarizeTag(s: Live, slug: string, turns: SessionTurn[], abort: AbortController): Promise<number> {
    let cost = 0;
    for (let attempt = 0; ; attempt++) {
      const prev = readTag(slug)?.summary ?? '';
      const res = await this.deps.summarize(sessionTagSummaryRequest(s.rec, slug, prev, turns, { model: 'haiku', abort }));
      if (abort.signal.aborted) throw new Error('остановлено');
      cost += res.costUsd;
      const text = dropRunPaths(parseTagSummary(res), this.deps.runsDir);
      if (attempt === 0 && (readTag(slug)?.summary ?? '') !== prev) continue;
      writeTagSummary(slug, text, { id: s.rec.id, flow: 'session', finishedAt: new Date().toISOString(), status: 'done', kind: 'session', title: s.rec.name });
      return cost;
    }
  }

  /** Файл, перетащенный в терминал: копия в папку файлов сессии (она в --add-dir), в ответ — абсолютный путь. */
  saveFile(id: string, body: unknown): { path: string } {
    const s = this.get(id);
    let file: { name: string; bytes: Buffer };
    try {
      [file] = validateAttachments([body]);
    } catch (err) {
      throw new SessionError(400, errMsg(err));
    }
    const dir = this.filesDir(s.rec.id);
    fs.mkdirSync(dir, { recursive: true });
    const name = dedupeNames([...fs.readdirSync(dir), file.name]).pop()!;
    const out = path.join(dir, name);
    fs.writeFileSync(out, file.bytes);
    return { path: out };
  }

  // --- хуки и MCP дочернего claude

  /** Сессия по токену из заголовка; нет сессии или токен чужой — 404 (401 запустил бы OAuth у MCP-клиента). */
  authed(id: string, headers: IncomingHttpHeaders): Live {
    const s = ID_RE.test(id) ? this.sessions.get(id) : undefined;
    const got = headers[SESSION_TOKEN_HEADER.toLowerCase()];
    if (!s || !s.token || typeof got !== 'string' || !timingSafeEqual(sha(got), sha(s.token))) throw new SessionError(404, 'Сессия не найдена');
    return s;
  }

  /** Хук: ответ и правка состояния; доставленный набор тегов запоминается, только когда ответ ушёл. */
  hook(s: Live, raw: unknown, res: ServerResponse): Record<string, unknown> {
    const input = parseHookInput(raw);
    if (!input) throw new SessionError(400, 'Это не вход хука Claude Code');
    const state: HookState = {
      tags: s.rec.tags,
      injected: s.injected,
      status: s.status,
      claudeSessionIds: s.rec.claudeSessionIds,
      transcriptPath: s.rec.transcriptPath,
      started: s.started,
      turns: s.rec.turns,
    };
    const r = handleHook(state, input, {
      readTags: (slugs) => readSessionTags(slugs, readTag),
      readTargets: (tags) => sessionReadTargets(tags, this.deps.runsDir),
      realpath: safeRealpath,
    });
    const p = r.patch;
    if (p.claudeSessionIds) s.rec.claudeSessionIds = p.claudeSessionIds;
    if (p.transcriptPath) s.rec.transcriptPath = p.transcriptPath;
    if (p.turns !== undefined) s.rec.turns = p.turns;
    if (p.started) s.started = true;
    if (p.status && s.pty?.alive) s.status = p.status;
    s.lastHookAt = Date.now();
    s.rec.lastActivityAt = new Date().toISOString();
    if (r.delivered) {
      const delivered = r.delivered;
      res.once('finish', () => {
        s.injected = delivered;
        this.changed(s);
      });
    }
    if (r.turn) this.appendTurn(s, r.turn);
    if (p.claudeSessionIds || p.turns !== undefined || p.transcriptPath) this.save(s);
    this.changed(s);
    return r.reply;
  }

  mcp(s: Live, body: unknown): { status: number; body?: unknown } {
    return mcpReply(body, () => {
      const t = readSessionTags(s.rec.tags, readTag);
      return { task: t.task.map((x) => x.slug), knowledge: t.knowledge.map((x) => x.slug) };
    });
  }

  // --- WebSocket экрана

  /**
   * upgrade на /api/sessions/:id/ws: Host — как у всего API, Origin — строго http://<Host>. Без Origin не пускаем:
   * браузер шлёт его всегда, а WebSocket без CORS дал бы любой открытой странице shell.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    // отказ — и сокет закрыт целиком (как у ws): полуоткрытый висел бы и держал server.close
    const deny = (status: number) => {
      socket.once('finish', () => socket.destroy());
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const bad = requestProblem('GET', req.headers);
    if (bad) return deny(bad.status);
    if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`) return deny(403);
    if (this.stopping) return deny(503);
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // кривой request-target (//[ и подобные): URL бросает, а upgrade — вне handle(), исключение уронило бы сервер
      return deny(400);
    }
    const m = pathname.match(/^\/api\/sessions\/([^/]+)\/ws$/);
    const s = m && ID_RE.test(m[1]) ? this.sessions.get(m[1]) : undefined;
    if (!s) return deny(404);
    this.wss ??= new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(s, ws));
  }

  private connect(s: Live, ws: WebSocket): void {
    const conn: Conn = { client: { send: (msg: string) => void (ws.readyState === ws.OPEN && ws.send(msg)) }, attached: null, snapSent: false };
    s.sockets.set(ws, conn);
    const { client } = conn;
    conn.client.send(JSON.stringify({ t: 's', session: this.view(s) } satisfies SessionWsServer));
    // ws зовёт обработчик синхронно из разбора кадра: исключение здесь уронило бы весь сервер
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as SessionWsClient | null;
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'r' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          conn.size = { cols: msg.cols, rows: msg.rows };
          if (s.pty && conn.attached !== s.pty) {
            conn.attached?.detach(client);
            conn.attached = s.pty;
            s.pty.attach(client, conn.size);
          } else if (s.pty) s.pty.resize(msg.cols, msg.rows);
          else if (!conn.attached && !conn.snapSent) {
            // процесса нет: последний экран завершённой сессии (после перезапуска сервера — с диска)
            conn.snapSent = true;
            const screen = (s.screen ??= this.readScreen(s.rec.id));
            if (screen) client.send(JSON.stringify({ t: 'snap', ...screen } satisfies SessionWsServer));
          }
        } else if (msg.t === 'i' && typeof msg.d === 'string') s.pty?.write(msg.d);
      } catch {
        /* кривой кадр клиента — пропускаем */
      }
    });
    ws.on('close', () => {
      s.sockets.delete(ws);
      conn.attached?.detach(client);
    });
    ws.on('error', () => ws.terminate());
  }

  /** Состояние сессии — подключённым экранам. */
  private changed(s: Live): void {
    const msg = JSON.stringify({ t: 's', session: this.view(s) } satisfies SessionWsServer);
    for (const ws of s.sockets.keys()) if (ws.readyState === ws.OPEN) ws.send(msg);
  }

  // --- запасной статус

  /**
   * Esc и некоторые сбои не шлют Stop: статус «работает» залипает. Раз в AGENTS_POLL_MS, если у живой сессии давно не
   * было хуков, сверяемся с `claude agents --json`; простаивающий разговор — «ждёт тебя».
   */
  private pollAgents(bin: string): void {
    if (this.poller) return;
    this.poller = setInterval(() => {
      const stale = [...this.sessions.values()].filter((s) => s.pty?.alive && s.status === 'working' && Date.now() - s.lastHookAt > AGENTS_STALE_MS);
      if (!this.liveCount()) {
        clearInterval(this.poller!);
        this.poller = null;
        return;
      }
      if (!stale.length) return;
      this.deps.agents(bin).then((out) => {
        const idle = idleAgents(out);
        for (const s of stale) {
          const sid = s.rec.claudeSessionIds.at(-1);
          if (sid && idle.has(sid) && s.status === 'working' && s.pty?.alive) {
            s.status = 'waiting';
            this.changed(s);
          }
        }
      }, () => {});
    }, AGENTS_POLL_MS);
    this.poller.unref();
  }

  // --- диск и остановка

  private filesDir(id: string): string {
    return path.join(this.deps.dir, id, 'files');
  }

  private turnsFile(id: string): string {
    return path.join(this.deps.dir, id, 'turns.jsonl');
  }

  /** Журнал ходов: сообщение пользователя (UserPromptSubmit) и итоговый ответ (Stop) — источник саммари. */
  private appendTurn(s: Live, turn: { prompt: string } | { answer: string }): void {
    try {
      fs.appendFileSync(this.turnsFile(s.rec.id), JSON.stringify({ at: new Date().toISOString(), ...turn }) + '\n');
    } catch (err) {
      console.error('сессия: журнал ходов —', errMsg(err));
    }
  }

  /** Последний экран завершённой сессии на диске: после перезапуска сервера его покажет и новое подключение. */
  private saveScreen(s: Live): void {
    if (!s.screen) return;
    try {
      fs.writeFileSync(path.join(this.deps.dir, s.rec.id, 'screen.json'), JSON.stringify(s.screen));
    } catch {
      /* без снимка — пустой экран под карточкой */
    }
  }

  private readScreen(id: string): Live['screen'] {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.deps.dir, id, 'screen.json'), 'utf8')) as Live['screen'];
      return v && typeof v.d === 'string' && Number.isFinite(v.cols) && Number.isFinite(v.rows) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private save(s: Live): void {
    const dir = path.join(this.deps.dir, s.rec.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.json');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s.rec, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  /**
   * Остановка сервера: сначала рвём WebSocket (иначе server.close не завершится), потом SIGHUP всем claude с ожиданием
   * выхода — сервер ещё слушает, и SessionEnd доходит. Ждём не дольше timeoutMs.
   */
  async stopAll(timeoutMs = STOP_WAIT_MS): Promise<void> {
    this.stopping = true;
    for (const s of this.sessions.values()) {
      for (const ws of s.sockets.keys()) ws.terminate();
      s.sockets.clear();
      if (s.pty?.alive) s.appClosed = true;
    }
    // саммари: идущие гасим, ждущие в очереди тега не начнутся — иначе держали бы и запуски в той же очереди
    for (const abort of this.summaries.values()) abort.abort();
    await Promise.all([...this.sessions.values()].map((s) => s.pty?.stop(timeoutMs)));
    await Promise.race([Promise.allSettled([...this.summaries.keys()]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.wss?.close();
    this.wss = null;
  }
}

function newLive(rec: SessionRecord, status: SessionStatus): Live {
  return { rec, token: '', pty: null, status, injected: null, started: false, trustNow: false, sawTrust: false, spawnedAt: 0, lastHookAt: 0, sockets: new Map(), summarizing: false };
}

/** Ходов после прошлого саммари. */
const newTurns = (r: SessionRecord) => Math.max(0, r.turns - (r.summarizedTurns ?? 0));

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** session.json с диска: битый или чужой (id не совпадает с папкой) — undefined, сессия не показывается. */
function readRecord(file: string, id: string): SessionRecord | undefined {
  let raw: Partial<SessionRecord>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SessionRecord>;
  } catch {
    return undefined;
  }
  if (!raw || raw.id !== id || typeof raw.cwd !== 'string' || typeof raw.createdAt !== 'string') return undefined;
  return {
    ...raw,
    id,
    name: typeof raw.name === 'string' ? raw.name : id.slice(0, 8),
    cwd: raw.cwd,
    tags: strings(raw.tags),
    saveTag: raw.saveTag !== false,
    claudeSessionIds: strings(raw.claudeSessionIds),
    createdAt: raw.createdAt,
    lastActivityAt: typeof raw.lastActivityAt === 'string' ? raw.lastActivityAt : raw.createdAt,
    turns: Number.isFinite(raw.turns) ? Number(raw.turns) : 0,
  };
}

/** Ходы из журнала: сообщение открывает ход, ответ — последний к нему (Stop бывает и без нового сообщения). */
export function readTurns(file: string): SessionTurn[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: SessionTurn[] = [];
  for (const line of text.split('\n')) {
    let e: { prompt?: unknown; answer?: unknown };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    if (typeof e.prompt === 'string') out.push({ prompt: e.prompt });
    else if (typeof e.answer === 'string' && out.length) out[out.length - 1].answer = e.answer;
  }
  return out;
}

/** Вид тега по слагу, с кэшем на один ответ; нет тега — задача. */
function kindCache(): (slug: string) => TagKind {
  const cache = new Map<string, TagKind>();
  return (slug) => {
    let k = cache.get(slug);
    if (!k) {
      try {
        k = readTag(slug)?.kind ?? 'task';
      } catch {
        k = 'task';
      }
      cache.set(slug, k);
    }
    return k;
  };
}

function sizeOf(body: Record<string, unknown>): { cols: number; rows: number } {
  const cols = Number(body.cols);
  const rows = Number(body.rows);
  return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0 ? { cols: Math.min(500, Math.max(20, cols)), rows: Math.min(200, Math.max(5, rows)) } : DEFAULT_SIZE;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

// --- маршруты

let manager: SessionManager | null = null;

/** Реестр сессий процесса; тесты подставляют свои зависимости (поддельный pty). */
export function sessionManager(deps?: Partial<SessionDeps>): SessionManager {
  if (deps) manager = new SessionManager({ ...defaultSessionDeps(), ...deps });
  return (manager ??= new SessionManager(defaultSessionDeps()));
}

export type SessionsCtx = {
  readJson: (maxBytes?: number) => Promise<unknown>;
  defaultCwd: string;
};

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** /api/sessions*: true — запрос обработан. Ошибки SessionError — ответом с кодом, остальные — обработчику сервера. */
export async function sessionsRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: SessionsCtx): Promise<boolean> {
  const p = url.pathname;
  if (p !== '/api/sessions' && !p.startsWith('/api/sessions/')) return false;
  const method = req.method ?? 'GET';
  const mgr = sessionManager();
  const done = (status: number, body?: unknown) => {
    send(res, status, body);
    return true;
  };
  let m: RegExpMatchArray | null;
  try {
    if (!(await mgr.available())) throw new SessionError(501, `Терминал недоступен: node-pty не загрузился (${ptyKitError()})`, 'no_pty');
    if (p === '/api/sessions') {
      if (method === 'GET') return done(200, mgr.list() satisfies SessionList);
      if (method === 'POST') return done(201, (await mgr.create(asObject(await ctx.readJson()), req.socket.localPort ?? 0, ctx.defaultCwd)) satisfies SessionView);
    }
    // хуки и MCP — от дочернего claude: токен проверяется до чтения тела
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/hook$/)) && method === 'POST') {
      const s = mgr.authed(m[1], req.headers);
      return done(200, mgr.hook(s, await ctx.readJson(HOOK_BODY_MAX), res));
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/mcp$/))) {
      const s = mgr.authed(m[1], req.headers);
      // без потока сервер→клиент (GET) и без завершения сессии (DELETE): сервер без состояния
      if (method !== 'POST') return done(405, { error: 'Только POST' });
      const r = mgr.mcp(s, await ctx.readJson());
      return done(r.status, r.body);
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)$/)) && method === 'GET') return done(200, mgr.view(mgr.get(m[1])) satisfies SessionView);
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/tags$/)) && method === 'PUT') return done(200, mgr.setTags(m[1], asObject(await ctx.readJson())) satisfies SessionView);
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/name$/)) && method === 'PUT') return done(200, mgr.rename(m[1], asObject(await ctx.readJson())) satisfies SessionView);
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/end$/)) && method === 'POST') return done(200, (await mgr.end(m[1])) satisfies SessionView);
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/files$/)) && method === 'POST') return done(201, mgr.saveFile(m[1], await ctx.readJson(FILE_BODY_MAX)));
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/summary$/)) && method === 'POST') return done(202, mgr.startSummary(m[1]) satisfies SessionView);
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/continue$/)) && method === 'POST') {
      const body = asObject(await ctx.readJson());
      return done(200, (await mgr.resume(m[1], req.socket.localPort ?? 0, body.cols ? sizeOf(body) : undefined)) satisfies SessionView);
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/restart$/)) && method === 'POST') return done(200, (await mgr.restart(m[1], req.socket.localPort ?? 0)) satisfies SessionView);
    if ((m = p.match(/^\/api\/sessions\/([^/]+)$/)) && method === 'DELETE') {
      mgr.remove(m[1]);
      return done(200, { ok: true });
    }
    return false;
  } catch (err) {
    if (!(err instanceof SessionError)) throw err;
    return done(err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
}

/** Есть ли фича sessions: для features в /api/config. */
export const sessionsAvailable = () => sessionManager().available();
/** upgrade сервера: WebSocket экрана сессии; остальное — 404. */
export const sessionsUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => sessionManager().upgrade(req, socket, head);
/** Остановка сервера: WebSocket и claude. */
export const stopSessions = (timeoutMs?: number) => (manager ? manager.stopAll(timeoutMs) : Promise.resolve());
/** Названия живых сессий: подтверждение выхода в десктопе. */
export const liveSessionNames = () => (manager ? manager.liveNames() : []);
