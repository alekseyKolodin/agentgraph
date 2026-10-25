// Проекты для дашборда: добавленные руками + подхваченные из cwd прошлых запусков (только существующие git-репо).
import fs from 'node:fs';
import path from 'node:path';
import { exec, forgeOf, originUrl, parseRemote, repoRoot, type Exec, type Forge, type Remote } from './git.js';
import type { ProjectSettings, Settings } from './settings.js';
import type { RecentDir } from './api-types.js';

export type Project = ProjectSettings & { name: string; remote?: Remote; forge?: Forge; webUrl?: string };

/** Добавляет в настройки репо из cwd запусков, которых там нет и которые не убраны руками. Возвращает true, если что-то добавлено. */
export async function autodetectProjects(s: Settings, cwds: string[], x: Exec = exec): Promise<boolean> {
  const known = new Set([...s.projects.map((p) => p.path), ...(s.hiddenProjects ?? [])]);
  let added = false;
  for (const cwd of new Set(cwds)) {
    if (!cwd || !fs.existsSync(cwd)) continue;
    const root = await repoRoot(cwd, x);
    if (!root || known.has(root)) continue;
    known.add(root);
    s.projects.push({ path: root });
    added = true;
  }
  return added;
}

export async function addProject(s: Settings, dir: string, x: Exec = exec): Promise<ProjectSettings> {
  return addProjectRoot(s, await projectRoot(dir, x));
}

export async function projectRoot(dir: string, x: Exec = exec): Promise<string> {
  const root = await repoRoot(path.resolve(dir), x);
  if (!root) throw new Error(`${dir} — не git-репозиторий`);
  return root;
}

/** Синхронная часть: вызывается внутри updateSettings, чтобы не затереть параллельные правки настроек. */
export function addProjectRoot(s: Settings, root: string): ProjectSettings {
  s.hiddenProjects = (s.hiddenProjects ?? []).filter((p) => p !== root);
  let p = s.projects.find((q) => q.path === root);
  if (!p) s.projects.push((p = { path: root }));
  p.manual = true;
  return p;
}

export function removeProject(s: Settings, root: string): void {
  s.projects = s.projects.filter((p) => p.path !== root);
  s.hiddenProjects = [...new Set([...(s.hiddenProjects ?? []), root])];
}

/** Проект с разобранным origin; отсутствующие на диске пропускаются. */
export async function describeProjects(s: Settings, x: Exec = exec): Promise<Project[]> {
  const out: Project[] = [];
  for (const p of s.projects) {
    if (!fs.existsSync(p.path)) continue;
    const url = await originUrl(p.path, x);
    const remote = url ? parseRemote(url) : undefined;
    out.push({ ...p, name: p.name || path.basename(p.path), remote, forge: remote ? forgeOf(remote.host) : undefined, webUrl: remote ? `https://${remote.host}/${remote.path}` : undefined });
  }
  return out;
}

export function findProject(s: Settings, root: string): ProjectSettings | undefined {
  return s.projects.find((p) => p.path === root);
}

// элемент списка недавних — общий с UI: src/api-types.ts
export type { RecentDir } from './api-types.js';
export type HiddenDir = { path: string; at: string };

/** Время ISO-строки для сравнения: Date.parse, а не строкой. Нераспознанная или пустая дата — «давно». */
const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
};

/** Текст ошибки, если путь для скрытия из недавних — не непустая абсолютная строка. */
export function recentDirProblem(dir: unknown): string | undefined {
  if (typeof dir !== 'string' || !dir.trim()) return 'Нужен параметр path — абсолютный путь';
  if (!path.isAbsolute(dir)) return `Путь должен быть абсолютным: ${dir}`;
  return undefined;
}

/** Синхронная часть для updateSettings: убирает путь из недавних, повторное скрытие обновляет время. */
export function hideRecentDir(s: Settings, dir: string, at: string): void {
  s.hiddenDirs = [...(Array.isArray(s.hiddenDirs) ? s.hiddenDirs : []).filter((h) => h.path !== dir), { path: dir, at }];
}

/**
 * Недавние директории для формы запуска: cwd и addDirs запусков (свежие сверху), затем проекты
 * из «Подключений» и директория по умолчанию. Worktree запусков не берём: они разовые.
 * Подпись — имя проекта, если путь — проект, иначе имя папки. exists — колбэк, чтобы не ходить в ФС в тестах.
 * Проекты, убранные в «Подключениях» (hidden), не показываются, даже если с ними были запуски.
 * Пути, убранные из недавних (hiddenDirs), не показываются, пока с ними не будет запуска позже скрытия.
 */
export function recentDirs(o: {
  runs: { cwd?: string; addDirs?: string[]; worktree?: unknown; startedAt: string }[];
  projects: { path: string; name?: string }[];
  hidden?: string[];
  hiddenDirs?: HiddenDir[];
  defaultCwd?: string;
  limit?: number;
  exists?: (dir: string) => boolean;
}): RecentDir[] {
  const last = new Map<string, string>();
  const hidden = new Set(o.hidden ?? []);
  const use = (dir: string | undefined, at?: string) => {
    if (!dir || hidden.has(dir)) return;
    const prev = last.get(dir);
    if (prev === undefined || (at && (!prev || at > prev))) last.set(dir, at ?? '');
  };
  for (const r of o.runs) {
    if (!r.worktree) use(r.cwd, r.startedAt);
    for (const d of r.addDirs ?? []) use(d, r.startedAt);
  }
  for (const p of o.projects) use(p.path);
  use(o.defaultCwd);
  const names = new Map(o.projects.map((p) => [p.path, p.name]));
  const exists = o.exists ?? ((d: string) => fs.existsSync(d));
  // фильтр после слияния источников: lastUsed — самый свежий запуск по всем; без запусков (проекты, путь по умолчанию) скрыт всегда
  const hiddenAt = new Map((Array.isArray(o.hiddenDirs) ? o.hiddenDirs : []).map((h) => [h.path, h.at]));
  const shown = ([dir, at]: [string, string]) => {
    const since = hiddenAt.get(dir);
    return since === undefined || time(at) > time(since);
  };
  const list = [...last.entries()]
    .filter(shown)
    // sort стабильный: пути без запусков остаются в порядке проектов и директории по умолчанию
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([dir, at]): RecentDir => ({ path: dir, label: names.get(dir) || path.basename(dir) || dir, ...(at ? { lastUsed: at } : {}), exists: exists(dir) }));
  return o.limit !== undefined && o.limit > 0 ? list.slice(0, o.limit) : list;
}
