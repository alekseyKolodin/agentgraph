// Зависимости предложения разбивки (spec §8.5, §9.1; макет Split.dc.html). checkDependencies повторяет сервер
// (src/teamwork.ts): неизвестная ссылка, цикл с цепочкой, волны по незавершённым предшественникам, существующие
// незавершённые задачи в волне 1, самая длинная цепочка по очкам. Плюс раскладка графа: колонки по волнам, порядок строк
// с меньшим числом пересечений, координаты узлов, пути рёбер, подсветка связей выбранной задачи, правка связей.
// Чистые функции без React и DOM.
import type { TeamDependencyReport, TeamMember, TeamProposedTask, TeamTask, TeamTaskStatus } from '@server/api-types';
import { plural, t } from '../i18n';
import { memberLabel, statusText } from './board';

/** Существующая задача проекта, на которую ссылается предложение. Для проверки хватает id и status. */
export type ExistingTask = { id: string; status: TeamTaskStatus } & Partial<Pick<TeamTask, 'title' | 'assignee' | 'sprint' | 'estimate'>>;

type Proposed = Pick<TeamProposedTask, 'key' | 'dependsOn' | 'estimate'>;

export const cycleText = (cycle: readonly string[]): string => t('цикл: {chain}', { chain: cycle.join(' → ') });

/** Разбор зависимостей предложения — та же семантика, что у сервера. */
export function checkDependencies(tasks: readonly Proposed[], existing: readonly { id: string; status: TeamTaskStatus }[]): TeamDependencyReport {
  const byKey = new Map(tasks.map((x) => [x.key, x]));
  const exist = new Map(existing.map((x) => [x.id, x]));
  const errors: TeamDependencyReport['errors'] = [];
  for (const x of tasks) {
    for (const dep of x.dependsOn) {
      if (dep === x.key) errors.push({ key: x.key, error: t('зависит от самой себя') });
      else if (!byKey.has(dep) && !exist.has(dep)) errors.push({ key: x.key, error: t('неизвестная задача «{dep}»', { dep }) });
    }
  }
  // цикл: первый найденный обходом в глубину по «зависит от», в порядке предложения
  const color = new Map<string, 1 | 2>();
  const path: string[] = [];
  let cycle: string[] | undefined;
  const dfs = (key: string): void => {
    if (cycle) return;
    color.set(key, 1);
    path.push(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (!byKey.has(dep)) continue;
      const c = color.get(dep);
      if (c === 1) {
        // путь шёл по «зависит от»; показываем в направлении стрелок графа: предшественник → последователь
        cycle = [...path.slice(path.indexOf(dep)), dep].reverse();
        return;
      }
      if (!c) dfs(dep);
      if (cycle) return;
    }
    path.pop();
    color.set(key, 2);
  };
  for (const x of tasks) if (!color.has(x.key)) dfs(x.key);
  const inCycle = new Set(cycle ?? []);
  if (cycle) for (const key of inCycle) errors.push({ key, error: cycleText(cycle) });
  // волны: 1 — можно начать сейчас; существующие незавершённые предшественники — в волне 1
  const waves: Record<string, number> = {};
  const memo = new Map<string, number | undefined>();
  const waveOf = (key: string, trail: Set<string>): number | undefined => {
    if (memo.has(key)) return memo.get(key);
    if (inCycle.has(key) || trail.has(key)) return undefined;
    trail.add(key);
    let max = 0;
    let ok = true;
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (byKey.has(dep)) {
        const w = waveOf(dep, trail);
        if (w === undefined) ok = false;
        else max = Math.max(max, w);
      } else {
        const e = exist.get(dep);
        if (e && e.status !== 'done') {
          waves[dep] = 1;
          max = Math.max(max, 1);
        }
      }
    }
    trail.delete(key);
    const w = ok ? max + 1 : undefined;
    memo.set(key, w);
    return w;
  };
  for (const x of tasks) {
    const w = waveOf(x.key, new Set());
    if (w !== undefined) waves[x.key] = w;
  }
  // самая длинная цепочка по очкам среди предложенных задач: при равных очках длиннее, затем раньше в предложении
  const best = new Map<string, { keys: string[]; points: number }>();
  const chainOf = (key: string): { keys: string[]; points: number } => {
    const got = best.get(key);
    if (got) return got;
    let top: { keys: string[]; points: number } = { keys: [], points: 0 };
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (!byKey.has(dep) || waves[dep] === undefined) continue;
      const c = chainOf(dep);
      if (c.points > top.points || (c.points === top.points && c.keys.length > top.keys.length)) top = c;
    }
    const me = { keys: [...top.keys, key], points: top.points + (byKey.get(key)?.estimate ?? 0) };
    best.set(key, me);
    return me;
  };
  let chain = { keys: [] as string[], points: 0 };
  for (const x of tasks) {
    if (waves[x.key] === undefined) continue;
    const c = chainOf(x.key);
    if (c.points > chain.points || (c.points === chain.points && c.keys.length > chain.keys.length)) chain = c;
  }
  const report: TeamDependencyReport = { errors, waves, chain };
  if (cycle) report.cycle = cycle;
  return report;
}

