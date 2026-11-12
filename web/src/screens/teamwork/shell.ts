// Чистые помощники оболочки Teamwork: адреса экранов и вкладок, разбор ссылки на репо, подписи. Без React и DOM.
// Логика доски, бэклога, документов и синхронизации — в web/src/lib/teamwork/ (волна ui-logic), здесь её нет.
import type { TeamProjectBrief, TeamRemoteCheck } from '@server/api-types';
import { plural, t } from '../../lib/i18n';

const enc = encodeURIComponent;

export const TEAMS_PATH = '/teamwork';
export const teamPath = (team: string): string => `${TEAMS_PATH}/${enc(team)}`;

/** Вкладки проекта (spec §11): адрес вкладки — её имя, «Обзор» — без хвоста. */
export type ProjectTab = 'overview' | 'prd' | 'architecture' | 'design' | 'docs' | 'backlog' | 'board' | 'sprints';
export const PROJECT_TABS: readonly ProjectTab[] = ['overview', 'prd', 'architecture', 'design', 'docs', 'backlog', 'board', 'sprints'];
const PROJECT_TAB_LABEL: Record<ProjectTab, string> = {
  overview: 'Обзор', prd: 'ТЗ', architecture: 'Архитектура', design: 'Дизайн', docs: 'Документы', backlog: 'Бэклог', board: 'Доска', sprints: 'Спринты',
};
export const projectTabLabel = (tab: ProjectTab): string => t(PROJECT_TAB_LABEL[tab]);
/** Хвост адреса → вкладка; пусто — «Обзор», незнакомое — undefined (экран уводит на обзор). */
export const projectTabOf = (raw: string | undefined): ProjectTab | undefined =>
  raw === undefined || raw === '' ? 'overview' : (PROJECT_TABS as readonly string[]).includes(raw) ? (raw as ProjectTab) : undefined;
export const projectPath = (team: string, project: string, tab: ProjectTab = 'overview'): string =>
  `${teamPath(team)}/${enc(project)}${tab === 'overview' ? '' : `/${tab}`}`;
/** Параметр ?task=ID: панель задачи поверх любой вкладки проекта. */
export const TASK_PARAM = 'task';

/** Вкладки команды: ?tab=members и т. п.; «Проекты» — без параметра. */
export type TeamTab = 'projects' | 'members' | 'process' | 'settings';
export const TEAM_TABS: readonly TeamTab[] = ['projects', 'members', 'process', 'settings'];
const TEAM_TAB_LABEL: Record<TeamTab, string> = { projects: 'Проекты', members: 'Участники', process: 'Процесс', settings: 'Настройки' };
export const teamTabLabel = (tab: TeamTab): string => t(TEAM_TAB_LABEL[tab]);
export const teamTabOf = (raw: string | null | undefined): TeamTab => ((TEAM_TABS as readonly string[]).includes(raw ?? '') ? (raw as TeamTab) : 'projects');
export const teamTabPath = (team: string, tab: TeamTab): string => (tab === 'projects' ? teamPath(team) : `${teamPath(team)}?tab=${tab}`);

/** Префикс номеров задач — как PREFIX_RE сервера (spec §5.2). */
export const PREFIX_RE = /^[A-Z]{2,6}$/;
/** Слаг проекта и команды — как TEAM_SLUG_RE сервера. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Ссылка на репо без схемы и .git: «github.com/acme/payments-team» — для подзаголовков и строк списка. */
export function remoteLabel(url: string): string {
  const s = url.trim();
  const scp = s.match(/^[^@\s/]+@([^:\s/]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]!.replace(/^\/+/, '')}`.replace(/\.git$/i, '');
  try {
    const u = new URL(s);
    if (u.protocol === 'file:') return u.pathname.replace(/\/+$/, '');
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`.replace(/\.git$/i, '');
  } catch {
    return s.replace(/\.git$/i, '');
  }
}

/** Слаг папки клона из ссылки — как teamSlugFromUrl сервера (последний сегмент), при занятости сервер добавит «-2». */
export function slugFromUrl(url: string): string {
  const tail = url.replace(/[/\\]+$/, '').split(/[/:\\]/).pop() ?? '';
  const slug = tail.replace(/\.git$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return SLUG_RE.test(slug) ? slug : 'team';
}

/** Похоже ли на ссылку целиком, чтобы проверять её на сервере: без пробелов, со схемой, «@host:» или абсолютным путём. */
export const urlLooksComplete = (url: string): boolean => {
  const s = url.trim();
  return s.length >= 4 && !/\s/.test(s) && !s.startsWith('-') && (/^[a-z][a-z0-9+.-]*:\/\/./i.test(s) || /^[^@/\s]+@[^:/\s]+:./.test(s) || s.startsWith('/'));
};

/** Строка под полем ссылки по ответу проверки. */
export function checkLine(check: TeamRemoteCheck | undefined, busy: boolean): { text: string; tone: '' | 'ok' | 'warn' | 'err' } {
  if (busy) return { text: t('Проверяю репо…'), tone: '' };
  if (!check) return { text: '', tone: '' };
  switch (check.kind) {
    case 'empty':
      return { text: check.writable === false ? t('✓ Репо пустой, но доступа на запись нет') : t('✓ Репо пустой, можно создавать команду'), tone: check.writable === false ? 'warn' : 'ok' };
    case 'team':
      return { text: t('Это уже команда «{title}» ({prefix}) — подключитесь к ней', { title: check.title, prefix: check.prefix }), tone: 'warn' };
    case 'not_empty':
      return { text: t('Репо не пустой и не команда: нужен пустой репо'), tone: 'err' };
    default:
      return { text: check.error, tone: 'err' };
  }
}

export const membersWord = (n: number): string => `${n} ${plural(n, 'участник', 'участника', 'участников')}`;
export const projectsWord = (n: number): string => `${n} ${plural(n, 'проект', 'проекта', 'проектов')}`;

/** Строка проектов команды в списке: «Экспорт счетов — спринт 2, готово 2 из 12 · Сверка — бэклог 7». */
export function projectBriefLine(p: TeamProjectBrief): string {
  if (p.sprint) return t('спринт {n}, готово {done} из {total}', { n: p.sprint.number, done: p.sprint.done, total: p.sprint.total });
  return t('бэклог {n}', { n: p.backlog });
}

/** Инициалы по имени или email: «Алексей Колодин» → АК, «alex@example.com» → AL. */
export function initialsOf(name: string | undefined, email?: string): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  if (parts.length === 1 && parts[0]!.length >= 2) return parts[0]!.slice(0, 2).toUpperCase();
  const local = (email ?? '').split('@')[0] ?? '';
  return local.slice(0, 2).toUpperCase() || '?';
}

/** Что показать значением конфликта: строка как есть, остальное — JSON. */
export function conflictValue(v: unknown): string {
  if (v === undefined || v === null) return t('— пусто —');
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

/** Подпись вида конфликта (spec §7.4). */
export function conflictKindText(kind: 'field' | 'text' | 'deleted' | 'sprint', field?: string): string {
  switch (kind) {
    case 'field':
      return field ? t('поле «{field}»: одно поле, разные значения', { field }) : t('одно поле, разные значения');
    case 'text':
      return t('текст изменили оба');
    case 'deleted':
      return t('файл удалён в репо, у вас он изменён');
    default:
      return t('два активных спринта: активным остался более ранний, задачи переносятся руками');
  }
}
