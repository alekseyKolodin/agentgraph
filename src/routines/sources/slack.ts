// Slack: сообщения в каналах, личках и групповых личках. Live — Socket Mode через ws (если задан SLACK_APP_TOKEN), иначе опрос conversations.history.
// Базовый адрес API — AGENTGRAPH_SLACK_API (фейковый сервер в e2e). Токены в ошибки и журнал не попадают.
import { WebSocket } from 'ws';
import { BASE_MATCH, type SourceCtx, type SourceKind } from '../kind.js';
import { loadProfile } from '../../settings.js';
import type { RoutineEvent } from '../types.js';
import { cfgList, firstLine, isoOfSlackTs, parseEvery, redact, sleep } from './util.js';

const DEFAULT_API = 'https://slack.com/api';
const apiBase = (): string => (process.env.AGENTGRAPH_SLACK_API || DEFAULT_API).replace(/\/+$/, '');
const MIN_POLL_MS = 30_000;
const FIRST_LIMIT = 20;
const PAGE_LIMIT = 50;
const CHANNELS_TTL_MS = 10 * 60_000;
/** Каналы, лички (im) и групповые лички (mpim). */
const CONV_TYPES = 'public_channel,private_channel,im,mpim';

type Channel = { id: string; name: string };
type Identity = { userId?: string; botId?: string; url?: string };

export type SlackMessage = {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  text?: string;
  files?: Array<{ name?: string; title?: string; url_private?: string }>;
};

type SlackReply = { ok?: boolean; error?: string; [k: string]: unknown };

// Состояние между вызовами одного токена: кто мы, каналы, имена. Ключ — токен: два источника на один токен делят кэш.
const identities = new Map<string, Identity>();
const channelCache = new Map<string, { at: number; list: Channel[] }>();
const userNames = new Map<string, string>();
const channelNames = new Map<string, string>();

/** Для тестов: кэши живут в модуле. */
export function resetSlackState(): void {
  identities.clear();
  channelCache.clear();
  userNames.clear();
  channelNames.clear();
}

function token(ctx: SourceCtx): string {
  const t = ctx.secret('SLACK_TOKEN');
  if (!t) throw new Error('Не задан ключ SLACK_TOKEN');
  return t;
}

async function api(ctx: SourceCtx, method: string, opts: { token?: string; query?: Record<string, string>; body?: Record<string, unknown> } = {}): Promise<SlackReply> {
  const tok = opts.token ?? token(ctx);
  const url = new URL(`${apiBase()}/${method}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: opts.body || method === 'apps.connections.open' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${tok}`, ...(opts.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctx.signal,
    });
  } catch (err) {
    throw new Error(`Slack недоступен: ${redact((err as Error).message, tok)}`);
  }
  if (res.status === 429) throw new Error(`Slack просит подождать (429, Retry-After ${res.headers.get('retry-after') ?? '?'} с)`);
  let json: SlackReply;
  try {
    json = (await res.json()) as SlackReply;
  } catch {
    throw new Error(`Slack ответил ${res.status} не JSON`);
  }
  if (!json.ok) throw new Error(`Slack ${method}: ${slackError(String(json.error ?? res.status))}`);
  return json;
}

function slackError(code: string): string {
  const hints: Record<string, string> = {
    invalid_auth: 'токен не подошёл (invalid_auth)',
    not_authed: 'нет токена (not_authed)',
    token_revoked: 'токен отозван (token_revoked)',
    missing_scope: 'у токена не хватает прав (missing_scope)',
    channel_not_found: 'канал не найден или бот не добавлен в него (channel_not_found)',
    not_in_channel: 'бот не состоит в канале (not_in_channel)',
  };
  return hints[code] ?? code;
}