export const wavesCount = (report: TeamDependencyReport): number => Object.values(report.waves).reduce((m, w) => Math.max(m, w), 0);

/** Предложенные задачи, которые напрямую ждут существующих незавершённых задач. */
export const waitingExisting = (tasks: readonly Proposed[], existing: readonly { id: string; status: TeamTaskStatus }[]): string[] => {
  const open = new Set(existing.filter((x) => x.status !== 'done').map((x) => x.id));
  return tasks.filter((x) => x.dependsOn.some((d) => open.has(d))).map((x) => x.key);
};

/** Сводка: «3 волны · сразу можно начать 1 · ждут текущих задач 2 · циклов нет». */
export function depsSummary(tasks: readonly Proposed[], existing: readonly { id: string; status: TeamTaskStatus }[], report: TeamDependencyReport): string[] {
  const n = wavesCount(report);
  const now = tasks.filter((x) => report.waves[x.key] === 1).length;
  return [
    `${n} ${plural(n, 'волна', 'волны', 'волн')}`,
    t('сразу можно начать {n}', { n: now }),
    t('ждут текущих задач {n}', { n: waitingExisting(tasks, existing).length }),
    report.cycle ? cycleText(report.cycle) : t('циклов нет'),
  ];
}

export const pointsWord = (n: number): string => `${n} ${plural(n, 'очко', 'очка', 'очков')}`;

/** «Самая длинная цепочка: 1 → 2 → 6 · 6 очков»; пусто без задач. */
export const chainText = (report: TeamDependencyReport): string =>
  report.chain.keys.length ? `${t('Самая длинная цепочка: {chain}', { chain: report.chain.keys.join(' → ') })} · ${pointsWord(report.chain.points)}` : '';

/** Волна словами: «волна 3», для существующей — статус. */
export const waveText = (wave: number | undefined): string => (wave === undefined ? t('цикл') : t('волна {n}', { n: wave }));

/** Ключ задачи как в макете: t1 → 1. */
export const keyLabel = (key: string): string => key.replace(/^t(?=\d+$)/, '');

/** Можно ли принять разбивку: нет ошибок у задач. */
export const canAccept = (report: TeamDependencyReport): boolean => report.errors.length === 0;

export const acceptText = (n: number): string => t('Добавить {n} в бэклог', { n });

// ---------- правка связей

export type DepsChange = { tasks: TeamProposedTask[]; report: TeamDependencyReport };

/** Новая связь key ← dep с повторной проверкой; на себя и дубли не добавляются. */
export function addDependency(tasks: readonly TeamProposedTask[], existing: readonly ExistingTask[], key: string, dep: string): DepsChange {
  const next = tasks.map((x) => (x.key === key && dep !== key && !x.dependsOn.includes(dep) ? { ...x, dependsOn: [...x.dependsOn, dep] } : x));
  return { tasks: next, report: checkDependencies(next, existing) };
}

export function removeDependency(tasks: readonly TeamProposedTask[], existing: readonly ExistingTask[], key: string, dep: string): DepsChange {
  const next = tasks.map((x) => (x.key === key ? { ...x, dependsOn: x.dependsOn.filter((d) => d !== dep) } : x));
  return { tasks: next, report: checkDependencies(next, existing) };
}

// ---------- панель задачи

