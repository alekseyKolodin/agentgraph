// Перевод Teamwork: у каждого текста интерфейса из web/src/screens/teamwork/ и web/src/lib/teamwork/ есть английский
// (spec §11). Ключи собираются из исходников: t('…'), t('…', vars, 'ctx') → «…#ctx» или «…», plural(n, 'a', 'b', 'c') →
// «a|b|c», и t(MAP[x]) — значения объекта MAP того же файла (подписи статусов, вкладок, черновиков).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EN } from '../../i18n/en';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIRS = ['screens/teamwork', 'lib/teamwork'];

function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.ts$/.test(e.name) && e.name !== 'fixtures.ts') out.push({ file: path.relative(SRC, p), text: fs.readFileSync(p, 'utf8') });
    }
  };
  for (const d of DIRS) walk(path.join(SRC, d));
  return out;
}

/** Строковый литерал в одинарных кавычках: текст с раскрытыми \' и \\. */
const LIT = String.raw`'((?:\\.|[^'\\])*)'`;
const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));

/** Ключи словаря, нужные файлу: [ключ, запасной ключ без контекста]. */
function keysOf(text: string): [string, string?][] {
  const out: [string, string?][] = [];
  const call = new RegExp(String.raw`\bt\(\s*${LIT}\s*(?:,\s*(?:undefined|\{[^{}()]*\}|[\w.]+)\s*,\s*'([\w-]+)'\s*)?\)?`, 'g');
  for (const m of text.matchAll(call)) out.push(m[2] ? [`${unescape(m[1]!)}#${m[2]}`, unescape(m[1]!)] : [unescape(m[1]!)]);
  const pl = new RegExp(String.raw`\bplural\([^,()]+,\s*${LIT}\s*,\s*${LIT}\s*,\s*${LIT}\s*\)`, 'g');
  for (const m of text.matchAll(pl)) out.push([[m[1], m[2], m[3]].map((x) => unescape(x!)).join('|')]);
  // t(MAP[x]): значения объекта const MAP = { … } этого файла
  for (const m of text.matchAll(/\bt\(\s*([A-Z][A-Z0-9_]*)\[/g)) {
    const decl = text.match(new RegExp(String.raw`const ${m[1]}\b[^=]*=\s*\{([\s\S]*?)\};`));
    assert.ok(decl, `t(${m[1]}[…]): объявление ${m[1]} не найдено`);
    for (const v of decl[1]!.matchAll(new RegExp(String.raw`:\s*${LIT}`, 'g'))) out.push([unescape(v[1]!)]);
  }
  return out;
}

test('сборщик ключей: t с переменными и контекстом, plural, подписи из объекта', () => {
  const src = `
    const LABEL: Record<string, string> = { a: 'Один', b: 'Два' };
    t('Привет, {name}', { name }); t('Команда', undefined, 'team'); t('С \\'кавычкой\\'');
    plural(n, 'задача', 'задачи', 'задач'); t(LABEL[k]);`;
  assert.deepEqual(keysOf(src), [['Привет, {name}'], ['Команда#team', 'Команда'], ["С 'кавычкой'"], ['задача|задачи|задач'], ['Один'], ['Два']]);
});

test('у каждого текста Teamwork есть английский перевод', () => {
  const missing: string[] = [];
  for (const { file, text } of sources()) {
    for (const [key, plain] of keysOf(text)) {
      if (EN[key] === undefined && (plain === undefined || EN[plain] === undefined)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
