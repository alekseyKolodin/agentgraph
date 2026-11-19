// История flow для его экрана (GET /api/flows/:name/history): сколько раз его запускали за 30 дней, последний запуск и
// версии — из снимков flow.yaml в папках его запусков (свои flow в git не лежат, другой истории у них нет). Версия
// запуска — та, с которой он начался: после правки на ходу прежний снимок лежит в flow.0.yaml (runner.ts, applyFlow).
// Одинаковые по содержимому снимки — одна версия; сравнение — по разобранному YAML, а не по тексту: снимок пишет
// раннер (stringify), и пробелы или порядок ключей файла в flows/ разницы не дают. Верхний input не в счёт: сервер
// кладёт в снимок задачу запуска (у рутины — с блоком события), это не версия flow.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { FlowHistory, FlowRunRow, FlowRunStop, FlowVersion, RunReport, RunSummary } from './api-types.js';
import { parseFlow } from './flows.js';

export const FLOW_STATS_DAYS = 30;
/** Версий в ответе не больше: дальше — самые старые, они почти никогда не нужны. */
export const FLOW_VERSIONS_MAX = 30;
/** Строк запусков в ответе не больше. */
export const FLOW_RUNS_MAX = 100;
/**
 * Задача в строке запуска — не длиннее: целиком она в отчёте запуска. Столько же оставляет сводка запуска (listRuns в
 * server.ts), из которой строки собираются: задача такой длины считается обрезанной.
 */
export const FLOW_RUN_INPUT_MAX = 200;
/** У скольких последних запусков считать, можно ли продолжить: «Прошлые запуски» на вкладке «Запуск». */
export const FLOW_CONTINUE_CHECK = 3;
/** Статусы идущего запуска в сводке (liveStatus сервера): у них нет места остановки. */
const LIVE_STATUSES = new Set(['running', 'waiting', 'paused']);

type RunLike = Pick<RunSummary, 'id' | 'flow' | 'startedAt' | 'status'> & Partial<Pick<RunSummary, 'title' | 'adhoc' | 'input' | 'totalCostUsd'>>;
type ReportLike = Pick<RunReport, 'id' | 'status' | 'blocks' | 'phases'>;

export type FlowHistoryDeps<R extends ReportLike = ReportLike> = {
  runsDir: string;
  /** YAML файла flow сейчас; нет — flow удалили (ни одна версия не текущая). */
  currentYaml?: string;
  now?: number;
  read?: (file: string) => string | undefined;
  /** Отчёт запуска (readReport сервера): по нему — где встал незавершённый. Нет — строки без stop. */
  report?: (id: string) => R | undefined;
  /** Продолжение с места: с какого блока (1 — первый) пойдёт, undefined — нельзя. Только у FLOW_CONTINUE_CHECK последних. */
  continueAt?: (report: R) => number | undefined;
};

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** Объект с ключами по алфавиту: одинаковые flow дают одну строку, как бы ни были упорядочены ключи. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Отпечаток содержимого flow: схема с умолчаниями (как пишет снимок раннер), не прошедший схему — как есть. */
export function flowFingerprint(yamlText: string): string | undefined {
  let obj: unknown;
  try {
    obj = parseFlow(yamlText);
  } catch {
    try {
      obj = parseYaml(yamlText);
    } catch {
      return undefined;
    }
  }
  // stringify и обратно: умолчания схемы и снимок раннера сравниваются в одном виде (undefined уходит)
  const plain = JSON.parse(JSON.stringify(obj ?? null)) as unknown;
  if (plain && typeof plain === 'object' && !Array.isArray(plain)) delete (plain as Record<string, unknown>).input;
  return createHash('sha256').update(canonical(plain)).digest('hex').slice(0, 12);
}

/** Снимки, которые бывают версией запуска. */
export const SNAPSHOT_FILES = ['flow.0.yaml', 'flow.yaml'] as const;

/**
 * Версия из снимка — для редактора flow: задача запуска (input снимка) заменена задачей файла flow сейчас, нет её —
 * поля нет. Иначе «Сохранить» унесло бы в flows/ чужую задачу (у рутины — с недоверенным блоком события).
 */
export function versionYaml(snapshot: string, currentYaml: string | undefined): string {
  const obj = parseYaml(snapshot) as unknown;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Снимок flow — не объект YAML');
  let input: unknown;
  try {
    input = currentYaml === undefined ? undefined : (parseYaml(currentYaml) as Record<string, unknown> | null)?.input;
  } catch {
    input = undefined;
  }
  const out: Record<string, unknown> = {};
  // порядок ключей снимка, input — на своём месте
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k !== 'input') out[k] = v;
    else if (input !== undefined) out[k] = input;
  }
  if (input !== undefined && !('input' in out)) out.input = input;
  return toYaml(out, { lineWidth: 0 });
}

