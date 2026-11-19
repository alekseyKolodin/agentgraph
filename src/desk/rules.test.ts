// Правила движения дел: таблица SPEC 3.2 строка в строку, плюс «один раз на изменение» и перенос руками.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ThingState } from '../things/types.js';
import { absorb, fingerprint, LINKS_MAX, SIGNALS_MAX, step, type RuleCtx } from './rules.js';
import type { DeskColumn, DeskItem, DeskSignal } from './types.js';

const KEY = 'mr:gitlab.example.com/grp/app/7';
const ctx = (now = '2026-11-19T10:00:00.000Z'): RuleCtx => ({ now, id: () => 'id1' });
const sig = (text: string, at = '2026-11-19T09:00:00.000Z', source = 'gitlab-reviews'): DeskSignal => ({ source, at, text, link: 'https://gitlab.example.com/grp/app/-/merge_requests/7' });
const state = (o: Partial<ThingState> = {}): ThingState => ({ exists: true, turn: 'me', why: 'автор ответил на 2 замечания', title: 'Починить вход', updatedAt: '2026-11-19T09:30:00.000Z', facts: {}, ...o });

function item(column: DeskColumn, o: Partial<DeskItem> = {}): DeskItem {
  return {
    id: 'x',
    key: KEY,
    thing: { type: 'mr', ref: { host: 'gitlab.example.com', project: 'grp/app', number: 7 } },
    kind: 'Ревью',
    title: 'Починить вход',
    column,
    why: '',
    signals: [sig('посмотри MR')],
    links: { runs: [], sessions: [] },
    createdAt: '2026-11-18T10:00:00.000Z',
    movedAt: '2026-11-18T10:00:00.000Z',
    movedBy: 'routine',
    ...(column === 'done' ? { closed: { at: '2026-11-18T12:00:00.000Z', reason: 'смержен' } } : {}),
    ...o,
  };
}

test('сигнал о вещи без дела: новое дело в «Новом», с сигналом и записью журнала', () => {
  const r = step(undefined, { type: 'put', key: KEY, patch: { kind: 'Ревью', title: 'Починить вход', signal: sig('посмотри MR') }, by: 'routine' }, ctx())!;
  assert.equal(r.item.column, 'new');
  assert.equal(r.item.kind, 'Ревью');
  assert.equal(r.item.signals.length, 1);
  assert.equal(r.item.createdAt, '2026-11-19T10:00:00.000Z');
  assert.deepEqual(r.move, { at: '2026-11-19T10:00:00.000Z', key: KEY, to: 'new', by: 'routine', why: 'посмотри MR' });
});

test('сигнал о вещи без дела: колонка правила, если задана', () => {
  const r = step(undefined, { type: 'put', key: KEY, patch: { title: 'x', column: 'plan' }, by: 'routine' }, ctx())!;
  assert.equal(r.item.column, 'plan');
});

test('новое дело без имени и вида: вид по типу вещи, имя из текста сигнала или ключа', () => {
  const a = step(undefined, { type: 'put', key: 'thread:slack/C1/171', patch: { signal: sig('глянь логи') }, by: 'routine' }, ctx())!;
  assert.deepEqual([a.item.kind, a.item.title], ['Разговор', 'глянь логи']);
  const b = step(undefined, { type: 'put', key: 'own:abc', patch: {}, by: 'session' }, ctx())!;
  assert.deepEqual([b.item.kind, b.item.title], ['Своё', 'own:abc']);
});

test('ещё один сигнал о той же вещи: тот же элемент, сигнал в список, колонка «В работе» не меняется', () => {
  const r = step(item('work'), { type: 'put', key: KEY, patch: { kind: 'Ревью из Slack', title: 'сообщение в Slack', signal: sig('напоминаю про MR', '2026-11-19T09:40:00.000Z', 'slack') }, by: 'routine' }, ctx())!;
  assert.equal(r.item.id, 'x');
  assert.equal(r.item.column, 'work');
  assert.equal(r.item.signals.length, 2);
  // первое имя и вид остаются
  assert.deepEqual([r.item.title, r.item.kind], ['Починить вход', 'Ревью']);
  assert.equal(r.move, undefined);
});

