// Конец запуска → дело на доске (docs/desk/SPEC.md: «сигнал → вещь → наблюдатель», вещь «Запуск»; редизайн —
// docs/flow-redesign/SPEC.md, «Главная и история»). Журнала событий на Главной нет: итог, который требует действия,
// приходит делом в «Новое».
//   упал (ошибка, лимит, оборвался с закрытием приложения) — «<flow> остановился с ошибкой», этап и причина; действия — на карточке;
//   готов — «<flow> готов», одна строка итога; закрывается, когда человек открыл страницу запуска (runSeen);
//   прерван человеком (aborted) и идущий — дела нет.
// Ключ — run:<id первого запуска цепочки>: повтор конца (перезапуск, продолжение, второй сервер) дела не плодит, продолжение
// упавшего запуска — то же дело; дошло до конца — дело закрывается вместе с оригиналом.
import fs from 'node:fs';
import path from 'node:path';
import type { RunReport } from '../api-types.js';
import { runKey } from '../things/keys.js';
import type { DeskApi, DeskItem, RunThingRef } from './types.js';

/** Вид дел о запусках. */
export const RUN_KIND = 'Запуск';
export type { RunThingRef } from './types.js';

const WHY_MAX = 200;
const REASON_MAX = 140;

const oneLine = (s: string | undefined, max: number): string => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
};

/** Ключ дела о запуске: у продолжения — первый запуск цепочки. */
export const runItemKey = (r: Pick<RunReport, 'id' | 'root'>): string => runKey(r.root ?? r.id);

/** Дело о запуске: вещь — запуск, в ref — состояние. */
export const runRef = (i: Pick<DeskItem, 'thing'>): RunThingRef | undefined => (i.thing?.type === 'run' ? (i.thing.ref as RunThingRef) : undefined);

/** Когда кончился запуск: прерванный (running без процесса) finishedAt не имеет — берём последнее известное время. */
export function endedAt(r: RunReport): string {
  return r.finishedAt ?? lastKnownAt(r);
}

/** Старт плюс длительности этапов (параллельная группа идёт вместе — берём самый долгий): больше этого запуск не работал. */
function workedUntil(r: RunReport): string | undefined {
  let ms = 0;
  const groups = new Map<string, number>();
  for (const p of r.phases ?? []) {
    if (!p.durationMs) continue;
    if (!p.group) ms += p.durationMs;
    else {
      const k = `${p.block}\n${p.iteration}\n${p.group}`;
      groups.set(k, Math.max(groups.get(k) ?? 0, p.durationMs));
    }
  }
  for (const v of groups.values()) ms += v;
  const start = Date.parse(r.startedAt);
  return ms > 0 && Number.isFinite(start) ? new Date(start + ms).toISOString() : undefined;
}

/** Последнее время, которое отчёт знает о запуске: вопросы, паузы, работа этапов, старт. Стабильно между вызовами. */
function lastKnownAt(r: RunReport): string {
  const times = [r.startedAt, workedUntil(r), ...(r.questions ?? []).flatMap((q) => [q.askedAt, q.answeredAt]), ...(r.pauses ?? []).flatMap((p) => [p.at, p.resumedAt])];
  return times.filter((t): t is string => Boolean(t)).sort().pop() ?? r.startedAt;
}

/** Где остановился: этап, который не прошёл; иначе блок, на котором оборвалось. */
export function stageOf(r: RunReport): string | undefined {
  const bad = [...(r.phases ?? [])].reverse().find((p) => !p.ok);
  const many = (r.blocks ?? []).length > 1;
  if (bad) {
    const phase = oneLine(bad.title || bad.phase, 60);
    return many && bad.block ? `блок «${oneLine(bad.block, 40)}», этап «${phase}»` : `этап «${phase}»`;
  }
  const block = [...(r.blocks ?? [])].reverse().find((b) => b.status === 'running' || b.status === 'interrupted' || b.status === 'failed' || b.status === 'budget_exceeded' || b.status === 'max_iterations');
  return block ? `блок «${oneLine(block.title || block.name, 40)}»` : undefined;
}

/** Короткая причина словами: у оборвавшегося запуска отчёт говорит про адрес API — человеку пишем по-человечески. */
export function reasonOf(r: RunReport): string {
  if (r.status === 'budget_exceeded') return 'кончился бюджет';
  if (r.status === 'max_iterations') return 'не уложился в число повторов';
  if (r.status === 'interrupted') return 'приложение закрылось во время работы';
  const bad = [...(r.phases ?? [])].reverse().find((p) => !p.ok && p.errors?.length);
  const raw = (r.error || bad?.errors?.[0] || '').split('\n').find((l) => l.trim()) ?? '';
  return oneLine(raw, REASON_MAX) || 'ошибка';
}

