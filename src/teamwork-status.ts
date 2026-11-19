// Teamwork: автоматика статусов задач по запускам, сессиям и PR (docs/teamwork/spec.md §10). Старт запуска или сессии из
// задачи — «К работе» → «В работе», исполнитель — я, если пусто; запуск кончился done — «В работе» → «Ревью»; упал или
// остановлен — без перехода (значок по статусу в local.json → work). PR по ветке задачи: открыт — «К работе» или «В работе»
// → «Ревью» и ссылка в задаче, смёржен — любой статус → «Готово», закрыт без мёржа — только pr.state. Автоматика двигает
// задачу только вперёд и срабатывает по смене pr.state: ручной возврат назад не отменяется, повторное наблюдение того же
// PR ничего не пишет (у двух участников — одинаковое значение, конфликта нет). PR ищутся через gh или glab (git.ts) раз в
// PR_POLL_MS и только пока есть задачи «В работе» или «Ревью» с веткой; без gh и glab переходы по PR не работают.
// Раннер и сессии про Teamwork не знают: сервер зовёт started/ended после старта и после события end.
import { exec, listMergeRequests, parseRemote, type Exec, type MergeRequest, type Remote } from './git.js';
import { mrLifecycle } from './things/forge.js';
import { TeamError, TeamRepo } from './teamwork-repo.js';
import type { TeamService } from './teamwork-server.js';
import { parseProject, TASK_ID_RE, TEAM_SLUG_RE } from './teamwork.js';
import type { RunTeamworkLink, TeamDraftKind, TeamPr, TeamTask, TeamTaskPatch, TeamTaskStatus, TeamTaskWork } from './api-types.js';

/** Опрос PR: раз в 2 минуты (spec §10). */
export const PR_POLL_MS = 2 * 60_000;

const ORDER: Record<TeamTaskStatus, number> = { todo: 0, in_progress: 1, review: 2, done: 3 };
const DRAFT_KINDS: readonly TeamDraftKind[] = ['prd', 'architecture', 'split'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Автоматика двигает задачу только вперёд по колонкам доски. */
export const forward = (from: TeamTaskStatus, to: TeamTaskStatus): boolean => ORDER[to] > ORDER[from];

/**
 * Связь запуска или сессии с Teamwork из тела запроса: слаги команды и проекта, номер задачи или вид черновика. Нет поля —
 * undefined; кривое — ошибка для 400.
 */
export function parseTeamworkLink(raw: unknown): RunTeamworkLink | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error('teamwork — объект { team, project, task? }');
  const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : raw[k] === undefined ? undefined : null);
  const team = str('team');
  const project = str('project');
  if (!team || !TEAM_SLUG_RE.test(team)) throw new Error('teamwork.team — слаг команды');
  if (!project || !TEAM_SLUG_RE.test(project)) throw new Error('teamwork.project — слаг проекта');
  const link: RunTeamworkLink = { team, project };
  const task = str('task');
  if (task !== undefined) {
    if (!task || !TASK_ID_RE.test(task)) throw new Error('teamwork.task — номер задачи вида PAY-12');
    link.task = task;
  }
  const draft = str('draft');
  if (draft !== undefined) {
    if (!draft || !DRAFT_KINDS.includes(draft as TeamDraftKind)) throw new Error(`teamwork.draft: ${DRAFT_KINDS.join(' | ')}`);
    link.draft = draft as TeamDraftKind;
  }
  const section = str('section');
  if (section !== undefined) {
    if (section === null) throw new Error('teamwork.section — строка');
    // заголовок раздела документа: длиннее не бывает, а в run.json уходит как есть
    if (section) link.section = section.slice(0, 200);
  }
  return link;
}

// ---------- переходы (чистые функции)