export type DepRow = { id: string; title: string; existing: boolean; status?: TeamTaskStatus; assignee?: string; wave?: number };

const rowOf = (id: string, tasks: readonly TeamProposedTask[], existing: readonly ExistingTask[], report: TeamDependencyReport): DepRow | undefined => {
  const p = tasks.find((x) => x.key === id);
  if (p) return { id: p.key, title: p.title, existing: false, wave: report.waves[p.key] };
  const e = existing.find((x) => x.id === id);
  if (e) return { id: e.id, title: e.title ?? e.id, existing: true, status: e.status, assignee: e.assignee, wave: report.waves[e.id] };
  return undefined;
};

/** «Ждёт»: предшественники задачи, известные предложению или проекту. */
export function waitsOn(key: string, tasks: readonly TeamProposedTask[], existing: readonly ExistingTask[], report: TeamDependencyReport): DepRow[] {
  const me = tasks.find((x) => x.key === key);
  return (me?.dependsOn ?? []).map((d) => rowOf(d, tasks, existing, report)).filter((x): x is DepRow => Boolean(x));
}

/** «Открывает»: предложенные задачи, которые ждут эту. */
export const unlocks = (key: string, tasks: readonly TeamProposedTask[], report: TeamDependencyReport): DepRow[] =>
  tasks.filter((x) => x.dependsOn.includes(key)).map((x) => ({ id: x.key, title: x.title, existing: false, wave: report.waves[x.key] }));

