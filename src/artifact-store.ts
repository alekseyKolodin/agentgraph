// Хранилище артефактов запуска: файлы в runs/<id>/artifacts/, версии в artifacts-history/, карантин, блокировка
// на время пишущего шага. Все методы синхронные: сервер и раннер в одном процессе не должны видеть полузаписанное состояние.
// Порядок вызовов раннером — «Жизненный цикл шага» в плане: prepareStep → beginStep → snapshot → шаг → finishStep → endStep.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  ARTIFACTS_DIR,
  EDIT_MAX,
  HISTORY_DIR,
  QUARANTINE_DIR,
  artifactFileProblem,
  artifactGuardDecision,
  artifactSection,
  artifactMapParts,
  artifactTasks,
  isArtifactKey,
  substitution,
  fmtWhen,
  judgeAccess,
  type ArtifactAccess,
  type ArtifactAuthor,
  type ArtifactLite,
  type ArtifactMeta,
  type ArtifactSource,
  type ArtifactsReport,
  type DeclaredArtifact,
  type Denial,
  type DenialReason,
  type GuardScope,
  type PathProbe,
  type PhaseArtifacts,
  type StepArtifacts,
  type StepDelta,
} from './artifacts.js';
import { referencedArtifacts } from './template.js';

export { ARTIFACTS_DIR, HISTORY_DIR, QUARANTINE_DIR };
const TMP_DIR = '.tmp';

/** Правка через API и версия с копией содержимого — до 1 МБ (EDIT_MAX из контракта). */
export { EDIT_MAX };
/** История запуска больше этого — версии без копий. */
const HISTORY_MAX = 200 * 1024 * 1024;
/** Файлы больше этого не хэшируются: сравнение по размеру и времени изменения. */
const HASH_MAX = 8 * 1024 * 1024;
/** Ответ на паузу. */
export const ANSWER_MAX = 64 * 1024;
/** При продолжении файл больше этого не копируется. */
const COPY_MAX = 64 * 1024 * 1024;

/** Чтение файла артефакта: без следования ссылке и без ожидания на именованном канале (mkfifo из Bash этапа повесил бы процесс). */
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

export const nodeProbe: PathProbe = {
  realpath: (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return undefined;
    }
  },
  lstat: (p) => {
    const s = fs.lstatSync(p, { throwIfNoEntry: false });
    return s ? { file: s.isFile(), symlink: s.isSymbolicLink(), nlink: s.nlink } : undefined;
  },
};

/** Отчёт этапа или проверки условия глазами хранилища: сюда пишутся изменения, предупреждения и отказы. */
export type StepHolder = { artifacts?: StepArtifacts; denials?: Denial[] };
export type { PauseAnswer } from './api-types.js';
import type { PauseAnswer } from './api-types.js';
type PauseLike = { block: string; iteration: number; phase: string; text: string; at?: string; resumedAt?: string; answer?: PauseAnswer };
/** Отчёт запуска глазами хранилища (структурно — RunReport или сырой run.json). */
export type StoreReport = {
  artifacts?: ArtifactsReport;
  pauses?: PauseLike[];
  status?: string;
  phases?: { block: string; iteration: number; phase: string }[];
};

export type StepMember = { name: string; access: ArtifactAccess; report?: StepHolder };
/** Шаг глазами хранилища. report участника и условия раннер проставляет перед finishStep. */
export type StepRef =
  | { kind: 'phases'; block: string; iteration: number; members: StepMember[]; finished?: boolean }
  | { kind: 'condition'; block: string; iteration: number; report?: StepHolder; finished?: boolean };

export type ArtifactsEvent = { type: 'artifacts'; items: ArtifactLite[]; step?: StepDelta };

export type StoreOptions = {
  runDir: string;
  declared: DeclaredArtifact[];
  /** Хранилище держит report.artifacts, пишет предупреждения в отчёты этапов и условий и ответы в report.pauses. */
  report: StoreReport;
  /** Сохранить run.json. Изменения между шагами сохраняются сразу. */
  persist: () => void;
  emit?: (e: ArtifactsEvent) => void;
  now?: () => Date;
  /** У этапов есть инструмент чтения по ключу (artifact-tools): карта и раздел промпта о нём говорят. */
  readTool?: boolean;
};

export type Guard = (tool: string, input: Record<string, unknown>, ctx?: { cwd: string }) => string | undefined;

type FileState = { size: number; mtimeMs: number; nlink: number; hash: string; content?: Buffer };

type Fail<C extends string> = { ok: false; code: C; message: string };
export type WriteResult =
  | { ok: true; hash: string; author: ArtifactAuthor; readers: string[] }
  | Fail<'unknown_key' | 'missing' | 'too_big'>
  | (Fail<'locked'> & { phases: string[] })
  | (Fail<'conflict'> & { hash: string; author: ArtifactAuthor; at?: string });
