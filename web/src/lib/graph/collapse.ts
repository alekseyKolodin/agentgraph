// Большой flow в конструкторе (components/graph/FlowGraph.tsx, docs/flow-redesign/SPEC.md → «Правка» → «большой flow»):
// сверху блоки плитками, ниже раскрыт только один блок. Здесь — без React: порог «большой», плитки, какой блок раскрыть,
// поиск этапа и вырезка одного блока из готовой модели (ключи, номера и данные узлов те же, меняются только координаты).
import { plural } from '../format';
import { t } from '../i18n';
import { ART_BUS, ART_LANE, MARGIN, type GraphEdge, type GraphFrame, type GraphModel, type GraphNode, type Point } from './model';

/** Маленький flow — до стольких блоков и этапов включительно: он, как и flow из одного блока, рисуется целиком. */
export const SMALL_BLOCKS = 3;
export const SMALL_PHASES = 8;

const isStep = (n: GraphNode) => n.kind === 'phase' || n.kind === 'call';
const blockFrames = (m: GraphModel) => m.frames.filter((f) => f.kind === 'block');

/** Сколько в модели блоков и этапов (узел вызова — тоже этап). */
export function flowSize(m: GraphModel): { blocks: number; phases: number } {
  const steps = m.nodes.filter(isStep);
  return { blocks: new Set(steps.map((n) => n.b)).size, phases: steps.length };
}

/** Большой flow: больше одного блока и больше SMALL_BLOCKS блоков или SMALL_PHASES этапов. */
export function isBigFlow(m: GraphModel): boolean {
  const { blocks, phases } = flowSize(m);
  return blocks > 1 && (blocks > SMALL_BLOCKS || phases > SMALL_PHASES);
}

export type BlockTile = {
  b: number;
  block: string;
  key: string;
  label: string;
  /** Этапов в блоке; у блока-вызова — имя вызываемого flow. */
  steps: number;
  flow?: string;
  iters?: number;
  until?: string;
  next?: number[];
  /** Блок может спросить человека: этап с AskUserQuestion или пауза цикла (pause_marker). */
  asks: boolean;
  /** Сколько этапов задела правка ИИ; changedBlock — сам блок (цикл, название, развилка) или узел вызова. */
  changed: number;
  changedBlock: boolean;
  /** Сколько этапов нашёл поиск. */
  found: number;
};

/** Плитки блоков по рамкам модели: правка ИИ — по changed (имена этапов) и changedBlocks (имена блоков), поиск — по found (ключи узлов). */
export function blockTiles(m: GraphModel, changed?: Set<string>, changedBlocks?: Set<string>, found?: Set<string>): BlockTile[] {
  return blockFrames(m).map((f) => {
    const own = m.nodes.filter((n) => isStep(n) && n.b === f.b);
    return {
      b: f.b!, block: f.block!, key: f.key, label: f.label || f.block!, steps: own.length,
      ...(f.flow !== undefined ? { flow: f.flow } : {}),
      ...(f.iters !== undefined ? { iters: f.iters, until: f.until } : {}),
      ...(f.next ? { next: f.next } : {}),
      asks: own.some((n) => n.asks) || Boolean(f.pauses),
      changed: own.filter((n) => n.kind === 'phase' && changed?.has(n.name!)).length,
      changedBlock: Boolean(changedBlocks?.has(f.block!)),
      found: own.filter((n) => found?.has(n.key)).length,
    };
  });
}

/** Есть ли на плитке пометка правки ИИ. */
export const tileChanged = (tile: BlockTile): boolean => tile.changed > 0 || tile.changedBlock;

/** Подпись плитки под названием: «3 этапа · до 12 раз», «2 этапа · один раз», «вызов flow x». */
export function tileMeta(tile: BlockTile): string {
  if (tile.flow !== undefined) return t('вызов flow {flow}', { flow: tile.flow });
  const steps = `${tile.steps} ${plural(tile.steps, 'этап', 'этапа', 'этапов')}`;
  const n = tile.iters;
  // «до» — всегда «раз» («до 4 раз»), «ровно» — по числу («ровно 2 раза»)
  const times = n === undefined ? t('один раз') : tile.until === 'none' ? `${t('ровно')} ${n} ${plural(n, 'раз', 'раза', 'раз')}` : t('до {n} раз', { n });
  return `${steps} · ${times}`;
}

/** Пометка правки ИИ на плитке: «2 изменены», «1 изменён», «изменён» (сам блок); без правки — пусто. */
export function tileChangedLabel(tile: BlockTile): string {
  if (tile.changed > 0) return `${tile.changed} ${plural(tile.changed, 'изменён', 'изменены', 'изменены')}`;
  return tile.changedBlock ? t('изменён') : '';
}

/** Куда ведёт развилка после блока: «дальше: 4, конец»; без next — пусто. total — число блоков. */
export function tileNext(tile: BlockTile, total: number): string {
  if (!tile.next?.length) return '';
  return t('дальше: {to}', { to: tile.next.map((to) => (to >= total ? t('конец') : String(to + 1))).join(', ') });
}

/** Блок, в котором выбранное: этап по имени, узел или рамка по ключу, блок по индексу. Ничего не выбрано или нет в модели — null. */
export function blockOfSelection(m: GraphModel, sel: { name?: string | null; key?: string | null; block?: number }): number | null {
  if (sel.name) {
    const n = m.nodes.find((x) => isStep(x) && x.name === sel.name);
    if (n) return n.b!;
  }
  if (sel.key) {
    const o = [...m.nodes, ...m.frames].find((x) => x.key === sel.key);
    if (o?.b !== undefined) return o.b;
  }
  return sel.block !== undefined && sel.block >= 0 && blockFrames(m).some((f) => f.b === sel.block) ? sel.block : null;
}

