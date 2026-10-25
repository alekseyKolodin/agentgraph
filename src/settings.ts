// Настройки интеграций (Jira, проекты GitLab, worktree): вне репозитория agentgraph, в ~/.agentgraph.
// Токен Jira лежит отдельным файлом с правами 600 и наружу (в API, лог, ошибки) не уходит.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProjectSettings = {
  /** Корень основного checkout репозитория. */
  path: string;
  /** Отображаемое имя; по умолчанию — имя папки. */
  name?: string;
  /** Базовая ветка для новых веток worktree (без origin/); по умолчанию — origin/HEAD. */
  base?: string;
  /** Неотслеживаемые файлы проекта, которые копируются в новый worktree (напр. local.properties). Только относительные пути. */
  copyFiles?: string[];
  /** Добавлен руками (true) или подхвачен из cwd запусков. Автоподхват не возвращает удалённые вручную. */
  manual?: boolean;
};

export type JiraSettings = { baseUrl: string; email: string; lastJql?: string };

export type Settings = {
  projects: ProjectSettings[];
  /** Проекты, убранные пользователем: автоподхват их не добавляет снова. */
  hiddenProjects?: string[];
  /**
   * Пути, убранные из недавних директорий формы запуска, и время скрытия (ISO). В отличие от hiddenProjects,
   * не выкидывает проект из «Подключений» и не отключает автоподхват: путь вернётся после нового запуска с ним.
   */
  hiddenDirs?: { path: string; at: string }[];
  jira?: JiraSettings;
  /** Куда класть worktree; по умолчанию <каталог настроек>/worktrees. */
  worktreesDir?: string;
};

/** Каталог читается при каждом вызове, а не при загрузке модуля: тесты подменяют AGENTGRAPH_CONFIG_DIR. */
export function configDir(): string {
  return process.env.AGENTGRAPH_CONFIG_DIR || path.join(os.homedir(), '.agentgraph');
}

const settingsFile = () => path.join(configDir(), 'settings.json');
const tokenFile = () => path.join(configDir(), 'jira-token');

function ensureDir(): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mode в mkdirSync действует только при создании
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function loadSettings(): Settings {
  let raw: Partial<Settings> = {};
  try {
    raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Не читается ${settingsFile()}: ${(err as Error).message}`);
  }
  return { ...raw, projects: Array.isArray(raw.projects) ? raw.projects : [] };
}

export function saveSettings(s: Settings): void {
  ensureDir();
  const file = settingsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function updateSettings(fn: (s: Settings) => void): Settings {
  const s = loadSettings();
  fn(s);
  saveSettings(s);
  return s;
}

export function worktreesDir(s: Settings = loadSettings()): string {
  const dir = s.worktreesDir?.trim();
  if (!dir) return path.join(configDir(), 'worktrees');
  return path.resolve(dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir);
}

export function readJiraToken(): string | undefined {
  try {
    return fs.readFileSync(tokenFile(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function writeJiraToken(token: string): void {
  ensureDir();
  const file = tokenFile();
  fs.writeFileSync(file, token.trim() + '\n', { mode: 0o600 });
  // mode в writeFileSync действует только при создании: старый файл мог быть с другими правами
  fs.chmodSync(file, 0o600);
}

export function deleteJiraToken(): void {
  fs.rmSync(tokenFile(), { force: true });
}