export type AnswerResult = { ok: true; hash: string } | Fail<'no_decisions' | 'not_paused' | 'empty' | 'too_big' | 'locked' | 'missing'>;
export type ReadResult = { ok: true; text: string; hash: string; size: number; mtimeMs: number; meta: ArtifactMeta } | Fail<'unknown_key' | 'missing' | 'too_big'>;
export type VersionResult =
  | { ok: true; n: number; at: string; author: ArtifactAuthor; size: number; stored: true; text: string }
  | { ok: true; n: number; at: string; author: ArtifactAuthor; size: number; stored: false }
  | Fail<'unknown_key' | 'unknown_version' | 'missing'>;

export class ArtifactStore {
  readonly runDir: string;
  /** Папка артефактов, канонический путь (фиксируется при init/open). */
  dir = '';
  private runsDir = '';
  private state: ArtifactsReport = { items: [], warnings: [] };
  private readonly decl: DeclaredArtifact[];
  private readonly titles = new Map<string, string>();
  private readonly files = new Map<string, string>();
  private readonly locks = new Map<string, string[]>();
  private current?: StepRef;
  private last?: StepRef;
  private readonly warnedForeign = new Set<string>();
  private historyBytes = 0;
  /** Открыто open(..., { readonly: true }): сверки с диском, записи и сохранения нет. */
  private readonly = false;
  /** Шаг что-то поменял (версии, предупреждения): endStep сохранит отчёт и пошлёт событие. */
  private stepDirty = false;
  private quarantineDir?: string;

  constructor(private readonly o: StoreOptions) {
    this.runDir = o.runDir;
    this.decl = o.declared;
    for (const a of o.declared) this.titles.set(a.key, a.title);
  }

  private now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  // ---------- создание

  /** Создаёт папку и файлы артефактов: из initial, пустые или копией текущих файлов прошлого запуска (по ключу). */
  init(from?: { runId: string; runDir: string }): void {
    const dirPath = path.join(this.runDir, ARTIFACTS_DIR);
    fs.mkdirSync(dirPath);
    this.dir = fs.realpathSync.native(dirPath);
    this.runsDir = fs.realpathSync.native(path.dirname(fs.realpathSync.native(this.runDir)));
    this.ensureTmp();
    const warnings: string[] = [];
    const prev = from ? readPrevious(from.runDir, warnings) : undefined;
    this.state = { items: [], warnings };
    this.o.report.artifacts = this.state;
    let copied = false;
    for (const a of this.decl) {
      const m: ArtifactMeta = { key: a.key, title: a.title, file: a.file, size: 0, hash: '', mtimeMs: 0, ...(a.decisions ? { decisions: true as const } : {}), versions: [] };
      this.state.items.push(m);
      const p = prev?.items.get(a.key);
      const content = p ? readPreviousFile(from!.runDir, p, warnings) : undefined;
      if (p && content !== undefined) {
        this.writeFile(a.file, content);
        const carried = p.versions.at(-1)?.author;
        const same = hashOf(content) === p.hash;
        const author: ArtifactAuthor = same && carried ? carried : changedAfter(prev!, this.now());
        m.fromRun = from!.runId;
        this.record(m, author, undefined, from!.runId);
        copied = true;
      } else {
        this.writeFile(a.file, a.initial ?? '');
        this.record(m, a.initial !== undefined ? { kind: 'initial' } : { kind: 'empty' }, undefined);
      }
    }
    if (copied) this.state.from = from!.runId;
    this.rebuildFiles();
  }

