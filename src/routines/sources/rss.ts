// RSS и Atom: fetch + небольшой разбор без зависимостей. id записи — guid/id, иначе ссылка.
import { BASE_MATCH, type SourceCtx, type SourceKind } from '../kind.js';
import type { RoutineEvent } from '../types.js';
import { cfgStr, firstLine, isoOf, truncate } from './util.js';

const MIN_POLL_MS = 5 * 60_000;
const MAX_ITEMS = 50;
const TEXT_MAX = 4000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Содержимое элемента: CDATA снимается, текст декодируется. Не нашёл — undefined. */
function inner(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?=[\\s/>])[^>]*?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'i').exec(block);
  if (!m || m[1] === undefined) return undefined;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return cdata ? cdata[1] : decode(m[1]);
}

/** HTML описания → плоский текст. */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?=[\\s>])[^>]*>[\\s\\S]*?</${tag}>`, 'gi'))].map((m) => m[0]);
}

/** Ссылка записи Atom: предпочитаем rel="alternate" или без rel. */
function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) ?? links.find((a) => !/rel=/i.test(a)) ?? links[0];
  return pick ? decode(/href=["']([^"']+)["']/i.exec(pick)?.[1] ?? '') || undefined : undefined;
}

export type FeedItem = { id: string; title: string; text: string; link?: string; at?: string; author?: string; categories: string[] };

/** Разбор ленты: RSS 2.0 (item) или Atom (entry). Пустая или чужая разметка — ошибка с понятным текстом. */
export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const atom = blocks(xml, 'entry');
  const rss = blocks(xml, 'item');
  if (!atom.length && !rss.length && !/<(rss|feed|rdf:RDF)\b/i.test(xml)) throw new Error('Это не RSS и не Atom: нет ни <rss>, ни <feed>');
  const head = xml.slice(0, Math.max(0, xml.search(/<(item|entry)\b/i)) || xml.length);
  const feedTitle = htmlToText(inner(head, 'title') ?? '');
  const items: FeedItem[] = [];
  for (const b of atom) {
    const link = atomLink(b);
    const body = inner(b, 'content') ?? inner(b, 'summary') ?? '';
    items.push({
      id: htmlToText(inner(b, 'id') ?? '') || link || '',
      title: htmlToText(inner(b, 'title') ?? ''),
      text: htmlToText(body),
      link,
      at: inner(b, 'updated') ?? inner(b, 'published'),
      author: htmlToText(inner(inner(b, 'author') ?? '', 'name') ?? '') || undefined,
      categories: [...b.matchAll(/<category\b[^>]*term=["']([^"']+)["']/gi)].map((m) => decode(m[1])),
    });
  }
  for (const b of rss) {
    const link = htmlToText(inner(b, 'link') ?? '') || undefined;
    items.push({
      id: htmlToText(inner(b, 'guid') ?? '') || link || '',
      title: htmlToText(inner(b, 'title') ?? ''),
      text: htmlToText(inner(b, 'content:encoded') ?? inner(b, 'description') ?? ''),
      link,
      at: inner(b, 'pubDate') ?? inner(b, 'dc:date'),
      author: htmlToText(inner(b, 'dc:creator') ?? inner(b, 'author') ?? '') || undefined,
      categories: blocks(b, 'category').map((c) => htmlToText(inner(c, 'category') ?? '')).filter(Boolean),
    });
  }
  return { title: feedTitle, items: items.filter((i) => i.id) };
}

async function poll(ctx: SourceCtx): Promise<RoutineEvent[]> {
  const url = cfgStr(ctx.spec, 'url');
  if (!url) throw new Error('Не указан адрес ленты');
  if (!/^https?:\/\//i.test(url)) throw new Error('Адрес ленты должен начинаться с http:// или https://');
  let res: Response;
  try {
    res = await ctx.fetch(url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }, signal: ctx.signal });
  } catch (err) {
    throw new Error(`Лента недоступна: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`Лента ответила ${res.status}`);
  const feed = parseFeed(await res.text());
  return feed.items.slice(0, MAX_ITEMS).map((i) => ({
    source: ctx.slug,
    id: i.id,
    at: isoOf(i.at),
    title: firstLine(i.title) || firstLine(i.text) || i.link || i.id,
    text: truncate(i.text, TEXT_MAX),
    link: i.link,
    author: i.author,
    fields: { feed: feed.title, categories: i.categories, author: i.author ?? '' },
  }));
}

export const rssKind: SourceKind = {
  kind: 'rss',
  title: 'RSS',
  summary: 'Новые записи в ленте RSS или Atom',
  delivery: 'poll',
  minEveryMs: MIN_POLL_MS,
  setup: [{ key: 'url', label: 'Адрес ленты', placeholder: 'https://example.com/feed.xml', hint: 'Ссылка на RSS или Atom. Раз в несколько минут проверяются новые записи.' }],
  match: [...BASE_MATCH, { key: 'feed', label: 'Название ленты', type: 'text' }, { key: 'categories', label: 'Теги записи', type: 'text' }],
  poll,
  describe: (spec) => `RSS/Atom: запрос ${cfgStr(spec, 'url') ?? '(адрес не указан)'}. Каждая новая запись — событие. Только чтение.`,
};
