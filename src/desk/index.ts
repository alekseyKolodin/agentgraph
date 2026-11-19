// Хранилище дел (docs/desk/SPEC.md 3.2, план — docs/desk/plan-3.md). Остальные модули импортируют отсюда только
// desk() и openDesk() и в тестах подменяют DeskApi своим. Устройство — store.ts, правила движения — rules.ts,
// сверка — reconcile.ts, HTTP — routes.ts.
//
// Поставщики (этап 4, SPEC 4.3): дела, которые живут в своей системе и в items.json не копируются, — задачи Teamwork
// (providers/teamwork.ts). desk() и deskStore() сливают их с делами хранилища: list — оба списка по одному фильтру,
// get/put/move/close по ключу поставщика — в поставщика, а если вещи у него нет (чужая задача) — в хранилище, как раньше.
// Сверке (reconcile.ts) нужно только хранилище — deskStorage(): за делами поставщика следит сам поставщик.
import path from 'node:path';
import { configDir } from '../settings.js';
import { matchesFilter, openStore, type DeskStore } from './store.js';
import { teamworkProvider } from './providers/teamwork.js';
import type { DeskApi, DeskItem, DeskProvider } from './types.js';

/** Хранилище в папке dir (<configDir()>/desk по умолчанию): items.json + log.jsonl. Без поставщиков. */
export function openDesk(dir?: string): DeskApi {
  return openDeskStore(dir);
}

/** То же с операциями сверки и подпиской на изменения — для reconcile.ts и сервера. Без поставщиков. */
export function openDeskStore(dir: string = path.join(configDir(), 'desk')): DeskStore {
  return openStore(dir);
}

/** Поставщики по умолчанию для папки дел dir: Teamwork — общий сервис команд сервера или свой без таймеров (CLI). */
export function defaultProviders(dir: string): DeskProvider[] {
  return [
    teamworkProvider({
      dir,
      // лениво: teamwork-server тянет git и flow, а CLI `agentgraph desk` без команд его не трогает
      service: async () => (await import('../teamwork-server.js')).deskTeamService(),
      // статус задачи пишет только сервер: у CLI своя очередь записи в клон и нет отправки
      writable: async () => (await import('../teamwork-server.js')).teamServiceRunning(),
    }),
  ];
}

const own = (p: DeskProvider, key: string) => key.startsWith(p.prefix);
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Хранилище, слитое с поставщиками. Операции сверки (observe, runEnded, check) — только хранилища. Поставщик упал на
 * list — его дел в списке нет, доска не ломается (причина — в лог); на get/put/move/close — ошибка операции.
 */
export function withProviders(store: DeskStore, providers: readonly DeskProvider[]): DeskStore {
  if (!providers.length) return store;
  const of = (key: string) => providers.find((p) => own(p, key));
  const fromProviders = async (): Promise<DeskItem[]> =>
    (await Promise.all(providers.map((p) => p.list().catch((err) => {
      console.error(`[дела] поставщик ${p.prefix} не отдал дела: ${errMsg(err)}`);
      return [] as DeskItem[];
    })))).flat();
  return {
    ...store,
    dir: store.dir,
    async list(filter = {}) {
      const [stored, provided] = await Promise.all([store.list(filter), fromProviders()]);
      // своя вещь поставщика главнее записи о ней в хранилище (её мог завести put до того, как задачу назначили на меня)
      const keys = new Set(provided.map((i) => i.key));
      return [...stored.filter((i) => !keys.has(i.key)), ...provided.filter((i) => matchesFilter(i, filter))].sort((a, b) => b.movedAt.localeCompare(a.movedAt));
    },
    async get(key) {
      return (await of(key)?.get(key)) ?? store.get(key);
    },
    async put(key, patch, by) {
      return (await of(key)?.put(key, patch, by)) ?? store.put(key, patch, by);
    },
    async move(key, column, by, why) {
      return (await of(key)?.move(key, column, by, why)) ?? store.move(key, column, by, why);
    },
    async close(key, reason, by) {
      return (await of(key)?.close(key, reason, by)) ?? store.close(key, reason, by);
    },
    onChange(fn) {
      const offs = [store.onChange(fn), ...providers.map((p) => p.onChange(fn))];
      return () => offs.forEach((off) => off());
    },
  };
}

let storage: DeskStore | undefined;
let shared: DeskStore | undefined;

/** Общее хранилище процесса с поставщиками. */
export function desk(): DeskApi {
  return deskStore();
}

/** Общее хранилище процесса с поставщиками, сверкой и подпиской (сервер: маршруты, события доски). */
export function deskStore(): DeskStore {
  shared ??= withProviders(deskStorage(), defaultProviders(deskStorage().dir));
  return shared;
}

/** Только хранилище процесса, без поставщиков: сверка (reconcile.ts) следит лишь за делами items.json. */
export function deskStorage(): DeskStore {
  storage ??= openDeskStore();
  return storage;
}
