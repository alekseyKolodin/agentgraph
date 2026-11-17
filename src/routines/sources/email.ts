// Почта: IMAP через curl (imaps://). Первый заход — UNSEEN за последнюю неделю, дальше — письма с UID больше запомненного.
// Пароль идёт в curl через конфиг со stdin (printf — встроенная команда шелла), в списке процессов его нет.
import { BASE_MATCH, type SourceCtx, type SourceKind } from '../kind.js';
import type { RoutineEvent } from '../types.js';
import { cfgStr, firstLine, isoOf, redact, truncate } from './util.js';

const MIN_POLL_MS = 60_000;
const MAX_NEW = 20;
const MAX_BYTES = 200_000;
/** Сколько байт текста письма просим у сервера: вложения и длинные цепочки не нужны. */
const PARTIAL_BYTES = 60_000;
const TEXT_MAX = 4000;
const WEEK_MS = 7 * 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Cursor = { lastUid?: number };
export type EmailDeps = { now: () => Date };

/** Строка в одинарных кавычках для sh. */
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Вставка в IMAP-команду: только безопасные символы, иначе пользователь протащил бы свои команды в запрос. */
function imapAtom(s: string, what: string): string {
  if (!/^[\w@.+\-]+$/.test(s)) throw new Error(`${what}: недопустимые символы`);
  return s;
}

export function imapDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

type Conn = { host: string; port: string; user: string; mailbox: string; from?: string };

function connOf(ctx: SourceCtx): Conn {
  const host = cfgStr(ctx.spec, 'host');
  const user = cfgStr(ctx.spec, 'user');
  if (!host) throw new Error('Не указан адрес почтового сервера (IMAP)');
  if (!user) throw new Error('Не указан логин почты');
  const from = cfgStr(ctx.spec, 'from');
  return { host: imapAtom(host, 'Адрес сервера'), port: imapAtom(cfgStr(ctx.spec, 'port') ?? '993', 'Порт'), user, mailbox: cfgStr(ctx.spec, 'mailbox') ?? 'INBOX', from: from ? imapAtom(from, 'Отправитель') : undefined };
}

/** curl к IMAP: логин и пароль — через конфиг на stdin. extra — аргументы после адреса. Код curl уходит в stderr: head скрыл бы его. */
function curlCommand(c: Conn, urlSuffix: string, extra: string): string {
  const esc = `esc() { printf '%s' "$1" | sed 's/[\\\\"]/\\\\&/g'; }`;
  const url = `imaps://${c.host}:${c.port}/${encodeURIComponent(c.mailbox)}${urlSuffix}`;
  return `${esc}; { printf 'user = "%s:%s"\\n' "$(esc "$EMAIL_USER")" "$(esc "$EMAIL_PASSWORD")" | curl -sS --max-time 40 -K - ${sq(url)} ${extra}; echo "${EXIT_MARK}$?" >&2; } | head -c ${MAX_BYTES}`;
}

const EXIT_MARK = '__curl_exit=';

async function imap(ctx: SourceCtx, c: Conn, urlSuffix: string, extra: string): Promise<string> {
  const password = ctx.secret('EMAIL_PASSWORD');
  if (!password) throw new Error('Не задан ключ EMAIL_PASSWORD');
  const r = await ctx.run(curlCommand(c, urlSuffix, extra), { env: { PATH: process.env.PATH ?? '', EMAIL_USER: c.user, EMAIL_PASSWORD: password }, timeoutMs: 60_000, signal: ctx.signal });
  const marked = new RegExp(`${EXIT_MARK}(\\d+)`).exec(r.stderr);
  const code = marked ? Number(marked[1]) : r.code;
  // 23 — head закрыл канал, когда ответ дошёл до предела: данных достаточно, это не ошибка
  if (code !== 0 && !(code === 23 && r.stdout.length > 0)) {
    const why = redact(r.stderr.replace(new RegExp(`${EXIT_MARK}\\d+`), ''), password).trim().split('\n').pop() ?? '';
    const hint = /\(67\)|login denied|authentication/i.test(r.stderr) ? ' — сервер не принял логин или пароль (для Gmail нужен пароль приложения)' : '';
    throw new Error(`Почта: ${why || `curl завершился с кодом ${code}`}${hint}`);
  }
  return r.stdout;
}