  /**
   * Хранилище неживого запуска на один запрос: читает run.json, сверяет файлы с диском (расхождение — новая версия
   * с автором «снаружи», у оборвавшегося запуска — «неизвестно») и сохраняет run.json сразу. undefined — у запуска нет артефактов.
   */
  static open(runDir: string, opts: { now?: () => Date; emit?: (e: ArtifactsEvent) => void; readonly?: boolean } = {}): ArtifactStore | undefined {
    const file = path.join(runDir, 'run.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as StoreReport;
    const { readonly, ...rest } = opts;
    const art = raw.artifacts;
    if (!art || !Array.isArray(art.items)) return undefined;
    const seen = new Set<string>();
    const items = art.items.filter((m) => {
      const ok = m && isArtifactKey(m.key) && !seen.has(m.key) && !artifactFileProblem(m.file) && Array.isArray(m.versions);
      if (ok) seen.add(m.key);
      return ok;
    });
    const declared = items.map((m) => ({ key: m.key, title: typeof m.title === 'string' && m.title ? m.title : m.key, file: m.file, decisions: m.decisions === true }));
    const persist = readonly
      ? () => {
          throw new Error('Хранилище открыто только для чтения');
        }
      : () => fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const store = new ArtifactStore({ runDir, declared, report: raw, persist, ...rest });
    store.readonly = Boolean(readonly);
    const dirPath = path.join(runDir, ARTIFACTS_DIR);
    const st = fs.lstatSync(dirPath, { throwIfNoEntry: false });
    if (!st?.isDirectory()) throw new Error(`Папки артефактов нет или это не каталог: ${dirPath}`);
    store.dir = fs.realpathSync.native(dirPath);
    store.runsDir = fs.realpathSync.native(path.dirname(fs.realpathSync.native(runDir)));
    store.state = { ...art, items, warnings: Array.isArray(art.warnings) ? art.warnings : [] };
    raw.artifacts = store.state;
    store.historyBytes = items.reduce((n, m) => n + m.versions.filter((v) => v.stored).reduce((s, v) => s + (v.size || 0), 0), 0);
    store.rebuildFiles();
    // только чтение (GET, запуск из CLI): run.json не трогаем — его может писать чужой процесс
    if (readonly) return store;
    let changed = false;
    for (const m of items) {
      const cur = store.stateOf(m);
      if (cur && cur.hash !== m.hash) {
        store.record(m, changedAfter(raw, store.now()), undefined);
        changed = true;
      }
    }
    if (changed) store.o.persist();
    return store;
  }

  // ---------- шаг

  /**
   * Перед шагом: папка на месте; посторонние каталоги, ссылки, файлы на точку и с зарезервированными именами — в карантин;
   * исчезнувшие и подменённые артефакты — заново; жёсткие ссылки — копией; изменения между шагами — автор «снаружи».
   * Предупреждения — тому, после кого нашли (последний шаг; до первого шага — уровень запуска).
   */
  prepareStep(): void {
    const step = this.last;
    const after = stepName(step);
    let changed = false;
    this.quarantineDir = undefined;
    this.ensureTmp();
    const dirPath = path.join(this.runDir, ARTIFACTS_DIR);
    const st = fs.lstatSync(dirPath, { throwIfNoEntry: false });
    if (!st?.isDirectory()) {
      const moved = st ? this.quarantine(dirPath, ARTIFACTS_DIR) : undefined;
      fs.mkdirSync(dirPath);
      this.warn(
        `Папка артефактов ${moved ? `подменена (перенесена в ${moved})` : 'исчезла'} ${after}: создана заново, артефакты созданы пустыми. Прежние версии — в истории запуска.`,
        step,
      );
      changed = true;
    }
    if (fs.realpathSync.native(dirPath) !== this.dir) throw new Error(`Папка артефактов ${dirPath} сменила расположение: продолжать нельзя`);

    const byLower = new Map(this.state.items.map((m) => [m.file.toLowerCase(), m]));
    for (const name of fs.readdirSync(dirPath)) {
      const full = path.join(dirPath, name);
      const s = fs.lstatSync(full, { throwIfNoEntry: false });
      if (!s) continue;
      const m = byLower.get(name.toLowerCase());
      // файл артефакта; на регистронезависимой ФС «Plan.md» и «plan.md» — один файл
      if (m && (name === m.file || sameFile(full, path.join(dirPath, m.file)))) continue;
      if (!s.isFile() || name.startsWith('.') || artifactFileProblem(name)) {
        const moved = this.quarantine(full, name);
        const what = s.isSymbolicLink() ? 'ссылка' : s.isDirectory() ? 'каталог' : s.isFile() ? 'файл' : 'не обычный файл';
        this.warn(`В папке артефактов ${after} появился ${what} ${name}, не объявленный артефактом: перенесён в ${moved}, этапы его не увидят. Проверь, кто его создал.`, step);
        changed = true;
      } else if (!this.warnedForeign.has(name)) {
        this.warnedForeign.add(name);
        this.warn(`В папке артефактов ${after} появился файл ${name}, не объявленный артефактом: оставлен на месте, артефактом он не станет.`, step);
        changed = true;
      }
    }

    for (const m of this.state.items) {
      const file = path.join(dirPath, m.file);
      const s = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!s || !s.isFile()) {
        const moved = s ? this.quarantine(file, m.file) : undefined;
        this.writeFile(m.file, '');
        this.record(m, { kind: 'outside', at: this.now() }, step);
        this.warn(
          moved
            ? `Артефакт «${m.title}» ${after} оказался ${s!.isSymbolicLink() ? 'ссылкой' : 'не обычным файлом'}: перенесён в ${moved}, создан пустой файл. Прежняя версия — в истории.`
            : `Артефакт «${m.title}» исчез ${after}: создан пустым. Прежняя версия — в истории.`,
          step,
          m.key,
        );
        changed = true;
        continue;
      }
      if (s.nlink > 1) {
        this.writeFile(m.file, fs.readFileSync(file));
        this.warn(`Файл артефакта «${m.title}» ${after} имел несколько жёстких ссылок: пересоздан копией, содержимое сохранено.`, step, m.key);
        changed = true;
      }
      const cur = this.stateOf(m);
      if (cur && cur.hash !== m.hash) {
        this.record(m, { kind: 'outside', at: this.now() }, step);
        changed = true;
      }
    }
    if (changed) {
      this.o.persist();
      this.emit(this.deltaOf(step));
    }
  }

