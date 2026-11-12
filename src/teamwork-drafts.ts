// Teamwork: черновики агентов (spec §8.4, §8.5, §9.2–9.3). Черновик — обычный локальный запуск flow команды
// (teamwork-prd, teamwork-architecture, teamwork-split из flows/ репо команды): текущие документы проекта кладутся в
// initial артефактов, анкета входа заполняется по именам полей (wave1-flows.md), текст людей идёт агенту только внутри
// source-data, ссылка { team, project, draft, section, brief, docs } — в run.json. Чтение черновика — снимок flow.yaml
// запуска (initial артефакта = база) и файлы его artifacts/; принятие — writeDoc с base или разделом (409 conflict) и
// createTasks одним коммитом после checkDependencies ядра. Маршруты …/drafts* — в teamwork-server.ts, запуски даёт server.ts.
import fs from 'node:fs';
import path from 'node:path';
import { readRunFlow, RUN_ID_RE } from './adhoc.js';
import { ARTIFACTS_DIR, declaredArtifacts } from './artifacts.js';
import { checkCalls } from './flows.js';
import { hasPlaceholders, wrapData } from './intake.js';
import type { FlowSpec } from './schema.js';
import { TeamError } from './teamwork-repo.js';
import type { TeamService } from './teamwork-server.js';
import { checkDependencies, docLabel, findSection, nextRequirementId, parseProject, replaceSection, sectionHash, splitSections, TASK_TYPES, TEAM_SLUG_RE, textHash } from './teamwork.js';
import type {
  RunReport, RunSummary, RunTeamworkLink, TeamDoc, TeamDraft, TeamDraftAccepted, TeamDraftDetail, TeamDraftDoc, TeamDraftDocName, TeamDraftExisting, TeamDraftKind,
  TeamDraftNote, TeamDraftStart, TeamProject, TeamProposedTask, TeamTaskType,
} from './api-types.js';

/** Опции запуска черновика для startRun сервера: разовый (flow не в flows/, его копия — снимок в папке запуска) со ссылкой на черновик. */
export type DraftRunOptions = { cwd: string; addDirs: string[]; model?: string; maxBudgetUsd?: number; adhoc: true; teamwork: RunTeamworkLink };

/** Запуски глазами сервера (server.ts): старт через startRun, список, отчёт run.json и статус запуска, идущего в этом сервере. */
export type DraftRunDeps = {
  runsDir: string;
  start: (spec: FlowSpec, o: DraftRunOptions) => string;
  runs: () => RunSummary[];
  report: (id: string) => RunReport | undefined;
  /** Статус идущего в этом сервере запуска (running | waiting | paused); не идёт здесь — undefined. */
  live: (id: string) => string | undefined;
};

/** Что нужно черновикам от сервиса команды. */
export type DraftService = Pick<TeamService, 'repo' | 'project' | 'doc' | 'readTeamFlow' | 'tasks' | 'writeDoc' | 'createTasks'>;

