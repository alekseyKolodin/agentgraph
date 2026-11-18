// Настройки интеграций (Jira, проекты GitLab, worktree): вне репозитория agentgraph, в ~/.agentgraph.
// Токен Jira лежит отдельным файлом с правами 600 и наружу (в API, лог, ошибки) не уходит.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Profile, ProfileResponse } from './api-types.js';
import { exec, type Exec } from './git.js';

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
  /** Кто я (SPEC 3.3). auto — поля, заполненные само: ручной ввод их снимает с пометки. */
  profile?: { value: Profile; auto?: (keyof Profile)[] };
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

// ---------------------------------------------------------------- профиль «кто я»

const PROFILE_KEYS = ['names', 'emails', 'gitlab', 'github', 'slackUserId', 'jiraEmail'] as const satisfies readonly (keyof Profile)[];

const uniq = (xs: unknown): string[] => {
  const list = Array.isArray(xs) ? xs : typeof xs === 'string' ? xs.split(/[\n,;]/) : [];
  const out: string[] = [];
  for (const x of list) {
    const v = String(x ?? '').trim();
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
};
const one = (x: unknown): string | undefined => String(x ?? '').trim() || undefined;

/** Любой ввод → Profile: обрезка, без повторов, пустые поля убраны. */
export function normalizeProfile(raw: unknown): Profile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const p: Profile = { names: uniq(r.names), emails: uniq(r.emails) };
  for (const k of ['gitlab', 'github', 'slackUserId', 'jiraEmail'] as const) {
    const v = one(r[k]);
    if (v) p[k] = v;
  }
  return p;
}

/** Сохранённый профиль без автозаполнения: его читают источники рутин (isSelf), без запуска команд. */
export function loadProfile(): Profile {
  return normalizeProfile(loadSettings().profile?.value);
}

const isEmpty = (p: Profile, k: keyof Profile): boolean => (Array.isArray(p[k]) ? (p[k] as string[]).length === 0 : !p[k]);

const tryRun = (x: Exec, cmd: string, args: string[]): Promise<string> =>
  x(cmd, args, { timeoutMs: 15_000 }).then(
    (o) => o.trim(),
    () => '',
  );

/** Что можно узнать само. Ошибка любой команды — пустой кусок, остальное работает. */
export async function guessProfile(jiraEmail: string | undefined, x: Exec = exec): Promise<Partial<Profile>> {
  const [glab, gh, name, email] = await Promise.all([
    tryRun(x, 'glab', ['api', 'user']).then((o) => {
      try {
        return (JSON.parse(o) as { username?: string }).username;
      } catch {
        return undefined;
      }
    }),
    tryRun(x, 'gh', ['api', 'user']).then((o) => {
      try {
        return (JSON.parse(o) as { login?: string }).login;
      } catch {
        return undefined;
      }
    }),
    tryRun(x, 'git', ['config', '--global', 'user.name']),
    tryRun(x, 'git', ['config', '--global', 'user.email']),
  ]);
  const g: Partial<Profile> = {};
  if (glab) g.gitlab = glab;
  if (gh) g.github = gh;
  if (name) g.names = [name];
  const emails = uniq([email, jiraEmail]);
  if (emails.length) g.emails = emails;
  if (jiraEmail) g.jiraEmail = jiraEmail;
  return g;
}

/** Профиль с автозаполнением пустых полей; введённое человеком не трогается. Найденное сохраняется с пометкой auto. */
export async function readProfile(x: Exec = exec): Promise<ProfileResponse> {
  const s = loadSettings();
  const profile = normalizeProfile(s.profile?.value);
  const auto = new Set<keyof Profile>(s.profile?.auto ?? []);
  if (PROFILE_KEYS.some((k) => isEmpty(profile, k))) {
    const guess = await guessProfile(s.jira?.email?.trim() || undefined, x);
    let changed = false;
    for (const k of PROFILE_KEYS) {
      const v = guess[k];
      if (!isEmpty(profile, k) || v === undefined || (Array.isArray(v) && !v.length)) continue;
      (profile as Record<string, unknown>)[k] = v;
      auto.add(k);
      changed = true;
    }
    if (changed) updateSettings((t) => (t.profile = { value: profile, auto: [...auto] }));
  }
  return { profile, auto: PROFILE_KEYS.filter((k) => auto.has(k)) };
}

/** Сохранить профиль, введённый человеком: изменённые им поля перестают быть «заполнено само». */
export function writeProfile(raw: unknown): ProfileResponse {
  const profile = normalizeProfile(raw);
  const prev = loadSettings().profile;
  const before = normalizeProfile(prev?.value);
  const auto = (prev?.auto ?? []).filter((k) => JSON.stringify(before[k] ?? null) === JSON.stringify(profile[k] ?? null) && !isEmpty(profile, k));
  updateSettings((s) => (s.profile = { value: profile, auto }));
  return { profile, auto };
}

/** GET/PUT /api/settings/profile; чужой маршрут — undefined. */
export async function profileRoute(method: string, pathname: string, readBody: () => Promise<unknown>, x: Exec = exec): Promise<{ status: number; body: unknown } | undefined> {
  if (pathname !== '/api/settings/profile') return undefined;
  if (method === 'GET') return { status: 200, body: await readProfile(x) };
  if (method === 'PUT') return { status: 200, body: writeProfile(await readBody()) };
  return undefined;
}
