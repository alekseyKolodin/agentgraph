// Разбор сигнала (SPEC 3.1): из ссылки и текста события достаются ссылки и ключи известных вещей — адрес MR/PR GitLab и
// GitHub любого хоста, адрес задачи Jira по хостам из настроек Jira (и *.atlassian.net), ключ задачи ABC-12 в тексте,
// когда хост Jira один (такая вещь угадана: ref.guess — правило повтора рутин на неё не опирается). Несколько ссылок —
// несколько вещей. Нить разговора — из записи по FieldMap (thread/channel).
import { pathGet } from '../routines/match.js';
import type { FieldMap } from '../routines/types.js';
import { loadSettings } from '../settings.js';
import { jiraKey, keyLabel, mrKey, normHost } from './keys.js';
import type { Thing, ThreadRef } from './types.js';

/** Больше вещей из одного сигнала не берём: сводка со списком из 50 ссылок — не 50 просьб. */
export const THINGS_MAX = 20;

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-[1-9]\d*$/;
/** Похоже на ключ задачи, но это стандарт, кодировка или модель: UTF-8, ISO-8601, SHA-256, GPT-4, CVE-2024… */
const NOT_JIRA = new Set(['UTF', 'ISO', 'SHA', 'MD', 'RFC', 'CVE', 'CWE', 'GPT', 'COVID', 'TLS', 'SSL', 'HTTP', 'HTTPS', 'IPV', 'AES', 'RSA', 'PEP', 'ES', 'ECMA', 'IEEE', 'IEC', 'ANSI', 'WCAG', 'CP', 'KOI', 'WIN', 'ARM', 'MP', 'AVX', 'SSE', 'DDR', 'LPDDR', 'PCI', 'USB', 'HDMI', 'UTC', 'GMT', 'EN', 'DIN', 'BASE', 'TOP', 'NO', 'OAUTH', 'IE', 'AI', 'ML', 'LLM', 'IOS', 'FY', 'Q1', 'Q2', 'Q3', 'Q4', 'PR', 'MR']);
/** Кварталы и полугодия (Q3-2024, H1-2025) — не задачи. */
const PERIOD = /^(Q[1-4]|H[12])$/;

export type MrRef = { forge: 'gitlab' | 'github'; host: string; project: string; number: number };

/** Вещь «MR/PR». project — как есть (для API), в ключе — нормализованный. */
export function mrThing(r: MrRef & { url?: string; title?: string }): Thing {
  const project = r.project.trim().replace(/^\/+|\/+$/g, '');
  return { type: 'mr', key: mrKey(r.host, project, r.number), ref: { forge: r.forge, host: normHost(r.host), project, number: r.number }, ...(r.url ? { url: r.url } : {}), ...(r.title ? { title: r.title } : {}) };
}

/** Вещь «задача Jira». */
export function jiraThing(r: { host: string; key: string; url?: string; title?: string }): Thing {
  const key = r.key.trim().toUpperCase();
  return { type: 'jira', key: jiraKey(r.host, key), ref: { host: normHost(r.host), key }, ...(r.url ? { url: r.url } : {}), ...(r.title ? { title: r.title } : {}) };
}

/** Подпись вещи: «MR grp/App!12» (регистр пути — из ref), «PR o/r#7», «ABC-12». */
export function thingLabel(t: Thing): string {
  if (t.type === 'mr' && typeof t.ref.project === 'string') return t.ref.forge === 'github' ? `PR ${t.ref.project}#${t.ref.number}` : `MR ${t.ref.project}!${t.ref.number}`;
  return keyLabel(t.key, typeof t.ref.forge === 'string' ? t.ref.forge : undefined);
}

/** Адреса в тексте: Slack пишет <url|подпись>, markdown — [подпись](url); хвостовую пунктуацию отрезаем. */
function urlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`|\\\])}]+/gi)) {
    // Slack экранирует & внутри адреса: ?a=1&amp;selectedIssue=ABC-12
    out.push(m[0].replace(/(&gt;|&lt;|&amp;)+$/i, '').replace(/&amp;/gi, '&').replace(/[.,;:!?»”'"]+$/, ''));
  }
  return out;
}

/** Адрес → вещь: MR GitLab (…/-/merge_requests/12), PR GitHub (…/owner/repo/pull/7), задача Jira на известном хосте. */
export function thingOfUrl(raw: string, jiraHosts: readonly string[] = []): Thing | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const host = normHost(u.host);
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* как есть */
  }
  const origin = `${u.protocol}//${u.host}`;
  // GitLab: /<группа>/<проект>/-/merge_requests/12[/diffs]; старый вид без «/-/» GitLab тоже открывает
  const gl = /^\/(.+?)\/(?:-\/)?merge_requests\/([1-9]\d*)(?:\/.*)?$/.exec(path);
  if (gl && gl[1].includes('/') && !gl[1].startsWith('groups/')) {
    return mrThing({ forge: 'gitlab', host, project: gl[1], number: Number(gl[2]), url: `${origin}/${gl[1]}/-/merge_requests/${gl[2]}` });
  }
  // GitHub и GitHub Enterprise: /<владелец>/<репозиторий>/pull/7[/files]
  const gh = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/.exec(path);
  if (gh) return mrThing({ forge: 'github', host, project: `${gh[1]}/${gh[2]}`, number: Number(gh[3]), url: `${origin}/${gh[1]}/${gh[2]}/pull/${gh[3]}` });
  // Jira: хост из настроек или Jira Cloud; ключ — ?selectedIssue=ABC-12, /browse/abc-12, …/issues/ABC-12, очередь. Любой
  // последний сегмент не берём: на том же хосте бывает Confluence (/wiki/…, /confluence/…) со страницами «RELEASE-2»
  if (jiraHosts.map(normHost).includes(host) || host.endsWith('.atlassian.net')) {
    // …/issues/ABC-12 и очереди Service Management (…/queues/custom/1/ABC-12)
    const inPath = /\/(?:issues\/|queues\/(?:[^/]+\/)*)([A-Z][A-Z0-9_]+-[1-9]\d*)\/?$/.exec(path)?.[1];
    const key = [u.searchParams.get('selectedIssue'), /\/browse\/([A-Za-z][A-Za-z0-9_]+-[1-9]\d*)\/?$/.exec(path)?.[1], inPath].map((k) => k?.toUpperCase()).find((k) => k && JIRA_KEY.test(k));
    if (key) return jiraThing({ host, key, url: `${origin}${jiraContext(host, path)}/browse/${key}` });
  }
  return undefined;
}

