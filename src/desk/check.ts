// Сверка «N из N» над доской (SPEC 3.4, план — docs/desk/plan-5.md): GET /api/desk/check собирается из итогов, которые
// уже лежат на диске, — источников рутин (routines-state/checks/<slug>.json, через RoutineEngine.sourceViews) и сверки
// наблюдателей (desk/check.json, reconcile.ts). Своего не хранит. Слова для человека («проверено 09:12, 14 записей, 2
// новых») собирает веб: время — в часовом поясе того, кто смотрит, и через перевод.
import type { CheckResult, SourceView } from '../routines/types.js';
import type { DeskCheckReply, DeskCheckSource, DeskCheckStatus } from './types.js';

const DAY_MS = 86_400_000;
/** «Обычно N в день» считается не меньше чем по стольким приходам нового и не короче суток. */
const USUAL_MIN_ARRIVALS = 3;

export type DeskCheckInput = {
  /** Источники рутин с итогами проверок (RoutineEngine.sourceViews). Нет — рутины не подключены. */
  sources?: readonly SourceView[];
  /** Когда приходило новое у источника (routines-state/checks: arrivals). */
  arrivals?: (slug: string) => readonly string[];
  /** Итог последней сверки наблюдателей (desk/check.json). */
  watcher?: CheckResult;
  /** Запуск приложения: итог сверки старше — «не проверялось с запуска». */
  startedAt: Date;
};

/**
 * Сколько раз в день обычно приходит новое: приходы между первым и последним из сохранённых. Меньше трёх приходов или
 * меньше суток между крайними — undefined (мало данных, чтобы говорить «обычно»). Одна десятая — точность.
 */
export function usualPerDay(arrivals: readonly string[]): number | undefined {
  const times = arrivals.map((x) => Date.parse(x)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < USUAL_MIN_ARRIVALS) return undefined;
  const span = times[times.length - 1] - times[0];
  if (span < DAY_MS) return undefined;
  const v = Math.round(((times.length - 1) / (span / DAY_MS)) * 10) / 10;
  return v > 0 ? v : undefined;
}

/**
 * Состояние источника для сверки. Источник, не нужный ни одной включённой рутине (idle), в сверку не идёт — и брошенный
 * черновик без ключа или с неизвестным видом тоже (движок называет его error/needs_secret раньше, чем idle). Итог
 * проверки старше запуска приложения — «не проверялось с запуска», а не «в порядке»: итог остаётся для подсказки.
 */
function statusOfSource(v: SourceView, startedAt: Date): DeskCheckStatus | undefined {
  if (!v.usedBy.length || v.status === 'idle') return undefined;
  if ((v.status === 'ok' || v.status === 'empty') && (!v.check || Date.parse(v.check.at) < startedAt.getTime())) return 'unchecked';
  switch (v.status) {
    case 'ok':
    case 'empty':
    case 'error':
    case 'needs_secret':
    case 'unchecked':
      return v.status;
  }
}

/** Сверка наблюдателей: нет итога или он с прошлого запуска приложения — «не проверялось»; иначе — по итогу. */
function watcherOf(c: CheckResult | undefined, startedAt: Date): DeskCheckSource {
  const fresh = c && Date.parse(c.at) >= startedAt.getTime();
  const status: DeskCheckStatus = !fresh ? 'unchecked' : c.ok ? 'ok' : 'error';
  return { slug: 'desk', title: 'Наблюдатели дел', kind: 'watcher', status, ...(c ? { result: c } : {}), ...(c?.error ? { error: c.error } : {}) };
}

/** Порядок: сломанное наверх (его чинить), потом молчащее, непроверенное и в порядке; внутри — по названию. */
const RANK: Record<DeskCheckStatus, number> = { error: 0, needs_secret: 1, empty: 2, unchecked: 3, ok: 4 };

export function deskCheck(i: DeskCheckInput): DeskCheckReply {
  const out: DeskCheckSource[] = [];
  for (const v of i.sources ?? []) {
    const status = statusOfSource(v, i.startedAt);
    if (!status) continue;
    const usual = i.arrivals ? usualPerDay(i.arrivals(v.slug)) : undefined;
    out.push({
      slug: v.slug,
      title: v.spec.title || v.slug,
      kind: 'source',
      status,
      ...(v.check ? { result: v.check } : {}),
      ...(usual !== undefined ? { usual } : {}),
      ...(status === 'error' && (v.error ?? v.check?.error) ? { error: v.error ?? v.check?.error } : {}),
    });
  }
  out.sort((a, b) => RANK[a.status] - RANK[b.status] || a.title.localeCompare(b.title, 'ru'));
  // наблюдатели — последней строкой: это не подключённый сервис, а сверка вещей уже заведённых дел
  out.push(watcherOf(i.watcher, i.startedAt));
  const at = out.reduce<string | undefined>((m, s) => (s.result && (!m || s.result.at > m) ? s.result.at : m), undefined);
  return { sources: out, ...(at ? { at } : {}) };
}
