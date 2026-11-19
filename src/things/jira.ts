// Наблюдатель задачи Jira (type: 'jira'): статус и его категория, исполнитель, что изменилось по changelog.
// Ключ вещи — jira:<host>/<KEY-123> (строкой по формату из types.ts; в реестр наблюдателей подключает things-core).
// Тратит только Jira API: ни модели, ни git. Ошибки наружу не летят — вещь без доступа получает exists: false и error.
import { JiraError, jiraClient, normalizeBaseUrl, parseIssueKey, type FetchFn, type JiraChange, type JiraClient, type JiraIssue } from '../jira.js';
import { loadProfile, loadSettings, readJiraToken, type JiraSettings } from '../settings.js';
import type { Profile } from '../api-types.js';
import type { Thing, ThingState, Watcher } from './types.js';

export type JiraWatcherDeps = {
  /** Подключение к Jira из «Подключений»; нет — undefined. */
  creds?: () => { cfg: JiraSettings; token: string } | undefined;
  /** «Я»: профиль из настроек. */
  profile?: () => Profile;
  fetch?: FetchFn;
  now?: () => number;
  everyMs?: number;
};

const DEFAULT_EVERY_MS = 5 * 60_000;
/** Сколько задач снимаем одновременно: Jira Cloud не любит всплеск запросов. */
const PARALLEL = 4;
/** Сколько изменений показываем в карточке: остальные — «и ещё N». */
const SHOWN_CHANGES = 2;
const FIRST_SIGHT_CHANGES = 3;

const defaultCreds: NonNullable<JiraWatcherDeps['creds']> = () => {
  const cfg = loadSettings().jira;
  const token = readJiraToken();
  return cfg && token ? { cfg, token } : undefined;
};

const FIELD_RU: Record<string, string> = {
  status: 'статус',
  assignee: 'исполнитель',
  priority: 'приоритет',
  summary: 'заголовок',
  description: 'описание',
  resolution: 'решение',
  labels: 'метки',
  sprint: 'спринт',
};

/** Хост из адреса Jira (с портом, нижний регистр) — ровно то, что стоит в ключе вещи. */
function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** «статус: В работе → Ревью (Анна)»; у описания значения не показываем — это простыня. */
export function describeChange(c: JiraChange): string {
  const field = FIELD_RU[c.field.toLowerCase()] ?? c.field;
  const who = c.author ? ` (${c.author})` : '';
  if (c.field.toLowerCase() === 'description') return `${field} изменено${who}`;
  const short = (v: string) => (v ? (v.length > 60 ? `${v.slice(0, 59)}…` : v) : '—');
  return `${field}: ${short(c.from)} → ${short(c.to)}${who}`;
}

const lower = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

