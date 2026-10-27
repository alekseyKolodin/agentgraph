// Markdown для вопросов агента, окна файлов и замечаний условия (порт ui/md.js один в один).
// В выводах бывает чужой текст (Jira, MR, цитаты агента), а сервер без авторизации запускает агентов с Bash,
// поэтому XSS здесь равен выполнению кода на машине. Правила: сначала экранируем весь текст, сырой HTML не пропускаем,
// ссылки — только http/https, пути к файлам — без href, по data-path (lib/paths.ts). Результат renderMarkdown — единственное, что можно класть в dangerouslySetInnerHTML.
// Чистые функции без DOM.
import { findPaths, isPath, pathLinkHtml } from './paths';

/** Выше порогов не размечаем: огромный вывод или одну гигантскую строку показываем как есть, чтобы не подвесить вкладку. */
const MAX_CHARS = 300_000;
const MAX_LINE = 10_000;
/** Глубже не разбираем вложенные цитаты: строка из тысяч «>» не должна переполнить стек. */
const MAX_QUOTE_DEPTH = 20;
/** Шапка шире — уже не таблица, а абзац: тысячи колонок раздували бы вывод. */
const MAX_TABLE_COLS = 50;

/** Экранирование текста для HTML: & < > ". */
export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch as '&']);

