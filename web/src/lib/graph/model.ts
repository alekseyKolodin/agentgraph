// Модель и раскладка графа flow (порт ui/graph.js flowGraphModel): узлы, рёбра и рамки с готовыми координатами.
// Один граф для конструктора, вкладки «Запуск» и страницы запуска; рисует его components/graph/FlowGraph.tsx.
import { t } from '../i18n';
import { iterTo, iterWord, loopLabel, textW } from './text';

/** Этап в той форме, которую читает граф: editable-spec конструктора или снимок flow запуска. */
export type GraphPhase = {
  name: string;
  title?: string;
  model?: string;
  effort?: string;
  tools?: string[];
  group?: string;
  prompt?: string;
  handoff?: string;
  reads?: string[];
  writes?: string[];
};
export type GraphUntil = { type?: string; run?: string; marker?: string };
export type GraphLoop = { max_iterations: number; until: GraphUntil };
/** Правило развилки next: условие (как until, без none) и куда идти — блок ниже или end. */
export type GraphNextRule = { if?: GraphUntil & { prompt?: string; phase?: string }; goto: string };
export type GraphBlock = {
  name: string;
  title?: string;
  knowledge?: string[];
  loop?: GraphLoop;
  on_fail?: string;
  phases: GraphPhase[];
  /** Блок-вызов: имя вызываемого flow; на графе — один узел вызова вместо этапов. */
  flow?: string;
  input?: string;
  next?: string | GraphNextRule[];
};
export type GraphArtifact = { title?: string; file?: string } | null | undefined;
/** Форма blocks, как после toEditable. */
export type GraphSpec = { blocks?: GraphBlock[]; artifacts?: Record<string, GraphArtifact> };

export type NodeKind = 'start' | 'phase' | 'cond' | 'artifact' | 'call' | 'end';
export type GraphNode = {
  id: string;
  key: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  /** Индекс блока и этапа: у этапа оба, у условия — блок. */
  b?: number;
  i?: number;
  block?: string;
  name?: string;
  num?: string;
  tools?: number;
  group?: string;
  /** Что этап получает (строки «← prev»…); есть, только если модель строили с inputsOf. */
  inputs?: string[];
  warn?: string;
  /** Тип условия у ромба. */
  type?: string;
  art?: string;
  /** Узел вызова: имя вызываемого flow. */
  flow?: string;
};

export type EdgeKind = 'flow' | 'next' | 'loop' | 'art-write' | 'art-read';
export type Point = [number, number];
export type GraphEdge = {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  points: Point[];
  /** Подпись — одна на пучок рёбер: центр (lx, ly) и предельная ширина lw. */
  label?: string;
  lx?: number;
  ly?: number;
  lw?: number;
  block?: string;
  untilType?: string;
  art?: string;
};

export type FrameKind = 'block' | 'group' | 'arts';
export type GraphFrame = {
  kind: FrameKind;
  key: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  b?: number;
  i?: number;
  block?: string;
  group?: string;
  /** Шапка рамки блока: «↺ до N итераций» или «один проход», чипы тегов знаний. */
  loop?: string;
  knowledge?: string[];
};

export type GraphModel = { nodes: GraphNode[]; edges: GraphEdge[]; frames: GraphFrame[]; width: number; height: number };

export const NODE_W = 210;
export const NODE_H = 88;
export const COL_GAP = 120; // между колонками: здесь стоит подпись ребра
export const ROW_GAP = 22; // между участниками группы
export const MARGIN = 24;
export const FPAD = 14; // поля рамки блока
export const FRAME_HEAD = 34; // шапка рамки блока: название, цикл, теги знаний
export const LOOP_H = 36; // полоса обратной дуги над узлами блока
export const GPAD = 10; // поля рамки группы
export const GROUP_HEAD = 26;
export const COND = 44; // ромб условия
export const LANE_GAP = 64; // между полосами блоков: здесь идёт ребро к следующему блоку
export const ART_W = 200;
export const ART_H = 100; // название, файл, автор и строка «открыто N из M» / «✎ пишет этап X»
export const ART_GAP = 16; // между узлами в колонке артефактов
export const ART_LANE = 5; // шаг между параллельными трассами рёбер артефактов
export const ART_BUS = 18; // от правого края блоков до первой вертикали шины
const ART_REF = /\{\{\s*artifacts\.([A-Za-z0-9_-]+)(?:\.path)?\s*\}\}/g;

