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
  if (r.finishedAt && r.status !== 'running') {
    out.push({ ...run, id: `${runId}:end`, kind: 'end', at: r.finishedAt, status: r.status, costUsd: r.totalCostUsd, text: r.error ? truncate(r.error, TEXT_MAX) : undefined });
  }
  return out;
}

/** От новых к старым, не больше max. */
export function mergeFeed(items: FeedItem[], max = FEED_MAX): FeedItem[] {
  return [...items].sort((a, b) => b.at.localeCompare(a.at)).slice(0, max);
}
