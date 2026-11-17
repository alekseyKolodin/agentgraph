// Фейковые внешние сервисы для e2e: Slack (Web API + Socket Mode), Telegram (Bot API с long polling) и простой HTTP со
// списком записей (команда curl у «своей команды» и подключения словами). Сервер agentgraph ходит в них по
// AGENTGRAPH_SLACK_API, AGENTGRAPH_TELEGRAM_API и адресу в команде; тест кладёт сообщения и читает, что ему ответили.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

type Handler = (req: http.IncomingMessage, url: URL, body: string) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;

async function listen(handler: Handler): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        try {
          const r = await handler(req, url, body);
          res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r.json));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const close = (s: http.Server) => new Promise<void>((resolve) => {
  s.closeAllConnections?.();
  s.close(() => resolve());
});

// ================================================================ Slack

export const SLACK_BOT_USER = 'U_BOT';
export const SLACK_BOT_ID = 'B_BOT';
export const SLACK_TOKEN = 'xoxb-e2e-token';
export const SLACK_APP_TOKEN = 'xapp-e2e-token';

export type SlackMsg = { ts: string; channel: string; text: string; user?: string; bot_id?: string; thread_ts?: string; subtype?: string };
export type SlackPost = { channel: string; text: string; thread_ts?: string; at: number };

export class FakeSlack {
  base = '';
  readonly channels = [
    { id: 'C_BUGS', name: 'bugs' },
    { id: 'C_GENERAL', name: 'general' },
  ];
  readonly users: Record<string, string> = { U_ANNA: 'anna', U_PETR: 'petr', [SLACK_BOT_USER]: 'agentgraph' };
  /** Все сообщения по каналам (старые первыми). */
  readonly history = new Map<string, SlackMsg[]>();
  /** Что прислал agentgraph через chat.postMessage. */
  readonly posts: SlackPost[] = [];
  private server?: http.Server;
  private wss?: WebSocketServer;
  private sockets = new Set<WebSocket>();
  private seq = 0;
  private lastTs = 0;
  private connected: Array<() => void> = [];