/** Кто мы: id пользователя и бота, адрес рабочего пространства (для ссылок). Ошибка — пустой ответ: он нужен для ссылок и isSelf. */
async function identity(ctx: SourceCtx): Promise<Identity> {
  const tok = token(ctx);
  const known = identities.get(tok);
  if (known) return known;
  try {
    const r = await api(ctx, 'auth.test');
    const id: Identity = { userId: str(r.user_id), botId: str(r.bot_id), url: str(r.url)?.replace(/\/?$/, '/') };
    identities.set(tok, id);
    return id;
  } catch (err) {
    ctx.log(`Slack auth.test не удался: ${(err as Error).message}`);
    return {};
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const ID_RE = /^[CGD][A-Z0-9]+$/;

/** Каналы из настроек: названия и id → {id, name}. Пусто в настройках — все каналы, где состоит токен. */
async function channelsOf(ctx: SourceCtx): Promise<Channel[]> {
  const tok = token(ctx);
  const wanted = cfgList(ctx.spec, 'channels').map((c) => c.replace(/^#/, ''));
  const key = `${tok}|${wanted.join(',')}`;
  const cached = channelCache.get(key);
  if (cached && Date.now() - cached.at < CHANNELS_TTL_MS) return cached.list;
  let list: Channel[] = [];
  if (!wanted.length) {
    const r = await api(ctx, 'users.conversations', { query: { types: CONV_TYPES, exclude_archived: 'true', limit: '200' } });
    list = await namedConversations(ctx, r.channels);
  } else {
    const byName = wanted.filter((w) => !ID_RE.test(w));
    const all = byName.length ? await listAllChannels(ctx, 'public_channel,private_channel') : [];
    let dms: Channel[] | undefined;
    for (const w of wanted) {
      if (ID_RE.test(w)) list.push({ id: w, name: await nameOfChannel(ctx, w) });
      else {
        let hit = all.find((c) => c.name === w);
        if (!hit) {
          // не канал — возможно, личка: имя собеседника, с @ или без (лички и их имена запрашиваем только при нужде)
          dms ??= await listAllChannels(ctx, 'im,mpim');
          const who = w.replace(/^@/, '').toLowerCase();
          hit = dms.find((c) => c.name.toLowerCase() === who);
        }
        if (!hit) throw new Error(`Канал или личка «${w}» не найдены — проверьте название и что бот добавлен в канал или есть переписка с этим человеком`);
        list.push(hit);
      }
    }
  }
  for (const c of list) channelNames.set(c.id, c.name);
  channelCache.set(key, { at: Date.now(), list });
  return list;
}

type RawConv = { id?: string; name?: string; user?: string; is_im?: boolean };

/** Ответ Slack со списком бесед → {id, name}: у лички имя — имя собеседника (в ответе у неё только id пользователя). */
async function namedConversations(ctx: SourceCtx, raw: unknown): Promise<Channel[]> {
  const out: Channel[] = [];
  for (const c of (Array.isArray(raw) ? raw : []) as RawConv[]) {
    if (!c.id) continue;
    out.push({ id: c.id, name: c.user && (c.is_im || !c.name) ? await nameOfUser(ctx, c.user) : c.name ?? c.id });
  }
  return out;
}

async function listAllChannels(ctx: SourceCtx, types = CONV_TYPES): Promise<Channel[]> {
  const out: Channel[] = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const r = await api(ctx, 'conversations.list', { query: { types, exclude_archived: 'true', limit: '1000', ...(cursor ? { cursor } : {}) } });
    out.push(...(await namedConversations(ctx, r.channels)));
    cursor = str((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor) ?? '';
    if (!cursor) break;
  }
  return out;
}

async function nameOfChannel(ctx: SourceCtx, id: string): Promise<string> {
  const known = channelNames.get(id);
  if (known) return known;
  try {
    const r = await api(ctx, 'conversations.info', { query: { channel: id } });
    const c = r.channel as RawConv | undefined;
    const name = c?.user && (c.is_im || !c.name) ? await nameOfUser(ctx, c.user) : str(c?.name) ?? id;
    channelNames.set(id, name);
    return name;
  } catch {
    return id;
  }
}

async function nameOfUser(ctx: SourceCtx, id: string): Promise<string> {
  const known = userNames.get(id);
  if (known) return known;
  try {
    const r = await api(ctx, 'users.info', { query: { user: id } });
    const u = r.user as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
    const name = u?.profile?.display_name || u?.real_name || u?.profile?.real_name || u?.name || id;
    userNames.set(id, name);
    return name;
  } catch {
    return id;
  }
}

/** Служебные сообщения (вошёл в канал, правка, удаление) событиями не считаются. */
const KEPT_SUBTYPES = new Set(['bot_message', 'thread_broadcast', 'file_share']);
export function isUserMessage(m: SlackMessage): boolean {
  if (!m.ts) return false;
  if (m.subtype && !KEPT_SUBTYPES.has(m.subtype)) return false;
  return Boolean(m.text?.trim() || m.files?.length);
}

/** Обращено ко мне: упомянут <@id> или это личка (id канала на D), если автор не я сам. me — id пользователя из профиля или владельца токена. */
function toMe(ch: Channel, m: SlackMessage, me?: string): boolean {
  if (!me || m.user === me) return false;
  return Boolean(m.text?.includes(`<@${me}>`)) || ch.id.startsWith('D');
}

/** Кто я для Slack: id из профиля, если задан (с токеном бота владелец токена — бот, не человек), иначе владелец токена. */
function myUserId(ident: Identity): string | undefined {
  return loadProfile().slackUserId || ident.userId;
}

/** Сообщение Slack → событие. author — имя автора, link — адрес рабочего пространства (https://acme.slack.com/). */
export function slackEvent(slug: string, ch: Channel, m: SlackMessage, extra: { author?: string; url?: string; me?: string } = {}): RoutineEvent {
  const text = m.text ?? '';
  const files = (m.files ?? []).map((f) => f.name || f.title || 'файл');
  const bot = Boolean(m.bot_id) || m.subtype === 'bot_message';
  const author = extra.author ?? m.username ?? m.bot_profile?.name ?? m.user ?? '';
  const thread = Boolean(m.thread_ts && m.thread_ts !== m.ts);
  return {
    source: slug,
    id: `${ch.id}:${m.ts}`,
    at: isoOfSlackTs(m.ts),
    title: firstLine(text) || (files.length ? `Файл: ${files[0]}` : '(пусто)'),
    text,
    link: extra.url ? `${extra.url}archives/${ch.id}/p${m.ts.replace('.', '')}` : undefined,
    author: author || undefined,
    fields: { channel: ch.name, channel_id: ch.id, thread, author, user: m.user ?? '', bot, bot_id: m.bot_id ?? '', files, ts: m.ts, thread_ts: m.thread_ts ?? '', subtype: m.subtype ?? '', to_me: toMe(ch, m, extra.me) },
    replyTo: { channel: ch.id, thread_ts: m.thread_ts ?? m.ts },
  };
}

async function toEvent(ctx: SourceCtx, ch: Channel, m: SlackMessage, ident: Identity): Promise<RoutineEvent> {
  const author = m.user ? await nameOfUser(ctx, m.user) : undefined;
  return slackEvent(ctx.slug, ch, m, { author, url: ident.url, me: myUserId(ident) });
}

type Cursor = { ts?: Record<string, string> };

/** Страниц истории за один опрос и тредов, у которых смотрим новые ответы: предел на случай, когда приложение не открывали неделю. */
const MAX_PAGES = 20;
const MAX_THREADS = 10;

/** Сообщения канала новее oldest: листаем по next_cursor, иначе Slack отдал бы 50 самых новых, а курсор перепрыгнул середину. */
async function historyOf(ctx: SourceCtx, ch: Channel, oldest: string | undefined): Promise<SlackMessage[]> {
  const all: SlackMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await api(ctx, 'conversations.history', { query: { channel: ch.id, limit: String(oldest ? PAGE_LIMIT : FIRST_LIMIT), ...(oldest ? { oldest } : {}), ...(cursor ? { cursor } : {}) } });
    all.push(...((Array.isArray(r.messages) ? r.messages : []) as SlackMessage[]));
    const next = str((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor);
    // первый заход берёт только последние сообщения: дальше листать незачем
    if (!oldest || !r.has_more || !next) break;
    cursor = next;
  }
  return all.filter((m) => m.ts);
}

/** Новые ответы в тредах, начатых в окне опроса (родитель в истории): conversations.history их не отдаёт. */
async function threadReplies(ctx: SourceCtx, ch: Channel, parents: SlackMessage[], oldest: string): Promise<SlackMessage[]> {
  const withNew = parents.filter((m) => (m.reply_count ?? 0) > 0 && m.latest_reply && Number(m.latest_reply) > Number(oldest) && (!m.thread_ts || m.thread_ts === m.ts)).slice(0, MAX_THREADS);
  const out: SlackMessage[] = [];
  for (const m of withNew) {
    const r = await api(ctx, 'conversations.replies', { query: { channel: ch.id, ts: m.ts, oldest, limit: '100' } });
    out.push(...((Array.isArray(r.messages) ? r.messages : []) as SlackMessage[]).filter((x) => x.ts && x.ts !== m.ts && Number(x.ts) > Number(oldest)));
  }
  return out;
}

async function poll(ctx: SourceCtx): Promise<RoutineEvent[]> {
  const ident = await identity(ctx);
  const channels = await channelsOf(ctx);
  const cursor = ((ctx.cursor.get() as Cursor | undefined) ?? {}) as Cursor;
  const ts = { ...(cursor.ts ?? {}) };
  const out: RoutineEvent[] = [];
  for (const ch of channels) {
    const oldest = ts[ch.id];
    const msgs = await historyOf(ctx, ch, oldest);
    if (oldest) msgs.push(...(await threadReplies(ctx, ch, msgs, oldest)));
    msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
    // канал добавили в уже работающий источник: его прошлое только запоминаем, рутины на него не запускаем
    const remember = !oldest && cursor.ts !== undefined;
    for (const m of msgs) {
      if (!remember && isUserMessage(m)) out.push(await toEvent(ctx, ch, m, ident));
      if (!ts[ch.id] || Number(m.ts) > Number(ts[ch.id])) ts[ch.id] = m.ts;
    }
    // пустой канал (новый или на самом первом заходе): точка отсчёта — сейчас, иначе следующий опрос принял бы канал за
    // «добавленный» и первое сообщение в нём только запомнил бы
    if (!ts[ch.id]) ts[ch.id] = `${Math.floor(Date.now() / 1000)}.000000`;
  }
  ctx.cursor.set({ ts });
  return out;
}

/** Без app-токена «live» — это опрос внутри listen: первый заход только запоминает курсор, старые сообщения не запускают рутины. */
async function pollLoop(ctx: SourceCtx, emit: (events: RoutineEvent[]) => void): Promise<void> {
  const every = Math.max(MIN_POLL_MS, parseEvery(ctx.spec.every) ?? MIN_POLL_MS);
  let baseline = ctx.cursor.get() === undefined;
  while (!ctx.signal.aborted) {
    const events = await poll(ctx);
    if (!baseline && events.length) emit(events);
    baseline = false;
    await sleep(every, ctx.signal);
  }
}

async function listen(ctx: SourceCtx, emit: (events: RoutineEvent[]) => void): Promise<void> {
  const app = ctx.secret('SLACK_APP_TOKEN');
  if (!app) return pollLoop(ctx, emit);
  const ident = await identity(ctx);
  const configured = cfgList(ctx.spec, 'channels').length > 0;
  const allowed = configured ? new Set((await channelsOf(ctx)).map((c) => c.id)) : undefined;
  // Slack штатно просит переподключиться (disconnect: refresh_requested раз в несколько часов): это не ошибка источника
  while (!ctx.signal.aborted) {
    const opened = await api(ctx, 'apps.connections.open', { token: app });
    const url = str(opened.url);
    if (!url) throw new Error('Slack apps.connections.open не вернул адрес соединения');
    const started = Date.now();
    const end = await socketSession(ctx, url, app, ident, allowed, emit);
    if (end === 'stop') return;
    // защита от петли, если сервер сразу же просит переподключиться снова
    if (Date.now() - started < RECONNECT_MIN_MS) await sleep(RECONNECT_MIN_MS, ctx.signal);
  }
}

const RECONNECT_MIN_MS = 1000;

/** Одно соединение Socket Mode. 'reconnect' — Slack попросил открыть новое, 'stop' — источник остановили; обрыв — ошибка. */
function socketSession(ctx: SourceCtx, url: string, app: string, ident: Identity, allowed: Set<string> | undefined, emit: (events: RoutineEvent[]) => void): Promise<'reconnect' | 'stop'> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let reconnect = false;
    const onAbort = (): void => ws.close();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    ws.on('message', (raw) => {
      void (async () => {
        let msg: { type?: string; envelope_id?: string; payload?: { event?: SlackMessage & { channel?: string; type?: string } } };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        // подтверждение конверта — сразу, иначе Slack пришлёт его повторно
        if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        if (msg.type === 'disconnect') {
          reconnect = true;
          return void ws.close();
        }
        const ev = msg.payload?.event;
        if (msg.type !== 'events_api' || !ev || ev.type !== 'message' || !ev.channel || !isUserMessage(ev)) return;
        if (allowed && !allowed.has(ev.channel)) return;
        const ch: Channel = { id: ev.channel, name: await nameOfChannel(ctx, ev.channel) };
        emit([await toEvent(ctx, ch, ev, ident)]);
      })().catch((err) => ctx.log(`Slack: событие не разобрано: ${(err as Error).message}`));
    });
    ws.on('error', (err) => {
      ctx.signal.removeEventListener('abort', onAbort);
      reject(new Error(`Slack Socket Mode: ${redact(err.message, app)}`));
    });
    ws.on('close', () => {
      ctx.signal.removeEventListener('abort', onAbort);
      if (ctx.signal.aborted) resolve('stop');
      else if (reconnect) resolve('reconnect');
      else reject(new Error('Slack Socket Mode: соединение закрыто'));
    });
  });
}

async function reply(ctx: SourceCtx, target: Record<string, unknown> | undefined, text: string): Promise<{ link?: string }> {
  const ident = await identity(ctx);
  // без адресата и без каналов в настройках «первый канал бота» — случайный (#general): лучше ошибка
  const channel = str(target?.channel) ?? (cfgList(ctx.spec, 'channels').length ? (await channelsOf(ctx))[0]?.id : undefined);
  if (!channel) throw new Error('Slack: не знаю, в какой канал отвечать — укажите канал в настройках источника');
  const threadTs = str(target?.thread_ts);
  const r = await api(ctx, 'chat.postMessage', { body: { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) } });
  const ts = str(r.ts);
  return { link: ts && ident.url ? `${ident.url}archives/${str(r.channel) ?? channel}/p${ts.replace('.', '')}` : undefined };
}

