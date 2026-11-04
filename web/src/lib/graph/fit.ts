// Вписывание графа конструктора в холст (components/graph/FlowGraph.tsx, autoFit): масштаб по ширине выбранного блока или
// всего графа, сдвиг поменьше, чтобы блок и узел были в кадре, и пределы, за которые холст не уезжает. Всё в px экрана.
import { LOOP_H, type GraphModel } from './model';

/** Поле вокруг блока и узла, которые вписываются в кадр. */
export const FIT_PAD = 16;
export type Rect = { x: number; y: number; w: number; h: number };
/** Вид холста xyflow: сдвиг и масштаб. */
export type View = { x: number; y: number; zoom: number };
/**
 * Масштаб: 'block' — по ширине блока узла (у узла без блока и без ключа — всего графа), 'graph' — всего графа (оба не крупнее
 * 100% и не мельче порога), 'keep' — прежний, число — оно. Кроме 'keep', в кадр встаёт и блок узла, а не только он сам.
 */
export type FitMode = 'block' | 'graph' | 'keep' | number;

/** Начало окна длины len, где отрезок [a, a + n] виден с полем FIT_PAD, а сдвиг от cur наименьший; не влезает — от его начала. */
export const nearest = (cur: number, len: number, a: number, n: number): number =>
  n + 2 * FIT_PAD > len || a - FIT_PAD < cur ? a - FIT_PAD : a + n + FIT_PAD > cur + len ? a + n + FIT_PAD - len : cur;

/** Масштаб, при котором span px графа влезают в width: вниз до сотых, не крупнее 100% и не мельче min. */
export const fitScale = (span: number, width: number, min: number): number => Math.max(min, Math.floor(Math.min(1, width / span) * 100) / 100);

/** Пределы сдвига холста w×h при масштабе s: граф, но не меньше окна — иначе xyflow поставил бы маленький граф по центру. */
export function clampView(model: Pick<GraphModel, 'width' | 'height'>, x: number, y: number, s: number, w: number, h: number): { x: number; y: number } {
  const ew = Math.max(model.width, w / s);
  const eh = Math.max(model.height, h / s);
  return { x: Math.min(0, Math.max(w - ew * s, x)), y: Math.min(0, Math.max(h - eh * s, y)) };
}

/**
 * Узел или рамка по ключу и блок вокруг: рамка блока, а у единственного блока без рамки (его ключ b:<имя> тоже узнаётся) —
 * его узлы, рамки групп и дуга цикла над ними. Узел без блока («Задача», артефакт) — без блока; ключа нет — null.
 */
export function focusOf(model: GraphModel, key: string | null): { o: Rect; box: Rect | null } | null {
  if (!key) return null;
  const o = [...model.frames, ...model.nodes].find((x) => x.key === key);
  const block = o ? o.block : model.nodes.find((n) => n.block !== undefined && `b:${n.block}` === key)?.block;
  if (block === undefined) return o ? { o, box: null } : null;
  const frame = model.frames.find((f) => f.kind === 'block' && f.block === block);
  if (frame) return { o: o ?? frame, box: frame };
  const own = [...model.nodes, ...model.frames].filter((x) => x.block === block);
  const x = Math.min(...own.map((n) => n.x));
  const y = Math.min(...own.map((n) => n.y)) - (own.some((n) => n.kind === 'cond') ? LOOP_H : 0);
  const box = { x, y, w: Math.max(...own.map((n) => n.x + n.w)) - x, h: Math.max(...own.map((n) => n.y + n.h)) - y };
  return { o: o ?? box, box };
}

export type FitInput = {
  /** Ширина холста и его высота при масштабе s (высота графа в пределах min- и max-height места). */
  w: number;
  heightAt: (s: number) => number;
  /** Вид сейчас и порог вписывания. */
  view: View;
  min: number;
};

/**
 * Вид после вписывания вокруг узла key (см. FitMode). Весь граф — от его левого края, где «Задача»; блок и сдвиг к узлу — от
 * того, что сейчас в кадре. null — для 'block' и 'keep' ключа нет в модели: новый этап, а отложенная модель ещё старая.
 */
export function fitView(model: GraphModel, key: string | null, to: FitMode, i: FitInput): View | null {
  const f = focusOf(model, key);
  if (key && !f && (to === 'block' || to === 'keep')) return null;
  const block = to === 'block' && f?.box;
  const s = typeof to === 'number' ? to : to === 'keep' ? i.view.zoom : fitScale(block ? block.w + 2 * FIT_PAD : model.width + 4, i.w, i.min);
  const h = i.heightAt(s);
  let left = block || to === 'keep' ? (-i.view.x / i.view.zoom) * s : 0;
  let top = (-i.view.y / i.view.zoom) * s;
  for (const r of f ? (to !== 'keep' && f.box ? [f.box, f.o] : [f.o]) : []) {
    left = nearest(left, i.w, r.x * s, r.w * s);
    top = nearest(top, h, r.y * s, r.h * s);
  }
  return { ...clampView(model, -left, -top, s, i.w, h), zoom: s };
}