  async start(): Promise<this> {
    const { server, base } = await listen((req, url, body) => this.handle(req, url, body));
    this.server = server;
    this.base = `${base}/api`;
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.add(ws);
        ws.on('close', () => this.sockets.delete(ws));
        ws.send(JSON.stringify({ type: 'hello', num_connections: this.sockets.size }));
        for (const f of this.connected.splice(0)) f();
      });
    });
    return this;
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.wss?.close();
    if (this.server) await close(this.server);
  }

  /** Сколько сейчас открыто соединений Socket Mode. */
  get sockets_open(): number {
    return this.sockets.size;
  }

  /** Дождаться, пока agentgraph откроет Socket Mode (слушатель источника поднялся). */
  async waitConnected(timeoutMs = 15_000): Promise<void> {
    if (this.sockets.size) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Slack Socket Mode: agentgraph не подключился')), timeoutMs);
      this.connected.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private nextTs(): string {
    // ts Slack растут и уникальны: секунды.микросекунды
    const now = Math.max(Date.now() / 1000, this.lastTs + 0.000001);
    this.lastTs = now;
    return now.toFixed(6);
  }

  private add(m: SlackMsg): SlackMsg {
    const list = this.history.get(m.channel) ?? [];
    list.push(m);
    this.history.set(m.channel, list);
    return m;
  }

  /** Сообщение в историю канала без события Socket Mode (уже было до подключения). */
  seed(channel: string, text: string, user = 'U_ANNA', at?: Date): SlackMsg {
    const ts = at ? (at.getTime() / 1000).toFixed(6) : this.nextTs();
    return this.add({ ts, channel: this.channelId(channel), text, user });
  }

  /** Человек пишет в канал: сообщение в историю и событие в Socket Mode. */
  say(channel: string, text: string, user = 'U_ANNA', o: { thread_ts?: string; bot_id?: string } = {}): SlackMsg {
    const m = this.add({ ts: this.nextTs(), channel: this.channelId(channel), text, user, ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}), ...(o.bot_id ? { bot_id: o.bot_id } : {}) });
    this.push(m);
    return m;
  }

  private push(m: SlackMsg): void {
    const envelope = { envelope_id: `env-${++this.seq}`, type: 'events_api', accepts_response_payload: false, payload: { type: 'event_callback', event: { type: 'message', ...m } } };
    for (const ws of this.sockets) ws.send(JSON.stringify(envelope));
  }

  channelId(nameOrId: string): string {
    return this.channels.find((c) => c.name === nameOrId.replace(/^#/, '') || c.id === nameOrId)?.id ?? nameOrId;
  }

  /** Ответы agentgraph в тред сообщения. */
  repliesTo(m: SlackMsg): SlackPost[] {
    return this.posts.filter((p) => p.channel === m.channel && p.thread_ts === m.ts);
  }

  private handle(req: http.IncomingMessage, url: URL, body: string): { status?: number; json: unknown } {
    const method = url.pathname.replace(/^\/api\//, '');
    const auth = req.headers.authorization ?? '';
    const tokenOk = method === 'apps.connections.open' ? auth === `Bearer ${SLACK_APP_TOKEN}` : auth === `Bearer ${SLACK_TOKEN}`;
    if (!tokenOk) return { json: { ok: false, error: 'invalid_auth' } };
    const q = url.searchParams;
    switch (method) {
      case 'auth.test':
        return { json: { ok: true, user_id: SLACK_BOT_USER, bot_id: SLACK_BOT_ID, url: 'https://e2e.slack.test/', team: 'e2e' } };
      case 'users.conversations':
      case 'conversations.list':
        return { json: { ok: true, channels: this.channels, response_metadata: { next_cursor: '' } } };
      case 'conversations.info': {
        const ch = this.channels.find((c) => c.id === q.get('channel'));
        return { json: ch ? { ok: true, channel: ch } : { ok: false, error: 'channel_not_found' } };
      }
      case 'users.info': {
        const id = q.get('user') ?? '';
        return { json: { ok: true, user: { id, name: this.users[id] ?? id } } };
      }
      case 'conversations.history': {
        const oldest = Number(q.get('oldest') ?? 0);
        const limit = Number(q.get('limit') ?? 100);
        const list = (this.history.get(q.get('channel') ?? '') ?? []).filter((m) => !oldest || Number(m.ts) > oldest);
        // Slack отдаёт новые первыми
        return { json: { ok: true, messages: list.slice(-limit).reverse(), has_more: false } };
      }
      case 'chat.postMessage': {
        const b = JSON.parse(body || '{}') as { channel: string; text: string; thread_ts?: string };
        this.posts.push({ channel: b.channel, text: b.text, ...(b.thread_ts ? { thread_ts: b.thread_ts } : {}), at: Date.now() });
        // как настоящий Slack: своё же сообщение бота приходит событием в Socket Mode (петля на себя)
        const m = this.add({ ts: this.nextTs(), channel: b.channel, text: b.text, user: SLACK_BOT_USER, bot_id: SLACK_BOT_ID, ...(b.thread_ts ? { thread_ts: b.thread_ts } : {}) });
        this.push(m);
        return { json: { ok: true, channel: b.channel, ts: m.ts, message: m } };
      }
      case 'apps.connections.open': {
        const port = (this.server!.address() as AddressInfo).port;
        return { json: { ok: true, url: `ws://127.0.0.1:${port}/socket` } };
      }
      default:
        return { json: { ok: false, error: `unknown_method ${method}` } };
    }
  }
}

// ================================================================ Telegram

export const TELEGRAM_TOKEN = '123456:E2E-TOKEN';

type TgUpdate = { update_id: number; message: { message_id: number; date: number; chat: { id: number; type: string; title?: string; first_name?: string }; from: { id: number; is_bot: boolean; username?: string; first_name?: string }; text: string } };
export type TgSent = { chat_id: number | string; text: string; reply_to_message_id?: number; at: number };

export class FakeTelegram {
  base = '';
  readonly updates: TgUpdate[] = [];
  readonly sent: TgSent[] = [];
  /** Сколько раз agentgraph спросил getUpdates (по нему видно, что слушатель жив). */
  polls = 0;
  /** Сколько заходов long polling сейчас висят в ожидании новых сообщений. */
  waiting = 0;
  private server?: http.Server;
  private waiters: Array<() => void> = [];
  private nextUpdate = 1000;
  private nextMessage = 1;

  async start(): Promise<this> {
    const { server, base } = await listen((_req, url, body) => this.handle(url, body));
    this.server = server;
    this.base = base;
    return this;
  }

  async stop(): Promise<void> {
    for (const w of this.waiters.splice(0)) w();
    if (this.server) await close(this.server);
  }

  /** Человек пишет боту (chatId > 0 — личный чат, < 0 — группа). */
  say(text: string, o: { chatId?: number; user?: string; isBot?: boolean } = {}): TgUpdate {
    const chatId = o.chatId ?? 4242;
    const u: TgUpdate = {
      update_id: this.nextUpdate++,
      message: {
        message_id: this.nextMessage++,
        date: Math.floor(Date.now() / 1000),
        chat: chatId > 0 ? { id: chatId, type: 'private', first_name: o.user ?? 'anna' } : { id: chatId, type: 'group', title: 'bugs' },
        from: { id: o.isBot ? 999 : 77, is_bot: Boolean(o.isBot), username: o.user ?? 'anna' },
        text,
      },
    };
    this.updates.push(u);
    for (const w of this.waiters.splice(0)) w();
    return u;
  }

  /** Дождаться, пока слушатель agentgraph повиснет в long polling (прошёл baseline и ждёт новые сообщения). */
  async waitListening(timeoutMs = 15_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.waiting < 1) {
      if (Date.now() > until) throw new Error('Telegram: agentgraph не спрашивает getUpdates');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async handle(url: URL, body: string): Promise<{ status?: number; json: unknown }> {
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m) return { status: 404, json: { ok: false, error_code: 404, description: 'Not Found' } };
    if (m[1] !== TELEGRAM_TOKEN) return { status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } };
    const b = JSON.parse(body || '{}') as Record<string, unknown>;
    if (m[2] === 'getUpdates') {
      this.polls++;
      const offset = Number(b.offset ?? 0);
      const timeout = Math.min(Number(b.timeout ?? 0), 25);
      const pending = () => this.updates.filter((u) => u.update_id >= offset);
      if (!pending().length && timeout > 0) {
        this.waiting++;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, timeout * 1000);
          this.waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
        this.waiting--;
      }
      return { json: { ok: true, result: pending() } };
    }
    if (m[2] === 'sendMessage') {
      this.sent.push({ chat_id: b.chat_id as number, text: String(b.text), ...(typeof b.reply_to_message_id === 'number' ? { reply_to_message_id: b.reply_to_message_id } : {}), at: Date.now() });
      return { json: { ok: true, result: { message_id: this.nextMessage++, chat: { id: b.chat_id, type: 'private' }, text: b.text } } };
    }
    if (m[2] === 'getMe') return { json: { ok: true, result: { id: 999, is_bot: true, username: 'e2e_bot' } } };
    return { json: { ok: false, error_code: 404, description: `unknown method ${m[2]}` } };
  }
}

// ================================================================ HTTP со списком записей

export const FAKE_API_KEY = 'fake-api-key-e2e';

export type Item = { id: string; title: string; text?: string; at?: string; author?: string };

/** GET /items → { items: [...] } с ключом в Authorization; GET /plain → тот же список без ключа. */
export class FakeItems {
  base = '';
  readonly items: Item[] = [];
  requests = 0;
  private server?: http.Server;

  async start(): Promise<this> {
    const { server, base } = await listen((req, url) => {
      this.requests++;
      if (url.pathname === '/items') {
        if (req.headers.authorization !== `Bearer ${FAKE_API_KEY}`) return { status: 401, json: { error: 'bad key' } };
        return { json: { items: this.items } };
      }
      if (url.pathname === '/plain') return { json: this.items };
      return { status: 404, json: { error: 'not found' } };
    });
    this.server = server;
    this.base = base;
    return this;
  }

  add(item: Omit<Item, 'at'> & { at?: string }): Item {
    const it = { at: new Date().toISOString(), ...item };
    this.items.push(it);
    return it;
  }

  async stop(): Promise<void> {
    if (this.server) await close(this.server);
  }
}
