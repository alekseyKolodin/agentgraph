// Маршруты дашборда: Jira, проекты GitLab и GitHub (MR/PR, ветки), мои MR, которым нужно внимание, вход флоу из задачи/MR/ветки, git worktree.
// Токен Jira принимается только на запись и наружу не отдаётся.
import fs from 'node:fs';
import path from 'node:path';
import { deleteJiraToken, loadSettings, readJiraToken, saveSettings, updateSettings, worktreesDir, writeJiraToken, type Settings } from './settings.js';
import { JiraError, jiraClient, JQL_PRESETS, normalizeBaseUrl, parseIssueKey, type FetchFn, type JqlPreset } from './jira.js';
import { ensureWorktree, exec, forgeUser, getMergeRequest, listMergeRequests, localBranches, mrDiscussions, repoRoot, worktreeList, type Exec } from './git.js';
import { addProjectRoot, autodetectProjects, describeProjects, findProject, projectRoot, removeProject } from './projects.js';
import { branchIntake, jiraIntake, mrIntake } from './intake.js';
import type { RunSource } from './intake.js';
import type { RunWorktree } from './runner.js';
import { attentionReasons, collectAttention, lastAttention, suggestFlows, type SuggestDeps } from './attention.js';
import type { FlowSummary } from './flows.js';
import type { AttentionResult, BranchView, IntegrationsInfo, JiraIssueBrief, MergeRequestView, Suggestion } from './api-types.js';

export type Reply = { status: number; body: unknown };

export type IntegrationDeps = {
  /** cwd прошлых запусков — для автоподхвата проектов. */
  runCwds: () => string[];
  /** Шаблон input флоу (анкета с плейсхолдерами). */
  flowInput: (flow: string) => string | undefined;
  /** Список flow для подбора к MR. */
  flows: () => FlowSummary[];
  exec?: Exec;
  /** Подмена сессии подбора flow в тестах. */
  session?: SuggestDeps['session'];
  fetch?: FetchFn;
};

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const bad = (error: string, status = 400): Reply => ({ status, body: { error } });