for (const from of ['waiting', 'done'] as const) {
  test(`ещё один сигнал о той же вещи: из «${from === 'waiting' ? 'Ждёт других' : 'Готово'}» — в «В плане»`, () => {
    const r = step(item(from), { type: 'put', key: KEY, patch: { signal: sig('ревью снова', '2026-11-19T09:50:00.000Z') }, by: 'routine' }, ctx())!;
    assert.equal(r.item.column, 'plan');
    assert.equal(r.item.closed, undefined);
    assert.equal(r.item.movedBy, 'routine');
    assert.deepEqual([r.move?.from, r.move?.to], [from, 'plan']);
  });
}

test('ещё один сигнал с on_repeat: keep — колонка та же', () => {
  const r = step(item('waiting'), { type: 'put', key: KEY, patch: { signal: sig('ещё', '2026-11-19T09:50:00.000Z'), onRepeat: 'keep' }, by: 'routine' }, ctx())!;
  assert.equal(r.item.column, 'waiting');
  assert.equal(r.item.signals.length, 2);
});

test('тот же самый сигнал второй раз ничего не меняет (правило срабатывает один раз)', () => {
  const i = item('waiting');
  assert.equal(step(i, { type: 'put', key: KEY, patch: { signal: sig('посмотри MR') }, by: 'routine' }, ctx()), undefined);
});

test('put без сигнала колонку не двигает, а поля правит', () => {
  const r = step(item('waiting'), { type: 'put', key: KEY, patch: { why: 'жду CI', due: '2026-11-20', links: { runs: ['r1'] } }, by: 'flow' }, ctx())!;
  assert.equal(r.item.column, 'waiting');
  assert.deepEqual([r.item.why, r.item.due, r.item.links.runs], ['жду CI', '2026-11-20', ['r1']]);
});

test('сигналов в деле не больше SIGNALS_MAX: старые уходят', () => {
  const many = Array.from({ length: SIGNALS_MAX }, (_, n) => sig(`s${n}`, `2026-11-01T00:00:${String(n).padStart(2, '0')}.000Z`));
  const r = step(item('new', { signals: many }), { type: 'put', key: KEY, patch: { signal: sig('последний', '2026-11-19T00:00:00.000Z') }, by: 'routine' }, ctx())!;
  assert.equal(r.item.signals.length, SIGNALS_MAX);
  assert.equal(r.item.signals.at(-1)!.text, 'последний');
  assert.equal(r.item.signals[0].text, 's1');
});

test('наблюдатель: ход стал моим — из «Ждёт других» в «В плане», why обновлён', () => {
  const r = step(item('waiting'), { type: 'state', state: state({ turn: 'me' }) }, ctx())!;
  assert.equal(r.item.column, 'plan');
  assert.equal(r.item.why, 'автор ответил на 2 замечания');
  assert.equal(r.item.movedBy, 'watcher');
  assert.equal(r.item.turn, 'me');
});

test('наблюдатель: ход мой, дело в «Новом» — колонка та же, why обновлён', () => {
  const r = step(item('new'), { type: 'state', state: state({ turn: 'me' }) }, ctx())!;
  assert.equal(r.item.column, 'new');
  assert.equal(r.item.why, 'автор ответил на 2 замечания');
  assert.equal(r.move, undefined);
});

for (const from of ['plan', 'work'] as const) {
  test(`наблюдатель: ход стал чужим — из «${from === 'plan' ? 'В плане' : 'В работе'}» в «Ждёт других»`, () => {
    const r = step(item(from), { type: 'state', state: state({ turn: 'others', why: 'жду автора' }) }, ctx())!;
    assert.equal(r.item.column, 'waiting');
    assert.deepEqual([r.move?.from, r.move?.to, r.move?.by], [from, 'waiting', 'watcher']);
  });
}

