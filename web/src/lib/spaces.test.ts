import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Space, SpaceRun, SpaceSession } from '@server/api-types';
import {
  dirLines, docLine, docSize, filterSpaces, itemsCount, newSpaceBody, pickerRows, spaceFieldNote, spaceFormOf, spaceItems, spaceLabel, spaceMetaLine,
  modelSummary, pickWorkdir, spacePatch, spacePreview, spacesNoneText, spaceSnapshot, spaceWorkdir, stateByText, updateLine, workdirHint, workdirNote,
  type CwdState,
} from './spaces';

const item = (slug: string, title = '', preview = '') => ({ slug, title, preview, updatedAt: '', docs: 0, hasMap: false, hasState: false });
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
  assert.match(spaceMetaLine({ hasMap: true, docs: 3, updatedAt: '2026-10-24T10:00:00Z' }), /^карта · документов: 3 · .+/);
  assert.match(spaceMetaLine({ hasMap: false, docs: 0, updatedAt: '2026-10-24T10:00:00Z', sessions: 2, runs: 1, live: 1 }), /^без карты · документов: 0 · 2 сессии · 1 запуск · идёт 1 · /);
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
  assert.match(stateByText(space({ history: [{ id: 's', at: '', kind: 'session', title: 'Kai' }, { id: 'r', at: '', kind: 'run', flow: 'f' }] })), / · всего обновлений: 2$/);
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
  assert.deepEqual(f, { title: 'Пуш', map: '# Пуш\n', state: 'Суть\n', dirs: '/a\n/b', cwd: '' });
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
  assert.deepEqual(newSpaceBody('p', '', '', '', ' ~/code/app '), { slug: 'p', cwd: '~/code/app' });
  // рабочая папка: правка — в патче, пустая — снять
  assert.deepEqual(spacePatch({ ...f, cwd: '/code/app' }, s), { cwd: '/code/app' });
  assert.deepEqual(spacePatch({ ...f, cwd: '' }, space({ cwd: '/code/app' })), { cwd: '' });
});

test('поле пространства: пусто — без пространства, неверный слаг — ошибка, новый — заведётся, существующий — что даст', () => {
  const options = [{ ...item('press-alert', 'Пуш', 'Суть'), hasMap: true, docs: 2, hasState: true }];
  assert.equal(spaceFieldNote('', options).text, 'Без пространства: только папка и теги знаний');
  assert.equal(spaceFieldNote('Bad Slug', options).tone, 'err');
  assert.match(spaceFieldNote('new-one', options).text, /^new-one: новое пространство — заведётся пустым/);
  assert.equal(spaceFieldNote(' press-alert ', options).text, 'Пуш: карта — памятью · документов: 2 · состояние — в контексте');
  // превью из карты — ещё не состояние
  assert.match(spaceFieldNote('press-alert', [{ ...options[0]!, hasState: false }]).text, /состояния ещё нет$/);
});

test('рабочая папка пространства — посчитанная сервером; подпись — откуда она', () => {
  const opts = [{ slug: 'p', workdir: { path: '/code/api', from: 'run' as const } }, { slug: 'own', workdir: { path: '/code/own', from: 'space' as const } }, { slug: 'none' }];
  assert.deepEqual(spaceWorkdir(' p ', opts), { path: '/code/api', from: 'run' });
  assert.equal(spaceWorkdir('none', opts), undefined);
  assert.equal(spaceWorkdir('', opts), undefined);
  assert.equal(workdirNote({ slug: 'own', title: 'Своё' }, 'own', { path: '/x', from: 'space' }), 'из пространства «Своё»: его рабочая папка');
  assert.match(workdirNote(undefined, 'p', { path: '/x', from: 'session' }), /^из пространства «p»: папка его последней сессии$/);
});

