import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactLite, ArtifactMeta, ArtifactRead, ConditionReport, PhaseReport } from '@server/api-types';
import {
  allWarnings, artAuthor, artBy, artClock, artLite, artStepKey, draftSaveWhy, draftsDialog, editMessage, hintLines, iterWarnCount, loadErrText, lockText, mergeItems,
  mergeStep, rowMarks, saveError, stepLine, stepOf, summaryParts, tasksBadge, versionOptions, winNote, winState, winStatus, type ArtDraft, type ArtWin,
  type StepInfo,
} from './artifacts';
import { setLangForTest } from '../i18n';

const lite = (key: string, over: Partial<ArtifactLite> = {}): ArtifactLite => ({
  key, title: key.toUpperCase(), file: `${key}.md`, size: 10, hash: `h-${key}`, author: { kind: 'initial' }, versions: 1, lockedBy: [], ...over,
});
const phase = (name: string, iteration: number, over: Partial<PhaseReport> = {}): PhaseReport => ({
  block: 'main', iteration, index: 0, phase: name, title: name, tools: [], ok: true, subtype: 'success', costUsd: 0, turns: 1, durationMs: 1, chars: 1, errors: [],
  files: { prompt: 'p', transcript: 't', output: 'o' }, ...over,
});
const cond = (iteration: number, over: Partial<ConditionReport> = {}): ConditionReport => ({ block: 'main', iteration, type: 'judge', done: false, feedback: '', costUsd: 0, ...over });
const win = (over: Partial<ArtWin> = {}): ArtWin => ({
  runId: 'r', key: 'plan', title: 'План', cur: null, ver: null, conflict: null, error: '', msg: '', msgKind: '', loading: false, saving: false, saveFailed: false, ...over,
});
const read = (over: Partial<ArtifactRead> = {}): ArtifactRead => ({
  key: 'plan', title: 'План', file: 'plan.md', path: '/runs/r/artifacts/plan.md', versions: [], lockedBy: [], text: 'текст', hash: 'h1', editable: true, ...over,
});
const draft = (over: Partial<ArtDraft> = {}): ArtDraft => ({ id: 1, runId: 'r', key: 'plan', title: 'План', text: 'текст', orig: 'текст', base: 'h1', ...over });

test('правило правки по-английски — по коду причины; без перевода и у неизвестной причины — текст сервера', () => {
  assert.equal(editMessage({ reason: 'done', message: 'Запуск завершён: правка ни на что не повлияет' }), 'Запуск завершён: правка ни на что не повлияет');
  setLangForTest('en');
  try {
    assert.equal(editMessage({ reason: 'done', message: 'x' }), 'The run is finished: an edit would change nothing');
    assert.equal(editMessage({ reason: 'writing', phases: ['plan', 'code'], message: 'x' }), 'Phase plan, code is writing: editing opens after the step ends');
    assert.equal(editMessage({ reason: 'too-big', message: 'Артефакт больше 1 МБ' }), 'Артефакт больше 1 МБ');
  } finally {
    setLangForTest('ru');
  }
});

test('автор словами: этап с блоком у многоблочного, пользователь, скилл, заготовка, пусто', () => {
  const at = '2026-10-24T10:00:00Z';
  assert.equal(artAuthor({ kind: 'phase', block: 'b2', iteration: 3, phase: 'dev', at }, true), 'этап dev (блок b2, итерация 3)');
  assert.equal(artAuthor({ kind: 'phase', block: 'b2', iteration: 3, phase: 'dev', at }, false), 'этап dev (итерация 3)');
  assert.equal(artAuthor({ kind: 'unknown', block: 'm', iteration: 1, phase: 'qa', at }, false), 'неизвестно: изменён во время этапа qa (итерация 1) не через UI');
  assert.equal(artAuthor({ kind: 'user', via: 'skill', at }, false), 'пользователь через скилл');
  assert.equal(artAuthor({ kind: 'condition', block: 'm', iteration: 2, at }, false), 'проверка условия (итерация 2)');
  assert.equal(artAuthor({ kind: 'initial' }, false), 'заготовка flow');
  assert.equal(artAuthor(undefined, false), 'ещё не заполнялся');
  assert.equal(artBy({ kind: 'user', via: 'ui', at }), 'пользователем в UI (другая вкладка или окно)');
});