/** Flow команды по виду черновика (spec §9.1). */
export const DRAFT_FLOWS: Record<TeamDraftKind, string> = { prd: 'teamwork-prd', architecture: 'teamwork-architecture', split: 'teamwork-split' };
const DRAFT_KINDS: readonly TeamDraftKind[] = ['prd', 'architecture', 'split'];
const DOC_NAMES: readonly TeamDraftDocName[] = ['prd', 'architecture', 'design'];
type What = NonNullable<TeamDraftStart['what']>;
const WHATS: readonly What[] = ['architecture', 'design', 'both'];
/** Строка «Что писать» анкеты teamwork-architecture. */
const WHAT_LABEL: Record<What, string> = { architecture: 'архитектура', design: 'дизайн', both: 'оба' };
/** Задание по умолчанию, если автор ничего не написал (комментарии в flow шаблона). */
const DEFAULT_BRIEF: Record<TeamDraftKind, string> = { prd: 'Написать ТЗ по коду', architecture: 'Написать по ТЗ', split: 'Разбить всё ТЗ' };
/** Анкета по умолчанию, если команда переписала input своего flow без плейсхолдеров: те же строки, что во flow шаблона. */
const DEFAULT_INPUT: Record<TeamDraftKind, string> = {
  prd: 'Проект: <…>\nСуть проекта: <…>\nЧто сделать: <…>\nРаздел: <…>\nНовые номера: <…>\nПапка проекта: <…>',
  architecture: 'Проект: <…>\nСуть проекта: <…>\nЧто сделать: <…>\nЧто писать: <…>\nРаздел: <…>\nПапка проекта: <…>',
  split: 'Проект: <…>\nСуть проекта: <…>\nЧто сделать: <…>\nРепо кода: <…>\nПапка проекта: <…>\nСуществующие задачи: <…>',
};
const TASKS_HEADER = 'Существующие задачи (номер · заголовок · тип · статус · исполнитель · требования · ждёт)';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
function bad(msg: string): never {
  throw new TeamError(400, msg);
}
const optStr = (v: unknown, field: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') bad(`Поле ${field} — строка`);
  return (v as string).trim() || undefined;
};
/** Одной строкой: идентификаторы снаружи source-data не должны ломать анкету переводом строки. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();
/** Текст документа заканчивается переводом строки, как его пишет writeDoc: иначе дифф покажет лишнюю правку в конце. */
const ensureNl = (s: string): string => (s && !s.endsWith('\n') ? `${s}\n` : s);
const isDir = (d: string): boolean => Boolean(fs.statSync(d, { throwIfNoEntry: false })?.isDirectory());

// ---------- анкета входа (wave1-flows.md)

/** Значение строки анкеты: inline — на месте; data — блок source-data с новой строки (текст людей); list — список с новой строки. */
export type FormValue = { inline: string } | { data: string } | { list: string[] };

/**
 * Заполняет анкету `Поле: <…>` по именам полей (без учёта регистра); labels — чем заменить имя поля в заполненной строке.
 * Строки с неизвестным полем остаются как есть, как у composeInput: команда могла добавить во flow свои строки.
 */
export function fillForm(template: string, values: Record<string, FormValue>, labels: Record<string, string> = {}): string {
  const byName = new Map(Object.entries(values).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const label = new Map(Object.entries(labels).map(([k, v]) => [k.trim().toLowerCase(), v]));
  return template
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*)([^:<>]+?)(\s*:\s*)<[^<>\n]*>\s*$/);
      if (!m) return line;
      const name = m[2].trim().toLowerCase();
      const v = byName.get(name);
      if (!v) return line;
      const head = `${m[1]}${label.get(name) ?? m[2].trim()}:`;
      if ('inline' in v) return `${head} ${v.inline}`;
      if ('data' in v) return `${head}\n${wrapData(v.data)}`;
      return `${head}\n${v.list.map((x) => `- ${x}`).join('\n')}`;
    })
    .join('\n')
    .trim();
}

// ---------- артефакты черновика

/** Задачи из tasks.json (spec §9.1): JSON-текст или уже разобранный объект. error — файл не по схеме, задач нет. */
export function parseProposedTasks(input: unknown): { tasks: TeamProposedTask[]; error?: string } {
  const fail = (error: string) => ({ tasks: [], error });
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (err) {
      return fail(`tasks.json не разбирается: ${errMsg(err)}`);
    }
  }
  if (!isRecord(raw) || !Array.isArray(raw.tasks)) return fail('tasks.json: ожидается объект { "tasks": [ … ] }');
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : []);
  const tasks: TeamProposedTask[] = [];
  for (const [i, item] of (raw.tasks as unknown[]).entries()) {
    const at = `задача ${i + 1}`;
    if (!isRecord(item)) return fail(`${at}: не объект`);
    const key = typeof item.key === 'string' && item.key.trim() ? item.key.trim() : `t${i + 1}`;
    const title = typeof item.title === 'string' ? oneLine(item.title) : '';
    if (!title) return fail(`${at} (${key}): нет title`);
    const type = item.type === undefined ? 'feature' : item.type;
    if (!TASK_TYPES.includes(type as TeamTaskType)) return fail(`${at} (${key}): type — ${TASK_TYPES.join(' | ')}`);
    if (item.acceptance !== undefined && !Array.isArray(item.acceptance)) return fail(`${at} (${key}): acceptance — список строк`);
    if (item.dependsOn !== undefined && !Array.isArray(item.dependsOn)) return fail(`${at} (${key}): dependsOn — список ключей или номеров`);
    const estimate = item.estimate === undefined || item.estimate === null ? undefined : item.estimate;
    if (estimate !== undefined && (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0)) return fail(`${at} (${key}): estimate — число очков`);
    const repo = typeof item.repo === 'string' && item.repo.trim() ? item.repo.trim() : undefined;
    tasks.push({
      key,
      title,
      type: type as TeamTaskType,
      description: typeof item.description === 'string' ? item.description.trim() : '',
      acceptance: strList(item.acceptance),
      ...(estimate !== undefined ? { estimate: estimate as number } : {}),
      ...(repo ? { repo } : {}),
      dependsOn: strList(item.dependsOn),
      covers: strList(item.covers),
    });
  }
  return { tasks };
}