test('наблюдатель: вещь закрыта — в «Готово» с причиной', () => {
  const r = step(item('work'), { type: 'state', state: state({ closed: 'merged', turn: 'none', why: 'смержен' }) }, ctx())!;
  assert.equal(r.item.column, 'done');
  assert.deepEqual(r.item.closed, { at: '2026-11-19T10:00:00.000Z', reason: 'смержен' });
});

test('наблюдатель: то же состояние второй раз ничего не меняет', () => {
  const s = state({ turn: 'me' });
  const first = step(item('waiting'), { type: 'state', state: s }, ctx())!;
  assert.equal(first.item.seen, fingerprint(s));
  assert.equal(step(first.item, { type: 'state', state: s }, ctx()), undefined);
});

test('наблюдатель: вещь не снялась (нет доступа) — дело не трогается', () => {
  assert.equal(step(item('waiting'), { type: 'state', state: state({ exists: false, error: 'нет доступа' }) }, ctx()), undefined);
});

test('наблюдатель закрытое дело не трогает', () => {
  assert.equal(step(item('done'), { type: 'state', state: state({ turn: 'me' }) }, ctx()), undefined);
});

test('с карточки начат запуск или сессия: в «В работе», ссылка в links', () => {
  const linked = step(item('plan'), { type: 'put', key: KEY, patch: { links: { runs: ['run-1'] } }, by: 'flow' }, ctx())!;
  const r = step(linked.item, { type: 'move', column: 'work', by: 'flow', why: 'начат запуск' }, ctx())!;
  assert.equal(r.item.column, 'work');
  assert.deepEqual(r.item.links.runs, ['run-1']);
  assert.equal(r.item.movedBy, 'flow');
});

test('запуск по делу закончился: колонка та же, why — «агент закончил» или «запуск упал»', () => {
  const i = item('work', { links: { runs: ['run-1'], sessions: [] } });
  const okr = step(i, { type: 'run', runIds: ['run-1'], outcome: 'ok', summary: 'замечания поправлены' }, ctx())!;
  assert.deepEqual([okr.item.column, okr.item.why], ['work', 'агент закончил: замечания поправлены']);
  const bad = step(i, { type: 'run', runIds: ['run-1'], outcome: 'failed', summary: 'нет доступа' }, ctx())!;
  assert.deepEqual([bad.item.column, bad.item.why], ['work', 'запуск упал: нет доступа']);
  assert.equal(step(i, { type: 'run', runIds: ['other'], outcome: 'ok' }, ctx()), undefined);
  // продолжение: id новый, первый запуск цепочки — тот, что в links; остановка руками — не падение
  const cont = step(i, { type: 'run', runIds: ['run-2', 'run-1'], outcome: 'stopped' }, ctx())!;
  assert.equal(cont.item.why, 'запуск остановлен');
});

test('перенос руками держится до следующего изменения вещи', () => {
  const s = state({ turn: 'others', why: 'жду автора' });
  // сверка увидела чужой ход: дело в «Ждёт других»
  const watched = step(item('plan'), { type: 'state', state: s }, ctx())!.item;
  assert.equal(watched.column, 'waiting');
  // перенёс руками в «В плане»
  const manual = step(watched, { type: 'move', column: 'plan', by: 'me' }, ctx('2026-11-19T11:00:00.000Z'))!.item;
  assert.deepEqual([manual.column, manual.movedBy], ['plan', 'me']);
  // следующая сверка видит то же состояние — перенос держится
  assert.equal(step(manual, { type: 'state', state: s }, ctx('2026-11-19T11:05:00.000Z')), undefined);
  // вещь изменилась (новая реплика, ход всё ещё чужой) — правило снова двигает
  const next = step(manual, { type: 'state', state: { ...s, updatedAt: '2026-11-19T11:10:00.000Z' } }, ctx('2026-11-19T11:15:00.000Z'))!;
  assert.equal(next.item.column, 'waiting');
});

