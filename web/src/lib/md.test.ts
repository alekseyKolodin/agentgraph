import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkifyText, markdownFits, renderMarkdown } from './md';

// Тесты markdown (перенесены из src/md.test.ts вместе с ui/md.js: web/src/lib/md.ts — его порт один в один).
const md = renderMarkdown;
const fits = markdownFits;
const linkify = linkifyText;

/** Время рендера в мс. */
function timed(src: string): number {
  const t = performance.now();
  md(src);
  return performance.now() - t;
}

test('сырой HTML экранируется: ни <script>, ни <img> в результат не попадают', () => {
  const out = md('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n**<b>жирный</b>**');
  assert.ok(!out.includes('<script') && !out.includes('<img') && !out.includes('<b>'), out);
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('ссылка только для http/https, с noopener', () => {
  for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html;base64,PHNjcmlwdD4=)', '[x](JaVaScRiPt:alert(1))', '[x](vbscript:msgbox)']) {
    assert.ok(!md(bad).includes('<a'), bad);
  }
  const out = md('см. [доку](https://a.b/x?q=1&y=2)');
  assert.ok(out.includes('<a href="https://a.b/x?q=1&amp;y=2" target="_blank" rel="noopener noreferrer">доку</a>'), out);
});

test('код и экранирование в подписи ссылки раскрываются, плейсхолдеры не утекают', () => {
  assert.equal(md('[`a.ts`](https://x/y)'), '<p><a href="https://x/y" target="_blank" rel="noopener noreferrer"><code>a.ts</code></a></p>');
  const out = md('[a\\_b **c**](https://x) и `код` и \\* и [`x`](javascript:1)');
  assert.ok(out.includes('>a_b <strong>c</strong></a>'), out);
  assert.ok(!/[\u0001\u0002]/.test(out), out);
  assert.ok(out.includes('[<code>x</code>](javascript:1)'), out);
});

test('кавычка в адресе ссылки не выходит из атрибута', () => {
  const out = md('[x](https://a.b/"onmouseover="alert(1))');
  assert.ok(!/href="[^"]*"\s*onmouseover/.test(out), out);
});

