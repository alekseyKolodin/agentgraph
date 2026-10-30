// Раннер: блоки по очереди; в блоке итерации -> этапы (каждый = свежая сессия) -> проверка условия остановки.
// Ход выполнения отдаётся через события (onEvent), чтобы одинаково работать из CLI и из UI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { stringify as toYaml } from 'yaml';
import type { RunSource } from './intake.js';
import type {
  BlockNext, BlockReport, ConditionReport, DigestSession, FinalPhase, NextCheck, PauseReason, PhaseFiles, PhaseReport, QuestionRecord, RunDigest, RunEvent, RunFixVia,
  RunFlowEdit, RunNote, RunParent, RunReport, RunStatus, RunWorktree, TagSummaryReport,
} from './api-types.js';
import { flowBlocks, isCallBlock, NEXT_END, phaseSteps, type Block, type FlowSpec, type NextRule, type Phase, type PhaseStep, type Until } from './schema.js';
import { emptyContext, render, type TemplateContext } from './template.js';
import { randomUUID } from 'node:crypto';
import { runSession, type AskAnswers, type EffortLevel, type AskQuestion, type SessionRequest, type SessionResult, type SessionTokens } from './agent.js';
import { ATTACHMENTS_DIR } from './attachments.js';
import { replyIn, taskLang } from './lang.js';
import {
  artifactAccess,
  declaredArtifacts,
  hasArtifacts,
  mappedKeys,
  inlineKeys,
  type ArtifactLite,
  type ArtifactsReport,
  type Denial,
  type PhaseArtifacts,
  type StepArtifacts,
  type StepDelta,
} from './artifacts.js';
import { ArtifactStore, countDenial, type PauseAnswer, type StepRef } from './artifact-store.js';
import { knowledgeBlock, knowledgeDirs, queueTagSummary, readTag, resolveKnowledge, writeTagSummary, type KnowledgeTag } from './tags.js';
import { dropRunPaths, parseTagSummary, tagSummaryPromptFile, tagSummaryRequest } from './tag-summary.js';
import type { AutoTagReport } from './auto-tag.js';
import type { RunTitleReport } from './run-title.js';
import { feedbackKey, type DigestInput, type DigestReport } from './run-digest.js';
import { ARTIFACT_TOOLS_ALLOW, ARTIFACT_TOOLS_ENABLED, ARTIFACT_TOOLS_SERVER, artifactToolsServer } from './artifact-tools.js';
import { KNOWLEDGE_TOOLS_ALLOW, KNOWLEDGE_TOOLS_SERVER, knowledgeToolsServer } from './knowledge-tools.js';
import { flowChanges, flowEditProblems, keepBlockName, RESTART_DETAIL, RunFixError } from './run-fix.js';
import { bypassedBlocks, callInput, callOutcome, pickNext } from './compose.js';
import { checkCalls, loadCalledFlow } from './flows.js';

export type RunOptions = {
  /** Рабочая директория агентов (репозиторий, над которым работаем). */
  cwd: string;
  /** Куда складывать логи запусков (если runDir не задан). */
  runsDir: string;
  /** Готовая директория запуска; создаётся через makeRunDir. */
  runDir?: string;
  maxIterations?: number;
  maxBudgetUsd?: number;
  model?: string;
  abort?: AbortController;
  /** Пауза: раннер ждёт checkpoint() перед каждым этапом и проверкой условия. */
  control?: RunControl;
  onEvent?: (event: RunEvent) => void;
  /** Как отвечать на вопросы агента. Без обработчика вопросы отклоняются. */
  onQuestion?: (q: QuestionRecord, signal: AbortSignal) => Promise<AskAnswers>;
  /** Продолжение завершённого запуска: блоки, пройденные в нём целиком, не повторяются. */
  continueFrom?: Continuation;
  /** Откуда запуск: задача Jira, MR или ветка с главной. Раннер только сохраняет в отчёт. */
  source?: RunSource;
  /** Запуск идёт в git worktree (cwd = path). Раннер только сохраняет в отчёт. */
  worktree?: RunWorktree;
  /** Шов для тестов: чем запускать сессии этапов и судьи. По умолчанию runSession. */
  session?: typeof runSession;
  /** Доп. директории на весь запуск: добавляются к add_dirs каждого этапа. */
  addDirs?: string[];
  /** Вложения к задаче: пути относительно runDir (attachments/<имя>). Файлы уже лежат на диске. */
  attachments?: string[];
  /** Продолжение: артефакты берутся копией текущих файлов этого запуска (по ключу). */
  artifactsFrom?: { runId: string; runDir: string };
  /** Разовый запуск: flow не сохранён в flows/, единственная его копия — снимок flow.yaml в папке запуска. */
  adhoc?: boolean;
  /**
   * Хранилище артефактов создано и заполнено — до события start. Только у flow с артефактами; через него сервер
   * правит артефакты идущего запуска. Единственный путь создания хранилища у живого запуска.
   */
  onArtifactStore?: (store: ArtifactStore) => void;
  /** Теги задачи (слаги): саммари фичи между запусками, см. tags.ts. Теги уже заведены, их блоки уже во вводе. */
  tags?: string[];
  /** Обновить саммари тегов после запуска со статусом done; по умолчанию — да. */
  saveTag?: boolean;
  /**
   * Папки только для чтения из тегов: пути тегов и артефакты их прошлых запусков (на них ссылается саммари). Идут в
   * additionalDirectories этапов и судьи, но не в addDirs запуска: при продолжении сервер пересчитывает их заново.
   */
  tagDirs?: string[];
  /** Модель сессии саммари тега; по умолчанию haiku. */
  tagSummaryModel?: string;
  /** Теги области знаний (слаги) на весь запуск: их раздел получает каждый блок вместе со своим knowledge из flow. */
  knowledge?: string[];
  /** Итог автотега (auto-tag.ts): тег уже заведён и стоит в tags или ошибка подбора; стоимость входит в totalCostUsd. */
  autoTag?: AutoTagReport;
  /**
   * Подбор имени запуска (run-title.ts): стартует после start и идёт параллельно этапам, раннер ждёт его только перед
   * концом. Не бросает; signal прерывается остановкой запуска. Без опции имени нет и ключей title/titleSession тоже.
   */
  nameRun?: (input: string, signal: AbortSignal) => Promise<RunTitleReport>;
  /** Готовое имя (продолжение берёт имя исходного запуска): в отчёте сразу, nameRun не зовётся. */
  title?: string;
  /**
   * Итоги для человека (run-digest.ts): после каждой проверки условия и каждого блока без цикла — итог итерации
   * (ConditionReport.summary) и сводка запуска (report.digest). Идут в фоне по одному, раннер ждёт их только перед
   * концом. Не бросает; signal прерывается остановкой запуска. Без опции нет ни итогов, ни ключей digest/digestSession.
   */
  digest?: (input: DigestInput, signal: AbortSignal) => Promise<DigestReport>;
  /** Правка запуска на паузе (RunFix): раннер отдаёт её до первой контрольной точки. Без опции править запуск нечем. */
  onFix?: (fix: RunFix) => void;
  /**
   * Дочерний запуск блока-вызова (flow: X). Раннер готовит его опции — папку, задачу, бюджет, родителя, abort; как
   * запускать, решает вызвавший: сервер регистрирует живой запуск, CLI печатает его с отступом. По умолчанию — runFlow.
   */
  runChild?: (spec: FlowSpec, opts: RunOptions) => Promise<RunReport>;
  /** Вызываемый flow по имени; по умолчанию — из flows/ (loadCalledFlow). Шов для тестов. */
  loadFlow?: (name: string) => FlowSpec;
  /** Запуск вызван блоком-вызовом другого запуска: в отчёт. */
  parent?: RunParent;
};

export type { RunWorktree } from './api-types.js';

/**
 * Что новый запуск берёт у прошлого при продолжении (continuationFrom). Только сплошное начало
 * блоков, завершённых done: их этапы не повторяются, выводы подставляются в {{phases.*}}, {{prev}}
 * и {{history}}. Блок, на котором прошлый запуск остановился, идёт с первой итерации и без своих
 * старых выводов: в них могут быть устаревшие указания вроде «ждать ответа пользователя».
 */
export type Continuation = {
  runId: string;
  skipBlocks: string[];
  /** Последний вывод каждого этапа пропускаемых блоков. */
  phases: Record<string, string>;
  /** Последний вывод последнего пропускаемого блока — как {{prev}} при обычном переходе между блоками. */
  prev: string;
  history: string[];
  /** Блоки, через которые развилка перешла в прошлом запуске: не выполняются и в этом. */
  bypassBlocks?: string[];
  /** Решения развилок пропускаемых блоков из прошлых запусков: в отчёт этого, чтобы следующее продолжение их не перерешало. */
  decided?: Record<string, BlockNext>;
  /**
   * Последний пропускаемый блок с next, чья развилка в прошлом запуске так и не решилась (остановили во время её
   * проверки): раннер решает её по выводам этого блока, прежде чем идти дальше.
   */
  branchFrom?: string;
  /**
   * Блок-вызов, на котором прошлый запуск остановился: его первая итерация берёт артефакты последнего дочернего запуска
   * (from), а если тот можно продолжить — продолжает его (cont — продолжение, spec — его flow), а не начинает заново.
   */
  calls?: Record<string, { from: { runId: string; runDir: string }; cont?: Continuation; spec?: FlowSpec }>;
};

/**
 * Управление паузой извне (UI). Пауза мягкая: текущая сессия доигрывает,
 * а следующий шаг ждёт, пока checkpoint() не отпустит. Остановка должна отпускать ждущий checkpoint.
 */
export type RunControl = {
  /** Вызывается перед каждым шагом; на паузе резолвится только после продолжения или остановки. */
  checkpoint: () => Promise<void>;
  /** Пауза по просьбе агента (loop.pause_marker): ближайший checkpoint() встанет. Причина уже лежит в report.pauseReason. */
  requestPause?: () => void;
  /**
   * Указания пользователя, ждущие шага: раннер забирает их в начале каждого шага (этапа или группы) и судьи и дописывает
   * хвостом в промпт. Отдать надо все ждущие; next больше не отдавать, run — отдавать и дальше. Где применено, пишет раннер.
   */
  takeNotes?: () => RunNote[];
};

/**
 * «Починить и продолжить» (run-fix.ts): правка идущего запуска, пока раннер стоит в контрольной точке на паузе
 * (control.checkpoint ещё не отпустил). Вне паузы и неподходящая правка — RunFixError, запуск при этом не меняется.
 * Никогда не посреди параллельной группы: контрольные точки только между шагами.
 */
export type RunFix = {
  /** Что мешает перейти на next; пусто — можно. */
  checkFlow: (next: FlowSpec) => string[];
  /** Перейти на next: следующие шаги идут по нему, снимок flow.yaml переписан, прошлый — flow.N.yaml. Без изменений — ничего не пишет. */
  applyFlow: (next: FlowSpec, o: { source: RunFlowEdit['source']; via: RunFixVia; savedToFlows?: boolean; saveError?: string }) => RunFlowEdit;
  /**
   * Повторить итерацию идущего блока: остаток её шагов отбрасывается, дальше идёт итерация N+1, лимит блока +1 (и у блока
   * без цикла). note дописывается в {{feedback}} новой итерации; хвостом в промпт его кладёт тот, кто зовёт (указание next).
   */
  restart: (o?: { note?: string }) => { block: string; iteration: number };
};

export type { QuestionRecord } from './api-types.js';
export type {
  BlockReport, BlockStatus, ConditionReport, DigestSession, FinalPhase, PauseReason, PhaseFiles, PhaseReport, RunEvent, RunReport, TagSummaryReport,
} from './api-types.js';

// interrupted раннер не пишет: так сервер показывает running-запуск, чей процесс умер, не дописав run.json
export type { RunStatus } from './api-types.js';

export type { RunDigest } from './api-types.js';

export type { RunFixVia, RunFlowEdit, RunNote } from './api-types.js';

const HISTORY_ENTRY_MAX = 6000;
const FEEDBACK_MAX = 6000;
/** Граница в замечаниях непройденной команды: до неё — команда и код выхода, после — хвост вывода (анализ flow ищет пустой). */
export const COMMAND_OUTPUT_HEAD = 'Вывод (хвост):\n';
/** Как в LoopSchema.max_iterations. */
const MAX_ITERATIONS_LIMIT = 50;
/** Шаг проверки условия в applied указаний (судья), как ключ карточки условия в UI. */
const COND_STEP = '#cond';