  /** Шаг начался: пишущие этапы блокируют свои артефакты для правки через API. */
  beginStep(step: StepRef): void {
    this.current = step;
    this.locks.clear();
    this.stepDirty = false;
    if (step.kind === 'phases') {
      for (const m of step.members) for (const k of m.access.write) this.locks.set(k, [...(this.locks.get(k) ?? []), m.name]);
    }
    if (this.locks.size) this.emit();
  }

  /**
   * Подстановки шага: путь — у всех артефактов, содержимое — у тех, на кого ссылаются шаблоны участников:
   * до 32 КБ — текст, больше — карта всего файла (mapped).
   */
  snapshot(templates: string[]): Record<string, { text: string; path: string; mapped?: boolean }> {
    const inline = new Set(templates.flatMap((t) => referencedArtifacts(t).content));
    const out: Record<string, { text: string; path: string; mapped?: boolean }> = Object.create(null);
    for (const m of this.state.items) {
      const file = path.join(this.dir, m.file);
      if (!inline.has(m.key)) {
        out[m.key] = { text: '', path: file };
        continue;
      }
      const sub = this.substitutionOf(m, file);
      out[m.key] = { text: sub.text, path: file, ...(sub.mapped ? { mapped: true } : {}) };
    }
    return out;
  }

  /**
   * Раздел «Артефакты запуска» для этих прав: артефакты в порядке объявления, автор и время на сейчас.
   * mapped — ключи, чью карту этап получил в промпте: пишущему такой артефакт раздел велит перечитать файл после правок;
   * inline — ключи, чей текст целиком уже в промпте: раздел говорит, что файл ради содержимого читать не нужно.
   */
  section(access: ArtifactAccess, mapped: Iterable<string> = [], inline: Iterable<string> = []): string {
    const withMap = new Set(mapped);
    const withText = new Set(inline);
    const any = this.state.items.some((m) => access.read.includes(m.key));
    return artifactSection(
      this.state.items
        .filter((m) => access.read.includes(m.key))
        .map((m) => {
          const last = m.versions.at(-1);
          return {
            title: m.title,
            path: path.join(this.dir, m.file),
            write: access.write.includes(m.key),
            author: last?.author ?? { kind: 'empty' },
            ...(last?.fromRun ? { fromRun: last.fromRun } : {}),
            ...(withMap.has(m.key) ? { mapped: true } : {}),
            ...(withText.has(m.key) ? { inline: true } : {}),
            ...(m.decisions ? { decisions: true } : {}),
          };
        }),
      { tool: Boolean(this.o.readTool && any) },
    );
  }

  /** Свои артефакты этапа (читаемые) для инструмента чтения по ключу. */
  sources(access: ArtifactAccess): ArtifactSource[] {
    return this.state.items.filter((m) => access.read.includes(m.key)).map((m) => ({ key: m.key, title: m.title, path: path.join(this.dir, m.file), file: m.file }));
  }

  /** Права, раздел и подстановки судьи: читает все артефакты. */
  forJudge(rubric: string): PhaseArtifacts {
    const access = judgeAccess({ artifacts: Object.fromEntries(this.decl.map((a) => [a.key, {}])) });
    return { dir: this.dir, access, section: this.section(access), snapshot: this.snapshot([rubric]), ...(this.o.readTool ? { sources: this.sources(access) } : {}) };
  }

