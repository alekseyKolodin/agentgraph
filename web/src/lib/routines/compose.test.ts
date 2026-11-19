import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectNeedHref, draftTouched, packDraft, pickNewFlow, unpackDraft } from './compose.js';
import { emptyDraft } from './spec.js';

test('черновик формы: что ушло на сервер, то и вернулось; название и список flow — вместе с ним', () => {
  const d = { ...emptyDraft(), title: 'Ревью', flow: 'review-mr', check: 'ревью мне' };
  const back = unpackDraft(JSON.parse(JSON.stringify(packDraft(d, true, ['a', 'b']))));
  assert.deepEqual(back, { v: 1, d, titleEdited: true, flowsBefore: ['a', 'b'] });
  assert.equal(unpackDraft(JSON.parse(JSON.stringify(packDraft(d, false))))?.flowsBefore, undefined);
});

test('черновик формы: чужой формат и мусор — не черновик; поля, которых не было в старой форме, берутся из пустой', () => {
  assert.equal(unpackDraft(null), undefined);
  assert.equal(unpackDraft('текст'), undefined);
  assert.equal(unpackDraft({ v: 2, d: emptyDraft() }), undefined);
  assert.equal(unpackDraft({ v: 1, d: { title: 5, conds: [] } }), undefined);
  assert.equal(unpackDraft({ v: 1, d: { title: 'x' } }), undefined);
  // черновик, сохранённый до появления узла «ИИ рутины» в форме: настройки узла — по умолчанию
  const old = unpackDraft({ v: 1, d: { title: 'Старый', conds: [], source: 'slack', flow: 'fix' }, titleEdited: true });
  assert.deepEqual([old?.d.source, old?.d.flow, old?.d.checkModel, old?.d.checkAsk, old?.d.mode], ['slack', 'fix', '', true, 'suggest']);
});

test('пустую форму на сервер не пишем; выбранный источник, flow или название — уже черновик', () => {
  assert.equal(draftTouched(emptyDraft()), false);
  assert.equal(draftTouched({ ...emptyDraft(), title: '  ' }), false);
  assert.equal(draftTouched({ ...emptyDraft(), title: 'Ревью' }), true);
  assert.equal(draftTouched({ ...emptyDraft(), source: 'slack' }), true);
  assert.equal(draftTouched({ ...emptyDraft(), input: 'сделай ревью' }), true);
});

test('по возврате со сборки flow: единственный новый flow находится сам; несколько новых или ни одного — не угадываем', () => {
  assert.equal(pickNewFlow(['a', 'b'], ['a', 'b', 'mr-review']), 'mr-review');
  assert.equal(pickNewFlow(['a', 'b'], ['a', 'b']), undefined);
  assert.equal(pickNewFlow(['a'], ['a', 'x', 'y']), undefined);
  // человек не уходил собирать flow — подставлять нечего
  assert.equal(pickNewFlow(undefined, ['a', 'b']), undefined);
});

test('ссылка на подключение: готовый вид — kind, иначе описание словами в q', () => {
  assert.equal(connectNeedHref({ description: 'сообщения', kind: 'slack' }), '/routines/connect?from=new&kind=slack');
  const u = new URL(connectNeedHref({ description: 'записи встреч в Fireflies' }), 'http://x');
  assert.equal(u.searchParams.get('q'), 'записи встреч в Fireflies');
  assert.equal(u.searchParams.get('kind'), null);
  assert.equal(u.searchParams.get('from'), 'new');
});
