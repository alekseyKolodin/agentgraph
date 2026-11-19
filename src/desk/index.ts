// Хранилище дел (docs/desk/SPEC.md 3.2, план — docs/desk/plan-3.md). Остальные модули импортируют отсюда только
// desk() и openDesk() и в тестах подменяют DeskApi своим. Устройство — store.ts, правила движения — rules.ts,
// сверка — reconcile.ts, HTTP — routes.ts.
import path from 'node:path';
import { configDir } from '../settings.js';
import { openStore, type DeskStore } from './store.js';
import type { DeskApi } from './types.js';

/** Хранилище в папке dir (<configDir()>/desk по умолчанию): items.json + log.jsonl. */
export function openDesk(dir?: string): DeskApi {
  return openDeskStore(dir);
}

/** То же с операциями сверки и подпиской на изменения — для reconcile.ts и сервера. */
export function openDeskStore(dir: string = path.join(configDir(), 'desk')): DeskStore {
  return openStore(dir);
}

let shared: DeskStore | undefined;

/** Общее хранилище процесса. */
export function desk(): DeskApi {
  return deskStore();
}

/** Общее хранилище процесса со сверкой и подпиской (сервер). */
export function deskStore(): DeskStore {
  shared ??= openDeskStore();
  return shared;
}
