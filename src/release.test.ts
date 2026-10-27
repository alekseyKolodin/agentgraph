import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANGELOG_HEADER, RELEASE_SUBJECT, RELEASE_SUBJECT_RE, bumpVersion, changelogSection, groupCommits, prependSection } from './release.js';

test('релиз: bumpVersion — major обнуляет minor и patch, minor обнуляет patch', () => {
  assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(bumpVersion('0.1.7', 'minor'), '0.2.0');
  assert.equal(bumpVersion('1.9.3', 'major'), '2.0.0');
  assert.equal(bumpVersion('0.9.0', 'minor'), '0.10.0');
});

test('релиз: bumpVersion — не X.Y.Z (пререлиз, мусор) отклоняется', () => {
  assert.throws(() => bumpVersion('1.0.0-beta.1', 'patch'), /X\.Y\.Z/);
  assert.throws(() => bumpVersion('v1.0.0', 'patch'), /X\.Y\.Z/);
});

test('релиз: groupCommits — feat и fix по группам, scope остаётся префиксом, прочее отброшено', () => {
  const groups = groupCommits([
    'feat: имя запуска от модели',
    'fix(ui): init() after DOMContentLoaded',
    'chore: обновить зависимости',
    'docs: README',
    'feat!: ломающее изменение',
    'Перенести справочник в docs/REFERENCE.md',
    'chore(release): v0.2.0',
  ]);
  assert.deepEqual(groups, [
    { title: 'Features', items: ['имя запуска от модели', 'ломающее изменение'] },
    { title: 'Fixes', items: ['ui: init() after DOMContentLoaded'] },
  ]);
});

test('релиз: changelogSection — нет feat/fix — null, иначе заголовок версии с датой и группы', () => {
  assert.equal(changelogSection('0.2.0', '2026-10-20', ['chore: x', 'docs: y']), null);
  assert.equal(
    changelogSection('0.2.0', '2026-10-20', ['fix: б', 'feat: а']),
    '## 0.2.0 — 2026-10-20\n\n### Features\n\n- а\n\n### Fixes\n\n- б\n',
  );
});

test('релиз: prependSection — пустой файл получает шапку, новый раздел встаёт над прошлыми', () => {
  const first = prependSection('', '## 0.2.0 — 2026-10-20\n\n### Features\n\n- а\n');
  assert.equal(first, `${CHANGELOG_HEADER}\n## 0.2.0 — 2026-10-20\n\n### Features\n\n- а\n`);
  const second = prependSection(first, '## 0.3.0 — 2026-11-01\n\n### Fixes\n\n- б\n');
  assert.ok(second.startsWith(CHANGELOG_HEADER));
  assert.ok(second.indexOf('## 0.3.0') < second.indexOf('## 0.2.0'));
  assert.ok(second.includes('- б\n\n## 0.2.0'), second);
});

test('релиз: заголовок коммита релиза узнаётся своим же RE', () => {
  assert.match(RELEASE_SUBJECT('1.2.3'), RELEASE_SUBJECT_RE);
  assert.doesNotMatch('chore(release): v1.2', RELEASE_SUBJECT_RE);
});
