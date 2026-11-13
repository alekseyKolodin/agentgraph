import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tag } from '@server/api-types';
import {
  filterTags, newTagBody, tagDeleteText, tagFocusCount, tagFocusField, tagFocusLabel, tagFormOf, tagMetaLine, tagNotesHint, tagPatch, tagPreview, tagSnapshot, tagsNoneText,
} from './tags';

const item = (slug: string, title = '', preview = '') => ({ slug, title, preview, kind: 'knowledge' as const, updatedAt: '', runs: 0 });
const tag = (over: Partial<Tag> = {}): Tag => ({
  slug: 'qa', kind: 'knowledge', title: 'QA', createdAt: '', updatedAt: '', runs: [], summary: '', notes: 'N', attachments: [], dirs: ['/a', '/b'], ...over,
});

test('теги: поиск — каждое слово в слаге, заголовке или превью, без учёта регистра; счётчик «N из M»', () => {
  const list = [item('qa-rules', 'Правила QA', 'граничные значения'), item('frontend', 'Фронт', 'компоненты и Граничные')];
  assert.deepEqual(filterTags(list, '').shown, list);
  assert.equal(filterTags(list, '').count, '2');
  assert.equal(filterTags([], '').count, '');
  const r = filterTags(list, '  ГРАНИЧНЫЕ  qa ');
  assert.deepEqual(r.shown.map((t) => t.slug), ['qa-rules']);
  assert.equal(r.count, '1 из 2');
  assert.equal(filterTags(list, 'граничные').count, '2 из 2');
  assert.equal(filterTags(list, 'нет-такого').count, '0 из 2');
});

test('теги: строка списка — первая строка превью или «заметок ещё нет», мета — вид и время', () => {
  assert.equal(tagPreview({ preview: 'раз\nдва' }), 'раз');
  assert.equal(tagPreview({ preview: '' }), 'заметок ещё нет');
  assert.match(tagMetaLine({ updatedAt: '2026-10-24T10:00:00Z' }), /^знания · .+$/);
  assert.equal(tagsNoneText(0), 'Тегов знаний пока нет — заведи первый выше');
  assert.equal(tagsNoneText(2), 'Ничего не нашлось');
  assert.match(tagDeleteText('qa'), /Удалить тег знаний qa/);
});

test('теги: снимок формы — заголовок, заметки, пути, описание и режим «целиком»', () => {
  const f = tagFormOf(tag());
  assert.deepEqual(f, { title: 'QA', notes: 'N', dirs: '/a\n/b', description: '', inline: false });
  assert.notEqual(tagSnapshot(f), tagSnapshot({ ...f, notes: 'X' }));
  assert.notEqual(tagSnapshot(f), tagSnapshot({ ...f, description: 'когда QA' }));
  assert.notEqual(tagSnapshot(f), tagSnapshot({ ...f, inline: true }));
  assert.deepEqual(tagFormOf(tag({ title: undefined, dirs: undefined })), { title: '', notes: 'N', dirs: '', description: '', inline: false });
  assert.equal(tagFormOf(tag({ description: 'Правила QA', inline: true })).description, 'Правила QA');
  assert.equal(tagFormOf(tag({ inline: true })).inline, true);
});

test('теги: патч — только изменённые поля; пути без пустых строк и пробелов', () => {
  const t = tag();
  assert.deepEqual(tagPatch(tagFormOf(t), t), {});
  assert.deepEqual(tagPatch({ ...tagFormOf(t), notes: 'N2' }, t), { notes: 'N2' });
  assert.deepEqual(tagPatch({ ...tagFormOf(t), dirs: ' /a \n\n/b\n' }, t), {});
  assert.deepEqual(tagPatch({ ...tagFormOf(t), dirs: '/a\n/c' }, t), { dirs: ['/a', '/c'] });
  assert.deepEqual(tagPatch({ ...tagFormOf(t), dirs: '' }, t), { dirs: [] });
  assert.deepEqual(tagPatch({ ...tagFormOf(t), title: '' }, t), { title: '' });
  assert.deepEqual(tagPatch({ ...tagFormOf(t), description: ' когда QA ', inline: true }, t), { description: 'когда QA', inline: true });
  assert.deepEqual(tagPatch({ ...tagFormOf(t), description: '' }, tag({ description: 'старое' })), { description: '' });
  assert.deepEqual(tagPatch({ ...tagFormOf(t), inline: false }, tag({ inline: true })), { inline: false });
  assert.match(tagNotesHint(false), /knowledge_read/);
  assert.match(tagNotesHint(true), /целиком/);
});

test('теги: новый тег — без пустого слага, заголовок по желанию', () => {
  assert.equal(newTagBody('  ', 'x'), null);
  assert.deepEqual(newTagBody(' a ', '  '), { slug: 'a' });
  assert.deepEqual(newTagBody('a', ' Заголовок '), { slug: 'a', title: 'Заголовок' });
});

test('теги: крупный редактор — подпись, счётчик и поле после открытия', () => {
  assert.equal(tagFocusLabel('dirs'), 'Пути');
  assert.equal(tagFocusLabel('notes'), 'Знание (текст для этапов)');
  assert.equal(tagFocusCount(''), 'строк: 0 · знаков: 0');
  assert.equal(tagFocusCount('ab\nc'), 'строк: 2 · знаков: 4');
  assert.equal(tagFocusField(undefined), 'notes');
  assert.equal(tagFocusField('dirs'), 'dirs');
});
