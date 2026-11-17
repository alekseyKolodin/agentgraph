// Файлы рутин в папке настроек (configDir()): routines/<slug>.yaml, sources/<slug>.yaml, recipes/<slug>.yaml,
// secrets.json (0600, наружу не отдаётся) и routines-state/ — seen, cursors, log (jsonl), waits, catchup, last-check,
// очередь и события рутин (для проверки словами и «на истории»). Пути — только по проверенному слагу.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { configDir } from '../settings.js';
import { readRegular, writeAtomic } from '../safe-fs.js';
import { assertSlug, parseRoutineYaml, parseSourceYaml, SLUG_RE, toYaml, type Parsed } from './schema.js';
import type { CatchUp, Feedback, LogEntry, LogOutcome, RoutineEvent, RoutineSpec, RoutineWait, SourceSpec } from './types.js';

const FILE_MAX = 1024 * 1024;
const LOG_MAX = 8 * 1024 * 1024;
/** Виденных id на источник: больше — забываем самые старые. */
export const SEEN_MAX = 2000;
/** Последних событий источника для «Проверить на истории». */
export const HISTORY_MAX = 50;
/** Запущенных событий рутины для поиска дублей и «Это не баг» для отрицательных примеров. */
export const STARTED_MAX = 20;
export const REJECTED_MAX = 20;
/** Строк журнала рутины: при перезаписи старые обрезаются. */
export const LOG_KEEP = 2000;

export type FileEntry<T> = { slug: string; yaml: string } & Parsed<T>;

/** Строка «догнать» вместе с событиями, которые она прогонит. */
export type CatchUpRecord = CatchUp & { items: RoutineEvent[]; matchingIds: string[] };

/** Событие, ждущее очереди parallel. */
export type QueueItem = { routine: string; event: RoutineEvent; at: string; /** Строка журнала limit, которая станет started. */ logId?: string; /** Решение человека: per_day не действует. */ human?: boolean };

/** Обратная связь на диске: со снимком события — для примеров проверки словами. */
export type FeedbackRecord = Feedback & { at: string; event?: RoutineEvent };

/** Ожидание на диске: со строкой журнала, которую правит ответ человека. */
export type StoredWait = RoutineWait & { logId?: string };

export class RoutineStore {
  constructor(readonly root: string = configDir()) {}

  private dir(...p: string[]): string {
    return path.join(this.root, ...p);
  }

  private ensure(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ------------------------------------------------------------ правила и источники

  private list<T>(sub: string, parse: (t: string) => Parsed<T>): FileEntry<T>[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir(sub));
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.yaml') && SLUG_RE.test(n.slice(0, -5)))
      .sort()
      .map((n) => this.read(sub, n.slice(0, -5), parse)!)
      .filter(Boolean);
  }

  private read<T>(sub: string, slug: string, parse: (t: string) => Parsed<T>): FileEntry<T> | undefined {
    // недопустимый слаг (ссылка из битого правила) — файла нет, а не исключение: битое правило не валит движок
    if (!SLUG_RE.test(slug)) return undefined;
    let yaml: string | undefined;
    try {
      yaml = readRegular(this.dir(sub, `${slug}.yaml`), { max: FILE_MAX, follow: false });
    } catch (err) {
      return { slug, yaml: '', problems: [err instanceof Error ? err.message : String(err)] };
    }
    if (yaml === undefined) return undefined;
    return { slug, yaml, ...parse(yaml) };
  }

  private write(sub: string, slug: string, text: string): void {
    assertSlug(slug);
    writeAtomic(path.join(this.ensure(this.dir(sub)), `${slug}.yaml`), text);
  }

  private remove(sub: string, slug: string): boolean {
    assertSlug(slug);
    const f = this.dir(sub, `${slug}.yaml`);
    if (!fs.existsSync(f)) return false;
    fs.rmSync(f);
    return true;
  }

