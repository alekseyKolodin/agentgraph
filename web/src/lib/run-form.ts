// Форма запуска без React и DOM (ui/app.js renderFlow, startRun, readAttachments, renderRunTags, addRunTag, renderRunMoreSum,
// renderConnWarn, renderRecentDirs; ui/dash.js renderRunLink, prepareWorktree, runLinkPayload): вложения, теги, сводка
// «Дополнительно», привязка к задаче, MR/PR или ветке и worktree, тело POST /api/runs.
import type { FlowSummary, PhaseSummary, ProjectInfo, RecentDir, RunSource, RunWorktree, TagDetail, TagKind, TagListItem } from '@server/api-types';
import { plural } from './format';
import { mrSign } from './dash';
import { CONN_PREFIX } from './flow/tools';
import { iterTo } from './graph/text';

// ---------- вложения: файлы читаются в base64 и уходят в POST /api/runs, сервер кладёт их в runs/<id>/attachments/

export const ATTACH_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'json', 'log', 'yaml', 'yml', 'xml'];
export const ATTACH_FILE_MAX = 10 * 1024 * 1024;
export const ATTACH_TOTAL_MAX = 25 * 1024 * 1024;
export const ATTACH_COUNT_MAX = 10;
export const ATTACH_ACCEPT = ATTACH_EXTS.map((e) => '.' + e).join(',');

export type Attach = { id: number; name: string; size: number; data: string };

export const fileSize = (n: number): string => (n < 1024 ? `${n} Б` : n < 1024 * 1024 ? `${Math.round(n / 1024)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`);

/** У скриншота из буфера имя всегда image.png: даём своё, сервер всё равно разведёт дубли. */
export const attachName = (name: string, now: Date = new Date()): string =>
  name && name !== 'image.png' ? name : `screenshot-${now.toTimeString().slice(0, 8).replace(/:/g, '')}.png`;

/** Отказ до чтения: тип (сервер срезает ведущие точки — у «.png» расширения нет) и размер одного файла. */
export function attachTypeError(name: string, size: number): string | undefined {
  const bare = name.trim().replace(/^\.+/, '');
  const ext = bare.split('.').pop()!.toLowerCase();
  if (!bare.includes('.') || !ATTACH_EXTS.includes(ext)) return `${name}: такой тип не поддерживается`;
  if (size > ATTACH_FILE_MAX) return `${name}: больше 10 МБ`;
  return undefined;
}

/** Отказ по сумме и числу: проверяется до чтения и ещё раз после — пока файл читался, другое перетаскивание могло добавить свои. */
export function attachOverLimit(list: { size: number }[], name: string, size: number): string | undefined {
  if (list.reduce((n, a) => n + a.size, 0) + size > ATTACH_TOTAL_MAX) return `${name}: вложения вместе больше 25 МБ`;
  if (list.length >= ATTACH_COUNT_MAX) return `${name}: больше ${ATTACH_COUNT_MAX} файлов нельзя`;
  return undefined;
}

/** Этапы flow по сводке: у одноблочного старого сервера — summary.phases. */
export const summaryPhases = (summary: FlowSummary | undefined): PhaseSummary[] =>
  (summary?.blocks || [{ phases: summary?.phases || [] }]).flatMap((b) => b.phases);

/** Пути вложений получают все этапы, но открыть их может только этап с Read: «Этапы a, b без Read вложений не увидят». */
export function attachWarn(summary: FlowSummary | undefined): string {
  const blind = summaryPhases(summary).filter((p) => !(p.tools || []).includes('Read')).map((p) => p.title || p.name);
  return blind.length ? `${plural(blind.length, 'Этап', 'Этапы', 'Этапы')} ${blind.join(', ')} без Read вложений ${blind.length === 1 ? 'не увидит' : 'не увидят'}` : '';
}

// ---------- ссылка на Jira, Confluence или Slack во входе

export const CONN_WARN_TEXT = 'Во входе ссылка на Jira, Confluence или Slack, но коннекторы claude.ai не получит ни один этап этого flow: открыть её агент не сможет. Выдай инструменты коннектора нужному этапу в конструкторе (строка «Коннекторы claude.ai») или вставь текст задачи вместо ссылки.';
const CONN_OPEN_MODES = ['bypassPermissions', 'auto'];

