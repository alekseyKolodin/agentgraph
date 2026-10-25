// Статусы узлов графа запуска (порт ui/graph.js graphRunState) и подписи бейджей (порт graphApplyRun) — без DOM.
import { usd } from '../format';
import type { GraphBlock } from './model';
import { ctxBadge, ctxLabel, iterTo, loopLabel } from './text';

/** Отчёт этапа (RunReport.phases): у старых запусков (до блоков) поля block нет. */
export type RunPhaseLike = {
  block?: string;
  phase: string;
  iteration: number;
  ok?: boolean;
  costUsd?: number;
  tokens?: { contextPeak?: number; contextWindow?: number };
};
export type RunCondLike = { block?: string; iteration: number; type?: string; done?: boolean; costUsd?: number };
export type RunBlockLike = { name: string; status?: string; skipped?: boolean; iterations?: number; maxIterations?: number };
/** RunReport (+ live): то, что граф берёт из отчёта запуска. */
export type RunReportLike = {
  live?: boolean;
  status?: string;
  iterations?: number;
  maxIterations?: number;
  blocks?: RunBlockLike[];
  phases?: RunPhaseLike[];
  conditions?: RunCondLike[];
  questions?: { phase?: string; answers?: unknown }[];
  pause?: string;
  pauseReason?: { block?: string; phase: string } | null;
};
/** Идущий этап (событие phase_start): at — время старта в мс, ctx — последний снимок контекста. */
export type PendingPhase = { block?: string; phase: string; iteration: number; index?: number; title?: string; at?: number; ctx?: { peak: number; window?: number } };
export type PendingCond = { block?: string; iteration: number; kind?: string };

export type NodeStatus = 'running' | 'done' | 'failed' | 'pending' | 'skipped' | 'notmet';
export const STATUSES: NodeStatus[] = ['running', 'done', 'failed', 'pending', 'skipped', 'notmet'];

export type NodeRunState = {
  status: NodeStatus;
  title?: string;
  costUsd?: number;
  iteration?: number;
  note?: string;
  /** Подпись в шапке рамки блока: «итер. 2/5» или «пропущен». */
  label?: string;
  ctx?: { peak: number; window?: number };
};
export type BlockRunState = {
  index: number;
  status: string;
  skipped: boolean;
  iteration: number;
  max: number;
  looped: boolean;
  untilType?: string;
  /** Последний вердикт условия блока — для подписи петли. */
  lastCond?: { iteration: number; done: boolean } | null;
};
export type GraphRunState = {
  nodes: Record<string, NodeRunState>;
  blocks: Record<string, BlockRunState>;
  current: string | null;
  currentKeys: string[];
  /** «Сейчас: …» над графом идущего запуска; у законченного — пусто. */
  now: string;
};

const COND_KIND: Record<string, string> = { command: 'команда', judge: 'судья', marker: 'маркер', none: 'без условия' };

/**
 * Статусы узлов запуска. Ключ узла: блок + имя этапа (имена этапов во flow уникальны).
 * blocks — блоки снимка flow; report — RunReport (+ live); pending — идущие этапы (Map или массив событий phase_start);
 * extra.condPending — идущая проверка условия, extra.now — текущее время в мс для «идёт N мин».
 */
