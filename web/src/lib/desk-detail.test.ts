import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskItem, DeskMove } from '@server/desk/types';
import { fieldRows, moveTitle, originOf, relatedOf, thingRows, timeline, whenText } from './desk-detail';

// полдень по местному времени: границы дня считаются по нему
const NOW = new Date(2026, 10, 19, 12, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 10, 19 + d, h, m).toISOString();

const item = (o: Partial<DeskItem> = {}): DeskItem => ({
  id: 'i1',
  key: 'own:i1',
  kind: 'Своё',
  title: 'Дело',
  column: 'plan',
  why: '',
  signals: [],
  links: { runs: [], sessions: [] },
  createdAt: at(-2, 9),
  movedAt: at(-1, 10),
  movedBy: 'me',
  ...o,
});
const ctx = {
  routineTitle: (s: string) => (s === 'mr-review' ? 'Ревью MR' : undefined),
  runTitle: (id: string) => (id === 'r1' ? 'Разбор тикета' : undefined),
  sessionName: (id: string) => (id === 's1' ? 'Чиню ретраи' : undefined),
  projectTitle: (s: string) => (s === 'pay' ? 'Платежи' : undefined),
};

test('whenText: сегодня, вчера, дата; не дата — пусто', () => {
  assert.match(whenText(at(0, 9, 5), NOW), /^сегодня, /);
  assert.match(whenText(at(-1, 23, 59), NOW), /^вчера, /);
  assert.doesNotMatch(whenText(at(-5, 9), NOW), /сегодня|вчера/);
  assert.equal(whenText('не дата', NOW), '');
  assert.equal(whenText(undefined, NOW), '');
});

test('откуда: рутина — ссылка на рутину с её названием, исходный сигнал — первый', () => {
  const i = item({
    createdBy: { routine: 'mr-review', run: 'r1' },
    signals: [
      { source: 'gitlab', at: at(-2, 9), text: 'назначили ревьюером', author: 'Иван', link: 'https://gl.example.com/mr/1' },
      { source: 'gitlab', at: at(-1, 9), text: 'новый коммит' },
    ],
  });
  const o = originOf(i, [], ctx);
  assert.equal(o.headline, 'Завела рутина');
  assert.deepEqual(o.links, [
    { text: 'Рутина «Ревью MR»', to: '/routines/mr-review' },
    { text: 'Запуск «Разбор тикета»', to: '/run/r1' },
  ]);
  assert.equal(o.signal?.text, 'назначили ревьюером');
});

test('откуда: сессия без названия в списке — по id; дело без createdBy с сигналом рутины — рутина из сигнала', () => {
  assert.deepEqual(originOf(item({ createdBy: { session: 'zz' } }), []).links, [{ text: 'Сессия «zz»', to: '/sessions/zz' }]);
  assert.equal(originOf(item({ createdBy: { session: 's1' } }), [], ctx).headline, 'Завела сессия Claude');
  const o = originOf(item({ signals: [{ source: 'slack', routine: 'mr-review', at: at(-2, 9) }] }), [], ctx);
  assert.equal(o.headline, 'Завела рутина');
  assert.deepEqual(o.links, [{ text: 'Рутина «Ревью MR»', to: '/routines/mr-review' }]);
});

test('откуда: заведено руками — «Завёл ты» по первой записи журнала; ни журнала, ни createdBy — по сигналу ui', () => {
  const moves: DeskMove[] = [{ at: at(-2, 9), key: 'own:i1', to: 'new', by: 'me' }];
  assert.equal(originOf(item(), moves).headline, 'Завёл ты');
  assert.equal(originOf(item({ signals: [{ source: 'ui', at: at(-2, 9), text: 'позвонить' }] }), []).headline, 'Завёл ты');
  assert.equal(originOf(item({ movedAt: at(-2, 9), movedBy: 'watcher' }), []).headline, 'Завёл наблюдатель вещи');
});

test('вещь: тип, метка, адрес только http(s), ход и правило закрытия', () => {
  const mr = item({
    key: 'mr:gitlab.example.com/g/app/12',
    kind: 'MR',
    thing: { type: 'mr', ref: { number: 12, forge: 'gitlab' }, url: 'https://gitlab.example.com/g/app/-/merge_requests/12' },
    turn: 'me',
    close: 'thing',
  });
  const rows = Object.fromEntries(thingRows(mr).map((r) => [r.label, r]));
  assert.equal(rows['Вещь']?.text, 'MR или PR · !12');
  assert.equal(rows['Ссылка']?.link?.href, 'https://gitlab.example.com/g/app/-/merge_requests/12');
  assert.equal(rows['Ход по вещи']?.text, 'ход за тобой');
  assert.equal(rows['Закрывается']?.text, 'когда вещь закрыта');
  // своё дело: вещи нет, ссылки и хода нет; javascript: адрес не попадает в ссылку
  const own = thingRows(item({ links: { runs: [], sessions: [], mr: 'javascript:alert(1)' } }));
  assert.deepEqual(own.map((r) => r.label), ['Вещь']);
  assert.equal(own[0]!.text, 'Своё дело');
  assert.equal(thingRows(item({ close: 'never' })).find((r) => r.label === 'Закрывается')?.text, 'только руками');
  assert.equal(thingRows(item({ close: 'ответили' })).find((r) => r.label === 'Закрывается')?.text, 'по условию: ответили');
});