  /** Подстановка содержимого: до 32 КБ — текст, до 8 МБ — карта по разделам, больше — карта частями по строкам. */
  private substitutionOf(m: ArtifactMeta, file: string): { text: string; mapped: boolean } {
    let fd: number;
    try {
      fd = fs.openSync(file, READ_FLAGS);
    } catch {
      return { text: '', mapped: false };
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { text: '', mapped: false };
      const o = { title: m.title, path: file, file: m.file, size: st.size, tool: this.o.readTool };
      if (st.size <= HASH_MAX) return substitution(readFd(fd, st.size).toString('utf8'), o);
      return { text: artifactMapParts(countLines(fd, st.size), o).text, mapped: true };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Проверка перед вызовом инструмента для этапа с этими tools и правами; onDeny считает отказы. */
  guard(tools: string[], access: ArtifactAccess, onDeny?: (tool: string, reason: DenialReason) => void): Guard {
    const scope: GuardScope = { access, tools, dir: this.dir, runsDir: this.runsDir, files: this.files, titles: this.titles, probe: nodeProbe };
    return (tool, input, ctx) => {
      const d = artifactGuardDecision(scope, tool, input, ctx?.cwd ?? process.cwd());
      if (!d) return undefined;
      onDeny?.(tool, d.reason);
      return d.message;
    };
  }

  /**
   * Шаг закончился (на любом выходе): изменения за шаг получают автора — пишущий этап, «условие» или «неизвестно»
   * с предупреждением; сохраняются версии. Идемпотентно.
   */
  finishStep(step: StepRef): void {
    if (step.finished) return;
    step.finished = true;
    const holders = step.kind === 'phases' ? step.members.map((m) => m.report) : [step.report];
    for (const h of holders) if (h) h.artifacts ??= { changed: [], warnings: [] };
    for (const m of this.state.items) {
      const cur = this.stateOf(m);
      // исчезнувший, подменённый или со второй жёсткой ссылкой — забота prepareStep
      if (!cur || cur.nlink > 1 || cur.hash === m.hash) continue;
      const at = this.now();
      let author: ArtifactAuthor;
      let holder: StepHolder | undefined;
      if (step.kind === 'condition') {
        author = { kind: 'condition', block: step.block, iteration: step.iteration, at };
        holder = step.report;
      } else {
        const w = step.members.find((x) => x.access.write.includes(m.key));
        if (w) {
          author = { kind: 'phase', block: step.block, iteration: step.iteration, phase: w.name, at };
          holder = w.report;
        } else {
          author = { kind: 'unknown', block: step.block, iteration: step.iteration, phase: step.members[0]?.name ?? '', at };
          this.warn(
            `Артефакт «${m.title}» изменён во время ${stepName(step, true)} не через UI: этап без права записи (например, через Bash) или правка снаружи. Содержимое не откатано: проверь артефакт, прежняя версия — в истории.`,
            step,
          );
        }
      }
      this.record(m, author, step);
      if (holder) holder.artifacts!.changed.push(m.key);
      this.stepDirty = true;
    }
    if (step.kind === 'phases' && step.members.some((m) => m.report?.denials?.length)) this.stepDirty = true;
    this.last = step;
  }

  /** Блокировка снята. Если шаг что-то поменял или что-то блокировал — сохранение и событие с итогом шага. */
  endStep(): void {
    const step = this.current;
    this.current = undefined;
    const hadLocks = this.locks.size > 0;
    this.locks.clear();
    if (this.stepDirty) this.o.persist();
    if (this.stepDirty || hadLocks) this.emit(step?.finished ? this.deltaOf(step) : undefined);
    this.stepDirty = false;
  }

  // ---------- правка пользователем

  /**
   * Запись через API (UI, скилл). Отказ: идёт пишущий шаг — locked; файл изменился после base — conflict с автором и временем;
   * больше 1 МБ — too_big. Успех — версия с автором «пользователь» и этапы идущего шага, которые уже прочли прежнюю версию.
   */
  userWrite(key: string, text: string, base: string, via: 'ui' | 'skill'): WriteResult {
    if (this.readonly) throw new Error('Хранилище открыто только для чтения');
    const m = this.meta(key);
    if (!m) return { ok: false, code: 'unknown_key', message: `Нет артефакта ${key}` };
    const locked = this.locks.get(key);
    if (locked?.length) return { ok: false, code: 'locked', phases: locked, message: `Артефакт пишет этап ${locked.join(', ')}: правка откроется после конца шага` };
    const buf = Buffer.from(text, 'utf8');
    if (buf.length > EDIT_MAX) return { ok: false, code: 'too_big', message: 'Текст больше 1 МБ' };
    this.ensureTmp();
    const cur = this.stateOf(m);
    if (!cur) return { ok: false, code: 'missing', message: `Файла артефакта нет на диске: перед следующим шагом он будет создан пустым` };
    if (cur.hash !== base) {
      const last = m.versions.at(-1);
      const author: ArtifactAuthor = cur.hash === m.hash && last ? last.author : { kind: 'outside', at: new Date(cur.mtimeMs).toISOString() };
      const at = 'at' in author ? author.at : last?.at;
      return { ok: false, code: 'conflict', hash: cur.hash, author, ...(at ? { at } : {}), message: 'Файл изменён после того, как ты его открыл' };
    }
    // изменение снаружи, которое ещё не записано, — отдельной версией до правки пользователя
    if (cur.hash !== m.hash) this.record(m, { kind: 'outside', at: new Date(cur.mtimeMs).toISOString() }, undefined);
    this.writeFile(m.file, buf);
    const author: ArtifactAuthor = { kind: 'user', via, at: this.now() };
    this.record(m, author, undefined);
    this.o.persist();
    this.emit();
    const step = this.current;
    const readers = step?.kind === 'phases' ? step.members.filter((x) => x.access.read.includes(key)).map((x) => x.name) : [];
    return { ok: true, hash: m.hash, author, readers };
  }

  /**
   * Ответ на паузу по просьбе агента: запись в конец артефакта decisions (дата и время, блок, итерация, этап,
   * вопросы этапа цитатой, ответ) и answer в записи паузы report.pauses. Ошибка — ничего не записано.
   */
  appendAnswer(text: string, via: 'ui' | 'skill'): AnswerResult {
    if (this.readonly) throw new Error('Хранилище открыто только для чтения');
    const m = this.state.items.find((x) => x.decisions);
    if (!m) return { ok: false, code: 'no_decisions', message: 'Во flow нет артефакта с decisions: true' };
    const answer = text.trim();
    if (!answer) return { ok: false, code: 'empty', message: 'Пустой ответ' };
    if (Buffer.byteLength(answer) > ANSWER_MAX) return { ok: false, code: 'too_big', message: 'Ответ больше 64 КБ' };
    const pause = [...(this.o.report.pauses ?? [])].reverse().find((p) => !p.resumedAt);
    if (!pause) return { ok: false, code: 'not_paused', message: 'Запуск не на паузе по просьбе агента' };
    const locked = this.locks.get(m.key);
    if (locked?.length) return { ok: false, code: 'locked', message: `Артефакт пишет этап ${locked.join(', ')}` };
    this.ensureTmp();
    const file = path.join(this.dir, m.file);
    let cur = this.stateOf(m);
    if (!cur) {
      if (fs.lstatSync(file, { throwIfNoEntry: false })) return { ok: false, code: 'missing', message: `Файл ${m.file} — не обычный файл` };
      this.writeFile(m.file, '');
      cur = this.stateOf(m)!;
    }
    if (!cur.content) return { ok: false, code: 'too_big', message: `Файл ${m.file} больше 8 МБ: ответ не дописан` };
    if (cur.hash !== m.hash) this.record(m, { kind: 'outside', at: new Date(cur.mtimeMs).toISOString() }, undefined);
    const at = this.now();
    const entry = [
      `## Ответ на паузу — ${fmtWhen(at)}`,
      '',
      `Блок ${pause.block}, итерация ${pause.iteration}, этап ${pause.phase}.`,
      '',
      'Вопросы этапа:',
      (pause.text.trim() || '(этап не написал вопросов)').split('\n').map((l) => `> ${l}`.trimEnd()).join('\n'),
      '',
      'Ответ:',
      answer,
      '',
    ].join('\n');
    const before = cur.content.toString('utf8');
    const sep = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    this.writeFile(m.file, before + sep + entry);
    this.record(m, { kind: 'user', via, at }, undefined);
    pause.answer = { text: answer, via, at };
    this.o.persist();
    this.emit();
    return { ok: true, hash: m.hash };
  }

  // ---------- чтение

  list(): ArtifactLite[] {
    return this.state.items.map((m) => {
      const last = m.versions.at(-1);
      return {
        key: m.key,
        title: m.title,
        file: m.file,
        size: m.size,
        hash: m.hash,
        author: last?.author ?? { kind: 'empty' },
        ...(last?.at ? { at: last.at } : {}),
        versions: m.versions.length,
        lockedBy: this.locks.get(m.key) ?? [],
        ...(m.decisions ? { decisions: true as const } : {}),
        ...(m.fromRun ? { fromRun: m.fromRun } : {}),
        // из run.json чужого процесса — только числа
        ...(typeof m.tasks?.open === 'number' && typeof m.tasks.done === 'number' ? { tasks: { open: m.tasks.open, done: m.tasks.done } } : {}),
      };
    });
  }

  /** Этапы, которые сейчас пишут артефакт. */
  lockedBy(key: string): string[] {
    return this.locks.get(key) ?? [];
  }

  /** Есть ли во flow артефакт для ответов на паузу (decisions: true). */
  hasDecisions(): boolean {
    return this.state.items.some((m) => m.decisions);
  }

  /** Откуда взяты артефакты при продолжении и предупреждения уровня запуска. */
  runInfo(): { from?: string; warnings: string[] } {
    return { ...(this.state.from ? { from: this.state.from } : {}), warnings: [...this.state.warnings] };
  }

  /** Файл артефакта без чтения содержимого: абсолютный путь, есть ли обычный файл, его размер. undefined — нет такого ключа. */
  fileInfo(key: string): { path: string; present: boolean; size: number } | undefined {
    const m = this.meta(key);
    if (!m) return undefined;
    const file = path.join(this.dir, m.file);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    return { path: file, present: Boolean(st?.isFile()), size: st?.isFile() ? st.size : 0 };
  }

  /** Версии артефакта (метаданные). */
  versionsOf(key: string): ArtifactMeta['versions'] | undefined {
    return this.meta(key)?.versions.map((v) => ({ ...v }));
  }

  read(key: string): ReadResult {
    const m = this.meta(key);
    if (!m) return { ok: false, code: 'unknown_key', message: `Нет артефакта ${key}` };
    const cur = this.stateOf(m);
    if (!cur) return { ok: false, code: 'missing', message: 'Файл исчез с диска: перед следующим шагом он будет создан пустым' };
    if (!cur.content) return { ok: false, code: 'too_big', message: `Файл больше 8 МБ: ${path.join(this.dir, m.file)}` };
    return { ok: true, text: cur.content.toString('utf8'), hash: cur.hash, size: cur.size, mtimeMs: cur.mtimeMs, meta: m };
  }

  readVersion(key: string, n: number): VersionResult {
    const m = this.meta(key);
    if (!m) return { ok: false, code: 'unknown_key', message: `Нет артефакта ${key}` };
    const v = m.versions.find((x) => x.n === n);
    if (!v) return { ok: false, code: 'unknown_version', message: `Нет версии ${n}` };
    const base = { ok: true as const, n: v.n, at: v.at, author: v.author, size: v.size };
    if (!v.stored) return { ...base, stored: false };
    const file = path.join(this.runDir, HISTORY_DIR, m.key, versionFile(v.n, m.file));
    const content = readRegular(file);
    if (content === undefined) return { ok: false, code: 'missing', message: `Копии версии ${n} нет на диске` };
    return { ...base, stored: true, text: content.toString('utf8') };
  }

  // ---------- внутреннее

  private meta(key: string): ArtifactMeta | undefined {
    return this.state.items.find((m) => m.key === key);
  }

  private rebuildFiles(): void {
    this.files.clear();
    for (const m of this.state.items) this.files.set(path.join(this.dir, m.file), m.key);
  }

  private emit(step?: StepDelta): void {
    this.o.emit?.({ type: 'artifacts', items: this.list(), ...(step ? { step } : {}) });
  }

  /** Предупреждение — в отчёт того, после кого нашли: пишущий этот артефакт участник, иначе первый участник; нет — уровень запуска. */
  private warn(text: string, step: StepRef | undefined, key?: string): void {
    let holder: StepHolder | undefined;
    if (step?.kind === 'condition') holder = step.report;
    else if (step) {
      const withReport = step.members.filter((m) => m.report);
      holder = ((key !== undefined ? withReport.find((m) => m.access.write.includes(key)) : undefined) ?? withReport[0])?.report;
    }
    if (holder) (holder.artifacts ??= { changed: [], warnings: [] }).warnings.push(text);
    else this.state.warnings.push(text);
    this.stepDirty = true;
  }

  private deltaOf(step: StepRef | undefined): StepDelta {
    const run = [...this.state.warnings];
    if (!step) return { phases: [], run };
    if (step.kind === 'condition') {
      const a = step.report?.artifacts;
      return { block: step.block, iteration: step.iteration, phases: [], condition: { changed: [...(a?.changed ?? [])], warnings: [...(a?.warnings ?? [])] }, run };
    }
    return {
      block: step.block,
      iteration: step.iteration,
      phases: step.members
        .filter((m) => m.report)
        .map((m) => ({
          phase: m.name,
          changed: [...(m.report!.artifacts?.changed ?? [])],
          warnings: [...(m.report!.artifacts?.warnings ?? [])],
          denials: (m.report!.denials ?? []).map((d) => ({ ...d })),
        })),
      run,
    };
  }

  /** Новая версия текущего содержимого файла. Копия — если файл до 1 МБ и история запуска не больше 200 МБ. */
  private record(m: ArtifactMeta, author: ArtifactAuthor, step: StepRef | undefined, fromRun?: string): void {
    const cur = this.stateOf(m);
    if (!cur) return;
    const n = (m.versions.at(-1)?.n ?? 0) + 1;
    let stored = false;
    if (cur.content && cur.size <= EDIT_MAX && this.historyBytes + cur.size <= HISTORY_MAX) {
      const dir = path.join(this.runDir, HISTORY_DIR, m.key);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, versionFile(n, m.file)), cur.content, { flag: 'wx' });
      this.historyBytes += cur.size;
      stored = true;
    } else {
      this.warn(`Версия ${n} артефакта «${m.title}» сохранена без копии содержимого: файл больше 1 МБ или история запуска больше 200 МБ.`, step, m.key);
    }
    m.versions.push({ n, at: this.now(), author, size: cur.size, stored, ...(fromRun ? { fromRun } : {}) });
    m.size = cur.size;
    m.hash = cur.hash;
    m.mtimeMs = cur.mtimeMs;
    // пункты чек-листа — вместе с хэшем, чтобы список отдавал их без чтения файлов
    const tasks = cur.content ? artifactTasks(m.file, cur.content.toString('utf8')) : undefined;
    if (tasks) m.tasks = tasks;
    else delete m.tasks;
  }

