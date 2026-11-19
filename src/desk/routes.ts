// Маршруты /api/desk (контракт — комментарий в types.ts) в стиле routinesRoute: (method, url, readBody) → Reply или
// undefined. Проверки Host/Origin/типа тела уже сделал server-guard в handle(). Всё, что приходит из UI, — от 'me'.
import { randomBytes } from 'node:crypto';
import { readSpaceMeta, spaceSlug } from '../spaces.js';
import { settingsJiraHosts } from '../things/resolve.js';
import { isColumn } from './rules.js';
import { canonicalKey, resolveThing } from './tools.js';
import type { DeskStore } from './store.js';
import type { DeskColumn, DeskFilter, DeskListReply, DeskPatch } from './types.js';

export type Reply = { status: number; body: unknown };

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const bad = (error: string, status = 400): Reply => ({ status, body: { error } });

const KEY_RE = /^[a-z]+:\S/;
const KEY_MAX = 600;

export type DeskRouteDeps = {
  store: DeskStore;
  /** Есть ли пространство (patch.project); по умолчанию — папка пространства в настройках. */
  hasProject?: (slug: string) => boolean;
  /** Хосты Jira для ссылки на задачу в key; по умолчанию — из настроек. */
  jiraHosts?: () => readonly string[];
};

const spaceExists = (slug: string): boolean => {
  const s = spaceSlug(slug);
  return Boolean(s && readSpaceMeta(s));
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Ключ дела в каноническом виде (src/desk/tools.ts → canonicalKey): MR из ссылки в другом регистре — то же дело. */
function keyOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= KEY_MAX && KEY_RE.test(v.trim()) ? canonicalKey(v) : undefined;
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
  if (method !== 'POST') return p === '/api/desk' || p.startsWith('/api/desk/') ? bad('Метод не поддерживается', 405) : undefined;
  if (p === '/api/desk/put') {
    const b = obj(await readBody());
    const patch = patchOf(b.patch);
    // ключа нет — своё дело, заведённое руками; ключ или адрес MR/задачи — канонический ключ и вещь для наблюдателя
    let key: string;
    if (b.key === undefined) key = `own:${randomBytes(6).toString('hex')}`;
    else {
      if (typeof b.key !== 'string' || b.key.length > KEY_MAX) return bad('key: ключ вещи вида тип:… или адрес MR, задачи');
      try {
        const r = resolveThing(b.key, { jiraHosts: (deps.jiraHosts ?? settingsJiraHosts)() });
        key = r.key;
        if (r.thing) patch.thing = r.thing;
      } catch (err) {
        return bad(`key: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (patch.project && !(deps.hasProject ?? spaceExists)(patch.project)) return bad(`patch.project: пространства ${patch.project} нет`);
    if (!(await store.get(key)) && !patch.title && !patch.signal?.text) return bad('patch.title: у нового дела нужно имя');
    return ok(await store.put(key, patch, 'me'));
  }
  if (p === '/api/desk/move') {
    const b = obj(await readBody());
    const key = keyOf(b.key);
    if (!key) return bad('key: ключ вещи вида тип:…');
    if (!isColumn(b.column)) return bad('column: new | plan | work | waiting | done');
    const item = await store.move(key, b.column, 'me', str(b.why, 300));
    return item ? ok(item) : bad('Дела нет', 404);
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