/** Маршрут не наш — undefined. */
export async function integrationsRoute(method: string, url: URL, readBody: () => Promise<unknown>, deps: IntegrationDeps): Promise<Reply | undefined> {
  const p = url.pathname;
  const x = deps.exec ?? exec;
  try {
    if (method === 'GET' && p === '/api/integrations') return ok(await overview(deps, x));

    // --- Jira
    if (p === '/api/integrations/jira' && method === 'PUT') {
      const b = (await readBody()) as { baseUrl?: string; email?: string; token?: string };
      const baseUrl = normalizeBaseUrl(String(b.baseUrl ?? ''));
      const email = String(b.email ?? '').trim();
      const saved = loadSettings().jira;
      // сохранённый токен уходит только на тот адрес и с тем email, для которых он был проверен
      const sameAccount = saved && normalizeBaseUrl(saved.baseUrl) === baseUrl && saved.email === email;
      const token = String(b.token ?? '').trim() || (sameAccount ? readJiraToken() : undefined);
      if (!email) return bad('Укажи email аккаунта Atlassian');
      if (!token && !sameAccount && readJiraToken()) return bad('Адрес или email изменились: впиши токен заново');
      if (!token) return bad('Укажи API-токен Jira');
      // проверяем до сохранения: неверный токен не затирает рабочий
      const me = await jiraClient({ baseUrl, email }, token, deps.fetch).myself();
      if (b.token?.trim()) writeJiraToken(token);
      updateSettings((s) => (s.jira = { ...s.jira, baseUrl, email }));
      return ok({ connected: true, user: me.displayName });
    }
    if (p === '/api/integrations/jira' && method === 'DELETE') {
      deleteJiraToken();
      updateSettings((s) => delete s.jira);
      return ok({ ok: true });
    }
    if (p === '/api/jira/issues' && method === 'GET') {
      const { client, s } = jira(deps);
      const preset = url.searchParams.get('preset') ?? 'sprint';
      let jql: string;
      if (preset === 'jql') {
        jql = (url.searchParams.get('jql') ?? '').trim();
        if (!jql) return bad('Пустой JQL');
        if (jql !== s.jira?.lastJql) updateSettings((x2) => x2.jira && (x2.jira.lastJql = jql));
      } else if (preset in JQL_PRESETS) jql = JQL_PRESETS[preset as JqlPreset];
      else return bad(`Неизвестный пресет: ${preset}`);
      return ok({ jql, issues: (await client.search(jql, 50)) satisfies JiraIssueBrief[] });
    }

    // --- проекты
    if (p === '/api/projects' && method === 'POST') {
      const b = (await readBody()) as { path?: string };
      if (!b.path?.trim()) return bad('Укажи путь к репозиторию');
      const root = await projectRoot(expandHome(b.path.trim()), x);
      let added;
      updateSettings((s) => (added = addProjectRoot(s, root)));
      return ok(added, 201);
    }
    if (p === '/api/projects' && (method === 'PUT' || method === 'DELETE')) {
      const b = (await readBody()) as { path?: string; name?: string; base?: string; copyFiles?: string[] | string };
      const s = loadSettings();
      const proj = b.path ? findProject(s, b.path) : undefined;
      if (!proj) return bad('Проект не найден', 404);
      if (method === 'DELETE') removeProject(s, proj.path);
      else {
        if (b.name !== undefined) proj.name = String(b.name).trim() || undefined;
        if (b.base !== undefined) proj.base = String(b.base).trim().replace(/^origin\//, '') || undefined;
        if (b.copyFiles !== undefined) {
          const list = (Array.isArray(b.copyFiles) ? b.copyFiles : String(b.copyFiles).split(/[\n,]/)).map((f) => String(f).trim()).filter(Boolean);
          const badPath = list.find((f) => path.isAbsolute(f) || f.split(/[\\/]/).includes('..'));
          if (badPath) return bad(`Только относительные пути внутри репозитория: ${badPath}`);
          proj.copyFiles = list.length ? list : undefined;
        }
      }
      saveSettings(s);
      return ok({ ok: true });
    }
    if (p === '/api/projects/mrs' && method === 'GET') {
      const proj = await projectInfo(url.searchParams.get('path') ?? '', x);
      if (!proj.remote) return bad('У репозитория нет origin на GitLab или GitHub');
      return ok({ mrs: (await listMergeRequests(proj.remote, { mine: url.searchParams.get('mine') === '1' }, x)) satisfies MergeRequestView[] });
    }
    if (p === '/api/projects/branches' && method === 'GET') {
      const proj = await projectInfo(url.searchParams.get('path') ?? '', x);
      const [branches, wts] = await Promise.all([localBranches(proj.path, x), worktreeList(proj.path, x)]);
      const where = new Map(wts.filter((w) => w.branch).map((w) => [w.branch!, w.path]));
      return ok({ branches: branches.slice(0, 100).map((b) => ({ ...b, worktree: where.get(b.name) })) satisfies BranchView[] });
    }

    // --- мои MR, которым нужно внимание
    if (p === '/api/attention' && method === 'GET') {
      const projects = await describeProjects(loadSettings(), x);
      return ok((await collectAttention(projects, { force: url.searchParams.get('force') === '1', exec: x })) satisfies AttentionResult);
    }
    if (p === '/api/attention/suggest' && method === 'POST') {
      const b = (await readBody()) as { refs?: unknown };
      const refs = new Set(Array.isArray(b.refs) ? b.refs.filter((r): r is string => typeof r === 'string') : []);
      // подбираем только по MR из последней выдачи: заголовки и причины с клиента модели не уходят
      const items = (lastAttention()?.items ?? []).filter((i) => refs.has(i.ref));
      return ok({ suggestions: (await suggestFlows(items, deps.flows(), { session: deps.session })) satisfies Record<string, Suggestion> });
    }

    // --- вход флоу и worktree
    if (p === '/api/intake' && method === 'POST') {
      const b = (await readBody()) as { flow?: string; type?: string; key?: string; project?: string; attention?: boolean };
      const template = b.flow ? deps.flowInput(b.flow) : undefined;
      const projectPath = b.project ? (await projectByPath(b.project, x)).path : undefined;
      if (b.type === 'jira') {
        const key = parseIssueKey(String(b.key ?? ''));
        if (!key) return bad('Не ключ и не ссылка задачи Jira');
        return ok(jiraIntake(await jira(deps).client.issue(key), template, projectPath));
      }
      if (b.type === 'mr') {
        const proj = await projectInfo(b.project ?? '', x);
        if (!proj.remote) return bad('У репозитория нет origin на GitLab или GitHub');
        const remote = proj.remote;
        const mr = await getMergeRequest(remote, Number(String(b.key ?? '').replace(/^.*[!#]/, '')), x);
        // из секции «нужно внимание»: причины считаем заново, на момент запуска
        const reasons = b.attention === true
          ? attentionReasons(mr, mr.notesCount ? await mrDiscussions(remote, mr.iid, x) : [], await forgeUser(remote.host, x))
          : undefined;
        return ok(mrIntake(mr, template, proj.path, reasons));
      }
      if (b.type === 'branch') {
        if (!projectPath) return bad('Не выбран проект');
        const br = (await localBranches(projectPath, x)).find((q) => q.name === b.key);
        if (!br) return bad(`Локальной ветки ${b.key} нет`, 404);
        return ok(branchIntake(br.name, br.subject, template, projectPath));
      }
      return bad('type: jira | mr | branch');
    }
    if (p === '/api/worktrees' && method === 'POST') {
      const b = (await readBody()) as { project?: string; branch?: string; name?: string; requireExisting?: boolean };
      const s = loadSettings();
      const proj = await projectByPath(b.project ?? '', x);
      const cfg = findProject(s, proj.path);
      return ok(await ensureWorktree({ root: proj.path, baseDir: worktreesDir(s), branch: b.branch, name: b.name, base: cfg?.base, copyFiles: cfg?.copyFiles, requireExisting: b.requireExisting === true }, x), 201);
    }
  } catch (err) {
    if (err instanceof JiraError) return bad(err.message, err.status === 401 || err.status === 403 ? 400 : 502);
    return bad(err instanceof Error ? err.message : String(err));
  }
  return undefined;
}

async function overview(deps: IntegrationDeps, x: Exec): Promise<IntegrationsInfo> {
  let s = loadSettings();
  const before = s.projects.length;
  if (await autodetectProjects(s, deps.runCwds(), x)) {
    const found = s.projects.slice(before);
    s = updateSettings((t) => {
      for (const f of found) if (!t.projects.some((q) => q.path === f.path)) t.projects.push(f);
    });
  }
  const has = (cmd: string) =>
    x(cmd, ['--version'], { timeoutMs: 5_000 }).then(
      () => true,
      () => false,
    );
  const [glab, gh] = await Promise.all([has('glab'), has('gh')]);
  return {
    jira: s.jira ? { baseUrl: s.jira.baseUrl, email: s.jira.email, lastJql: s.jira.lastJql, hasToken: Boolean(readJiraToken()) } : null,
    presets: JQL_PRESETS,
    projects: await describeProjects(s, x),
    worktreesDir: worktreesDir(s),
    glab,
    gh,
  };
}

function jira(deps: IntegrationDeps) {
  const s = loadSettings();
  const token = readJiraToken();
  if (!s.jira || !token) throw new JiraError('Jira не подключена: открой «Подключения» на главной');
  return { s, client: jiraClient(s.jira, token, deps.fetch) };
}

/** Проект только из настроек: произвольные пути с клиента в git не идут. */
async function projectByPath(dir: string, x: Exec) {
  const s = loadSettings();
  const root = dir && fs.existsSync(dir) ? await repoRoot(dir, x) : undefined;
  const proj = root ? findProject(s, root) : undefined;
  if (!proj) throw new Error('Проект не найден: добавь его на главной');
  return proj;
}

async function projectInfo(dir: string, x: Exec) {
  const proj = await projectByPath(dir, x);
  const [full] = await describeProjects({ projects: [proj] } as Settings, x);
  if (!full) throw new Error(`Папки проекта нет на диске: ${proj.path}`);
  return full;
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(process.env.HOME ?? '', p.slice(1)) : p;
}

/** Поля запуска с клиента: источник как есть (обрезанный), worktree — только внутри папки worktree. */
export function runLinks(body: { source?: unknown; worktree?: unknown }, cwd: string): { source?: RunSource; worktree?: RunWorktree } {
  const out: { source?: RunSource; worktree?: RunWorktree } = {};
  const src = body.source as Partial<RunSource> | undefined;
  if (src && (src.type === 'jira' || src.type === 'mr' || src.type === 'branch') && typeof src.key === 'string' && src.key) {
    const str = (v: unknown, n: number) => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
    out.source = { type: src.type, key: src.key.slice(0, 200), title: str(src.title, 300) ?? '', url: str(src.url, 500), project: str(src.project, 500) };
  }
  const wt = body.worktree as Partial<RunWorktree> | undefined;
  if (wt && typeof wt.path === 'string') {
    const base = worktreesDir();
    const real = fs.existsSync(wt.path) ? fs.realpathSync(wt.path) : '';
    const realBase = fs.existsSync(base) ? fs.realpathSync(base) : base;
    if (real && real.startsWith(realBase + path.sep) && fs.realpathSync(cwd) === real) out.worktree = { path: real, branch: typeof wt.branch === 'string' ? wt.branch : undefined };
  }
  return out;
}
