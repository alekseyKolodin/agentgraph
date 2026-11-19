// Лента событий главной: то, о чём сообщают уведомления (вопрос агента, пауза по его просьбе, конец запуска).
// Строится из отчёта запуска, а не из потока событий: переживает перезапуск сервера и видит запуски из CLI.
import { truncate } from './agent.js';
import type { RunReport } from './runner.js';
import type { FeedItem } from './api-types.js';

// событие ленты — общее с UI: src/api-types.ts
export type { FeedItem } from './api-types.js';

/** Идущий запуск этого сервера: только он может ждать ответа прямо сейчас. */
export type FeedLive = { pending: (questionId: string) => boolean };

export const FEED_MAX = 80;
const TEXT_MAX = 300;

/** События одного запуска. Скрытый запуск в ленту не попадает. */
export function reportFeed(runId: string, r: RunReport, live?: FeedLive): FeedItem[] {
  if (r.hidden) return [];
  const run = { runId, flow: r.flow };
  const out: FeedItem[] = [];
  for (const q of r.questions ?? []) {
    const text = truncate(q.questions.map((x) => x.question).join(' · '), TEXT_MAX);
    out.push({ ...run, id: q.id, kind: 'question', at: q.askedAt, title: q.title || q.phase, text, doneAt: q.answeredAt, open: Boolean(live?.pending(q.id)) });
  }
  // у пауз из отчётов до появления ленты нет времени: поставить их в ленту некуда
  for (const pz of r.pauses ?? []) {
    if (!pz.at) continue;
    const open = Boolean(live && r.pauseReason?.at === pz.at);
    out.push({ ...run, id: `${runId}:pause:${pz.at}`, kind: 'pause', at: pz.at, title: pz.phase, text: truncate(pz.text, TEXT_MAX), doneAt: pz.resumedAt, open });
  }
  // прерванный запуск (running без процесса) finishedAt не имеет: концом считаем его последнее известное время
  const endAt = r.finishedAt ?? (r.status === 'interrupted' ? lastKnownAt(r) : undefined);
  if (endAt && r.status !== 'running') {
    out.push({ ...run, id: `${runId}:end`, kind: 'end', at: endAt, status: r.status, costUsd: r.totalCostUsd, text: endText(r) });
  }
  return out;
}

/** Текст конца: у оборвавшегося запуска отчёт говорит про адрес API — человеку это пишем словами. */
function endText(r: RunReport): string | undefined {
  if (r.status === 'interrupted' && (!r.error || /\/continue\b/.test(r.error))) return 'прерван: приложение закрылось во время работы, можно продолжить';
  return r.error ? truncate(r.error, TEXT_MAX) : undefined;
}

/**
 * Когда запуск шёл по этапам: старт плюс их длительности (этапы параллельной группы идут вместе — берётся самый долгий).
 * У блоков и этапов своих меток времени нет, а длительность известна точно; больше этого запуск не работал.
 */
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

/** Последнее время, которое отчёт знает о запуске: вопросы, паузы, работа этапов, старт. Стабильно между вызовами, лента не прыгает. */
function lastKnownAt(r: RunReport): string {
  const times = [r.startedAt, workedUntil(r), ...(r.questions ?? []).flatMap((q) => [q.askedAt, q.answeredAt]), ...(r.pauses ?? []).flatMap((p) => [p.at, p.resumedAt])];
  return times.filter((t): t is string => Boolean(t)).sort().pop() ?? r.startedAt;
}

/** От новых к старым, не больше max. */
export function mergeFeed(items: FeedItem[], max = FEED_MAX): FeedItem[] {
  return [...items].sort((a, b) => b.at.localeCompare(a.at)).slice(0, max);
}