  /** Состояние файла артефакта без следования ссылкам; undefined — нет или не обычный файл. */
  private stateOf(m: ArtifactMeta): FileState | undefined {
    let fd: number;
    try {
      fd = fs.openSync(path.join(this.dir, m.file), READ_FLAGS);
    } catch {
      return undefined;
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return undefined;
      const content = st.size <= HASH_MAX ? readFd(fd, st.size) : undefined;
      return { size: st.size, mtimeMs: st.mtimeMs, nlink: st.nlink, hash: content ? hashOf(content) : `size:${st.size}:mtime:${st.mtimeMs}`, content };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Атомарная запись без следования ссылкам: временный файл (wx) в runs/<id>/.tmp и rename на место артефакта. */
  private writeFile(file: string, data: string | Buffer): void {
    const tmp = path.join(this.runDir, TMP_DIR, `${randomUUID()}.tmp`);
    const fd = fs.openSync(tmp, 'wx', 0o644);
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, path.join(this.dir, file));
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  /** Папка временных файлов — настоящий каталог, не ссылка. */
  private ensureTmp(): void {
    const tmp = path.join(this.runDir, TMP_DIR);
    const st = fs.lstatSync(tmp, { throwIfNoEntry: false });
    if (st?.isDirectory()) return;
    if (st) this.quarantine(tmp, TMP_DIR);
    fs.mkdirSync(tmp);
  }

  /** Перенос в runs/<id>/artifacts-quarantine/<время>/; возвращает путь от папки запуска. */
  private quarantine(full: string, name: string): string {
    this.quarantineDir ??= path.join(this.runDir, QUARANTINE_DIR, this.now().replace(/[:.]/g, '-'));
    fs.mkdirSync(this.quarantineDir, { recursive: true });
    let target = path.join(this.quarantineDir, name);
    for (let i = 2; fs.lstatSync(target, { throwIfNoEntry: false }); i++) target = path.join(this.quarantineDir, `${name}-${i}`);
    fs.renameSync(full, target);
    return path.relative(this.runDir, target);
  }
}

/** Подсчёт отказа guard в списке этапа. */
export function countDenial(list: Denial[], tool: string, reason: DenialReason): void {
  const d = list.find((x) => x.tool === tool && x.reason === reason);
  if (d) d.count++;
  else list.push({ tool, reason, count: 1 });
}

function stepName(step: StepRef | undefined, during = false): string {
  if (!step) return during ? 'старта запуска' : 'до первого шага';
  const where = step.kind === 'condition' ? `проверки условия` : step.members.length > 1 ? `шага ${step.members.map((m) => m.name).join(', ')}` : `этапа ${step.members[0]?.name ?? ''}`;
  const iter = `${step.block !== 'main' ? `блок ${step.block}, ` : ''}итерация ${step.iteration}`;
  return during ? `${where} (${iter})` : `после ${where} (${iter})`;
}

/** Автор изменения, найденного при сверке с диском после конца запуска: у оборвавшегося — «неизвестно» с его последним этапом. */
function changedAfter(r: StoreReport, at: string): ArtifactAuthor {
  const last = r.status === 'running' ? r.phases?.at(-1) : undefined;
  return last ? { kind: 'unknown', block: last.block, iteration: last.iteration, phase: last.phase, at } : { kind: 'outside', at };
}

function readPrevious(runDir: string, warnings: string[]): (StoreReport & { items: Map<string, ArtifactMeta> }) | undefined {
  let raw: StoreReport;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) as StoreReport;
  } catch (err) {
    warnings.push(`Артефакты прошлого запуска не прочитаны: ${err instanceof Error ? err.message : String(err)}. Созданы заново.`);
    return undefined;
  }
  const items = new Map<string, ArtifactMeta>();
  for (const m of raw.artifacts?.items ?? []) {
    if (!m || !isArtifactKey(m.key) || items.has(m.key) || artifactFileProblem(m.file) || !Array.isArray(m.versions)) continue;
    items.set(m.key, m);
  }
  return { ...raw, items };
}