export function jiraWatcher(deps: JiraWatcherDeps = {}): Watcher {
  const creds = deps.creds ?? defaultCreds;
  const profile = deps.profile ?? loadProfile;
  const now = deps.now ?? Date.now;
  /** Время последнего изменения, которое мы уже показывали, по ключу вещи. Живёт, пока жив наблюдатель. */
  const seen = new Map<string, number>();
  /** Задачи, которые были на мне: «переназначили» говорим только про них, а не про чужую задачу из ссылки. */
  const wasMine = new Set<string>();
  const myself = new Map<string, { accountId: string; displayName: string } | null>();

  async function me(client: JiraClient, cacheKey: string): Promise<{ accountId: string; displayName: string } | null> {
    if (!myself.has(cacheKey)) myself.set(cacheKey, await client.myself().catch(() => null));
    return myself.get(cacheKey) ?? null;
  }

  function watchable(thing: Thing): true | string {
    if (thing.type !== 'jira') return 'не задача Jira';
    const c = creds();
    if (!c) return 'Jira не подключена: добавьте адрес, email и токен в «Подключения»';
    const mine = hostOf(c.cfg.baseUrl);
    const host = lower(String(thing.ref.host ?? ''));
    const key = parseIssueKey(String(thing.ref.key ?? ''));
    if (!host || !key) return 'у вещи нет адреса Jira или ключа задачи';
    if (host !== mine) return `Jira на ${host} не подключена${mine ? ` (подключена ${mine})` : ''}`;
    return true;
  }

  async function snapshot(client: JiraClient, c: { cfg: JiraSettings }, thing: Thing, prof: Profile): Promise<ThingState> {
    const key = parseIssueKey(String(thing.ref.key)) as string;
    let issue: JiraIssue;
    try {
      issue = await client.issue(key);
    } catch (err) {
      const e = err as Error;
      const msg = err instanceof JiraError && err.status === 404 ? `Задача ${key} не найдена или нет доступа к ней в Jira` : e.message;
      return gone(thing, msg, now());
    }
    const changelog = await client.changelog(key).catch(() => [] as JiraChange[]);
    const who = issue.assignee ? await me(client, `${c.cfg.baseUrl}|${c.cfg.email}`) : null;

    const myNames = new Set([...prof.names, who?.displayName ?? ''].map(lower).filter(Boolean));
    const myEmails = new Set([prof.jiraEmail, ...prof.emails, c.cfg.email].map(lower).filter(Boolean));
    const a = issue.assignee;
    const isMine = Boolean(a && ((who && a.accountId === who.accountId) || (a.email && myEmails.has(lower(a.email))) || myNames.has(lower(a.displayName))));
    const awayFromMe = changelog.some((ch) => ch.field.toLowerCase() === 'assignee' && myNames.has(lower(ch.from)));
    const lostIt = !isMine && (wasMine.has(thing.key) || awayFromMe);
    if (isMine) wasMine.add(thing.key);

    const time = (ch: JiraChange) => Date.parse(ch.at) || 0;
    const before = seen.get(thing.key);
    const fresh = before === undefined ? changelog.slice(-FIRST_SIGHT_CHANGES) : changelog.filter((ch) => time(ch) > before);
    const last = changelog.reduce((m, ch) => Math.max(m, time(ch)), 0);
    if (last) seen.set(thing.key, last);
    // «изменилось» пишем только про то, что случилось с прошлого раза; при первом взгляде прошлого раза нет — изменения лежат в facts
    const news = before === undefined ? [] : fresh;
    const tail = news.length ? ` · изменилось: ${news.slice(0, SHOWN_CHANGES).map(describeChange).join('; ')}${news.length > SHOWN_CHANGES ? ` и ещё ${news.length - SHOWN_CHANGES}` : ''}` : '';

    const done = issue.statusCategory === 'done';
    let turn: ThingState['turn'] = 'none';
    let reason: string;
    if (done) reason = `статус «${issue.status}»`;
    else if (!a) reason = lostIt ? 'сняли с задачи: исполнитель не назначен' : 'исполнитель не назначен';
    else if (isMine) {
      turn = 'me';
      reason = `назначена на вас · статус «${issue.status}»`;
    } else reason = lostIt ? `переназначили на ${a.displayName || 'другого человека'}` : `исполнитель — ${a.displayName || 'другой человек'}`;

    return {
      exists: true,
      closed: done ? 'done' : undefined,
      turn: done ? 'none' : turn,
      why: reason + tail,
      title: issue.title,
      updatedAt: issue.updated ?? new Date(now()).toISOString(),
      facts: {
        key,
        host: thing.ref.host,
        url: issue.url,
        status: issue.status,
        statusCategory: issue.statusCategory,
        type: issue.type,
        priority: issue.priority,
        assignee: a?.displayName ?? null,
        assigneeId: a?.accountId ?? null,
        assigneeIsMe: isMine,
        reassignedFromMe: lostIt,
        changes: fresh,
      },
    };
  }

  return {
    type: 'jira',
    everyMs: deps.everyMs ?? DEFAULT_EVERY_MS,
    canWatch: watchable,
    async state(things, signal) {
      const out = new Map<string, ThingState>();
      const c = creds();
      const prof = profile();
      const todo: Thing[] = [];
      for (const t of things) {
        const w = watchable(t);
        if (w === true && c) todo.push(t);
        else out.set(t.key, gone(t, w === true ? 'Jira не подключена' : w, now()));
      }
      if (!c) return out;
      let client: JiraClient;
      try {
        client = jiraClient(c.cfg, c.token, deps.fetch);
      } catch (err) {
        for (const t of todo) out.set(t.key, gone(t, (err as Error).message, now()));
        return out;
      }
      for (let i = 0; i < todo.length && !signal.aborted; i += PARALLEL) {
        await Promise.all(
          todo.slice(i, i + PARALLEL).map(async (t) => {
            try {
              out.set(t.key, await snapshot(client, c, t, prof));
            } catch (err) {
              out.set(t.key, gone(t, (err as Error).message, now()));
            }
          }),
        );
      }
      return out;
    },
  };
}

/** Вещь не снялась: нет доступа, задачи нет, Jira недоступна. */
function gone(thing: Thing, error: string, at: number): ThingState {
  return { exists: false, turn: 'none', why: 'состояние не отслеживается', title: thing.title ?? '', updatedAt: new Date(at).toISOString(), facts: { host: thing.ref.host, key: thing.ref.key }, error };
}