  routines = () => this.list('routines', parseRoutineYaml);
  routine = (slug: string) => this.read('routines', slug, parseRoutineYaml);
  /** Пишет spec или текст YAML как есть (ручная правка «Открыть YAML» сохраняет комментарии). */
  writeRoutine = (slug: string, specOrYaml: RoutineSpec | string) => this.write('routines', slug, typeof specOrYaml === 'string' ? specOrYaml : toYaml(specOrYaml));
  deleteRoutine = (slug: string) => this.remove('routines', slug);

  sources = () => this.list('sources', parseSourceYaml);
  source = (slug: string) => this.read('sources', slug, parseSourceYaml);
  writeSource = (slug: string, spec: SourceSpec) => this.write('sources', slug, toYaml(spec));
  deleteSource = (slug: string) => this.remove('sources', slug);

  recipes = () => this.list('recipes', parseSourceYaml);
  writeRecipe = (slug: string, yaml: string) => this.write('recipes', slug, yaml);
  recipeFile = (slug: string) => this.dir('recipes', `${slug}.yaml`);

  // ------------------------------------------------------------ ключи

  private secretsFile = () => this.dir('secrets.json');

  secrets(): Record<string, string> {
    try {
      const raw = JSON.parse(readRegular(this.secretsFile(), { max: FILE_MAX, follow: false }) ?? '{}') as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return {};
    }
  }

  secret = (name: string): string | undefined => this.secrets()[name] || undefined;
  hasSecret = (name: string): boolean => Boolean(this.secret(name));