// Регулярки работают по уже экранированному тексту: «>» здесь — это &gt;.
// Регулярки без вложенных и соседних квантификаторов по одним символам: на длинной строке они работают линейно.
// Хвост строки — [^\n]*, а не .*: точка не совпадает с U+2028/U+2029, и на них начинался перебор с откатом.
const FENCE = /^(\s*)(`{3,}|~{3,})([^\n]*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+([^\n]*)$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}&gt;/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+([^\n]*)$/;
const DELIM_CELL = /^:?-+:?$/;
const TASK = /^\[([ xX])\]\s+/;

// Плейсхолдеры для готового HTML внутри строки: управляющие символы вычищаем из исходника заранее.
const PH_OPEN = '\u0001';
const PH_CLOSE = '\u0002';

type Keep = (html: string) => string;

/** Влезает ли текст в пороги разметки; по нему же решают, показывать ли текст моноширинно. */
export function markdownFits(src: unknown): boolean {
  const text = String(src ?? '');
  if (text.length > MAX_CHARS) return false;
  for (let at = 0; at < text.length; ) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl;
    if (end - at > MAX_LINE) return false;
    at = end + 1;
  }
  return true;
}

export function renderMarkdown(src: unknown): string {
  const text = String(src ?? '');
  if (!text.trim()) return '';
  if (!markdownFits(text)) return `<pre>${esc(text)}</pre>`;
  const lines = esc(text.replace(/[\u0001\u0002]/g, '�'))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length)));
  return blocks(lines, 0);
}

function blocks(lines: string[], depth: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const f = fence(line);
    if (f) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i]!, f.fence)) body.push(stripIndent(lines[i++]!, f.indent.length));
      i++; // закрывающая ограда (или конец текста)
      out.push(`<pre><code${f.lang ? ` class="lang-${f.lang}"` : ''}>${body.join('\n')}</code></pre>`);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const n = h[1]!.length;
      out.push(`<h${n}>${inline(stripClosingHashes(h[2]!))}</h${n}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line) && depth < MAX_QUOTE_DEPTH) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(lines[i++]!.replace(/^\s{0,3}&gt; ?/, ''));
      out.push(`<blockquote>${blocks(inner, depth + 1)}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, i)) {
      const r = table(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (LIST.test(line)) {
      const r = list(lines, i);
      out.push(r.html);
      i = r.next;
      continue;
    }
    const para = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines, i)) para.push(lines[i++]!);
    out.push(`<p>${para.map((l) => inline(l.trim())).join('<br>')}</p>`);
  }
  return out.join('\n');
}

/** Что прерывает абзац. Нумерованный список — только с «1.», иначе строка вида «2025. Итог» рвала бы текст. */
function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i]!;
  const li = LIST.exec(l);
  return (
    isFence(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || isTableStart(lines, i)
    || (li !== null && (!/\d/.test(li[2]!) || parseInt(li[2]!, 10) === 1))
  );
}

/** Открывающая ограда: у ``` в info-строке не бывает обратных кавычек, у ~~~ — бывает. Язык — первое слово. */
function fence(line: string): { indent: string; fence: string; lang: string } | null {
  const m = FENCE.exec(line);
  if (!m || (m[2]![0] === '`' && m[3]!.includes('`'))) return null;
  return { indent: m[1]!, fence: m[2]!, lang: /^\s*([\w+#.-]*)/.exec(m[3]!)![1]! };
}

const isFence = (line: string): boolean => fence(line) !== null;

/** «## Заголовок ##» → «Заголовок»: хвост из # снимается, только если перед ним пробел. */
function stripClosingHashes(s: string): string {
  const t = s.trimEnd();
  let k = t.length;
  while (k > 0 && t[k - 1] === '#') k--;
  if (k === t.length || k === 0 || !/\s/.test(t[k - 1]!)) return s;
  return t.slice(0, k).trimEnd();
}

function closesFence(line: string, mark: string): boolean {
  const t = line.trim();
  return t.length >= mark.length && t[0] === mark[0] && [...t].every((ch) => ch === mark[0]);
}

function stripIndent(line: string, n: number): string {
  let k = 0;
  while (k < n && line[k] === ' ') k++;
  return line.slice(k);
}

// ---------- таблицы GFM

function isTableStart(lines: string[], i: number): boolean {
  if (!lines[i]!.includes('|') || i + 1 >= lines.length || !isDelimRow(lines[i + 1]!)) return false;
  const n = splitRow(lines[i]!).length;
  return n <= MAX_TABLE_COLS && n === splitRow(lines[i + 1]!).length;
}

/** Строка-разделитель под шапкой: «|---|:--:|», ячейки только из - и :. */
function isDelimRow(line: string): boolean {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').every((c) => DELIM_CELL.test(c.trim()));
}

/** Ячейки строки таблицы: «|» внутри `кода` и экранированный \| ячейку не делят. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let tick = 0; // длина открытой серии обратных кавычек, 0 — вне кода
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') {
      cur += '\\|';
      k++;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (s[k + n] === '`') n++;
      if (!tick) tick = n;
      else if (tick === n) tick = 0;
      cur += '`'.repeat(n);
      k += n - 1;
      continue;
    }
    if (ch === '|' && !tick) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function table(lines: string[], i: number): { html: string; next: number } {
  const head = splitRow(lines[i]!);
  const align = splitRow(lines[i + 1]!).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '',
  );
  const cell = (tag: string, c: string, k: number) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
  const rows: string[] = [];
  let j = i + 2;
  while (j < lines.length && lines[j]!.trim() && lines[j]!.includes('|')) {
    // короткую строку пустыми ячейками не добиваем: иначе строка из одного «|» дала бы по ячейке на колонку шапки
    const cells = splitRow(lines[j++]!).slice(0, head.length);
    rows.push(`<tr>${cells.map((c, k) => cell('td', c, k)).join('')}</tr>`);
  }
  const html = `<div class="md-table"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>`
    + `${rows.length ? `<tbody>${rows.join('')}</tbody>` : ''}</table></div>`;
  return { html, next: j };
}

// ---------- списки: вложенность по отступу, продолжение пункта — строкой с отступом

type ListItem = { indent: number; ordered: boolean; num: number; lines: string[] };

function list(lines: string[], i: number): { html: string; next: number } {
  const items: ListItem[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    const m = !HR.test(line) && LIST.exec(line);
    if (m) {
      items.push({ indent: m[1]!.length, ordered: /\d/.test(m[2]!), num: parseInt(m[2]!, 10), lines: [m[3]!] });
      i++;
      continue;
    }
    if (!line.trim()) {
      // пустая строка не рвёт список, если дальше пункт или продолжение с отступом
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim()) j++;
      const next = lines[j];
      if (next !== undefined && !isFence(next) && ((!HR.test(next) && LIST.test(next)) || /^\s{2,}\S/.test(next))) {
        i = j;
        continue;
      }
      break;
    }
    if (/^\s+\S/.test(line) && !isFence(line)) {
      items[items.length - 1]!.lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  return { html: renderList(items), next: i };
}

function renderList(items: ListItem[]): string {
  let html = '';
  const stack: { indent: number; tag: string }[] = [];
  const open = (it: ListItem) => {
    const tag = it.ordered ? 'ol' : 'ul';
    stack.push({ indent: it.indent, tag });
    html += `<${tag}${it.ordered && it.num !== 1 ? ` start="${it.num}"` : ''}>`;
  };
  const close = () => {
    html += `</li></${stack.pop()!.tag}>`;
  };
  for (const it of items) {
    while (stack.length > 1 && it.indent < stack[stack.length - 1]!.indent) close();
    const top = stack[stack.length - 1];
    if (!top || it.indent >= top.indent + 2) open(it); // вложенный список остаётся внутри текущего пункта
    else if (top.tag !== (it.ordered ? 'ol' : 'ul')) {
      close();
      open(it);
    } else html += '</li>';
    let first = it.lines[0]!;
    let task = '';
    const t = TASK.exec(first);
    if (t) {
      task = `<input type="checkbox" disabled${t[1] === ' ' ? '' : ' checked'}> `;
      first = first.slice(t[0].length);
    }
    html += `<li${task ? ' class="task"' : ''}>${task}${[first, ...it.lines.slice(1)].map(inline).join('<br>')}`;
  }
  while (stack.length) close();
  return html;
}

// ---------- строчная разметка

function inline(s: string): string {
  const saved: string[] = [];
  const keep: Keep = (html) => `${PH_OPEN}${saved.push(html) - 1}${PH_CLOSE}`;
  const restore = (str: string) => str.replace(/\u0001(\d+)\u0002/g, (_, n: string) => saved[Number(n)]!);

  // ссылка в ссылке не работает: путь из `кода` в подписи остаётся текстом
  const labelHtml = (label: string) => restore(emphasis(label)).replace(/<a class="path-link"[^>]*>([^<]*)<\/a>/g, '$1');
  s = codeSpans(s, keep);
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, (_, ch: string) => keep(ch));
  // в подписи нет «[»: до «]» доходит только ближайшая «[», а не каждая из тысячи подряд
  s = s.replace(/\[([^[\]\n]{1,500})\]\(([^()\s\u0001\u0002]{1,2000})\)/g, (all, label: string, url: string) => {
    // url уже экранирован (без " < >), так что из атрибута не выйти; протокол — только http/https, остальное — путь или текст
    if (!/^https?:\/\//i.test(url)) return isPath(url, true) ? keep(pathLinkHtml(url, labelHtml(label))) : all;
    // `код` в подписи уже заменён плейсхолдером: раскрываем его здесь, внешний restore вложенные не видит
    return keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${labelHtml(label)}</a>`);
  });
  s = linkPaths(autolink(s, keep), keep);
  return restore(emphasis(s));
}

// Голый адрес в уже экранированном тексте: до пробела или сущности (&lt; &gt; &quot;), &amp; — часть адреса.
// Плейсхолдеры в адрес не входят, так что ссылки [..](..) и `код` повторно не размечаются.
const BARE_URL = /\bhttps?:\/\/(?:[^\s&\u0001\u0002]|&amp;)+/gi;

/** Голые http/https-адреса — в ссылки; хвостовую пунктуацию и непарную «)» оставляем тексту. */
function autolink(s: string, keep: Keep): string {
  if (!/https?:\/\//i.test(s)) return s;
  return s.replace(BARE_URL, (all) => {
    // скобки считаем один раз и отнимаем по ходу: пересчёт на каждом шаге квадратичен на «)))…»
    let open = 0;
    let close = 0;
    for (const ch of all) {
      if (ch === '(') open++;
      else if (ch === ')') close++;
    }
    let end = all.length;
    for (;;) {
      const last = all[end - 1]!;
      if (/[.,;:!?'*_~\]]/.test(last)) end--;
      else if (last === ')' && close > open) {
        end--;
        close--;
      } else break;
    }
    const url = all.slice(0, end);
    if (!/^https?:\/\/[^/]/i.test(url)) return all;
    return keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + all.slice(url.length);
  });
}

/** Пути к файлам — в ссылки «показать в Finder»; адреса и `код` уже стоят плейсхолдерами и сюда не попадают. */
function linkPaths(s: string, keep: Keep): string {
  let out = '';
  let at = 0;
  for (const h of findPaths(s)) {
    out += s.slice(at, h.start) + keep(pathLinkHtml(h.path, h.path));
    at = h.end;
  }
  return at ? out + s.slice(at) : s;
}

/** Обычный текст без разметки, но с кликабельными адресами и путями: для полей, где markdown неуместен. */
export function linkifyText(src: unknown): string {
  const saved: string[] = [];
  const keep: Keep = (html) => `${PH_OPEN}${saved.push(html) - 1}${PH_CLOSE}`;
  return linkPaths(autolink(esc(String(src ?? '').replace(/[\u0001\u0002]/g, '�')), keep), keep).replace(
    /\u0001(\d+)\u0002/g,
    (_, n: string) => saved[Number(n)]!,
  );
}

function emphasis(s: string): string {
  return (
    s
      .replace(/\*\*(?=[^\s*])([^*]*?[^\s*])\*\*/g, '<strong>$1</strong>')
      // звёздочка внутри слова (a*b*c) курсивом не считается
      .replace(/(^|[^*\p{L}\p{N}])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\p{L}\p{N}])/gu, '$1<em>$2</em>')
      .replace(/~~(?=\S)([^~]*?\S)~~/g, '<del>$1</del>')
  );
}

/** `код` любой длиной ограды; содержимое уже экранировано и дальше не размечается. */
function codeSpans(s: string, keep: Keep): string {
  if (!s.includes('`')) return s;
  const runs = [...s.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  // для каждой серии — индекс следующей серии той же длины, за один проход с конца
  const next = new Array<number>(runs.length);
  const seen = new Map<number, number>();
  for (let k = runs.length - 1; k >= 0; k--) {
    next[k] = seen.get(runs[k]!.len) ?? -1;
    seen.set(runs[k]!.len, k);
  }
  let out = '';
  let pos = 0;
  for (let a = 0; a < runs.length; a++) {
    const b = next[a]!;
    if (b < 0) continue;
    const open = runs[a]!;
    const close = runs[b]!;
    let body = s.slice(open.at + open.len, close.at);
    if (/^ [^\n]* $/.test(body) && body.trim()) body = body.slice(1, -1);
    // `src/a.ts:42` или `README.md` целиком — путь: в коде голое имя файла почти всегда файл
    out += s.slice(pos, open.at) + keep(`<code>${isPath(body, true) ? pathLinkHtml(body, body) : body}</code>`);
    pos = close.at + close.len;
    a = b;
  }
  return out + s.slice(pos);
}
