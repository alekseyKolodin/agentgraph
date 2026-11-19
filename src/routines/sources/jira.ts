// Jira: события «назначили на меня» и «что изменилось» по истории задач (changelog) из выборки JQL — не событие на каждую правку.
// Клиент jira.ts и токен, сохранённые в настройках «Подключения»; ответ — комментарий. У события — вещь jira (src/things).
import type { Profile } from '../../api-types.js';
import { ASSIGNED_TO_ME_JQL, jiraClient, normalizeBaseUrl, type JiraChange, type JiraClient, type JiraIssue } from '../../jira.js';
import { loadProfile, loadSettings, readJiraToken, type JiraSettings } from '../../settings.js';
import { describeChange } from '../../things/jira.js';
import { jiraThing } from '../../things/resolve.js';
import { BASE_MATCH, type SourceCtx, type SourceKind } from '../kind.js';
import type { RoutineEvent } from '../types.js';
import { cfgStr, truncate } from './util.js';

const MIN_POLL_MS = 60_000;
const DESCRIPTION_FETCHES = 5;
/** Наш комментарий двигает updated задачи: такое обновление в пределах этого окна — не событие. */
const SELF_BUMP_MS = 5_000;

type Creds = { cfg: JiraSettings; token: string };
export type JiraDeps = {
  creds: () => Creds | undefined;
  /** «Я» для узнавания своих правок и назначений; по умолчанию — профиль из настроек. */
  profile?: () => Profile;
  /** Часы; в тестах подменяются. */
  now?: () => number;
};

/**
 * known — последний виденный updated задач; own — updated, которые породил наш комментарий (их событием не считаем и в следующих опросах);
 * seen — время последней записи истории (changelog), по которой уже было событие: «что изменилось» берётся после неё;
 * fails — сколько опросов подряд не получилась история задачи; at — когда начался прошлый опрос.
 */
type Cursor = { known?: Record<string, string>; own?: Record<string, string>; seen?: Record<string, number>; fails?: Record<string, number>; at?: number };

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
  accounts.clear();
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

/** Сколько задач за опрос разбираем по истории: остальные подождут следующего опроса, а не потеряются. */
const HISTORY_FETCHES = 10;
/** Сколько опросов подряд ждём историю задачи, прежде чем считать её правкой без истории (постоянная ошибка доступа не должна держать задачу вечно). */
const HISTORY_RETRIES = 3;
const MAX_CHANGES_SHOWN = 3;
/** Запас на разницу часов и на запись, пришедшую во время прошлого опроса: назначение «новее прошлого опроса» считается с этим запасом. */
const OVERLAP_MS = 2 * 60_000;
/** updated дальше последней записи истории больше чем на это — между ними был комментарий (его в истории нет). */
const COMMENT_GAP_MS = 60_000;
/** Служебные поля истории: порядок в списке, учёт времени. Это не «что изменилось» для человека. */
const NOISY_FIELDS = new Set(['rank', 'timespent', 'timeestimate', 'timeoriginalestimate', 'aggregatetimespent', 'worklogid', 'remainingestimate', 'time spent', 'original estimate', 'remaining estimate', 'work ratio', 'lastviewed']);

/** Кто я для Jira: имя из аккаунта (узнаётся один раз и только удачно) и имена из профиля; по ним узнаются «назначили на меня» и «изменил я сам». */
const accounts = new Map<string, string>();

async function myNames(client: JiraClient, tokenKey: string, profile: Profile, log: (m: string) => void): Promise<Set<string>> {
  let display = accounts.get(tokenKey);
  if (display === undefined) {
    try {
      display = (await client.myself()).displayName;
      if (display) accounts.set(tokenKey, display);
    } catch (err) {
      // сбой не кэшируем: в следующий опрос спросим снова
      log(`Jira: не удалось узнать, кто я: ${(err as Error).message}`);
    }
  }
  return new Set([display ?? '', ...profile.names].map((n) => n.trim().toLowerCase()).filter(Boolean));
}

const ms = (iso: string): number => Date.parse(iso) || 0;

type ChangeKind = 'assigned' | 'changed' | 'comment' | 'new';

const KIND_TEXT: Record<ChangeKind, string> = {
  assigned: 'Назначили на вас',
  changed: 'Изменилось',
  comment: 'Новый комментарий или правка без истории',
  new: 'Новая задача в вашей выборке',
};

