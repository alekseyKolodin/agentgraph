// Недописанный ответ на паузу по просьбе агента у flow с артефактом решений (ui/artifacts.js art.answers): живёт в памяти
// вкладки по запуску и паузе. «Возобновить» с ответом и черновиками артефактов — artResume в artStore.ts.
import { useSyncExternalStore } from 'react';

const answers = new Map<string, string>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const answerKey = (runId: string, pauseAt = ''): string => `${runId}\n${pauseAt}`;

export function setPauseAnswer(key: string, text: string): void {
  answers.set(key, text);
  emit();
}

export function dropPauseAnswer(key: string): void {
  if (answers.delete(key)) emit();
}

export const pauseAnswerOf = (key: string): string => answers.get(key) || '';

/** Запуск удалён: недописанные ответы на его паузы — тоже. */
export function dropRunPauseAnswers(runId: string): void {
  let changed = false;
  for (const k of answers.keys()) if (k.startsWith(answerKey(runId))) changed = answers.delete(k) || changed;
  if (changed) emit();
}

export function usePauseAnswer(key: string): string {
  return useSyncExternalStore((f) => {
    subs.add(f);
    return () => subs.delete(f);
  }, () => answers.get(key) || '');
}

/** Есть ли что терять при уходе со страницы: недописанный ответ на паузу. */
export const hasPauseAnswers = (): boolean => [...answers.values()].some((t) => t.trim());