export async function runFlow(spec: FlowSpec, opts: RunOptions): Promise<RunReport> {
  const namer = new RunNamer();
  const digester = new RunDigester();
  try {
    return await runFlowBody(spec, opts, namer, digester);
  } finally {
    // после выхода (в том числе исключением) поздний ответ подбора имени или итога ни run.json, ни событий не трогает
    namer.close();
    digester.close();
  }
}

/**
 * Подбор имени параллельно этапам. Колбэк пишет в тот же объект report и сохраняет его тем же save(), поэтому гонок
 * с раннером нет; перед концом раннер ждёт подбор (settle), чтобы имя попало в end и CLI не вышел раньше записи.
 */
class RunNamer {
  private closed = false;
  private pending?: Promise<void>;
  private readonly abort = new AbortController();

  start(report: RunReport, opts: RunOptions, save: () => void, emit: (e: RunEvent) => void): void {
    if (report.title || !opts.nameRun) return;
    const stop = () => this.abort.abort();
    opts.abort?.signal.addEventListener('abort', stop, { once: true });
    if (opts.abort?.signal.aborted) stop();
    const apply = (r: RunTitleReport) => {
      if (this.closed) return;
      if (r.title) report.title = r.title;
      report.titleSession = { costUsd: r.costUsd, ...(r.tokens ? { tokens: r.tokens } : {}), ...(r.error ? { error: r.error } : {}) };
      report.totalCostUsd += r.costUsd;
      save();
      emit({ type: 'title', ...(r.title ? { title: r.title } : {}), ...(r.error ? { error: r.error } : {}), totalCostUsd: report.totalCostUsd });
    };
    let call: Promise<RunTitleReport>;
    try {
      call = opts.nameRun(report.input, this.abort.signal);
    } catch (err) {
      call = Promise.reject(err);
    }
    this.pending = call
      .catch((err): RunTitleReport => ({ error: err instanceof Error ? err.message : String(err), costUsd: 0 }))
      .then(apply)
      // сбой записи или подписчика событий не должен ронять запуск из колбэка
      .catch(() => {})
      .finally(() => opts.abort?.signal.removeEventListener('abort', stop));
  }

  /** Дождаться подбора: он ограничен таймаутом и остановкой запуска и не бросает. */
  async settle(): Promise<void> {
    await this.pending;
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
  }
}

/** Что пересказать и куда записать: cond — отчёт проверки (у блока без цикла нет), file — его condition.json. */
type DigestJob = { input: Omit<DigestInput, 'prev'>; block: string; iteration: number; cond?: ConditionReport; file?: string };

/**
 * Итоги параллельно этапам, по одному вызову за раз: пока идёт вызов, ждёт только самый свежий запрос (промежуточные
 * остаются без итога — их показывает сырой текст). Прошлая сводка берётся в момент вызова, поэтому цепочка не рвётся.
 * Колбэк пишет в тот же report тем же save(), как RunNamer; перед концом раннер ждёт очередь (settle).
 */
class RunDigester {
  private closed = false;
  private busy = false;
  private queued?: DigestJob;
  private pending?: Promise<void>;
  private readonly abort = new AbortController();
  private ctx?: { report: RunReport; opts: RunOptions; save: () => void; emit: (e: RunEvent) => void };

  start(report: RunReport, opts: RunOptions, save: () => void, emit: (e: RunEvent) => void): void {
    if (!opts.digest) return;
    this.ctx = { report, opts, save, emit };
    const stop = () => this.abort.abort();
    if (opts.abort?.signal.aborted) stop();
    else opts.abort?.signal.addEventListener('abort', stop, { once: true });
  }

  get enabled(): boolean {
    return Boolean(this.ctx) && !this.closed;
  }

  /**
   * Провал с теми же замечаниями, что у прошлой итерации блока, у которой итог уже есть: итог тот же, модель не зовём.
   * Так «буксующий» цикл из 50 итераций стоит как один вызов. true — итог проставлен.
   */
  reuse(cond: ConditionReport): boolean {
    if (!this.enabled || cond.done || !cond.feedback.trim()) return false;
    const r = this.ctx!.report;
    const prev = r.conditions.find((c) => c.block === cond.block && c.iteration === cond.iteration - 1);
    if (!prev?.summary || prev.done || feedbackKey(prev.feedback) !== feedbackKey(cond.feedback)) return false;
    cond.summary = prev.summary;
    (r.digestSession ??= emptyDigestSession()).reused++;
    return true;
  }

  push(job: DigestJob): void {
    if (!this.enabled) return;
    if (this.busy) {
      this.queued = job;
      return;
    }
    this.busy = true;
    this.pending = this.drain(job);
  }

  private async drain(first: DigestJob): Promise<void> {
    let job: DigestJob | undefined = first;
    while (job && !this.closed) {
      await this.one(job);
      job = this.queued;
      this.queued = undefined;
    }
    this.busy = false;
  }

  private async one(job: DigestJob): Promise<void> {
    if (this.abort.signal.aborted) return;
    const { report, opts } = this.ctx!;
    let r: DigestReport;
    try {
      r = await opts.digest!({ ...job.input, ...(report.digest ? { prev: report.digest.text } : {}) }, this.abort.signal);
    } catch (err) {
      r = { error: err instanceof Error ? err.message : String(err), costUsd: 0 };
    }
    // остановка — не сбой итога: пустой ответ после неё не считаем
    if (this.abort.signal.aborted && !r.costUsd && !r.iteration && !r.run) return;
    try {
      this.apply(job, r);
    } catch {
      // сбой записи или подписчика событий не должен ронять запуск из фона
    }
  }

  private apply(job: DigestJob, r: DigestReport): void {
    if (this.closed) return;
    const { report, save, emit } = this.ctx!;
    const ds = (report.digestSession ??= emptyDigestSession());
    ds.calls++;
    ds.costUsd += r.costUsd;
    report.totalCostUsd += r.costUsd;
    if (r.error) {
      ds.failed++;
      ds.error = r.error;
    }
    const summary = job.cond && r.iteration ? r.iteration : undefined;
    if (summary) {
      job.cond!.summary = summary;
      if (job.file) fs.writeFileSync(job.file, JSON.stringify(job.cond, null, 2));
    }
    if (r.run) report.digest = { text: r.run, block: job.block, iteration: job.iteration, at: new Date().toISOString() };
    save();
    emit({
      type: 'digest', block: job.block, iteration: job.iteration,
      ...(summary ? { summary } : {}), ...(r.run ? { digest: report.digest } : {}), totalCostUsd: report.totalCostUsd,
    });
  }

  /** Дождаться очереди: каждый вызов ограничен таймаутом и остановкой запуска и не бросает. */
  async settle(): Promise<void> {
    await this.pending;
  }

  close(): void {
    this.closed = true;
    this.queued = undefined;
    this.abort.abort();
  }
}

const emptyDigestSession = (): DigestSession => ({ calls: 0, costUsd: 0, failed: 0, reused: 0 });