/** Снимок, с которым запуск начался: flow.0.yaml, если flow правили на ходу, иначе flow.yaml. */
export function startSnapshot(runDir: string, read: (file: string) => string | undefined): { file: string; text: string } | undefined {
  for (const file of SNAPSHOT_FILES) {
    const text = read(path.join(runDir, file));
    if (text !== undefined) return { file, text };
  }
  return undefined;
}

/**
 * Где встал незавершённый запуск: последний начатый блок (не ждущий и не пропущенный развилкой), у упавшего — этап,
 * который упал. done и идущий — undefined.
 */
export function runStop(r: Pick<RunReport, 'status' | 'blocks' | 'phases'>): FlowRunStop | undefined {
  if (r.status === 'done' || r.status === 'running') return undefined;
  const blocks = r.blocks ?? [];
  if (!blocks.length) return undefined;
  let at = 0;
  blocks.forEach((b, i) => {
    if (b.status !== 'pending' && !b.bypassed) at = i;
  });
  const b = blocks[at]!;
  const out: FlowRunStop = { block: at + 1, blocks: blocks.length, blockTitle: b.title || b.name };
  if (r.status === 'failed') {
    const bad = (r.phases ?? []).filter((p) => p.block === b.name && !p.ok).at(-1);
    if (bad) Object.assign(out, { phase: bad.title || bad.phase, iteration: bad.iteration });
  }
  return out;
}

const cutInput = (s: string): Pick<FlowRunRow, 'input' | 'inputCut'> =>
  s.length >= FLOW_RUN_INPUT_MAX ? { input: s.slice(0, FLOW_RUN_INPUT_MAX), inputCut: true } : { input: s };

/** runs — все запуски (от новых к старым, как listRuns): берутся только этого flow, разовые — нет. */
export function flowHistory<R extends ReportLike>(name: string, runs: RunLike[], deps: FlowHistoryDeps<R>): FlowHistory {
  const read = deps.read ?? readText;
  const now = deps.now ?? Date.now();
  const mine = runs.filter((r) => r.flow === name && !r.adhoc).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const since = now - FLOW_STATS_DAYS * 86_400_000;
  const runs30d = mine.filter((r) => Date.parse(r.startedAt) >= since).length;
  const last = mine[0];
  const current = deps.currentYaml === undefined ? undefined : flowFingerprint(deps.currentYaml);

  const byPrint = new Map<string, Omit<FlowVersion, 'n'>>();
  const printOf = new Map<string, string>();
  let noSnapshot = 0;
  for (const r of mine) {
    const snap = startSnapshot(path.join(deps.runsDir, r.id), read);
    const print = snap && flowFingerprint(snap.text);
    if (print) printOf.set(r.id, print);
    if (!snap || !print) {
      noSnapshot++;
      continue;
    }
    const v = byPrint.get(print);
    // запуски — от новых к старым: первый встреченный — последний с этой версией
    if (v) {
      v.runs++;
      v.firstAt = r.startedAt;
    } else byPrint.set(print, { id: print, current: print === current, runs: 1, firstAt: r.startedAt, lastAt: r.startedAt, runId: r.id, file: snap.file });
  }
  // номер — по времени появления: 1 — самая старая известная; список — от свежих
  const versions = [...byPrint.values()]
    .sort((a, b) => a.firstAt.localeCompare(b.firstAt))
    .map((v, i): FlowVersion => ({ ...v, n: i + 1 }))
    .reverse()
    .slice(0, FLOW_VERSIONS_MAX);
  const rows = mine.slice(0, FLOW_RUNS_MAX).map((r, i): FlowRunRow => {
    const print = printOf.get(r.id);
    // отчёт читаем только у незавершённого: где встал, можно ли продолжить (у последних). Идущий (и ждущий, и на паузе) — нет
    const ended = r.status !== 'done' && !LIVE_STATUSES.has(r.status);
    const rep = ended && deps.report ? deps.report(r.id) : undefined;
    const stop = rep ? runStop(rep) : undefined;
    const cont = rep && i < FLOW_CONTINUE_CHECK ? deps.continueAt?.(rep) : undefined;
    return {
      id: r.id,
      startedAt: r.startedAt,
      status: r.status,
      ...(r.title ? { title: r.title } : {}),
      ...cutInput(r.input ?? ''),
      costUsd: r.totalCostUsd ?? 0,
      ...(print ? { version: print } : {}),
      ...(stop ? { stop } : {}),
      ...(cont ? { continueAt: cont } : {}),
    };
  });
  return {
    name,
    total: mine.length,
    runs30d,
    ...(last ? { last: { id: last.id, startedAt: last.startedAt, status: last.status, ...(last.title ? { title: last.title } : {}) } } : {}),
    versions,
    noSnapshot,
    // «поправили после последнего» — только если запуски со снимком были
    ...(current && byPrint.size && !byPrint.has(current) ? { currentUnrun: true as const } : {}),
    runs: rows,
  };
}
