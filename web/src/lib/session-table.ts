// Таблица «Все сессии» на странице «Сессии» без React и DOM: поиск (название, папка, ветка, проект, теги, id), фильтр
// по проекту (пространству — его считает сервер, SessionView.projectRef) и группы по проекту. Сессии закрытых дел
// (closed-work.ts) уходят с глаз со счётчиком, поиск находит и их.
import type { SessionView } from '@server/api-types';
import { t } from './i18n';
import { searchWords, textMatches } from './search';
import { projectHint, projectKeyOf, projectLabel } from './spaces';

/** Фильтр по проекту: null — все проекты, '' — без проекта, иначе слаг пространства. */
export type SessionProject = string | null;

export type TableSession = Pick<SessionView, 'id' | 'name' | 'cwd' | 'live' | 'tags'> & Partial<Pick<SessionView, 'space' | 'branch' | 'projectRef'>>;

export type SessionTableOpts<S extends TableSession> = {
  query: string;
  project: SessionProject;
  grouped: boolean;
  /** Сессия закрытого дела: уходит с глаз, пока не показали убранные. */
  closed?: (s: S) => boolean;
  showClosed?: boolean;
};

export type ProjectOption = { space: string; label: string; count: number };
export type SessionTableGroup<S> = { key: string; space: string; label: string; title: string; sessions: S[] };

export type SessionTableView<S> = {
  /** Группы строк; без группировки (или проект один) — одна группа без подписи (label ''). */
  groups: SessionTableGroup<S>[];
  /** Проекты для фильтра — с числом сессий (после поиска), выбранный остаётся, даже если сессий в нём нет. */
  projects: ProjectOption[];
  /** Сколько строк в таблице. */
  shown: number;
  /** Сколько сессий закрытых дел убрано с глаз (без поиска). */
  closedCount: number;
  /** Почему таблица пуста; '' — есть строки. */
  empty: string;
};

/** Сессия подходит под запрос: каждое слово — в названии, папке, ветке, проекте, пространстве, тегах или id. */
export const sessionMatches = (s: TableSession, words: string[]): boolean =>
  textMatches([s.name, s.cwd, s.branch, s.space, s.projectRef?.space ? s.projectRef.title : '', ...s.tags, s.id], words);

export function sessionTable<S extends TableSession>(all: S[], o: SessionTableOpts<S>): SessionTableView<S> {
  const words = searchWords(o.query);
  const searching = words.length > 0;
  const away = (s: S) => !s.live && Boolean(o.closed?.(s));
  const closedCount = searching ? 0 : all.filter(away).length;
  const pool = o.showClosed || searching ? all : all.filter((s) => !away(s));
  const found = searching ? pool.filter((s) => sessionMatches(s, words)) : pool;

  // проекты — в порядке списка (живые и свежие сверху), «Без проекта» — на общих правах
  const byProject = new Map<string, S[]>();
  for (const s of found) {
    const k = projectKeyOf(s.projectRef);
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k)!.push(s);
  }
  const projects: ProjectOption[] = [...byProject].map(([space, list]) => ({ space, label: projectLabel(list[0]!.projectRef), count: list.length }));
  if (o.project !== null && !byProject.has(o.project)) {
    const known = all.find((s) => projectKeyOf(s.projectRef) === o.project);
    projects.push({ space: o.project, label: known ? projectLabel(known.projectRef) : o.project ? `◇ ${o.project}` : t('Без проекта'), count: 0 });
  }

  const rows = o.project === null ? found : (byProject.get(o.project) ?? []);
  const groups: SessionTableGroup<S>[] = !rows.length
    ? []
    : o.grouped && o.project === null && byProject.size > 1
      ? [...byProject].map(([space, list]) => ({ key: `sproj:${space}`, space, label: projectLabel(list[0]!.projectRef), title: projectHint(list[0]!.projectRef), sessions: list }))
      : [{ key: 'all', space: o.project ?? '', label: '', title: '', sessions: rows }];
  const empty = rows.length
    ? ''
    : !all.length
      ? t('Сессий ещё не было: открой первую формой выше.')
      : searching
        ? t('Ничего не нашлось')
        : !pool.length
          ? t('Все сессии — закрытых дел: они убраны с глаз')
          : t('В этом проекте сессий нет');
  return { groups, projects, shown: rows.length, closedCount, empty };
}