/** Текущий файл артефакта прошлого запуска: только обычный файл в его папке артефактов, не больше 64 МБ. */
function readPreviousFile(runDir: string, m: ArtifactMeta, warnings: string[]): Buffer | undefined {
  const dir = path.join(runDir, ARTIFACTS_DIR);
  const file = path.join(dir, m.file);
  if (path.dirname(file) !== dir) return undefined;
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (!st.isFile() || st.size > COPY_MAX) {
    warnings.push(`Артефакт «${m.title ?? m.key}» прошлого запуска не перенесён: ${st.isFile() ? 'файл больше 64 МБ' : 'не обычный файл'}. Создан заново.`);
    return undefined;
  }
  return readRegular(file);
}

function readRegular(file: string): Buffer | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, READ_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const st = fs.fstatSync(fd);
    return st.isFile() ? readFd(fd, st.size) : undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Число строк большого файла без чтения целиком (как у Read: завершающий перевод строки лишней строки не даёт). */
function countLines(fd: number, size: number): number {
  const buf = Buffer.alloc(1024 * 1024);
  let lines = 0;
  let last = 0x0a;
  for (let off = 0; off < size; ) {
    const n = fs.readSync(fd, buf, 0, buf.length, off);
    if (n <= 0) break;
    for (let i = 0; i < n; i++) if (buf[i] === 0x0a) lines++;
    last = buf[n - 1];
    off += n;
  }
  return size === 0 ? 0 : last === 0x0a ? lines : lines + 1;
}

function readFd(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = fs.readSync(fd, buf, off, size - off, off);
    if (n <= 0) break;
    off += n;
  }
  return off === size ? buf : buf.subarray(0, off);
}

function hashOf(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Один и тот же элемент каталога (без следования ссылкам): на регистронезависимой ФС «Plan.md» и «plan.md». */
function sameFile(a: string, b: string): boolean {
  const x = fs.lstatSync(a, { throwIfNoEntry: false });
  const y = fs.lstatSync(b, { throwIfNoEntry: false });
  return Boolean(x && y && x.ino === y.ino && x.dev === y.dev);
}

function versionFile(n: number, file: string): string {
  return `${String(n).padStart(4, '0')}${path.extname(file).toLowerCase()}`;
}