test('рабочая папка в формах: подставить или нет — вручную, недавняя, «Запустить…», worktree, ссылка, смена пространства, пространство без папки', () => {
  const opts = [
    { slug: 'a', title: 'Альфа', workdir: { path: '/code/a', from: 'space' as const } },
    { slug: 'b', title: '', workdir: { path: '/code/b', from: 'session' as const } },
    { slug: 'c', title: '' },
  ];
  const wd = (slug: string) => spaceWorkdir(slug, opts);
  const fresh: CwdState = { cwd: '/home/me', from: '', touched: false };
  // папку не трогали (по умолчанию, запомненная, ?space= без &cwd=, когда пришёл список) — подставляется с подписью
  const a = pickWorkdir('a', wd('a'), fresh);
  assert.deepEqual(a, { cwd: '/code/a', from: 'a', touched: false });
  assert.deepEqual(workdirHint('a', opts, a), { wd: { path: '/code/a', from: 'space' }, note: 'из пространства «Альфа»: его рабочая папка' });
  // папку подставило пространство — другое пространство её меняет; без рабочей папки — папка остаётся, подпись снимается
  assert.deepEqual(pickWorkdir('b', wd('b'), a), { cwd: '/code/b', from: 'b', touched: false });
  const c = pickWorkdir('c', wd('c'), a);
  assert.deepEqual(c, { cwd: '/code/a', from: '', touched: false });
  assert.deepEqual(workdirHint('c', opts, c), {});
  assert.deepEqual(pickWorkdir('b', wd('b'), c).cwd, '/code/b');
  // вписали руками, выбрали «Выбрать…» или недавнюю, ссылка «Сессия в папке» (&cwd=) — не трогаем: предложение «подставить»
  const own: CwdState = { cwd: '/mine', from: '', touched: true };
  assert.deepEqual(pickWorkdir('a', wd('a'), own), own);
  assert.deepEqual(workdirHint('a', opts, own), { wd: { path: '/code/a', from: 'space' }, offer: { path: '/code/a', from: 'space' } });
  // «Запустить…» с проектом и worktree — тоже
  const locked: CwdState = { cwd: '/wt/x', from: '', touched: false, locked: true };
  assert.deepEqual(pickWorkdir('a', wd('a'), locked), locked);
  // «подставить» (папка от пространства) — дальше её снова меняет выбор пространства, даже при «Запустить…»
  assert.equal(pickWorkdir('b', wd('b'), { ...locked, cwd: '/code/a', from: 'a' }).cwd, '/code/b');
  // своя папка совпала с рабочей (&cwd= со страницы пространства) — подпись «из пространства»
  const same = pickWorkdir('b', wd('b'), { cwd: '/code/b', from: '', touched: true });
  assert.deepEqual(same, { cwd: '/code/b', from: 'b', touched: true });
  assert.match(workdirHint('b', opts, same).note ?? '', /папка его последней сессии/);
  // папка та же, но подставило её не это пространство — ни подписи, ни предложения
  assert.deepEqual(workdirHint('b', opts, { cwd: '/code/b', from: '' }), { wd: { path: '/code/b', from: 'session' } });
  assert.deepEqual(workdirHint('', opts, fresh), {});
});

test('выбор пространства: свежие сверху по последней работе или обновлению, поиск; «+ новое» для нового слага — перед «без пространства»', () => {
  const a = { ...item('a', 'Альфа', 'суть альфы'), updatedAt: '2026-11-01T00:00:00Z', lastWorkAt: '2026-11-04T00:00:00Z' };
  const b = { ...item('b', 'Бета'), updatedAt: '2026-11-03T00:00:00Z' };
  const kinds = (rows: ReturnType<typeof pickerRows>) => rows.map((r) => (r.kind === 'space' ? r.s.slug : r.kind));
  assert.deepEqual(kinds(pickerRows('', [a, b])), ['a', 'b', 'none']);
  assert.deepEqual(kinds(pickerRows('альфы', [a, b])), ['a', 'none']);
  // новый слаг без совпадений: первой строкой — «+ новое», Enter выберет его
  assert.deepEqual(pickerRows('new-one', [a, b]), [{ kind: 'new', slug: 'new-one' }, { kind: 'none' }]);
  assert.equal(pickerRows('a', [a, b]).some((r) => r.kind === 'new'), false);
  assert.equal(pickerRows('Bad Slug', [a, b]).some((r) => r.kind === 'new'), false);
});


test('модель получит: строка-сводка — карта и состояние в токенах (оценка), документы, папки, знания; без пространства — только знания', () => {
  const space = { slug: 'p', title: 'П', dir: '/c/p', map: { path: '/c/p/CLAUDE.md', chars: 3840, loaded: true }, state: 'x'.repeat(640), docs: [{ name: 'a.md', size: 1, mtimeMs: 0, text: true }], dirs: ['/a', '/b'] };
  assert.equal(modelSummary({ space, knowledge: [{ slug: 'qa', title: '', inline: false, text: '- qa' }] }), 'карта ≈1.2k ток. — памятью · состояние ≈200 ток. · документов: 1 · папок: 2 · знаний: 1');
  // сессия в папке, которая содержит папку пространства (~): карта — строкой «прочитай»; этапу она приходит памятью всегда
  const home = { space: { ...space, map: { ...space.map, loaded: false } }, knowledge: [] };
  assert.match(modelSummary(home, 'session'), /^карта ≈1\.2k ток\. — по запросу/);
  assert.match(modelSummary(home), /^карта ≈1\.2k ток\. — памятью/);
  assert.equal(modelSummary({ space: { ...space, map: { ...space.map, chars: 0 }, state: '', docs: [], dirs: [] }, knowledge: [] }), 'карты нет · состояния ещё нет');
  assert.equal(modelSummary({ knowledge: [{ slug: 'qa', title: '', inline: true, text: '' }] }), 'знаний: 1');
});
