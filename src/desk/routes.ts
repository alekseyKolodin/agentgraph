// Маршруты /api/desk (контракт — комментарий в types.ts) в стиле routinesRoute: (method, url, readBody) → Reply или
// undefined. Проверки Host/Origin/типа тела уже сделал server-guard в handle(). Всё, что приходит из UI, — от 'me'.
import { randomBytes } from 'node:crypto';
import { readSpaceMeta, spaceSlug } from '../spaces.js';
import { settingsJiraHosts, thingLabel, thingOfUrl } from '../things/resolve.js';
import { deskCheck } from './check.js';
import { runSeen } from './run-end.js';
import { isColumn, RELINK_WHY } from './rules.js';
import { canonicalKey, resolveThing } from './tools.js';
import { DAYS_MAX, deskWeek, STALE_DAYS, WEEK_DAYS } from './week.js';
import type { DeskStore } from './store.js';
import type { DeskCheckReply, DeskColumn, DeskFilter, DeskItemReply, DeskListReply, DeskMove, DeskPatch } from './types.js';

export type Reply = { status: number; body: unknown };

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const bad = (error: string, status = 400): Reply => ({ status, body: { error } });

const KEY_RE = /^[a-z]+:\S/;
const KEY_MAX = 600;
/** Запуск процесса: итог сверки наблюдателей старше — «не проверялось с запуска приложения». */
export const PROCESS_STARTED = new Date(Date.now() - process.uptime() * 1000);

/**
 * check — сверка «N из N» (check.ts): сервер собирает её из итогов источников рутин и наблюдателей. Нет — в сверке только
 * наблюдатели (в тестах и без рутин).
 */
export type DeskRouteDeps = {
  store: DeskStore;
  check?: () => DeskCheckReply;
  /** Есть ли пространство (patch.project); по умолчанию — папка пространства в настройках. */
  hasProject?: (slug: string) => boolean;
  /** Время обзора недели; по умолчанию — сейчас. */
  now?: () => Date;
  /** Хосты Jira для ссылки на задачу в key; по умолчанию — из настроек. */
  jiraHosts?: () => readonly string[];
};

const spaceExists = (slug: string): boolean => {
  try {
    const s = spaceSlug(slug);
    return Boolean(s && readSpaceMeta(s));
  } catch {
    return false; // кривое имя — пространства нет
  }
};

/** Причина закрытия своего дела, которое переложено на вещь («Привязать вещь»): доска такие в «Готово» не показывает. */
import { LINKED_REASON } from './rules.js';

/** Вид дела вещи вместо «Своё» (как у нового дела в rules.ts). */
const KIND_OF_THING: Record<string, string> = { mr: 'MR', jira: 'Jira' };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * Ключ дела в каноническом виде (src/desk/tools.ts → canonicalKey): MR в другом регистре — то же дело. Ключ, который
 * канон не разбирает (свои дела рутин с пробелом: файл папки, тред), — как есть: карточку должно быть можно двигать.
 */
function keyOf(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > KEY_MAX || !KEY_RE.test(v.trim())) return undefined;
  return canonicalKey(v) ?? v.trim();
}