/**
 * Ссылка во входе, а коннекторы claude.ai flow не получит ни один этап. Как в старом UI — по сводке flow: в ней нет
 * permission_mode, поэтому режимы с открытыми правами на деле не учитываются.
 */
export function connWarn(input: string, summary: FlowSummary | undefined): boolean {
  const phases = summaryPhases(summary) as (PhaseSummary & { permission_mode?: string })[];
  const link = /atlassian\.net|slack\.com\//i.test(input);
  const none = phases.length > 0 && !phases.some((p) => (p.tools || []).some((t) => t.startsWith(CONN_PREFIX)) || CONN_OPEN_MODES.includes(p.permission_mode ?? ''));
  return link && none;
}

// ---------- теги

export const TAG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TAG_SLUG_ERROR = 'Слаг тега: строчные латинские буквы, цифры и дефис';
export const KIND_LABEL: Record<TagKind, string> = { task: 'задача', knowledge: 'знание' };

/** Выбранный тег с сервера; у нового (404) записи нет — он заведётся тегом задачи. */
export type TagInfo = { kind: TagKind; title: string; input: string };

/** Подсказка в datalist поля «Теги»: «задача · заголовок». */
export const tagOptionLabel = (t: TagListItem): string =>
  `${KIND_LABEL[t.kind] || 'задача'} · ${t.title || t.preview.split('\n')[0] || (t.kind === 'knowledge' ? 'заметок ещё нет' : 'саммари ещё нет')}`;

/** Сообщение под тегами после добавления. */
export const tagAddedMsg = (slug: string, r: TagDetail): string =>
  r.kind === 'knowledge'
    ? `${slug}: тег знаний — ${r.notes.trim() || r.attachments.length || (r.dirs || []).length ? 'этапы получат его знание' : 'тег пуст'}`
    : `${slug}: ${r.summary.trim() || r.notes.trim() ? 'встанет в задачу' : 'саммари ещё нет'} · запусков: ${r.runs.length}`;

export const tagNewMsg = (slug: string): string => `${slug}: новый тег — заведётся при запуске`;

/** Панель «что сервер вставит» по тегу: текст блока без маркеров и куда он уйдёт. */
export function tagContext(info: TagInfo | undefined): { text: string; where: string; kind: TagKind } {
  const kind = info?.kind || 'task';
  return {
    kind,
    text: info ? info.input.replace(/<!-- \/?tag(?::[a-z0-9-]+)? -->\n?/g, '') : 'Новый тег: заведётся при запуске как тег задачи, саммари ещё нет.',
    where: kind === 'knowledge' ? 'уйдёт в конец промптов этапов каждого блока' : 'встанет в начало задачи',
  };
}

// ---------- доп. директории и недавние папки

export const RECENT_CHIPS = 8;

/** Чипы недавних папок: существующие, не больше восьми. */
export const recentChips = (dirs: RecentDir[]): RecentDir[] => dirs.filter((d) => d.exists).slice(0, RECENT_CHIPS);

/** Пути строками, без пустых. */
export const dirLines = (text: string): string[] => text.split('\n').map((x) => x.trim()).filter(Boolean);

/** Дописать путь строкой, без дублей (чип недавней папки, «Выбрать…» у доп. директорий). */
export function appendDir(text: string, dir: string): string {
  const lines = dirLines(text);
  return lines.includes(dir) ? lines.join('\n') : [...lines, dir].join('\n');
}

// ---------- привязка к источнику и worktree

/** Задача Jira, MR/PR или ветка, из которой собран вход; worktree — подготовленный для запуска. */
export type RunLink = { source?: RunSource; branch?: string; project?: string; worktree?: RunWorktree };

/** «Задача», «MR» или «PR» (по ключу: owner/repo#N — GitHub), «Ветка». */
export const sourceLabel = (s: RunSource): string => (s.type === 'jira' ? 'Задача' : s.type === 'mr' ? (mrSign(s.key) === '#' ? 'PR' : 'MR') : 'Ветка');

/** Проект в выборе worktree: из привязки, по директории проекта, иначе первый. */
export function worktreeProject(projects: Pick<ProjectInfo, 'path'>[], link: RunLink | null, cwd: string): string {
  const c = cwd.trim();
  return link?.project || projects.find((p) => c === p.path || c.startsWith(p.path + '/'))?.path || projects[0]?.path || '';
}

/**
 * Тело POST /api/worktrees: без ветки имя worktree — ключ источника; ветку MR/PR не подменяем новой от базовой —
 * её нет, пусть будет ошибка.
 */