test('время: сегодня — часы и минуты, другой день — с датой', () => {
  const now = new Date('2026-10-24T15:00:00');
  assert.equal(artClock(new Date('2026-10-24T09:05:00').toISOString(), now), '09:05');
  assert.equal(artClock(new Date('2026-10-20T09:05:00').toISOString(), now), '20.10 09:05');
  assert.equal(artClock(undefined, now), '');
});

test('артефакт из отчёта приводится к виду события: автор и время — последней версии', () => {
  const meta: ArtifactMeta = {
    key: 'plan', title: '', file: 'plan.md', size: 5, hash: 'h', mtimeMs: 0, decisions: true, tasks: { open: 1, done: 2 },
    versions: [{ n: 1, at: 'a1', author: { kind: 'initial' }, size: 1, stored: true }, { n: 2, at: 'a2', author: { kind: 'user', via: 'ui', at: 'a2' }, size: 5, stored: true }],
  };
  assert.deepEqual(artLite(meta), {
    key: 'plan', title: 'plan', file: 'plan.md', size: 5, hash: 'h', author: { kind: 'user', via: 'ui', at: 'a2' }, at: 'a2', versions: 2, lockedBy: [],
    decisions: true, tasks: { open: 1, done: 2 },
  });
  assert.equal(artLite({ ...meta, versions: [] }).author.kind, 'empty');
});

test('снимок из события сохраняет путь и правило правки из списка; changed — смена хэша или блокировки', () => {
  const first = mergeItems(new Map(), [{ ...lite('a'), path: '/x/a.md', editable: false, reason: 'done', message: 'Запуск завершён' }, lite('b')], true);
  assert.deepEqual(first.order, ['a', 'b']);
  assert.deepEqual(first.changed, ['a', 'b']);
  const next = mergeItems(first.items, [lite('a', { lockedBy: ['dev'] }), lite('b')], false);
  assert.deepEqual(next.changed, ['a']);
  assert.equal(next.items.get('a')!.path, '/x/a.md');
  assert.equal(next.items.get('a')!.reason, 'done');
  assert.deepEqual(next.items.get('a')!.lockedBy, ['dev']);
  // список — заново целиком
  assert.equal(mergeItems(next.items, [lite('a')], true).items.get('a')!.path, undefined);
});

test('итоги шагов: событие свежее отчёта, условие — #cond, предупреждения запуска приходят отдельно', () => {
  const steps = new Map<string, StepInfo>();
  assert.deepEqual(mergeStep(steps, { run: ['w0'], phases: [] }), ['w0']);
  mergeStep(steps, {
    block: 'main', iteration: 1, phases: [{ phase: 'dev', changed: ['plan'], warnings: [], denials: [{ tool: 'Write', reason: 'not-artifact', count: 2 }] }],
    condition: { changed: [], warnings: ['«План» пуст'] },
  });
  assert.deepEqual(stepOf(steps, 'main', 1, 'dev')!.changed, ['plan']);
  assert.deepEqual(stepOf(steps, 'main', 1, null)!.warnings, ['«План» пуст']);
  // нет в событиях — из отчёта; без артефактов и отказов — пусто
  assert.deepEqual(stepOf(steps, 'main', 2, 'dev', { artifacts: { changed: ['x'], warnings: [] } })!.changed, ['x']);
  assert.equal(stepOf(steps, 'main', 2, 'qa', {}), null);
  const line = stepLine(stepOf(steps, 'main', 1, 'dev'))!;
  assert.equal(line.denied, 2);
  assert.equal(line.why, 'Write: файл не артефакт этапа ×2');
  assert.equal(stepLine({ changed: [], warnings: [], denials: [] }), null);
});

