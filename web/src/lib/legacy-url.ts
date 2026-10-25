// Адреса старого UI (ui/, удалён на этапе 7 миграции) были хешами на корне: /#run/<id>, /#flow/<имя>, /#tags/<slug>, /#context.
// Сохранённые ссылки и закладки ведут туда же, но уже путями роутера. Хеш до сервера не доходит, поэтому разбирает клиент
// (main.tsx, до роутера); /next/… времён миграции сервер переводит на /… сам (legacyRedirect в src/web-static.ts).

/** Путь роутера для старого хеша (с `#`) или undefined, если это не старый адрес. Разбор — как route() в ui/app.js. */
export function legacyHashPath(hash: string): string | undefined {
  if (hash === '#context') return '/context';
  const t = hash.match(/^#tags(?:\/([a-z0-9-]+))?$/);
  if (t) return t[1] ? `/tags/${t[1]}` : '/tags';
  // черновик жил только в памяти вкладки: после перезагрузки его нет — на главную, как в старом
  if (hash === '#draft') return '/';
  const m = hash.match(/^#(flow|run)\/([A-Za-z0-9_-]+)$/);
  return m ? `/${m[1]}/${m[2]}` : undefined;
}

/** Адрес, на который заменить текущий, если открыт старый `/#…`; иначе undefined. query сохраняется. */
export function legacyLocation(loc: { pathname: string; search: string; hash: string }): string | undefined {
  if (loc.pathname !== '/' || !loc.hash) return undefined;
  const p = legacyHashPath(loc.hash);
  return p === undefined ? undefined : p + loc.search;
}
