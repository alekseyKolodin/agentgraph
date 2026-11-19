// Канонические ключи вещей (формат — src/things/types.ts): собираются и разбираются только здесь. По ключу определяется
// «то же самое», откуда бы ни пришёл сигнал: MR из GitLab и ссылка на него в Slack дают один ключ. Без node-импортов —
// модуль может читать и веб.
import type { ThingType, ThreadRef } from './types.js';

const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-[1-9]\d*$/;

/** Хост в ключе: нижний регистр, без схемы, пути, логина, «www.», точки в конце и порта по умолчанию. */
export function normHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^[^@]*@/, '')
    .replace(/:(80|443)$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/**
 * Путь проекта в ключе: без «/» по краям и «.git», в нижнем регистре — GitLab и GitHub не различают регистр пути, а
 * ссылка из Slack и ответ API пишут его по-разному. Для запросов к API берите путь из ref вещи, а не из ключа.
 */
export function normProject(raw: string): string {
  let p = raw.trim();
  try {
    p = decodeURIComponent(p);
  } catch {
    /* не процентная запись — как есть */
  }
  return p
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/** Корень репо в ключе ветки: «/» вместо «\», без «/» в конце. Worktree к основному checkout сворачивает вызывающий (repoRoot). */
export function normRoot(raw: string): string {
  const p = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** «/» и «%» в части ключа нити — процентами: части разбираются обратно однозначно. */
const encPart = (s: string): string => s.replace(/%/g, '%25').replace(/\//g, '%2F');
const decPart = (s: string): string => s.replace(/%2F/gi, '/').replace(/%25/g, '%');

const bad = (what: string): Error => new Error(`Ключ вещи не собрать: ${what}`);

/** mr:<host>/<путь проекта>/<номер>. */
export function mrKey(host: string, project: string, number: number): string {
  const h = normHost(host);
  const p = normProject(project);
  if (!h || !p || !p.includes('/') || !Number.isInteger(number) || number <= 0) throw bad(`MR ${host} ${project} ${number}`);
  return `mr:${h}/${p}/${number}`;
}

/** jira:<host>/<KEY-123>. */
export function jiraKey(host: string, key: string): string {
  const h = normHost(host);
  const k = key.trim().toUpperCase();
  if (!h || !JIRA_KEY_RE.test(k)) throw bad(`задача Jira ${host} ${key}`);
  return `jira:${h}/${k}`;
}

/** tw:<команда>/<проект>/<id>. */
export function twKey(team: string, project: string, id: string): string {
  if (!team.trim() || !project.trim() || !id.trim()) throw bad(`задача Teamwork ${team}/${project}/${id}`);
  return `tw:${encPart(team.trim())}/${encPart(project.trim())}/${encPart(id.trim())}`;
}

/** branch:<корень репо>#<ветка>. root — основной checkout (worktree сворачивает вызывающий: repoRoot в git.ts). */
export function branchKey(root: string, branch: string): string {
  const r = normRoot(root);
  const b = branch.trim().replace(/^refs\/heads\//, '');
  if (!r || r.includes('#') || !b) throw bad(`ветка ${root} ${branch}`);
  return `branch:${r}#${b}`;
}

/** thread:<источник>/<канал>/<нить>; канала нет — пустая часть. */
export function threadKey(t: ThreadRef): string {
  if (!t.source.trim() || !t.thread.trim()) throw bad(`нить ${t.source} ${t.thread}`);
  return `thread:${encPart(t.source.trim())}/${encPart(t.channel?.trim() ?? '')}/${encPart(t.thread.trim())}`;
}

export const sessionKey = (id: string): string => `session:${id.trim()}`;
/** id первого запуска цепочки: продолжение упавшего запуска — та же вещь. */
export const runKey = (firstRunId: string): string => `run:${firstRunId.trim()}`;
export const ownKey = (id: string): string => `own:${id.trim()}`;

const TYPES: Record<string, ThingType> = { mr: 'mr', jira: 'jira', tw: 'teamwork', branch: 'branch', session: 'session', run: 'run', thread: 'thread', own: 'own' };

/** Ключ → тип и ref (то, что нужно наблюдателю). Не ключ вещи — undefined. Регистр пути MR в ref — как в ключе (нижний). */
export function parseKey(key: string): { type: ThingType; ref: Record<string, unknown> } | undefined {
  const i = key.indexOf(':');
  if (i <= 0) return undefined;
  const type = TYPES[key.slice(0, i)];
  const rest = key.slice(i + 1);
  if (!type || !rest) return undefined;
  switch (type) {
    case 'mr': {
      const m = /^([^/]+)\/(.+\/.+)\/([1-9]\d*)$/.exec(rest);
      return m ? { type, ref: { host: m[1], project: m[2], number: Number(m[3]) } } : undefined;
    }
    case 'jira': {
      const m = /^([^/]+)\/([^/]+)$/.exec(rest);
      return m && JIRA_KEY_RE.test(m[2] ?? '') ? { type, ref: { host: m[1], key: m[2] } } : undefined;
    }
    case 'teamwork': {
      const parts = rest.split('/');
      const [team = '', project = '', id = ''] = parts;
      return parts.length === 3 && parts.every(Boolean) ? { type, ref: { team: decPart(team), project: decPart(project), id: decPart(id) } } : undefined;
    }
    case 'branch': {
      const h = rest.indexOf('#');
      return h > 0 && h < rest.length - 1 ? { type, ref: { root: rest.slice(0, h), branch: rest.slice(h + 1) } } : undefined;
    }
    case 'thread': {
      const parts = rest.split('/');
      if (parts.length !== 3 || !parts[0] || !parts[2]) return undefined;
      return { type, ref: { source: decPart(parts[0]), ...(parts[1] ? { channel: decPart(parts[1]) } : {}), thread: decPart(parts[2]) } };
    }
    default:
      return { type, ref: { id: rest } };
  }
}

/** Короткая подпись вещи для журнала и карточки: «MR grp/app!12», «PR o/r#7», «ABC-12», «ветка feat/x». */
export function keyLabel(key: string, forge?: string): string {
  const p = parseKey(key);
  if (!p) return key;
  const r = p.ref;
  switch (p.type) {
    case 'mr':
      return forge === 'github' || (!forge && r.host === 'github.com') ? `PR ${r.project}#${r.number}` : `MR ${r.project}!${r.number}`;
    case 'jira':
      return String(r.key);
    case 'branch':
      return `ветка ${r.branch}`;
    case 'teamwork':
      return `задача ${r.id}`;
    default:
      return key;
  }
}
