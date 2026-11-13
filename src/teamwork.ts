// Teamwork, чистая логика без git и HTTP (docs/teamwork/spec.md §5, §8.4–8.6, §9.1): разбор и запись файлов репо команды
// с сохранением неизвестных полей, номера задач и требований, дробный индекс порядка, разделы markdown, проверка
// зависимостей разбивки, слияние полей при конфликте. Файлы читает и пишет src/teamwork-repo.ts, маршруты — src/teamwork-server.ts.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parse as parseYaml, parseDocument, stringify as toYaml, isMap } from 'yaml';
import { configDir } from './settings.js';
import type {
  TeamColumns, TeamComment, TeamDependencyReport, TeamDocName, TeamMember, TeamProjectStatus, TeamProposedTask, TeamRequirement, TeamSprint, TeamSprintStatus,
  TeamTask, TeamTaskStatus, TeamTaskType,
} from './api-types.js';

/** Версия формата репо команды, которую знает этот agentgraph; новее — только чтение (spec §5.9). */
export const TEAM_FORMAT = 1;

export const TASK_STATUSES: readonly TeamTaskStatus[] = ['todo', 'in_progress', 'review', 'done'];
export const TASK_TYPES: readonly TeamTaskType[] = ['feature', 'bug', 'chore'];
export const SPRINT_STATUSES: readonly TeamSprintStatus[] = ['planned', 'active', 'closed'];
export const PROJECT_STATUSES: readonly TeamProjectStatus[] = ['active', 'archived'];
export const DEFAULT_COLUMNS: TeamColumns = { todo: 'К работе', in_progress: 'В работе', review: 'Ревью', done: 'Готово' };

/** Слаг команды и проекта: имя папки. */
export const TEAM_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Префикс номеров задач: латиница, 2–6 букв (spec §5.2). */
export const PREFIX_RE = /^[A-Z]{2,6}$/;
export const TASK_ID_RE = /^[A-Z]{2,6}-\d+$/;
export const FLOW_NAME_RE = /^[a-z0-9-]+$/;
/** Ветка задачи в файле: латиница, цифры, «._/-», без ведущего «-» — её получают агент в тексте задачи и git аргументом (S-3). */
export const TASK_BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]+$/;
/** Строка требования ТЗ: «- FR-3. Текст» или «- NFR-2. Текст» в любом разделе (spec §8.4). */
export const REQUIREMENT_RE = /^- (FR|NFR)-(\d+)\.\s+(.*)$/;
const CHECKBOX_RE = /^\s*[-*+]\s+\[([ xX])\]\s/;
const SECTION_RE = /^## (.*)$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** Корень команд: <configDir()>/teams. Читается при каждом вызове, как spacesDir(): тесты подменяют AGENTGRAPH_CONFIG_DIR. */
export function teamsDir(): string {
  return path.join(configDir(), 'teams');
}

// ---------- общие помощники

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** Даты в YAML разбираются в Date: нам нужна строка ISO как в файле. */
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : str(v));
/** JSON с ключами объектов по алфавиту: тот же объект с другим порядком ключей (правка руками) — то же значение. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));

/** Короткий хэш текста: base документа и задачи, хэш раздела. */
export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** YAML без длинных переносов строк: заголовки задач не ломаются посреди слова. */
export const yamlText = (obj: unknown): string => toYaml(obj, { lineWidth: 0 });