/** Шаг блока, как его исполняет раннер: соседние этапы с одной группой — один шаг. from/to — индексы этапов. */
export type BlockStep = { group: string; from: number; to: number };

export function blockSteps(block: GraphBlock): BlockStep[] {
  const steps: BlockStep[] = [];
  block.phases.forEach((p, i) => {
    const last = steps.at(-1);
    if (p.group && last?.group === p.group) last.to = i;
    else steps.push({ group: p.group || '', from: i, to: i });
  });
  return steps;
}

export const isGroupStep = (s: BlockStep | null | undefined): boolean => Boolean(s && s.to > s.from);

/** Источник {{prev}} для шага: этап или группа. */
export const stepSource = (block: GraphBlock, s: BlockStep): string =>
  isGroupStep(s) ? t('группа {g}', { g: s.group }) : block.phases[s.from]?.name || '';

/** Что шаг передаёт дальше: handoff этапа или склейку выводов группы. */
export const stepHandoff = (block: GraphBlock, s: BlockStep): string =>
  isGroupStep(s) ? t('выводы группы {g} (склейка)', { g: s.group }) : block.phases[s.from]?.handoff || t('весь ответ');

export function condLabel(loop: GraphLoop): string {
  const u = loop.until;
  return u.type === 'command' ? `$ ${u.run || '…'}` : u.type === 'judge' ? t('⚖ судья') : u.type === 'marker' ? t('маркер {m}', { m: u.marker || '…' }) : t('ровно {n}', { n: iterWord(loop.max_iterations) });
}

/** Совпадает с artifactAccess на сервере. Чтение: reads и подстановки в промпте и handoff. Запись: writes, она включает чтение. */
export function phaseArtifactAccess(p: GraphPhase): { read: string[]; write: string[] } {
  const subs = [...`${p.prompt || ''}\n${p.handoff || ''}`.matchAll(ART_REF)].map((m) => m[1]!);
  const write = [...new Set(p.writes || [])];
  const read = [...new Set([...(p.reads || []), ...subs])].filter((k) => !write.includes(k));
  return { read, write };
}

export const blockHeading = (b: { title?: string }, bi: number): string => `${t('Блок {n}', { n: bi + 1 })}${b.title ? ` · ${b.title}` : ''}`;

/**
 * Оценка ширины шапки рамки блока: название, «↺ до N», чипы знаний и запас под бейдж «итер. X/N» / «пропущен».
 * Шапка в одну строку (высота FRAME_HEAD в раскладке фиксирована), поэтому рамка не уже этой оценки.
 */
const headWidth = (title: string, loop: string, chips: string[]): number =>
  24 + textW(title, 7.6) + 8 + textW(loop, 6.6) + chips.reduce((w, c) => w + 8 + textW(c, 6.6) + 14, 0) + 8 + 72;

export type GraphModelOptions = {
  /** Что этап получает (строки «← prev»…); без колбэка строки на узле нет. */
  inputsOf?: (bi: number, i: number) => string[] | undefined;
  /** Нарисовать колонку артефактов справа от блоков (только если у flow они объявлены). */
  artifacts?: boolean;
  /** Подпись узла вызова по имени вызываемого flow («2 блока · 3 этапа»); без неё — «вызов flow». */
  callSub?: (flow: string) => string | undefined;
};

/** Конец запуска как цель next. */
export const NEXT_END = 'end';
export const END_W = 140;
export const END_H = 44;
const BRANCH_ROW = 22; // между горизонталями рёбер развилки под блоком: подписи не налезают друг на друга
const SKIP_LANE = 12; // шаг между вертикалями рёбер, которые перепрыгивают через блоки

/** Правила next списком: строка — одно безусловное правило. */
export const nextRulesOf = (b: Pick<GraphBlock, 'next'>): GraphNextRule[] =>
  b.next === undefined ? [] : typeof b.next === 'string' ? [{ goto: b.next }] : b.next;

/** Подпись ребра развилки: условие правила. */
export function nextCondLabel(c: NonNullable<GraphNextRule['if']>): string {
  return c.type === 'marker' ? `${c.marker || '…'} →` : c.type === 'command' ? `$ ${c.run || '…'} →` : t('судья: да →');
}