async function runFlowBody(spec: FlowSpec, opts: RunOptions, namer: RunNamer, digester: RunDigester): Promise<RunReport> {
  const runDir = opts.runDir ?? makeRunDir(opts.runsDir, spec.name);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'flow.yaml'), toYaml(spec, { lineWidth: 0 }));
  const emit = opts.onEvent ?? (() => {});

  // spec и blocks подменяет правка flow на паузе (fix.applyFlow): все шаги после неё читают новые
  let blocks = flowBlocks(spec);
  // Один блок пишет логи как раньше (iter-NN/…), несколько — в NN-<блок>/iter-NN/…. Правка раскладку не меняет (run-fix.ts).
  const multi = blocks.length > 1;
  const cont = opts.continueFrom;
  const blockReports: BlockReport[] = blocks.map((b, i) => {
    const skipped = Boolean(cont?.skipBlocks.includes(b.name));
    // через этот блок развилка перешла в прошлом запуске: он не выполнялся и здесь не выполняется
    const bypassed = Boolean(cont?.bypassBlocks?.includes(b.name));
    return {
      index: i,
      name: b.name,
      title: b.title ?? b.name,
      status: skipped && !bypassed ? 'done' : 'pending',
      iterations: 0,
      maxIterations: skipped ? 0 : blockMaxIterations(b, opts),
      condition: b.loop?.until.type ?? 'none',
      looped: Boolean(b.loop),
      onFail: b.on_fail ?? 'stop',
      ...(skipped ? { skipped: true } : {}),
      ...(bypassed ? { bypassed: true } : {}),
      ...(cont?.decided?.[b.name] ? { next: cont.decided[b.name] } : {}),
    };
  });
  const report: RunReport = {
    id: path.basename(runDir),
    flow: spec.name,
    description: spec.description,
    input: spec.input ?? '',
    cwd: opts.cwd,
    status: 'running',
    iterations: 0,
    maxIterations: blockReports.reduce((n, b) => n + b.maxIterations, 0),
    // подбор автотега прошёл до старта, но это тоже сессия запуска: его стоимость — в итоге и под --max-budget
    totalCostUsd: opts.autoTag?.costUsd ?? 0,
    blocks: blockReports,
    phases: [],
    conditions: [],
    questions: [],
    runDir,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    ...(cont ? { continuedFrom: cont.runId } : {}),
    ...(opts.adhoc ? { adhoc: true as const } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.worktree ? { worktree: opts.worktree } : {}),
    ...(opts.addDirs?.length ? { addDirs: opts.addDirs } : {}),
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    ...(opts.tags?.length ? { tags: opts.tags, saveTag: opts.saveTag !== false } : {}),
    ...(opts.knowledge?.length ? { knowledge: opts.knowledge } : {}),
    ...(opts.autoTag ? { autoTag: opts.autoTag } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.parent ? { parent: opts.parent } : {}),
  };
  // абсолютные пути вложений считаются от runDir, а из CLI он в opts не приходит
  const runOpts: RunOptions = { ...opts, runDir };
  // теги знаний блоков считаются на старте (и при продолжении заново: тег мог измениться); ошибка — до первого этапа
  let knowledge = new Map<string, KnowledgeTag[]>();
  const save = () => fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(report, null, 2));
  // Хранилище создаётся до start, ошибка его создания делает запуск failed (бросается в try ниже).
  let store: ArtifactStore | undefined;
  let storeError: unknown;
  if (hasArtifacts(spec)) {
    try {
      store = new ArtifactStore({ runDir, declared: declaredArtifacts(spec), report, persist: save, emit, readTool: ARTIFACT_TOOLS_ENABLED });
      store.init(opts.artifactsFrom);
      opts.onArtifactStore?.(store);
    } catch (err) {
      store = undefined;
      storeError = err;
    }
  }
  save();
  emit({ type: 'start', report });
  namer.start(report, opts, save, emit);
  digester.start(report, opts, save, emit);

  const aborted = () => Boolean(opts.abort?.signal.aborted);
  let current: BlockReport | undefined;
  /**
   * Раннер стоит в контрольной точке: только здесь правят flow и повторяют итерацию (fix). open — итерация начата, а её
   * условие ещё не проверено: повтор её обрывает. restarted — на этой паузе итерацию уже перезапустили.
   */
  let stopped: { open: boolean; restarted?: boolean } | null = null;
  /** Повтор итерации, заказанный посреди неё: раннер обрывает её сразу после контрольной точки. */
  let cut = false;
  /** Идёт дочерний запуск блока-вызова: раннер ждёт его, а не стоит в контрольной точке. */
  let calling: { flow: string; runId: string } | undefined;
  /** Граница шага: здесь запуск встаёт на паузу. true — запуск остановлен, дальше не идём. */
  const checkpoint = async (open = false): Promise<boolean> => {
    if (opts.control) {
      stopped = { open };
      try {
        await opts.control.checkpoint();
      } finally {
        stopped = null;
      }
    }
    return aborted();
  };

  /**
   * Указания пользователя к шагу (phases — его этапы, у судьи — '#cond'): где применено — в самом указании и report.notes,
   * событие note на каждое. Возвращает тексты для хвоста промпта.
   */
  const takeNotes = (block: string, iteration: number, phases: string[]): string[] => {
    const got = opts.control?.takeNotes?.() ?? [];
    if (!got.length) return [];
    const at = new Date().toISOString();
    const list = (report.notes ??= []);
    const fresh = phases.map((phase) => ({ block, iteration, phase, at }));
    for (const n of got) {
      (n.applied ??= []).push(...fresh);
      if (!list.some((x) => x.id === n.id)) list.push(n);
    }
    save();
    // в событии — только новые записи applied: указание run применяется к каждому шагу, и лента переигрывания не должна расти квадратично
    for (const n of got) emit({ type: 'note', note: { ...n, applied: fresh } });
    return got.map((n) => n.text);
  };

  // prev, phases.* и history переходят из блока в блок; feedback, outputs и счётчик итераций у каждого блока свои.
  const ctx = emptyContext(spec.input ?? '', 0);
  const history: string[] = [];
  if (cont) {
    Object.assign(ctx.phases, cont.phases);
    ctx.prev = cont.prev;
    history.push(...cont.history);
    ctx.history = history.join('\n\n');
  }

  // --- правка запуска на паузе (run-fix.ts)
  const fixLimit = (b: Block) => blockMaxIterations(b, opts);
  /** Блок, на котором стоит раннер; вне контрольной точки — RunFixError not_paused. */
  const stoppedAt = (): { br: BlockReport; open: boolean; restarted?: boolean } => {
    if (!stopped && calling) {
      throw new RunFixError(`Сейчас идёт вызванный flow ${calling.flow} (запуск ${calling.runId}): правь его на его странице — этот запуск встанет на паузу после него`, 'not_paused');
    }
    if (!stopped || !current) throw new RunFixError('Запуск не на паузе: править flow и повторять итерацию можно только на паузе', 'not_paused');
    return { br: current, ...stopped };
  };
  /** Что мешает перейти на next: совместимость с идущим запуском и то же, что проверяется на старте. */
  const flowProblems = (next: FlowSpec, br: BlockReport): { problems: string[]; known: Map<string, KnowledgeTag[]> } => {
    const problems = flowEditProblems(spec, next, { block: br.index, iterations: br.iterations, limit: fixLimit });
    // пройденным блокам директории, плагины и теги знаний уже не нужны: их пропажа не мешает править будущее
    const ahead = flowBlocks(next).slice(br.index);
    const aheadSpec: FlowSpec = next.blocks ? { ...next, blocks: ahead } : next;
    let known = new Map<string, KnowledgeTag[]>();
    const steps = [
      () => checkAddDirs(ahead, opts.cwd, opts.addDirs),
      () => checkPlugins(ahead, opts.cwd),
      () => { known = resolveKnowledge(aheadSpec, opts.knowledge); },
      // блоки-вызовы правки: flow есть, глубина и циклы — как на старте
      () => checkCalls(aheadSpec, opts.loadFlow ?? loadCalledFlow),
    ];
    for (const step of steps) {
      try {
        step();
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    return { problems, known };
  };
  /**
   * Отчёты блоков под новую версию: пройденные не трогаем; у идущего — заголовок, цикл и лимит, если его поменяли во flow
   * (поднятый руками или повтором остаётся); будущие — заново, с лимитом, поднятым руками, если во flow он тот же.
   */
  const syncBlocks = (br: BlockReport, prev: Block[], restarted: boolean) => {
    const was = new Map(prev.map((b) => [b.name, b]));
    const reports = new Map(blockReports.map((b) => [b.name, b]));
    const limitOf = (b: Block, old?: BlockReport) => {
      const def = was.get(b.name);
      return old && def && fixLimit(def) === fixLimit(b) ? old.maxIterations : fixLimit(b);
    };
    const cur = blocks[br.index];
    // итерацию на этой паузе уже повторили: её номер обещан клиенту, лимит из flow его не отменяет
    const curMax = restarted ? Math.max(limitOf(cur, br), br.iterations + 1) : limitOf(cur, br);
    Object.assign(br, { title: cur.title ?? cur.name, maxIterations: curMax, condition: cur.loop?.until.type ?? 'none', looped: Boolean(cur.loop), onFail: cur.on_fail ?? 'stop' });
    const later = blocks.slice(br.index + 1).map((b, k): BlockReport => ({
      index: br.index + 1 + k,
      name: b.name,
      title: b.title ?? b.name,
      status: 'pending',
      iterations: 0,
      maxIterations: limitOf(b, reports.get(b.name)),
      condition: b.loop?.until.type ?? 'none',
      looped: Boolean(b.loop),
      onFail: b.on_fail ?? 'stop',
    }));
    blockReports.splice(br.index + 1, blockReports.length, ...later);
    report.maxIterations = blockReports.reduce((n, b) => n + b.maxIterations, 0);
  };
  const fix: RunFix = {
    checkFlow: (raw) => {
      const { br } = stoppedAt();
      return flowProblems(keepBlockName(spec, raw), br).problems;
    },
    applyFlow: (raw, o) => {
      const { br, restarted } = stoppedAt();
      const next = keepBlockName(spec, raw);
      const { problems, known } = flowProblems(next, br);
      if (problems.length) throw new RunFixError(`Правка не подходит идущему запуску:\n${problems.join('\n')}`, 'incompatible', problems);
      const changed = flowChanges(spec, next);
      const version = report.flowEdits?.length ?? 0;
      const edit: RunFlowEdit = {
        version, at: new Date().toISOString(), source: o.source, via: o.via, changed,
        ...(o.savedToFlows ? { savedToFlows: true } : {}), ...(o.saveError ? { saveError: o.saveError } : {}),
      };
      // те же этапы — новой версии нет: ни снимка, ни записи в отчёте
      if (!changed.length) return edit;
      edit.version++;
      const snap = path.join(runDir, 'flow.yaml');
      fs.copyFileSync(snap, path.join(runDir, `flow.${version}.yaml`));
      fs.writeFileSync(snap, toYaml(next, { lineWidth: 0 }));
      const prev = blocks;
      spec = next;
      blocks = flowBlocks(next);
      knowledge = known;
      syncBlocks(br, prev, Boolean(restarted));
      (report.flowEdits ??= []).push(edit);
      save();
      emit({ type: 'flow', edit, blocks: blockReports.map((b) => ({ ...b })), maxIterations: report.maxIterations });
      return edit;
    },
    restart: (o = {}) => {
      const at = stoppedAt();
      const { br } = at;
      if (at.restarted) throw new RunFixError('Итерацию уже перезапустили на этой паузе: возобнови запуск', 'restarted');
      if (!br.iterations) throw new RunFixError(`Блок ${br.title} ещё не начал итераций: повторять нечего — дай указание`, 'not_started');
      if (br.maxIterations >= MAX_ITERATIONS_LIMIT) throw new RunFixError(`Лимит итераций блока ${br.title} уже ${MAX_ITERATIONS_LIMIT}: поднять его нельзя`, 'limit');
      const note = o.note?.trim();
      if (note) ctx.feedback = ctx.feedback.trim() ? `${ctx.feedback.trimEnd()}\n\nУказание пользователя: ${note}` : note;
      br.maxIterations++;
      report.maxIterations = blockReports.reduce((n, b) => n + b.maxIterations, 0);
      stopped!.restarted = true;
      if (at.open) cut = true;
      save();
      emit({ type: 'limit', block: br.name, max: br.maxIterations, total: report.maxIterations });
      return { block: br.name, iteration: br.iterations + 1 };
    },
  };
  opts.onFix?.(fix);

  /**
   * Один этап: промпт из снимка контекста, сессия, файлы и отчёт. Контекст не трогает — выводы
   * сливает runBlock после шага, поэтому участники группы могут идти одновременно.
   */
  const runPhase = async (block: Block, phase: Phase, i: number, iter: number, iterRel: string, snap: TemplateContext, art?: PhaseArtifacts, notes?: string[]): Promise<PhaseRun> => {
    if (isCallBlock(block)) return runCall(block, phase, i, iter, iterRel, snap, art, notes);
    const title = phase.title ?? phase.name;
    const group = phase.group ? { group: phase.group } : {};
    const known = knowledge.get(block.name);
    const prompt = renderPhasePrompt(phase, snap, opts.cwd, runOpts, art, known, notes);
    const baseRel = `${iterRel}/${pad(i + 1)}-${phase.name}`;
    const files: PhaseFiles = { prompt: `${baseRel}.prompt.md`, transcript: `${baseRel}.transcript.md`, output: `${baseRel}.output.md` };
    fs.writeFileSync(path.join(runDir, files.prompt), prompt);
    const transcript = fs.createWriteStream(path.join(runDir, files.transcript));
    const log = (line: string) => {
      transcript.write(line + '\n');
      emit({ type: 'log', block: block.name, iteration: iter, phase: phase.name, line });
    };

    const asked = phaseModel(spec, phase, runOpts);
    emit({
      type: 'phase_start', block: block.name, iteration: iter, index: i, phase: phase.name, title, tools: phase.tools, files, ...group,
      ...(asked.model ? { model: asked.model } : {}), ...(asked.effort ? { effort: asked.effort } : {}),
    });
    const onQuestion = opts.onQuestion
      ? async (questions: AskQuestion[], signal: AbortSignal, preface?: string) => {
          const q: QuestionRecord = {
            id: randomUUID(),
            block: block.name,
            iteration: iter,
            phase: phase.name,
            title,
            questions,
            ...(preface ? { preface } : {}),
            askedAt: new Date().toISOString(),
          };
          report.questions.push(q);
          save();
          emit({ type: 'question', question: q });
          const answers = await opts.onQuestion!(q, signal);
          q.answers = answers;
          q.answeredAt = new Date().toISOString();
          save();
          emit({ type: 'answer', question: q });
          log(`? ${questions.map((x) => x.question).join(' | ')}`);
          log(`= ${Object.values(answers).join(' | ')}`);
          return answers;
        }
      : undefined;
    const startedAt = Date.now();
    // у flow с артефактами каждый этап под guard: свои артефакты, папка запусков; отказы считаются в отчёт этапа
    const denials: Denial[] = [];
    const guard = store && art ? { guard: store.guard(phase.tools, art.access, (tool, reason) => countDenial(denials, tool, reason)) } : {};
    let res: SessionResult;
    let thrown: { err: unknown } | undefined;
    try {
      res = await (opts.session ?? runSession)({
        ...buildRequest(spec, phase, prompt, runOpts, art, known),
        onQuestion,
        onModel: (model) => emit({ type: 'phase_model', block: block.name, iteration: iter, phase: phase.name, model }),
        onContext: (c) => emit({ type: 'phase_context', block: block.name, iteration: iter, phase: phase.name, ...c }),
        ...guard,
      }, log);
    } catch (err) {
      // Этап вне группы, упавший исключением, обрывает запуск сразу, как раньше. Участник группы сначала
      // пишет отчёт и phase_end: иначе он висел бы «выполняется», пока доигрывают соседи.
      if (!phase.group) throw err;
      thrown = { err };
      const message = err instanceof Error ? err.message : String(err);
      res = { ok: false, subtype: 'exception', text: message, costUsd: 0, turns: 0, durationMs: Date.now() - startedAt, errors: [message] };
    } finally {
      await new Promise<void>((resolve) => transcript.end(resolve));
    }

    const output = res.structured !== undefined ? JSON.stringify(res.structured, null, 2) : res.text;
    fs.writeFileSync(path.join(runDir, files.output), output);
    const phaseReport: PhaseReport = {
      block: block.name,
      iteration: iter,
      index: i,
      phase: phase.name,
      title,
      tools: phase.tools,
      ...group,
      ok: res.ok,
      subtype: res.subtype,
      costUsd: res.costUsd,
      turns: res.turns,
      durationMs: res.durationMs,
      chars: output.length,
      sessionId: res.sessionId,
      errors: res.errors,
      files,
      ...(store ? { denials } : {}),
      ...((res.model ?? asked.model) ? { model: res.model ?? asked.model } : {}),
      ...(asked.effort ? { effort: asked.effort } : {}),
      ...(res.tokens ? { tokens: res.tokens } : {}),
    };
    report.phases.push(phaseReport);
    report.totalCostUsd += res.costUsd;
    save();
    emit({ type: 'phase_end', report: phaseReport });
    if (thrown) throw thrown.err;
    return { phase, index: i, res, output, files };
  };

  // --- вызов flow (блок-вызов, flow: X) и развилка next (compose.ts)

  /** Последний дочерний запуск каждого блока-вызова: следующая итерация берёт его артефакты, как продолжение. */
  const lastCall = new Map<string, { runId: string; runDir: string }>();

  /**
   * Итерация блока-вызова: дочерний запуск вызванного flow с задачей из input (и указаниями) — как этап: промпт —
   * задача, вывод — итог дочернего, стоимость — его итог. Ошибка загрузки или запуска — этап с ошибкой, как у сессии.
   */
  const runCall = async (block: Block & { flow: string }, phase: Phase, i: number, iter: number, iterRel: string, snap: TemplateContext, art?: PhaseArtifacts, notes?: string[]): Promise<PhaseRun> => {
    const title = phase.title ?? phase.name;
    const baseRel = `${iterRel}/${pad(i + 1)}-${phase.name}`;
    const files: PhaseFiles = { prompt: `${baseRel}.prompt.md`, transcript: `${baseRel}.transcript.md`, output: `${baseRel}.output.md` };
    const task = withNotes(callInput(block, art ? { ...snap, artifacts: art.snapshot } : snap), notes);
    fs.writeFileSync(path.join(runDir, files.prompt), task);
    // транскрипт вызова — его строки хода: пишется по ходу, чтобы файл был и у идущего шага
    fs.writeFileSync(path.join(runDir, files.transcript), '');
    emit({ type: 'phase_start', block: block.name, iteration: iter, index: i, phase: phase.name, title, tools: [], files });
    const log = (line: string) => {
      fs.appendFileSync(path.join(runDir, files.transcript), line + '\n');
      emit({ type: 'log', block: block.name, iteration: iter, phase: phase.name, line });
    };
    const startedAt = Date.now();
    // остановка родителя останавливает и дочерний; дочерний, остановленный сам, родителя не трогает
    const childAbort = new AbortController();
    const stop = () => childAbort.abort();
    if (opts.abort?.signal.aborted) stop();
    else opts.abort?.signal.addEventListener('abort', stop, { once: true });
    let child: RunReport | undefined;
    let childDir: string | undefined;
    let res: SessionResult;
    try {
      // продолжение: первая итерация блока, где прошлый запуск остановился, берёт артефакты его последнего дочернего,
      // а если тот можно продолжить — продолжает его
      const prior = iter === 1 ? cont?.calls?.[block.name] : undefined;
      const resume = prior?.cont && prior.spec ? { cont: prior.cont, spec: prior.spec } : undefined;
      // продолжаемый дочерний идёт со своей прежней задачей; указания, взятые для этого шага, — её хвостом
      const callee: FlowSpec = resume
        ? { ...resume.spec, input: withNotes(resume.spec.input ?? '', notes) }
        : { ...(opts.loadFlow ?? loadCalledFlow)(block.flow), input: task };
      if (resume) fs.writeFileSync(path.join(runDir, files.prompt), callee.input ?? '');
      childDir = makeRunDir(opts.runsDir, callee.name);
      // вложения задачи — и дочернему: те же имена, копия в его папке
      const attachments = opts.attachments ?? [];
      if (attachments.length) fs.cpSync(path.join(runDir, ATTACHMENTS_DIR), path.join(childDir, ATTACHMENTS_DIR), { recursive: true });
      // связь с дочерним — сразу: прервётся этот запуск, пока ждёт его, — продолжение найдёт дочерний по ней
      const br = blockReports.find((b) => b.name === block.name);
      if (br) br.call = { runId: path.basename(childDir), iteration: iter };
      save();
      const before = iter > 1 ? lastCall.get(block.name) : prior?.from;
      const budget = opts.maxBudgetUsd !== undefined ? Math.max(0, opts.maxBudgetUsd - report.totalCostUsd) : undefined;
      const parent: RunParent = { runId: report.id, flow: spec.name, block: block.name, iteration: iter };
      const childOpts: RunOptions = {
        cwd: opts.cwd,
        runsDir: opts.runsDir,
        runDir: childDir,
        ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
        ...(budget !== undefined ? { maxBudgetUsd: budget } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        abort: childAbort,
        ...(opts.onQuestion ? { onQuestion: opts.onQuestion } : {}),
        ...(opts.session ? { session: opts.session } : {}),
        ...(opts.worktree ? { worktree: opts.worktree } : {}),
        ...(opts.addDirs?.length ? { addDirs: opts.addDirs } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(before ? { artifactsFrom: before } : {}),
        ...(resume ? { continueFrom: resume.cont } : {}),
        ...(opts.tagDirs?.length ? { tagDirs: opts.tagDirs } : {}),
        ...(opts.knowledge?.length ? { knowledge: opts.knowledge } : {}),
        ...(report.title ? { title: `${report.title} · ${block.title ?? block.name}` } : {}),
        ...(opts.digest ? { digest: opts.digest } : {}),
        ...(opts.runChild ? { runChild: opts.runChild } : {}),
        ...(opts.loadFlow ? { loadFlow: opts.loadFlow } : {}),
        parent,
      };
      emit({ type: 'call', block: block.name, iteration: iter, phase: phase.name, runId: path.basename(childDir), flow: block.flow });
      log(`↪ вызов flow ${block.flow}: запуск ${path.basename(childDir)}${resume ? `, продолжение ${prior!.from.runId}` : ''}`);
      calling = { flow: block.flow, runId: path.basename(childDir) };
      child = await (opts.runChild ?? runFlow)(callee, childOpts);
      lastCall.set(block.name, { runId: child.id, runDir: child.runDir });
      const done = child;
      res = callOutcome(block.flow, done, (rel) => {
        const f = path.join(done.runDir, rel);
        return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined;
      }, Date.now() - startedAt);
      log(`итог: ${child.status}${child.error ? ` — ${child.error}` : ''}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`ошибка: ${message}`);
      res = { ok: false, subtype: 'exception', text: message, costUsd: child?.totalCostUsd ?? 0, turns: 0, durationMs: Date.now() - startedAt, errors: [message] };
      // дочерний не начался (вложения, загрузка flow): пустая папка без run.json выглядела бы сломанным запуском
      if (!child && childDir && !fs.existsSync(path.join(childDir, 'run.json'))) fs.rmSync(childDir, { recursive: true, force: true });
    } finally {
      calling = undefined;
      opts.abort?.signal.removeEventListener('abort', stop);
    }
    const output = res.text;
    fs.writeFileSync(path.join(runDir, files.output), output);
    const phaseReport: PhaseReport = {
      block: block.name,
      iteration: iter,
      index: i,
      phase: phase.name,
      title,
      tools: [],
      ok: res.ok,
      subtype: res.subtype,
      costUsd: res.costUsd,
      turns: res.turns,
      durationMs: res.durationMs,
      chars: output.length,
      errors: res.errors,
      files,
      ...(child ? { call: { runId: child.id, flow: block.flow, status: child.status } } : {}),
    };
    report.phases.push(phaseReport);
    report.totalCostUsd += res.costUsd;
    save();
    emit({ type: 'phase_end', report: phaseReport });
    return { phase, index: i, res, output, files };
  };

  /**
   * Правило развилки после блока: marker по выводу этапа, command по коду выхода, judge по вердикту — как until.
   * Судья без вердикта — ошибка, а не «нет»: решение развилки окончательное, его не исправит следующая итерация.
   */
  const checkNext = async (block: Block, br: BlockReport, cond: NonNullable<NextRule['if']>, k: number): Promise<NextCheck> => {
    const rel = path.posix.join(multi ? `${pad(br.index + 1)}-${block.name}` : '', `next-${k + 1}`);
    // у блока, пропущенного продолжением (Continuation.branchFrom), своей папки в этом запуске нет
    if (cond.type !== 'marker') fs.mkdirSync(path.join(runDir, path.posix.dirname(rel)), { recursive: true });
    const base = { rule: k, type: cond.type, costUsd: 0 };
    switch (cond.type) {
      case 'marker': {
        const name = cond.phase ?? block.phases[block.phases.length - 1].name;
        const done = endsWithMarker(ctx.phases[name] ?? '', cond.marker);
        return { ...base, done, detail: `маркер ${cond.marker} последней строкой вывода ${name}: ${done ? 'есть' : 'нет'}` };
      }
      case 'command': {
        const r = await runCommand(cond.run, opts.cwd, (cond.timeout_sec ?? 600) * 1000, opts.abort?.signal);
        const logFile = `${rel}.command.log`;
        fs.writeFileSync(path.join(runDir, logFile), r.output);
        return { ...base, done: r.code === 0, detail: `exit ${r.code ?? r.signal ?? '?'}`, logFile };
      }
      case 'judge': {
        const art = store?.forJudge(cond.prompt);
        const req = judgeRequest(spec, cond, render(cond.prompt, art ? { ...ctx, artifacts: art.snapshot } : ctx), runOpts, art, knowledge.get(block.name), ctx.input);
        const logFile = `${rel}.judge.prompt.md`;
        fs.writeFileSync(path.join(runDir, logFile), req.prompt);
        const res = await (opts.session ?? runSession)(req, () => {});
        const verdict = parseVerdict(res);
        if (!verdict) {
          report.totalCostUsd += res.costUsd;
          throw new Error(`Развилка после блока ${block.title ?? block.name}: судья правила ${k + 1} не вернул вердикт (${res.errors.join('; ') || res.subtype}) — продолжи запуск, чтобы решить её заново`);
        }
        return { ...base, done: verdict.done, detail: verdict.reason, costUsd: res.costUsd, logFile };
      }
    }
  };

  /**
   * Куда после блока bi: правила next по порядку (pickNext), без next — следующий блок. Пропущенные блоки помечаются.
   * Остановили во время проверки — 'aborted', и ничего не записано: прерванная проверка не решение, развилку решит
   * продолжение (Continuation.branchFrom).
   */
  const branch = async (bi: number, br: BlockReport): Promise<number | 'aborted'> => {
    const block = blocks[bi];
    if (block.next === undefined) return bi + 1;
    const checks: NextCheck[] = [];
    const stopped = new Error('stopped');
    let choice: Awaited<ReturnType<typeof pickNext>>;
    try {
      choice = await pickNext(blocks, bi, async (cond, k) => {
        let c: NextCheck;
        try {
          c = await checkNext(block, br, cond, k);
        } catch (err) {
          throw aborted() ? stopped : err;
        }
        report.totalCostUsd += c.costUsd;
        if (aborted()) throw stopped;
        checks.push(c);
        return c.done;
      });
    } catch (err) {
      if (err !== stopped) throw err;
      save();
      return 'aborted';
    }
    br.next = { to: choice.to >= blocks.length ? NEXT_END : blocks[choice.to].name, ...(choice.rule !== undefined ? { rule: choice.rule } : {}), checks };
    const skipped = bypassedBlocks(bi, choice.to).map((k) => blockReports[k]);
    for (const skip of skipped) {
      skip.bypassed = true;
      skip.maxIterations = 0;
    }
    report.maxIterations = blockReports.reduce((n, b) => n + b.maxIterations, 0);
    save();
    emit({ type: 'next', block: block.name, next: br.next, total: report.maxIterations });
    for (const skip of skipped) emit({ type: 'block_end', block: skip });
    return choice.to;
  };

  /** Итог итерации (или прохода блока без цикла) в фон: выводы её этапов, вердикт проверки и что будет дальше. */
  const digestIteration = (block: Block, br: BlockReport, iter: number, outs: PhaseOutput[], cond?: ConditionReport, file?: string) => {
    if (!digester.enabled) return;
    const after = blocks[br.index + 1];
    const next = cond && !cond.done
      ? iter < br.maxIterations
        ? `итерация ${iter + 1} из ${br.maxIterations}${cond.feedback.trim() ? ': этапы получат замечания проверки' : ''}`
        : 'лимит итераций блока исчерпан'
      : block.next !== undefined ? 'следующий блок выбирает развилка после блока' : after ? `следующий блок «${after.title ?? after.name}»` : 'запуск завершается';
    const title = (name: string) => block.phases.find((p) => p.name === name)?.title ?? name;
    digester.push({
      input: {
        flow: spec.name,
        task: report.input,
        block: { title: br.title, index: br.index, total: blocks.length, iteration: iter, maxIterations: br.maxIterations, looped: br.looped },
        phases: outs.map((o) => ({ title: title(o.phase), output: o.output })),
        ...(cond ? { condition: { type: cond.type, done: cond.done, ...(cond.detail ? { detail: cond.detail } : {}), feedback: cond.feedback } } : {}),
        next,
      },
      block: block.name,
      iteration: iter,
      ...(cond ? { cond } : {}),
      ...(file ? { file } : {}),
    });
  };

  /** Цикл одного блока: итерации -> шаги (этап или параллельная группа) -> условие. Возвращает итоговый статус блока. */
  const runBlock = async (bi: number, br: BlockReport, blockRel: string): Promise<RunStatus> => {
    ctx.feedback = '';
    ctx.outputs = '';

    // лимит читаем на каждом шаге: его можно поменять во время запуска (setBlockMaxIterations, повтор итерации)
    for (let iter = 1; ; iter++) {
      // Пауза до начала итерации, чтобы на паузе в отчёте не висела пустая итерация. После последней — тоже: на ней
      // можно повторить итерацию или поднять лимит, и блок пойдёт дальше.
      if (await checkpoint()) return 'aborted';
      // лимит могли уменьшить, пока стояли на паузе
      if (iter > br.maxIterations) break;
      // блок берём заново после каждой контрольной точки: на паузе flow могли поправить (fix.applyFlow)
      let block = blocks[bi];
      ctx.iteration = iter;
      ctx.max_iterations = br.maxIterations;
      br.iterations = iter;
      report.iterations++;
      const iterRel = path.posix.join(blockRel, `iter-${pad(iter)}`);
      fs.mkdirSync(path.join(runDir, iterRel), { recursive: true });
      const iterOutputs: string[] = [];
      const iterPhaseOutputs: PhaseOutput[] = [];
      ctx.outputs = '';
      emit({ type: 'iteration', block: block.name, iteration: iter, max: br.maxIterations });

      // Шаги ищутся по именам этапов: после правки flow на паузе следующий — первый, чьи этапы в этой итерации ещё не шли.
      // Номер этапа (index) после правки сдвигается за уже прошедшие: вставленный этап не делит номер с прошедшим,
      // и порядок итерации (итог запуска, history продолжения, карточки) остаётся порядком выполнения.
      const ran = new Set<string>();
      let lastIndex = -1;
      const nextStep = (): PhaseStep | undefined => {
        for (const s of phaseSteps(block)) {
          const left = s.phases.filter(({ phase }) => !ran.has(phase.name));
          if (!left.length) continue;
          const shift = Math.max(0, lastIndex + 1 - Math.min(...left.map((m) => m.index)));
          return { ...s, phases: left.map((m) => ({ ...m, index: m.index + shift })) };
        }
        return undefined;
      };
      let step = nextStep();
      while (step) {
        // Участники группы рендерят промпты из одного снимка: {{prev}} и {{phases.*}} — как до группы.
        // Пока группа идёт, в ctx, history и выводы итерации никто не пишет: всё сливается после шага.
        const snapshot: TemplateContext = { ...ctx, phases: { ...ctx.phases } };
        const members = step.phases;
        // указания — всем участникам шага: группа стартует разом
        const notes = takeNotes(block.name, iter, members.map(({ phase }) => phase.name));
        // Артефакты: prepareStep → beginStep → снимок → синхронная часть runPhase без await между ними,
        // finishStep и endStep — на любом выходе из шага.
        let ref: Extract<StepRef, { kind: 'phases' }> | undefined;
        const arts: PhaseArtifacts[] = [];
        if (store) {
          store.prepareStep();
          ref = { kind: 'phases', block: block.name, iteration: iter, members: members.map(({ phase }) => ({ name: phase.name, access: artifactAccess(phase) })) };
          store.beginStep(ref);
          const texts = store.snapshot(members.flatMap(({ phase }) => [phase.prompt, phase.handoff ?? '']));
          ref.members.forEach((m, k) => {
            const { prompt, handoff } = members[k].phase;
            arts.push({
              dir: store!.dir,
              access: m.access,
              section: store!.section(m.access, mappedKeys([prompt, handoff ?? ''], texts), inlineKeys([prompt, handoff ?? ''], texts)),
              snapshot: texts,
              ...(ARTIFACT_TOOLS_ENABLED ? { sources: store!.sources(m.access) } : {}),
            });
          });
        }
        let settled: PromiseSettledResult<PhaseRun>[];
        try {
          settled = await Promise.allSettled(
            members.map(({ phase, index }, k) => runPhase(block, phase, index, iter, iterRel, snapshot, arts[k], notes)),
          );
        } finally {
          if (store && ref) {
            for (const m of ref.members) m.report = report.phases.find((p) => p.block === block.name && p.iteration === iter && p.phase === m.name);
            store.finishStep(ref);
            store.endStep();
          }
        }
        for (const { phase, index } of members) {
          ran.add(phase.name);
          lastIndex = Math.max(lastIndex, index);
        }
        if (aborted()) return 'aborted';
        // Ошибки разбираем в порядке объявления: запуск получает ошибку первого упавшего участника.
        // Этап, упавший исключением, обрывает запуск как раньше, но только когда соседи дописали отчёты.
        const done: PhaseRun[] = [];
        for (const s of settled) {
          if (s.status === 'rejected') throw s.reason;
          const { phase, res, output } = s.value;
          done.push(s.value);
          // Сессия с ошибкой (API, сон компьютера) отдаёт текст ошибки как вывод. Дальше он ушёл бы
          // следующему этапу под видом результата, и тот принял бы «результатов нет» за «проблем нет».
          if (!res.ok) {
            // дочерний запуск остановили или он упёрся в остаток бюджета — у родителя тот же статус
            if (isCallBlock(block) && (res.subtype === 'aborted' || res.subtype === 'budget_exceeded')) {
              report.error = res.errors.join('; ');
              return res.subtype;
            }
            report.error = `Этап ${phase.name} завершился с ошибкой: ${res.errors.join('; ') || output.trim() || res.subtype}`;
            return 'failed';
          }
          if (!output.trim()) {
            report.error = `Этап ${phase.name} не вернул вывод` + (res.errors.length ? `: ${res.errors.join('; ')}` : '');
            return 'failed';
          }
        }

        const where = multi ? `${block.name} · итерация ${iter}` : `Итерация ${iter}`;
        mergeGroupOutputs(
          { ctx, history, iterOutputs, iterPhaseOutputs },
          done.map(({ phase, index, output, files }) => ({ phase: phase.name, index, output, file: files.output })),
          where,
        );

        if (opts.maxBudgetUsd !== undefined && report.totalCostUsd > opts.maxBudgetUsd) {
          report.error = `Лимит ${opts.maxBudgetUsd.toFixed(2)} превышен: ${report.totalCostUsd.toFixed(2)}`;
          return 'budget_exceeded';
        }

        // Пауза только между шагами и перед условием: у сервера один release, и второй параллельный checkpoint
        // перезаписал бы его — первая ветка группы так и осталась бы ждать. У блока без цикла после последнего шага её нет.
        if (!nextStep() && !block.loop) break;
        if (await checkpoint(true)) return 'aborted';
        block = blocks[bi];
        if (cut) break;
        step = nextStep();
      }

      if (cut) {
        // Повтор по просьбе пользователя: итерация обрывается, вместо проверки условия — запись о перезапуске.
        // Её замечания (с указанием, fix.restart) получает следующая итерация.
        cut = false;
        const cond: ConditionReport = { block: block.name, iteration: iter, type: block.loop?.until.type ?? 'none', done: false, feedback: ctx.feedback, detail: RESTART_DETAIL, costUsd: 0 };
        report.conditions.push(cond);
        fs.writeFileSync(path.join(runDir, iterRel, 'condition.json'), JSON.stringify(cond, null, 2));
        save();
        emit({ type: 'condition', report: cond });
        continue;
      }

      // Блок без цикла — один проход, условие не проверяется.
      if (!block.loop) {
        digestIteration(block, br, iter, iterPhaseOutputs);
        return 'done';
      }

      // проверка условия — тоже шаг: изменения за неё получают автора «условие», судья читает все артефакты
      let cref: Extract<StepRef, { kind: 'condition' }> | undefined;
      let judgeArt: PhaseArtifacts | undefined;
      if (store) {
        store.prepareStep();
        cref = { kind: 'condition', block: block.name, iteration: iter };
        store.beginStep(cref);
        if (block.loop.until.type === 'judge') judgeArt = store.forJudge(block.loop.until.prompt);
      }
      let cond!: ConditionReport;
      try {
        cond = await evaluateUntil(spec, block, ctx, runOpts, runDir, iterRel, emit, judgeArt, knowledge.get(block.name), () => takeNotes(block.name, iter, [COND_STEP]));
      } finally {
        if (store && cref) {
          cref.report = cond;
          store.finishStep(cref);
          store.endStep();
        }
      }
      report.conditions.push(cond);
      report.totalCostUsd += cond.costUsd;
      // повтор прошлого провала получает его итог сразу, остальные — позже, событием digest
      const reused = digester.reuse(cond);
      const condFile = path.join(runDir, iterRel, 'condition.json');
      fs.writeFileSync(condFile, JSON.stringify(cond, null, 2));
      save();
      emit({ type: 'condition', report: cond });
      if (!reused) digestIteration(block, br, iter, iterPhaseOutputs, cond, condFile);

      if (cond.done) return 'done';
      if (aborted()) return 'aborted';
      ctx.feedback = cond.feedback;

      // Агент сказал, что дальше без пользователя нельзя: встаём здесь, а не крутим итерации вхолостую.
      const ask = block.loop.pause_marker ? findPauseRequest(iterPhaseOutputs, block.loop.pause_marker) : undefined;
      if (ask) {
        if (!opts.control?.requestPause) {
          report.error = `Этап ${ask.phase} ждёт решения пользователя, а встать на паузу запуск без UI-сервера не может:\n${ask.text}`;
          return 'failed';
        }
        const reason: PauseReason = { block: block.name, iteration: iter, phase: ask.phase, text: ask.text, output: ask.file, at: new Date().toISOString() };
        report.pauseReason = reason;
        const record: PauseReason = { ...reason };
        (report.pauses ??= []).push(record);
        save();
        opts.control.requestPause();
        if (await checkpoint()) return 'aborted';
        record.resumedAt = new Date().toISOString();
        delete report.pauseReason;
        save();
      }
    }
    // без цикла (его могли снять правкой на паузе) условия нет — проход завершён
    const until = blocks[bi].loop?.until.type;
    return !until || until === 'none' ? 'done' : 'max_iterations';
  };

  try {
    if (storeError) throw storeError;
    // несуществующую директорию ловим до первого этапа, а не молча отдаём сессии без неё
    checkAddDirs(blocks, opts.cwd, opts.addDirs);
    checkPlugins(blocks, opts.cwd);
    // как и несуществующий тег знаний
    knowledge = resolveKnowledge(spec, opts.knowledge);
    // и вызываемый flow, которого нет, круг вызовов или слишком глубокая цепочка: вызываемые могли поменять после сохранения
    checkCalls(spec, opts.loadFlow ?? loadCalledFlow);
    // по индексу, а не по списку: правка flow на паузе меняет будущие блоки (fix.applyFlow); развилка next — переход вперёд
    for (let bi = 0; bi < blocks.length; ) {
      current = blockReports[bi];
      // развилка после блока (у пропущенного продолжением — только нерешённая в прошлом запуске)
      const go = async (): Promise<boolean> => {
        const to = await branch(bi, current!);
        if (to === 'aborted') {
          report.status = 'aborted';
          return false;
        }
        // проверка развилки (судья) тоже стоит денег: дальше не идём, если бюджет кончился
        if (to < blocks.length && opts.maxBudgetUsd !== undefined && report.totalCostUsd > opts.maxBudgetUsd) {
          report.error = `Лимит ${opts.maxBudgetUsd.toFixed(2)} превышен: ${report.totalCostUsd.toFixed(2)}`;
          report.status = 'budget_exceeded';
          return false;
        }
        bi = to;
        return true;
      };
      if (current.skipped) {
        if (cont?.branchFrom !== current.name) bi++;
        else if (!(await go())) break;
        continue;
      }
      current.status = 'running';
      save();
      emit({ type: 'block_start', block: current, total: blocks.length });

      current.status = await runBlock(bi, current, multi ? `${pad(bi + 1)}-${blocks[bi].name}` : '');
      save();
      emit({ type: 'block_end', block: current });

      if (current.status === 'done' || (current.status === 'max_iterations' && current.onFail === 'continue')) {
        if (!(await go())) break;
        continue;
      }
      if (current.status === 'max_iterations' && multi) report.error = `Блок ${current.title}: условие не выполнено за ${current.iterations} итераций`;
      report.status = current.status;
      break;
    }
  } catch (err) {
    report.status = 'failed';
    report.error = err instanceof Error ? err.message : String(err);
    if (current?.status === 'running') {
      current.status = 'failed';
      emit({ type: 'block_end', block: current });
    }
  }

  // финальная сверка: находки после последнего шага — его участникам, артефакты остаются в папке запуска целыми
  try {
    store?.prepareStep();
  } catch (err) {
    report.error ??= `Артефакты после последнего шага: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (report.status === 'running') report.status = 'done';
  // пауза, запрошенная на последнем шаге, так и не наступила
  delete report.pause;
  // итог считаем до саммари тегов (им нужны пути выводов), а report.final присваиваем после finishedAt, как раньше:
  // порядок ключей run.json у запусков без тегов не меняется
  const final = finalPhases(report);
  if (opts.tags?.length) report.tagSummaries = await updateTagSummaries(report, final, runOpts, emit);
  // имя и последние итоги должны попасть в end и итоговый run.json: после конца в run.json никто не пишет
  await Promise.all([namer.settle(), digester.settle()]);
  report.finishedAt = new Date().toISOString();
  report.final = final;
  save();
  emit({ type: 'end', report });
  return report;
}

/**
 * Сессии саммари тегов после запуска, по одной на тег и по очереди: только при статусе done и галочке. Ошибка сессии
 * не меняет статус запуска — она в error этого тега, его старое саммари остаётся. Стоимость идёт в итог запуска.
 */
async function updateTagSummaries(report: RunReport, final: FinalPhase[], opts: RunOptions, emit: (e: RunEvent) => void): Promise<TagSummaryReport[]> {
  const out: TagSummaryReport[] = [];
  for (const tag of opts.tags ?? []) {
    let r: TagSummaryReport;
    if (opts.saveTag === false) r = { tag, ok: false, costUsd: 0, skipped: 'галочка «Обновить саммари тегов» снята' };
    else if (report.status !== 'done') r = { tag, ok: false, costUsd: 0, skipped: `запуск не завершён (${report.status})` };
    // «Остановить» во время саммари прерывает оставшиеся сессии, запуск остаётся done
    else if (opts.abort?.signal.aborted) r = { tag, ok: false, costUsd: 0, skipped: 'остановлено' };
    // «Стоп» мог прийти, пока саммари ждало в очереди тега (её держала сессия терминала): тогда ни промпта, ни сессии
    else r = await queueTagSummary(tag, async () => (opts.abort?.signal.aborted ? { tag, ok: false, costUsd: 0, skipped: 'остановлено' } : updateTagSummary(report, final, tag, opts, emit)));
    out.push(r);
  }
  return out;
}

// Зовётся через queueTagSummary (tags.ts): саммари запуска и сессии терминала по одному тегу пишутся по очереди —
// иначе вторая перезаписала бы первое, считав прошлое саммари до его записи.
async function updateTagSummary(report: RunReport, final: FinalPhase[], tag: string, opts: RunOptions, emit: (e: RunEvent) => void): Promise<TagSummaryReport> {
  let out: TagSummaryReport;
  try {
    const prev = readTag(tag)?.summary ?? '';
    const req = tagSummaryRequest({ ...report, final }, tag, prev, { model: opts.tagSummaryModel ?? 'haiku', abort: opts.abort });
    const file = tagSummaryPromptFile(tag);
    fs.writeFileSync(path.join(report.runDir, file), req.prompt);
    emit({ type: 'tag_summary_start', tag, file });
    let res: SessionResult | undefined;
    try {
      res = await (opts.session ?? runSession)(req, () => {});
      report.totalCostUsd += res.costUsd;
      // ссылки на выводы этапов и прочие файлы папки запуска следующему запуску недоступны — вычищаем
      const text = dropRunPaths(parseTagSummary(res), path.dirname(report.runDir));
      writeTagSummary(tag, text, { id: report.id, flow: report.flow, finishedAt: new Date().toISOString(), status: report.status });
      out = { tag, ok: true, costUsd: res.costUsd };
    } catch (err) {
      out = { tag, ok: false, costUsd: res?.costUsd ?? 0, error: err instanceof Error ? err.message : String(err) };
    }
    if (res?.tokens) out.tokens = res.tokens;
  } catch (err) {
    out = { tag, ok: false, costUsd: 0, error: err instanceof Error ? err.message : String(err) };
  }
  emit({ type: 'tag_summary', tag, report: out });
  return out;
}

/**
 * Меняет лимит итераций блока у идущего запуска. Раннер читает лимит на каждой итерации,
 * поэтому новое значение подхватится со следующей; {{max_iterations}} обновится в промптах следующих итераций.
 * Нельзя опустить ниже уже начатой итерации; равный ей — блок завершится после текущей.
 */
export function setBlockMaxIterations(report: RunReport, blockName: string, value: number): BlockReport {
  const br = report.blocks.find((b) => b.name === blockName);
  if (!br) throw new Error(`Нет блока ${blockName}`);
  if (!br.looped) throw new Error(`У блока ${br.title} нет цикла`);
  if (br.bypassed || br.skipped) throw new Error(`Блок ${br.title} в этом запуске не выполняется`);
  if (br.status !== 'pending' && br.status !== 'running') throw new Error(`Блок ${br.title} уже завершён`);
  if (!Number.isInteger(value) || value < 1 || value > MAX_ITERATIONS_LIMIT) {
    throw new Error(`Лимит итераций — целое от 1 до ${MAX_ITERATIONS_LIMIT}`);
  }
  if (value < br.iterations) throw new Error(`Блок уже на итерации ${br.iterations}: лимит не может быть меньше`);
  br.maxIterations = value;
  report.maxIterations = report.blocks.reduce((n, b) => n + b.maxIterations, 0);
  return br;
}

/** Лимит итераций блока: у блока без цикла — один проход; --max-iterations переопределяет лимит каждого цикла. */
export function blockMaxIterations(block: Block, opts: { maxIterations?: number }): number {
  if (!block.loop) return 1;
  return opts.maxIterations ?? block.loop.max_iterations;
}

/** Что запуск добавляет к каждому этапу: доп. директории и вложения. runDir нужен для абсолютных путей вложений. */
export type RunExtras = Pick<RunOptions, 'addDirs' | 'attachments' | 'runDir'>;

/**
 * Промпт фазы + инструкция «что передать дальше» (handoff) + доп. директории этапа и запуска + раздел тегов знаний
 * блока (knowledge: список по строке на тег, inline-теги целиком) + раздел «Артефакты запуска» + вложения к задаче.
 * art — артефакты этапа на старте шага (подстановки и раздел); без них промпт как до артефактов, без knowledge — как до тегов знаний.
 */
export function renderPhasePrompt(phase: Phase, ctx: TemplateContext, cwd?: string, run?: RunExtras, art?: PhaseArtifacts, knowledge?: KnowledgeTag[], notes?: string[]): string {
  const vars = art ? { ...ctx, artifacts: art.snapshot } : ctx;
  let body = render(phase.prompt, vars);
  if (phase.handoff?.trim()) body = `${body.trimEnd()}\n\n${handoffTail(render(phase.handoff, vars))}`;
  const dirs = cwd ? [...new Set([...resolveAddDirs(phase, cwd), ...resolveDirList(run?.addDirs, cwd)])] : [];
  if (dirs.length) body = `${body.trimEnd()}\n\n${dirsTail(dirs)}`;
  const known = knowledgeBlock(knowledge ?? []);
  if (known) body = `${body.trimEnd()}\n\n${known}`;
  if (art?.section) body = `${body.trimEnd()}\n\n${art.section}`;
  return withNotes(withAttachments(body, run), notes);
}

/**
 * Хвост промпта с указаниями пользователя, данными по ходу запуска (POST /api/runs/:id/note) — последним, после
 * вложений: это поправка к плану, её агент должен увидеть. Без указаний промпт не меняется.
 */
export function withNotes(body: string, notes?: string[]): string {
  const list = (notes ?? []).map((n) => n.trim()).filter(Boolean);
  if (!list.length) return body;
  const tail = list.length === 1
    ? `Указание пользователя (дано по ходу запуска — учти его):\n${list[0]}`
    : `Указания пользователя (даны по ходу запуска — учти их):\n${list.map((n, i) => `${i + 1}. ${n}`).join('\n\n')}`;
  return `${body.trimEnd()}\n\n${tail}`;
}

/** Хвост промпта с handoff: чем этап заканчивает ответ. Общий с страницей «Контекст», которая считает его размер. */
export const handoffTail = (handoff: string): string => `Чем закончить ответ (это уйдёт следующему этапу): ${handoff.trim()}`;

/** Хвост промпта со списком доп. директорий этапа и запуска. */
export const dirsTail = (dirs: string[]): string =>
  `Кроме директории проекта тебе доступны (правила, инструкции, скиллы — сверяйся с ними):\n${dirs.map((d) => `- ${d}`).join('\n')}`;

/** Хвост промпта со списком вложений абсолютными путями. Без вложений промпт не меняется. */
export function withAttachments(body: string, run?: RunExtras): string {
  const files = attachmentPaths(run);
  if (!files.length) return body;
  return `${body.trimEnd()}\n\nВложения к задаче (открой инструментом Read):\n${files.map((f) => `- ${f}`).join('\n')}`;
}

function attachmentPaths(run?: RunExtras): string[] {
  if (!run?.runDir || !run.attachments?.length) return [];
  return run.attachments.map((f) => path.resolve(run.runDir!, f));
}

/** Папка вложений запуска — в additionalDirectories, чтобы Read открыл файлы вне cwd. */
function attachmentsDir(run?: RunExtras): string[] {
  return attachmentPaths(run).length ? [path.join(run!.runDir!, ATTACHMENTS_DIR)] : [];
}

/** Доп. директории этапа абсолютными путями: ~ раскрывается, относительные — от рабочей директории. */
export function resolveAddDirs(phase: Phase, cwd: string): string[] {
  return resolveDirList(phase.add_dirs, cwd);
}

/** Список путей абсолютными: ~ раскрывается, относительные — от cwd, пустые и дубли убираются. */
export function resolveDirList(list: string[] | undefined, cwd: string): string[] {
  const dirs = (list ?? []).map((d) => d.trim()).filter(Boolean).map((d) => {
    const home = d === '~' || d.startsWith('~/') ? path.join(os.homedir(), d.slice(1)) : d;
    return path.resolve(cwd, home);
  });
  return [...new Set(dirs)];
}

/** Бросает ошибку, если какой-то доп. директории этапа или запуска нет на диске. */
export function checkAddDirs(blocks: Block[], cwd: string, runDirs?: string[]): void {
  const isDir = (d: string) => Boolean(fs.statSync(d, { throwIfNoEntry: false })?.isDirectory());
  const missing = [
    ...resolveDirList(runDirs, cwd).filter((d) => !isDir(d)).map((d) => `запуск: ${d}`),
    ...blocks.flatMap((b) =>
      b.phases.flatMap((p) =>
        resolveAddDirs(p, cwd)
          .filter((d) => !isDir(d))
          .map((d) => `${p.name}: ${d}`),
      ),
    ),
  ];
  if (missing.length) throw new Error(`Нет директорий:\n${missing.join('\n')}`);
}

/** Плагины этапа абсолютными путями: plugins блока, затем этапа; ~ и относительные — как у add_dirs. */
export function resolvePlugins(spec: FlowSpec, phase: Phase, cwd: string): string[] {
  // имена этапов уникальны во всём flow: ищем по имени, а не по объекту — клон этапа плагины блока не теряет
  const block = flowBlocks(spec).find((b) => b.phases.some((p) => p.name === phase.name));
  return resolveDirList([...(block?.plugins ?? []), ...(phase.plugins ?? [])], cwd);
}

/** Бросает ошибку, если какой-то папки плагина (блока или этапа) нет на диске. */
export function checkPlugins(blocks: Block[], cwd: string): void {
  const isDir = (d: string) => Boolean(fs.statSync(d, { throwIfNoEntry: false })?.isDirectory());
  const missing = blocks.flatMap((b) => [
    ...resolveDirList(b.plugins, cwd).filter((d) => !isDir(d)).map((d) => `блок ${b.name}: ${d}`),
    ...b.phases.flatMap((p) => resolveDirList(p.plugins, cwd).filter((d) => !isDir(d)).map((d) => `${p.name}: ${d}`)),
  ]);
  if (missing.length) throw new Error(`Нет папок плагинов:\n${missing.join('\n')}`);
}

/** Модель и effort, с которыми пойдёт этап: единственное место приоритета (этап → defaults → opts.model для модели). */
export function phaseModel(spec: FlowSpec, phase: Phase, opts: Pick<RunOptions, 'model'>): { model?: string; effort?: EffortLevel } {
  const d = spec.defaults ?? {};
  return { model: phase.model ?? d.model ?? opts.model, effort: phase.effort ?? d.effort };
}

/**
 * Запрос сессии этапа. art — права на артефакты: папка артефактов доп. директорией (если есть доступ) и неявные
 * Read/Edit/Write в tools; их ограничивает guard, который навешивает runPhase. Без art — как до артефактов.
 * knowledge — теги знаний блока: их пути и папки вложений идут доп. директориями, а тегам по запросу (не inline) —
 * инструмент knowledge_read рядом с инструментом чтения артефактов.
 */
export function buildRequest(spec: FlowSpec, phase: Phase, prompt: string, opts: RunOptions, art?: Pick<PhaseArtifacts, 'dir' | 'access' | 'sources'>, knowledge?: KnowledgeTag[]) {
  const d = spec.defaults ?? {};
  const implicit = art?.access.implicit.filter((t) => !phase.tools.includes(t)) ?? [];
  const artDir = art?.access.read.length ? [art.dir] : [];
  const plugins = resolvePlugins(spec, phase, opts.cwd);
  return {
    prompt,
    cwd: opts.cwd,
    additionalDirectories: [...new Set([...resolveAddDirs(phase, opts.cwd), ...resolveDirList(opts.addDirs, opts.cwd), ...attachmentsDir(opts), ...artDir, ...(opts.tagDirs ?? []), ...knowledgeDirs(knowledge ?? [])])],
    system: phase.system,
    tools: implicit.length ? [...phase.tools, ...implicit] : phase.tools,
    ...phaseModel(spec, phase, opts),
    maxTurns: phase.max_turns ?? d.max_turns,
    maxBudgetUsd: phase.max_budget_usd ?? d.max_budget_usd,
    permissionMode: phase.permission_mode ?? d.permission_mode,
    outputSchema: phase.output_schema,
    persist: true,
    // этап, закончивший ответ раньше своей фоновой задачи, теряет её результат
    foreground: true,
    abort: opts.abort,
    ...(plugins.length ? { plugins } : {}),
    ...mergeTools(artifactTools(art), knowledgeTools(knowledge)),
  };
}

type McpTools = { mcpServers?: NonNullable<SessionRequest['mcpServers']>; allow?: string[] };

/** Инструмент чтения артефактов по ключу: MCP-сервер на сессию и его имена в allow — только при доступе к артефактам. */
function artifactTools(art?: Pick<PhaseArtifacts, 'access' | 'sources'>): McpTools {
  if (!ARTIFACT_TOOLS_ENABLED || !art?.sources || !art.access.read.length) return {};
  return { mcpServers: { [ARTIFACT_TOOLS_SERVER]: artifactToolsServer(art.sources) }, allow: ARTIFACT_TOOLS_ALLOW };
}

/** Инструмент knowledge_read: только если среди тегов знаний блока есть тег по запросу (не inline). Судье не даётся. */
function knowledgeTools(knowledge?: KnowledgeTag[]): McpTools {
  const onDemand = knowledge?.filter((t) => !t.inline) ?? [];
  if (!onDemand.length) return {};
  return { mcpServers: { [KNOWLEDGE_TOOLS_SERVER]: knowledgeToolsServer(onDemand) }, allow: KNOWLEDGE_TOOLS_ALLOW };
}

/** Несколько наборов MCP-серверов в одном запросе: серверы и allow складываются; без серверов полей нет, как раньше. */
function mergeTools(...parts: McpTools[]): McpTools {
  const mcpServers = Object.assign({}, ...parts.map((p) => p.mcpServers ?? {})) as NonNullable<McpTools['mcpServers']>;
  const allow = [...new Set(parts.flatMap((p) => p.allow ?? []))];
  return Object.keys(mcpServers).length ? { mcpServers, allow } : {};
}

const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    done: { type: 'boolean', description: 'true только если задача полностью выполнена и цикл можно завершить.' },
    reason: { type: 'string', description: 'Краткое обоснование вердикта.' },
    feedback: {
      type: 'string',
      description: 'Что конкретно нужно исправить или доделать на следующей итерации. Пустая строка, если done.',
    },
  },
  required: ['done', 'reason', 'feedback'],
  additionalProperties: false,
};

const JUDGE_SYSTEM =
  'Ты строгий приёмщик результата многошагового агентского процесса. Тебе дают исходную задачу и выводы этапов текущей итерации. ' +
  'Оцени по рубрике из промпта. Отвечай done=true только когда задача выполнена целиком; иначе перечисли конкретные пробелы в feedback.';

/** reason и feedback — на языке задачи: их читает человек в интерфейсе и этапы следующей итерации. */
const judgeSystem = (task: string) => `${JUDGE_SYSTEM} Пиши reason и feedback ${replyIn(taskLang(task))}, если рубрика не требует другого языка.`;

/**
 * Сессия судьи. Вложения — часть задачи: судья получает их список и папку attachments/.
 * Доп. директории (этапа и запуска) ему не даются; артефакты (art) — даются: раздел в промпте и их папка.
 * Теги знаний блока (knowledge) — только папками: рубрика судьи своя, текст знаний ему не даётся.
 */
export function judgeRequest(spec: FlowSpec, until: Extract<Until, { type: 'judge' }>, prompt: string, opts: RunOptions, art?: PhaseArtifacts, knowledge?: KnowledgeTag[], task = '') {
  return {
    prompt: withAttachments(art?.section ? `${prompt.trimEnd()}\n\n${art.section}` : prompt, opts),
    cwd: opts.cwd,
    additionalDirectories: [...new Set([...attachmentsDir(opts), ...(art ? [art.dir] : []), ...(opts.tagDirs ?? []), ...knowledgeDirs(knowledge ?? [])])],
    system: judgeSystem(task),
    // Только чтение + сабагенты (Agent добавляет runSession): судья может сам проверить файлы.
    tools: ['Read', 'Grep', 'Glob'],
    model: until.model ?? spec.defaults?.model ?? opts.model,
    maxTurns: 30,
    outputSchema: JUDGE_SCHEMA,
    persist: false,
    foreground: true,
    abort: opts.abort,
    ...artifactTools(art),
  };
}

async function evaluateUntil(
  spec: FlowSpec,
  block: Block,
  ctx: TemplateContext,
  opts: RunOptions,
  runDir: string,
  iterRel: string,
  emit: (e: RunEvent) => void,
  judgeArt?: PhaseArtifacts,
  knowledge?: KnowledgeTag[],
  /** Указания пользователя судье: забираются, только если судья и правда идёт. */
  notes: () => string[] = () => [],
): Promise<ConditionReport> {
  const until = block.loop!.until;
  const base: ConditionReport = { block: block.name, iteration: ctx.iteration, type: until.type, done: false, feedback: '', costUsd: 0 };
  const start = (kind: Until['type'], detail: string, file?: string) =>
    emit({ type: 'condition_start', block: block.name, iteration: ctx.iteration, kind, detail, ...(file ? { file } : {}) });

  switch (until.type) {
    case 'none':
      start('none', '');
      return { ...base, done: false, detail: 'фиксированное число итераций' };

    case 'marker': {
      start('marker', until.marker);
      const phaseName = until.phase ?? block.phases[block.phases.length - 1].name;
      const output = ctx.phases[phaseName] ?? '';
      const done = endsWithMarker(output, until.marker);
      return { ...base, done, detail: `маркер ${until.marker} последней строкой вывода ${phaseName}: ${done ? 'есть' : 'нет'}` };
    }

    case 'command': {
      start('command', until.run);
      // асинхронно: синхронный запуск держал бы event loop, и UI-сервер не слышал бы «Остановить»
      const r = await runCommand(until.run, opts.cwd, (until.timeout_sec ?? 600) * 1000, opts.abort?.signal);
      const out = r.output;
      const logFile = `${iterRel}/condition.command.log`;
      fs.writeFileSync(path.join(runDir, logFile), out);
      const done = r.code === 0;
      const code = r.code ?? r.signal ?? '?';
      const feedback = done ? '' : `Команда \`${until.run}\` завершилась с кодом ${code}. ${COMMAND_OUTPUT_HEAD}${truncateTail(out, FEEDBACK_MAX)}`;
      return { ...base, done, feedback, detail: `exit ${code}`, logFile };
    }

    case 'judge': {
      const req = judgeRequest(spec, until, render(until.prompt, judgeArt ? { ...ctx, artifacts: judgeArt.snapshot } : ctx), opts, judgeArt, knowledge, ctx.input);
      req.prompt = withNotes(req.prompt, notes());
      const logFile = `${iterRel}/condition.judge.prompt.md`;
      fs.writeFileSync(path.join(runDir, logFile), req.prompt);
      // событие после записи: промпт судьи можно открыть, пока он думает
      start('judge', '', logFile);
      const res: SessionResult = await (opts.session ?? runSession)(req, () => {});
      const verdict = parseVerdict(res);
      if (!verdict) {
        return {
          ...base,
          done: false,
          feedback: `Судья не вернул вердикт: ${res.errors.join('; ') || res.subtype}`,
          detail: 'ошибка судьи',
          costUsd: res.costUsd,
          logFile,
        };
      }
      return { ...base, done: verdict.done, feedback: verdict.feedback, detail: verdict.reason, costUsd: res.costUsd, logFile };
    }
  }
}

const COMMAND_OUTPUT_MAX = 64 * 1024 * 1024;

/** Команда условия: stdout+stderr в одном буфере; таймаут и остановка убивают всю группу процессов шелла. */
function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve) => {
    // detached — своя группа процессов, чтобы kill дошёл и до детей шелла (gradle, npm test…)
    const child = spawn(cmd, { shell: true, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const collect = (b: Buffer) => {
      if (size >= COMMAND_OUTPUT_MAX) return;
      chunks.push(b);
      size += b.length;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let note = '';
    const kill = (why: string) => {
      note ||= `\n[${why}]\n`;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // группа уже завершилась
      }
    };
    const timer = setTimeout(() => kill(`таймаут ${Math.round(timeoutMs / 1000)} с`), timeoutMs);
    const onAbort = () => kill('запуск остановлен');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => { note += `\n${err.message}\n`; });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, output: Buffer.concat(chunks).toString('utf8') + note });
    });
  });
}

