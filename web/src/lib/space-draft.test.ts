import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpaceDetail, SpaceDraft } from '@server/api-types';
import {
  anyTaken, createBody, danglingDocs, defaultSources, diffRows, diffStat, docRefs, docsToSave, draftSourceItems, editOf, elapsed, estimateLine, lineDiff, updatePatch, usd,
} from './space-draft';

test('разница строк: общие строки остаются, удалённые и добавленные — по местам; пустой текст — все строки добавлены', () => {
  assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nB\nc\nd'), [
    { op: ' ', text: 'a' },
    { op: '-', text: 'b' },
    { op: '+', text: 'B' },
    { op: ' ', text: 'c' },
    { op: '+', text: 'd' },
  ]);
  assert.deepEqual(lineDiff('', 'x\ny').map((l) => l.op), ['+', '+']);
  assert.deepEqual(diffStat(lineDiff('a\nb', 'a\nc\nd')), { add: 2, del: 1 });
});

test('разница строк: длинные неизменённые куски свёрнуты, вокруг правки — по две строки', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const after = before.replace('l10', 'L10');
  const rows = diffRows(lineDiff(before, after));
  assert.deepEqual(rows[0], { skip: 8 });
  assert.deepEqual(rows.slice(1, 7).map((r) => ('skip' in r ? r.skip : r.text)), ['l8', 'l9', 'l10', 'L10', 'l11', 'l12']);
  assert.deepEqual(rows.at(-1), { skip: 7 });
});

test('ссылки карты на документы: docs/<имя>.md; висячие — не отмечены и не лежат в пространстве', () => {
  const map = '- docs/tests.md — тесты\n- `docs/release.md`\n- /repo/docs/readme.md — файл репозитория';
  assert.deepEqual(docRefs(map), ['tests.md', 'release.md']);
  assert.deepEqual(danglingDocs(map, ['tests.md'], []), ['release.md']);
  assert.deepEqual(danglingDocs(map, [], ['tests.md', 'release.md']), []);
});

const detail = (over: Partial<SpaceDetail> = {}): SpaceDetail =>
  ({
    slug: 'shop', dir: '/cfg/spaces/shop', map: '# Магазин', state: 'Суть: старое', docs: [], history: [], createdAt: '', updatedAt: '', cwd: '/code/shop', dirs: ['/code/api'],
    sessions: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, name: `сессия ${i}`, status: 'ended', live: false, cwd: '/code/shop', lastActivityAt: `2026-11-0${i + 1}T10:00:00Z`, turns: i })),
    runs: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, flow: 'fix', status: 'done', startedAt: `2026-10-2${i}T10:00:00Z`, input: '' })),
    looseSessions: [{ id: 'loose', name: 'без пространства', status: 'ended', live: false, cwd: '/code/shop', lastActivityAt: '2026-11-09T10:00:00Z', turns: 3 }],
    ...over,
  }) as SpaceDetail;

test('источники «Из истории»: свои свежие сверху, без пространства — в конце; по умолчанию — 5 сессий и 5 запусков, без чужих', () => {
  const items = draftSourceItems(detail());
  assert.equal(items.at(-1)!.id, 'loose');
  assert.equal(items[0]!.id, 's6');
  const def = defaultSources(items);
  assert.deepEqual(def, ['s6', 's5', 's4', 's3', 's2', 'r5', 'r4', 'r3', 'r2', 'r1']);
});

const draft = (over: Partial<SpaceDraft> = {}): SpaceDraft => ({ title: 'Магазин', map: '# Магазин\nновое', state: 'Суть: новое', cwd: '/code/shop', dirs: ['/code/api'], docs: [], doubts: [], ...over });

test('правка из черновика существующего: отмечено только изменённое, документ-замена снят; сохранение — с базой начала черновика', () => {
  const e = editOf(draft({ docs: [{ name: 'tests.md', text: 'тесты' }, { name: 'spec.md', text: 'спека', replaces: 123 }] }), detail());
  assert.deepEqual(e.take, { map: true, state: true, cwd: false, dirs: false });
  assert.deepEqual(e.docs.map((d) => d.on), [true, false]);
  assert.deepEqual(updatePatch(e, { mapMtimeMs: 5, stateMtimeMs: 0 }), { map: '# Магазин\nновое', mapBase: 5, state: 'Суть: новое', stateBase: 0 });
  assert.deepEqual(docsToSave(e), [{ name: 'tests.md', text: 'тесты', base: 0 }]);
  const replace = { ...e, docs: e.docs.map((d) => ({ ...d, on: true })) };
  assert.deepEqual(docsToSave(replace).map((d) => d.base), [0, 123]);
  const none = { ...e, take: { map: false, state: false, cwd: false, dirs: false }, docs: [] };
  assert.deepEqual(updatePatch(none, { mapMtimeMs: 5 }), {});
  assert.equal(anyTaken(none), false);
});

test('правка из черновика нового: всё отмечено; тело POST /api/spaces — без пустых полей, папки строками', () => {
  const e = editOf(draft({ slug: 'shop', state: undefined, cwd: undefined, dirs: [] }));
  assert.deepEqual(e.take, { map: true, state: false, cwd: false, dirs: false });
  assert.deepEqual(createBody({ ...e, dirs: '/code/api\n\n /code/web ' }), { slug: 'shop', title: 'Магазин', map: '# Магазин\nновое', dirs: ['/code/api', '/code/web'] });
});

test('цена и время: два знака, меньше цента — три, совсем мало — «< $0.001»; оценка — диапазон и потолок; минуты:секунды', () => {
  assert.equal(usd(0.2349), '$0.23');
  assert.equal(usd(0.0041), '$0.004');
  assert.equal(usd(0.0004), '< $0.001');
  assert.equal(usd(0), '$0.00');
  assert.equal(estimateLine({ low: 0.13, high: 0.46, ceiling: 1.5 }), '≈ $0.13–$0.46, не больше $1.50');
  assert.equal(elapsed(72_400), '1:12');
});