function parseYamlRecord(text: string, what: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`${what}: ошибка YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw new Error(`${what}: ожидался объект с полями`);
  return raw;
}

/**
 * Правка YAML-файла по месту: поля из patch меняются или снимаются (undefined), остальное — комментарии, неизвестные
 * поля, порядок — остаётся как было (spec §5.9). Пустой или не-объект файл становится объектом.
 */
export function updateYaml(text: string, patch: Record<string, unknown>): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`ошибка YAML: ${doc.errors[0].message}`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error('ожидался объект с полями');
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      if (doc.contents !== null) doc.delete(k);
    } else doc.set(k, v);
  }
  return doc.toString({ lineWidth: 0 });
}

/**
 * Правка frontmatter задачи по месту, как updateYaml: остальные поля, вложенные неизвестные поля, комментарии и тело
 * остаются как были. Файл без frontmatter — как есть.
 */
export function updateTaskText(text: string, patch: Record<string, unknown>): string {
  const m = text.match(/^(---\r?\n)([\s\S]*?\r?\n)(---[ \t]*(?:\r?\n|$))/);
  if (!m) return text;
  const yaml = updateYaml(m[2], patch);
  return m[1] + (yaml.endsWith('\n') ? yaml : `${yaml}\n`) + m[3] + text.slice(m[0].length);
}

// ---------- teamwork.yaml

export type TeamConfig = {
  format: number;
  title: string;
  prefix: string;
  columns: TeamColumns;
  members: TeamMember[];
  defaultFlow?: string;
  /** Наибольший выданный номер задачи, которого может не быть среди задач (удалена): номер не возвращается (spec §5.7). */
  lastTask?: number;
  /** Неизвестные поля: сохраняются при записи. */
  extra: Record<string, unknown>;
};

export function parseTeamConfig(text: string): TeamConfig {
  const { format, title, prefix, columns, members, defaultFlow, lastTask, ...extra } = parseYamlRecord(text, 'teamwork.yaml');
  const fmt = typeof format === 'number' && Number.isInteger(format) && format > 0 ? format : undefined;
  if (!fmt) throw new Error('teamwork.yaml: нет поля format');
  const pfx = str(prefix)?.trim().toUpperCase() ?? '';
  if (!PREFIX_RE.test(pfx)) throw new Error('teamwork.yaml: prefix — латиница, 2–6 букв');
  return {
    format: fmt,
    title: str(title)?.trim() || pfx,
    prefix: pfx,
    columns: parseColumns(columns),
    members: parseMembers(members),
    ...(str(defaultFlow)?.trim() ? { defaultFlow: str(defaultFlow)!.trim() } : {}),
    ...(typeof lastTask === 'number' && Number.isInteger(lastTask) && lastTask > 0 ? { lastTask } : {}),
    extra,
  };
}

/** Названия колонок: ключи фиксированы, пропущенные — по умолчанию (spec §3.2). */
export function parseColumns(v: unknown): TeamColumns {
  const out = { ...DEFAULT_COLUMNS };
  if (!isRecord(v)) return out;
  for (const s of TASK_STATUSES) {
    const t = str(v[s])?.trim();
    if (t) out[s] = t;
  }
  return out;
}

export function parseMembers(v: unknown): TeamMember[] {
  if (!Array.isArray(v)) return [];
  const out: TeamMember[] = [];
  for (const m of v) {
    if (!isRecord(m)) continue;
    const email = str(m.email)?.trim().toLowerCase();
    if (!email) continue;
    const github = str(m.github)?.trim();
    const gitlab = str(m.gitlab)?.trim();
    out.push({ name: str(m.name)?.trim() || email, email, ...(github ? { github } : {}), ...(gitlab ? { gitlab } : {}) });
  }
  return out;
}

export function serializeTeamConfig(cfg: TeamConfig): string {
  return yamlText({
    format: cfg.format,
    title: cfg.title,
    prefix: cfg.prefix,
    columns: cfg.columns,
    members: cfg.members,
    ...(cfg.defaultFlow ? { defaultFlow: cfg.defaultFlow } : {}),
    ...(cfg.lastTask ? { lastTask: cfg.lastTask } : {}),
    ...cfg.extra,
  });
}

// ---------- project.yaml

export type ProjectRepo = { key: string; url: string; defaultBranch?: string };
export type ProjectConfig = {
  slug: string;
  title: string;
  summary: string;
  status: TeamProjectStatus;
  repos: ProjectRepo[];
  createdAt?: string;
  createdBy?: string;
  /** Последние выданные номера требований: удалённый номер не возвращается (spec §8.4). */
  lastRequirement?: { FR?: number; NFR?: number };
  extra: Record<string, unknown>;
};

/**
 * project.yaml. slug — имя папки проекта: оно главнее поля в файле, иначе скопированная папка projects/alpha → gamma
 * отдавала бы документы, спринты и пространство alpha (S-5). Без него (разбор текста без папки) — поле slug файла.
 */
export function parseProject(text: string, slug?: string): ProjectConfig {
  const { slug: s, title, summary, status, repos, createdAt, createdBy, lastRequirement, ...extra } = parseYamlRecord(text, 'project.yaml');
  const own = slug || str(s)?.trim();
  if (!own || !TEAM_SLUG_RE.test(own)) throw new Error('project.yaml: нет поля slug');
  const st = str(status)?.trim();
  const list: ProjectRepo[] = [];
  if (Array.isArray(repos)) {
    for (const r of repos) {
      if (!isRecord(r)) continue;
      const key = str(r.key)?.trim();
      const url = str(r.url)?.trim();
      if (!key || !url) continue;
      const defaultBranch = str(r.defaultBranch)?.trim();
      list.push({ key, url, ...(defaultBranch ? { defaultBranch } : {}) });
    }
  }
  const last = isRecord(lastRequirement) ? lastRequirement : undefined;
  const lr: ProjectConfig['lastRequirement'] = {};
  if (typeof last?.FR === 'number') lr.FR = last.FR;
  if (typeof last?.NFR === 'number') lr.NFR = last.NFR;
  return {
    slug: own,
    title: str(title)?.trim() || own,
    summary: str(summary)?.trim() ?? '',
    status: st === 'archived' ? 'archived' : 'active',
    repos: list,
    ...(iso(createdAt) ? { createdAt: iso(createdAt) } : {}),
    ...(str(createdBy) ? { createdBy: str(createdBy) } : {}),
    ...(Object.keys(lr).length ? { lastRequirement: lr } : {}),
    extra,
  };
}

export function serializeProject(p: ProjectConfig): string {
  return yamlText({
    slug: p.slug,
    title: p.title,
    summary: p.summary,
    status: p.status,
    repos: p.repos,
    ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    ...(p.createdBy ? { createdBy: p.createdBy } : {}),
    ...(p.lastRequirement && Object.keys(p.lastRequirement).length ? { lastRequirement: p.lastRequirement } : {}),
    ...p.extra,
  });
}

// ---------- спринт

export type SprintFile = TeamSprint & { extra: Record<string, unknown> };

export function parseSprint(text: string, numberFromFile?: number): SprintFile {
  const { number, title, goal, status, startedAt, startedBy, closedAt, closedBy, result, ...extra } = parseYamlRecord(text, 'спринт');
  const n = typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : numberFromFile;
  if (!n) throw new Error('спринт: нет поля number');
  const st = str(status)?.trim() as TeamSprintStatus | undefined;
  const res = isRecord(result) ? { done: strList(result.done), carried: strList(result.carried), returned: strList(result.returned) } : undefined;
  return {
    number: n,
    title: str(title)?.trim() || `Спринт ${n}`,
    ...(str(goal)?.trim() ? { goal: str(goal)!.trim() } : {}),
    status: st && SPRINT_STATUSES.includes(st) ? st : 'planned',
    ...(iso(startedAt) ? { startedAt: iso(startedAt) } : {}),
    ...(str(startedBy) ? { startedBy: str(startedBy) } : {}),
    ...(iso(closedAt) ? { closedAt: iso(closedAt) } : {}),
    ...(str(closedBy) ? { closedBy: str(closedBy) } : {}),
    ...(res ? { result: res } : {}),
    extra,
  };
}

export function serializeSprint(s: SprintFile): string {
  return yamlText({
    number: s.number,
    title: s.title,
    ...(s.goal ? { goal: s.goal } : {}),
    status: s.status,
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    ...(s.startedBy ? { startedBy: s.startedBy } : {}),
    ...(s.closedAt ? { closedAt: s.closedAt } : {}),
    ...(s.closedBy ? { closedBy: s.closedBy } : {}),
    ...(s.result ? { result: s.result } : {}),
    ...s.extra,
  });
}

/** Публичная часть спринта без extra — для API. */
export const sprintView = ({ extra: _e, ...s }: SprintFile): TeamSprint => s;

export const nextSprintNumber = (sprints: Pick<TeamSprint, 'number'>[]): number => sprints.reduce((m, s) => Math.max(m, s.number), 0) + 1;

/** Итог спринта для списка проектов: готово, всего, по статусам. */
export function sprintSummary(tasks: Pick<TeamTask, 'status' | 'sprint'>[], n: number): { done: number; total: number; counts: Record<TeamTaskStatus, number> } {
  const counts: Record<TeamTaskStatus, number> = { todo: 0, in_progress: 0, review: 0, done: 0 };
  for (const t of tasks) if (t.sprint === n) counts[t.status]++;
  return { done: counts.done, total: Object.values(counts).reduce((a, b) => a + b, 0), counts };
}

// ---------- задача

export type TaskFile = TeamTask & { extra: Record<string, unknown> };

/** Frontmatter между строками «---» в начале файла и текст под ним. undefined — файл не начинается с «---». */
export function splitFrontmatter(text: string): { yaml: string; body: string } | undefined {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return undefined;
  return { yaml: m[1], body: text.slice(m[0].length) };
}

/** Задача по файлу tasks/<ID>.md. Файл, который не разобрался, даёт задачу с error и телом как есть, а не исключение (spec §5.9). */
export function parseTask(text: string, file: string): TaskFile {
  const fileId = path.basename(file).replace(/\.md$/i, '');
  const base = textHash(text);
  const broken = (error: string, body = ''): TaskFile => ({
    id: fileId, title: fileId, type: 'feature', status: 'todo', rank: '', blockedBy: [], covers: [], body, acceptance: { done: 0, total: 0 }, comments: 0, base, file, error, extra: {},
  });
  const fm = splitFrontmatter(text);
  if (!fm) return broken('нет frontmatter', text);
  let raw: Record<string, unknown>;
  try {
    raw = parseYamlRecord(fm.yaml, 'frontmatter');
  } catch (err) {
    return broken(err instanceof Error ? err.message : String(err), fm.body);
  }
  const { id, title, type, status, sprint, rank, assignee, estimate, repo, branch, pr, blockedBy, covers, createdAt, createdBy, updatedAt, updatedBy, ...extra } = raw;
  const tid = str(id)?.trim();
  if (!tid || !TASK_ID_RE.test(tid)) return broken(`поле id: ожидался номер вида PAY-12, а не ${JSON.stringify(id ?? null)}`, fm.body);
  if (tid !== fileId) return broken(`id ${tid} не совпадает с именем файла ${fileId}.md`, fm.body);
  const ttl = str(title)?.trim();
  if (!ttl) return broken('нет поля title', fm.body);
  const ty = str(type)?.trim() ?? 'feature';
  if (!TASK_TYPES.includes(ty as TeamTaskType)) return broken(`поле type: ${ty} (ожидалось ${TASK_TYPES.join(' | ')})`, fm.body);
  const st = str(status)?.trim() ?? 'todo';
  if (!TASK_STATUSES.includes(st as TeamTaskStatus)) return broken(`поле status: ${st} (ожидалось ${TASK_STATUSES.join(' | ')})`, fm.body);
  if (sprint !== undefined && sprint !== null && !(typeof sprint === 'number' && Number.isInteger(sprint) && sprint > 0)) return broken(`поле sprint: ${JSON.stringify(sprint)}`, fm.body);
  if (estimate !== undefined && estimate !== null && typeof estimate !== 'number') return broken(`поле estimate: ${JSON.stringify(estimate)}`, fm.body);
  // известное поле неожиданного вида — ошибка у задачи, а не молча исчезнувшее при следующей записи поле (spec §5.9, D-9)
  for (const [name, v] of Object.entries({ rank, assignee, repo, branch, createdAt, createdBy, updatedAt, updatedBy })) {
    if (v !== undefined && v !== null && typeof v !== 'string' && typeof v !== 'number' && !(v instanceof Date)) return broken(`поле ${name}: ожидалась строка, а не ${JSON.stringify(v)}`, fm.body);
  }
  for (const [name, v] of Object.entries({ blockedBy, covers })) {
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) return broken(`поле ${name}: ожидался список строк, а не ${JSON.stringify(v)}`, fm.body);
  }
  // ветку агент получает в тексте задачи и git — аргументом: только имя ветки, без ведущего «-» (S-3)
  const br = str(branch)?.trim();
  if (br && !TASK_BRANCH_RE.test(br)) return broken(`поле branch: недопустимое имя ветки ${JSON.stringify(br)}`, fm.body);
  if (pr !== undefined && pr !== null && !isRecord(pr)) return broken(`поле pr: ожидалось { url, state }, а не ${JSON.stringify(pr)}`, fm.body);
  const prUrl = isRecord(pr) ? str(pr.url)?.trim() : undefined;
  const prState = isRecord(pr) ? str(pr.state)?.trim() : undefined;
  // UI рисует ссылку на PR: только http(s) без пробелов и управляющих символов (S-10)
  if (isRecord(pr) && (!prUrl || !/^https?:\/\/[^\s\u0000-\u001f\u007f]+$/.test(prUrl))) return broken(`поле pr.url: ожидалась ссылка http(s), а не ${JSON.stringify(pr.url ?? null)}`, fm.body);
  if (prState !== undefined && !['open', 'merged', 'closed'].includes(prState)) return broken(`поле pr.state: ${prState} (ожидалось open | merged | closed)`, fm.body);
  const body = fm.body.replace(/^(\r?\n)+/, '');
  const task: TaskFile = {
    id: tid,
    title: ttl,
    type: ty as TeamTaskType,
    status: st as TeamTaskStatus,
    ...(typeof sprint === 'number' ? { sprint } : {}),
    rank: str(rank)?.trim() ?? '',
    ...(str(assignee)?.trim() ? { assignee: str(assignee)!.trim() } : {}),
    ...(typeof estimate === 'number' ? { estimate } : {}),
    ...(str(repo)?.trim() ? { repo: str(repo)!.trim() } : {}),
    ...(br ? { branch: br } : {}),
    ...(prUrl ? { pr: { url: prUrl, state: prState === 'merged' || prState === 'closed' ? prState : 'open' } } : {}),
    blockedBy: strList(blockedBy),
    covers: strList(covers),
    ...(iso(createdAt) ? { createdAt: iso(createdAt) } : {}),
    ...(str(createdBy) ? { createdBy: str(createdBy) } : {}),
    ...(iso(updatedAt) ? { updatedAt: iso(updatedAt) } : {}),
    ...(str(updatedBy) ? { updatedBy: str(updatedBy) } : {}),
    body,
    acceptance: acceptanceOf(body),
    comments: 0,
    base,
    file,
    extra,
  };
  return task;
}

/** Frontmatter задачи как объект: известные поля в фиксированном порядке, неизвестные — следом. */
export function taskFrontmatter(t: TaskFile): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    type: t.type,
    status: t.status,
    ...(t.sprint !== undefined ? { sprint: t.sprint } : {}),
    rank: t.rank,
    ...(t.assignee ? { assignee: t.assignee } : {}),
    ...(t.estimate !== undefined ? { estimate: t.estimate } : {}),
    ...(t.repo ? { repo: t.repo } : {}),
    ...(t.branch ? { branch: t.branch } : {}),
    ...(t.pr ? { pr: t.pr } : {}),
    blockedBy: t.blockedBy,
    ...(t.covers.length ? { covers: t.covers } : {}),
    ...(t.createdAt ? { createdAt: t.createdAt } : {}),
    ...(t.createdBy ? { createdBy: t.createdBy } : {}),
    ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
    ...(t.updatedBy ? { updatedBy: t.updatedBy } : {}),
    ...t.extra,
  };
}

/** Текст файла задачи из frontmatter и тела. */
export function composeTask(frontmatter: Record<string, unknown>, body: string): string {
  const b = body.replace(/^(\r?\n)+/, '').trimEnd();
  return `---\n${yamlText(frontmatter)}---\n${b ? `\n${b}\n` : ''}`;
}

export const serializeTask = (t: TaskFile): string => composeTask(taskFrontmatter(t), t.body);

/** Публичная часть задачи без extra — для API. */
export const taskView = ({ extra: _e, ...t }: TaskFile): TeamTask => t;

/** Критерии приёмки: чек-лист раздела «Критерии приёмки» (или «Acceptance criteria»); нет раздела — весь текст. */
export function acceptanceOf(body: string): { done: number; total: number } {
  const sections = splitSections(body);
  const sec = sections.find((s) => /^(критерии приёмки|acceptance criteria)$/i.test(s.heading.trim()));
  const lines = (sec ? sec.text : body).split(/\r?\n/);
  const fenced = fencedLines(lines);
  let done = 0;
  let total = 0;
  lines.forEach((l, i) => {
    if (fenced[i]) return;
    const m = l.match(CHECKBOX_RE);
    if (!m) return;
    total++;
    if (m[1] !== ' ') done++;
  });
  return { done, total };
}

/** Наибольший номер среди задач с этим префиксом; нет таких — 0. */
export function maxTaskNumber(ids: Iterable<string>, prefix: string): number {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of ids) {
    const m = id.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Следующий номер задачи: больше всех известных и последнего выданного (teamwork.yaml → lastTask), чтобы номер удалённой
 * задачи не вернулся (spec §5.7).
 */
export function nextTaskId(ids: Iterable<string>, prefix: string, last = 0): string {
  return `${prefix}-${Math.max(maxTaskNumber(ids, prefix), last) + 1}`;
}

export const taskNumber = (id: string): number => Number(id.split('-').pop() ?? 0);

/** Порядок задач: по rank, при равных — по номеру (spec §5.8). */
export function compareTasks(a: Pick<TeamTask, 'rank' | 'id'>, b: Pick<TeamTask, 'rank' | 'id'>): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return taskNumber(a.id) - taskNumber(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export const sortTasks = <T extends Pick<TeamTask, 'rank' | 'id'>>(tasks: T[]): T[] => [...tasks].sort(compareTasks);

// ---------- rank: дробный индекс (алгоритм midpoint из rocicorp/fractional-indexing без целой части)

export const RANK_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Строка строго между a и b на алфавите 0-9A-Za-z; нет a — от начала, нет b — до конца. Тот же алгоритм повторяет UI
 * (web/src/lib/teamwork): (∅,∅)→V, (V,∅)→l, (∅,V)→G, (V,W)→VV. a ≥ b или хвостовой «0» — ошибка.
 */
export function rankBetween(a?: string, b?: string): string {
  const lo = a ?? '';
  if (b !== undefined && lo >= b) throw new Error(`rank: ${JSON.stringify(lo)} >= ${JSON.stringify(b)}`);
  if (lo.endsWith('0') || b?.endsWith('0')) throw new Error('rank: хвостовой 0');
  if (!/^[0-9A-Za-z]*$/.test(lo) || (b !== undefined && !/^[0-9A-Za-z]*$/.test(b))) throw new Error('rank: недопустимые символы');
  return midpoint(lo, b);
}

const RANK_OK_RE = /^(?:[0-9A-Za-z]*[1-9A-Za-z])?$/;

/** rank соседа для rankBetween: правленный руками (хвостовой 0, лишние символы) не годится — считается пустым. */
export const validRank = (r: string | undefined): string | undefined => (r && RANK_OK_RE.test(r) ? r : undefined);

/** rankBetween по соседям из файлов: битые rank и перевёрнутые соседи (одновременные переносы) не роняют запись — встаём после a. */
export function rankNear(a?: string, b?: string): string {
  const lo = validRank(a);
  const hi = validRank(b);
  try {
    return rankBetween(lo, hi);
  } catch {
    return rankBetween(lo);
  }
}

/**
 * rank для переноса между соседями своего списка (D-12): строго между after и before, а если между ними места нет (одинаковый
 * rank после одновременных переносов, соседи поменялись местами, rank правлен руками) — между after и ближайшим rank
 * списка больше него (или между before и ближайшим меньше), а не в самый конец за чужие задачи. ranks — rank задач
 * списка без переносимой.
 */
export function placeRank(ranks: readonly string[], after?: string, before?: string): string {
  const lo = validRank(after);
  const hi = validRank(before);
  const valid = ranks.map(validRank).filter((x): x is string => x !== undefined);
  if (lo !== undefined && hi !== undefined && lo < hi) return rankBetween(lo, hi);
  if (lo !== undefined) return rankBetween(lo, valid.filter((x) => x > lo).sort()[0]);
  if (hi !== undefined) return rankBetween(valid.filter((x) => x < hi).sort().pop(), hi);
  return rankBetween(valid.sort().pop());
}

function midpoint(a: string, b: string | undefined): string {
  const zero = RANK_DIGITS[0];
  if (b !== undefined) {
    let n = 0;
    while ((a[n] ?? zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? RANK_DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== undefined ? RANK_DIGITS.indexOf(b[0]) : RANK_DIGITS.length;
  if (digitB - digitA > 1) return RANK_DIGITS[Math.round(0.5 * (digitA + digitB))];
  if (b !== undefined && b.length > 1) return b.slice(0, 1);
  return RANK_DIGITS[digitA] + midpoint(a.slice(1), undefined);
}

// ---------- разделы markdown

export type DocSection = { heading: string; text: string; start: number; end: number };

/** Строки внутри оград кода (``` или ~~~): заголовки и требования там не считаются. */
function fencedLines(lines: string[]): boolean[] {
  let fence: { ch: string; len: number } | undefined;
  return lines.map((l) => {
    const f = l.match(FENCE_RE);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && l.trim() === f[1]) fence = undefined;
      return true;
    }
    if (f) fence = { ch: f[1][0], len: f[1].length };
    return Boolean(f);
  });
}

