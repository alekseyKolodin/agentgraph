// Граф flow (ui/graph.js renderFlowGraph и холст): один компонент для конструктора (edit, есть «+»), вкладки «Запуск» (view)
// и страницы запуска (run, статусы узлов). Раскладка — lib/graph/model.ts; холст — @xyflow/react: узлы и рамки модели — его узлы
// (не двигаются, не выделяются), рёбра — его рёбра с готовыми ломаными, подписи рёбер — слой поверх узлов.
// Масштаб и вписывание — как в старом: панель «− 100% + Вписать», ⌘/Ctrl+колесо, масштаб запоминается по месту
// (agentgraph.graphZoom.<place>), пока его не выбрали руками, широкий граф один раз вписывается по ширине (не мельче 70%).
// Колесо без модификатора двигает холст, а когда двигать некуда — прокручивает страницу, как прокрутка старого холста.
import '@xyflow/react/dist/base.css';
import {
  createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type ReactNode,
} from 'react';
import {
  Handle, Position, ReactFlow, ReactFlowProvider, ViewportPortal, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import { plural } from '../../lib/format';
import type { GraphEdge, GraphFrame, GraphModel, GraphNode } from '../../lib/graph/model';
import { blockLoopNote, loopRunLabel, loopVerdict, nodeBadge, phaseNodeTitle, STATUSES, type GraphRunState } from '../../lib/graph/run-state';
import { pathD } from '../../lib/graph/text';
import { LS } from '../../lib/storage';
import styles from './FlowGraph.module.css';

export type GraphMode = 'edit' | 'view' | 'run';

/** Что кликнули: узел, шапка рамки блока или «+». b, i — индексы блока и этапа в модели. */
export type GraphHit = {
  kind: string;
  key: string;
  name?: string;
  block?: string;
  group?: string;
  art?: string;
  b?: number;
  i?: number;
};

export type FlowGraphProps = {
  model: GraphModel;
  mode: GraphMode;
  /** Ключ масштаба в localStorage: builder, flow, run — общий со старым UI. */
  place: string;
  /** Вид холста: высота по месту (конструктор, вкладка «Запуск», страница запуска). */
  host: 'builder' | 'flow' | 'run';
  /** Сменился — граф вписывается по ширине заново (другой flow или запуск), как opts.refit. */
  refitKey?: unknown;
  /** Имя выделенного этапа и индекс выделенного блока (рамка и ромб). */
  selectedName?: string | null;
  selectedBlock?: number;
  /** Выделенный узел или рамка блока по ключу — инспектор страницы запуска. */
  selectedKey?: string | null;
  /** Этапы, изменённые «Правкой с ИИ»: зелёная обводка. */
  changed?: Set<string>;
  /** Чип тега знаний в шапке рамки блока. */
  chip?: (slug: string) => ReactNode;
  /** Подпись и чипы узла «Задача». */
  startSub?: string;
  startChips?: ReactNode;
  /** Подсказка инструментов этапа. */
  toolsOf?: (n: GraphNode) => string;
  /** Статусы запуска: классы и бейджи узлов, счётчик на дуге. */
  run?: GraphRunState | null;
  /** Строки под артефактом на странице запуска: последний автор, чек-лист, кто пишет. */
  artInfo?: (key: string) => ReactNode;
  /** Артефакт сейчас пишет этап: рамка узла. */
  artLocked?: (key: string) => boolean;
  onNode?: (hit: GraphHit) => void;
  onAdd?: (hit: GraphHit) => void;
  /** Прокрутить холст к узлу по ключу; seq — чтобы повторить для того же ключа. */
  reveal?: { key: string; seq: number } | null;
  /** Высота холста задаётся местом (вкладка «Граф» страницы запуска), а не высотой графа в масштабе. */
  fill?: boolean;
};

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
const statusClass = (status: string | undefined) => (status ? styles[`is${status[0]!.toUpperCase()}${status.slice(1)}`] : '');
const statusClasses = (status: string | undefined) => STATUSES.map((st) => (st === status ? statusClass(st) : '')).filter(Boolean).join(' ');

type Ctx = Omit<FlowGraphProps, 'model' | 'place' | 'host' | 'refitKey' | 'reveal' | 'fill'> & { markers: string; current: Set<string>; hl: string; setHl: (k: string) => void };
const GraphCtx = createContext<Ctx | null>(null);
const useG = () => useContext(GraphCtx)!;

const hitOf = (o: GraphNode | GraphFrame): GraphHit => ({ kind: o.kind, key: o.key, name: 'name' in o ? o.name : undefined, block: o.block, group: o.group, art: 'art' in o ? o.art : undefined, b: o.b, i: o.i });

/** Enter и пробел на узле — как клик. */
const onKeys = (fn: () => void) => (e: KeyboardEvent) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
    e.preventDefault();
    fn();
  }
};

