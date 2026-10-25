// Раздача сборки UI (dist/web, `npm run build:web`) на /. Чистое решение по пути: что отдать и с каким кэшем; поток
// открывает сервер. Вложенные папки разрешены, выход из dist/web — нет (`..`, в том числе %2e%2e и %2f).
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './artifacts.js';

/** Префикс UI. Совпадает с base в web/vite.config.ts. */
export const WEB_BASE = '/';

/** Префикс, на котором UI жил во время миграции на React. */
const LEGACY_BASE = '/next';

/**
 * Старый адрес UI → новый для 308: `/next/run/<id>` → `/run/<id>`, `/next` → `/`. query сохраняется, хеш браузер
 * переносит сам (старые `/#run/<id>` разбирает клиент, web/src/lib/legacy-url.ts). Не старый адрес — undefined.
 */
export function legacyRedirect(pathname: string, search = ''): string | undefined {
  if (pathname !== LEGACY_BASE && !pathname.startsWith(`${LEGACY_BASE}/`)) return undefined;
  // //evil.example после среза стал бы адресом другого хоста: схлопываем ведущие слеши
  const rest = pathname.slice(LEGACY_BASE.length).replace(/^\/+/, '/');
  return (rest || '/') + search;
}

/**
 * Страница UI: только свои скрипты (в сборке Vite нет inline-скриптов), без плагинов, <base> и встраивания во фрейм
 * чужой страницей. Вторая линия защиты за экранированием markdown: XSS в UI — это запуск агентов на машине.
 * style-src не ограничен: inline-стили ставят React, xyflow, CodeMirror и markdown (text-align в таблицах).
 */
export const PAGE_CSP = "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export type WebAnswer =
  | { kind: 'file'; file: string; type: string; cache: string; headers?: Record<string, string> }
  /** Сборки нет: npm run build:web. */
  | { kind: 'not-built' }
  | { kind: 'not-found' }
  /** Путь выходит из папки сборки или не разбирается. */
  | { kind: 'bad-path' };

/** Файлы с хешем в имени (Vite кладёт их в assets/) не меняются никогда; index.html и остальное — перепроверять. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Что отдать на GET `pathname` (уже без query) из папки сборки `dir`. pathname начинается с WEB_BASE.
 * Существующий файл — он сам; путь без расширения вне assets/ — index.html (SPA: маршруты роутера); иначе 404.
 */
export function resolveWebFile(dir: string, pathname: string): WebAnswer {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(WEB_BASE.length));
  } catch {
    return { kind: 'bad-path' };
  }
  if (rel.includes('\0') || rel.split(/[/\\]/).includes('..')) return { kind: 'bad-path' };
  // /api/… — не UI: неизвестный маршрут API должен дать 404, а не index.html
  if (rel === 'api' || rel.startsWith('api/')) return { kind: 'not-found' };
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');
  if (!isFile(index)) return { kind: 'not-built' };

  if (rel && !rel.endsWith('/')) {
    const full = path.resolve(root, rel);
    if (!isInside(full, root)) return { kind: 'bad-path' };
    if (isFile(full)) {
      // симлинк наружу из сборки не отдаём
      if (!isInside(fs.realpathSync.native(full), fs.realpathSync.native(root))) return { kind: 'bad-path' };
      const top = rel.split(/[/\\]/)[0];
      return { kind: 'file', file: full, type: TYPES[path.extname(full).toLowerCase()] ?? 'application/octet-stream', cache: top === 'assets' ? IMMUTABLE : NO_CACHE };
    }
    // пропавший файл сборки (старый хеш после пересборки) — 404, а не index.html под видом скрипта
    if (rel.startsWith('assets/') || path.extname(rel)) return { kind: 'not-found' };
  }
  return { kind: 'file', file: index, type: TYPES['.html'], cache: NO_CACHE, headers: { 'Content-Security-Policy': PAGE_CSP } };
}

function isFile(p: string): boolean {
  return Boolean(fs.statSync(p, { throwIfNoEntry: false })?.isFile());
}
