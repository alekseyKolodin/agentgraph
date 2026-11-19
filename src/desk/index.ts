// Хранилище дел. Заглушка контракта этапа 3: реализацию пишет сессия desk-core (docs/desk/plan-3.md).
// Остальные сессии импортируют отсюда только desk() и openDesk() и в тестах подменяют DeskApi своим.

import type { DeskApi } from './types.js';

/** Хранилище в папке dir (<configDir()>/desk по умолчанию): items.json + log.jsonl. */
export function openDesk(_dir?: string): DeskApi {
  throw new Error('desk: хранилище ещё не реализовано (этап 3, desk-core)');
}

let shared: DeskApi | undefined;

/** Общее хранилище процесса. */
export function desk(): DeskApi {
  shared ??= openDesk();
  return shared;
}