/** Разделы Jira Server/Data Center: всё, что до них в пути, — путь контекста (https://x/jira/browse/ABC-1 → /jira). */
const JIRA_SECTIONS = ['/browse/', '/secure/', '/projects/', '/servicedesk/', '/plugins/'];

/** Путь контекста Jira Server по адресу; у Jira Cloud его нет (/jira/software/… — часть приложения, задачи — в /browse/). */
function jiraContext(host: string, path: string): string {
  if (host.endsWith('.atlassian.net')) return '';
  const at = JIRA_SECTIONS.map((s) => path.indexOf(s)).filter((i) => i >= 0);
  return at.length ? path.slice(0, Math.min(...at)).replace(/\/+$/, '') : '';
}

/** Ключи ABC-12 в тексте (без адресов): только когда хост Jira один — иначе не знаем, чья это задача. */
function bareJiraKeys(text: string, jiraHosts: readonly string[]): Thing[] {
  if (jiraHosts.length !== 1) return [];
  const host = normHost(jiraHosts[0]);
  const out: Thing[] = [];
  for (const m of text.matchAll(/(?<![\w./#@-])([A-Z][A-Z0-9_]{1,9})-([1-9]\d{0,6})(?![\w-]|\.\d)/g)) {
    if (NOT_JIRA.has(m[1]) || PERIOD.test(m[1])) continue;
    const t = jiraThing({ host, key: `${m[1]}-${m[2]}` });
    out.push({ ...t, ref: { ...t.ref, guess: true } });
  }
  return out;
}

export type Signal = { link?: string; title?: string; text?: string };
export type ResolveOpts = { jiraHosts?: readonly string[] };

const RANK: Partial<Record<Thing['type'], number>> = { mr: 0, jira: 1 };

/**
 * Вещи сигнала, разделённые по роли. own — вещь, о которой сам сигнал: у ссылки события (link) адрес вещи — назначение
 * в ревью, комментарий в MR, обновление задачи. mentioned — вещи, которые сигнал только упоминает в тексте (ссылка на MR
 * в сообщении Slack, ключ задачи в заголовке MR): MR раньше задач, дальше по порядку в тексте. Без повторов по ключу.
 */
export function resolveSignal(s: Signal, o: ResolveOpts = {}): { own: Thing[]; mentioned: Thing[] } {
  const hosts = o.jiraHosts ?? [];
  const keys = new Set<string>();
  const take = (t: Thing | undefined, into: Thing[]): void => {
    if (!t || keys.has(t.key)) return;
    keys.add(t.key);
    into.push(t);
  };
  const own: Thing[] = [];
  if (s.link) take(thingOfUrl(s.link.trim(), hosts), own);
  const text = [s.title ?? '', s.text ?? ''].join('\n');
  const mentioned: Thing[] = [];
  for (const u of urlsIn(text)) take(thingOfUrl(u, hosts), mentioned);
  // ключи — по тексту без адресов: ABC-12 внутри ссылки уже разобран вместе с ней
  for (const t of bareJiraKeys(text.replace(/https?:\/\/\S+/gi, ' '), hosts)) take(t, mentioned);
  mentioned.sort((a, b) => (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9));
  return { own, mentioned };
}

/** Все вещи сигнала: свои, потом упомянутые; первая — главная (у своей — версия, по ней «то же срабатывание»). */
export function resolveThings(s: Signal, o: ResolveOpts = {}): Thing[] {
  const r = resolveSignal(s, o);
  return [...r.own, ...r.mentioned].slice(0, THINGS_MAX);
}

/** Хосты Jira из настроек «Подключений». Настроек нет или не читаются — пусто. */
export function settingsJiraHosts(): string[] {
  try {
    const base = loadSettings().jira?.baseUrl;
    return base ? [normHost(base)] : [];
  } catch {
    return [];
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** Нить разговора: источник, канал (может не быть) и нить. Пустая нить — нити нет. */
export function threadRef(source: string, channel: unknown, thread: unknown): ThreadRef | undefined {
  const t = str(thread);
  if (!t) return undefined;
  const c = str(channel);
  return { source, ...(c ? { channel: c } : {}), thread: t };
}

/** Нить записи по путям FieldMap (thread, channel) — для чатов через коннектор (у «Своей команды» map.thread схема пока не пускает). */
export function threadOfItem(source: string, item: unknown, map: Pick<FieldMap, 'thread' | 'channel'>): ThreadRef | undefined {
  if (!map.thread) return undefined;
  return threadRef(source, map.channel ? pathGet(item, map.channel) : undefined, pathGet(item, map.thread));
}
