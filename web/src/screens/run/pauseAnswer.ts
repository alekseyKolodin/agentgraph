// Недописанный ответ на паузу по просьбе агента у flow с артефактом решений (ui/artifacts.js art.answers): живёт в памяти
// вкладки и в localStorage (`agentgraph.pauseAnswer:<запуск>\n<пауза>`) по запуску и паузе, чтобы пережить перезагрузку. «Возобновить» с ответом и черновиками артефактов — artResume в artStore.ts.
import { useSyncExternalStore } from 'react';

const answers = new Map<string, string>();
const LS = 'agentgraph.pauseAnswer:';

function lsGet(key: string): string {
  try {
    return localStorage.getItem(LS + key) || '';
  } catch {
    return '';
  }
}
function lsSet(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(LS + key, text);
    else localStorage.removeItem(LS + key);
  } catch {
    /* хранилище недоступно — черновик живёт только в памяти */
  }
}
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const answerKey = (runId: string, pauseAt = ''): string => `${runId}\n${pauseAt}`;

export function setPauseAnswer(key: string, text: string): void {
  answers.set(key, text);
  lsSet(key, text);
  emit();
}

export function dropPauseAnswer(key: string): void {
  lsSet(key, '');
  if (answers.delete(key)) emit();
}

export function pauseAnswerOf(key: string): string {
  let v = answers.get(key);
  if (v === undefined) {
    v = lsGet(key);
    if (v) answers.set(key, v);
  }
  return v;
}

/** Запуск удалён: недописанные ответы на его паузы — тоже. */
export function dropRunPauseAnswers(runId: string): void {
  let changed = false;
  const prefix = answerKey(runId);
  for (const k of [...answers.keys()]) if (k.startsWith(prefix)) changed = answers.delete(k) || changed;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS + prefix)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
  if (changed) emit();
}

export function usePauseAnswer(key: string): string {
  return useSyncExternalStore((f) => {
    subs.add(f);
    return () => subs.delete(f);
  }, () => pauseAnswerOf(key));
}

/** Есть ли что терять при уходе со страницы: недописанный ответ на паузу. */
export const hasPauseAnswers = (): boolean => [...answers.values()].some((t) => t.trim());
