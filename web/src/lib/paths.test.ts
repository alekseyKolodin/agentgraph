import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPaths, isPath, splitPaths } from './paths';
import { linkifyText, renderMarkdown } from './md';

const paths = (s: string) => findPaths(s).map((h) => h.path);

test('пути: абсолютные, ~, ./, относительные с расширением и хвост :строка', () => {
  assert.deepEqual(paths('Готово: /Users/a/proj/runs/x/artifacts/ideas.md.'), ['/Users/a/proj/runs/x/artifacts/ideas.md']);
  assert.deepEqual(paths('см. web/src/lib/md.ts:42 и src/a.ts:3:7, ещё ~/notes/todo.md'), ['web/src/lib/md.ts:42', 'src/a.ts:3:7', '~/notes/todo.md']);
  assert.deepEqual(paths('./scripts/run и ../docs/x'), ['./scripts/run', '../docs/x']);
  assert.deepEqual(paths('папка /Users/a/proj, файл .claude/skills/x/SKILL.md'), ['/Users/a/proj', '.claude/skills/x/SKILL.md']);
  assert.deepEqual(paths('Путь: /Users/a/Документы/отчёт.md'), ['/Users/a/Документы/отчёт.md']);
});

test('пути: не путь — дроби, и/или, адреса, домены, короткие абсолютные и голые имена в тексте', () => {
  assert.deepEqual(paths('и/или, 1/2, km/h, 2026/10/27, TCP/IP'), []);
  assert.deepEqual(paths('https://github.com/a/b/blob/main/src/a.ts и github.com/a/b.md'), []);
  assert.deepEqual(paths('GET /api/runs и /tmp'), []);
  assert.deepEqual(paths('README.md, Node.js, example.com'), []);
});

test('пути: из JSON в логе и рядом со скобками и кавычками', () => {
  assert.deepEqual(paths('▸ Read {"file_path":"/Users/a/p/src/a.ts","limit":50}'), ['/Users/a/p/src/a.ts']);
  assert.deepEqual(paths('(src/a.ts) «src/b.ts» `src/c.ts`'), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(splitPaths('[impl] открыл src/a.ts, дальше'), ['[impl] открыл ', { path: 'src/a.ts' }, ', дальше']);
  assert.deepEqual(splitPaths('без путей'), ['без путей']);
});

test('пути: длинные серии точек, двоеточий и «/» разбираются за линейное время', () => {
  for (const s of ['/a/' + '.'.repeat(40_000) + 'x', 'a/' + ':1'.repeat(20_000), '/'.repeat(40_000) + 'a.md', 'a/'.repeat(20_000)]) {
    const t0 = performance.now();
    findPaths(s);
    assert.ok(performance.now() - t0 < 200, `${s.slice(0, 10)}…`);
  }
});

test('пути: голое имя — только с bare (код и ссылки)', () => {
  assert.equal(isPath('README.md'), false);
  assert.equal(isPath('README.md', true), true);
  assert.equal(isPath('.env', true), true);
  assert.equal(isPath('npm run build', true), false);
  assert.equal(isPath('..', true), false);
  assert.equal(isPath('src/a.ts:42', true), true);
});

const link = (p: string, html = p) => `<a class="path-link" data-path="${p}" role="link" tabindex="0">${html}</a>`;

test('пути в markdown: в тексте, в `коде`, в ссылке [..](..); в блоке кода и в подписи ссылки — текстом', () => {
  assert.equal(renderMarkdown('Правка в src/a.ts:42.'), `<p>Правка в ${link('src/a.ts:42')}.</p>`);
  assert.equal(renderMarkdown('Файл `README.md`'), `<p>Файл <code>${link('README.md')}</code></p>`);
  assert.equal(renderMarkdown('[md.ts](web/src/lib/md.ts:42)'), `<p>${link('web/src/lib/md.ts:42', 'md.ts')}</p>`);
  assert.equal(renderMarkdown('**src/a.ts**'), `<p><strong>${link('src/a.ts')}</strong></p>`);
  assert.equal(renderMarkdown('```\ncat src/a.ts\n```'), '<pre><code>cat src/a.ts</code></pre>');
  assert.equal(renderMarkdown('[`a.ts`](src/a.ts)'), `<p>${link('src/a.ts', '<code>a.ts</code>')}</p>`);
  // ссылка на путь не получает href: javascript: и подобное в неё не попадут
  assert.ok(!renderMarkdown('[x](src/a.ts)').includes('href'));
});

test('пути в markdown: адрес ссылкой остаётся адресом, кавычка из data-path не выходит', () => {
  const out = renderMarkdown('https://x.com/a/b.md и /Users/a/"onclick="x/b.md');
  assert.ok(out.includes('<a href="https://x.com/a/b.md"'), out);
  assert.ok(!out.includes('data-path="https'), out);
  assert.ok(!/data-path="[^"]*"onclick/.test(out), out);
  assert.equal(linkifyText('в ~/proj/a.md & https://a.b'), `в ${link('~/proj/a.md')} &amp; <a href="https://a.b" target="_blank" rel="noopener noreferrer">https://a.b</a>`);
});