/** Записи notes.json: массив { at, why, doc? }; битый файл или не массив — предупреждение и пусто, чужие записи пропускаются. */
export function parseNotes(text: string, warnings: string[] = []): TeamDraftNote[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    warnings.push(`notes.json не разбирается: ${errMsg(err)}`);
    return [];
  }
  if (!Array.isArray(raw)) {
    warnings.push('notes.json: ожидается массив записей { "at", "why" }');
    return [];
  }
  const out: TeamDraftNote[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.at !== 'string' || typeof item.why !== 'string' || !item.at.trim() || !item.why.trim()) continue;
    out.push({ at: item.at.trim(), why: item.why.trim(), ...(typeof item.doc === 'string' && item.doc.trim() ? { doc: item.doc.trim() } : {}) });
  }
  return out;
}

// ---------- режим «только раздел» (spec §8.4)

const sectionLabel = (heading: string): string => heading || 'начало документа';

/**
 * Заголовки разделов, которые в b отличаются от a, не считая раздела heading: изменённые, добавленные и убранные (сравнение
 * как мультимножеств «заголовок + текст», порядок разделов не важен). Не считается только первый раздел с таким заголовком —
 * тот, что правят findSection, replaceSection и writeDoc; второй такой же — обычный раздел вне правки. Пустой заголовок —
 * «начало документа».
 */
export function sectionsChangedOutside(a: string, b: string, heading: string): string[] {
  const h = heading.trim();
  const norm = (md: string) => {
    let skipped = false;
    return splitSections(md)
      .filter((s) => {
        if (skipped || s.heading !== h) return true;
        skipped = true;
        return false;
      })
      .map((s) => ({ heading: s.heading, key: `${s.heading}\n${s.text.trimEnd()}` }));
  };
  const left = new Map<string, number>();
  for (const s of norm(a)) left.set(s.key, (left.get(s.key) ?? 0) + 1);
  const out = new Set<string>();
  for (const s of norm(b)) {
    const n = left.get(s.key) ?? 0;
    if (n > 0) left.set(s.key, n - 1);
    else out.add(sectionLabel(s.heading));
  }
  for (const s of norm(a)) if ((left.get(s.key) ?? 0) > 0) out.add(sectionLabel(s.heading));
  return [...out];
}

/**
 * Текст агента в режиме раздела: base с разделом heading из next; правки вне раздела отброшены (их заголовки — dropped).
 * Раздела нет в ответе агента или в базе — текст остаётся base (missing).
 */
export function restrictToSection(base: string, next: string, heading: string): { text: string; dropped: string[]; missing: boolean } {
  const dropped = sectionsChangedOutside(base, next, heading);
  const sec = findSection(next, heading);
  const was = findSection(base, heading);
  if (!sec || !was) return { text: base, dropped, missing: true };
  // раздел не менялся — база байт в байт, а не её пересборка replaceSection
  return { text: sectionHash(sec.text) === sectionHash(was.text) ? base : replaceSection(base, heading, sec.text), dropped, missing: false };
}

