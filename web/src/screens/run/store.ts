// Состояние открытой страницы запуска — модуль вне компонентов, как state.run старого UI: события потока правят его на месте,
// экран перерисовывается раз в кадр (useRunStore подписывает на счётчик версий). Свёртки, выбранная вкладка и «следовать»
// переживают уход со страницы: свёртки — пока открыт тот же запуск (resetRunFold), остальное — общее на все запуски.
import { useSyncExternalStore } from 'react';
import type { AskAnswers, RunDetail, RunStreamEvent } from '@server/api-types';
import { fetchRun, fetchRunFlow, type RunFlowView } from '../../api';
import { applyRunEvent, liveState, type EventEffect, type LiveState } from '../../lib/run/events';
import { RunLogBuffer } from '../../lib/run/log';
import type { InspectSel, RunFold } from '../../lib/run/view';
import { LS } from '../../lib/storage';

export type RunTab = 'overview' | 'graph' | 'log' | 'artifacts';
export const RUN_TABS: RunTab[] = ['overview', 'graph', 'log', 'artifacts'];

export const runState = {
  id: null as string | null,
  st: null as LiveState | null,
  /** Снимок flow.yaml запуска: по нему рисуется граф. Нет снимка (старые запуски) — нет вкладки «Граф». */
  flow: null as { id: string; spec: RunFlowView } | null,
  /** Подписаны на поток: запуск идёт, конец ещё не пришёл. */
  streaming: false,
  fold: { over: new Map(), older: new Set() } as RunFold,
  foldId: null as string | null,
  inspect: null as InspectSel | null,
  /** Выбранная вкладка (запоминается); override — показанная без запоминания (переход из графа в «Обзор»). */
  tabPref: LS.get<RunTab>('agentgraph.runTab', 'overview'),
  tabOverride: null as RunTab | null,
  follow: LS.get('agentgraph.graphFollow', true),
  /** Этап, к которому «следовать» уже подвёл холст: следующий текущий его сменит. */
  followShown: '',
  reveal: null as { key: string; seq: number } | null,
  /** Прокрутить к карточке после перерисовки: step — data-step карточки, fold — первый найденный заголовок свёртки; мигнуть. */
  scrollTo: null as { step?: string; fold?: string[]; block: ScrollLogicalPosition } | null,
  version: 0,
};

const subs = new Set<() => void>();
let frame = 0;

export function bump(): void {
  cancelAnimationFrame(frame);
  frame = 0;
  runState.version++;
  subs.forEach((f) => f());
}

/** При подключении к длинному запуску события приходят пачкой: перерисовываем раз в кадр, а не на каждое. */
export function bumpSoon(): void {
  if (!frame) frame = requestAnimationFrame(bump);
}

export const useRunStore = (): number =>
  useSyncExternalStore((f) => {
    subs.add(f);
    return () => subs.delete(f);
  }, () => runState.version);

// ---------- живой лог: строки копятся в буфере и забираются раз в кадр (окно лога, хвосты на «Обзоре» и в инспекторе)

export const runLog = new RunLogBuffer();
type LogListener = (reset: boolean) => void;
const logSubs = new Set<LogListener>();
let logFrame = 0;

export function onLog(f: LogListener): () => void {
  logSubs.add(f);
  return () => logSubs.delete(f);
}

function flushLog() {
  logFrame = 0;
  logSubs.forEach((f) => f(false));
}

export function resetLog(): void {
  cancelAnimationFrame(logFrame);
  logFrame = 0;
  runLog.clear();
  logSubs.forEach((f) => f(true));
}

// ---------- открытие и события

let loadSeq = 0;

/** Открыть запуск: отчёт, сброс страницы, снимок flow для графа. Ошибка (нет запуска) — исключение. */
export async function openRun(id: string, withFlow: boolean): Promise<void> {
  const my = ++loadSeq;
  const run = await fetchRun(id);
  if (my !== loadSeq) return;
  if (runState.foldId !== id) {
    runState.fold = { over: new Map(), older: new Set() };
    runState.foldId = id;
  }
  Object.assign(runState, { id, st: liveState(run), flow: null, streaming: run.live, inspect: null, followShown: '', reveal: null, tabOverride: null });
  resetLog();
  bump();
  if (!withFlow) return;
  try {
    const spec = await fetchRunFlow(id);
    if (my !== loadSeq || runState.id !== id) return;
    runState.flow = { id, spec };
    bump();
  } catch {
    // 404 — у запуска нет снимка flow.yaml
  }
}

/** Ушли со страницы запуска: поток закроет компонент, ответы на опоздавшие запросы не применяются. */
export function closeRun(): void {
  loadSeq++;
  Object.assign(runState, { id: null, st: null, flow: null, streaming: false, inspect: null });
}

/** Событие потока; что делать, кроме перерисовки, решает вызывающий (список запусков, продолжение). */
export function runEvent(e: RunStreamEvent): EventEffect | null {
  const st = runState.st;
  if (!st) return null;
  const eff = applyRunEvent(st, e);
  if (eff.log) {
    runLog.append(eff.log);
    if (!logFrame) logFrame = requestAnimationFrame(flushLog);
  }
  if (eff.close) runState.streaming = false;
  if (eff.render) bumpSoon();
  return eff;
}

/** Живой запуск закончился: событие end не знает, можно ли его продолжить, — спрашиваем сервер. */
export async function loadContinuable(id: string): Promise<void> {
  const r: RunDetail | null = await fetchRun(id).catch(() => null);
  const st = runState.st;
  if (!r || !('continuable' in r) || runState.id !== id || !st || st.run.live) return;
  st.run.continuable = r.continuable;
  st.run.continueReason = r.continueReason;
  bump();
}

/** Ответ на вопрос ушёл: отметить его отвеченным сразу, не дожидаясь события. */
export function markAnswered(runId: string, qid: string, answers: AskAnswers): void {
  const q = runState.id === runId ? runState.st?.run.questions.find((x) => x.id === qid) : undefined;
  if (!q) return;
  q.answers = answers;
  bump();
}

// ---------- вкладки

export function setRunTab(name: RunTab, remember = true): void {
  if (remember) {
    runState.tabPref = name;
    LS.set('agentgraph.runTab', name);
    runState.tabOverride = null;
  } else runState.tabOverride = name;
  bump();
}

/** Показанная вкладка: недоступная выбранная — «Обзор», появилась — снова выбранная (если не уводили руками). */
export function shownTab(available: Set<RunTab>): RunTab {
  const want = runState.tabOverride ?? runState.tabPref;
  return available.has(want) ? want : 'overview';
}