/** Правка с карточки или «Своё» руками: только поля, которые UI вправе задать; сигнал — от 'ui', время сервера. */
function patchOf(v: unknown): DeskPatch {
  const p = obj(v);
  const out: DeskPatch = {};
  const kind = str(p.kind, 80);
  const title = str(p.title, 300);
  const project = str(p.project, 200);
  const why = str(p.why, 300);
  const due = str(p.due, 40);
  if (kind) out.kind = kind;
  if (title) out.title = title;
  if (project) out.project = project;
  if (why) out.why = why;
  if (due && !Number.isNaN(Date.parse(due))) out.due = due;
  if (isColumn(p.column)) out.column = p.column;
  if (p.onRepeat === 'plan' || p.onRepeat === 'keep') out.onRepeat = p.onRepeat;
  const s = obj(p.signal);
  const text = str(s.text, 2000);
  const link = str(s.link, 1000);
  if (text || link) out.signal = { source: 'ui', at: new Date().toISOString(), ...(text ? { text } : {}), ...(link && /^https?:\/\//i.test(link) ? { link } : {}) };
  return out;
}

/** Сколько движений отдаём в подробностях дела: журнал короче LOG_KEEP, но одно дело столько не наберёт. */
const MOVES_MAX = 200;

/** Движения дела: свои и своего дела, из которого оно переехало (RELINK_WHY → ключ), по цепочке; старые сверху. */
export function movesOf(log: readonly DeskMove[], key: string): DeskMove[] {
  const keys = new Set([key]);
  // цепочка переездов: дело вещи ← своё дело; журнал идёт по времени, но обходим до неподвижной точки
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of log) {
      if (!keys.has(m.key) || !m.why?.startsWith(RELINK_WHY)) continue;
      const from = m.why.slice(RELINK_WHY.length).trim();
      if (from && !keys.has(from)) {
        keys.add(from);
        grew = true;
      }
    }
  }
  return log.filter((m) => keys.has(m.key)).sort((a, b) => a.at.localeCompare(b.at)).slice(-MOVES_MAX);
}

function filterOf(q: URLSearchParams): DeskFilter {
  const f: DeskFilter = {};
  const cols = (q.get('column') ?? '').split(',').filter(isColumn) as DeskColumn[];
  if (cols.length) f.column = cols;
  for (const k of ['project', 'kind', 'key'] as const) {
    const v = q.get(k);
    if (v) f[k] = v;
  }
  const open = q.get('open');
  if (open === '1' || open === 'true') f.open = true;
  else if (open === '0' || open === 'false') f.open = false;
  return f;
}