test('все предупреждения: запуска, этапов и условий, шаг без отчёта; значок итерации считает свою', () => {
  const steps = new Map<string, StepInfo>();
  mergeStep(steps, { block: 'main', iteration: 2, phases: [{ phase: 'qa', changed: [], warnings: ['qa пишет мимо'], denials: [] }] });
  const r = {
    artifacts: { items: [], warnings: ['из отчёта'] },
    phases: [phase('dev', 1, { artifacts: { changed: [], warnings: ['dev забыл «План»'] } })],
    conditions: [cond(1, { artifacts: { changed: [], warnings: ['судья'] } })],
  };
  const w = allWarnings(r, steps, null);
  assert.deepEqual(w.map((x) => x.where), ['запуск', 'этап dev, итерация 1', 'проверка условия, итерация 1', 'этап qa, итерация 2']);
  assert.equal(allWarnings(r, steps, ['свежее'])[0]!.text, 'свежее');
  assert.equal(iterWarnCount(w, 'main', 1), 2);
  assert.equal(iterWarnCount(w, 'main', 2), 1);
  assert.deepEqual(allWarnings({ ...r, artifacts: undefined }, steps, null), []);
  assert.equal(artStepKey(undefined, 1, '#cond'), '|1|#cond');
});

test('сводка, пометки строки и подсказка панели', () => {
  const items = [
    artLite(lite('plan', { lockedBy: ['dev'], at: '2026-10-24T10:00:00Z', author: { kind: 'user', via: 'ui', at: '2026-10-24T10:00:00Z' } })),
    artLite(lite('notes', { size: 0, decisions: true })),
  ];
  const parts = summaryParts({ items, warns: 2, drafts: 1, asking: ['dev'], live: true, paused: true, multi: false, now: new Date('2026-10-24T12:00:00Z') });
  assert.equal(parts[0], '2 артефакта');
  assert.match(String(parts[1]), /^последний изменён: PLAN — пользователь, /);
  assert.deepEqual(parts.slice(2), [
    { text: '✎ этап dev ждёт ответа и пишет', cls: 'lock' }, { text: '⚠ предупреждений: 2', cls: 'warn' }, { text: 'не сохранено: 1', cls: 'draft' },
    { text: 'на паузе: можно править' },
  ]);
  assert.equal(lockText([], ['dev', 'qa']), 'пишет этап dev, qa');
  const marks = rowMarks(items[1]!, { warns: [{ text: 'нет «NOTES»', where: 'запуск' }], dirty: true, asking: [] });
  assert.deepEqual(marks.map((m) => m.text), ['⚠ предупреждений: 1', 'не сохранено', 'пока пусто', 'ответы на паузы']);
  assert.deepEqual(tasksBadge({ open: 0, done: 3 }), { text: 'открыто 0 из 3', title: 'Пункты чек-листа: открыто 0, закрыто 3', done: true });
  const hints = hintLines({
    from: 'r0', fromKnown: false, live: false, paused: false, foreignDrafts: [], lostAnswer: true,
    items: [{ ...items[0]!, reason: 'too-big' }, { ...items[1]!, reason: 'continuable', message: 'Правка попадёт в продолжение' }],
  });
  assert.deepEqual(hints, [{ kind: 'from', id: 'r0', known: false }, { kind: 'continue', text: 'Правка попадёт в продолжение.' }, { kind: 'lost' }]);
  assert.equal((hintLines({ live: true, paused: false, fromKnown: false, items: [], foreignDrafts: ['План'], lostAnswer: false })[1] as { text: string }).text,
    'Запуск возобновлён не отсюда, текст не сохранён: «План». Идущий шаг его не увидит; сохрани правку, и её получит следующий шаг.');
});

test('состояние окна: просмотр, правка, конфликт по хэшу, блокировка, версия', () => {
  const w = win({ cur: read() });
  assert.equal(winState(w, undefined), 'view');
  assert.equal(winState(w, draft()), 'edit');
  assert.equal(winState(win({ cur: read({ hash: 'h2' }) }), draft()), 'conflict');
  assert.equal(winState(win({ cur: read({ editable: false, message: 'Пишет этап dev' }) }), draft()), 'locked');
  assert.equal(winState(win({ cur: read(), ver: read({ version: { n: 1, at: 'a', author: { kind: 'initial' }, size: 1, stored: true } }) }), draft()), 'version');
});