/** Запуск или сессия начаты из задачи: «К работе» → «В работе», исполнитель — я, если пусто. Нечего менять — undefined. */
export function startPatch(task: Pick<TeamTask, 'status' | 'assignee'>, me?: string): TeamTaskPatch | undefined {
  const patch: TeamTaskPatch = {};
  if (task.status === 'todo') patch.status = 'in_progress';
  if (!task.assignee && me) patch.assignee = me;
  return Object.keys(patch).length ? patch : undefined;
}

/** Запуск по задаче закончился: done — «В работе» → «Ревью»; упал, остановлен или задача уже дальше — без перехода. */
export function runEndPatch(task: Pick<TeamTask, 'status'>, runStatus: string): TeamTaskPatch | undefined {
  return runStatus === 'done' && task.status === 'in_progress' ? { status: 'review' } : undefined;
}

/**
 * Увидели PR по ветке задачи. Тот же PR в том же состоянии, что записано в задаче, — ничего (так ручной возврат задачи
 * назад не отменяется). Иначе — ссылка и состояние, и переход вперёд: открыт → «Ревью» из «К работе» и «В работе»,
 * смёржен → «Готово» из любого статуса, закрыт без мёржа — только состояние.
 */
export function prPatch(task: Pick<TeamTask, 'status' | 'pr'>, seen: TeamPr): TeamTaskPatch | undefined {
  if (task.pr && task.pr.url === seen.url && task.pr.state === seen.state) return undefined;
  const patch: TeamTaskPatch = { pr: { url: seen.url, state: seen.state } };
  if (seen.state === 'open' && forward(task.status, 'review')) patch.status = 'review';
  if (seen.state === 'merged' && forward(task.status, 'done')) patch.status = 'done';
  return patch;
}

/** Задачи, по которым опрашиваются PR: «В работе» и «Ревью» с веткой; смёрженный PR дальше не меняется. */
export const watched = (t: TeamTask): boolean => !t.error && Boolean(t.branch) && (t.status === 'in_progress' || t.status === 'review') && t.pr?.state !== 'merged';