/**
 * Разделы по заголовкам «## » вне блоков кода. text — кусок файла от строки заголовка до следующего заголовка (с его
 * переводами строк), start и end — смещения в md. Текст до первого заголовка — раздел с пустым heading, если он не пустой.
 */
export function splitSections(md: string): DocSection[] {
  const lines = md.split('\n');
  const fenced = fencedLines(lines);
  const starts: { heading: string; offset: number }[] = [];
  let offset = 0;
  lines.forEach((l, i) => {
    const m = fenced[i] ? null : l.replace(/\r$/, '').match(SECTION_RE);
    if (m) starts.push({ heading: m[1].replace(/[ \t]+#+$/, '').trim(), offset });
    offset += l.length + 1;
  });
  const out: DocSection[] = [];
  const first = starts[0]?.offset ?? md.length;
  if (md.slice(0, first).trim()) out.push({ heading: '', text: md.slice(0, first), start: 0, end: first });
  starts.forEach((s, i) => {
    const end = starts[i + 1]?.offset ?? md.length;
    out.push({ heading: s.heading, text: md.slice(s.offset, end), start: s.offset, end });
  });
  return out;
}

export const sectionHash = (text: string): string => textHash(text.trimEnd());

/** Раздел по заголовку (первый с таким заголовком); пустой heading — текст до первого раздела. */
export function findSection(md: string, heading: string): DocSection | undefined {
  const h = heading.trim();
  return splitSections(md).find((s) => s.heading === h);
}

/**
 * Заменяет раздел целиком (строку заголовка и тело) на text; остальные разделы не трогаются. Между разделами остаётся
 * пустая строка. Нет такого раздела — ошибка.
 */
export function replaceSection(md: string, heading: string, text: string): string {
  const sec = findSection(md, heading);
  if (!sec) throw new Error(`Раздела «${heading}» нет в документе`);
  const body = text.replace(/\s+$/, '');
  const tail = sec.end < md.length ? '\n\n' : '\n';
  return md.slice(0, sec.start) + body + tail + md.slice(sec.end);
}

// ---------- требования ТЗ

export function parseRequirements(md: string): TeamRequirement[] {
  const lines = md.split(/\r?\n/);
  const fenced = fencedLines(lines);
  let section = '';
  const out: TeamRequirement[] = [];
  lines.forEach((l, i) => {
    if (fenced[i]) return;
    const h = l.match(SECTION_RE);
    if (h) {
      section = h[1].replace(/[ \t]+#+$/, '').trim();
      return;
    }
    const m = l.match(REQUIREMENT_RE);
    if (m) out.push({ id: `${m[1]}-${m[2]}`, text: m[3].trim(), section });
  });
  return out;
}

export type RequirementKind = 'FR' | 'NFR';

/** Наибольшие номера требований в тексте, по видам. */
export function requirementMax(md: string): Record<RequirementKind, number> {
  const max: Record<RequirementKind, number> = { FR: 0, NFR: 0 };
  for (const r of parseRequirements(md)) {
    const [kind, n] = r.id.split('-') as [RequirementKind, string];
    max[kind] = Math.max(max[kind], Number(n));
  }
  return max;
}

/**
 * Номера требований, которых в next больше одного и больше, чем было в current: запись не добавляет повторов (spec §8.4,
 * номер — идентификатор). Повтор, который уже был в документе (слияние двух правок, правка руками), запись не блокирует —
 * иначе не сохранить и соседний раздел. Порядок — как в документе.
 */
export function addedRequirementRepeats(next: string, current = ''): string[] {
  const count = (md: string) => {
    const n = new Map<string, number>();
    for (const r of parseRequirements(md)) n.set(r.id, (n.get(r.id) ?? 0) + 1);
    return n;
  };
  const was = count(current);
  return [...count(next)].filter(([id, n]) => n > 1 && n > (was.get(id) ?? 0)).map(([id]) => id);
}

/** Следующий номер: больше всех в тексте и последнего выданного (project.yaml → lastRequirement), чтобы удалённый не вернулся. */
export function nextRequirementId(md: string, kind: RequirementKind, last?: Partial<Record<RequirementKind, number>>): string {
  return `${kind}-${Math.max(requirementMax(md)[kind], last?.[kind] ?? 0) + 1}`;
}

// ---------- зависимости разбивки (spec §9.1)

/** Ссылка в dependsOn: ключ другой предложенной задачи или номер существующей. */
export function checkDependencies(tasks: TeamProposedTask[], existing: { id: string; status: TeamTaskStatus }[]): TeamDependencyReport {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const errors: TeamDependencyReport['errors'] = [];
  const seenKeys = new Set<string>();
  for (const t of tasks) {
    if (seenKeys.has(t.key)) errors.push({ key: t.key, error: `Ключ ${t.key} повторяется` });
    seenKeys.add(t.key);
    for (const d of t.dependsOn) {
      if (!byKey.has(d) && !existingById.has(d)) errors.push({ key: t.key, error: `Неизвестная зависимость: ${d}` });
    }
  }
  // цикл — обходом в глубину по предложенным задачам; цепочка отдаётся по направлению стрелок графа, от предшественника
  // к зависимой задаче (как в web/src/lib/teamwork/deps.ts), а не по dependsOn
  const color = new Map<string, 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | undefined;
  const visit = (k: string): void => {
    if (cycle) return;
    color.set(k, 1);
    stack.push(k);
    for (const d of byKey.get(k)?.dependsOn ?? []) {
      if (!byKey.has(d)) continue;
      const c = color.get(d);
      if (c === 1) {
        cycle = [...stack.slice(stack.indexOf(d)), d].reverse();
        return;
      }
      if (!c) visit(d);
      if (cycle) return;
    }
    stack.pop();
    color.set(k, 2);
  };
  for (const t of tasks) if (!color.has(t.key)) visit(t.key);
  if (cycle) {
    const chain = cycle.join(' → ');
    for (const k of new Set(cycle)) errors.push({ key: k, error: `Цикл зависимостей: ${chain}` });
  }
  // волны: незавершённые существующие предшественники — волна 1, каждая предложенная задача — после своих предшественников
  const waves: Record<string, number> = {};
  const unfinished = (id: string) => existingById.has(id) && existingById.get(id)!.status !== 'done';
  for (const e of existing) if (tasks.some((t) => t.dependsOn.includes(e.id)) && e.status !== 'done') waves[e.id] = 1;
  const visiting = new Set<string>();
  const waveOf = (k: string): number => {
    if (waves[k] !== undefined) return waves[k];
    if (visiting.has(k)) return 0;
    visiting.add(k);
    let w = 1;
    for (const d of byKey.get(k)?.dependsOn ?? []) {
      if (byKey.has(d)) w = Math.max(w, waveOf(d) + 1);
      else if (unfinished(d)) w = Math.max(w, 2);
    }
    visiting.delete(k);
    waves[k] = w;
    return w;
  };
  for (const t of tasks) waveOf(t.key);
  // самая длинная цепочка по очкам (без оценки — 0 очков); при равных очках — длиннее
  const best = new Map<string, { points: number; keys: string[] }>();
  const chainOf = (k: string): { points: number; keys: string[] } => {
    const got = best.get(k);
    if (got) return got;
    if (visiting.has(k)) return { points: 0, keys: [] };
    visiting.add(k);
    let pick: { points: number; keys: string[] } = { points: 0, keys: [] };
    for (const d of byKey.get(k)?.dependsOn ?? []) {
      if (!byKey.has(d)) continue;
      const c = chainOf(d);
      if (c.points > pick.points || (c.points === pick.points && c.keys.length > pick.keys.length)) pick = c;
    }
    visiting.delete(k);
    const own = { points: pick.points + (byKey.get(k)?.estimate ?? 0), keys: [...pick.keys, k] };
    best.set(k, own);
    return own;
  };
  let chain: { keys: string[]; points: number } = { keys: [], points: 0 };
  for (const t of tasks) {
    const c = chainOf(t.key);
    if (c.points > chain.points || (c.points === chain.points && c.keys.length > chain.keys.length)) chain = c;
  }
  return { errors, ...(cycle ? { cycle } : {}), waves, chain };
}

// ---------- комментарии (spec §5.6)

export type CommentFile = Omit<TeamComment, 'mine'> & { name?: string; extra: Record<string, unknown> };

/** Имя файла комментария: время до секунд и handle автора, чтобы одновременные комментарии не давали конфликт. */
export function commentFileName(at: string, email: string): string {
  const stamp = at.replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  const handle = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'user';
  return `${stamp}-${handle}.md`;
}

export function parseComment(text: string, file: string): CommentFile | undefined {
  const fm = splitFrontmatter(text);
  if (!fm) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = parseYamlRecord(fm.yaml, 'комментарий');
  } catch {
    return undefined;
  }
  const { author, name, at, ...extra } = raw;
  const a = str(author)?.trim().toLowerCase();
  if (!a) return undefined;
  return { id: path.basename(file).replace(/\.md$/i, ''), author: a, ...(str(name) ? { name: str(name) } : {}), at: iso(at) ?? '', text: fm.body.replace(/^(\r?\n)+/, '').trimEnd(), extra };
}

export function serializeComment(c: Omit<CommentFile, 'id'>): string {
  return `---\n${yamlText({ author: c.author, ...(c.name ? { name: c.name } : {}), at: c.at, ...c.extra })}---\n\n${c.text.trim()}\n`;
}

// ---------- документы проекта

export const DOC_FILES: Record<'prd' | 'architecture' | 'design', string> = { prd: 'prd.md', architecture: 'architecture.md', design: 'design.md' };
const DOC_FILE_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,100}\.md$/u;

/** Файл документа в папке проекта по имени из API; undefined — имя недопустимо. */
export function docFile(name: string): string | undefined {
  if (name in DOC_FILES) return DOC_FILES[name as keyof typeof DOC_FILES];
  const m = name.match(/^docs\/(.+)$/);
  if (!m || !DOC_FILE_RE.test(m[1]) || m[1].includes('..')) return undefined;
  return `docs/${m[1]}`;
}

export const isDocName = (name: string): name is TeamDocName => docFile(name) !== undefined;

/** Заголовок документа: первая строка «# …», иначе имя файла. */
export function docTitle(text: string, fallback: string): string {
  const lines = text.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const i = lines.findIndex((l, j) => !fenced[j] && /^# \S/.test(l));
  return i >= 0 ? lines[i].replace(/^# /, '').replace(/[ \t]+#+$/, '').trim() : fallback;
}

// ---------- ссылка на репо (план: допустимые ссылки)

/** Почему ссылка на репо не годится; undefined — годится. Допустимы https://, http://, ssh://, scp-вид user@host:path, file:// и абсолютный путь. */
export function remoteProblem(url: string): string | undefined {
  if (!url) return 'Укажи ссылку на репо';
  if (/\s/.test(url)) return 'Ссылка не может содержать пробелы и переводы строк';
  if (url.startsWith('-')) return 'Ссылка не может начинаться с «-»';
  // <helper>::<адрес> зовёт внешний remote-helper git (ext:: запускает команду, fd:: читает дескриптор, hg::, foo::…):
  // git часть из них запрещает сам, но мы не пропускаем ни один (S-9)
  if (/^[a-z][a-z0-9+.-]*::/i.test(url)) return 'Ссылки вида <helper>::… (ext::, fd::, hg:: и подобные) не поддерживаются';
  if (/^(https?|ssh|file):\/\//i.test(url)) {
    try {
      new URL(url);
      return undefined;
    } catch {
      return 'Ссылка не разбирается как URL';
    }
  }
  if (path.isAbsolute(url)) return undefined;
  if (/^(?:[^@/:\s]+@)?[^:/\s]+:(?!\/\/)[^\s].*$/.test(url)) return undefined;
  return 'Ссылка на репо: https://, ssh://, user@host:path, file:// или абсолютный путь';
}

/**
 * Ссылка, которую можно положить в репо команды: у http(s) — без логина и токена (https://user:ghp_…@host), у других схем —
 * без пароля. Не URL или без учётных данных — как есть.
 */
export function shareableUrl(url: string): string {
  if (!/^[a-z+]+:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    if (/^https?:$/i.test(u.protocol)) u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** Слаг папки команды из ссылки на репо: последний сегмент пути без .git. */
export function teamSlugFromUrl(url: string): string {
  const tail = url.replace(/[/\\]+$/, '').split(/[/:\\]/).pop() ?? '';
  const slug = tail.replace(/\.git$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return TEAM_SLUG_RE.test(slug) ? slug : 'team';
}

// ---------- слияние полей при конфликте (spec §7.4)

export type FieldConflict = { field: string; ours: unknown; theirs: unknown };

/** Ключ элемента в списке объектов: участники — по email, репо кода — по key (D-3). */
const LIST_IDS: Record<string, string> = { members: 'email', repos: 'key' };
/** Поля-объекты, которые сливаются только целиком: ссылка на PR и его состояние вместе. */
const ATOMIC_FIELDS = new Set(['pr']);
const listId = (field: string, v: unknown): string | undefined => {
  const k = LIST_IDS[field];
  const id = k && isRecord(v) ? str(v[k])?.trim() : undefined;
  return id ? (k === 'email' ? id.toLowerCase() : id) : undefined;
};
const isPrimitive = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/**
 * Трёхстороннее слияние значения поля (D-3): менял только я — моё; только они — их; оба одинаково — любое. Оба по-разному:
 * объект — по вложенным ключам (columns, lastRequirement, неизвестные), список строк — как множество (добавленное любой
 * стороной — в итоге, удалённое любой — убрано), список участников и репо — по элементам (email, key); конфликт — только
 * если один ключ или элемент изменён по-разному, и тогда его значение — от prefer (команды в файле, моё — в конфликте).
 * Остальное (pr, списки без ключей) — целиком.
 */
function merge3(field: string, b: unknown, m: unknown, t: unknown, prefer: 'theirs' | 'mine'): { value: unknown; conflict: boolean } {
  if (eq(m, t) || eq(m, b)) return { value: t, conflict: false };
  if (eq(t, b)) return { value: m, conflict: false };
  const pick = { value: prefer === 'mine' ? m : t, conflict: true };
  if (ATOMIC_FIELDS.has(field)) return pick;
  if (isRecord(m) && isRecord(t) && (b === undefined || b === null || isRecord(b))) {
    const bb = isRecord(b) ? b : {};
    const value: Record<string, unknown> = {};
    let conflict = false;
    for (const k of new Set([...Object.keys(t), ...Object.keys(m), ...Object.keys(bb)])) {
      const r = merge3(k, bb[k], m[k], t[k], prefer);
      conflict ||= r.conflict;
      if (r.value !== undefined) value[k] = r.value;
    }
    return { value, conflict };
  }
  // нет поля — пустой список: covers без элементов в файл не пишется вовсе
  const lists = [b, m, t].map((v) => (v === undefined || v === null ? [] : v));
  if (!(Array.isArray(m) || Array.isArray(t)) || !lists.every(Array.isArray)) return pick;
  return mergeLists(field, lists[0] as unknown[], lists[1] as unknown[], lists[2] as unknown[], prefer, pick);
}

/** Списки для merge3: из примитивов — как множество, из объектов с ключом (LIST_IDS) — по элементам, иначе — pick целиком. */
function mergeLists(field: string, bl: unknown[], m: unknown[], t: unknown[], prefer: 'theirs' | 'mine', pick: { value: unknown; conflict: boolean }): { value: unknown; conflict: boolean } {
  if ([...bl, ...m, ...t].every(isPrimitive)) {
    const key = (x: unknown) => JSON.stringify(x);
    const [bs, ms, ts] = [bl, m, t].map((l) => new Set(l.map(key)));
    const removed = new Set([...bs].filter((x) => !ms.has(x)));
    const added = m.filter((x, i) => !bs.has(key(x)) && !ts.has(key(x)) && m.findIndex((y) => key(y) === key(x)) === i);
    return { value: [...t.filter((x) => !removed.has(key(x))), ...added], conflict: false };
  }
  const ids = (l: unknown[]) => l.map((x) => listId(field, x));
  const [bi, mi, ti] = [bl, m, t].map(ids);
  if ([...bi, ...mi, ...ti].some((x) => x === undefined) || [bi, mi, ti].some((l) => new Set(l).size !== l.length)) return pick;
  const byId = (l: unknown[], li: (string | undefined)[]) => new Map(l.map((x, i) => [li[i]!, x]));
  const [bm, mm, tm] = [byId(bl, bi), byId(m, mi), byId(t, ti)];
  const value: unknown[] = [];
  let conflict = false;
  // порядок — как у команды, мои новые элементы — следом в моём порядке
  for (const id of [...ti, ...mi.filter((x) => !tm.has(x!))] as string[]) {
    const [be, me, te] = [bm.get(id), mm.get(id), tm.get(id)];
    if (me !== undefined && te !== undefined) {
      const r = merge3(`${field}[]`, be, me, te, prefer);
      conflict ||= r.conflict;
      value.push(r.value);
    } else if (te !== undefined) {
      // у меня элемента нет: удалил я (было в базе) или добавили они
      if (be === undefined) value.push(te);
      else if (!eq(be, te)) {
        conflict = true; // они его изменили, я удалил
        if (prefer === 'theirs') value.push(te);
      }
    } else if (be === undefined) value.push(me);
    else if (!eq(be, me)) {
      conflict = true; // я его изменил, они удалили
      if (prefer === 'mine') value.push(me);
    }
  }
  return { value, conflict };
}

/**
 * Слияние объектов по полям: база, моё, их (merge3 по каждому полю). Поле менял только я — моё; только они — их; оба
 * одинаково — любое; по-разному — по вложенным ключам и элементам списков, а что не слилось — остаётся значение команды,
 * моё (то же поле, но с моими значениями в спорных местах) уходит в конфликты. Отсутствие поля — тоже значение (снятое поле).
 */
export function mergeRecords(base: Record<string, unknown> | undefined, mine: Record<string, unknown>, theirs: Record<string, unknown>): { merged: Record<string, unknown>; conflicts: FieldConflict[] } {
  const merged: Record<string, unknown> = {};
  const conflicts: FieldConflict[] = [];
  const keys = [...new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(base ?? {})])];
  for (const k of keys) {
    const r = merge3(k, base?.[k], mine[k], theirs[k], 'theirs');
    if (r.conflict) conflicts.push({ field: k, ours: merge3(k, base?.[k], mine[k], theirs[k], 'mine').value, theirs: r.value });
    if (r.value !== undefined) merged[k] = r.value;
  }
  return { merged, conflicts };
}

/**
 * «Взять моё» у конфликта поля: моё значение из конфликта поверх текущего, как слияние от значения команды на момент
 * конфликта. У простого поля — моё; у списка и объекта — мои спорные элементы и ключи, а то, что команда изменила с тех
 * пор в остальных, остаётся.
 */
export function mergeFieldMine(field: string, theirsAtConflict: unknown, ours: unknown, current: unknown): unknown {
  return merge3(field, theirsAtConflict, ours, current, 'mine').value;
}

/**
 * Трёхстороннее слияние одного поля для правки настроек от base клиента (D-10): conflict — один ключ или элемент изменён
 * и клиентом, и командой по-разному; value — итог (значение команды в спорных местах).
 */
export function mergeField(field: string, base: unknown, mine: unknown, current: unknown): { value: unknown; conflict: boolean } {
  return merge3(field, base, mine, current, 'theirs');
}

/** Поля-следы правки задачи: при расхождении сторон это не конфликт, а «кто правил последним». */
const STAMP_FIELDS = new Set(['updatedAt', 'updatedBy']);
const stampTime = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

/**
 * updatedAt и updatedBy при конфликте не уходят в диалог: остаётся более поздняя правка вместе со своим автором (при
 * равенстве — команды). Меняет merged по месту, возвращает конфликты без этих полей.
 */
function mergeStamps(merged: Record<string, unknown>, conflicts: FieldConflict[], mine: Record<string, unknown>, theirs: Record<string, unknown>): FieldConflict[] {
  const rest = conflicts.filter((c) => !STAMP_FIELDS.has(c.field));
  if (rest.length === conflicts.length) return conflicts;
  // updatedAt разошёлся — сторона с более поздним временем; иначе (разошёлся только автор) — сторона, чьё время осталось
  const atConflict = conflicts.some((c) => c.field === 'updatedAt');
  const mineWins = atConflict ? stampTime(mine.updatedAt) > stampTime(theirs.updatedAt) : eq(merged.updatedAt, mine.updatedAt) && !eq(merged.updatedAt, theirs.updatedAt);
  const side = mineWins ? mine : theirs;
  for (const k of STAMP_FIELDS) {
    if (side[k] === undefined) delete merged[k];
    else merged[k] = side[k];
  }
  return rest;
}

/** Слияние текстов: undefined — конфликт, не слилось. Реализация с git merge-file — в teamwork-repo.ts. */
export type MergeText = (base: string, mine: string, theirs: string) => string | undefined | Promise<string | undefined>;

/**
 * Слияние файла задачи: поля frontmatter — по полям, тело — mergeText; при конфликте тела остаётся текст команды, моё —
 * в конфликт поля body. Задача без базы (создана с обеих сторон) сливается от пустой базы.
 */
export async function mergeTaskTexts(base: string | undefined, mine: string, theirs: string, file: string, mergeText: MergeText): Promise<{ text: string; conflicts: FieldConflict[] }> {
  const b = base !== undefined ? parseTask(base, file) : undefined;
  const m = parseTask(mine, file);
  const t = parseTask(theirs, file);
  if (m.error || t.error || b?.error) {
    // не разбирается — сливаем как текст
    const merged = await mergeText(base ?? '', mine, theirs);
    return merged !== undefined ? { text: merged, conflicts: [] } : { text: theirs, conflicts: [{ field: 'text', ours: mine, theirs }] };
  }
  const mineFm = taskFrontmatter(m);
  const theirsFm = taskFrontmatter(t);
  const { merged, conflicts: fieldConflicts } = mergeRecords(b ? taskFrontmatter(b) : undefined, mineFm, theirsFm);
  const conflicts = mergeStamps(merged, fieldConflicts, mineFm, theirsFm);
  let body = t.body;
  if (m.body !== t.body) {
    if (b && m.body === b.body) body = t.body;
    else if (b && t.body === b.body) body = m.body;
    else {
      const mergedBody = await mergeText(b?.body ?? '', m.body, t.body);
      if (mergedBody !== undefined) body = mergedBody;
      else conflicts.push({ field: 'body', ours: m.body, theirs: t.body });
    }
  }
  return { text: composeTask(merged, body), conflicts };
}

/**
 * Счётчики выданных номеров: teamwork.yaml → lastTask, project.yaml → lastRequirement. Номер только растёт, поэтому при
 * слиянии берётся большее значение (у объекта — по каждому ключу), и это не конфликт.
 */
const COUNTER_FIELDS = new Set(['lastTask', 'lastRequirement']);
function maxCounter(mine: unknown, theirs: unknown): unknown {
  if (isRecord(mine) && isRecord(theirs)) {
    const out: Record<string, unknown> = { ...theirs };
    for (const k of Object.keys(mine)) out[k] = maxCounter(mine[k], theirs[k]);
    return out;
  }
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (num(mine) && num(theirs)) return Math.max(mine as number, theirs as number);
  if (num(mine)) return mine;
  return theirs ?? mine;
}

/**
 * Слияние YAML-файла (проект, спринт, teamwork.yaml) по полям; итог пишется поверх текста команды, чтобы остались её
 * комментарии. Счётчики номеров — большее из двух значений.
 */
export function mergeYamlTexts(base: string | undefined, mine: string, theirs: string): { text: string; conflicts: FieldConflict[] } {
  let b: Record<string, unknown> | undefined;
  let m: Record<string, unknown>;
  let t: Record<string, unknown>;
  try {
    b = base !== undefined ? parseYamlRecord(base, 'база') : undefined;
    m = parseYamlRecord(mine, 'моё');
    t = parseYamlRecord(theirs, 'их');
  } catch {
    return { text: theirs, conflicts: [{ field: 'text', ours: mine, theirs }] };
  }
  const { merged, conflicts: all } = mergeRecords(b, m, t);
  for (const k of COUNTER_FIELDS) if (m[k] !== undefined || t[k] !== undefined) merged[k] = maxCounter(m[k], t[k]);
  const conflicts = all.filter((c) => !COUNTER_FIELDS.has(c.field));
  // поверх текста команды — только то, что слияние поменяло: остальные поля сохраняют её вид и комментарии
  const patch: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(t), ...Object.keys(merged)])) if (!eq(merged[k], t[k]) || (k in t) !== (k in merged)) patch[k] = merged[k];
  return { text: Object.keys(patch).length ? updateYaml(theirs, patch) : theirs, conflicts };
}

// ---------- сообщения коммитов (spec §7.1)

/** «PAY-12: статус → В работе», «PAY-12: исполнитель → alex», несколько полей — через запятую. */
export function taskChangeMessage(id: string, changes: string[]): string {
  return changes.length ? `${id}: ${changes.join(', ')}` : `${id}: обновлена`;
}

export const DOC_LABELS: Record<string, string> = { prd: 'ТЗ', architecture: 'архитектура', design: 'дизайн' };

export function docLabel(name: string): string {
  return DOC_LABELS[name] ?? name.replace(/^docs\//, '');
}