test('заголовки и списки', () => {
  assert.equal(md('# Раз'), '<h1>Раз</h1>');
  assert.equal(md('### Три ###'), '<h3>Три</h3>');
  assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(md('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(md('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(md('- a\n  - a1\n  - a2\n- b'), '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>');
  assert.equal(md('1. шаг\n   - деталь\n2. шаг'), '<ol><li>шаг<ul><li>деталь</li></ul></li><li>шаг</li></ol>');
});

test('строчная разметка: жирный, курсив, код', () => {
  assert.equal(md('**ж** и *к* и `к<од>`'), '<p><strong>ж</strong> и <em>к</em> и <code>к&lt;од&gt;</code></p>');
  assert.equal(md('snake*case*name и 2 * 3 * 4'), '<p>snake*case*name и 2 * 3 * 4</p>');
});

test('fenced-блок: разметка внутри не применяется, < экранирован', () => {
  const out = md('```ts\nconst a = **x** < 1;\n# не заголовок\n```');
  assert.equal(out, '<pre><code class="lang-ts">const a = **x** &lt; 1;\n# не заголовок</code></pre>');
  assert.equal(md('```\nплоский\n```'), '<pre><code>плоский</code></pre>');
});

test('GFM-таблица: th/td, | внутри кода не делит ячейку', () => {
  const out = md('| Файл | Что |\n|---|:---:|\n| `a|b` | **жирный** |\n| c | d |');
  assert.ok(out.includes('<th>Файл</th><th style="text-align:center">Что</th>'), out);
  assert.ok(out.includes('<td><code>a|b</code></td><td style="text-align:center"><strong>жирный</strong></td>'), out);
  assert.ok(out.includes('<td>c</td>'), out);
  assert.equal((out.match(/<tr>/g) ?? []).length, 3);
});

test('чекбоксы, цитата, линия', () => {
  const out = md('- [x] готово\n- [ ] нет');
  assert.equal(out, '<ul><li class="task"><input type="checkbox" disabled checked> готово</li><li class="task"><input type="checkbox" disabled> нет</li></ul>');
  assert.equal(md('> цитата\n> ещё'), '<blockquote><p>цитата<br>ещё</p></blockquote>');
  assert.equal(md('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>');
});

test('JSON и текст без разметки проходят без потерь', () => {
  const json = JSON.stringify({ done: false, feedback: 'нет <тестов> & "кавычки"', list: [1, 2] }, null, 2);
  const out = md(json);
  const plain = out.replace(/<br>/g, '\n').replace(/<\/?p>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.equal(plain.replace(/\s+/g, ''), json.replace(/\s+/g, ''));
  assert.equal(md('VERDICT: APPROVED\nвсё ок'), '<p>VERDICT: APPROVED<br>всё ок</p>');
});

test('выше порога — один экранированный <pre>', () => {
  const big = '# заголовок <b>\n' + 'x'.repeat(300_001);
  const out = md(big);
  assert.ok(out.startsWith('<pre># заголовок &lt;b&gt;\n') && out.endsWith('</pre>'));
  assert.ok(!out.includes('<h1>'));
});

test('строка длиннее 10 000 символов — тоже один <pre>, и markdownFits это видит', () => {
  const long = '# заголовок\n' + 'y'.repeat(10_001);
  assert.equal(fits(long), false);
  assert.equal(fits('# заголовок\n' + 'y'.repeat(10_000)), true);
  assert.equal(fits('x'.repeat(300_001)), false);
  const out = md(long);
  assert.ok(out.startsWith('<pre># заголовок\n') && out.endsWith('</pre>'), out.slice(0, 40));
});

test('длинные строки размечаются за линейное время', () => {
  // Строки чуть короче порога, каждая бьёт в своё место, где раньше был квадратичный перебор;
  // по 25 штук, чтобы сумма квадратов была большой, а весь текст — меньше 300 КБ. Прежняя версия тратила на каждый случай секунду и больше.
  const n = 9_990;
  const cases: Record<string, string> = {
    'пробелы в заголовке без закрывающих #': `# a${' '.repeat(n)}x`,
    'длинная info-строка ограды с ` в конце': '```' + 'a'.repeat(n) + '`',
    'строка из пробелов под строкой с |': `a | b\n${' '.repeat(n)}`,
    'непарные серии обратных кавычек': Array.from({ length: 140 }, (_, k) => '`'.repeat(k + 1)).join('x').slice(0, n),
    'много одиночных обратных кавычек': '`a'.repeat(n / 2),
  };
  for (const [name, line] of Object.entries(cases)) {
    const src = Array(25).fill(line).join('\n\n');
    assert.ok(fits(src), name);
    const ms = timed(src);
    assert.ok(ms < 300, `${name}: ${Math.round(ms)} мс`);
  }
  // за порогом — сразу <pre>, без разбора
  assert.ok(timed(`# ${' '.repeat(120_000)}x`) < 300);
  assert.ok(timed('```' + 'a'.repeat(100_000) + '`') < 300);
});

test('U+2028 и тысячи «[» в строке разбираются линейно', () => {
  // Каждый случай — 30 строк чуть короче порога. Прежняя версия тратила на них 350–1600 мс, текущая — единицы мс.
  const n = 9_990;
  const cases: Record<string, string> = {
    'заголовок с U+2028 в конце': '# ' + ' '.repeat(n - 4) + 'a ',
    'пункт списка с U+2028 в конце': '- ' + ' '.repeat(n - 4) + 'a ',
    'длинная ограда с U+2028 в конце': '~'.repeat(n - 2) + 'a ',
    'строка из «[»': '['.repeat(n),
    'строка из «[» со ссылкой в конце': '['.repeat(n - 10) + 'a](http:x)',
  };
  for (const [name, line] of Object.entries(cases)) {
    const src = Array(30).fill(line).join('\n\n');
    assert.ok(fits(src), name);
    const ms = timed(src);
    assert.ok(ms < 150, `${name}: ${Math.round(ms)} мс`);
  }
});

test('U+2028 внутри строки не ломает заголовок и пункт списка', () => {
  assert.equal(md('- a b'), '<ul><li>a b</li></ul>');
  assert.equal(md('# a b'), '<h1>a b</h1>');
  assert.equal(md('~~~ js \nx\n~~~'), '<pre><code class="lang-js">x</code></pre>');
});

test('таблица: вывод не раздувается относительно входа', () => {
  // строки из одного «|» под широкой шапкой: раньше каждая добивалась пустыми ячейками до ширины шапки
  const head = '|' + 'a|'.repeat(50) + '\n|' + ':-:|'.repeat(50) + '\n';
  const src = head + '|\n'.repeat(100_000);
  assert.ok(fits(src));
  const out = md(src);
  assert.ok(out.includes('<table>'));
  assert.ok(out.length < 30 * src.length, `вывод в ${Math.round(out.length / src.length)} раз больше входа`);
  // короткая строка не добивается пустыми ячейками, лишние ячейки отбрасываются
  const t = md('| a | b |\n|---|---|\n| c |\n| d | e | f |');
  assert.ok(t.includes('<tr><td>c</td></tr><tr><td>d</td><td>e</td></tr>'), t);
});

test('шапка шире 50 колонок — не таблица', () => {
  const row = (n: number, cell: string) => '|' + `${cell}|`.repeat(n);
  assert.ok(md(`${row(50, 'a')}\n${row(50, '-')}`).includes('<table>'));
  const wide = `${row(2000, 'a')}\n${row(2000, '-')}\n${'|\n'.repeat(1000)}`;
  const out = md(wide);
  assert.ok(!out.includes('<table>'));
  assert.ok(out.length < 3 * wide.length);
});

test('переписанные разборы ведут себя как раньше', () => {
  assert.equal(md('## C# ##'), '<h2>C#</h2>');
  assert.equal(md('# C#'), '<h1>C#</h1>');
  assert.equal(md('# a #b'), '<h1>a #b</h1>');
  // ``` с обратной кавычкой в info-строке — не ограда
  assert.ok(!md('```a`b\nx').includes('<pre>'));
  assert.equal(md('```  py extra\nz\n```'), '<pre><code class="lang-py">z</code></pre>');
  // пустая ячейка в разделителе — не таблица
  assert.ok(!md('| a | b | c |\n|---||---|').includes('<table>'));
  assert.ok(md('a | b\n--- | :-:').includes('<table>'));
  // парные серии разной длины
  assert.equal(md('`` a`b `` и `c`'), '<p><code>a`b</code> и <code>c</code></p>');
});

test('у ~~~ обратная кавычка в info-строке разрешена, как в CommonMark', () => {
  assert.equal(md('~~~ js `x`\ny\n~~~'), '<pre><code class="lang-js">y</code></pre>');
});

test('нумерованный список прерывает абзац только с 1.', () => {
  assert.equal(md('Итоги года\n2025. Рост'), '<p>Итоги года<br>2025. Рост</p>');
  assert.equal(md('Шаги:\n1. раз\n2. два'), '<p>Шаги:</p>\n<ol><li>раз</li><li>два</li></ol>');
  assert.equal(md('Пункты:\n- раз'), '<p>Пункты:</p>\n<ul><li>раз</li></ul>');
});

test('пустая строка — пустой результат', () => {
  assert.equal(md(''), '');
  assert.equal(md('  \n\n'), '');
});

test('глубокая цитата и много скобок не роняют рендерер', () => {
  assert.doesNotThrow(() => md('>'.repeat(50_000) + ' x'));
  assert.doesNotThrow(() => md('['.repeat(50_000) + '`'.repeat(3) + '*'.repeat(50_000)));
});

test('голый http/https-адрес становится ссылкой, хвостовая пунктуация и скобка — нет', () => {
  const a = (u: string) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`;
  assert.equal(md('Ссылка: https://gitlab.x/mr/-/merge_requests/12'), `<p>Ссылка: ${a('https://gitlab.x/mr/-/merge_requests/12')}</p>`);
  assert.equal(md('см. (https://a.b/x?q=1&y=2).'), `<p>см. (${a('https://a.b/x?q=1&amp;y=2')}).</p>`);
  assert.equal(md('https://en.wikipedia.org/wiki/A_(b)'), `<p>${a('https://en.wikipedia.org/wiki/A_(b)')}</p>`);
  assert.equal(md('<https://a.b>'), `<p>&lt;${a('https://a.b')}&gt;</p>`);
  // подчёркивания в адресе не превращаются в курсив, явная ссылка и код не размечаются повторно
  assert.equal(md('https://a.b/x_y_z'), `<p>${a('https://a.b/x_y_z')}</p>`);
  assert.equal(md('[доку](https://a.b) и `https://c.d`'), '<p><a href="https://a.b" target="_blank" rel="noopener noreferrer">доку</a> и <code>https://c.d</code></p>');
  for (const bad of ['javascript:alert(1)', 'ftp://a.b', 'https://', 'xhttps://a.b']) assert.ok(!md(bad).includes('<a'), bad);
});

test('linkifyText: текст экранирован, адреса кликабельны, разметки нет', () => {
  assert.equal(
    linkify('**жирный** <b>x</b>\nhttps://a.b/"onmouseover=alert(1)'),
    '**жирный** &lt;b&gt;x&lt;/b&gt;\n<a href="https://a.b/" target="_blank" rel="noopener noreferrer">https://a.b/</a>&quot;onmouseover=alert(1)',
  );
  assert.equal(linkify('\u0001' + '0\u0002 https://a.b'), '\uFFFD0\uFFFD <a href="https://a.b" target="_blank" rel="noopener noreferrer">https://a.b</a>');
  assert.equal(linkify(''), '');
});

test('автоссылки линейны на длинной строке из адресов и скобок', () => {
  assert.ok(timed('https://a.b/' + ')'.repeat(9_000)) < 500);
  assert.ok(timed(('https://a.b/x ').repeat(700)) < 500);
});