export function graphRunState(
  blocks: GraphBlock[],
  report: RunReportLike | null | undefined,
  pending: Map<string, PendingPhase> | PendingPhase[] | null | undefined,
  extra: { condPending?: PendingCond | null; now?: number } = {},
): GraphRunState {
  const r = report || {};
  const live = Boolean(r.live);
  // у старых запусков (до блоков) у этапов нет поля block: этапы единственного блока сопоставляем только по имени
  const sole = blocks.length === 1 ? blocks[0]!.name : null;
  const inBlock = (x: { block?: string }, name: string) => (sole !== null ? true : x.block === name);
  const running = pending ? [...pending.values()] : [];
  const condPending = extra.condPending || null;
  const asking = live ? (r.questions || []).filter((q) => !q.answers) : [];
  const out: GraphRunState = { nodes: {}, blocks: {}, current: null, currentKeys: [], now: '' };
  const legacy: RunBlockLike = { name: '', status: r.status, iterations: r.iterations, maxIterations: r.maxIterations };
  const last = <T extends { iteration: number }>(list: T[]): T | null => list.reduce<T | null>((a, x) => (!a || x.iteration >= a.iteration ? x : a), null);

  blocks.forEach((b, bi) => {
    const br = (r.blocks || []).find((x) => x.name === b.name) || (sole !== null ? r.blocks?.[0] || legacy : null);
    const status = br?.status || 'pending';
    const skipped = Boolean(br?.skipped);
    // у пропущенного продолжением блока maxIterations = 0: лимит тогда из снимка, иначе на дуге «до 0»
    const max = (!skipped && (br?.maxIterations ?? 0) > 0 ? br!.maxIterations! : 0) || b.loop?.max_iterations || 1;
    const phases = (r.phases || []).filter((p) => inBlock(p, b.name));
    const runs = running.filter((x) => inBlock(x, b.name));
    const condRun = condPending && inBlock(condPending, b.name) ? condPending : null;
    const iter = Math.max(br?.iterations || 0, ...phases.map((p) => p.iteration), ...runs.map((x) => x.iteration), condRun?.iteration || 0, 0);
    // блок идёт: этапы, которых нет в текущей итерации, ещё впереди, даже если выполнялись в прошлой
    const active = status === 'running';
    out.blocks[b.name] = { index: bi, status, skipped, iteration: iter, max, looped: Boolean(b.loop), untilType: b.loop?.until?.type };
    out.nodes[`b:${b.name}`] = {
      status: skipped ? 'skipped' : status === 'pending' ? 'pending' : active ? 'running' : status === 'done' ? 'done' : 'failed',
      label: skipped ? 'пропущен' : b.loop && iter ? `итер. ${iter}/${max}` : '',
    };
    for (const p of b.phases) {
      const mine = phases.filter((x) => x.phase === p.name);
      const run = runs.find((x) => x.phase === p.name);
      let st: NodeStatus;
      let rep: RunPhaseLike | null = null;
      if (skipped) st = 'skipped';
      else if (run) st = 'running';
      else {
        rep = active ? mine.find((x) => x.iteration === iter) || null : last(mine);
        st = rep ? (rep.ok ? 'done' : 'failed') : 'pending';
      }
      const node: NodeRunState = { status: st, title: p.title || p.name };
      if (rep) Object.assign(node, { costUsd: rep.costUsd, iteration: rep.iteration });
      if (run) node.iteration = run.iteration;
      // контекст: у идущего этапа — последний снимок из потока, у готового — из отчёта; без данных поля нет
      const ctx = run ? run.ctx : rep?.tokens && { peak: rep.tokens.contextPeak ?? 0, window: rep.tokens.contextWindow };
      if (ctx && ctx.peak > 0) node.ctx = (ctx.window ?? 0) > 0 ? { peak: ctx.peak, window: ctx.window } : { peak: ctx.peak };
      if (run && asking.some((q) => q.phase === p.name)) node.note = 'ждёт ответа';
      else if (run && r.pause === 'requested') node.note = 'пауза после шага';
      out.nodes[`p:${b.name}:${p.name}`] = node;
    }
    if (b.loop) {
      const conds = (r.conditions || []).filter((c) => inBlock(c, b.name));
      let st: NodeStatus;
      let c: RunCondLike | null = null;
      if (skipped) st = 'skipped';
      else if (condRun) st = 'running';
      else {
        c = active ? conds.find((x) => x.iteration === iter) || null : last(conds);
        st = c ? (c.done || c.type === 'none' ? 'done' : 'notmet') : 'pending';
      }
      const node: NodeRunState = { status: st };
      // последний вердикт блока — для подписи петли: у идущего блока узел условия уже «впереди», а вердикт прошлой итерации нужен
      const lc = last(conds);
      out.blocks[b.name]!.lastCond = lc ? { iteration: lc.iteration, done: Boolean(lc.done || lc.type === 'none') } : null;
      if (c) Object.assign(node, { iteration: c.iteration, costUsd: c.costUsd });
      if (condRun) node.iteration = condRun.iteration;
      out.nodes[`c:${b.name}`] = node;
    }
  });

  if (!live) return out;
  const blockOf = (x: { block?: string }) => (sole !== null ? sole : x.block!);
  const order = (x: PendingPhase) => (out.blocks[blockOf(x)]?.index ?? 0) * 1000 + (x.index ?? 0);
  const cur = running.filter((x) => out.blocks[blockOf(x)]).sort((a, z) => order(a) - order(z));
  let bname: string | null = null;
  if (cur.length) {
    out.currentKeys = cur.map((x) => `p:${blockOf(x)}:${x.phase}`);
    bname = blockOf(cur[0]!);
  } else if (condPending && out.blocks[blockOf(condPending)]) {
    bname = blockOf(condPending);
    out.currentKeys = [`c:${bname}`];
  } else if (r.pause === 'paused' && r.pauseReason) {
    bname = sole !== null ? sole : r.pauseReason.block!;
    const node = out.nodes[`p:${bname}:${r.pauseReason.phase}`];
    if (node) {
      out.currentKeys = [`p:${bname}:${r.pauseReason.phase}`];
      node.note = 'пауза';
    }
  }
  if (!bname) bname = Object.keys(out.blocks).find((n) => out.blocks[n]!.status === 'running') || null;
  out.current = out.currentKeys[0] || null;
  if (!bname) return out;
  const bs = out.blocks[bname]!;
  const b = blocks[bs.index]!;
  const parts: string[] = [];
  if (blocks.length > 1) parts.push(`блок ${bs.index + 1} «${b.title || b.name}»`);
  if (b.loop) parts.push(`итерация ${bs.iteration}/${bs.max}`);
  if (cur.length) {
    const names = cur.map((x) => `«${x.title || x.phase}»`);
    const since = cur.map((x) => x.at).filter((x): x is number => Boolean(x));
    let took = '';
    if (since.length && extra.now) {
      const min = Math.floor((extra.now - Math.min(...since)) / 60000);
      took = min < 1 ? ' (идёт меньше минуты)' : ` (идёт ${min} мин)`;
    }
    parts.push(`${names.length > 1 ? `этапы ${names.join(', ')}` : `этап ${names[0]}`}${took}`);
  } else if (condPending) {
    parts.push(`проверка условия (${COND_KIND[condPending.kind ?? ''] || condPending.kind || 'условие'})`);
  } else if (r.pause === 'paused' && r.pauseReason) {
    parts.push(`этап «${r.pauseReason.phase}» попросил паузу`);
  } else parts.push('между шагами');
  if (asking.length && cur.length) parts.push('ждёт ответа');
  if (r.pause === 'paused') parts.push('на паузе');
  else if (r.pause === 'requested') parts.push('пауза после шага');
  out.now = `Сейчас: ${parts.join(' · ')}`;
  return out;
}