type Verdict = { done: boolean; reason: string; feedback: string };

function parseVerdict(res: SessionResult): Verdict | undefined {
  const raw = res.structured ?? tryJson(res.text);
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Partial<Verdict>;
  if (typeof v.done !== 'boolean') return undefined;
  return { done: v.done, reason: String(v.reason ?? ''), feedback: String(v.feedback ?? '') };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
}

export function makeRunDir(runsDir: string, name: string): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  let dir = path.join(runsDir, `${stamp}-${name}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(runsDir, `${stamp}-${name}-${i}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

type PhaseOutput = { phase: string; output: string; file: string };

/** Что вернул этап шага: сливается в контекст после того, как закончат все участники. */
type PhaseRun = { phase: Phase; index: number; res: SessionResult; output: string; files: PhaseFiles };

/** Вывод этапа шага; index — номер этапа в блоке, по нему восстанавливается порядок объявления. */
export type StepOutput = PhaseOutput & { index: number };

/** Куда сливаются выводы шага: контекст шаблонов и накопители запуска и итерации. */
export type OutputSink = { ctx: TemplateContext; history: string[]; iterOutputs: string[]; iterPhaseOutputs: PhaseOutput[] };

/**
 * Сливает выводы шага в порядке объявления, в каком бы порядке участники ни закончили:
 * {{phases.*}}, {{outputs}}, {{history}} и выводы итерации — по этапу, {{prev}} — см. stepPrev.
 */
export function mergeGroupOutputs(sink: OutputSink, outs: StepOutput[], where: string): void {
  const ordered = [...outs].sort((a, b) => a.index - b.index);
  for (const o of ordered) {
    sink.ctx.phases[o.phase] = o.output;
    sink.iterOutputs.push(`### ${o.phase}\n${o.output}`);
    sink.iterPhaseOutputs.push({ phase: o.phase, output: o.output, file: o.file });
    sink.history.push(`## ${where} · ${o.phase}\n${truncateTail(o.output, HISTORY_ENTRY_MAX)}`);
  }
  sink.ctx.prev = stepPrev(ordered);
  sink.ctx.outputs = sink.iterOutputs.join('\n\n');
  sink.ctx.history = sink.history.join('\n\n');
}

/** {{prev}} после шага: вывод этапа как есть, у группы — склейка участников «### имя» по порядку, как в {{outputs}}. */
function stepPrev(ordered: { phase: string; output: string }[]): string {
  if (ordered.length === 1) return ordered[0].output;
  return ordered.map((o) => `### ${o.phase}\n${o.output}`).join('\n\n');
}

/** Как continuationFrom читает прошлые запуски: отчёт по id и файл вывода по пути относительно папки запуска. */
export type RunStore = {
  report: (id: string) => RunReport | undefined;
  output: (runId: string, rel: string) => string | undefined;
  /** Flow запуска для продолжения его дочернего (блок-вызов): без него упавший вызов начинается заново. */
  spec?: (report: RunReport) => FlowSpec;
  /** Папка запуска по id: откуда брать артефакты дочернего. Нет — runDir из его run.json. */
  dir?: (runId: string) => string;
};

const CONTINUE_DEPTH_MAX = 50;

/**
 * Можно ли продолжить запуск prev текущей версией флоу spec — единственный источник ответа: им пользуются
 * continuationFrom, кнопка «Продолжить» и правило «можно ли править артефакт» (через continuable в API).
 * Смотрит только на статусы, файлы не читает. skip — сплошное начало блоков, завершённых в prev (done), по имени.
 * prev — отчёт глазами сервера: у оборвавшегося запуска статус interrupted, а не running.
 */
export function canContinue(
  prev: Pick<RunReport, 'status' | 'blocks'> & { phases?: RunReport['phases']; continuedFrom?: string },
  spec: FlowSpec,
): { ok: true; skip: Block[] } | { ok: false; reason: string } {
  if (prev.status === 'running') return { ok: false, reason: 'Запуск ещё идёт: продолжить можно только завершённый' };
  if (prev.status === 'done') return { ok: false, reason: 'Запуск завершён полностью: продолжать нечего' };
  const blocks = flowBlocks(spec);
  const skip: Block[] = [];
  for (const b of blocks) {
    const was = prev.blocks?.find((x) => x.name === b.name);
    // через этот блок развилка прошлого запуска перешла: как и завершённый, он не повторяется
    if (was?.status !== 'done' && !was?.bypassed) break;
    skip.push(b);
  }
  if (skip.length === blocks.length) return { ok: false, reason: 'Все блоки flow уже завершены в этом запуске: продолжать нечего' };
  // первый блок, упёршийся в лимит итераций, продолжаем: он идёт заново с новым лимитом, а код и артефакты остаются;
  // первый блок-вызов, уже вызывавший flow, — тоже: его первая итерация продолжает дочерний запуск (Continuation.calls)
  const first = prev.blocks?.find((x) => x.name === blocks[0].name)?.status;
  // (или prev сам продолжение: тогда вызов был в запуске, который он продолжал, — callContinuation найдёт его там)
  const called = isCallBlock(blocks[0]) && Boolean(
    prev.blocks?.find((x) => x.name === blocks[0].name)?.call || prev.phases?.some((p) => p.block === blocks[0].name && p.call) || prev.continuedFrom,
  );
  if (!skip.length && first !== 'max_iterations' && !called) {
    return { ok: false, reason: `Первый блок «${blocks[0].title ?? blocks[0].name}» не завершён: продолжать нечего, запусти заново` };
  }
  return { ok: true, skip };
}

/**
 * Что взять у завершённого запуска prev, чтобы продолжить его текущей версией флоу spec.
 * Пропускается сплошное начало блоков, которые в prev завершились done (сопоставление по имени);
 * у каждого их этапа берётся последний вывод. Если prev сам был продолжением и блок в нём пропущен,
 * выводы берутся из запуска, где блок выполнялся (по цепочке continuedFrom). Бросает ошибку, если
 * продолжать нечего или вывода пропускаемого этапа нет: без него {{phases.*}} молча остался бы пустым.
 */
export function continuationFrom(prev: RunReport, spec: FlowSpec, store: RunStore, depth = 0): Continuation {
  const check = canContinue(prev, spec);
  if (!check.ok) throw new Error(check.reason);
  const blocks = flowBlocks(spec);
  const multi = blocks.length > 1;
  const skip = check.skip;

  type Ran = { runId: string; p: PhaseReport };
  const ranIn = (r: RunReport, block: string, depth: number): Ran[] => {
    if (r.blocks?.find((x) => x.name === block)?.skipped && r.continuedFrom) {
      if (depth >= CONTINUE_DEPTH_MAX) throw new Error(`Цепочка продолжений длиннее ${CONTINUE_DEPTH_MAX}`);
      const from = store.report(r.continuedFrom);
      if (!from) throw new Error(`Нет запуска ${r.continuedFrom}, который продолжал ${r.id}`);
      return ranIn(from, block, depth + 1);
    }
    // участники группы пишут отчёты в порядке завершения; history строим в порядке объявления, как живой запуск
    return r.phases
      .filter((p) => p.block === block)
      .map((p) => ({ runId: r.id, p }))
      .sort((a, b) => a.p.iteration - b.p.iteration || (a.p.index ?? 0) - (b.p.index ?? 0));
  };
  const read = ({ runId, p }: Ran): string => {
    const text = p.files?.output ? store.output(runId, p.files.output) : undefined;
    if (text === undefined) throw new Error(`Нет вывода этапа ${p.phase} (${p.block}, итерация ${p.iteration}) в запуске ${runId}`);
    return text;
  };

  const runs: Ran[] = [];
  const phases: Record<string, string> = {};
  // через блок развилка перешла: выводов у него нет, {{phases.*}} его этапов пусты, как и в живом запуске
  const bypassed = (b: Block) => Boolean(prev.blocks?.find((x) => x.name === b.name)?.bypassed);
  for (const b of skip) {
    if (bypassed(b)) continue;
    const ran = ranIn(prev, b.name, 0);
    runs.push(...ran);
    for (const ph of b.phases) {
      const last = ran.filter((x) => x.p.phase === ph.name).at(-1);
      if (!last) throw new Error(`Этап ${ph.name} блока ${b.name} в прошлом запуске не выполнялся`);
      phases[ph.name] = read(last);
    }
  }
  const history = runs.map((x) => {
    const where = multi ? `${x.p.block} · итерация ${x.p.iteration}` : `Итерация ${x.p.iteration}`;
    return `## ${where} · ${x.p.phase}\n${truncateTail(read(x), HISTORY_ENTRY_MAX)}`;
  });
  // {{prev}} — как при обычном переходе между блоками: вывод последнего шага последнего выполненного блока, у группы — склейка
  const lastRan = skip.filter((b) => !bypassed(b)).at(-1);
  const lastStep = lastRan ? phaseSteps(lastRan).at(-1)! : undefined;
  const tail = lastStep ? stepPrev(lastStep.phases.map(({ phase }) => ({ phase: phase.name, output: phases[phase.name] }))) : '';
  const bypass = skip.filter(bypassed).map((b) => b.name);
  const calls = callContinuation(prev, blocks[skip.length], store, depth);
  // решения развилок пропускаемых блоков: у пропущенного и в prev блока — по цепочке continuedFrom, где он выполнялся
  const decisionIn = (r: RunReport, block: string, d: number): BlockNext | undefined => {
    const br = r.blocks?.find((x) => x.name === block);
    if (br?.next) return br.next;
    if (!br?.skipped || !r.continuedFrom || d >= CONTINUE_DEPTH_MAX) return undefined;
    const from = store.report(r.continuedFrom);
    return from ? decisionIn(from, block, d + 1) : undefined;
  };
  const decided: Record<string, BlockNext> = {};
  for (const b of skip) {
    const n = b.next !== undefined && !bypassed(b) ? decisionIn(prev, b.name, 0) : undefined;
    if (n) decided[b.name] = n;
  }
  // развилку после последнего пропускаемого блока не решили (остановили на её проверке) — её решит этот запуск
  const last = skip.at(-1);
  const undecided = last && last === lastRan && last.next !== undefined && !decided[last.name];
  return {
    runId: prev.id, skipBlocks: skip.map((b) => b.name), phases, prev: tail, history,
    ...(bypass.length ? { bypassBlocks: bypass } : {}),
    ...(calls ? { calls } : {}),
    ...(Object.keys(decided).length ? { decided } : {}),
    ...(undecided ? { branchFrom: last.name } : {}),
  };
}

/**
 * Блок-вызов, на котором prev остановился: артефакты его последнего дочернего запуска переходят в первый вызов, а сам
 * дочерний продолжается, если его можно продолжить (и дальше вглубь — его собственный упавший вызов). Без вызова или
 * если блок теперь зовёт другой flow — ничего: блок начнёт вызов заново. Без flow дочернего (store.spec) или когда
 * продолжить его не выходит — только артефакты.
 */
function callContinuation(prev: RunReport, block: Block | undefined, store: RunStore, depth: number): Continuation['calls'] {
  if (!block || !isCallBlock(block)) return undefined;
  // последний дочерний блока: связь пишется при старте вызова (BlockReport.call), у старых отчётов — только в этапе.
  // Не вызывал вовсе (продолжение упало до вызова) — ищем в запуске, который оно продолжало
  const lastChild = (r: RunReport, d: number): string | undefined => {
    const id = r.blocks?.find((x) => x.name === block.name)?.call?.runId ?? [...r.phases].reverse().find((p) => p.block === block.name && p.call)?.call?.runId;
    if (id || !r.continuedFrom || d >= CONTINUE_DEPTH_MAX) return id;
    const from = store.report(r.continuedFrom);
    return from ? lastChild(from, d + 1) : undefined;
  };
  const id = lastChild(prev, 0);
  const child = id ? store.report(id) : undefined;
  if (!child || child.flow !== block.flow) return undefined;
  const from = { runId: child.id, runDir: store.dir?.(child.id) ?? child.runDir };
  if (!store.spec || depth >= CONTINUE_DEPTH_MAX) return { [block.name]: { from } };
  try {
    const childSpec = store.spec(child);
    if (!canContinue(child, childSpec).ok) return { [block.name]: { from } };
    const cont = continuationFrom(child, childSpec, store, depth + 1);
    return { [block.name]: { from, cont, spec: { ...childSpec, input: child.input } } };
  } catch {
    // нет flow дочернего, его выводов или запуска в цепочке его продолжений: вызов начнётся заново, с его артефактами
    return { [block.name]: { from } };
  }
}

/**
 * Итог запуска — последний выполненный шаг: этап с наибольшими (порядок блока, итерация, номер в блоке).
 * report.phases идёт в порядке завершения, у группы он случайный, поэтому «последний элемент» не годится.
 * Если этап в группе, берутся все участники группы той же итерации по порядку объявления.
 * Упавший этап тоже в итоге (ok: false). Этап вне группы, упавший исключением, отчёта не пишет — в итоге будет шаг до него.
 */
export function finalPhases(report: Pick<RunReport, 'blocks' | 'phases'>): FinalPhase[] {
  const order = (p: PhaseReport) => report.blocks?.findIndex((b) => b.name === p.block) ?? 0;
  const key = (p: PhaseReport) => [order(p), p.iteration ?? 0, p.index ?? 0];
  const later = (a: PhaseReport, b: PhaseReport) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
    return false;
  };
  let last: PhaseReport | undefined;
  for (const p of report.phases ?? []) if (!last || later(p, last)) last = p;
  if (!last) return [];
  const step = last.group
    ? report.phases
        .filter((p) => p.block === last.block && p.iteration === last.iteration && p.group === last.group)
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    : [last];
  return step.map((p) => ({
    block: p.block,
    iteration: p.iteration,
    phase: p.phase,
    title: p.title || p.phase,
    ok: p.ok,
    output: p.files?.output ?? '',
  }));
}

