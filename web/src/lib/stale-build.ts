// Сборка устарела: открытая страница держит старый index-*.js, а `npm run build:web` (emptyOutDir) уже стёр файлы
// экранов с прежними хешами — ленивый экран просит файл, которого нет, сервер отвечает 404. main.tsx ловит
// vite:preloadError, ставит флаг и перезагружает страницу; экран ошибки маршрута (shell/RouteError) по флагу
// объясняет, что приложение обновилось. Без React и DOM.

/** Не чаще одной авто-перезагрузки за это время: файла нет и в свежей сборке — без цикла перезагрузок. */
export const AUTO_RELOAD_GAP_MS = 10_000;

let stale = false;

/** Файл сборки не загрузился: флаг живёт до перезагрузки страницы. */
export function markStale(): void {
  stale = true;
}

export function isStale(): boolean {
  return stale;
}

/** Перезагружать ли сами: с прошлой авто-перезагрузки (`last`, мс; 0 — не было) прошло больше 10 секунд. */
export function shouldAutoReload(last: number, now: number): boolean {
  return now - last > AUTO_RELOAD_GAP_MS;
}