/**
 * Куда ведёт блок bi из n: индекс цели (n — конец запуска) → подпись ребра. Правила next по порядку; правило без if —
 * «иначе»; без безусловного правила — ещё и следующий блок по порядку. Без next — следующий блок с подписью fallback.
 */
export function blockTargets(b: Pick<GraphBlock, 'next'>, bi: number, names: string[], fallback: string): Map<number, string> {
  const rules = nextRulesOf(b);
  const out = new Map<number, string>();
  const add = (to: number, label: string) => out.set(to, out.has(to) ? `${out.get(to)} · ${label}` : label);
  for (const r of rules) {
    const to = r.goto === NEXT_END ? names.length : names.indexOf(r.goto);
    if (to <= bi) continue; // переход назад или в неизвестный блок валидация не пропустит; граф не падает
    add(to, r.if ? nextCondLabel(r.if) : rules.length > 1 ? t('иначе →') : fallback);
  }
  if (!rules.some((r) => !r.if)) add(bi + 1, rules.length ? t('иначе →') : fallback);
  return out;
}

type Box = { id: string; x: number; y: number; w: number; h: number };
type ArtLink = { n: GraphNode; kind: 'art-write' | 'art-read'; key: string; j: number; li: number; y: number };

/** Модель графа из editable-spec: узлы, рёбра и рамки с готовыми координатами. */
export function flowGraphModel(spec: GraphSpec, opts: GraphModelOptions = {}): GraphModel {
  const blocks = spec.blocks || [];
  const multi = blocks.length > 1;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const frames: GraphFrame[] = [];
  const x0 = MARGIN + NODE_W + COL_GAP + GPAD + FPAD; // левый край первой колонки этапов
  const start: GraphNode = { id: 'start', key: 'start', kind: 'start', x: MARGIN, y: MARGIN, w: NODE_W, h: NODE_H, title: t('Задача'), sub: '{{input}}' };
  nodes.push(start);
  let laneTop = MARGIN;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  let prev: { end: Box; frameBottom: number; targets: Map<number, string> } | null = null; // чем кончился предыдущий блок и куда из него идти
  // артефакты — колонка справа от всех блоков. Рёбра к ней идут через свой промежуток и канал под своим блоком,
  // поэтому не пересекают другие блоки. Трасса достраивается после раскладки блоков, когда известен их правый край
  const arts = opts.artifacts ? Object.entries(spec.artifacts || {}) : [];
  const artIndex = new Map(arts.map(([k], j) => [k, j]));
  const artLinks: ArtLink[] = [];

  // ребро «пучком»: от каждого источника к каждой цели, вертикаль посередине промежутка, подпись — одна на пучок
  const connect = (srcs: Box[], tgts: Box[], label: string, kind: EdgeKind, mid: number) => {
    const sx = Math.max(...srcs.map((n) => n.x + n.w));
    const tx = Math.min(...tgts.map((n) => n.x));
    const mx = (sx + tx) / 2;
    let first = true;
    for (const s of srcs) {
      for (const t of tgts) {
        const a: Point = [s.x + s.w, s.y + s.h / 2];
        const z: Point = [t.x, t.y + t.h / 2];
        const points: Point[] = a[1] === z[1] ? [a, z] : [a, [mx, a[1]], [mx, z[1]], z];
        edges.push({ id: `${s.id}->${t.id}`, kind, from: s.id, to: t.id, points, ...(first ? { label, lx: mx, ly: mid, lw: COL_GAP - 12 } : {}) });
        first = false;
      }
    }
  };

  const names = blocks.map((b) => b.name);
  // вход в каждый блок и выход из него — для рёбер развилки, которые перепрыгивают через блоки
  const entries: (GraphNode[] | undefined)[] = [];
  const exits: { bi: number; end: Box; frameBottom: number; targets: Map<number, string> }[] = [];
  blocks.forEach((raw, bi) => {
    // блок-вызов — один узел вызова; ключ как у этапа (p:<блок>:<блок>): так его находят статусы запуска
    const call = raw.flow !== undefined;
    const b: GraphBlock = call ? { ...raw, phases: [{ name: raw.name, title: raw.title || raw.flow, prompt: raw.input, handoff: t('итог вызванного flow') }] } : raw;
    const steps = blockSteps(b);
    const framed = multi || Boolean(b.title) || Boolean(b.knowledge?.length);
    const hasGroup = steps.some(isGroupStep);
    const head = framed ? FPAD + FRAME_HEAD : 0;
    const loopY = laneTop + head + LOOP_H / 2;
    const top = laneTop + head + (b.loop ? LOOP_H : 0) + (hasGroup ? GROUP_HEAD + 4 : 0);
    const mid = top + NODE_H / 2;
    if (!prev) start.y = top;
    let x = x0;
    const cols = steps.map((s) => {
      const members = b.phases.slice(s.from, s.to + 1).map((p, k) => {
        const i = s.from + k;
        const n: GraphNode = {
          id: `p:${b.name}:${p.name}`, key: `p:${b.name}:${p.name}`, kind: call ? 'call' : 'phase', b: bi, i, block: b.name, name: p.name,
          num: multi ? `${bi + 1}.${i + 1}` : `${i + 1}`, title: p.title || p.name,
          sub: call ? opts.callSub?.(raw.flow!) || t('вызов flow') : [p.name, p.model, p.effort].filter(Boolean).join(' · '),
          tools: (p.tools || []).length, group: p.group || '',
          x, y: top + k * (NODE_H + ROW_GAP), w: NODE_W, h: NODE_H,
          ...(call ? { flow: raw.flow } : {}),
        };
        if (opts.inputsOf) {
          n.inputs = opts.inputsOf(bi, i) || [];
          if (!n.inputs.length) n.warn = t('ничего не получает');
        }
        nodes.push(n);
        return n;
      });
      let box: Box = { id: '', x, y: top, w: NODE_W, h: NODE_H };
      let frameKey = '';
      if (isGroupStep(s)) {
        const h = members.length * NODE_H + (members.length - 1) * ROW_GAP;
        frameKey = `g:${b.name}:${s.group}`;
        box = { id: frameKey, x: x - GPAD, y: top - GROUP_HEAD, w: NODE_W + 2 * GPAD, h: GROUP_HEAD + h + GPAD };
        frames.push({ kind: 'group', key: frameKey, b: bi, i: s.to, block: b.name, group: s.group, title: `∥ ${s.group}`, x: box.x, y: box.y, w: box.w, h: box.h });
      }
      x += NODE_W + COL_GAP;
      return { s, members, box, frameKey };
    });
    let cond: GraphNode | null = null;
    if (b.loop) {
      cond = { id: `c:${b.name}`, key: `c:${b.name}`, kind: 'cond', b: bi, block: b.name, type: b.loop.until?.type, title: t('Условие'), sub: condLabel(b.loop), x, y: mid - COND / 2, w: COND, h: COND };
      nodes.push(cond);
      x += COND;
    } else {
      x -= COL_GAP;
    }
    let contentBottom = Math.max(...cols.map((c) => c.box.y + c.box.h), cond ? cond.y + cond.h + 18 : 0);

    // вход в блок: от «Задачи» или от конца предыдущего блока. Блок без этапов (недописанный YAML) пропускаем, граф не падает
    const firstCol = cols[0];
    if (!firstCol) return;
    entries[bi] = firstCol.members;
    // канал под узлами блока для рёбер артефактов: у каждой пары «артефакт + чтение или запись» своя дорожка
    if (artIndex.size) {
      const mine: Omit<ArtLink, 'y'>[] = [];
      for (const c of cols) {
        for (const n of c.members) {
          const { read, write } = phaseArtifactAccess(b.phases[n.i!]!);
          const links = [...write.map((k) => ['art-write', k] as const), ...read.map((k) => ['art-read', k] as const)].filter(([, k]) => artIndex.has(k));
          links.forEach(([kind, key], j) => mine.push({ n, kind, key, j, li: artIndex.get(key)! * 2 + (kind === 'art-read' ? 1 : 0) }));
        }
      }
      const lanes = [...new Set(mine.map((l) => l.li))].sort((a, z) => a - z);
      for (const l of mine) artLinks.push({ ...l, y: contentBottom + 12 + lanes.indexOf(l.li) * ART_LANE });
      if (lanes.length) contentBottom += 12 + lanes.length * ART_LANE;
    }
    if (!prev) connect([start], firstCol.members, t('задача'), 'flow', mid);
    else if (prev.targets.has(bi)) {
      const e = prev.end;
      const sx = e.x + e.w / 2;
      const sy = e.y + e.h;
      const gapY = prev.frameBottom + LANE_GAP / 2;
      const cx = x0 - GPAD - FPAD - 22;
      let first = true;
      for (const t of firstCol.members) {
        const ty = t.y + t.h / 2;
        edges.push({
          id: `${e.id}->${t.id}`, kind: 'next', from: e.id, to: t.id, points: [[sx, sy], [sx, gapY], [cx, gapY], [cx, ty], [t.x, ty]],
          ...(first ? { label: prev.targets.get(bi)!, lx: (sx + cx) / 2, ly: gapY, lw: 220 } : {}),
        });
        first = false;
      }
    }
    for (let si = 1; si < cols.length; si++) connect(cols[si - 1]!.members, cols[si]!.members, stepHandoff(b, steps[si - 1]!), 'flow', mid);
    const lastCol = cols.at(-1)!;
    if (cond && b.loop) {
      connect(lastCol.members, [cond], stepHandoff(b, lastCol.s), 'flow', mid);
      const cx = cond.x + cond.w / 2;
      const fx = firstCol.box.x + firstCol.box.w / 2;
      edges.push({
        id: `${cond.id}->loop`, kind: 'loop', from: cond.id, to: firstCol.members[0]!.id, block: b.name, untilType: b.loop.until?.type,
        points: [[cx, cond.y], [cx, loopY], [fx, loopY], [fx, firstCol.box.y]],
        label: loopLabel(b.loop.until?.type, b.loop.max_iterations), lx: (cx + fx) / 2, ly: loopY, lw: 200,
      });
    }

    let frameBottom = contentBottom;
    if (framed) {
      const title = multi ? blockHeading(b, bi) : b.title || t('Блок');
      const loopNote = b.loop ? t('↺ до {n}', { n: iterTo(b.loop.max_iterations) }) : t('один проход');
      const knowledge = [...(b.knowledge || [])];
      const fr: GraphFrame = {
        kind: 'block', key: `b:${b.name}`, b: bi, block: b.name, title, loop: loopNote, knowledge,
        x: x0 - GPAD - FPAD, y: laneTop,
        w: Math.max(x - x0 + 2 * (GPAD + FPAD), Math.ceil(headWidth(title, loopNote, knowledge))),
        h: contentBottom + FPAD - laneTop,
      };
      frames.push(fr);
      frameBottom = fr.y + fr.h;
      right = Math.max(right, fr.x + fr.w);
    } else {
      right = Math.max(right, x + GPAD);
    }
    // подпись под ромбом (по центру, не шире 180px, см. .fg-cond-label) может выступать за рамку: шину артефактов ставим правее
    if (cond) right = Math.max(right, cond.x + cond.w / 2 + Math.min(90, textW(cond.sub, 6.6) / 2 + 6));
    bottom = Math.max(bottom, frameBottom);
    const loop = b.loop;
    const nextLabel = !loop
      ? stepHandoff(b, lastCol.s)
      : loop.until?.type === 'none' ? t('после {n} →', { n: iterWord(loop.max_iterations) }) : b.on_fail === 'continue' ? t('выполнено или лимит →') : t('выполнено →');
    const end = cond || (isGroupStep(lastCol.s) ? { ...lastCol.box, id: lastCol.frameKey } : lastCol.members[0]!);
    const targets = blockTargets(b, bi, names, nextLabel);
    prev = { end, frameBottom, targets };
    exits.push({ bi, end, frameBottom, targets });
    // рёбра через блоки идут своими горизонталями под блоком: промежуток до следующего блока шире на их число
    const far = [...targets.keys()].filter((to) => to > bi + 1 || (to === blocks.length && to !== bi + 1)).length;
    laneTop = frameBottom + LANE_GAP + far * BRANCH_ROW;
  });

  // развилка: «Конец», если на него ведёт правило next, и рёбра, которые перепрыгивают через блоки (или ведут в «Конец»).
  // Ребро к соседнему блоку нарисовано выше, как раньше. Трасса: вниз под блок, влево на свою вертикаль левее канала
  // обычных рёбер, вниз до цели, вправо в её первый узел
  const toEnd = blocks.some((b) => nextRulesOf(b).some((r) => r.goto === NEXT_END));
  if (toEnd) {
    const endNode: GraphNode = { id: 'end', key: 'end', kind: 'end', title: t('Конец'), sub: '', x: x0, y: laneTop, w: END_W, h: END_H };
    nodes.push(endNode);
    bottom = Math.max(bottom, endNode.y + endNode.h);
    right = Math.max(right, endNode.x + endNode.w);
  }
  const channel = x0 - GPAD - FPAD - 22;
  let lane = 0;
  for (const ex of exits) {
    let row = 0;
    for (const [to, label] of ex.targets) {
      if (to === ex.bi + 1 && to < blocks.length) continue;
      const tgts = to === blocks.length ? nodes.filter((n) => n.kind === 'end') : entries[to];
      if (!tgts?.length) continue;
      // в «Конец» из последнего блока — по обычному каналу, через блоки — каждое ребро на своей вертикали
      const adjacent = to === ex.bi + 1;
      const lx = adjacent ? channel : Math.max(start.x + start.w + 8, channel - SKIP_LANE * ++lane);
      const sx = ex.end.x + ex.end.w / 2;
      const sy = ex.end.y + ex.end.h;
      const gy = ex.frameBottom + LANE_GAP / 2 + (adjacent ? 0 : ++row) * BRANCH_ROW;
      let first = true;
      for (const t of tgts) {
        const ty = t.y + t.h / 2;
        edges.push({
          id: `${ex.end.id}->${t.id}`, kind: 'next', from: ex.end.id, to: t.id, points: [[sx, sy], [sx, gy], [lx, gy], [lx, ty], [t.x, ty]],
          ...(first ? { label, lx: (sx + lx) / 2, ly: gy, lw: 220 } : {}),
        });
        first = false;
      }
    }
  }

  // колонка артефактов: узел на артефакт, рёбра записи (сплошные) и чтения (пунктир).
  // Трасса ребра: из правого бока этапа вправо и вниз по промежутку за его колонкой, по каналу под блоком к шине справа
  // от всех блоков, по шине — к артефакту. У каждой пары «артефакт + чтение или запись» своя вертикаль шины
  if (arts.length) {
    const lanes = arts.length * 2;
    const blocksRight = right;
    const busX = (li: number) => blocksRight + ART_BUS + li * ART_LANE;
    const ax = blocksRight + ART_BUS + lanes * ART_LANE + ART_BUS + FPAD;
    const artNodes = new Map<string, GraphNode>();
    arts.forEach(([key, a], j) => {
      const n: GraphNode = {
        id: `a:${key}`, key: `a:${key}`, kind: 'artifact', art: key, title: a?.title || key, sub: a?.file || `${key}.md`,
        x: ax, y: MARGIN + FRAME_HEAD + j * (ART_H + ART_GAP), w: ART_W, h: ART_H,
      };
      artNodes.set(key, n);
      nodes.push(n);
    });
    const frame: GraphFrame = {
      kind: 'arts', key: 'arts', title: t('Артефакты'), x: ax - FPAD, y: MARGIN,
      w: ART_W + 2 * FPAD, h: FRAME_HEAD + arts.length * (ART_H + ART_GAP) - ART_GAP + FPAD,
    };
    frames.push(frame);
    right = frame.x + frame.w;
    bottom = Math.max(bottom, frame.y + frame.h);
    for (const l of artLinks) {
      const a = artNodes.get(l.key)!;
      const k = l.j % 5; // несколько рёбер у одного этапа: выходы ниже середины узла, чтобы не лечь на ребро потока
      const sx = l.n.x + l.n.w;
      const sy = l.n.y + l.n.h - 10 - k * 6;
      const vx = sx + 12 + k * ART_LANE;
      const bx = busX(l.li);
      const ay = a.y + a.h / 2 + (l.kind === 'art-read' ? 8 : -8);
      const pts: Point[] = [[sx, sy], [vx, sy], [vx, l.y], [bx, l.y], [bx, ay], [a.x, ay]];
      const write = l.kind === 'art-write';
      edges.push({
        id: `${l.kind}:${l.n.id}:${l.key}`, kind: l.kind, art: l.key,
        from: write ? l.n.id : a.id, to: write ? a.id : l.n.id, points: write ? pts : pts.reverse(),
      });
    }
  }
  return { nodes, edges, frames, width: Math.ceil(right + MARGIN), height: Math.ceil(bottom + MARGIN) };
}
