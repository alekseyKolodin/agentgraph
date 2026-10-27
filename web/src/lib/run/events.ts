// Состояние открытого запуска и события его потока /api/runs/:id/events (порт subscribe из ui/app.js) — без React и DOM.
// Состояние правится на месте, как state.run старого UI: события приходят пачками, экран перерисовывается раз в кадр.
// При переподключении сервер переигрывает все события заново, поэтому обработчики идемпотентны: max вместо инкремента,
// дубли отчётов не добавляются, первое время старта этапа не затирается.
import type { PhaseFiles, QuestionRecord, RunDetail, RunStreamEvent, UntilType } from '@server/api-types';

/** Запуск на экране: отчёт с сервера (+ live, continuable) и правки событий. */
export type RunView = RunDetail & { questions: QuestionRecord[] };

/** Идущий этап (событие phase_start): at — время старта в мс, model — фактическая, ctx — последний снимок контекста. */
export type PendingPhase = {
  block: string;
  iteration: number;
  index: number;
  phase: string;
  title: string;
  tools: string[];
  files?: PhaseFiles;
  group?: string;
  model?: string;
  effort?: string;
  at: number;
  ctx?: { peak: number; requests: number; window?: number };
};
export type PendingCond = { block: string; iteration: number; kind: UntilType; detail: string; file?: string };

export type LiveState = {
  run: RunView;
  /** Ключ — pendingKey: у параллельной группы в одной итерации идут несколько этапов. */
  pending: Map<string, PendingPhase>;
  condPending: PendingCond | null;
  tagPending: { tag: string; file: string } | null;
};

/** Что сделать после события, кроме перерисовки. */
export type EventEffect = {
  /** Перерисовать страницу (раз в кадр). */
  render: boolean;
  /** Строка живого лога «[этап] строка». */
  log?: string;
  /** Обновить список запусков (с задержкой: переигранные события идут пачкой). */
  runsSoon?: boolean;
  /** Поток больше не нужен: запуск закончился или не найден. */
  close?: boolean;
  /** Запуск закончился: спросить сервер, можно ли его продолжить. */
  ended?: boolean;
  /** Flow запуска поправили на паузе: перечитать снимок (граф) и отчёты будущих блоков. */
  flow?: boolean;
};

export const pendingKey = (x: { block?: string; iteration: number; phase: string }): string => `${x.block}:${x.iteration}:${x.phase}`;

/** Состояние только что открытого запуска. */
export function liveState(run: RunDetail): LiveState {
  return { run: withQuestions(run), pending: new Map(), condPending: null, tagPending: null };
}

const withQuestions = <T extends { questions?: QuestionRecord[] }>(r: T): T & { questions: QuestionRecord[] } => ({ ...r, questions: r.questions || [] });