export async function deskRoute(method: string, url: URL, readBody: () => Promise<unknown>, deps: DeskRouteDeps): Promise<Reply | undefined> {
  const p = url.pathname;
  const { store } = deps;
  if (p === '/api/desk' && method === 'GET') {
    const reply: DeskListReply = { items: await store.list(filterOf(url.searchParams)), ...((c) => (c ? { check: c } : {}))(store.readCheck()) };
    return ok(reply);
  }
  if (p === '/api/desk/week' && method === 'GET') {
    const n = (k: string, d: number) => {
      const v = Number(url.searchParams.get(k) ?? d);
      return Number.isInteger(v) && v >= 1 && v <= DAYS_MAX ? v : d;
    };
    return ok(deskWeek(await store.list({}), store.readLog(), (deps.now ?? (() => new Date()))(), { days: n('days', WEEK_DAYS), staleDays: n('stale', STALE_DAYS) }));
  }
  if (p === '/api/desk/item' && method === 'GET') {
    const key = keyOf(url.searchParams.get('key'));
    if (!key) return bad('key: ключ вещи вида тип:…');
    const item = await store.get(key);
    if (!item) return bad('Дела нет', 404);
    return ok({ item, moves: movesOf(store.readLog(), key) } satisfies DeskItemReply);
  }
  if (p === '/api/desk/check' && method === 'GET') {
    return ok(deps.check ? deps.check() : deskCheck({ watcher: store.readCheck(), startedAt: PROCESS_STARTED }));
  }
  if (method !== 'POST') return p === '/api/desk' || p.startsWith('/api/desk/') ? bad('Метод не поддерживается', 405) : undefined;
  if (p === '/api/desk/put') {
    const b = obj(await readBody());
    const patch = patchOf(b.patch);
    // ключа нет — своё дело, заведённое руками; ключ или адрес MR/задачи — канонический ключ и вещь для наблюдателя;
    // ключ, который канон не разбирает (своё дело рутины с пробелом), — как есть
    let key: string;
    let link: string | undefined;
    if (b.key === undefined) key = `own:${randomBytes(6).toString('hex')}`;
    else {
      if (typeof b.key !== 'string' || b.key.length > KEY_MAX) return bad('key: ключ вещи вида тип:… или адрес MR, задачи');
      try {
        const r = resolveThing(b.key, { jiraHosts: (deps.jiraHosts ?? settingsJiraHosts)() });
        key = r.key;
        link = r.link;
        if (r.thing) patch.thing = r.thing;
      } catch (err) {
        // как есть — только своё дело или уже заведённое: иначе MR-подобный кривой ключ завёл бы дубль без вещи
        const raw = keyOf(b.key);
        if (!raw || /^https?:/i.test(b.key.trim()) || !(raw.startsWith('own:') || (await store.get(raw)))) return bad(`key: ${err instanceof Error ? err.message : String(err)}`);
        key = raw;
      }
    }
    if (patch.project && !(deps.hasProject ?? spaceExists)(patch.project)) return bad(`patch.project: пространства ${patch.project} нет`);
    const exists = Boolean(await store.get(key));
    if (!exists && !patch.title && !patch.signal?.text) return bad('patch.title: у нового дела нужно имя');
    // адрес из ключа не теряется: у MR — в links.mr, у другого адреса — ссылкой сигнала (у нового дела — сигнал с ней)
    if (link && patch.thing?.type === 'mr') patch.links = { mr: link };
    else if (link && patch.signal && !patch.signal.link) patch.signal = { ...patch.signal, link };
    else if (link && !exists && !patch.signal) patch.signal = { source: 'ui', at: new Date().toISOString(), link };
    return ok(await store.put(key, patch, 'me'));
  }
  if (p === '/api/desk/run-seen') {
    // страницу запуска открыли: дело «<flow> готов» этой цепочки закрывается (упавшее — нет). id запуска и первого запуска цепочки
    const b = obj(await readBody());
    const ids = [b.runId, b.root].filter((v): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v));
    if (!ids.length) return bad('runId: id запуска');
    return ok({ closed: await runSeen(store, ids) });
  }
  if (p === '/api/desk/move') {
    const b = obj(await readBody());
    const key = keyOf(b.key);
    if (!key) return bad('key: ключ вещи вида тип:…');
    if (!isColumn(b.column)) return bad('column: new | plan | work | waiting | done');
    const item = await store.move(key, b.column, 'me', str(b.why, 300));
    return item ? ok(item) : bad('Дела нет', 404);
  }
  if (p === '/api/desk/link') {
    // «Привязать вещь» у своего дела: адрес MR, PR или задачи Jira → дело по ключу вещи (одна вещь — одно дело, следующий
    // сигнал о ней найдёт его), своё закрывается со ссылкой. Вещь собирает сервер по адресу, не клиент; переезд — одной
    // записью хранилища (сигналы, ссылки и возраст те же)
    const b = obj(await readBody());
    const key = keyOf(b.key);
    if (!key) return bad('key: ключ вещи вида тип:…');
    if (!key.startsWith('own:')) return bad('Вещь привязывается только к своему делу', 409);
    const thing = thingOfUrl(str(b.url, 1000) ?? '', (deps.jiraHosts ?? settingsJiraHosts)());
    if (!thing) return bad('Адрес не узнан: нужна ссылка на MR, PR или задачу Jira');
    const r = await store.relink(key, { key: thing.key, kind: KIND_OF_THING[thing.type] ?? 'Своё', type: thing.type, ref: thing.ref, ...(thing.url ? { url: thing.url } : {}) }, `${LINKED_REASON}${thingLabel(thing)}`);
    if (r === 'missing') return bad('Открытого своего дела без вещи нет', 409);
    return ok(r);
  }
  if (p === '/api/desk/close') {
    const b = obj(await readBody());
    const key = keyOf(b.key);
    if (!key) return bad('key: ключ вещи вида тип:…');
    const item = await store.close(key, str(b.reason, 200) ?? 'закрыто вручную', 'me');
    return item ? ok(item) : bad('Дела нет', 404);
  }
  return p.startsWith('/api/desk/') ? bad('Не найдено', 404) : undefined;
}