// ---------------------------------------------------------------- письмо

/**
 * Ответ `UID FETCH … (BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.n>)`: куски письма идут литералами `{длина}\r\n…`. Склеиваем их в письмо;
 * нет литералов (ответ уже письмо) — возвращаем как есть.
 */
export function fetchedMessage(out: string): string {
  const buf = Buffer.from(out, 'utf8');
  const scan = buf.toString('latin1');
  const parts: string[] = [];
  const re = /\{(\d+)\}\r?\n/g;
  let m: RegExpExecArray | null;
  let from = 0;
  while ((m = re.exec(scan.slice(from)))) {
    const start = from + m.index + m[0].length;
    const end = Math.min(start + Number(m[1]), buf.length);
    parts.push(buf.subarray(start, end).toString('utf8'));
    from = end;
    re.lastIndex = 0;
  }
  if (!parts.length) return out;
  const [head, ...rest] = parts;
  return /\n\r?\n$/.test(head) || !rest.length ? head + rest.join('') : `${head}\r\n${rest.join('')}`;
}

function decodeQuoted(s: string): Buffer {
  return Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
}

function toText(buf: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** =?utf-8?B?...?= и =?utf-8?Q?...?= в заголовках. */
export function decodeWords(s: string): string {
  return s
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs: string, enc: string, data: string) =>
      enc.toLowerCase() === 'b' ? toText(Buffer.from(data, 'base64'), cs) : toText(decodeQuoted(data.replace(/_/g, ' ')), cs),
    );
}

type Parsed = { headers: Record<string, string>; body: string };

function splitMessage(raw: string): Parsed {
  const norm = raw.replace(/\r\n/g, '\n');
  const i = norm.indexOf('\n\n');
  const head = i === -1 ? norm : norm.slice(0, i);
  const body = i === -1 ? '' : norm.slice(i + 2);
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m && !(m[1].toLowerCase() in headers)) headers[m[1].toLowerCase()] = m[2].trim();
  }
  return { headers, body };
}

const param = (header: string | undefined, name: string): string | undefined => new RegExp(`${name}\\s*=\\s*"?([^";\\s]+)"?`, 'i').exec(header ?? '')?.[1];

/** Текст письма: text/plain из multipart или само тело; HTML — без тегов. */
export function bodyText(p: Parsed): string {
  const ctype = p.headers['content-type'] ?? 'text/plain';
  const boundary = /multipart\//i.test(ctype) ? param(ctype, 'boundary') : undefined;
  if (boundary) {
    const parts = p.body.split(`--${boundary}`).slice(1).filter((x) => !x.startsWith('--'));
    const parsed = parts.map((x) => splitMessage(x.replace(/^\n/, '')));
    const best = parsed.find((x) => /text\/plain/i.test(x.headers['content-type'] ?? 'text/plain') && !/multipart/i.test(x.headers['content-type'] ?? '')) ?? parsed.find((x) => /multipart|text\/html/i.test(x.headers['content-type'] ?? ''));
    return best ? bodyText(best) : '';
  }
  const enc = (p.headers['content-transfer-encoding'] ?? '').toLowerCase();
  const charset = param(ctype, 'charset') ?? 'utf-8';
  const buf = enc === 'base64' ? Buffer.from(p.body.replace(/\s+/g, ''), 'base64') : enc === 'quoted-printable' ? decodeQuoted(p.body) : Buffer.from(p.body, 'utf8');
  const text = enc === 'quoted-printable' || enc === 'base64' ? toText(buf, charset) : p.body;
  return /text\/html/i.test(ctype) ? text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : text.trim();
}

function addressOf(h: string | undefined): string {
  const v = decodeWords(h ?? '');
  return /<([^>]+)>/.exec(v)?.[1] ?? v.trim();
}