/** Применить событие к состоянию. now — для времени старта этапа. */
export function applyRunEvent(st: LiveState, e: RunStreamEvent, now: number = Date.now()): EventEffect {
  const r = st.run;
  switch (e.type) {
    case 'start':
      st.run = withQuestions({ ...e.report, live: true });
      break;
    case 'block_start':
    case 'block_end':
      r.blocks ||= [];
      r.blocks[e.block.index] = e.block;
      break;
    case 'iteration': {
      const b = r.blocks?.find((x) => x.name === e.block);
      if (b) {
        b.iterations = Math.max(b.iterations || 0, e.iteration);
        if (b.status === 'pending') b.status = 'running';
        r.iterations = r.blocks.reduce((n, x) => n + (x.iterations || 0), 0);
      } else {
        r.iterations = e.iteration;
      }
      break;
    }
    case 'phase_start': {
      const { type: _type, ...x } = e;
      st.pending.set(pendingKey(e), { ...x, at: st.pending.get(pendingKey(e))?.at ?? now });
      st.condPending = null;
      break;
    }
    case 'phase_model': {
      const cur = st.pending.get(pendingKey(e));
      if (!cur || cur.model === e.model) return { render: false };
      cur.model = e.model;
      break;
    }
    case 'phase_context': {
      // этапа нет в pending — снимок опоздал к phase_end
      const cur = st.pending.get(pendingKey(e));
      if (!cur) return { render: false };
      cur.ctx = { peak: e.contextPeak, requests: e.requests, ...(e.contextWindow ? { window: e.contextWindow } : {}) };
      break;
    }
    case 'log':
      return { render: false, log: `[${e.phase}] ${e.line}` };
    case 'artifacts':
      // снимок артефактов правит только их состояние (screens/run/artStore.ts): страница его сюда не передаёт
      return { render: false };
    case 'phase_end':
      st.pending.delete(pendingKey(e.report));
      if (!r.phases.some((p) => p.block === e.report.block && p.iteration === e.report.iteration && p.phase === e.report.phase)) {
        r.phases.push(e.report);
        r.totalCostUsd += e.report.costUsd;
      }
      break;
    case 'condition_start': {
      const { type: _type, ...x } = e;
      st.condPending = x;
      break;
    }
    case 'tag_summary_start':
      st.tagPending = { tag: e.tag, file: e.file };
      break;
    case 'tag_summary': {
      st.tagPending = null;
      const list = (r.tagSummaries ||= []);
      if (!list.some((s) => s.tag === e.tag)) {
        r.totalCostUsd += e.report.costUsd;
        list.push(e.report);
      }
      break;
    }
    case 'condition':
      st.condPending = null;
      if (!r.conditions.some((c) => c.block === e.report.block && c.iteration === e.report.iteration)) {
        r.conditions.push(e.report);
        r.totalCostUsd += e.report.costUsd;
      }
      break;
    case 'question':
      if (!r.questions.some((q) => q.id === e.question.id)) r.questions.push(e.question);
      return { render: true, runsSoon: true };
    case 'answer': {
      const idx = r.questions.findIndex((q) => q.id === e.question.id);
      if (idx >= 0) r.questions[idx] = e.question;
      else r.questions.push(e.question);
      return { render: true, runsSoon: true };
    }
    case 'pause':
      // при переподключении события переигрываются, последнее и есть текущее состояние
      if (e.state === 'resumed') {
        delete r.pause;
        delete r.pauseReason;
      } else {
        r.pause = e.state;
        if (e.reason) r.pauseReason = e.reason;
      }
      return { render: true, runsSoon: true };
    case 'title':
      // имя приходит через несколько секунд после старта; итог — уже со стоимостью подбора
      if (e.title) r.title = e.title;
      r.totalCostUsd = e.totalCostUsd;
      return { render: true, runsSoon: true };
    case 'digest': {
      // итог модели приходит позже вердикта: дописываем его в уже показанную проверку
      const c = e.summary ? r.conditions.find((x) => x.block === e.block && x.iteration === e.iteration) : undefined;
      if (c) c.summary = e.summary;
      if (e.digest) r.digest = e.digest;
      r.totalCostUsd = e.totalCostUsd;
      break;
    }
    case 'limit': {
      const b = r.blocks?.find((x) => x.name === e.block);
      if (b) b.maxIterations = e.max;
      r.maxIterations = e.total;
      break;
    }
    case 'note': {
      // добавлено или применено ещё к шагу: в applied события — только новые записи, дописываем их без дублей
      const list = (r.notes ||= []);
      const cur = list.find((n) => n.id === e.note.id);
      if (!cur) {
        list.push({ ...e.note, applied: [...(e.note.applied ?? [])] });
        break;
      }
      const key = (a: { block: string; iteration: number; phase: string }) => `${a.block}\u0000${a.iteration}\u0000${a.phase}`;
      const seen = new Set((cur.applied ?? []).map(key));
      const fresh = (e.note.applied ?? []).filter((a) => !seen.has(key(a)));
      if (fresh.length) cur.applied = [...(cur.applied ?? []), ...fresh];
      break;
    }
    case 'flow': {
      const list = (r.flowEdits ||= []);
      if (!list.some((x) => x.version === e.edit.version)) list.push(e.edit);
      return { render: true, flow: true };
    }
    case 'end':
      st.run = withQuestions({ ...e.report, live: false });
      st.pending.clear();
      st.condPending = null;
      st.tagPending = null;
      return { render: true, close: true, runsSoon: true, ended: true };
    case 'error':
      return { render: true, close: true };
    default:
      return { render: false };
  }
  return { render: true };
}