const joinAnd = (parts: string[]): string => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} ${t('и')} ${parts[parts.length - 1]}`);

/**
 * Когда задачу можно начать: «Можно начать сейчас.», «Начать можно, когда PAY-14 будет в «Готово». Сейчас её делает Алексей.»,
 * «Начать можно после задачи 1 из этого предложения.»
 */
export function startNote(key: string, tasks: readonly TeamProposedTask[], existing: readonly ExistingTask[], report: TeamDependencyReport, members: readonly TeamMember[] = []): string {
  const rows = waitsOn(key, tasks, existing, report).filter((r) => !(r.existing && r.status === 'done'));
  if (report.cycle?.includes(key)) return t('Нельзя начать: задача в цикле зависимостей, уберите одну из связей.');
  if (!rows.length) return t('Можно начать сейчас.');
  const ext = rows.filter((r) => r.existing);
  const own = rows.filter((r) => !r.existing);
  const parts: string[] = [];
  if (ext.length) parts.push(t('когда {ids} {verb} в «Готово»', { ids: joinAnd(ext.map((r) => r.id)), verb: plural(ext.length, 'будет', 'будут', 'будут') }));
  if (own.length) parts.push(t('после {word} {ids} из этого предложения', { word: plural(own.length, 'задачи', 'задач', 'задач'), ids: joinAnd(own.map((r) => keyLabel(r.id))) }));
  const when = parts.join(` ${t('и')} `);
  let text = ext.length ? t('Начать можно, {when}.', { when }) : t('Начать можно {when}.', { when });
  if (ext.length === 1) {
    const r = ext[0]!;
    const m = members.find((x) => x.email === r.assignee);
    const who = m ? memberLabel(m) : r.assignee?.split('@')[0];
    text += ` ${who ? t('Сейчас её делает {who}.', { who }) : t('Исполнителя у неё пока нет.')}`;
  }
  return text;
}

/** Статус существующей задачи на узле: «в работе», «уже в спринте 2». */
export const existingNote = (e: ExistingTask): { status: string; where: string } => ({
  status: statusText(e.status), where: e.sprint !== undefined ? t('уже в спринте {n}', { n: e.sprint }) : t('в бэклоге'),
});

// ---------- граф

export type GraphOptions = { nodeW: number; nodeH: number; colGap: number; rowGap: number; left: number; top: number };

/** Размеры из макета Split.dc.html: узел 200×76, колонки через 40, строки через 20, поле слева 16, заголовки колонок сверху. */
export const GRAPH_DEFAULTS: GraphOptions = { nodeW: 200, nodeH: 76, colGap: 40, rowGap: 20, left: 16, top: 40 };

export type GraphNode = { key: string; existing: boolean; wave?: number; col: number; row: number; x: number; y: number; task?: TeamProposedTask; ref?: ExistingTask };
export type GraphEdge = { from: string; to: string; existing: boolean; path: string };
export type GraphColumn = { col: number; wave?: number; x: number; label: string; note?: string };
export type DepsGraph = { nodes: GraphNode[]; edges: GraphEdge[]; columns: GraphColumn[]; width: number; height: number; crossings: number; options: GraphOptions };

/** Путь ребра от правого края предшественника к левому краю последователя: прямая на одной высоте, иначе кубическая кривая. */
export function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, o: GraphOptions = GRAPH_DEFAULTS): string {
  const x1 = from.x + o.nodeW;
  const y1 = from.y + o.nodeH / 2;
  const x2 = to.x - 2;
  const y2 = to.y + o.nodeH / 2;
  if (y1 === y2) return `M${x1} ${y1} L${x2} ${y2}`;
  const mx = Math.round((x1 + x2) / 2);
  return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
}

type Link = { from: string; to: string };

/** Пересечения рёбер между одними и теми же колонками при данном порядке строк. */
export function countCrossings(cols: readonly (readonly string[])[], links: readonly Link[]): number {
  const col = new Map<string, number>();
  const row = new Map<string, number>();
  cols.forEach((c, ci) => c.forEach((k, ri) => {
    col.set(k, ci);
    row.set(k, ri);
  }));
  const es = links.filter((l) => col.has(l.from) && col.has(l.to));
  let n = 0;
  for (let i = 0; i < es.length; i++) {
    for (let j = i + 1; j < es.length; j++) {
      const a = es[i]!;
      const b = es[j]!;
      if (col.get(a.from) !== col.get(b.from) || col.get(a.to) !== col.get(b.to)) continue;
      const d1 = row.get(a.from)! - row.get(b.from)!;
      const d2 = row.get(a.to)! - row.get(b.to)!;
      if (d1 * d2 < 0) n++;
    }
  }
  return n;
}

/** Порядок строк в колонках: барицентры соседей вперёд и назад, пока пересечений не станет меньше; лучший порядок. */
export function orderRows(cols: readonly (readonly string[])[], links: readonly Link[]): string[][] {
  let cur = cols.map((c) => [...c]);
  let best = cur;
  let bestN = countCrossings(cur, links);
  const colOf = new Map<string, number>();
  cols.forEach((c, ci) => c.forEach((k) => colOf.set(k, ci)));
  const sweep = (order: string[][], forward: boolean): string[][] => {
    const next = order.map((c) => [...c]);
    const rowOf = (k: string): number => next[colOf.get(k)!]!.indexOf(k);
    const idx = forward ? [...next.keys()].slice(1) : [...next.keys()].slice(0, -1).reverse();
    for (const ci of idx) {
      const bary = new Map<string, number>();
      next[ci]!.forEach((k, ri) => {
        const nb = links
          .filter((l) => (forward ? l.to === k && colOf.get(l.from)! < ci : l.from === k && colOf.get(l.to)! > ci))
          .map((l) => rowOf(forward ? l.from : l.to));
        bary.set(k, nb.length ? nb.reduce((s, x) => s + x, 0) / nb.length : ri);
      });
      next[ci] = [...next[ci]!].sort((a, b) => bary.get(a)! - bary.get(b)!);
    }
    return next;
  };
  for (let it = 0; it < 4 && bestN > 0; it++) {
    cur = sweep(cur, true);
    cur = sweep(cur, false);
    const n = countCrossings(cur, links);
    if (n < bestN) {
      best = cur;
      bestN = n;
    } else if (it > 0) break;
  }
  return best;
}

/** Раскладка графа: колонки по волнам слева направо, существующие задачи пунктиром в волне 1, задачи из цикла — в последней колонке. */
export function layoutGraph(tasks: readonly TeamProposedTask[], existing: readonly ExistingTask[], report: TeamDependencyReport, o: GraphOptions = GRAPH_DEFAULTS): DepsGraph {
  const n = wavesCount(report);
  const cyclic = tasks.filter((x) => report.waves[x.key] === undefined);
  const colCount = n + (cyclic.length ? 1 : 0);
  const byCol: string[][] = Array.from({ length: colCount }, () => []);
  const info = new Map<string, { existing: boolean; wave?: number; task?: TeamProposedTask; ref?: ExistingTask }>();
  for (const x of tasks) {
    const w = report.waves[x.key];
    byCol[w === undefined ? colCount - 1 : w - 1]!.push(x.key);
    info.set(x.key, { existing: false, wave: w, task: x });
  }
  for (const x of tasks) {
    for (const d of x.dependsOn) {
      const e = existing.find((y) => y.id === d);
      if (!e || info.has(d) || report.waves[d] === undefined) continue;
      byCol[report.waves[d]! - 1]!.push(d);
      info.set(d, { existing: true, wave: report.waves[d], ref: e });
    }
  }
  const links: Link[] = tasks.flatMap((x) => x.dependsOn.filter((d) => info.has(d)).map((d) => ({ from: d, to: x.key })));
  const ordered = orderRows(byCol, links);
  const nodes: GraphNode[] = [];
  const pos = new Map<string, GraphNode>();
  ordered.forEach((c, ci) => c.forEach((key, ri) => {
    const i = info.get(key)!;
    const node: GraphNode = { key, existing: i.existing, wave: i.wave, col: ci, row: ri, x: o.left + ci * (o.nodeW + o.colGap), y: o.top + ri * (o.nodeH + o.rowGap) };
    if (i.task) node.task = i.task;
    if (i.ref) node.ref = i.ref;
    nodes.push(node);
    pos.set(key, node);
  }));
  const edges: GraphEdge[] = links.map((l) => ({ from: l.from, to: l.to, existing: info.get(l.from)!.existing, path: edgePath(pos.get(l.from)!, pos.get(l.to)!, o) }));
  const columns: GraphColumn[] = ordered.map((_, ci) => {
    const wave = ci < n ? ci + 1 : undefined;
    const col: GraphColumn = { col: ci, wave, x: o.left + ci * (o.nodeW + o.colGap), label: wave === undefined ? t('Цикл') : t('Волна {n}', { n: wave }) };
    if (wave === 1) col.note = t('сейчас');
    return col;
  });
  const rows = Math.max(0, ...ordered.map((c) => c.length));
  return {
    nodes, edges, columns, options: o, crossings: countCrossings(ordered, links),
    width: colCount ? o.left * 2 + colCount * o.nodeW + (colCount - 1) * o.colGap : 0,
    height: rows ? o.top + rows * o.nodeH + (rows - 1) * o.rowGap + o.left : 0,
  };
}

export type FocusState = 'selected' | 'before' | 'after' | 'dim';
export type GraphFocus = { key: string; before: string[]; after: string[]; nodes: Record<string, FocusState>; edges: boolean[] };

/** Подсветка выбранной задачи: все предшественники и последователи по цепочкам, остальное приглушено; рёбра на этих путях. */
export function focusGraph(graph: Pick<DepsGraph, 'nodes' | 'edges'>, key: string): GraphFocus {
  const walk = (start: string, dir: 'before' | 'after'): string[] => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const k = stack.pop()!;
      for (const e of graph.edges) {
        const next = dir === 'before' ? (e.to === k ? e.from : null) : e.from === k ? e.to : null;
        if (next && !seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    seen.delete(start);
    return [...seen];
  };
  const before = walk(key, 'before');
  const after = walk(key, 'after');
  const nodes: Record<string, FocusState> = {};
  for (const n of graph.nodes) nodes[n.key] = n.key === key ? 'selected' : before.includes(n.key) ? 'before' : after.includes(n.key) ? 'after' : 'dim';
  const lit = new Set([key, ...before, ...after]);
  const edges = graph.edges.map((e) => lit.has(e.from) && lit.has(e.to) && !(before.includes(e.from) && after.includes(e.to)));
  return { key, before, after, nodes, edges };
}

/** Рёбра самой длинной цепочки — для кнопки «Показать». */
export const chainEdges = (graph: Pick<DepsGraph, 'edges'>, report: TeamDependencyReport): boolean[] => {
  const pairs = new Set(report.chain.keys.slice(1).map((k, i) => `${report.chain.keys[i]}→${k}`));
  return graph.edges.map((e) => pairs.has(`${e.from}→${e.to}`));
};