/** Письмо → событие. */
export function emailEvent(slug: string, c: Pick<Conn, 'mailbox'>, uid: number, raw: string): RoutineEvent {
  const p = splitMessage(raw);
  const subject = decodeWords(p.headers.subject ?? '').trim();
  const from = decodeWords(p.headers.from ?? '').trim();
  const text = truncate(bodyText(p), TEXT_MAX);
  return {
    source: slug,
    id: `${c.mailbox}:${uid}`,
    at: isoOf(p.headers.date),
    title: firstLine(subject) || '(без темы)',
    text,
    author: addressOf(p.headers.from) || undefined,
    fields: { from, from_address: addressOf(p.headers.from), to: decodeWords(p.headers.to ?? ''), subject, mailbox: c.mailbox, uid, message_id: p.headers['message-id'] ?? '' },
  };
}

async function poll(ctx: SourceCtx, deps: EmailDeps): Promise<RoutineEvent[]> {
  const c = connOf(ctx);
  const cur = ((ctx.cursor.get() as Cursor | undefined) ?? {}) as Cursor;
  const from = c.from ? ` FROM "${c.from}"` : '';
  const criteria = cur.lastUid ? `UID ${cur.lastUid + 1}:*${from}` : `UNSEEN SINCE ${imapDate(new Date(deps.now().getTime() - WEEK_MS))}${from}`;
  const found = await imap(ctx, c, '', `-X ${sq(`UID SEARCH ${criteria}`)}`);
  // «UID n:*» всегда возвращает хотя бы последнее письмо, даже старше n — отсекаем
  const uids = [...(/\*\s+SEARCH([\d\s]*)/i.exec(found)?.[1] ?? '').matchAll(/\d+/g)].map((m) => Number(m[0])).filter((u) => u > (cur.lastUid ?? 0)).sort((a, b) => a - b);
  const take = uids.slice(-MAX_NEW);
  const out: RoutineEvent[] = [];
  // BODY.PEEK не ставит \Seen, а PARTIAL не тянет вложения целиком. Первый заход только запоминает письма — хватает заголовков
  const sections = cur.lastUid ? `BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.${PARTIAL_BYTES}>` : 'BODY.PEEK[HEADER]';
  for (const uid of take) out.push(emailEvent(ctx.slug, c, uid, fetchedMessage(await imap(ctx, c, '', `-X ${sq(`UID FETCH ${uid} (${sections})`)}`))));
  const top = uids.length ? uids[uids.length - 1] : cur.lastUid;
  // курсор есть всегда: следующий заход идёт по UID, а не по UNSEEN
  ctx.cursor.set({ lastUid: top ?? 0 });
  return out;
}

export function emailKind(deps: EmailDeps = { now: () => new Date() }): SourceKind {
  return {
    kind: 'email',
    title: 'Почта',
    summary: 'Новые письма в папке почтового ящика (IMAP)',
    delivery: 'poll',
    minEveryMs: MIN_POLL_MS,
    setup: [
      { key: 'host', label: 'Сервер IMAP', placeholder: 'imap.gmail.com' },
      { key: 'user', label: 'Логин', placeholder: 'me@example.com' },
      { key: 'EMAIL_PASSWORD', label: 'Пароль', secret: true, hint: 'Для Gmail и Яндекса нужен пароль приложения, а не пароль от аккаунта.' },
      { key: 'mailbox', label: 'Папка', placeholder: 'INBOX', optional: true },
      { key: 'from', label: 'Только от адреса', placeholder: 'alerts@example.com', optional: true },
    ],
    match: [...BASE_MATCH, { key: 'from_address', label: 'Адрес отправителя', type: 'text' }, { key: 'subject', label: 'Тема', type: 'text' }],
    poll: (ctx) => poll(ctx, deps),
    describe: (spec) => `Почта: IMAP ${cfgStr(spec, 'host') ?? '(сервер не указан)'}, папка ${cfgStr(spec, 'mailbox') ?? 'INBOX'}${cfgStr(spec, 'from') ? `, от ${cfgStr(spec, 'from')}` : ''}. Команда curl imaps://…; пароль не показывается. Только чтение.`,
  };
}
