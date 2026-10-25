// Клиент Jira Cloud REST v3: Basic email:token. Токен в ошибки и ответы не попадает.
import type { JiraSettings } from './settings.js';
import type { JiraIssueBrief } from './api-types.js';

export type FetchFn = typeof fetch;

/** Поиск в Jira Cloud: старый /search снят, новый отдаёт issues + nextPageToken. */
export const JIRA_SEARCH_PATH = '/rest/api/3/search/jql';

export const JQL_PRESETS = {
  sprint: 'assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC',
  mine: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
} as const;
export type JqlPreset = keyof typeof JQL_PRESETS;

/** Без явных fields поиск вернёт только id. */
export const LIST_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'updated', 'parent'];
const ISSUE_FIELDS = [...LIST_FIELDS, 'description', 'subtasks', 'issuelinks', 'labels'];

// задача в списке — общая с UI: src/api-types.ts
export type { JiraIssueBrief } from './api-types.js';

export type JiraIssue = JiraIssueBrief & {
  description: string;
  labels: string[];
  subtasks: { key: string; title: string; status: string }[];
  links: { relation: string; key: string; title: string }[];
};

export type JiraClient = {
  myself(): Promise<{ accountId: string; displayName: string }>;
  search(jql: string, max?: number): Promise<JiraIssueBrief[]>;
  issue(key: string): Promise<JiraIssue>;
};

export class JiraError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

export function normalizeBaseUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new JiraError('Адрес Jira должен быть https://');
  return u.origin;
}

/** Ключ задачи из ключа или ссылки (…/browse/ABC-12, ?selectedIssue=ABC-12). */
export function parseIssueKey(raw: string): string | undefined {
  const s = raw.trim();
  if (KEY_RE.test(s.toUpperCase())) return s.toUpperCase();
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)/);
    const k = m?.[1] ?? u.searchParams.get('selectedIssue') ?? '';
    return KEY_RE.test(k.toUpperCase()) ? k.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