test('перенос в «Готово» закрывает дело, перенос из «Готово» — открывает', () => {
  const done = step(item('plan'), { type: 'move', column: 'done', by: 'me' }, ctx())!.item;
  assert.equal(done.closed?.reason, 'перенесено в «Готово»');
  const back = step(done, { type: 'move', column: 'plan', by: 'me' }, ctx())!.item;
  assert.equal(back.closed, undefined);
});

test('close: в «Готово» с причиной; повторный close ничего не меняет', () => {
  const r = step(item('waiting'), { type: 'close', reason: 'сделано', by: 'session' }, ctx())!;
  assert.deepEqual([r.item.column, r.item.closed?.reason, r.item.movedBy], ['done', 'сделано', 'session']);
  assert.equal(step(r.item, { type: 'close', reason: 'ещё раз', by: 'me' }, ctx()), undefined);
});

test('move и close без дела — ничего', () => {
  assert.equal(step(undefined, { type: 'move', column: 'plan', by: 'me' }, ctx()), undefined);
  assert.equal(step(undefined, { type: 'close', reason: 'x', by: 'me' }, ctx()), undefined);
});

test('правило close: never или словами — закрытая вещь дело не закрывает; thing — закрывает', () => {
  const merged = state({ closed: 'merged', turn: 'none', why: 'смержен' });
  for (const close of ['never', 'когда ответят в треде']) {
    const r = step(item('work', { close }), { type: 'state', state: merged }, ctx())!;
    assert.deepEqual([r.item.column, r.item.closed, r.item.why], ['work', undefined, 'смержен']);
  }
  assert.equal(step(item('work', { close: 'thing' }), { type: 'state', state: merged }, ctx())!.item.column, 'done');
});

test('правило close сохраняется при заведении и перезаписывается переданным', () => {
  const a = step(undefined, { type: 'put', key: KEY, patch: { title: 'x', close: 'never' }, by: 'routine' }, ctx())!.item;
  assert.equal(a.close, 'never');
  assert.equal(step(a, { type: 'put', key: KEY, patch: { close: 'thing' }, by: 'routine' }, ctx())!.item.close, 'thing');
  assert.equal(step(a, { type: 'put', key: KEY, patch: { why: 'y' }, by: 'routine' }, ctx())!.item.close, 'never');
});

test('наблюдатель: вещь та же, причина другая — why обновлён, колонка и seen те же', () => {
  const s = state({ turn: 'others', why: '3 файла не закоммичены' });
  const first = step(item('waiting'), { type: 'state', state: s }, ctx())!.item;
  const r = step(first, { type: 'state', state: { ...s, why: '7 файлов не закоммичены' } }, ctx())!;
  assert.deepEqual([r.item.column, r.item.why, r.item.seen, r.move], ['waiting', '7 файлов не закоммичены', first.seen, undefined]);
});

test('сигнал с потолком: длинный текст обрезан, ссылка не http(s) и огромный replyTo отброшены', () => {
  const r = step(undefined, { type: 'put', key: 'own:x', patch: { title: 'x', signal: { source: 'slack', at: 'a', text: 'я'.repeat(5000), link: 'javascript:x', replyTo: { blob: 'x'.repeat(10_000) } } }, by: 'routine' }, ctx())!;
  const s = r.item.signals[0];
  assert.equal(s.text!.length, 2000);
  assert.deepEqual([s.link, s.replyTo], [undefined, undefined]);
});

test('ссылки дописываются по одной и без повторов, ветка и MR — последние переданные', () => {
  let i = item('work');
  for (const links of [{ runs: ['r1'] }, { sessions: ['s1'] }, { runs: ['r2'] }, { runs: ['r1'], sessions: ['s1'] }, { branch: 'feat' }]) {
    i = step(i, { type: 'put', key: KEY, patch: { links }, by: 'session' }, ctx())?.item ?? i;
  }
  assert.deepEqual(i.links, { runs: ['r1', 'r2'], sessions: ['s1'], branch: 'feat' });
});