/** Текст бейджа узла по статусу (graphApplyRun): этап, ромб условия или шапка рамки блока. */
export function nodeBadge(kind: 'phase' | 'cond' | 'block' | 'start' | 'artifact', s: NodeRunState): string {
  // контекст — сразу после иконки/цены: хвост (заметка, итерация) в узле 210 px обрезается первым
  const ctx = s.ctx ? ` ${ctxBadge(s.ctx.peak, s.ctx.window)}` : '';
  if (kind === 'block') return s.label || '';
  if (s.status === 'running') return `⏳${ctx ? `${ctx} ·` : ''} ${s.note || 'идёт'}${s.iteration ? ` · итер. ${s.iteration}` : ''}`;
  if (s.status === 'done') return kind === 'cond' ? `✓${s.iteration ? ` итер. ${s.iteration}` : ''}` : `✓ ${usd(s.costUsd)}${ctx ? ` ·${ctx}` : ''}${s.note ? ` · ${s.note}` : ''}`;
  if (s.status === 'failed') return `✗ ${usd(s.costUsd)}`;
  if (s.status === 'notmet') return `↻ не выполнено${s.iteration ? ` (итер. ${s.iteration})` : ''}`;
  if (s.status === 'skipped') return 'пропущен';
  return '';
}

/** Подсказка узла этапа: статичная часть (номер, название, инструменты) и расшифровка контекста. */
export const phaseNodeTitle = (base: string, s: NodeRunState | undefined): string =>
  s?.ctx ? `${base}\nКонтекст: пик ${ctxLabel(s.ctx.peak, s.ctx.window)}${s.ctx.window ? '' : ' (окно модели неизвестно)'}` : base;

/** Вердикт последней проверки условия блока: '' — проверок не было. */
export const loopVerdict = (b: BlockRunState): '' | 'done' | 'notmet' => (b.lastCond ? (b.lastCond.done ? 'done' : 'notmet') : '');

/** Подпись петли: на странице запуска — счётчик «↺ 2 / 5» и вердикт, в конструкторе и на вкладке «Запуск» — лимит. */
export function loopRunLabel(mode: string, untilType: string | undefined, b: BlockRunState): string {
  const v = loopVerdict(b);
  return mode === 'run' && b.iteration
    ? `↺ ${b.iteration} / ${b.max}${v === 'notmet' ? ` · ✕ итер. ${b.lastCond!.iteration}` : v === 'done' ? ' · ✓' : ''}`
    : loopLabel(untilType, b.max);
}

/** «↺ до N итераций» в шапке рамки блока — тот же лимит, что на дуге. */
export const blockLoopNote = (b: BlockRunState): string => `↺ до ${iterTo(b.max)}`;
