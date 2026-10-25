import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tag } from '@server/api-types';
import {
  filterTags, newTagBody, tagFocusCount, tagFocusField, tagFocusLabel, tagFormOf, tagMetaLine, tagNotesHint, tagPatch, tagPreview, tagSnapshot, tagsNoneText,
} from './tags';

const item = (slug: string, title = '', preview = '') => ({ slug, title, preview, kind: 'task' as const, updatedAt: '', runs: 0 });
const tag = (over: Partial<Tag> = {}): Tag => ({
  slug: 'loyalty', kind: 'task', title: 'Карта', createdAt: '', updatedAt: '', runs: [], summary: 'S', notes: 'N', attachments: [], dirs: ['/a', '/b'], ...over,
});

test('теги: поиск — каждое слово в слаге, заголовке или превью, без учёта регистра; счётчик «N из M»', () => {
  const list = [item('loyalty-card', 'Карта лояльности', 'бонусы'), item('checkout', 'Оплата', 'корзина и Бонусы')];
  assert.deepEqual(filterTags(list, '').shown, list);
  assert.equal(filterTags(list, '').count, '2');
  assert.equal(filterTags([], '').count, '');
  const r = filterTags(list, '  БОНУСЫ  карта ');
  assert.deepEqual(r.shown.map((t) => t.slug), ['loyalty-card']);
  assert.equal(r.count, '1 из 2');
  assert.equal(filterTags(list, 'бонусы').count, '2 из 2');
  assert.equal(filterTags(list, 'нет-такого').count, '0 из 2');
});

test('теги: строка списка — первая строка превью, заглушка по виду, мета без запусков у тега знаний', () => {
  assert.equal(tagPreview({ kind: 'task', preview: 'раз\nдва' }), 'раз');
  assert.equal(tagPreview({ kind: 'task', preview: '' }), 'саммари ещё нет');
  assert.equal(tagPreview({ kind: 'knowledge', preview: '' }), 'заметок ещё нет');
  assert.match(tagMetaLine({ kind: 'task', updatedAt: '2026-10-24T10:00:00Z', runs: 3 }), /^задача · .+ · запусков: 3$/);
  assert.match(tagMetaLine({ kind: 'knowledge', updatedAt: '2026-10-24T10:00:00Z', runs: 3 }), /^область знаний · [^·]+$/);
  assert.equal(tagMetaLine({ kind: 'task', updatedAt: '', runs: 0 }), 'задача ·  · запусков: 0');
  assert.equal(tagsNoneText(0), 'Тегов пока нет — заведи первый выше');
  assert.equal(tagsNoneText(2), 'Ничего не нашлось');
});

test('теги: снимок формы — саммари тега знаний не считается, описание и режим «целиком» — только у него', () => {
  const f = tagFormOf(tag());
  assert.deepEqual(f, { title: 'Карта', summary: 'S', notes: 'N', dirs: '/a\n/b', description: '', inline: false });
  assert.notEqual(tagSnapshot(f, 'task'), tagSnapshot({ ...f, summary: 'X' }, 'task'));
  assert.equal(tagSnapshot(f, 'knowledge'), tagSnapshot({ ...f, summary: 'X' }, 'knowledge'));
  assert.notEqual(tagSnapshot(f, 'knowledge'), tagSnapshot({ ...f, notes: 'X' }, 'knowledge'));
  assert.notEqual(tagSnapshot(f, 'knowledge'), tagSnapshot({ ...f, description: 'когда QA' }, 'knowledge'));
  assert.notEqual(tagSnapshot(f, 'knowledge'), tagSnapshot({ ...f, inline: true }, 'knowledge'));
  assert.equal(tagSnapshot(f, 'task'), tagSnapshot({ ...f, description: 'x', inline: true }, 'task'));
  assert.deepEqual(tagFormOf(tag({ title: undefined, dirs: undefined })), { title: '', summary: 'S', notes: 'N', dirs: '', description: '', inline: false });
  assert.deepEqual(tagFormOf(tag({ kind: 'knowledge', description: 'Правила QA', inline: true })).description, 'Правила QA');
  assert.equal(tagFormOf(tag({ kind: 'knowledge', inline: true })).inline, true);
});

test('теги: патч — только изменённые поля; пути без пустых строк и пробелов; саммари тега знаний не уходит', () => {
  const t = tag();
  assert.deepEqual(tagPatch(tagFormOf(t), t), {});
  assert.deepEqual(tagPatch({ ...tagFormOf(t), notes: 'N2' }, t), { notes: 'N2' });
  assert.deepEqual(tagPatch({ ...tagFormOf(t), dirs: ' /a \n\n/b\n' }, t), {});
  assert.deepEqual(tagPatch({ ...tagFormOf(t), dirs: '/a\n/c' }, t), { dirs: ['/a', '/c'] });
  assert.deepEqual(tagPatch({ ...tagFormOf(t), dirs: '' }, t), { dirs: [] });
  assert.deepEqual(tagPatch({ title: '', summary: 'S2', notes: 'N', dirs: '/a\n/b', description: '', inline: false }, t), { title: '', summary: 'S2' });
  const k = tag({ kind: 'knowledge' });
  assert.deepEqual(tagPatch({ ...tagFormOf(k), summary: 'S2' }, k), {});
  // описание и режим «целиком» уходят только у тега знаний и только изменённые
  assert.deepEqual(tagPatch({ ...tagFormOf(k), description: ' когда QA ', inline: true }, k), { description: 'когда QA', inline: true });
  assert.deepEqual(tagPatch({ ...tagFormOf(k), description: '' }, tag({ kind: 'knowledge', description: 'старое' })), { description: '' });
  assert.deepEqual(tagPatch({ ...tagFormOf(k), inline: false }, tag({ kind: 'knowledge', inline: true })), { inline: false });
  assert.deepEqual(tagPatch({ ...tagFormOf(t), description: 'x', inline: true }, t), {});
  assert.match(tagNotesHint('knowledge', false), /knowledge_read/);
  assert.match(tagNotesHint('knowledge', true), /целиком/);
  assert.match(tagNotesHint('task', false), /задачу каждого запуска/);
});

test('теги: новый тег — без пустого слага, заголовок по желанию, вид знаний только при фиче', () => {
  assert.equal(newTagBody('  ', 'x', 'task', true), null);
  assert.deepEqual(newTagBody(' a ', '  ', 'task', true), { slug: 'a' });
  assert.deepEqual(newTagBody('a', ' Заголовок ', 'knowledge', true), { slug: 'a', title: 'Заголовок', kind: 'knowledge' });
  assert.deepEqual(newTagBody('a', '', 'knowledge', false), { slug: 'a' });
});

test('теги: крупный редактор — подпись, счётчик и поле после открытия', () => {
  assert.equal(tagFocusLabel('dirs', 'task'), 'Пути');
  assert.equal(tagFocusLabel('summary', 'task'), 'Саммари');
  assert.equal(tagFocusLabel('notes', 'task'), 'Заметки (промпт тега)');
  assert.equal(tagFocusLabel('notes', 'knowledge'), 'Знание (текст для этапов)');
  assert.equal(tagFocusCount(''), 'строк: 0 · знаков: 0');
  assert.equal(tagFocusCount('ab\nc'), 'строк: 2 · знаков: 4');
  assert.equal(tagFocusField(undefined, 'task'), 'summary');
  assert.equal(tagFocusField(undefined, 'knowledge'), 'notes');
  assert.equal(tagFocusField('dirs', 'task'), 'dirs');
  assert.equal(tagFocusField('summary', 'knowledge'), 'notes');
});
