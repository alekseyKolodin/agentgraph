// Защита локального UI-сервера от чужих страниц в браузере: DNS rebinding (имя хоста) и CSRF (Origin, тип тела).
// Сервер слушает только 127.0.0.1 и авторизации не имеет, поэтому браузер с открытой посторонней страницей — единственный
// путь к нему снаружи. Проверка чистая: заголовки на входе, причина отказа на выходе.
import type { IncomingHttpHeaders } from 'node:http';

/** Имена хоста, по которым к серверу ходит UI. Порт любой: SSH-туннель может пробросить другой. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type RequestProblem = { status: 421 | 403 | 415; error: string };

/**
 * Почему запрос отклоняется; undefined — пропустить.
 * - Host: только 127.0.0.1, localhost или [::1] с любым портом, иначе 421 (страница с чужим доменом, указывающим на 127.0.0.1).
 * - Кроме GET и HEAD: Origin либо нет (curl, хелпер скилла), либо совпадает с Host по схеме, хосту и порту, иначе 403.
 * - Запрос с телом: Content-Type application/json, иначе 415 (форма с чужой страницы шлёт его без preflight только как text/plain или form).
 */
export function requestProblem(method: string, headers: IncomingHttpHeaders): RequestProblem | undefined {
  const host = parseHost(headers.host);
  if (!host || !LOCAL_HOSTS.has(host.hostname)) {
    return { status: 421, error: 'Сервер agentgraph принимает запросы только на 127.0.0.1, localhost или [::1]' };
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = headers.origin;
    if (origin !== undefined && !sameOrigin(origin, host)) {
      return { status: 403, error: 'Запрос с чужой страницы отклонён: Origin не совпадает с адресом сервера' };
    }
  }
  if (hasBody(headers) && mediaType(headers['content-type']) !== 'application/json') {
    return { status: 415, error: 'Тело запроса — только JSON (Content-Type: application/json)' };
  }
  return undefined;
}

/** Host как URL: hostname (у IPv6 — в скобках) и host с портом. undefined — нет или не разбирается. */
function parseHost(raw: string | undefined): URL | undefined {
  if (!raw || /[/?#@\s\\]/.test(raw)) return undefined;
  try {
    return new URL(`http://${raw}`);
  } catch {
    return undefined;
  }
}

/** Origin совпадает с адресом сервера: схема http (сервер без TLS), тот же хост и порт. Origin: null — не совпадает. */
function sameOrigin(origin: string, host: URL): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  return o.protocol === 'http:' && o.host === host.host;
}

/** Тело есть, если заявлена длина больше нуля или передача по частям. POST без тела (pause, resume) шлёт content-length: 0. */
function hasBody(headers: IncomingHttpHeaders): boolean {
  if (headers['transfer-encoding'] !== undefined) return true;
  const len = headers['content-length'];
  return len !== undefined && Number(len) !== 0;
}

function mediaType(raw: string | undefined): string {
  return (raw ?? '').split(';')[0].trim().toLowerCase();
}