test('дело, переоткрытое сигналом, пока вещь закрыта, сверка закрывает снова', () => {
  const merged = state({ closed: 'merged', turn: 'none', why: 'смержен' });
  const done = step(item('work'), { type: 'state', state: merged }, ctx())!.item;
  const reopened = step(done, { type: 'put', key: KEY, patch: { signal: sig('а что с этим MR?', '2026-11-19T11:00:00.000Z', 'slack') }, by: 'routine' }, ctx())!.item;
  assert.deepEqual([reopened.column, reopened.seen], ['plan', undefined]);
  const again = step(reopened, { type: 'state', state: merged }, ctx())!;
  assert.equal(again.item.column, 'done');
});

test('перенос руками до первой сверки держится: первое состояние только запоминается', () => {
  const manual = step(item('plan', { seen: undefined }), { type: 'move', column: 'work', by: 'me' }, ctx())!.item;
  const r = step(manual, { type: 'state', state: state({ turn: 'others', why: 'жду автора' }) }, ctx())!;
  assert.deepEqual([r.item.column, r.item.seen !== undefined, r.move], ['work', true, undefined]);
  // следующее изменение вещи — уже правило
  const next = step(r.item, { type: 'state', state: state({ turn: 'others', why: 'жду автора', updatedAt: '2026-11-19T12:00:00.000Z' }) }, ctx())!;
  assert.equal(next.item.column, 'waiting');
});

test('итог запуска — только у дел, где он начат по делу (links.runs), не у заведённых им через desk_put (mentionedBy)', () => {
  const byRoutine = step(item('plan'), { type: 'put', key: KEY, patch: { links: { runs: ['r1'] } }, by: 'routine' }, ctx())!.item;
  const byFlow = step(undefined, { type: 'put', key: 'own:f', patch: { title: 'нашёл агент', links: { mentionedBy: ['r1'] } }, by: 'flow' }, ctx())!.item;
  assert.deepEqual([byFlow.links.runs, byFlow.links.mentionedBy], [[], ['r1']]);
  assert.equal(step(byFlow, { type: 'run', runIds: ['r1'], outcome: 'ok', summary: 'x' }, ctx()), undefined);
  assert.equal(step(byRoutine, { type: 'run', runIds: ['r1'], outcome: 'ok', summary: 'x' }, ctx())!.item.why, 'агент закончил: x');
});

test('закрыто руками при открытой вещи, переоткрыто сигналом: отпечаток держится, сверка не уводит в «Ждёт других»', () => {
  const watched = step(item('plan'), { type: 'state', state: state({ turn: 'others', why: 'ждём автора' }) }, ctx())!.item;
  assert.equal(watched.column, 'waiting');
  const closed = step(watched, { type: 'close', reason: 'не моё', by: 'me' }, ctx())!.item;
  const reopened = step(closed, { type: 'put', key: KEY, patch: { signal: sig('всё же глянь', '2026-11-19T11:00:00.000Z', 'slack') }, by: 'routine' }, ctx())!.item;
  assert.deepEqual([reopened.column, reopened.seen], ['plan', watched.seen]);
  // то же состояние вещи: обновится только why, колонка та же
  const r = step(reopened, { type: 'state', state: state({ turn: 'others', why: 'ждём автора' }) }, ctx())!;
  assert.deepEqual([r.item.column, r.item.why, r.move], ['plan', 'ждём автора', undefined]);
});

