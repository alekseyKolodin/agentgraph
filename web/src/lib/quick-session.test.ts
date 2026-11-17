import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpaceListItem } from '@server/api-types';
import { quickMeta, quickRows, setKey, togglePin } from './quick-session';

const space = (slug: string, o: Partial<SpaceListItem> = {}): SpaceListItem => ({ slug, updatedAt: '2026-01-01', preview: '', docs: 0, hasMap: false, hasState: false, ...o });

test('быстрая сессия: закреплённые первыми, потом пространства по свежей работе, папки сессий и недавние — без повторов', () => {
  const rows = quickRows({
    spaces: [
      space('old', { lastWorkAt: '2026-01-02', workdir: { path: '/code/old', from: 'space' } }),
      space('kai', { title: 'Kai', lastWorkAt: '2026-03-01', workdir: { path: '/code/android', from: 'session' }, dirs: ['/code/api', '/specs'], tags: ['kotlin'] }),
    ],
    sessions: [
      { space: 'kai', cwd: '/code/android', lastActivityAt: '2026-03-01' },
      { cwd: '/code/tool', lastActivityAt: '2026-02-01' },
      { space: 'gone', cwd: '/code/gone', lastActivityAt: '2026-02-02' },
    ],
    recent: [
      { path: '/code/tool', label: 'tool', exists: true },
      { path: '/code/x', label: 'x', exists: true },
      { path: '/code/missing', label: 'missing', exists: false },
    ],
    pins: [setKey('', '/code/x'), setKey('nope', '/a')],
    query: '',
  });
  assert.deepEqual(rows.map((r) => r.key), ['|/code/x', 'kai|/code/android', 'old|/code/old', '|/code/gone', '|/code/tool']);
  assert.equal(rows[0]!.pinned, true);
  assert.equal(rows[1]!.title, 'Kai');
  assert.equal(rows[1]!.dirs, 2);
  assert.deepEqual(rows[1]!.tags, ['kotlin']);
  // у пространства без рабочей папки и прошлой работы строка есть, но папки нет — откроет форму
  const bare = quickRows({ spaces: [space('new')], sessions: [], recent: [], pins: [], query: '' });
  assert.deepEqual(bare.map((r) => [r.key, r.cwd]), [['new|', '']]);
});

test('быстрая сессия: поиск по названию, слагу и пути; путь целиком — первой строкой', () => {
  const o = { spaces: [space('kai', { title: 'Мобилка', workdir: { path: '/code/android', from: 'space' as const } })], sessions: [], recent: [{ path: '/code/tool', label: 'tool', exists: true }], pins: [] };
  assert.deepEqual(quickRows({ ...o, query: 'моби' }).map((r) => r.key), ['kai|/code/android']);
  assert.deepEqual(quickRows({ ...o, query: 'android' }).map((r) => r.key), ['kai|/code/android']);
  const typed = quickRows({ ...o, query: '/code/new-app' });
  assert.equal(typed[0]!.from, 'path');
  assert.equal(typed[0]!.cwd, '/code/new-app');
  assert.equal(typed[0]!.title, 'new-app');
  // путь уже есть строкой — второй не нужен
  assert.deepEqual(quickRows({ ...o, query: '/code/tool' }).map((r) => r.from), ['recent']);
  assert.equal(quickRows({ ...o, query: 'нет такого' }).length, 0);
});

test('быстрая сессия: подпись набора и закрепление', () => {
  const tilde = (p: string) => p.replace('/Users/me', '~');
  assert.equal(quickMeta({ cwd: '/Users/me/code', dirs: 2, tags: ['a'], space: 'k' }, tilde), '~/code · ещё папок: 2 · тегов знаний: 1');
  assert.equal(quickMeta({ cwd: '', dirs: 0, tags: [], space: 'k' }, tilde), 'папка не задана — откроется форма');
  assert.deepEqual(togglePin(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(togglePin(['a', 'b'], 'a'), ['b']);
});