export function jiraClient(cfg: JiraSettings, token: string, fetchFn: FetchFn = fetch): JiraClient {
  const base = normalizeBaseUrl(cfg.baseUrl);
  const auth = 'Basic ' + Buffer.from(`${cfg.email}:${token}`).toString('base64');

  async function call<T>(method: 'GET' | 'POST', p: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(base + p, {
        method,
        headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new JiraError(`Jira недоступна: ${(err as Error).message}`);
    }
    if (!res.ok) throw new JiraError(await httpError(res), res.status);
    return (await res.json()) as T;
  }

  const brief = (raw: RawIssue): JiraIssueBrief => {
    const f = raw.fields ?? {};
    return {
      key: raw.key,
      title: f.summary ?? '',
      status: f.status?.name ?? '',
      statusCategory: f.status?.statusCategory?.key ?? '',
      type: f.issuetype?.name ?? '',
      priority: f.priority?.name,
      updated: f.updated,
      parent: f.parent ? { key: f.parent.key, title: f.parent.fields?.summary ?? '' } : undefined,
      url: `${base}/browse/${raw.key}`,
    };
  };

  return {
    async myself() {
      const r = await call<{ accountId: string; displayName: string }>('GET', '/rest/api/3/myself');
      return { accountId: r.accountId, displayName: r.displayName };
    },
    async search(jql, max = 50) {
      const r = await call<{ issues?: RawIssue[] }>('POST', JIRA_SEARCH_PATH, { jql, fields: LIST_FIELDS, maxResults: max });
      return (r.issues ?? []).map(brief);
    },
    async issue(key) {
      if (!KEY_RE.test(key)) throw new JiraError(`Не ключ задачи Jira: ${key}`);
      const raw = await call<RawIssue>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(',')}`);
      const f = raw.fields ?? {};
      return {
        ...brief(raw),
        description: adfToMarkdown(f.description).trim(),
        labels: f.labels ?? [],
        subtasks: (f.subtasks ?? []).map((s) => ({ key: s.key, title: s.fields?.summary ?? '', status: s.fields?.status?.name ?? '' })),
        links: (f.issuelinks ?? []).flatMap((l) => {
          const other = l.outwardIssue ?? l.inwardIssue;
          if (!other) return [];
          const relation = (l.outwardIssue ? l.type?.outward : l.type?.inward) ?? l.type?.name ?? '';
          return [{ relation, key: other.key, title: other.fields?.summary ?? '' }];
        }),
      };
    },
  };
}

/** Статус + errorMessages/errors Jira; заголовки запроса (с токеном) сюда не попадают. */
async function httpError(res: Response): Promise<string> {
  let detail = '';
  try {
    const j = (await res.json()) as { errorMessages?: string[]; errors?: Record<string, string> };
    detail = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join('; ');
  } catch {
    // тело не JSON — хватит статуса
  }
  const hint = res.status === 401 ? ' (проверь email и API-токен)' : res.status === 403 ? ' (нет доступа)' : '';
  return `Jira ответила ${res.status}${hint}${detail ? `: ${detail}` : ''}`;
}

type RawIssueRef = { key: string; fields?: { summary?: string; status?: { name?: string } } };
type RawIssue = {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    priority?: { name?: string };
    updated?: string;
    parent?: RawIssueRef;
    description?: unknown;
    labels?: string[];
    subtasks?: RawIssueRef[];
    issuelinks?: { type?: { name?: string; inward?: string; outward?: string }; inwardIssue?: RawIssueRef; outwardIssue?: RawIssueRef }[];
  };
};

type AdfNode = { type?: string; text?: string; content?: AdfNode[]; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[] };

/** ADF (Atlassian Document Format) → markdown. Незнакомые узлы не теряют текст: обходим их детей. */
export function adfToMarkdown(doc: unknown): string {
  if (!doc) return '';
  if (typeof doc === 'string') return doc;
  return block(doc as AdfNode, '').replace(/\n{3,}/g, '\n\n');
}

function inline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(inlineNode).join('');
}

function inlineNode(n: AdfNode): string {
  const a = n.attrs ?? {};
  switch (n.type) {
    case 'text': {
      let t = n.text ?? '';
      for (const m of n.marks ?? []) {
        if (m.type === 'strong') t = `**${t}**`;
        else if (m.type === 'em') t = `*${t}*`;
        else if (m.type === 'code') t = '`' + t + '`';
        else if (m.type === 'strike') t = `~~${t}~~`;
        else if (m.type === 'link' && typeof m.attrs?.href === 'string') t = `[${t}](${m.attrs.href})`;
      }
      return t;
    }
    case 'hardBreak':
      return '\n';
    case 'mention':
      return String(a.text ?? '@?');
    case 'emoji':
      return String(a.text ?? a.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return String(a.url ?? '');
    case 'date':
      return a.timestamp ? new Date(Number(a.timestamp)).toISOString().slice(0, 10) : '';
    case 'status':
      return `[${String(a.text ?? '')}]`;
    default:
      return n.text ?? inline(n.content);
  }
}

function block(n: AdfNode, indent: string): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case 'doc':
      return kids.map((k) => block(k, indent)).join('');
    case 'paragraph':
      return indent + inline(kids) + '\n\n';
    case 'heading':
      return '#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level) || 2))) + ' ' + inline(kids) + '\n\n';
    case 'bulletList':
    case 'orderedList':
      return (
        kids
          .map((li, i) => {
            const mark = n.type === 'orderedList' ? `${i + 1}. ` : '- ';
            const body = (li.content ?? []).map((c) => block(c, indent + '  ')).join('').trim();
            return indent + mark + body.replace(/^\s+/, '');
          })
          .join('\n') + '\n\n'
      );
    case 'taskList':
      return kids.map((t) => `${indent}- [${t.attrs?.state === 'DONE' ? 'x' : ' '}] ${inline(t.content)}`).join('\n') + '\n\n';
    case 'codeBlock':
      return '```' + String(n.attrs?.language ?? '') + '\n' + inline(kids) + '\n```\n\n';
    case 'blockquote':
    case 'panel':
      return kids.map((k) => block(k, indent)).join('').trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
    case 'rule':
      return '---\n\n';
    case 'table':
      return kids.map((row) => '| ' + (row.content ?? []).map((c) => (c.content ?? []).map((x) => block(x, '')).join(' ').trim().replace(/\n+/g, ' ')).join(' | ') + ' |').join('\n') + '\n\n';
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '[вложение]\n\n';
    default:
      // незнакомый блок или inline-узел на уровне блока: текст не теряем
      if (kids.some((k) => k.type === 'paragraph' || k.type === 'bulletList' || k.type === 'orderedList')) return kids.map((k) => block(k, indent)).join('');
      return inlineNode(n) + (kids.length || n.text ? '\n\n' : '');
  }
}