test('createdBy — только у нового дела и только строки; mentionedBy дописывается без повторов, ссылок не больше LINKS_MAX', () => {
  const made = step(undefined, { type: 'put', key: 'own:f', patch: { title: 'x', createdBy: { run: 'r1', routine: 7 as unknown as string } }, by: 'flow' }, ctx())!.item;
  assert.deepEqual(made.createdBy, { run: 'r1' });
  const again = step(made, { type: 'put', key: 'own:f', patch: { why: 'ещё', createdBy: { run: 'r2' }, links: { mentionedBy: ['r2', 'r2'] } }, by: 'flow' }, ctx())!.item;
  assert.deepEqual([again.createdBy, again.links.mentionedBy], [{ run: 'r1' }, ['r2']]);
  let i = again;
  for (let k = 0; k < LINKS_MAX + 5; k++) i = step(i, { type: 'put', key: 'own:f', patch: { links: { runs: [`run-${k}`], mentionedBy: [`m-${k}`] } }, by: 'routine' }, ctx())!.item;
  assert.equal(i.links.runs.length, LINKS_MAX);
  // первый запуск (корень цепочки) остаётся: по нему продолжение находит дело
  assert.deepEqual([i.links.runs[0], i.links.runs.at(-1)], ['run-0', `run-${LINKS_MAX + 4}`]);
  assert.equal(i.links.mentionedBy?.length, LINKS_MAX);
});

test('absorb: своё сливается в открытое дело вещи — сигналы без повторов по времени, ссылки и кто завёл своё; колонка та же, журнал from = to', () => {
  const target = item('work', { signals: [sig('посмотри MR', '2026-11-18T09:00:00.000Z')] });
  const own = item('new', {
    key: 'own:a', title: 'Доделать ретраи', kind: 'Своё', thing: undefined, due: '2026-11-30',
    signals: [sig('посмотри MR', '2026-11-18T09:00:00.000Z'), sig('сделаешь?', '2026-11-17T09:00:00.000Z', 'slack')],
    links: { runs: [], sessions: ['s1'] }, createdBy: { run: 'r0', session: 's0' },
  });
  const r = absorb(target, own, ctx());
  assert.deepEqual(r.item.signals.map((s) => s.text), ['сделаешь?', 'посмотри MR']);
  assert.deepEqual([r.item.column, r.item.kind, r.item.title, r.item.due, r.item.links.sessions, r.item.links.mentionedBy], ['work', 'Ревью', 'Починить вход', '2026-11-30', ['s1', 's0'], ['r0']]);
  assert.deepEqual(r.move, { at: '2026-11-19T10:00:00.000Z', key: KEY, from: 'work', to: 'work', by: 'me', why: 'из своего дела own:a' });
});

test('absorb: «Ждёт других» — в «В плане» только при новых сигналах; дело без вещи получает вещь и заголовок своего', () => {
  const own = item('new', { key: 'own:a', title: 'Своё', thing: undefined, signals: [sig('новое', '2026-11-19T09:00:00.000Z', 'slack')] });
  assert.equal(absorb(item('waiting'), own, ctx()).item.column, 'plan');
  assert.equal(absorb(item('waiting'), { ...own, signals: [] }, ctx()).item.column, 'waiting');
  const bare = item('plan', { thing: undefined, title: KEY });
  const thing = { type: 'mr' as const, ref: { host: 'gitlab.example.com', project: 'grp/app', number: 7 } };
  const r = absorb(bare, own, ctx(), thing);
  assert.deepEqual([r.item.thing, r.item.title], [thing, 'Своё']);
});

test('absorb: закрытое наблюдателем — открывается без отпечатка (сверка закроет снова); закрытое руками при открытой вещи — с отпечатком', () => {
  const merged = state({ closed: 'merged', turn: 'none', why: 'смержен' });
  const byWatcher = step(item('work'), { type: 'state', state: merged }, ctx())!.item;
  const own = item('new', { key: 'own:a', thing: undefined, signals: [] });
  const reopened = absorb(byWatcher, own, ctx()).item;
  assert.deepEqual([reopened.column, reopened.closed, reopened.seen], ['plan', undefined, undefined]);
  assert.equal(step(reopened, { type: 'state', state: merged }, ctx())!.item.column, 'done');
  const seenOpen = step(item('plan'), { type: 'state', state: state({ turn: 'others' }) }, ctx())!.item;
  const byHand = step(seenOpen, { type: 'close', reason: 'не моё', by: 'me' }, ctx())!.item;
  const back = absorb(byHand, own, ctx()).item;
  assert.deepEqual([back.column, back.closed, back.seen], ['plan', undefined, seenOpen.seen]);
});
