// Jira: новые и обновлённые задачи по JQL. Клиент jira.ts и токен, сохранённые в настройках «Подключения»; ответ — комментарий.
import { jiraClient, JQL_PRESETS, normalizeBaseUrl, type JiraIssue } from '../../jira.js';
import { loadSettings, readJiraToken, type JiraSettings } from '../../settings.js';
import { BASE_MATCH, type SourceCtx, type SourceKind } from '../kind.js';
import type { RoutineEvent } from '../types.js';
import { cfgStr, truncate } from './util.js';

const MIN_POLL_MS = 60_000;
const DESCRIPTION_FETCHES = 5;
/** Наш комментарий двигает updated задачи: такое обновление в пределах этого окна — не событие. */
const SELF_BUMP_MS = 5_000;

type Creds = { cfg: JiraSettings; token: string };
export type JiraDeps = { creds: () => Creds | undefined };

/** known — последний виденный updated задач; own — updated, которые породил наш комментарий (их событием не считаем и в следующих опросах). */
type Cursor = { known?: Record<string, string>; own?: Record<string, string> };

/**
 * Наши комментарии: источник|задача → время комментария. Лежит в памяти процесса, а не в курсоре: у reply и poll разные ctx
 * (у каждого свой снимок курсора), и poll затирал бы запись reply своим set. Живёт недолго — нужен только пока Jira не отдала updated.
 */
const bumps = new Map<string, { created: number; setAt: number }>();
const BUMP_TTL_MS = 10 * 60_000;
const bumpKey = (slug: string, key: string): string => `${slug}\u0000${key}`;

/** Для тестов. */
export function resetJiraState(): void {
  bumps.clear();
}

const defaultDeps: JiraDeps = {
  creds: () => {
    const cfg = loadSettings().jira;
    const token = readJiraToken();
    return cfg && token ? { cfg, token } : undefined;
  },
};

function need(deps: JiraDeps): Creds {
  const c = deps.creds();
  if (!c) throw new Error('Jira не подключена: добавьте адрес, email и токен в «Подключения»');
  return c;
}

function describeIssue(i: JiraIssue | undefined, b: { status: string; type: string; priority?: string }): string {
  const head = [`Статус: ${b.status}`, `Тип: ${b.type}`, b.priority ? `Приоритет: ${b.priority}` : ''].filter(Boolean).join(' · ');
  return i?.description ? `${head}\n\n${truncate(i.description, 3000)}` : head;
}

async function poll(ctx: SourceCtx, deps: JiraDeps): Promise<RoutineEvent[]> {
  const creds = need(deps);
  const client = jiraClient(creds.cfg, creds.token, ctx.fetch);
  const jql = cfgStr(ctx.spec, 'jql') ?? JQL_PRESETS.mine;
  const issues = await client.search(jql, 30);
  const cursor = ((ctx.cursor.get() as Cursor | undefined) ?? {}) as Cursor;
  const known = { ...(cursor.known ?? {}) };
  const own = { ...(cursor.own ?? {}) };
  for (const [k, b] of bumps) if (Date.now() - b.setAt > BUMP_TTL_MS) bumps.delete(k);
  const out: RoutineEvent[] = [];
  let fetched = 0;
  for (const b of issues) {
    const updated = b.updated ?? '';
    const bump = bumps.get(bumpKey(ctx.slug, b.key));
    if (bump && updated && Date.parse(updated) <= bump.created + SELF_BUMP_MS) {
      // обновление от нашего же комментария: запоминаем его как своё, событием оно не станет ни сейчас, ни в следующих опросах
      bumps.delete(bumpKey(ctx.slug, b.key));
      own[b.key] = updated;
    }
    if (updated && own[b.key] === updated) {
      known[b.key] = updated;
      continue;
    }
    let full: JiraIssue | undefined;
    if (known[b.key] !== updated && fetched < DESCRIPTION_FETCHES) {
      fetched++;
      try {
        full = await client.issue(b.key);
      } catch (err) {
        ctx.log(`Jira ${b.key}: описание не получено: ${(err as Error).message}`);
      }
    }
    known[b.key] = updated;
    out.push({
      source: ctx.slug,
      id: `${b.key}@${updated}`,
      at: updated ? new Date(updated).toISOString() : new Date().toISOString(),
      title: `${b.key} ${b.title}`,
      text: describeIssue(full, b),
      link: b.url,
      fields: { key: b.key, summary: b.title, status: b.status, status_category: b.statusCategory, type: b.type, priority: b.priority ?? '', labels: full?.labels ?? [], parent: b.parent?.key ?? '' },
      replyTo: { key: b.key },
    });
  }
  // курсор не растёт бесконечно: храним последние 300 задач
  const keys = Object.keys(known);
  for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete known[k];
  for (const k of Object.keys(own).slice(0, Math.max(0, Object.keys(own).length - 300))) Reflect.deleteProperty(own, k);
  ctx.cursor.set({ known, own });
  return out;
}

async function reply(ctx: SourceCtx, deps: JiraDeps, target: Record<string, unknown> | undefined, text: string): Promise<{ link?: string }> {
  const key = typeof target?.key === 'string' ? target.key : '';
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new Error('Не знаю, куда отвечать: нет задачи Jira в событии');
  const { cfg, token } = need(deps);
  const base = normalizeBaseUrl(cfg.baseUrl);
  const body = { body: { type: 'doc', version: 1, content: text.split(/\n{2,}/).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p.trim() || ' ' }] })) } };
  const res = await ctx.fetch(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.email}:${token}`).toString('base64'), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Jira не приняла комментарий к ${key}: ответила ${res.status}`);
  const r = (await res.json().catch(() => ({}))) as { id?: string; created?: string };
  // комментарий двигает updated задачи: запомним, чтобы не принять это за новое событие
  bumps.set(bumpKey(ctx.slug, key), { created: r.created && Number.isFinite(Date.parse(r.created)) ? Date.parse(r.created) : Date.now(), setAt: Date.now() });
  return { link: r.id ? `${base}/browse/${key}?focusedCommentId=${r.id}` : `${base}/browse/${key}` };
}

export function jiraKind(deps: JiraDeps = defaultDeps): SourceKind {
  return {
    kind: 'jira',
    title: 'Jira',
    summary: 'Новые и обновлённые задачи по запросу JQL',
    delivery: 'poll',
    minEveryMs: MIN_POLL_MS,
    setup: [{ key: 'jql', label: 'Запрос JQL', placeholder: JQL_PRESETS.mine, optional: true, hint: 'Адрес, email и токен Jira берутся из «Подключений». Пусто — ваши незакрытые задачи.' }],
    match: [
      ...BASE_MATCH,
      { key: 'status', label: 'Статус', type: 'text' },
      { key: 'type', label: 'Тип задачи', type: 'text' },
      { key: 'priority', label: 'Приоритет', type: 'text' },
      { key: 'key', label: 'Ключ задачи', type: 'text' },
    ],
    poll: (ctx) => poll(ctx, deps),
    reply: (ctx, target, text) => reply(ctx, deps, target, text),
    describe: (spec) => `Jira: задачи по запросу ${cfgStr(spec, 'jql') ?? JQL_PRESETS.mine}. Новая или обновлённая задача — событие. Опрос раз в минуту, только чтение; ответ — комментарий к задаче.`,
  };
}