const PAUSE_TEXT_MAX = 4000;

/**
 * Первый этап итерации, чей вывод заканчивается маркером паузы (последняя непустая строка ровно маркер).
 * Маркер в середине текста не считается: выводы этапов попадают в промпты следующих ({{prev}}, {{phases.*}}),
 * и цитата чужого маркера не должна ставить запуск на паузу.
 */
export function findPauseRequest(outputs: PhaseOutput[], marker: string): { phase: string; text: string; file: string } | undefined {
  for (const o of outputs) {
    if (!endsWithMarker(o.output, marker)) continue;
    const lines = o.output.trimEnd().split('\n');
    return { phase: o.phase, text: truncateTail(lines.slice(0, -1).join('\n').trim(), PAUSE_TEXT_MAX), file: o.file };
  }
  return undefined;
}

/**
 * Последняя непустая строка вывода — ровно маркер. Маркер внутри текста не считается: цитата чужого
 * вывода или фраза «маркер <DONE> не вывожу» не должны завершать цикл или ставить паузу.
 */
export function endsWithMarker(output: string, marker: string): boolean {
  const m = marker.trim();
  if (!m) return false;
  const lines = output.trimEnd().split('\n');
  return lines[lines.length - 1].trim() === m;
}

function truncateTail(s: string, max: number): string {
  return s.length > max ? '…' + s.slice(-max) : s;
}
