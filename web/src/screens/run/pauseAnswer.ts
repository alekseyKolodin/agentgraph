// Недописанный ответ на паузу по просьбе агента у flow с артефактом решений (ui/artifacts.js art.answers): живёт в памяти
// вкладки и в localStorage (`agentgraph.pauseAnswer:<запуск>\n<пауза>` → {text, at}) по запуску и паузе, чтобы пережить перезагрузку; старше недели — убирается при загрузке. «Возобновить» с ответом и черновиками артефактов — artResume в artStore.ts.
import { useSyncExternalStore } from 'react';
import { LS } from '../../lib/storage';

const answers = new Map<string, string>();
const PREFIX = 'agentgraph.pauseAnswer:';
/** Черновик старше недели больше не нужен: запуск давно ушёл дальше. */
const KEEP_MS = 7 * 24 * 3600_000;

type Stored = { text: string; at: number };

/** Запись в хранилище: {text, at}; до этой версии лежал просто текст — читается как есть, с отметкой «сейчас». */
function parseStored(raw: string, now: number): Stored {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && typeof (v as Stored).text === 'string' && typeof (v as Stored).at === 'number') return v as Stored;
  } catch {
    /* старый формат: сырая строка */
  }
  return { text: raw, at: now };
}

function lsGet(key: string): string {
  const raw = LS.raw(PREFIX + key);
  return raw ? parseStored(raw, Date.now()).text : '';
}
function lsSet(key: string, text: string): void {
  if (text) LS.set(PREFIX + key, { text, at: Date.now() } satisfies Stored);
  else LS.remove(PREFIX + key);
}

/** Уборка при загрузке: черновики старше недели уходят, старые записи без отметки получают её. */
export function sweepPauseAnswers(now: number = Date.now()): void {
  for (const k of LS.keys(PREFIX)) {
    const raw = LS.raw(k);
    if (raw === null) continue;
    const st = parseStored(raw, now);
    if (now - st.at > KEEP_MS || !st.text) LS.remove(k);
    else if (raw !== JSON.stringify(st)) LS.set(k, st);
  }
}
sweepPauseAnswers();
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
  for (const k of LS.keys(PREFIX + prefix)) LS.remove(k);
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