async function poll(ctx: SourceCtx, deps: JiraDeps): Promise<RoutineEvent[]> {
  const startedAt = (deps.now ?? Date.now)();
  const creds = need(deps);
  const client = jiraClient(creds.cfg, creds.token, ctx.fetch);
  const host = new URL(normalizeBaseUrl(creds.cfg.baseUrl)).host;
  const jql = cfgStr(ctx.spec, 'jql') ?? ASSIGNED_TO_ME_JQL;
  const issues = await client.search(jql, 50);
  const prevCursor = ctx.cursor.get() as Cursor | undefined;
  const cursor = (prevCursor ?? {}) as Cursor;
  // самый первый опрос только запоминает (его события движок отбрасывает): историю по каждой задаче не запрашиваем
  const first = prevCursor === undefined;
  const known = { ...(cursor.known ?? {}) };
  const own = { ...(cursor.own ?? {}) };
  const seen = { ...(cursor.seen ?? {}) };
  const fails = { ...(cursor.fails ?? {}) };
  // порядок ключей в known — по давности: недавно виденную задачу переставляем в конец, обрезка до 300 бьёт по давно не виденным
  const remember = (key: string, updated: string): void => {
    delete known[key];
    known[key] = updated;
  };
  // «новее прошлого опроса»: для задачи, впервые попавшей в выборку, и для назначения на меня
  const recentCut = (cursor.at ?? startedAt - 24 * 3600_000) - OVERLAP_MS;
  for (const [k, b] of bumps) if (Date.now() - b.setAt > BUMP_TTL_MS) bumps.delete(k);
  const out: RoutineEvent[] = [];
  let fetched = 0;
  let histories = 0;
  const me = first ? new Set<string>() : await myNames(client, `${creds.cfg.baseUrl}|${creds.cfg.email}`, (deps.profile ?? loadProfile)(), ctx.log);
  // не знаем, кто я: «назначили на меня» не найти, свои правки не отличить — пропускаем опрос целиком, курсор не двигаем
  if (!first && !me.size) {
    ctx.log('Jira: профиль «кто я» пуст и аккаунт не определился — опрос пропущен');
    return [];
  }
  const mine = (c: JiraChange): boolean => Boolean(c.author) && me.has(c.author.trim().toLowerCase());
  const toMe = (c: JiraChange): boolean => c.field.toLowerCase() === 'assignee' && me.has(c.to.trim().toLowerCase());
  const getFull = async (key: string): Promise<JiraIssue | undefined> => {
    if (fetched >= DESCRIPTION_FETCHES) return undefined;
    fetched++;
    try {
      return await client.issue(key);
    } catch (err) {
      ctx.log(`Jira ${key}: описание не получено: ${(err as Error).message}`);
      return undefined;
    }
  };

  for (const b of issues) {
    const updated = b.updated ?? '';
    const bump = bumps.get(bumpKey(ctx.slug, b.key));
    if (bump && updated && Date.parse(updated) <= bump.created + SELF_BUMP_MS) {
      // обновление от нашего же комментария: запоминаем его как своё, событием оно не станет ни сейчас, ни в следующих опросах
      bumps.delete(bumpKey(ctx.slug, b.key));
      own[b.key] = updated;
    }
    if (updated && own[b.key] === updated) {
      remember(b.key, updated);
      continue;
    }
    // ничего нового с прошлого опроса
    if (known[b.key] === updated) continue;
    const isNew = known[b.key] === undefined;

    let changes: JiraChange[] = [];
    let kind: ChangeKind = 'new';
    let full: JiraIssue | undefined;
    if (!first) {
      if (histories >= HISTORY_FETCHES) continue;
      histories++;
      // задачу, впервые попавшую в выборку, различаем по created: ему нужна полная задача (подождёт следующего опроса, если лимит вышел)
      if (isNew) {
        full = await getFull(b.key);
        if (!full) continue;
      }
      // известная — записи после прошлого раза; новая в выборке — только то, что произошло после прошлого опроса
      const since = isNew ? recentCut : (seen[b.key] ?? ms(known[b.key]));
      let all: JiraChange[];
      try {
        all = await client.changelog(b.key);
        delete fails[b.key];
      } catch (err) {
        ctx.log(`Jira ${b.key}: история не получена: ${(err as Error).message}`);
        // блип Jira не должен стереть назначение: курсор по задаче не двигаем, спросим в следующий опрос
        const n = (fails[b.key] ?? 0) + 1;
        if (n < HISTORY_RETRIES) {
          fails[b.key] = n;
          continue;
        }
        delete fails[b.key];
        all = [];
      }
      const freshAll = all.filter((c) => ms(c.at) > since);
      const meaningful = freshAll.filter((c) => !NOISY_FIELDS.has(c.field.toLowerCase()));
      // назначение самим собой — моя правка, а не «назначили на вас»
      const assigned = meaningful.filter((c) => toMe(c) && !mine(c));
      const lastEntry = Math.max(0, ...freshAll.map((c) => ms(c.at)));
      if (assigned.length) {
        // назначили: событие про последнее назначение, прочие правки того же момента в него не входят
        kind = 'assigned';
        changes = assigned.slice(-1);
      } else if (isNew) {
        // без назначения событием становится только созданная после прошлого опроса; задача, давно назначенная и просто поднявшаяся в выборке, запоминается молча
        const created = full?.created ? ms(full.created) : 0;
        if (created <= recentCut) {
          remember(b.key, updated);
          seen[b.key] = Math.max(seen[b.key] ?? 0, lastEntry, ms(updated));
          continue;
        }
        kind = 'new';
      } else {
        changes = meaningful.filter((c) => !mine(c));
        if (!changes.length) {
          // записи есть, но все мои или служебные: событием это не станет, если после них не было комментария
          const commented = ms(updated) - lastEntry > COMMENT_GAP_MS;
          if (freshAll.length && !commented) {
            remember(b.key, updated);
            seen[b.key] = Math.max(seen[b.key] ?? 0, lastEntry);
            continue;
          }
          kind = 'comment';
        } else kind = 'changed';
      }
      seen[b.key] = Math.max(seen[b.key] ?? 0, lastEntry, kind === 'comment' ? ms(updated) : 0);
    }

    full ??= await getFull(b.key);
    remember(b.key, updated);
    const stamp = changes.length ? changes[changes.length - 1].at : updated;
    const shown = changes.slice(0, MAX_CHANGES_SHOWN).map(describeChange).join('; ');
    const more = changes.length > MAX_CHANGES_SHOWN ? ` и ещё ${changes.length - MAX_CHANGES_SHOWN}` : '';
    const headline = kind === 'assigned' || kind === 'changed' ? `${KIND_TEXT[kind]}: ${shown}${more}` : KIND_TEXT[kind];
    out.push({
      source: ctx.slug,
      id: `${b.key}@${kind}@${stamp}`,
      at: stamp && Number.isFinite(Date.parse(stamp)) ? new Date(stamp).toISOString() : new Date().toISOString(),
      title: `${b.key} ${b.title}`,
      text: `${headline}\n\n${describeIssue(full, b)}`,
      link: b.url,
      things: [jiraThing({ host, key: b.key, url: b.url, title: b.title })],
      fields: {
        key: b.key,
        summary: b.title,
        status: b.status,
        status_category: b.statusCategory,
        type: b.type,
        priority: b.priority ?? '',
        labels: full?.labels ?? [],
        parent: b.parent?.key ?? '',
        change: kind,
        assigned_to_me: kind === 'assigned',
        assignee: full?.assignee?.displayName ?? '',
        changes: changes.map(describeChange),
        changed_fields: [...new Set(changes.map((c) => c.field.toLowerCase()))],
        changed_by: [...new Set(changes.map((c) => c.author).filter(Boolean))],
      },
      replyTo: { key: b.key },
    });
  }
  // курсор не растёт бесконечно: храним последние 300 задач
  const keys = Object.keys(known);
  for (const k of keys.slice(0, Math.max(0, keys.length - 300))) {
    delete known[k];
    delete seen[k];
    delete fails[k];
  }
  for (const k of Object.keys(own).slice(0, Math.max(0, Object.keys(own).length - 300))) Reflect.deleteProperty(own, k);
  ctx.cursor.set({ known, own, seen, fails, at: startedAt });
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
    summary: 'Задачи Jira: назначили на меня и что изменилось',
    delivery: 'poll',
    minEveryMs: MIN_POLL_MS,
    setup: [{ key: 'jql', label: 'Запрос JQL', placeholder: ASSIGNED_TO_ME_JQL, optional: true, hint: 'Адрес, email и токен Jira берутся из «Подключений». Пусто — ваши незакрытые задачи («назначено на меня»).' }],
    match: [
      ...BASE_MATCH,
      { key: 'status', label: 'Статус', type: 'text' },
      { key: 'type', label: 'Тип задачи', type: 'text' },
      { key: 'priority', label: 'Приоритет', type: 'text' },
      { key: 'key', label: 'Ключ задачи', type: 'text' },
      { key: 'change', label: 'Что случилось: assigned, changed, comment, new', type: 'text' },
      { key: 'assigned_to_me', label: 'Назначили на меня', type: 'bool' },
      { key: 'assignee', label: 'Исполнитель', type: 'text' },
      { key: 'changed_fields', label: 'Что изменилось (status, assignee, priority…)', type: 'text' },
    ],
    poll: (ctx) => poll(ctx, deps),
    reply: (ctx, target, text) => reply(ctx, deps, target, text),
    describe: (spec) => `Jira: задачи по запросу ${cfgStr(spec, 'jql') ?? ASSIGNED_TO_ME_JQL}. Событие — когда задачу назначили на вас, когда в ней что-то изменилось (по истории Jira: статус, исполнитель, приоритет…) или появилась новая правка без истории (комментарий); ваши собственные правки в истории и назначение себя событием не считаются (комментарий из интерфейса Jira от вашего — отличить нельзя). Опрос раз в минуту, только чтение; ответ — комментарий к задаче.`,
  };
}
