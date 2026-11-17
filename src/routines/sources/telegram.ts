// Telegram: сообщения боту и в чатах, где он состоит. Live — long polling getUpdates; ответ — sendMessage.
// Чат по умолчанию (для ответов без адресата) запоминает первое сообщение /start. Адрес API — AGENTGRAPH_TELEGRAM_API.
import { BASE_MATCH, type SourceCtx, type SourceKind } from '../kind.js';
import type { RoutineEvent } from '../types.js';
import { cfgStr, firstLine, redact, sleep } from './util.js';

const DEFAULT_API = 'https://api.telegram.org';
const apiBase = (): string => (process.env.AGENTGRAPH_TELEGRAM_API || DEFAULT_API).replace(/\/+$/, '');
const LONG_POLL_S = 25;
const MIN_POLL_MS = 5_000;

type TgChat = { id: number; type?: string; title?: string; username?: string; first_name?: string; last_name?: string };
type TgUser = { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string };
export type TgMessage = { message_id: number; date: number; chat: TgChat; from?: TgUser; text?: string; caption?: string };
export type TgUpdate = { update_id: number; message?: TgMessage; channel_post?: TgMessage };
type TgReply<T> = { ok: boolean; result?: T; description?: string; error_code?: number };

type Cursor = { offset?: number; defaultChat?: number };

function token(ctx: SourceCtx): string {
  const t = ctx.secret('TELEGRAM_BOT_TOKEN');
  if (!t) throw new Error('Не задан ключ TELEGRAM_BOT_TOKEN');
  return t;
}

