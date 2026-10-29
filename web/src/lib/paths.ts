// Пути к файлам в тексте — в вывод этапов, лог и поля запуска, чтобы по клику показать файл в Finder (POST /api/reveal).
// Чистые функции без DOM. Работают и по сырому тексту (лог), и по экранированному (md.ts): «&» и «;» в путь не входят,
// поэтому &quot; и &gt; путь не съедают, а экранированный путь совпадает с сырым.
// Ложная ссылка безвредна (сервер ответит «Файл не найден»), но шумна, поэтому правила строгие:
// абсолютный — /a/b.ext или от трёх частей, ~/…, ./… и ../… — всегда; относительный — с «/» и расширением в конце;
// голое имя файла (README.md) — только целиком в `коде` или в ссылке [..](..), в тексте это чаще Node.js и example.com.

/** Часть пути между «/»: без пробелов, кавычек (и «ёлочек»), скобок, «:» (хвост :строка), разметки и плейсхолдеров md.ts. */
const SEG = String.raw`[^\s"'\x60«»“”‘’…<>()[\]{}|,;:*?=&\\/\u0001\u0002]+`;
// слева не буква, цифра и не символ пути: внутри слова, адреса или другого пути новый путь не начинается
const TOKEN = new RegExp(String.raw`(?<![\p{L}\p{N}_.~/:@\\-])(?:~\/|\.{1,2}\/|\/)?${SEG}(?:\/${SEG})*\/?(?::\d+){0,2}`, 'gu');
const URL_OR_TOKEN = new RegExp(String.raw`https?:\/\/\S+|${TOKEN.source}`, 'giu');
const EXT = /[^.]\.[A-Za-z][A-Za-z0-9]{0,9}$|^\.[A-Za-z][\w-]{0,15}$/;
const LINE = /(?::\d+){1,2}$/;
// первая часть похожа на домен: github.com/a/b.md — адрес без схемы, а не путь
const DOMAIN = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[A-Za-z]{2,}$/u;

/** Похоже ли это целиком на путь. bare — пустить и голое имя файла с расширением (README.md). */
export function isPath(s: string, bare = false): boolean {
  const core = s.replace(LINE, '');
  if (!core || core !== core.match(TOKEN)?.[0]) return false;
  if (/^(?:~|\.{1,2})\/./.test(core)) return true;
  const abs = core.startsWith('/');
  const segs = core.replace(/^\//, '').replace(/\/$/, '').split('/');
  const last = segs[segs.length - 1]!;
  if (segs.some((x) => !x)) return false;
  if (abs) return segs.length >= 3 || (segs.length === 2 && EXT.test(last));
  if (segs.length === 1) return bare && EXT.test(last) && !/^\.\.?$/.test(last);
  return EXT.test(last) && (segs[0]!.startsWith('.') || !DOMAIN.test(segs[0]!));
}

export type PathHit = { start: number; end: number; path: string };

/** Пути в тексте; хвостовые точки предложения в путь не входят. */
export function findPaths(text: string): PathHit[] {
  if (!text.includes('/')) return [];
  const out: PathHit[] = [];
  for (const m of text.matchAll(URL_OR_TOKEN)) {
    if (/^https?:/i.test(m[0])) continue;
    // точки с конца — циклом: /\.+$/ на длинной серии точек внутри пути квадратичен
    let end = m[0].length;
    while (end && m[0][end - 1] === '.') end--;
    const p = m[0].slice(0, end);
    if (isPath(p)) out.push({ start: m.index, end: m.index + p.length, path: p });
  }
  return out;
}

export type Piece = string | { path: string };

/** Текст кусками: строки как есть, пути — отдельными кусками. */
export function splitPaths(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const h of findPaths(text)) {
    if (h.start > at) out.push(text.slice(at, h.start));
    out.push({ path: h.path });
    at = h.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** HTML ссылки на путь для md.ts. path и html уже экранированы; клик ловит обработчик оболочки по data-path. */
export const pathLinkHtml = (path: string, html: string): string =>
  `<a class="path-link" data-path="${path}" role="link" tabindex="0">${html}</a>`;

/** Путь от домашней папки: «/Users/me/proj/shop» → «~/proj/shop». */
export const tildePath = (p: string, home: string | undefined): string => (home && (p === home || p.startsWith(home + '/')) ? `~${p.slice(home.length)}` : p);