test('поля: колонка, проект по названию, срок, у закрытого — причина; срок закрытого не показывается просроченным', () => {
  const open = fieldRows(item({ project: 'pay', due: '2026-11-17' }), NOW, ctx);
  const get = (rows: ReturnType<typeof fieldRows>, label: string) => rows.find((r) => r.label === label)?.text;
  assert.equal(get(open, 'Колонка'), 'В плане');
  assert.equal(get(open, 'Проект'), 'Платежи');
  assert.match(get(open, 'Срок') ?? '', /просрочено/);
  assert.equal(get(open, 'Ключ'), 'own:i1');
  const done = fieldRows(item({ column: 'done', due: '2026-11-17', closed: { at: at(0, 8), reason: 'смержен' } }), NOW, ctx);
  assert.match(get(done, 'Закрыто') ?? '', /смержен/);
  // у закрытого срока нет, а «Срок» с сырой строкой — только у даты, которую не разобрали
  assert.equal(get(done, 'Срок'), '2026-11-17');
  assert.equal(get(fieldRows(item({ due: 'скоро' }), NOW), 'Срок'), 'скоро');
});

test('связи: запуски, сессии, кто упоминал (без повтора запусков), ветка и MR', () => {
  const rel = relatedOf(
    item({ links: { runs: ['r1'], sessions: ['s1', 's2'], mentionedBy: ['r1', 'r9'], branch: 'fix/retry', mr: 'https://gl.example.com/mr/3' } }),
    ctx,
  );
  assert.deepEqual(rel.map((r) => [r.kind, r.text, r.to ?? r.href]), [
    ['run', 'Разбор тикета', '/run/r1'],
    ['session', 'Чиню ретраи', '/sessions/s1'],
    ['session', 's2', '/sessions/s2'],
    ['mention', 'r9', '/run/r9'],
    ['branch', 'fix/retry', undefined],
    ['mr', 'gl.example.com/mr/3', 'https://gl.example.com/mr/3'],
  ]);
});

test('история: сигналы и переносы вместе, новое сверху; у переноса — кто и почему', () => {
  const i = item({
    signals: [
      { source: 'slack', at: at(-2, 9), text: 'посмотришь?', author: 'Иван', link: 'https://slack.example.com/t/1' },
      { source: 'slack', at: at(-1, 8), text: 'ещё раз' },
    ],
  });
  const moves: DeskMove[] = [
    { at: at(-2, 9), key: i.key, to: 'new', by: 'routine' },
    { at: at(-1, 10), key: i.key, from: 'new', to: 'plan', by: 'me', why: 'беру завтра' },
  ];
  const tl = timeline(i, moves);
  assert.deepEqual(tl.map((e) => [e.kind, e.title]), [
    ['move', 'Новое → В плане'],
    ['signal', 'Сигнал · slack'],
    // одно время — позже записанное выше
    ['move', 'Заведено в «Новое»'],
    ['signal', 'Сигнал · slack'],
  ]);
  assert.deepEqual([tl[0]!.who, tl[0]!.text], ['ты', 'беру завтра']);
  assert.deepEqual([tl[3]!.who, tl[3]!.text, tl[3]!.link?.href], ['Иван', 'посмотришь?', 'https://slack.example.com/t/1']);
});

test('история: журнал обрезан или пуст — «Дело заведено» по createdAt; закрытое без строки закрытия — «Закрыто»', () => {
  const closed = item({ column: 'done', closed: { at: at(0, 9), reason: 'не моё' } });
  assert.deepEqual(timeline(closed, []).map((e) => [e.kind, e.title, e.text]), [
    ['closed', 'Закрыто', 'не моё'],
    ['created', 'Дело заведено', undefined],
  ]);
  // строка закрытия есть в журнале — второй раз не добавляется
  const moves: DeskMove[] = [
    { at: at(-2, 9), key: closed.key, to: 'new', by: 'me' },
    { at: at(0, 9), key: closed.key, from: 'new', to: 'done', by: 'me', why: 'не моё' },
  ];
  assert.deepEqual(timeline(closed, moves).map((e) => e.kind), ['move', 'move']);
  // кривой адрес сигнала ссылкой не становится
  assert.equal(timeline(item({ signals: [{ source: 'x', at: at(-1, 9), link: 'javascript:alert(1)' }] }), [])[0]!.link, undefined);
});

test('moveTitle: заведение, перенос и слияние', () => {
  assert.equal(moveTitle({ to: 'new' }), 'Заведено в «Новое»');
  assert.equal(moveTitle({ from: 'plan', to: 'work' }), 'В плане → В работе');
  assert.equal(moveTitle({ from: 'plan', to: 'plan' }), 'Дополнено в «В плане»');
});
