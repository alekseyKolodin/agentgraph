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
import type { SessionList, SessionPermissionMode, SessionStatus, SessionTagChip, SessionView, SessionWsClient, SessionWsServer, TagKind } from './api-types.js';
import { ROOT, RUNS_DIR } from './paths.js';
import { requestProblem } from './server-guard.js';
import { createTag, readTag, runTagSlugs } from './tags.js';
import { isInside } from './artifacts.js';
import { dedupeNames, validateAttachments } from './attachments.js';
import {
  findClaude, handleHook, idleAgents, launchDirs, LIVE_SESSIONS_MAX, parseClaudeVersion, parseHookInput, readSessionTags, safeRealpath, sessionArgs, sessionEnv,
  sessionFlags, sessionName, sessionReadTargets, sessionTagDirs, SESSION_TOKEN_HEADER, TRUST_PROMPT_RE, type HookState,
} from './sessions.js';
import { mcpReply } from './sessions-mcp.js';
import { loadPtyKit, PtySession, ptyKitError, type PtyKit } from './sessions-pty.js';

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
};

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
  sockets: Set<WebSocket>;
  watch?: ReturnType<typeof setInterval>;
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
  private readonly versions = new Map<string, Promise<string | undefined>>();

  constructor(readonly deps: SessionDeps) {}

  /** Фича есть, если node-pty и зеркало загрузились. */
  async available(): Promise<boolean> {
    return (await this.deps.kit()) !== null;
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
    const s: Live = { rec, token: '', pty: null, status: 'starting', injected: null, started: false, trustNow: false, sawTrust: false, spawnedAt: 0, lastHookAt: 0, sockets: new Set() };
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
    // пока нет SessionStart: следим за диалогом доверия на экране и за «теги не доставлены»
    s.watch = setInterval(() => this.watchStart(s), 2000);
    s.watch.unref();
    // сбой записи на диск (папку удалили, нет места) не должен уронить сервер с идущими запусками
    void pty.done.then((e) => this.exited(s, pty, e.exitCode)).catch((err: unknown) => console.error('сессия: выход claude —', errMsg(err)));
    void this.version(bin)
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

  private version(bin: string): Promise<string | undefined> {
    let v = this.versions.get(bin);
    if (!v) this.versions.set(bin, (v = this.deps.version(bin)));
    return v;
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
    pty.broadcast({ t: 'x', code });
    this.changed(s);
    this.save(s);
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
    const deny = (status: number) => {
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const bad = requestProblem('GET', req.headers);
    if (bad) return deny(bad.status);
    if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`) return deny(403);
    if (this.stopping) return deny(503);
    const m = new URL(req.url ?? '/', 'http://localhost').pathname.match(/^\/api\/sessions\/([^/]+)\/ws$/);
    const s = m && ID_RE.test(m[1]) ? this.sessions.get(m[1]) : undefined;
    if (!s) return deny(404);
    this.wss ??= new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(s, ws));
  }

  private connect(s: Live, ws: WebSocket): void {
    s.sockets.add(ws);
    const client = { send: (msg: string) => ws.readyState === ws.OPEN && ws.send(msg) };
    let attached: PtySession | null = null;
    client.send(JSON.stringify({ t: 's', session: this.view(s) } satisfies SessionWsServer));
    let snapSent = false;
    // ws зовёт обработчик синхронно из разбора кадра: исключение здесь уронило бы весь сервер
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as SessionWsClient | null;
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'r' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          // «Продолжить» поднимает новый pty: первый же resize подключает к нему
          if (s.pty && attached !== s.pty) {
            attached?.detach(client);
            attached = s.pty;
            s.pty.attach(client, { cols: msg.cols, rows: msg.rows });
          } else if (s.pty) s.pty.resize(msg.cols, msg.rows);
          else if (!attached && !snapSent && s.screen) {
            // процесса нет: последний экран завершённой сессии
            snapSent = true;
            client.send(JSON.stringify({ t: 'snap', ...s.screen } satisfies SessionWsServer));
          }
        } else if (msg.t === 'i' && typeof msg.d === 'string') s.pty?.write(msg.d);
      } catch {
        /* кривой кадр клиента — пропускаем */
      }
    });
    ws.on('close', () => {
      s.sockets.delete(ws);
      attached?.detach(client);
    });
    ws.on('error', () => ws.terminate());
  }

  /** Состояние сессии — подключённым экранам. */
  private changed(s: Live): void {
    const msg = JSON.stringify({ t: 's', session: this.view(s) } satisfies SessionWsServer);
    for (const ws of s.sockets) if (ws.readyState === ws.OPEN) ws.send(msg);
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
      for (const ws of s.sockets) ws.terminate();
      s.sockets.clear();
    }
    await Promise.all([...this.sessions.values()].map((s) => s.pty?.stop(timeoutMs)));
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.wss?.close();
    this.wss = null;
  }
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