/** Номер PR или MR из ссылки: …/pull/42, …/pulls/42, …/-/merge_requests/7. */
export function prNumber(url: string): number | undefined {
  const m = url.match(/\/(?:pulls?|merge_requests)\/(\d+)(?:[/?#]|$)/);
  return m ? Number(m[1]) : undefined;
}

/** Ссылка на PR ведёт в этот remote: тот же хост, путь начинается с пути репо (…/acme/billing/pull/42, …/g/app/-/merge_requests/7). */
export function prBelongsTo(remote: Remote, url: string): boolean {
  const r = parseRemote(url);
  return Boolean(r && r.host === remote.host && (r.path === remote.path || r.path.startsWith(`${remote.path}/`)));
}

/**
 * Состояние одного PR по ссылке: в списке открытых его уже нет, и нужно понять, смёржен он или закрыт. Разбор ответа gh
 * и glab — в общем наблюдателе MR (things/forge.ts → mrLifecycle): state closed с merged_at — merged, state merged |
 * closed | opened у GitLab. Ссылка без номера — undefined.
 */
export async function fetchPrState(remote: Remote, url: string, x: Exec = exec): Promise<TeamPr['state'] | undefined> {
  const n = prNumber(url);
  if (!n) return undefined;
  return mrLifecycle({ host: remote.host, project: remote.path, number: n }, x);
}

// ---------- сервис

/** Что автоматике нужно от сервиса команды: тесты подставляют задачи в памяти, сервер — statusService(teamService()). */
export type StatusService = {
  /** Слаги команд на этом компьютере. */
  teams(): string[];
  projects(team: string): string[];
  /** Репо кода проекта из project.yaml. */
  repos(team: string, project: string): { key: string; url: string }[];
  /** Мой email по git config клона; нет — undefined. */
  me(team: string): Promise<string | undefined>;
  tasks(team: string, project: string): TeamTask[];
  /** Нет задачи — TeamError 404. */
  task(team: string, project: string, id: string): TeamTask;
  updateTask(team: string, project: string, id: string, patch: TeamTaskPatch): Promise<TeamTask>;
  recordWork(team: string, taskId: string, work: TeamTaskWork): void;
  /**
   * Номер задачи, у которой в local.json → work записан этот запуск или сессия: после переименования совпавшего номера
   * (spec §5.7) работа переезжает на новый, а запуск помнит старый (D-14). Нет записи — undefined.
   */
  workTask?(team: string, work: Pick<TeamTaskWork, 'kind' | 'id'>): string | undefined;
};

/** Адаптер настоящего сервиса команды. Список команд и репо проекта читаются с диска без git: опрос идёт по таймеру. */
export function statusService(svc: TeamService): StatusService {
  return {
    teams: () => TeamRepo.list(svc.root()),
    projects: (team) => svc.repo(team).dirs('projects'),
    repos: (team, project) => {
      const text = svc.repo(team).read(`projects/${project}/project.yaml`);
      return text === undefined ? [] : parseProject(text, project).repos.map((r) => ({ key: r.key, url: r.url }));
    },
    me: async (team) => (await svc.repo(team).identity()).email,
    tasks: (team, project) => svc.tasks(team, project),
    task: (team, project, id) => svc.task(team, project, id),
    updateTask: (team, project, id, patch) => svc.updateTask(team, project, id, patch),
    recordWork: (team, id, work) => svc.recordWork(team, id, work),
    workTask: (team, work) => svc.workTask(team, work),
  };
}

export type TeamworkStatusDeps = {
  service: StatusService;
  /** gh и glab; по умолчанию exec из git.ts. Тесты подставляют поддельный. */
  exec?: Exec;
  /** Опрос PR по таймеру; false — только явный poll() (тесты). */
  timers?: boolean;
  intervalMs?: number;
  now?: () => Date;
  /** Куда писать о сбоях опроса и записи; по умолчанию console.error. */
  log?: (line: string) => void;
};

/** Итог одного опроса PR: сколько задач смотрели, сколько запросов к gh/glab ушло, какие задачи изменились, ошибки. */
export type PollReport = { tasks: number; requests: number; changed: string[]; errors: string[] };

/** Автоматика статусов одного сервера: старт и конец работы по задаче, опрос PR по таймеру. */
export class TeamworkStatus {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<PollReport> | null = null;
  /** Последняя ошибка по remote: повтор той же в лог не пишется, чтобы опрос раз в 2 минуты не засорял его. */
  private readonly lastErrors = new Map<string, string>();
  /** Идущие записи старта по задаче: конец очень короткого запуска ждёт их, иначе «Ревью» не наступит. */
  private readonly starting = new Map<string, Promise<void>>();
  /** Все идущие записи старта и конца: stop() дожидается их до остановки сервиса команды. */
  private readonly writes = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly deps: TeamworkStatusDeps) {}

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.error(l)))(`teamwork: ${line}`);
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  /** Задача по связи — до старта запуска или сессии: нет команды, проекта или задачи — TeamError 404, битая — 400. */
  check(link: RunTeamworkLink): TeamTask | undefined {
    if (!link.task) return undefined;
    const task = this.deps.service.task(link.team, link.project, link.task);
    if (task.error) throw new TeamError(400, `Задача ${task.id} не читается (${task.error}): поправь файл ${task.file} руками`);
    return task;
  }

  /**
   * Запуск или сессия начаты из задачи (spec §10, строка 1): запись в local.json → work, «К работе» → «В работе»,
   * исполнитель — я, если пусто. Не бросает: запуск уже идёт, сбой записи — в лог.
   */
  async started(link: RunTeamworkLink, work: Omit<TeamTaskWork, 'at'> & { at?: string }): Promise<void> {
    if (!link.task) return;
    const key = `${link.team}/${link.task}`;
    // запись в local.json — сразу, а не в цепочке за прошлым стартом той же задачи (тот может ждать очередь клона): по ней
    // инструменты сессии находят задачу (D-14)
    let recorded = true;
    try {
      this.deps.service.recordWork(link.team, link.task, { ...work, at: work.at ?? this.now() });
    } catch (err) {
      recorded = false;
      this.log(`${link.task}: старт работы не записан — ${errMsg(err)}`);
    }
    const prev = this.starting.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      if (!recorded) return;
      try {
        const task = this.deps.service.task(link.team, link.project, link.task!);
        const patch = startPatch(task, await this.deps.service.me(link.team));
        if (patch) await this.deps.service.updateTask(link.team, link.project, link.task!, patch);
      } catch (err) {
        this.log(`${link.task}: старт работы не записан — ${errMsg(err)}`);
      }
    });
    this.starting.set(key, run);
    this.writes.add(run);
    await run;
    this.writes.delete(run);
    if (this.starting.get(key) === run) this.starting.delete(key);
  }

  /**
   * Запуск или сессия по задаче закончились: статус — в local.json → work; запуск done — «В работе» → «Ревью». Упал или
   * остановлен — без перехода, значок на карточке по work. Задача — та, у которой этот запуск записан в work: если мою
   * неотправленную задачу переименовали из-за совпавшего номера, run.json помнит старый номер, а он теперь у чужой
   * задачи (D-14). Не бросает.
   */
  async ended(link: RunTeamworkLink, work: Omit<TeamTaskWork, 'at'> & { at?: string }): Promise<void> {
    if (!link.task) return;
    const run = (async () => {
      // старт той же задачи ещё пишется (запуск кончился за секунды): сначала он, иначе done не даст «Ревью»
      await this.starting.get(`${link.team}/${link.task}`);
      let id = link.task!;
      try {
        if (this.deps.service.workTask) {
          const found = this.deps.service.workTask(link.team, work);
          // записи нет нигде — задачу удалили (работа забыта) или старт не записался: номер из связи мог уже достаться
          // чужой задаче, её не трогаем
          if (!found) return this.log(`${link.task}: конец работы не записан — запуска ${work.id} нет в работе задач`);
          id = found;
        }
        this.deps.service.recordWork(link.team, id, { ...work, at: work.at ?? this.now() });
        if (work.kind !== 'run' || !work.status) return;
        const patch = runEndPatch(this.deps.service.task(link.team, link.project, id), work.status);
        if (patch) await this.deps.service.updateTask(link.team, link.project, id, patch);
      } catch (err) {
        this.log(`${id}: конец работы не записан — ${errMsg(err)}`);
      }
    })();
    this.writes.add(run);
    await run;
    this.writes.delete(run);
  }

  /** Опрос PR сейчас; идущий опрос не дублируется — возвращается его итог. */
  poll(): Promise<PollReport> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<PollReport> {
    const report: PollReport = { tasks: 0, requests: 0, changed: [], errors: [] };
    const svc = this.deps.service;
    const x = this.deps.exec ?? exec;
    // открытые PR по remote: один запрос на remote за опрос, даже если по нему задачи в нескольких проектах и командах
    const open = new Map<string, Promise<MergeRequest[]>>();
    const fail = (key: string, msg: string) => {
      report.errors.push(`${key}: ${msg}`);
      if (this.lastErrors.get(key) !== msg) {
        this.lastErrors.set(key, msg);
        this.log(`опрос PR ${key}: ${msg}`);
      }
    };
    for (const team of svc.teams()) {
      let projects: string[];
      try {
        projects = svc.projects(team);
      } catch (err) {
        fail(team, errMsg(err));
        continue;
      }
      for (const project of projects) {
        let tasks: TeamTask[];
        let repos: { key: string; url: string }[];
        try {
          tasks = svc.tasks(team, project).filter(watched);
          if (!tasks.length) continue;
          repos = svc.repos(team, project);
        } catch (err) {
          fail(`${team}/${project}`, errMsg(err));
          continue;
        }
        for (const task of tasks) {
          if (this.stopped) return report;
          report.tasks++;
          // репо задачи; у проекта с одним репо — оно. Ссылка без хоста (путь, file://) — PR негде искать
          const repo = task.repo ? repos.find((r) => r.key === task.repo) : repos.length === 1 ? repos[0] : undefined;
          const remote = repo && parseRemote(repo.url);
          if (!remote) continue;
          const key = `${remote.host}/${remote.path}`;
          let mrs: MergeRequest[];
          try {
            if (!open.has(key)) {
              report.requests++;
              open.set(key, listMergeRequests(remote, {}, x));
            }
            mrs = await open.get(key)!;
          } catch (err) {
            fail(key, errMsg(err));
            continue;
          }
          this.lastErrors.delete(key);
          const mr = mrs.find((m) => m.sourceBranch === task.branch);
          let seen: TeamPr | undefined;
          if (mr) seen = { url: mr.url, state: 'open' };
          else if (task.pr?.state === 'open') {
            // открытым он был, а в списке открытых его нет: смёржен или закрыт — точный запрос по номеру. Ссылка,
            // записанная рукой и ведущая в другой репозиторий, по этому remote не спрашивается: чужой PR не двигает задачу
            if (!prBelongsTo(remote, task.pr.url)) {
              fail(`${task.id} ${task.pr.url}`, `ссылка на PR ведёт не в репо ${key}`);
              continue;
            }
            try {
              report.requests++;
              const state = await fetchPrState(remote, task.pr.url, x);
              if (state) seen = { url: task.pr.url, state };
            } catch (err) {
              fail(`${key} ${task.pr.url}`, errMsg(err));
              continue;
            }
          }
          if (!seen) continue;
          const patch = prPatch(task, seen);
          if (!patch) continue;
          try {
            await svc.updateTask(team, project, task.id, patch);
            report.changed.push(task.id);
          } catch (err) {
            fail(task.id, errMsg(err));
          }
        }
      }
    }
    return report;
  }

  /** Опрос по таймеру; с timers: false — ничего. */
  start(): void {
    this.stopped = false;
    if (this.deps.timers === false || this.timer) return;
    this.timer = setInterval(() => void this.poll().catch((err: unknown) => this.log(`опрос PR: ${errMsg(err)}`)), this.deps.intervalMs ?? PR_POLL_MS);
    this.timer.unref();
  }

  /**
   * Снять таймер и дождаться идущего опроса и записей старта и конца: сервис команды останавливается после них. Ждём не
   * дольше waitMs: запись опроса стоит в очереди клона за fetch без сети (до 2 минут), а выход из приложения не должен
   * висеть на ней (D-16). Опрос после stop() дальше по задачам не идёт; недописанное автоматика повторит при следующем
   * запуске (PR увидится снова).
   */
  async stop(waitMs = 5_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    const all = Promise.all([this.polling?.catch(() => undefined), ...[...this.writes].map((w) => w.catch(() => undefined))]);
    await Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref())]);
  }
}

let status: TeamworkStatus | undefined;

/** Автоматика процесса: одна на сервер, создаётся при первом обращении с зависимостями этого обращения. */
export function teamworkStatus(deps?: TeamworkStatusDeps): TeamworkStatus {
  if (!status) {
    if (!deps) throw new Error('teamworkStatus: автоматика статусов ещё не создана');
    status = new TeamworkStatus(deps);
  }
  return status;
}

/** Автоматика, если она создана и не снята остановкой сервера: конец опоздавшего запуска не должен ронять процесс. */
export const currentTeamworkStatus = (): TeamworkStatus | undefined => status;

/** Остановить автоматику (stopServer): таймер снимается, идущий опрос дожидается не дольше нескольких секунд (D-16). */
export async function stopTeamworkStatus(): Promise<void> {
  const s = status;
  status = undefined;
  await s?.stop();
}