/** Одна строка итога готового запуска: сводка модели, иначе последний шаг, иначе ничего. */
export function summaryOf(r: RunReport): string {
  const text = r.digest?.text || [...(r.final ?? [])].reverse().find((f) => f.ok && f.output.trim())?.output || '';
  // разметка мешает карточке: первая содержательная строка без маркеров заголовков и списков
  const first = text.split('\n').map((l) => l.replace(/^[\s>#*\-•\d.)]+/, '').replace(/[*_`]/g, '').trim()).find(Boolean) ?? '';
  return oneLine(first, WHY_MAX);
}

export type RunEndOpts = {
  /** Конец запуска рутины: готовые молчат (их журнал — у рутины), упавшие — дело. */
  routine?: boolean;
  /** Страницу запуска смотрят прямо сейчас: итог «готов» уже виден, дела нет. */
  watched?: boolean;
  /** Слаг пространства запуска. */
  project?: string;
  /** Запуск можно продолжить с места. */
  continuable?: boolean;
};

export type RunEndResult = 'failed' | 'ready' | 'closed' | 'skipped';

/**
 * Конец запуска → дело. Дочерний, скрытый, идущий и остановленный человеком запуск дела не заводят; запуск, начатый с
 * карточки или рутиной с задачей (он в links.runs дела), — тоже: его итог пишет в дело runEnded.
 */
export async function noteRunEnd(store: DeskApi, r: RunReport, o: RunEndOpts = {}): Promise<RunEndResult> {
  if (r.parent || r.hidden || r.status === 'running' || r.status === 'aborted') return 'skipped';
  const key = runItemKey(r);
  const ids = [r.id, ...(r.root ? [r.root] : [])];
  if ((await store.list({ open: true })).some((i) => ids.some((id) => i.links.runs.includes(id)))) return 'skipped';
  const at = endedAt(r);
  const existing = await store.get(key);
  const state = existing && runRef(existing);

  if (r.status === 'done') {
    // продолжение дошло до конца: упавший запуск закрывается вместе с оригиналом (человек сам нажал «Продолжить»)
    if (existing && !existing.closed && state?.status === 'failed') {
      await store.close(key, 'продолжили — запуск дошёл до конца', 'flow');
      return 'closed';
    }
    // дело уже было (открытое или закрытое человеком), у рутины и на глазах — нового не нужно
    if (existing || o.routine || o.watched) return 'skipped';
    const why = summaryOf(r) || 'без итога в тексте';
    await store.put(key, {
      kind: RUN_KIND,
      title: `${r.flow} готов`,
      why,
      ...(o.project ? { project: o.project } : {}),
      thing: { type: 'run', ref: { runId: r.id, flow: r.flow, status: 'done', costUsd: r.totalCostUsd } satisfies RunThingRef },
      signal: { source: 'flow', at, text: why },
    }, 'flow');
    return 'ready';
  }

  // упал: ошибка, лимит, оборвался; повтор того же конца — тот же сигнал, дела не прибавится
  const stage = stageOf(r);
  const reason = reasonOf(r);
  const why = oneLine(stage ? `${stage} — ${reason}` : reason, WHY_MAX);
  // этот конец уже учтён (обход после перезапуска видит тот же оборвавшийся запуск): дело не откатывается к нему
  if (existing?.signals.some((s) => s.source === 'flow' && s.at === at && s.text === why)) return 'skipped';
  const ref: RunThingRef = { runId: r.id, flow: r.flow, status: 'failed', ...(stage ? { stage } : {}), costUsd: r.totalCostUsd, ...(o.continuable ? { continuable: true } : {}) };
  await store.put(key, {
    kind: RUN_KIND,
    title: `${r.flow} остановился с ошибкой`,
    why,
    ...(o.project ? { project: o.project } : {}),
    thing: { type: 'run', ref },
    signal: { source: 'flow', at, text: why },
    refresh: true,
  }, 'flow');
  // «Убранное» и закрытое продолжением дело, упавшее снова, — новость: в «Новое», а не в «В план»
  if (existing?.closed) await store.move(key, 'new', 'flow', why);
  return 'failed';
}

/**
 * Человек открыл страницу запуска: дело «<flow> готов» этой цепочки закрывается. Упавший запуск открытием не закрывается —
 * его закрывает «Убрать» или продолжение, дошедшее до конца. Сколько дел закрыто (0 или 1).
 */
export async function runSeen(store: DeskApi, ids: readonly string[]): Promise<number> {
  let n = 0;
  for (const key of new Set(ids.map((id) => runKey(id)))) {
    const item = await store.get(key);
    if (!item || item.closed || runRef(item)?.status !== 'done') continue;
    if (await store.close(key, 'открыт запуск', 'me')) n++;
  }
  return n;
}

/**
 * Запуски, оборвавшиеся вместе с приложением, конца не объявили: при старте сервер находит их по run.json. Старые запуски
 * задним числом дел не заводят: первый обход только запоминает время (desk/runs-since), следующие берут запуски, кончившиеся
 * позже, и после каждого обхода метка — сейчас (закрытое дело, ушедшее из хранилища по сроку, не вернётся). Повторный обход дела
 * не плодит (тот же сигнал). Сколько запусков разобрано.
 */
export async function sweepInterrupted(
  store: DeskApi,
  dir: string,
  reports: () => Iterable<{ report: RunReport; opts: RunEndOpts }>,
  now: () => Date = () => new Date(),
): Promise<number> {
  const file = path.join(dir, 'runs-since');
  let since: string | undefined;
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    since = Number.isNaN(Date.parse(s)) ? undefined : s;
  } catch {
    /* первого обхода ещё не было */
  }
  if (!since) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, now().toISOString());
    return 0;
  }
  let n = 0;
  const started = now().toISOString();
  for (const { report, opts } of reports()) {
    if (report.status !== 'interrupted' || endedAt(report) < since) continue;
    if ((await noteRunEnd(store, report, opts)) === 'failed') n++;
  }
  fs.writeFileSync(file, started);
  return n;
}