async function call<T>(ctx: SourceCtx, method: string, body: Record<string, unknown>): Promise<T> {
  const tok = token(ctx);
  let res: Response;
  try {
    res = await ctx.fetch(`${apiBase()}/bot${tok}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(`Telegram недоступен: ${redact((err as Error).message, tok)}`);
  }
  let json: TgReply<T>;
  try {
    json = (await res.json()) as TgReply<T>;
  } catch {
    throw new Error(`Telegram ответил ${res.status} не JSON`);
  }
  if (!json.ok) {
    const hint = json.error_code === 401 ? ' (токен бота не подошёл)' : json.error_code === 409 ? ' (у бота включён webhook или бота слушает другая программа)' : '';
    throw new Error(`Telegram ${method}: ${json.description ?? res.status}${hint}`);
  }
  return json.result as T;
}

const nameOfUser = (u?: TgUser): string => u?.username || [u?.first_name, u?.last_name].filter(Boolean).join(' ') || (u ? String(u.id) : '');
const nameOfChat = (c: TgChat): string => c.title || (c.username ? `@${c.username}` : '') || [c.first_name, c.last_name].filter(Boolean).join(' ') || String(c.id);

/** Сообщение Telegram → событие. id — update_id: он уникален и растёт. */
export function telegramEvent(slug: string, u: TgUpdate): RoutineEvent | undefined {
  const m = u.message ?? u.channel_post;
  if (!m) return undefined;
  const text = m.text ?? m.caption ?? '';
  if (!text.trim()) return undefined;
  const author = nameOfUser(m.from);
  const isCommand = text.trimStart().startsWith('/');
  return {
    source: slug,
    id: String(u.update_id),
    at: new Date(m.date * 1000).toISOString(),
    title: firstLine(text),
    text,
    link: m.chat.username ? `https://t.me/${m.chat.username}/${m.message_id}` : undefined,
    author: author || undefined,
    fields: { chat: nameOfChat(m.chat), chat_id: String(m.chat.id), chat_type: m.chat.type ?? '', author, is_command: isCommand, is_bot: Boolean(m.from?.is_bot), message_id: m.message_id },
    replyTo: { chat_id: m.chat.id, message_id: m.message_id },
  };
}

/** Один заход getUpdates: события и новый курсор. Первое /start запоминает чат по умолчанию. */
async function fetchUpdates(ctx: SourceCtx, timeout: number): Promise<{ events: RoutineEvent[]; raw: number }> {
  const cur = ((ctx.cursor.get() as Cursor | undefined) ?? {}) as Cursor;
  const updates = await call<TgUpdate[]>(ctx, 'getUpdates', { offset: cur.offset, timeout, allowed_updates: ['message', 'channel_post'] });
  if (!Array.isArray(updates) || !updates.length) return { events: [], raw: 0 };
  const next: Cursor = { ...cur };
  const out: RoutineEvent[] = [];
  for (const u of updates) {
    next.offset = Math.max(next.offset ?? 0, u.update_id + 1);
    const e = telegramEvent(ctx.slug, u);
    if (!e) continue;
    const text = e.text.trim();
    const m = u.message ?? u.channel_post;
    if (m && /^\/start(@\w+)?(\s|$)/.test(text)) next.defaultChat = m.chat.id;
    out.push(e);
  }
  ctx.cursor.set(next);
  return { events: out, raw: updates.length };
}

/** Токены ботов, которых сейчас слушает listen: второй getUpdates вытеснил бы long poll (409 Conflict). */
const listening = new Map<string, number>();
const BASELINE_MAX_ROUNDS = 100;

async function poll(ctx: SourceCtx): Promise<RoutineEvent[]> {
  // проверка на истории и пробная проверка зовут poll и при живом listen: история и так лежит в журнале ядра
  if ((listening.get(ctx.secret('TELEGRAM_BOT_TOKEN') ?? '') ?? 0) > 0) return [];
  return (await fetchUpdates(ctx, 0)).events;
}

async function listen(ctx: SourceCtx, emit: (events: RoutineEvent[]) => void): Promise<void> {
  const token = ctx.secret('TELEGRAM_BOT_TOKEN') ?? '';
  listening.set(token, (listening.get(token) ?? 0) + 1);
  try {
    // без курсора первый заход только запоминает позицию: накопленные сообщения не запускают рутины.
    // getUpdates отдаёт до 100 обновлений за раз — листаем, пока очередь не опустеет
    if (ctx.cursor.get() === undefined) {
      for (let round = 0; round < BASELINE_MAX_ROUNDS && !ctx.signal.aborted; round++) {
        if (!(await fetchUpdates(ctx, 0)).raw) break;
      }
      // курсор ставим даже если сообщений не было: следующий заход ждёт новое
      if (ctx.cursor.get() === undefined) ctx.cursor.set({});
    }
    while (!ctx.signal.aborted) {
      let events: RoutineEvent[];
      try {
        events = (await fetchUpdates(ctx, LONG_POLL_S)).events;
      } catch (err) {
        if (ctx.signal.aborted) return;
        throw err;
      }
      if (events.length) emit(events);
      else await sleep(MIN_POLL_MS / 5, ctx.signal);
    }
  } finally {
    const left = (listening.get(token) ?? 1) - 1;
    if (left > 0) listening.set(token, left);
    else listening.delete(token);
  }
}

async function reply(ctx: SourceCtx, target: Record<string, unknown> | undefined, text: string): Promise<{ link?: string }> {
  const cur = ((ctx.cursor.get() as Cursor | undefined) ?? {}) as Cursor;
  const fromTarget = target?.chat_id;
  const chat = typeof fromTarget === 'number' || typeof fromTarget === 'string' ? fromTarget : (cur.defaultChat ?? cfgStr(ctx.spec, 'chat_id'));
  if (chat === undefined || chat === '') throw new Error('Telegram: не знаю, в какой чат отвечать — отправьте боту /start или укажите чат в настройках источника');
  const replyTo = target?.message_id;
  // в группах ответ привязывается к сообщению, в личном чате — просто пишем
  const quote = typeof replyTo === 'number' && Number(chat) < 0 ? { reply_to_message_id: replyTo } : {};
  const r = await call<{ message_id?: number; chat?: TgChat }>(ctx, 'sendMessage', { chat_id: chat, text, ...quote });
  const username = r?.chat?.username;
  return { link: username && r?.message_id ? `https://t.me/${username}/${r.message_id}` : undefined };
}

export const telegramKind: SourceKind = {
  kind: 'telegram',
  title: 'Telegram',
  summary: 'Сообщения боту и в чатах, где он состоит',
  delivery: 'live',
  minEveryMs: MIN_POLL_MS,
  setup: [
    { key: 'TELEGRAM_BOT_TOKEN', label: 'Токен бота', placeholder: '123456:ABC-DEF…', secret: true, hint: 'Создайте бота у @BotFather и скопируйте токен. Напишите боту /start — этот чат станет чатом по умолчанию для ответов.' },
    { key: 'chat_id', label: 'Чат по умолчанию для ответов', placeholder: '123456789', optional: true, hint: 'Необязательно: без него ответы идут в чат, откуда написали /start.' },
  ],
  match: [
    ...BASE_MATCH,
    { key: 'chat', label: 'Чат', type: 'text' },
    { key: 'is_command', label: 'Это команда (/…)', type: 'bool' },
  ],
  poll,
  listen,
  reply,
  isSelf: (_ctx, e) => e.fields.is_bot === true,
  describe: (spec) => {
    const chat = cfgStr(spec, 'chat_id');
    return `Telegram: новые сообщения боту${chat ? ` (ответы по умолчанию в чат ${chat})` : ''}. Long polling getUpdates. Только чтение; ответ — sendMessage.`;
  },
};