const handles = (
  <>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </>
);

function PlusButton({ title, hit }: { title: string; hit: GraphHit }) {
  const g = useG();
  return (
    <button
      type="button"
      className={cx(styles.fgPlus, 'nopan')}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        g.onAdd?.(hit);
      }}
    >
      +
    </button>
  );
}

const NodeView = memo(function NodeView({ data }: NodeProps<Node<{ n: GraphNode }>>) {
  const n = data.n;
  const g = useG();
  const s = g.run?.nodes[n.key];
  const status = cx(statusClasses(s?.status), g.current.has(n.key) && styles.isCurrent);
  const open = () => g.onNode?.(hitOf(n));
  const common = { tabIndex: 0, onClick: open, onKeyDown: onKeys(open) };
  if (n.kind === 'start') {
    return (
      <div className={cx(styles.fgNode, styles.fgStart, g.selectedKey === n.key && styles.isSelected, 'nopan')} title={g.startSub || 'Задача, введённая при запуске'} {...common}>
        {handles}
        <div className={styles.fgTitle}>{n.title}</div>
        <div className={styles.fgSub}>{g.startSub || n.sub}</div>
        {g.startChips && <div className={styles.fgChips}>{g.startChips}</div>}
      </div>
    );
  }
  if (n.kind === 'cond') {
    return (
      <div className={cx(styles.fgNode, styles.fgCond, (g.selectedBlock === n.b || g.selectedKey === n.key) && styles.isSelected, status, 'nopan')} title={`Условие: ${n.sub}`} {...common}>
        {handles}
        <span className={styles.fgDiamond} />
        <span className={styles.fgCondLabel}>{n.sub}</span>
        <span className={styles.fgBadge}>{s ? nodeBadge('cond', s) : ''}</span>
      </div>
    );
  }
  if (n.kind === 'artifact') {
    return (
      <div
        className={cx(styles.fgNode, styles.fgArtifact, g.artLocked?.(n.art!) && styles.isLocked, 'nopan')}
        title={`${n.title} (${n.sub})${g.mode === 'run' ? ': открыть' : ''}`}
        onMouseEnter={() => g.setHl(n.art!)}
        onMouseLeave={() => g.setHl('')}
        {...common}
      >
        {handles}
        <div className={styles.fgTitle}>{n.title}</div>
        <div className={cx(styles.fgSub, 'mono')}>{n.sub}</div>
        <div className={styles.fgInfo}>{g.artInfo?.(n.art!)}</div>
      </div>
    );
  }
  const tools = g.toolsOf ? g.toolsOf(n) : '';
  const base = `${n.num}. ${n.title}${tools ? `\nИнструменты: ${tools}` : ''}`;
  return (
    <div
      className={cx(styles.fgNode, styles.fgPhase, g.changed?.has(n.name!) && styles.aiChanged, ((g.selectedName && g.selectedName === n.name) || g.selectedKey === n.key) && styles.isSelected, status, 'nopan')}
      title={n.kind === 'phase' ? phaseNodeTitle(base, s) : base}
      {...common}
    >
      {handles}
      <div className={styles.fgTitle}><span className={styles.fgNum}>{n.num}</span>{n.title}</div>
      <div className={cx(styles.fgSub, 'mono')}>{n.sub}</div>
      {n.inputs && (
        <div className={styles.fgIn}>
          {n.inputs.length ? n.inputs.map((x, k) => <span key={k}>{k > 0 && ' · '}<b>{x}</b></span>) : <span className="err">{n.warn}</span>}
        </div>
      )}
      <div className={styles.fgFoot}>
        <span className={styles.fgTools}>{n.tools} {plural(n.tools ?? 0, 'инструмент', 'инструмента', 'инструментов')}</span>
        <span className={styles.fgBadge}>{s ? nodeBadge('phase', s) : ''}</span>
      </div>
      {g.mode === 'edit' && <PlusButton title="Добавить этап после этого" hit={hitOf(n)} />}
    </div>
  );
});

