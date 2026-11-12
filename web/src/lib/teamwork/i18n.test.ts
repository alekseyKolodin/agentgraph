// Перевод Teamwork: у каждого текста интерфейса из web/src/screens/teamwork/ и web/src/lib/teamwork/ есть английский
// (spec §11). Ключи собираются из исходников: t('…'), t('…', vars, 'ctx') → «…#ctx» или «…», plural(n, 'a', 'b', 'c') →
// «a|b|c», t(MAP[x]) — значения объекта MAP того же файла (подписи статусов, вкладок, черновиков) и t(переменная) из списка
// VARS — русские строки названной константы. Любой другой t(переменная), t(`…`) или t("…") роняет тест: его ключ не проверить.
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

/** t(переменная), чьи значения берутся из константы того же файла: файл → переменная → константа. */
const VARS: Record<string, Record<string, string>> = { 'screens/teamwork/TeamsScreen.tsx': { desc: 'TREE' } };

/** Русские строковые литералы объявления const NAME = { … } или [ … ] (у объекта — только значения). */
function constStrings(text: string, name: string): string[] {
  const decl = text.match(new RegExp(String.raw`const ${name}\b[^=]*=\s*([\{\[])([\s\S]*?)[\}\]];`));
  assert.ok(decl, `объявление ${name} не найдено`);
  const lit = decl[1] === '{' ? new RegExp(String.raw`:\s*${LIT}`, 'g') : new RegExp(LIT, 'g');
  return [...decl[2]!.matchAll(lit)].map((v) => unescape(v[1]!)).filter((x) => /[А-Яа-яЁё]/.test(x));
}

/** Ключи словаря, нужные файлу: [ключ, запасной ключ без контекста]. vars — t(переменная) этого файла и их константы. */
function keysOf(text: string, vars: Record<string, string> = {}): [string, string?][] {
  const out: [string, string?][] = [];
  const call = new RegExp(String.raw`\bt\(\s*${LIT}\s*(?:,\s*(?:undefined|\{[^{}()]*\}|[\w.]+)\s*,\s*'([\w-]+)'\s*)?\)?`, 'g');
  for (const m of text.matchAll(call)) out.push(m[2] ? [`${unescape(m[1]!)}#${m[2]}`, unescape(m[1]!)] : [unescape(m[1]!)]);
  const pl = new RegExp(String.raw`\bplural\([^,()]+,\s*${LIT}\s*,\s*${LIT}\s*,\s*${LIT}\s*\)`, 'g');
  for (const m of text.matchAll(pl)) out.push([[m[1], m[2], m[3]].map((x) => unescape(x!)).join('|')]);
  // t(MAP[x]): значения объекта const MAP = { … } этого файла
  for (const m of text.matchAll(/\bt\(\s*([A-Z][A-Z0-9_]*)\[/g)) for (const v of constStrings(text, m[1]!)) out.push([v]);
  for (const name of Object.values(vars)) for (const v of constStrings(text, name)) out.push([v]);
  return out;
}

/** Вызовы t(), ключ которых не проверить: переменная (кроме vars), шаблонная строка, двойные кавычки. Регулярки вида /t(\d+)/ не в счёт. */
function uncheckable(text: string, vars: Record<string, string> = {}): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w.$])t\(\s*(`|"|[a-z_$][\w$.]*(?=\s*[),]))/g)) if (!Object.hasOwn(vars, m[1]!)) out.push(`t(${m[1]}`);
  return out;
}

test('сборщик ключей: t с переменными и контекстом, plural, подписи из объекта и списка, непроверяемые вызовы', () => {
  const src = `
    const LABEL: Record<string, string> = { a: 'Один', b: 'Два' };
    const LIST: [string, string][] = [['file.md', 'описание'], ['x', '']];
    t('Привет, {name}', { name }); t('Команда', undefined, 'team'); t('С \\'кавычкой\\'');
    plural(n, 'задача', 'задачи', 'задач'); t(LABEL[k]); t(desc);`;
  assert.deepEqual(keysOf(src, { desc: 'LIST' }), [
    ['Привет, {name}'], ['Команда#team', 'Команда'], ["С 'кавычкой'"], ['задача|задачи|задач'], ['Один'], ['Два'], ['описание'],
  ]);
  assert.deepEqual(uncheckable(src, { desc: 'LIST' }), []);
  assert.deepEqual(uncheckable('t(label); t(`x`); t("y"); s.replace(/^t(\\d+)$/, ""); at(x); t(x.y, 1)'), ['t(label', 't(`', 't("', 't(x.y']);
});

test('у каждого текста Teamwork есть английский перевод, и каждый ключ t() можно проверить', () => {
  const missing: string[] = [];
  for (const { file, text } of sources()) {
    const vars = VARS[file] ?? {};
    for (const call of uncheckable(text, vars)) missing.push(`${file}: ${call} — ключ не литерал, добавьте его константу в VARS`);
    for (const [key, plain] of keysOf(text, vars)) {
      if (EN[key] === undefined && (plain === undefined || EN[plain] === undefined)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
