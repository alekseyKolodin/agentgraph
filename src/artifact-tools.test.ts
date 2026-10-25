import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapPage, readSection, READ_PART_MAX, searchArtifact } from './artifact-tools.js';
import { artifactMap, sliceLines, type ArtifactSource } from './artifacts.js';

function withFiles(files: Record<string, string>, fn: (sources: ArtifactSource[], dir: string) => void) {
  return () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-tools-')));
    try {
      const sources = Object.entries(files).map(([file, text]) => {
        fs.writeFileSync(path.join(dir, file), text);
        const key = file.replace(/\.[a-z]+$/, '');
        return { key, title: key.toUpperCase(), path: path.join(dir, file), file };
      });
      fn(sources, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const PLAN = Array.from({ length: 30 }, (_, i) => `## Шаг ${i + 1}\nО шаге ${i + 1}.\n${i === 17 ? 'Здесь миграция базы.\n' : ''}- пункт\n`).join('');

test('K2: artifact_read по ключу раздела из карты — текст раздела байт в байт', withFiles({ 'plan.md': PLAN }, (src) => {
  for (const sec of artifactMap(PLAN, { title: 'P', path: src[0].path, file: 'plan.md' }).sections) {
    const out = readSection(src, 'plan', sec.key);
    const [head, ...body] = out.split('\n');
    assert.match(head, new RegExp(`^Раздел «${sec.key}» артефакта «PLAN» — строки ${sec.from}–${sec.to}:$`));
    assert.equal(body.join('\n'), sliceLines(PLAN, sec.from, sec.to));
  }
}));

test('K3: неизвестный раздел или чужой артефакт — ошибка с перечнем допустимых ключей, файлы не изменены', withFiles({ 'plan.md': PLAN }, (src) => {
  assert.throws(() => readSection(src, 'plan', 'Нет такого'), /нет раздела «Нет такого»\. Разделы: «Шаг 1», «Шаг 2»/);
  assert.throws(() => readSection(src, 'notes', 'Шаг 1'), /Артефакта notes у этапа нет\. Доступны: plan/);
  assert.throws(() => readSection(src, '../run', 'x'), /Доступны: plan/);
  assert.throws(() => mapPage(src, 'constructor'), /Доступны: plan/);
  assert.equal(fs.readFileSync(src[0].path, 'utf8'), PLAN);
}));

test('K4: artifact_search — раздел и номер строки совпадения, без учёта регистра', withFiles({ 'plan.md': PLAN }, (src) => {
  const out = searchArtifact(src, 'plan', 'МИГРАЦИЯ');
  const line = PLAN.split('\n').findIndex((l) => l.includes('миграция')) + 1;
  assert.equal(out, `«МИГРАЦИЯ» в артефакте «PLAN»: совпадений 1.\n- строка ${line}, раздел «Шаг 18»: Здесь миграция базы.`);
  assert.equal(searchArtifact(src, 'plan', 'нет-такого'), 'В артефакте «PLAN» нет «нет-такого».');
  assert.throws(() => searchArtifact(src, 'plan', '  '), /Пустой запрос/);
}));

test('artifact_map: полная карта без сворачивания, постранично; маленький файл — тоже по разделам', withFiles({ 'big.md': Array.from({ length: 400 }, (_, i) => `## Р${i + 1}\nтекст ${i + 1}\n`).join(''), 'small.md': '# Один\na\n# Два\nb\n' }, (src) => {
  const p1 = mapPage(src, 'big');
  assert.match(p1, /^Карта артефакта «BIG» — .*\nВсе разделы: ключ, строки, размер, о чём он\. Раздел целиком: инструментом artifact_read/);
  assert.match(p1, /\nСтраница 1 из 3: следующая — artifact_map\(key: "big", page: 2\)\.\n- Р1 — строки 1–2 \(2\)/);
  assert.equal(p1.split('\n').filter((l) => l.startsWith('- ')).length, 150);
  assert.match(mapPage(src, 'big', 3), /\nСтраница 3 из 3\.\n- Р301 — /);
  assert.throws(() => mapPage(src, 'big', 4), /Страницы 4 нет: всего 3/);
  assert.match(mapPage(src, 'small'), /\n- Один — строки 1–2 \(2\), 13 Б: a\n- Два — строки 3–4 \(2\), 11 Б: b$/);
}));

test('artifact_read: раздел больше 64 КБ — по частям по границам строк, части вместе дают раздел', withFiles({ 'log.md': '' }, (src) => {
  const huge = `# Один раздел\n${`${'я'.repeat(300)}\n`.repeat(150)}`;
  fs.writeFileSync(src[0].path, huge);
  const sections = artifactMap(huge, { title: 'L', path: src[0].path, file: 'log.md' }).sections;
  assert.deepEqual(sections.map((x) => [x.key, x.from, x.to]), [['Один раздел · часть 1', 1, 151]]);
  const first = readSection(src, 'log', sections[0].key);
  const second = readSection(src, 'log', sections[0].key, 2);
  assert.match(first.split('\n')[0], /^Раздел «Один раздел · часть 1» артефакта «LOG» — строки 1–\d+, часть 1 из 2:$/);
  assert.match(second.split('\n')[0], /, часть 2 из 2:$/);
  const body = (x: string) => x.slice(x.indexOf('\n') + 1);
  assert.ok(Buffer.byteLength(body(first)) <= READ_PART_MAX);
  assert.equal(body(first) + body(second), huge);
  assert.throws(() => readSection(src, 'log', sections[0].key, 3), /Части 3 нет: всего 2/);
}));

test('инструмент не идёт по ссылке и не читает не обычный файл', withFiles({ 'plan.md': PLAN }, (src, dir) => {
  fs.writeFileSync(path.join(dir, 'secret.md'), 'секрет');
  fs.rmSync(src[0].path);
  fs.symlinkSync(path.join(dir, 'secret.md'), src[0].path);
  assert.throws(() => mapPage(src, 'plan'), /сейчас нет/);
}));
