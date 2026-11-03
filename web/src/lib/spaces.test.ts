import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Space, SpaceRun, SpaceSession } from '@server/api-types';
import {
  dirLines, docLine, docSize, filterSpaces, itemsCount, newSpaceBody, spaceFieldNote, spaceFormOf, spaceItems, spaceLabel, spaceMetaLine, spaceOptionLabel, spacePatch,
  spacePreview, spacesNoneText, spaceSnapshot, stateByText, updateLine,
} from './spaces';

const item = (slug: string, title = '', preview = '') => ({ slug, title, preview, updatedAt: '', docs: 0, hasMap: false });
const space = (over: Partial<Space> = {}): Space => ({
  slug: 'press-alert', title: 'Пуш', dir: '/cfg/spaces/press-alert', map: '# Пуш\n', mapMtimeMs: 10, state: 'Суть\n', stateMtimeMs: 20, docs: [], history: [],
  createdAt: '', updatedAt: '', dirs: ['/a', '/b'], ...over,
});

test('пространства: поиск по слагу, заголовку и превью; счётчик «N из M»; подписи', () => {
  const list = [item('press-alert', 'Пуш-тревога', 'уведомления'), item('kai-mvp', 'Kai', 'MVP и CI')];
  assert.equal(filterSpaces(list, '').count, '2');
  assert.equal(filterSpaces([], '').count, '');
  assert.deepEqual(filterSpaces(list, 'ТРЕВОГА').shown.map((s) => s.slug), ['press-alert']);
  assert.equal(filterSpaces(list, 'ci').count, '1 из 2');
  assert.equal(spaceLabel({ slug: 'a', title: '' }), 'a');
  assert.equal(spaceLabel({ slug: 'a', title: 'А' }), 'А');
  assert.equal(spacePreview({ preview: 'раз\nдва' }), 'раз');
  assert.equal(spacePreview({ preview: '' }), 'состояния ещё нет');
  assert.equal(spaceOptionLabel(item('a', 'А', 'суть\nещё')), 'А · суть');
  assert.equal(spaceOptionLabel(item('a')), 'пространство без карты и состояния');
  assert.match(spaceMetaLine({ hasMap: true, docs: 3, updatedAt: '2026-10-24T10:00:00Z' }), /^карта · документов: 3 · .+/);
  assert.equal(spacesNoneText(0), 'Пространств пока нет — заведи первое выше');
  assert.equal(spacesNoneText(1), 'Ничего не нашлось');
});

test('пространства: документы и история — размеры, заголовок, кто обновил', () => {
  assert.equal(docSize(512), '512 Б');
  assert.equal(docSize(4096), '4 КБ');
  assert.equal(docSize(3 * 1024 * 1024), '3.0 МБ');
  assert.equal(docLine({ name: 'spec.md', size: 2048, mtimeMs: 0, text: true, title: 'Спека' }), 'Спека · 2 КБ');
  assert.equal(docLine({ name: 'a.png', size: 10, mtimeMs: 0, text: false }), '10 Б');
  assert.equal(updateLine({ id: 'r1', at: '', kind: 'run', flow: 'feature' }), 'запуск feature');
  assert.equal(updateLine({ id: 'abcdef123', at: '', kind: 'session' }), 'сессия «abcdef12»');
  assert.match(stateByText(space({ history: [{ id: 's', at: '', kind: 'session', title: 'Kai' }] })), /^Обновил: сессия «Kai»/);
  assert.equal(stateByText(space()), 'Состояние правили только руками');
  assert.match(stateByText(space({ state: '' })), /запишет короткая сессия/);
});

test('пространства: сессии и запуски одним списком — живые сверху, потом свежие; счётчик', () => {
  const s = (id: string, live: boolean, at: string): SpaceSession => ({ id, name: id, status: live ? 'working' : 'ended', live, cwd: '/p', lastActivityAt: at, turns: 0 });
  const r = (id: string, status: string, at: string): SpaceRun => ({ id, flow: 'f', status, startedAt: at, input: '' });
  const items = spaceItems([s('old', false, '2026-01-01'), s('now', true, '2025-01-01')], [r('r1', 'done', '2026-02-01'), r('r2', 'running', '2025-06-01')]);
  assert.deepEqual(items.map((i) => (i.kind === 'session' ? i.s.id : i.r.id)), ['r2', 'now', 'r1', 'old']);
  assert.equal(itemsCount(2, 5), '2 сессии · 5 запусков');
  assert.equal(itemsCount(1, 0), '1 сессия');
  assert.equal(itemsCount(0, 0), '');
});

test('пространства: форма — снимок без хвостовых переводов строки, патч только изменённого и с базой mtimeMs', () => {
  const s = space();
  const f = spaceFormOf(s);
  assert.deepEqual(f, { title: 'Пуш', map: '# Пуш\n', state: 'Суть\n', dirs: '/a\n/b' });
  assert.equal(spaceSnapshot(f), spaceSnapshot({ ...f, map: '# Пуш', dirs: ' /a \n\n/b' }));
  assert.notEqual(spaceSnapshot(f), spaceSnapshot({ ...f, map: '# Другое' }));
  assert.deepEqual(spacePatch(f, s), {});
  assert.deepEqual(spacePatch({ ...f, map: '# Новая' }, s), { map: '# Новая', mapBase: 10 });
  assert.deepEqual(spacePatch({ ...f, state: 'Другое' }, space({ stateMtimeMs: undefined })), { state: 'Другое', stateBase: 0 });
  assert.deepEqual(spacePatch({ ...f, title: ' Новый ', dirs: '/a' }, s), { title: 'Новый', dirs: ['/a'] });
  assert.deepEqual(dirLines(' /x \n\n /y'), ['/x', '/y']);
  assert.equal(newSpaceBody('  ', 'x', '', ''), null);
  assert.deepEqual(newSpaceBody(' p ', ' П ', ' суть ', '/a\n'), { slug: 'p', title: 'П', gist: 'суть', dirs: ['/a'] });
  assert.deepEqual(newSpaceBody('p', '', '', ''), { slug: 'p' });
});

test('поле пространства: пусто — без пространства, неверный слаг — ошибка, новый — заведётся, существующий — что даст', () => {
  const options = [{ ...item('press-alert', 'Пуш', 'Суть'), hasMap: true, docs: 2 }];
  assert.equal(spaceFieldNote('', options).text, 'Без пространства: только папка и теги знаний');
  assert.equal(spaceFieldNote('Bad Slug', options).tone, 'err');
  assert.match(spaceFieldNote('new-one', options).text, /^new-one: новое пространство — заведётся пустым/);
  assert.equal(spaceFieldNote(' press-alert ', options).text, 'Пуш: карта — памятью · документов: 2 · состояние — в контексте');
});