const FrameView = memo(function FrameView({ data }: NodeProps<Node<{ f: GraphFrame }>>) {
  const f = data.f;
  const g = useG();
  if (f.kind === 'block') {
    const s = g.run?.nodes[f.key];
    const b = g.run?.blocks[f.block!];
    const open = () => g.onNode?.(hitOf(f));
    return (
      <div className={cx(styles.fgFrame, styles.fgBlock, (g.selectedBlock === f.b || g.selectedKey === f.key) && styles.isSelected, statusClasses(s?.status))}>
        {handles}
        <div
          className={cx(styles.fgFrameHead, 'nopan')}
          tabIndex={0}
          title={g.mode === 'edit' ? `${f.title}: настройки цикла блока` : f.title}
          onClick={open}
          onKeyDown={onKeys(open)}
        >
          <b>{f.title}</b>
          <span className={styles.fgLoopNote}>{b?.looped ? blockLoopNote(b) : f.loop}</span>
          {f.knowledge!.length > 0 && <span className={styles.fgChips}>{f.knowledge!.map((t) => <span key={t}>{g.chip ? g.chip(t) : <span className={styles.fgChip}>{t}</span>}</span>)}</span>}
          <span className={styles.fgBadge}>{s ? nodeBadge('block', s) : ''}</span>
        </div>
      </div>
    );
  }
  if (f.kind === 'group') {
    return (
      <div className={cx(styles.fgFrame, styles.fgGroup)} title={`Параллельная группа ${f.group}: этапы идут одновременно и видят один {{prev}}`}>
        {handles}
        <div className={cx(styles.fgFrameHead, styles.fgGroupHead)}>{f.title}</div>
        {g.mode === 'edit' && <PlusButton title={`Добавить участника группы ${f.group}`} hit={hitOf(f)} />}
      </div>
    );
  }
  return (
    <div className={cx(styles.fgFrame, styles.fgArts)}>
      {handles}
      <div className={cx(styles.fgFrameHead, styles.fgArtsHead)}>{f.title}</div>
    </div>
  );
});

const MARKER: Record<GraphEdge['kind'], string> = { flow: 'ar', next: 'ar', loop: 'arl', 'art-write': 'ara', 'art-read': 'ara' };
const EDGE_CLASS: Record<GraphEdge['kind'], string> = {
  flow: styles.fgEFlow ?? '', next: styles.fgENext ?? '', loop: styles.fgELoop ?? '', 'art-write': styles.fgEArtWrite ?? '', 'art-read': styles.fgEArtRead ?? '',
};

function EdgeView({ data }: EdgeProps<Edge<{ e: GraphEdge }>>) {
  const e = data!.e;
  const g = useG();
  const b = e.kind === 'loop' && g.run ? g.run.blocks[e.block!] : undefined;
  return (
    <path
      className={cx(styles.fgEdge, EDGE_CLASS[e.kind], e.art && g.hl === e.art && styles.isHl, b && loopVerdict(b) === 'notmet' && styles.isNotmet)}
      d={pathD(e.points)}
      markerEnd={`url(#${MARKER[e.kind]}-${g.markers})`}
    />
  );
}

function EdgeLabel({ e }: { e: GraphEdge }) {
  const g = useG();
  const b = e.kind === 'loop' && g.run ? g.run.blocks[e.block!] : undefined;
  const text = b ? loopRunLabel(g.mode, e.untilType, b) : e.label!;
  const v = b ? loopVerdict(b) : '';
  return (
    <div
      className={cx(styles.fgLabel, styles[`fgL${e.kind === 'loop' ? 'Loop' : e.kind === 'next' ? 'Next' : 'Flow'}`], v === 'notmet' && styles.isNotmet, v === 'done' && styles.isDone, 'nopan')}
      style={{ left: e.lx, top: e.ly, maxWidth: e.lw, pointerEvents: 'all' }}
      title={text}
    >
      {text}
    </div>
  );
}