/** Первый блок, который задела правка ИИ; правки нет — null. */
export const firstChangedBlock = (tiles: BlockTile[]): number | null => tiles.find(tileChanged)?.b ?? null;

/** Какой блок раскрыть при открытии: выбранного, иначе первый изменённый, иначе первый. */
export function initialOpenBlock(m: GraphModel, sel: Parameters<typeof blockOfSelection>[1], tiles: BlockTile[]): number {
  return blockOfSelection(m, sel) ?? firstChangedBlock(tiles) ?? tiles[0]?.b ?? 0;
}

const norm = (s: string) => s.toLocaleLowerCase().replace(/ё/g, 'е').trim();

/** Этапы, у которых название, имя или номер («2.3») содержит запрос; по порядку блоков. Пустой запрос — ничего. */
export function findPhases(m: GraphModel, query: string): GraphNode[] {
  const q = norm(query);
  if (!q) return [];
  return m.nodes.filter((n) => isStep(n) && [n.title, n.name, n.num, n.flow].some((v) => v && norm(v).includes(q)));
}

const shift = (p: Point, dx: number, dy: number): Point => [p[0] + dx, p[1] + dy];

/**
 * Один блок из модели как отдельная модель: его рамка, этапы, группы, ромб, рёбра внутри и дуга цикла; у первого блока — ещё
 * «Задача» с ребром. Блок встаёт к левому верхнему краю. Колонка артефактов остаётся вся и встаёт справа от блока; рёбра к ней —
 * только от этапов блока: их часть у блока сдвигается с блоком, шина и подход к артефакту — с колонкой (трасса — см. flowGraphModel).
 * Блока нет — модель как есть.
 */
export function sliceBlock(m: GraphModel, bi: number): GraphModel {
  const frame = m.frames.find((f) => f.kind === 'block' && f.b === bi);
  if (!frame) return m;
  const first = bi === 0;
  const own = (o: { b?: number; kind: string }) => o.b === bi && o.kind !== 'arts' && o.kind !== 'artifact';
  const dx = first ? 0 : MARGIN - frame.x;
  const dy = MARGIN - frame.y;
  const nodes: GraphNode[] = [];
  const frames: GraphFrame[] = [];
  for (const n of m.nodes) if (own(n) || (first && n.kind === 'start')) nodes.push({ ...n, x: n.x + dx, y: n.y + dy });
  for (const f of m.frames) if (own(f)) frames.push({ ...f, x: f.x + dx, y: f.y + dy });
  const ids = new Set([...nodes.map((n) => n.id), ...frames.map((f) => f.key)]);

  // правый край блока; подпись под ромбом (не шире 180px) может выступать за рамку, как в flowGraphModel
  let right = Math.max(...[...nodes, ...frames].map((o) => o.x + o.w));
  for (const n of nodes) if (n.kind === 'cond') right = Math.max(right, n.x + n.w / 2 + 90);

  const edges: GraphEdge[] = [];
  const move = (e: GraphEdge, pts: Point[]): GraphEdge => ({ ...e, points: pts, ...(e.lx !== undefined ? { lx: e.lx + dx, ly: e.ly! + dy } : {}) });
  const artFrame = m.frames.find((f) => f.kind === 'arts');
  const artNodes = m.nodes.filter((n) => n.kind === 'artifact');
  // старый правый край блоков восстанавливается по колонке: frame.x = blocksRight + 2·ART_BUS + 2·артефактов·ART_LANE
  const da = artFrame ? right - (artFrame.x - 2 * ART_BUS - artNodes.length * 2 * ART_LANE) : 0;
  for (const e of m.edges) {
    if (e.kind === 'art-write' || e.kind === 'art-read') {
      const phase = e.kind === 'art-write' ? e.from : e.to;
      if (!ids.has(phase)) continue;
      // трасса записи: этап → вправо → вниз в канал → по каналу к шине → по шине → в артефакт; у чтения — та же наоборот
      const pts = e.kind === 'art-write' ? e.points : [...e.points].reverse();
      const moved = pts.map((p, k): Point => (k < 3 ? shift(p, dx, dy) : k === 3 ? [p[0] + da, p[1] + dy] : [p[0] + da, p[1]]));
      edges.push(move(e, e.kind === 'art-write' ? moved : moved.reverse()));
      continue;
    }
    if (ids.has(e.from) && ids.has(e.to)) edges.push(move(e, e.points.map((p) => shift(p, dx, dy))));
  }
  if (artFrame) {
    frames.push({ ...artFrame, x: artFrame.x + da });
    for (const n of artNodes) nodes.push({ ...n, x: n.x + da });
  }
  const all = [...nodes, ...frames];
  const width = Math.max(right, ...all.map((o) => o.x + o.w));
  const height = Math.max(...all.map((o) => o.y + o.h));
  return { nodes, edges, frames, width: Math.ceil(width + MARGIN), height: Math.ceil(height + MARGIN) };
}

/** «Только изменённое»: плитки, которые задела правка ИИ (выбранная — всегда, чтобы раскрытый блок не потерял плитку). */
export const visibleTiles = (tiles: BlockTile[], onlyChanged: boolean, open: number): BlockTile[] =>
  onlyChanged ? tiles.filter((x) => tileChanged(x) || x.b === open) : tiles;
