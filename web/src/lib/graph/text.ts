// Подписи и геометрия графа flow (порт помощников FG из ui/graph.js): итерации, контекст этапа, ломаные рёбер.
import { plural } from '../format';
import type { Point } from './model';

export const iterWord = (n: number): string => `${n} ${plural(n, 'итерация', 'итерации', 'итераций')}`;
export const iterTo = (n: number): string => `${n} ${plural(n, 'итерации', 'итераций', 'итераций')}`;

/** Подпись обратной дуги: лимит N меняется на ходу, поэтому строится и в модели, и по статусам запуска. */
export const loopLabel = (type: string | undefined, n: number): string => (type === 'none' ? `↺ ровно ${iterWord(n)}` : `не выполнено ↺ до ${n}`);

/** Токены коротко: 999, 1.5k, 90k, 172k, 1M, 1.5M; ноль и пусто — пустая строка. */
export function tokensShort(n: number | null | undefined): string {
  if (!(n! > 0)) return '';
  const v = n!;
  if (v >= 999500) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e5) return `${Math.round(v / 1e3)}k`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/** Занятость окна, %: целое, не меньше 1 при ненулевом пике; нет окна или пика — null. */
const ctxPercent = (peak: number, window: number | undefined): number | null =>
  peak > 0 && window! > 0 ? Math.max(1, Math.round((peak / window!) * 100)) : null;

/** Подпись контекста этапа: «172k / 1M · 17%»; окна нет — только пик «90k»; пика нет — пусто. */
export function ctxLabel(peak: number, window?: number): string {
  const pct = ctxPercent(peak, window);
  return pct === null ? tokensShort(peak) : `${tokensShort(peak)} / ${tokensShort(window)} · ${pct}%`;
}

/** Короткая подпись для бейджа узла: «45%», без окна — «90k». */
export function ctxBadge(peak: number, window?: number): string {
  const pct = ctxPercent(peak, window);
  return pct === null ? tokensShort(peak) : `${pct}%`;
}

/** Уровень предупреждения по занятости окна: «» / «warn» (от 70%) / «crit» (от 90%). */
export function ctxLevel(peak: number, window?: number): '' | 'warn' | 'crit' {
  const pct = ctxPercent(peak, window);
  return pct === null ? '' : pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : '';
}

/** Ширина текста в px по средней ширине символа: шапка рамки блока и подпись под ромбом. */
export const textW = (s: string, px: number): number => [...String(s)].length * px;

/** Ломаная со скруглёнными углами для SVG. */
export function pathD(pts: Point[], r = 8): string {
  const f = (v: number) => Math.round(v * 10) / 10;
  if (pts.length < 3) return `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')}`;
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let k = 1; k < pts.length - 1; k++) {
    const [x0, y0] = pts[k - 1]!;
    const [x1, y1] = pts[k]!;
    const [x2, y2] = pts[k + 1]!;
    const d1 = Math.hypot(x1 - x0, y1 - y0);
    const d2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    if (!rr) {
      d += ` L${f(x1)} ${f(y1)}`;
      continue;
    }
    const ax = x1 + ((x0 - x1) / d1) * rr;
    const ay = y1 + ((y0 - y1) / d1) * rr;
    const bx = x1 + ((x2 - x1) / d2) * rr;
    const by = y1 + ((y2 - y1) / d2) * rr;
    d += ` L${f(ax)} ${f(ay)} Q${f(x1)} ${f(y1)} ${f(bx)} ${f(by)}`;
  }
  const [lx, ly] = pts.at(-1)!;
  return `${d} L${f(lx)} ${f(ly)}`;
}