const nodeTypes = { node: NodeView, frame: FrameView };
const edgeTypes = { fg: EdgeView };

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.6;
const roundZoom = (s: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s)) * 100) / 100;

export function FlowGraph(props: FlowGraphProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas(props: FlowGraphProps) {
  const { model, mode, place, host, refitKey, reveal } = props;
  const rf = useReactFlow();
  const zoomKey = `agentgraph.graphZoom.${place}`;
  const scroll = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(() => Number(LS.raw(zoomKey)) || 1);
  // масштаб — и в ref: несколько событий колеса до перерисовки (жест трекпада) копят шаги, как fg.scale в старом
  const scaleRef = useRef(scale);
  const manual = useRef(LS.raw(zoomKey) !== null);
  const fitted = useRef(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hl, setHl] = useState('');
  const markers = useId().replace(/[^a-zA-Z0-9]/g, '');

  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // область, по которой можно двигать холст: граф, но не меньше окна — иначе xyflow поставил бы маленький граф по центру
  const extent = useCallback((s: number) => ({ w: Math.max(model.width, size.w / s), h: Math.max(model.height, size.h / s) }), [model.width, model.height, size]);
  const clamp = useCallback((x: number, y: number, s: number) => {
    const { w, h } = extent(s);
    return { x: Math.min(0, Math.max(size.w - w * s, x)), y: Math.min(0, Math.max(size.h - h * s, y)) };
  }, [extent, size]);

  /** save — масштаб выбран руками (кнопки, ⌘/Ctrl+колесо): запомнить его для этого места. Прокрутка в пикселях остаётся, как в старом. */
  const zoom = useCallback((next: number, save = true) => {
    const s = roundZoom(next);
    if (save) {
      manual.current = true;
      LS.setRaw(zoomKey, String(s));
    }
    scaleRef.current = s;
    setScale(s);
    const v = rf.getViewport();
    void rf.setViewport({ ...clamp(v.x, v.y, s), zoom: s });
  }, [rf, clamp, zoomKey]);

  // другой flow или запуск — вписать заново
  useEffect(() => {
    fitted.current = false;
  }, [refitKey]);

  // пока масштаб не выбирали руками, широкий граф один раз вписывается по ширине (не мельче 70%); скрытый холст ширины не имеет — ждём
  useEffect(() => {
    if (manual.current || fitted.current || !size.w) return;
    fitted.current = true;
    const s = Math.floor(Math.max(0.7, Math.min(1, (size.w - 4) / model.width)) * 100) / 100;
    if (s !== scale) zoom(s, false);
  });

  // смена модели или окна: позиция остаётся в пределах графа
  useEffect(() => {
    const v = rf.getViewport();
    const c = clamp(v.x, v.y, scale);
    if (c.x !== v.x || c.y !== v.y || v.zoom !== scale) void rf.setViewport({ ...c, zoom: scale });
  }, [rf, clamp, scale]);

  // колесо: ⌘/Ctrl — масштаб; без модификатора — сдвиг холста, а у края — прокрутка страницы
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoom(scaleRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        return;
      }
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
      const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
      const v = rf.getViewport();
      const c = clamp(v.x - dx, v.y - dy, scale);
      if (c.x === v.x && c.y === v.y) return;
      e.preventDefault();
      void rf.setViewport({ ...c, zoom: scale });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [rf, clamp, scale, zoom]);

  // узел по ключу — в кадр: как graphReveal, отступ 40 px
  useEffect(() => {
    if (!reveal) return;
    const o = [...model.nodes, ...model.frames].find((x) => x.key === reveal.key);
    if (!o || !size.w) return;
    const v = rf.getViewport();
    const left = -v.x;
    const top = -v.y;
    let x = v.x;
    let y = v.y;
    if (o.x * scale < left || (o.x + o.w) * scale > left + size.w) x = -Math.max(0, o.x * scale - 40);
    if (o.y * scale < top || (o.y + o.h) * scale > top + size.h) y = -Math.max(0, o.y * scale - 40);
    void rf.setViewport({ ...clamp(x, y, scale), zoom: scale });
    // только по новому запросу
  }, [reveal?.seq, reveal?.key]);

  const fit = () => {
    zoom(Math.floor(Math.min(1, (size.w - 4) / model.width, Math.max(0.3, (size.h - 4) / model.height)) * 100) / 100);
  };

  const nodes = useMemo<Node[]>(() => [
    ...model.frames.map((f) => ({ id: f.key, type: 'frame', position: { x: f.x, y: f.y }, width: f.w, height: f.h, data: { f }, zIndex: 0, draggable: false, selectable: false, focusable: false })),
    ...model.nodes.map((n) => ({ id: n.id, type: 'node', position: { x: n.x, y: n.y }, width: n.w, height: n.h, data: { n }, zIndex: 1, draggable: false, selectable: false, focusable: false })),
  ], [model]);
  const edges = useMemo<Edge[]>(() => model.edges.map((e) => ({ id: e.id, source: e.from, target: e.to, type: 'fg', data: { e }, selectable: false, focusable: false })), [model]);

  const run = props.run;
  const ctx = useMemo<Ctx>(() => ({
    mode, selectedName: props.selectedName, selectedBlock: props.selectedBlock, selectedKey: props.selectedKey, changed: props.changed, chip: props.chip,
    startSub: props.startSub, startChips: props.startChips, toolsOf: props.toolsOf, run, artInfo: props.artInfo, artLocked: props.artLocked, onNode: props.onNode, onAdd: props.onAdd,
    markers, current: new Set(run?.currentKeys ?? []), hl, setHl,
  }), [mode, props.selectedName, props.selectedBlock, props.selectedKey, props.changed, props.chip, props.startSub, props.startChips, props.toolsOf, run, props.artInfo, props.artLocked, props.onNode, props.onAdd, markers, hl]);

  const marker = (id: string, cls: string) => (
    <marker id={`${id}-${markers}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path className={cls} d="M0 0 L10 5 L0 10 z" />
    </marker>
  );
  const ext = extent(scale);

  return (
    <GraphCtx.Provider value={ctx}>
      <div className={cx(styles.fg, styles[`fg${mode[0]!.toUpperCase()}${mode.slice(1)}`], styles[`fg${host[0]!.toUpperCase()}${host.slice(1)}Host`], hl && styles.fgHl)}>
        <div className={styles.fgBar}>
          <button type="button" className={styles.fgBtn} title="Мельче" onClick={() => zoom(scale - 0.1)}>−</button>
          <span className={styles.fgZoom}>{Math.round(scale * 100)}%</span>
          <button type="button" className={styles.fgBtn} title="Крупнее" onClick={() => zoom(scale + 0.1)}>+</button>
          <button type="button" className={styles.fgBtn} title="Вписать граф в окно" onClick={fit}>Вписать</button>
        </div>
        <svg className={styles.fgDefs} aria-hidden="true">
          <defs>
            {marker('ar', styles.fgMk!)}
            {marker('arl', cx(styles.fgMk, styles.fgMkLoop))}
            {marker('ara', cx(styles.fgMk, styles.fgMkArt))}
          </defs>
        </svg>
        <div ref={scroll} className={cx(styles.fgScroll, props.fill && styles.fgFill)} style={props.fill ? undefined : { height: Math.ceil(model.height * scale) }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={{ x: 0, y: 0, zoom: scale }}
            minZoom={ZOOM_MIN}
            maxZoom={ZOOM_MAX}
            translateExtent={[[0, 0], [ext.w, ext.h]]}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            disableKeyboardA11y
            panOnDrag
            panOnScroll={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            zoomActivationKeyCode={null}
            preventScrolling={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            onNodeClick={noop}
            proOptions={{ hideAttribution: true }}
          >
            <ViewportPortal>
              {model.edges.filter((e) => e.label).map((e) => <EdgeLabel key={e.id} e={e} />)}
            </ViewportPortal>
          </ReactFlow>
        </div>
      </div>
    </GraphCtx.Provider>
  );
}

const noop = (_e: MouseEvent) => {};