  /** Дописывает ключи (пустое значение — удаляет). Файл — 0600: создаётся сразу с этими правами. */
  setSecrets(patch: Record<string, string>): void {
    const next = this.secrets();
    for (const [k, v] of Object.entries(patch)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Недопустимое имя ключа: ${k}`);
      if (v) next[k] = v;
      else delete next[k];
    }
    const file = this.secretsFile();
    this.ensure(this.root);
    const tmp = path.join(this.root, `.secrets.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  // ------------------------------------------------------------ состояние

  private stateFile = (...p: string[]) => this.dir('routines-state', ...p);

  private readJson<T>(file: string, fallback: T): T {
    try {
      const t = readRegular(file, { max: FILE_MAX * 8, follow: false });
      return t === undefined ? fallback : (JSON.parse(t) as T);
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, v: unknown): void {
    this.ensure(path.dirname(file));
    writeAtomic(file, JSON.stringify(v));
  }

  private keyed(sub: string, key: string): string {
    // ключи — слаги источников и рутин, а также 'schedule'
    assertSlug(key);
    return this.stateFile(sub, `${key}.json`);
  }

  seen(source: string): string[] {
    return this.readJson<string[]>(this.keyed('seen', source), []);
  }

  hasSeen(source: string, id: string): boolean {
    return this.seen(source).includes(id);
  }

  /** Добавляет id в виденные (не больше SEEN_MAX, старые забываются). */
  addSeen(source: string, ids: string[]): void {
    if (!ids.length) return;
    const cur = this.seen(source);
    const set = new Set(cur);
    for (const id of ids) if (!set.has(id)) cur.push(id), set.add(id);
    this.writeJson(this.keyed('seen', source), cur.slice(-SEEN_MAX));
  }

  cursor = (source: string): unknown => this.readJson<{ v?: unknown }>(this.keyed('cursors', source), {}).v;
  setCursor = (source: string, v: unknown): void => this.writeJson(this.keyed('cursors', source), { v });

  /** Последние события источника (свежие в конце) — для «Проверить на истории». */
  history = (source: string): RoutineEvent[] => this.readJson<RoutineEvent[]>(this.keyed('history', source), []);
  addHistory(source: string, events: RoutineEvent[]): void {
    if (!events.length) return;
    const ids = new Set(events.map((e) => e.id));
    this.writeJson(this.keyed('history', source), [...this.history(source).filter((e) => !ids.has(e.id)), ...events].slice(-HISTORY_MAX));
  }

  /** События рутины: запущенные (дубли) и отклонённые человеком (отрицательные примеры). */
  events(routine: string): { started: RoutineEvent[]; rejected: RoutineEvent[] } {
    const r = this.readJson<{ started?: RoutineEvent[]; rejected?: RoutineEvent[] }>(this.keyed('events', routine), {});
    return { started: r.started ?? [], rejected: r.rejected ?? [] };
  }

  addEvent(routine: string, kind: 'started' | 'rejected', e: RoutineEvent): void {
    const cur = this.events(routine);
    const list = [...cur[kind].filter((x) => !(x.source === e.source && x.id === e.id)), e].slice(-(kind === 'started' ? STARTED_MAX : REJECTED_MAX));
    this.writeJson(this.keyed('events', routine), { ...cur, [kind]: list });
  }

  // журнал

  private logFile = (routine: string) => this.keyed('log', routine);

  /** Журнал рутины по порядку записи (старые первыми). */
  logAll(routine: string): LogEntry[] {
    let text: string | undefined;
    try {
      text = readRegular(this.logFile(routine), { max: LOG_MAX, follow: false });
    } catch {
      return [];
    }
    const out: LogEntry[] = [];
    for (const line of (text ?? '').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LogEntry);
      } catch {
        /* битая строка не валит журнал */
      }
    }
    return out;
  }

  /** Новые сверху, с фильтром по исходам. */
  log(routine: string, o: { outcomes?: LogOutcome[]; limit?: number } = {}): LogEntry[] {
    const all = this.logAll(routine).reverse();
    const f = o.outcomes?.length ? all.filter((e) => o.outcomes!.includes(e.outcome)) : all;
    return o.limit ? f.slice(0, o.limit) : f;
  }

  appendLog(entry: LogEntry): void {
    const file = this.logFile(entry.routine);
    this.ensure(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  }

  /** Правка строки журнала (стоимость и ответ после конца запуска); файл переписывается, старые строки обрезаются. */
  updateLog(routine: string, id: string, patch: Partial<LogEntry>): LogEntry | undefined {
    const all = this.logAll(routine);
    const i = all.findIndex((e) => e.id === id);
    if (i < 0) return undefined;
    all[i] = { ...all[i], ...patch };
    this.ensure(path.dirname(this.logFile(routine)));
    writeAtomic(this.logFile(routine), all.slice(-LOG_KEEP).map((e) => JSON.stringify(e)).join('\n') + '\n');
    return all[i];
  }

  deleteRoutineState(routine: string): void {
    for (const sub of ['log', 'events', 'feedback']) fs.rmSync(this.keyed(sub, routine), { force: true });
  }

  /** Обратная связь рутины по порядку (старые первыми), по одной записи на событие. */
  feedback = (routine: string): FeedbackRecord[] => this.readJson<FeedbackRecord[]>(this.keyed('feedback', routine), []);

  /** Новый ответ на событие заменяет прежний; хранится не больше REJECTED_MAX * 10 записей. */
  setFeedback(routine: string, f: FeedbackRecord): void {
    const list = [...this.feedback(routine).filter((x) => x.eventId !== f.eventId), f].slice(-REJECTED_MAX * 10);
    this.writeJson(this.keyed('feedback', routine), list);
  }

  // ожидания, «догнать», очередь, время последней проверки

  waits = (): StoredWait[] => this.readJson<StoredWait[]>(this.stateFile('waits.json'), []);
  setWaits = (w: StoredWait[]) => this.writeJson(this.stateFile('waits.json'), w);

  catchUp = (): CatchUpRecord[] => this.readJson<CatchUpRecord[]>(this.stateFile('catchup.json'), []);
  setCatchUp = (c: CatchUpRecord[]) => this.writeJson(this.stateFile('catchup.json'), c);

  queue = (): QueueItem[] => this.readJson<QueueItem[]>(this.stateFile('queue.json'), []);
  setQueue = (q: QueueItem[]) => this.writeJson(this.stateFile('queue.json'), q);

  /** Время последней проверки: ключ — слаг источника или schedule:<рутина> (двоеточия в слаге нет — ключи не пересекаются). */
  lastChecks = (): Record<string, string> => this.readJson<Record<string, string>>(this.stateFile('last-check.json'), {});
  lastCheck = (key: string): string | undefined => this.lastChecks()[key];
  setLastCheck(key: string, at: string): void {
    this.writeJson(this.stateFile('last-check.json'), { ...this.lastChecks(), [key]: at });
  }
}