// ---------- черновики

type Start = { kind: TeamDraftKind; brief: string; section?: string; what: What; model?: string; cwd?: string; maxBudgetUsd?: number };

/** Тело POST …/drafts; раздел без «## » в начале. */
function parseStart(body: unknown): Start {
  if (!isRecord(body)) bad('Тело запроса — объект');
  const b = body as Record<string, unknown>;
  const kind = b.kind as TeamDraftKind;
  if (!DRAFT_KINDS.includes(kind)) bad(`Поле kind: ${DRAFT_KINDS.join(' | ')}`);
  const brief = optStr(b.brief, 'brief') ?? DEFAULT_BRIEF[kind];
  const section = optStr(b.section, 'section')?.replace(/^#+\s*/, '').replace(/[ \t]+#+$/, '').trim() || undefined;
  if (section && kind === 'split') bad('У разбивки нет раздела');
  const what = (optStr(b.what, 'what') ?? 'both') as What;
  if (kind === 'architecture' && !WHATS.includes(what)) bad(`Поле what: ${WHATS.join(' | ')}`);
  if (kind === 'architecture' && section && what === 'both') bad('С разделом — один документ: what architecture или design');
  const budget = b.maxBudgetUsd === undefined || b.maxBudgetUsd === null || b.maxBudgetUsd === '' ? undefined : Number(b.maxBudgetUsd);
  if (budget !== undefined && !Number.isFinite(budget)) bad('Поле maxBudgetUsd — число');
  return { kind, brief, ...(section ? { section } : {}), what: kind === 'architecture' ? what : 'both', model: optStr(b.model, 'model'), cwd: optStr(b.cwd, 'cwd'), ...(budget !== undefined ? { maxBudgetUsd: budget } : {}) };
}

/** Документы, которые правит черновик: ссылка в run.json и вкладки UI. */
function draftDocs(kind: TeamDraftKind, what: What): TeamDraftDocName[] {
  if (kind === 'prd') return ['prd'];
  if (kind === 'split') return [];
  return what === 'both' ? ['architecture', 'design'] : [what];
}

/** Черновики агентов по проекту: старт, список, чтение и принятие. Один на сервер, живёт рядом с TeamService. */
export class TeamDrafts {
  constructor(
    private readonly service: DraftService,
    private readonly deps: DraftRunDeps,
  ) {}

  /** Проект есть; иначе 404. Без project(): он ищет локальные папки репо, а список и черновик опрашиваются часто. */
  private requireProject(team: string, slug: string): void {
    if (!TEAM_SLUG_RE.test(slug) || !this.service.repo(team).exists(`projects/${slug}/project.yaml`)) throw new TeamError(404, `Проекта ${slug} нет`);
  }

  /** Документ проекта или undefined, если его нет (удалили руками): база черновика тогда пустая. */
  private async readDoc(team: string, slug: string, name: TeamDraftDocName): Promise<TeamDoc | undefined> {
    try {
      return await this.service.doc(team, slug, name);
    } catch (err) {
      if (err instanceof TeamError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Отчёт запуска-черновика этого проекта; чужой или не черновик — 404. */
  private draftReport(team: string, slug: string, run: string): { report: RunReport; link: RunTeamworkLink & { draft: TeamDraftKind } } {
    const report = RUN_ID_RE.test(run) ? this.deps.report(run) : undefined;
    const link = report?.teamwork;
    if (!report || !link?.draft || link.team !== team || link.project !== slug) throw new TeamError(404, `Черновика ${run} нет в проекте ${slug}`);
    return { report, link: link as RunTeamworkLink & { draft: TeamDraftKind } };
  }

  private item(run: string, status: string, flow: string, startedAt: string, finishedAt: string | undefined, link: RunTeamworkLink & { draft: TeamDraftKind }): TeamDraft {
    return {
      run,
      kind: link.draft,
      flow,
      status,
      startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      ...(link.section !== undefined ? { section: link.section } : {}),
      ...(link.brief ? { brief: link.brief } : {}),
      ...(link.docs?.length ? { docs: link.docs } : {}),
    };
  }

  /** Черновики проекта, от новых к старым (runs() уже так отсортирован). */
  list(team: string, slug: string): TeamDraft[] {
    this.requireProject(team, slug);
    return this.deps
      .runs()
      .filter((r) => r.teamwork?.draft && r.teamwork.team === team && r.teamwork.project === slug)
      .map((r) => this.item(r.id, r.status, r.flow, r.startedAt, r.finishedAt, r.teamwork as RunTeamworkLink & { draft: TeamDraftKind }));
  }

  /**
   * Запуск черновика (spec §9.2): flow команды проверяется как любой, текущие документы — в initial артефактов, папка
   * запуска — локальная папка основного репо кода проекта (или cwd из тела; без репо кода — папка проекта в клоне),
   * папка проекта и остальные репо — доп. папками; текст людей — только в source-data.
   */
  async start(team: string, slug: string, body: unknown): Promise<TeamDraft> {
    const b = parseStart(body);
    const project = await this.service.project(team, slug);
    const flow = this.service.readTeamFlow(team, DRAFT_FLOWS[b.kind]);
    const spec = structuredClone(flow.spec);
    // блоки-вызовы других flow — как у разового запуска: ошибка на старте, а не первым шагом
    try {
      checkCalls(spec);
    } catch (err) {
      bad(`Flow ${spec.name}: ${errMsg(err)}`);
    }
    const docs = draftDocs(b.kind, b.what);
    for (const key of [...docs, ...(b.kind === 'split' ? ['tasks'] : ['notes'])]) if (!spec.artifacts?.[key]) bad(`Flow ${spec.name} должен объявлять артефакт ${key}`);
    // текущие документы — в initial одноимённых артефактов (и те, что агенту не просили менять: он их читает)
    const texts: Partial<Record<TeamDraftDocName, TeamDoc | undefined>> = {};
    for (const name of DOC_NAMES) {
      if (!spec.artifacts?.[name]) continue;
      texts[name] = await this.readDoc(team, slug, name);
      spec.artifacts[name].initial = texts[name]?.text ?? '';
    }
    if (b.section !== undefined) {
      const target = docs[0];
      if (!texts[target] || !findSection(texts[target]!.text, b.section)) throw new TeamError(404, `Раздела «${b.section}» нет в документе «${docLabel(target)}»`);
    }
    const dirs = this.dirs(project, b.cwd);
    spec.input = this.input(spec, b, project, texts, dirs.roles, b.kind === 'split' ? this.service.tasks(team, slug) : [], this.nextRequirement(team, slug, texts.prd));
    const link: RunTeamworkLink = { team, project: slug, draft: b.kind, ...(b.section !== undefined ? { section: b.section } : {}), brief: b.brief, ...(docs.length ? { docs } : {}) };
    const run = this.deps.start(spec, {
      cwd: dirs.cwd,
      addDirs: dirs.addDirs,
      ...(b.model ? { model: b.model } : {}),
      ...(b.maxBudgetUsd !== undefined ? { maxBudgetUsd: b.maxBudgetUsd } : {}),
      adhoc: true,
      teamwork: link,
    });
    return this.item(run, 'running', spec.name, this.deps.report(run)?.startedAt ?? new Date().toISOString(), undefined, link as RunTeamworkLink & { draft: TeamDraftKind });
  }

  /** Следующие свободные FR-N и NFR-N: из документа, а без prd.md — по выданным раньше (project.yaml → lastRequirement), чтобы номера не вернулись. */
  private nextRequirement(team: string, slug: string, prd: TeamDoc | undefined): { FR: string; NFR: string } {
    if (prd?.nextRequirement) return prd.nextRequirement;
    const cfg = parseProject(this.service.repo(team).read(`projects/${slug}/project.yaml`) ?? '', slug);
    return { FR: nextRequirementId('', 'FR', cfg.lastRequirement), NFR: nextRequirementId('', 'NFR', cfg.lastRequirement) };
  }

  /** Папка запуска, доп. папки и роль каждого репо кода для строки «Репо кода». */
  private dirs(project: TeamProject, cwdOverride?: string): { cwd: string; addDirs: string[]; roles: string[] } {
    const [main] = project.repos;
    let cwd: string;
    if (cwdOverride) {
      cwd = path.resolve(cwdOverride);
      if (!isDir(cwd)) bad(`Директория не найдена: ${cwd}`);
    } else if (main) {
      if (!main.local) bad(`Папка репо кода ${main.key} на этом компьютере неизвестна: укажи её в настройках команды (PUT /api/teams/:t/local → repoPaths) или передай cwd`);
      cwd = path.resolve(main.local);
      if (!isDir(cwd)) bad(`Папка репо кода ${main.key} не найдена: ${cwd}`);
    } else cwd = project.dir;
    const extra = (r: TeamProject['repos'][number]): string | undefined => (r.local && path.resolve(r.local) !== cwd && isDir(r.local) ? path.resolve(r.local) : undefined);
    const addDirs = [...new Set([project.dir, ...project.repos.map(extra).filter((d): d is string => Boolean(d))].filter((d) => d !== cwd))];
    // поля project.yaml пишут люди и они идут вне source-data: только одной строкой
    const roles = project.repos.map((r) => {
      const role = (r.local && path.resolve(r.local) === cwd) || (r === main && !main.local) ? 'рабочая папка запуска' : extra(r) ? 'дополнительная папка' : 'локально нет';
      return `${oneLine(r.key)} — ${oneLine(r.url)}, ветка ${oneLine(r.defaultBranch ?? '') || 'main'}, ${role}`;
    });
    return { cwd, addDirs, roles };
  }

  /**
   * Вход запуска по анкете flow: наши значения на месте, текст людей — блоками source-data. Команда переписала input без
   * плейсхолдеров — её текст остаётся сверху, анкета шаблона под ним: без неё агенту нечего читать.
   */
  private input(spec: FlowSpec, b: Start, project: TeamProject, texts: Partial<Record<TeamDraftDocName, TeamDoc | undefined>>, roles: string[], tasks: ReturnType<DraftService['tasks']>, nextRequirement: { FR: string; NFR: string }): string {
    const own = spec.input?.trim() ?? '';
    const template = hasPlaceholders(spec.input) ? spec.input! : [own, DEFAULT_INPUT[b.kind]].filter(Boolean).join('\n\n');
    const values: Record<string, FormValue> = {
      Проект: { inline: `${project.slug} · «${oneLine(project.title) || project.slug}»` },
      'Суть проекта': { data: project.summary.trim() || '(пусто)' },
      'Что сделать': { data: b.brief },
      Раздел: { inline: b.section !== undefined ? `## ${b.section}` : 'весь документ' },
      'Папка проекта': { inline: project.dir },
    };
    if (b.kind === 'prd') values['Новые номера'] = { inline: `${nextRequirement.FR}, ${nextRequirement.NFR}` };
    if (b.kind === 'architecture') values['Что писать'] = { inline: WHAT_LABEL[b.what] };
    if (b.kind === 'split') {
      values['Репо кода'] = roles.length ? { list: roles } : { inline: '(репо кода не указаны)' };
      const lines = tasks.filter((t) => !t.error).map((t) => `- ${t.id} · ${oneLine(t.title)} · ${t.type} · ${t.status} · ${t.assignee ?? '—'} · ${t.covers.join(', ') || '—'} · ${t.blockedBy.join(', ') || '—'}`);
      values['Существующие задачи'] = { data: lines.join('\n') || '(задач ещё нет)' };
    }
    return fillForm(template, values, { 'Существующие задачи': TASKS_HEADER });
  }

  /** Черновик с текстами (spec §9.3): база — initial артефакта из снимка flow запуска, текст агента — файл в artifacts/. */
  async draft(team: string, slug: string, run: string): Promise<TeamDraftDetail> {
    this.requireProject(team, slug);
    const { report, link } = this.draftReport(team, slug, run);
    const base = this.item(run, this.deps.live(run) ?? report.status, report.flow, report.startedAt, report.finishedAt, link);
    let spec: FlowSpec;
    try {
      spec = readRunFlow(this.deps.runsDir, run);
    } catch (err) {
      return { ...base, error: `Снимок flow запуска не читается: ${errMsg(err)}` };
    }
    const declared = declaredArtifacts(spec);
    const runDir = path.join(this.deps.runsDir, run);
    // text undefined — агент (или хранилище) файл ещё не записал: показываем базу
    const artifact = (key: string): { initial: string; text?: string } | undefined => {
      const a = declared.find((x) => x.key === key);
      if (!a) return undefined;
      let text: string | undefined;
      try {
        text = fs.readFileSync(path.join(runDir, ARTIFACTS_DIR, a.file), 'utf8');
      } catch {
        text = undefined;
      }
      return { initial: a.initial ?? '', ...(text !== undefined ? { text } : {}) };
    };
    const warnings: string[] = [];
    if (link.draft === 'split') {
      const a = artifact('tasks');
      const parsed = a?.text === undefined ? { tasks: [] as TeamProposedTask[] } : parseProposedTasks(a.text);
      const existing: TeamDraftExisting[] = this.service
        .tasks(team, slug)
        .filter((t) => !t.error)
        .map((t) => ({ id: t.id, status: t.status, title: t.title, ...(t.assignee ? { assignee: t.assignee } : {}), ...(t.sprint !== undefined ? { sprint: t.sprint } : {}), ...(t.estimate !== undefined ? { estimate: t.estimate } : {}) }));
      return { ...base, tasks: parsed.tasks, report: checkDependencies(parsed.tasks, existing), existing, ...(parsed.error ? { error: parsed.error } : {}) };
    }
    const notesArtifact = artifact('notes');
    const notes = notesArtifact?.text === undefined ? [] : parseNotes(notesArtifact.text, warnings);
    const documents: TeamDraftDoc[] = [];
    for (const name of link.docs ?? []) {
      const a = artifact(name);
      if (!a) {
        warnings.push(`В flow запуска нет артефакта ${name}`);
        continue;
      }
      const current = (await this.readDoc(team, slug, name))?.text ?? '';
      let next = a.text === undefined ? a.initial : ensureNl(a.text);
      let dropped: string[] = [];
      if (link.section !== undefined) {
        const r = restrictToSection(a.initial, next, link.section);
        next = r.text;
        dropped = r.dropped;
        if (r.missing && a.text !== undefined) warnings.push(`Раздел «${link.section}» в ответе агента для документа «${docLabel(name)}» не найден: правки не приняты`);
      }
      documents.push({
        name,
        base: a.initial,
        baseHash: textHash(a.initial),
        next,
        changed: next !== a.initial,
        current,
        currentHash: textHash(current),
        moved: current !== a.initial,
        ...(dropped.length ? { dropped } : {}),
      });
    }
    return { ...base, documents, notes, ...(warnings.length ? { warnings } : {}) };
  }

  /** Принятие черновика (spec §9.3): документ — writeDoc с base или разделом; разбивка — createTasks одним коммитом. */
  async accept(team: string, slug: string, run: string, body: unknown): Promise<TeamDraftAccepted> {
    this.requireProject(team, slug);
    const { report, link } = this.draftReport(team, slug, run);
    // агент ещё пишет артефакты (или ждёт ответа): принимать нечего
    if (['running', 'waiting', 'paused'].includes(this.deps.live(run) ?? report.status)) throw new TeamError(409, 'Черновик ещё идёт: дождись конца запуска', 'busy');
    if (!isRecord(body)) bad('Тело запроса — объект');
    const b = body as Record<string, unknown>;
    if (link.draft === 'split') {
      if (!('tasks' in b)) bad('Это черновик разбивки: пришли tasks');
      return this.acceptTasks(team, slug, b.tasks);
    }
    if ('tasks' in b) bad('Это черновик документа: пришли text и base');
    return this.acceptDoc(team, slug, run, link, b);
  }

  private async acceptDoc(team: string, slug: string, run: string, link: RunTeamworkLink & { draft: TeamDraftKind }, b: Record<string, unknown>): Promise<TeamDoc> {
    const docs = link.docs ?? [];
    const doc = optStr(b.doc, 'doc');
    const name = (doc ?? (docs.length === 1 ? docs[0] : bad('Укажи doc: какой документ принимать'))) as TeamDraftDocName;
    if (!docs.includes(name)) bad(`Черновик не правил документ ${name}`);
    if (typeof b.text !== 'string') bad('Поле text — строка');
    const text = b.text as string;
    const base = optStr(b.base, 'base');
    let spec: FlowSpec;
    try {
      spec = readRunFlow(this.deps.runsDir, run);
    } catch (err) {
      bad(`Снимок flow запуска не читается: ${errMsg(err)}`);
    }
    const art = declaredArtifacts(spec!).find((a) => a.key === name);
    if (!art) bad(`В flow запуска нет артефакта ${name}`);
    const baseText = art!.initial ?? '';
    const baseHash = textHash(baseText);
    const label = docLabel(name);
    const message = optStr(b.message, 'message') ?? `${slug}: ${label} — принят черновик агента${link.section !== undefined ? `, раздел «${link.section}»` : ''}`;
    const current = await this.readDoc(team, slug, name);
    if (link.section === undefined) {
      // документа больше нет: принять можно только черновик с пустой базы, он создаст документ
      if (!current) {
        if ((base ?? baseHash) !== textHash('')) throw new TeamError(409, `Документа «${label}» больше нет в репо`, 'conflict');
        return this.service.writeDoc(team, slug, name, text, { message });
      }
      return this.service.writeDoc(team, slug, name, text, { base: base ?? baseHash, message });
    }
    // режим раздела: относительно чего смотрим правки вне раздела — база черновика или, после ручного разрешения
    // конфликтов, текущий документ
    const currentText = current?.text ?? '';
    const against = !base || base === baseHash ? baseText : base === textHash(currentText) ? currentText : undefined;
    if (against === undefined) throw new TeamError(409, 'Документ уже изменил кто-то другой', 'conflict', { current });
    const outside = sectionsChangedOutside(against, text, link.section);
    if (outside.length) bad(`Черновик только для раздела «${link.section}»: правки в ${outside.map((h) => `«${h}»`).join(', ')} не принимаются`);
    const sec = findSection(text, link.section);
    if (!sec) bad(`В тексте нет раздела «${link.section}»`);
    const was = findSection(against, link.section);
    if (!was) throw new TeamError(404, `Раздела «${link.section}» нет в документе «${label}»`);
    return this.service.writeDoc(team, slug, name, sec!.text, { section: link.section, hash: sectionHash(was.text), message });
  }

  /** Разбивка в бэклог: проверка ссылок и циклов (400 с report), задачи одним коммитом, dependsOn → blockedBy с номерами. */
  private async acceptTasks(team: string, slug: string, raw: unknown): Promise<{ tasks: Awaited<ReturnType<DraftService['createTasks']>> }> {
    const parsed = parseProposedTasks({ tasks: raw });
    if (parsed.error) bad(parsed.error);
    if (!parsed.tasks.length) bad('Нужна хотя бы одна задача');
    const existing = this.service.tasks(team, slug).filter((t) => !t.error);
    const report = checkDependencies(parsed.tasks, existing);
    if (report.errors.length) {
      const text = report.cycle ? `цикл ${report.cycle.join(' → ')}` : report.errors.map((e) => `${e.key}: ${e.error}`).join('; ');
      throw new TeamError(400, `Зависимости с ошибками: ${text}`, 'dependencies', { report });
    }
    const tasks = await this.service.createTasks(
      team,
      slug,
      parsed.tasks.map((t) => ({
        key: t.key,
        title: t.title,
        type: t.type,
        description: t.description,
        acceptance: t.acceptance,
        ...(t.estimate !== undefined ? { estimate: t.estimate } : {}),
        ...(t.repo ? { repo: t.repo } : {}),
        dependsOn: t.dependsOn,
        covers: t.covers,
      })),
    );
    return { tasks };
  }
}