export const slackKind: SourceKind = {
  kind: 'slack',
  title: 'Slack',
  summary: 'Новые сообщения в каналах и личках Slack',
  delivery: 'live',
  minEveryMs: MIN_POLL_MS,
  setup: [
    { key: 'SLACK_TOKEN', label: 'Токен Slack', placeholder: 'xoxb-… или xoxp-…', secret: true, hint: 'Нужны права: channels:history, groups:history, channels:read, groups:read, users:read, chat:write. Для личек и групповых личек добавьте im:history, mpim:history, im:read, mpim:read.' },
    { key: 'SLACK_APP_TOKEN', label: 'Токен приложения для мгновенных сообщений', placeholder: 'xapp-…', secret: true, optional: true, hint: 'Включите Socket Mode в приложении и создайте токен с правом connections:write. Без него сообщения проверяются раз в 30 секунд, а ответы в тредах видны только у тредов, начатых после прошлой проверки.' },
    { key: 'channels', label: 'Каналы и лички', placeholder: 'bugs, alerts, @Анна', optional: true, hint: 'Названия каналов, имя собеседника (для лички, можно с @) или id через запятую. Пусто — все каналы, лички и групповые лички, где участвует бот.' },
  ],
  match: [
    ...BASE_MATCH,
    { key: 'channel', label: 'Канал', type: 'text' },
    { key: 'thread', label: 'Ответ в треде', type: 'bool' },
    { key: 'to_me', label: 'Обращено ко мне (упомянут или личка)', type: 'bool' },
    { key: 'bot', label: 'Написал бот', type: 'bool' },
    { key: 'files', label: 'Имена прикреплённых файлов', type: 'text' },
  ],
  poll,
  listen,
  reply,
  isSelf: (ctx, e) => {
    const tok = ctx.secret('SLACK_TOKEN');
    const ident = tok ? identities.get(tok) : undefined;
    const user = typeof e.fields.user === 'string' ? e.fields.user : '';
    const botId = typeof e.fields.bot_id === 'string' ? e.fields.bot_id : '';
    const mine = loadProfile().slackUserId;
    return Boolean((mine && user === mine) || (ident?.userId && user === ident.userId) || (ident?.botId && botId === ident.botId));
  },
  describe: (spec) => {
    const channels = cfgList(spec, 'channels');
    const where = channels.length ? channels.map((c) => (c.startsWith('@') ? c : `#${c.replace(/^#/, '')}`)).join(', ') : 'всех каналах и личках, где участвует бот';
    return `Slack: новые сообщения в ${where}. Соединение Socket Mode (если задан SLACK_APP_TOKEN) или опрос conversations.history раз в 30 секунд. Только чтение; ответ — chat.postMessage в тред.`;
  },
};