export function worktreeRequest(link: RunLink | null, project: string, branch: string): { project: string; branch?: string; name?: string; requireExisting: boolean } {
  const b = branch.trim();
  return {
    project,
    branch: b || undefined,
    name: !b && link?.source ? link.source.key : undefined,
    requireExisting: link?.source?.type === 'mr' && b === link.branch,
  };
}

/** Заметка о worktree видна в задаче до запуска (сервер сам ничего не дописывает); прошлая заменяется, а не копится. */
export function withWorktreeNote(input: string, note: string): string {
  const rest = input.replace(/\n*^(?:Рабочая папка|Директория проекта) — (?:новый|существующий) git worktree .*$/gm, '').trimEnd();
  return rest ? `${rest}\n\n${note}` : note;
}

/** В cwd остался путь worktree прошлого запуска (запомнен раньше): без привязки к нему он чужой. */
export const staleWorktreeCwd = (cwd: string, worktreesDir: string | undefined, link: RunLink | null): boolean =>
  Boolean(worktreesDir) && !link?.worktree && cwd.trim().startsWith(worktreesDir + '/');

// ---------- сводка «Дополнительно» и тело запуска

export type MoreSumInput = {
  tags: string[];
  attach: number;
  addDirs: string;
  worktree: boolean;
  maxIterations: string;
  flowMaxIterations: number | undefined;
  budget: string;
  modelLabel: string;
};

/** Заголовок свёрнутого «Дополнительно»: что там задано не по умолчанию, чтобы скрытое не забылось. */
export function runMoreSum(f: MoreSumInput): { text: string; set: boolean } {
  const parts: string[] = [];
  if (f.tags.length) parts.push(f.tags.map((t) => `#${t}`).join(' '));
  if (f.attach) parts.push(`${f.attach} ${plural(f.attach, 'файл', 'файла', 'файлов')}`);
  const dirs = f.addDirs.split('\n').filter((x) => x.trim()).length;
  if (dirs) parts.push(`доп. директорий: ${dirs}`);
  if (f.worktree) parts.push('worktree');
  if (f.maxIterations && f.maxIterations !== String(f.flowMaxIterations ?? '')) parts.push(`до ${iterTo(Number(f.maxIterations))}`);
  if (f.budget) parts.push(`до $${f.budget}`);
  if (f.modelLabel) parts.push(f.modelLabel);
  return parts.length ? { text: parts.join(' · '), set: true } : { text: 'теги, вложения, директории, worktree, лимиты, модель', set: false };
}

export type RunBodyInput = {
  flow: string;
  /** Черновик разового запуска: spec из конструктора вместо имени flow. */
  spec?: unknown;
  input: string;
  cwd: string;
  maxIterations: string;
  maxBudgetUsd: string;
  model: string;
  link: RunLink | null;
  attach: Attach[];
  addDirs: string;
  tags: string[];
  saveTag: boolean;
  autoTag: boolean;
  /** Фичи сервера: чего он не умеет, того в теле нет. */
  can: { integrations: boolean; attachments: boolean; addDirs: boolean; tags: boolean };
};

/** Тело POST /api/runs — поля как у startRun старого UI. */
export function runBody(f: RunBodyInput): Record<string, unknown> {
  return {
    ...(f.spec ? { spec: f.spec } : { flow: f.flow }),
    input: f.input,
    cwd: f.cwd,
    maxIterations: f.maxIterations || undefined,
    maxBudgetUsd: f.maxBudgetUsd || undefined,
    model: f.model || undefined,
    ...(f.can.integrations && f.link ? { source: f.link.source, worktree: f.link.worktree } : {}),
    ...(f.can.attachments && f.attach.length ? { attachments: f.attach.map(({ name, data }) => ({ name, data })) } : {}),
    ...(f.can.addDirs ? { addDirs: dirLines(f.addDirs) } : {}),
    ...(f.can.tags && f.tags.length ? { tags: f.tags, saveTag: f.saveTag } : {}),
    ...(f.autoTag ? { autoTag: true } : {}),
  };
}

/** Автотег: только без выбранного тега задачи (новый слаг — тоже тег задачи). */
export const wantsAutoTag = (checked: boolean, tags: string[], info: Map<string, TagInfo>): boolean =>
  checked && !tags.some((t) => (info.get(t)?.kind || 'task') === 'task');