test('строка статуса и баннер окна', () => {
  const live = { live: true, pause: null };
  assert.deepEqual(winStatus(win({ loading: true }), 'view', null), { text: 'Загружаю…', kind: '' });
  assert.deepEqual(winStatus(win({ cur: read() }), 'view', live).text, 'Править надёжнее на паузе: идущий этап уже получил свою версию, правка учтётся со следующего шага.');
  assert.deepEqual(winStatus(win({ cur: read() }), 'view', { live: true, pause: 'paused' }), { text: '', kind: '' });
  assert.deepEqual(winStatus(win({ cur: read({ editable: false, message: 'Пишет этап dev' }) }), 'locked', live), { text: 'Пишет этап dev', kind: 'warn' });
  assert.deepEqual(winStatus(win({ cur: read({ editable: false, message: 'Запуск завершён' }), msg: 'Скопировано.', msgKind: 'ok' }), 'view', null), {
    text: 'Запуск завершён Скопировано.', kind: 'ok',
  });
  assert.equal(winStatus(win({ cur: read({ reason: 'continuable', message: 'Правка попадёт в продолжение' }) }), 'view', null).text, 'Правка попадёт в продолжение.');
  assert.equal(winStatus(win({ error: 'нет' }), 'view', null).kind, 'err');
  const note = winNote(win({ cur: read({ author: { kind: 'phase', block: 'm', iteration: 1, phase: 'dev', at: '' } }) }), 'conflict', true, false)!;
  assert.equal(note.kind, 'err');
  assert.match(note.text, /^Файл изменён после того, как ты его открыл \(этапом dev\); .* Запуск возобновлён не отсюда/);
  assert.equal(winNote(win(), 'view', true, false), null);
});

test('версии: текущая и прошлые от новых к старым, без копии', () => {
  const at = new Date().toISOString();
  const opts = versionOptions(read({
    versions: [{ n: 1, at, author: { kind: 'initial' }, size: 1, stored: true }, { n: 2, at, author: { kind: 'user', via: 'ui', at }, size: 2, stored: false }, { n: 3, at, author: { kind: 'initial' }, size: 3, stored: true }],
  }), false);
  assert.deepEqual(opts.map((o) => o.value), ['', '2', '1']);
  assert.equal(opts[0]!.label, 'текущая · версия 3');
  assert.match(opts[1]!.label, /^версия 2 · пользователь · \d\d:\d\d · без копии$/);
});

test('ошибки: записи из окна, сохранения пачкой и загрузки', () => {
  assert.deepEqual(saveError({ status: 409, code: 'conflict', message: 'x', data: { hash: 'h9', author: { kind: 'outside', at: 't' } } }), {
    msg: '', kind: 'err', conflict: { hash: 'h9', author: { kind: 'outside', at: 't' }, at: undefined },
  });
  assert.deepEqual(saveError({ status: 423, code: 'locked', message: 'Пишет этап dev', data: { reason: 'writing' } }), {
    msg: 'Текст остался в редакторе.', kind: 'warn', readonly: { reason: 'writing', message: 'Пишет этап dev' },
  });
  assert.equal(saveError({ message: 'Failed to fetch' }).msg, 'Сервер недоступен: правка не сохранена. Текст остался в редакторе. Сохрани снова, когда сервер поднимется.');
  assert.equal(saveError({ status: 409, code: 'not_paused', message: 'Запуск не на паузе' }).msg, 'Запуск не на паузе. Нажми «Сохранить».');
  assert.equal(draftSaveWhy(null, true), 'текст больше 1 МБ');
  assert.equal(draftSaveWhy({ message: 'x' }, false), 'сервер недоступен');
  assert.equal(loadErrText({ status: 404, code: 'missing', message: 'x' }, 'Артефакт не загрузился'), 'Файл артефакта исчез с диска: перед следующим шагом он будет создан пустым');
  assert.equal(loadErrText({ status: 500, message: 'сбой' }, 'Список артефактов не загрузился'), 'Список артефактов не загрузился: сбой');
});

test('диалог несохранённой правки: подписи кнопок и текст по режиму', () => {
  assert.deepEqual(draftsDialog(['План'], 'resume'), {
    text: 'Несохранённая правка артефакта «План». Без сохранения следующий шаг её не увидит.', save: 'Сохранить и возобновить', skip: 'Возобновить без правки',
  });
  assert.equal(draftsDialog(['План', 'Заметки'], 'continue').text, 'Несохранённая правка артефактов «План», «Заметки». Продолжение возьмёт артефакты с диска: без сохранения правка в него не попадёт.');
  assert.equal(draftsDialog(['План'], 'requested').save, 'Сохранить');
});
