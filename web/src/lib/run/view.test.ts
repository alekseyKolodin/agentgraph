import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BlockReport, ConditionReport, PhaseReport, RunDetail, RunReport } from '@server/api-types';
import { liveState, type LiveState, type PendingPhase } from './events';
import {
  blockIters, chatMeta, chatText, continueVisible, ctxChipInfo, fileIsMarkdown, finalFacts, finalFeedback, gotoTarget, headerStatus, inspectView,
  iterSummary, limitEditable, nodeFromKey, pauseHint, phaseModelChip, ribbonRows, runBlocks, runMeta, runSteps, summaryView, tagFinalLines,
  type RunFold,
} from './view';

const block = (name: string, over: Partial<BlockReport> = {}): BlockReport => ({
  index: 0, name, title: '', status: 'running', iterations: 1, maxIterations: 3, condition: 'judge', looped: true, onFail: 'stop', ...over,
});
const report = (over: Partial<RunReport> = {}): RunReport => ({
  id: 'r1', flow: 'f', input: 'задача', cwd: '/p', status: 'running', iterations: 1, maxIterations: 3, totalCostUsd: 0,
  blocks: [block('main')], phases: [], conditions: [], questions: [], runDir: '/runs/r1', startedAt: '2026-10-24T10:00:00Z', ...over,
});
const phase = (name: string, iteration: number, over: Partial<PhaseReport> = {}): PhaseReport => ({
  block: 'main', iteration, index: 0, phase: name, title: name, tools: [], ok: true, subtype: 'success', costUsd: 0.1, turns: 3,
  durationMs: 1000, chars: 10, errors: [], files: { prompt: `${name}.prompt.md`, transcript: `${name}.transcript.md`, output: `${name}.output.md` }, ...over,
});
const cond = (iteration: number, over: Partial<ConditionReport> = {}): ConditionReport => ({
  block: 'main', iteration, type: 'judge', done: false, feedback: 'нет тестов в строке 12', costUsd: 0.05, ...over,
});
const st = (over: Partial<RunReport> = {}, live = true): LiveState => liveState({ ...report(over), live } as RunDetail);
const pend = (s: LiveState, x: Partial<PendingPhase> & { phase: string }) =>
  s.pending.set(`${x.block ?? 'main'}:${x.iteration ?? 1}:${x.phase}`, { block: 'main', iteration: 1, index: 0, title: x.phase, tools: [], at: 0, ...x });
const fold = (): RunFold => ({ over: new Map(), older: new Set() });

test('шапка: статус ждёт ответа / на паузе / идёт / итог; прогресс одного и нескольких блоков', () => {
  const s = st();
  assert.equal(headerStatus(s.run), 'running');
  s.run.pause = 'paused';
  assert.equal(headerStatus(s.run), 'paused');
  s.run.questions.push({ id: 'q', block: 'main', iteration: 1, phase: 'a', title: 'a', questions: [], askedAt: '' });
  assert.equal(headerStatus(s.run), 'waiting');
  assert.equal(headerStatus(st({ status: 'failed' }, false).run), 'failed');
  assert.equal(runMeta(st({ totalCostUsd: 1.234 }).run, null), 'итерация 1/3 · ≈$1.23');
  const multi = st({ blocks: [block('a', { status: 'done' }), block('b', { index: 1, status: 'running' }), block('c', { index: 2, status: 'pending' })], iterations: 4 });
  assert.equal(runMeta(multi.run, { tag: 'front', file: '' }), 'блок 2/3 · итераций: 4 · ≈$0.00 · обновляю саммари тега front…');
  assert.equal(runBlocks({ ...report(), blocks: undefined as unknown as BlockReport[] })[0]!.name, undefined);
});

test('лимит правится у живого цикла до конца блока; «Продолжить» — по серверу, без поля — старое правило', () => {
  assert.equal(limitEditable({ live: true }, block('main')), true);
  assert.equal(limitEditable({ live: true }, block('main', { status: 'done' })), false);
  assert.equal(limitEditable({ live: false }, block('main')), false);
  assert.equal(limitEditable({ live: true }, { ...block('main'), name: undefined }), false);
  assert.equal(continueVisible({ ...st({}, false).run, continuable: true }), true);
  assert.equal(continueVisible({ ...st({ status: 'failed', blocks: [block('a', { status: 'done' })] }, false).run }), true);
  assert.equal(continueVisible({ ...st({ status: 'done', blocks: [block('a', { status: 'done' })] }, false).run }), false);
});

test('подсказка паузы: без артефактов, с артефактом решений, с артефактами без решений', () => {
  const s = st({ pause: 'paused', pauseReason: { block: 'main', iteration: 2, phase: 'plan', text: 'реши', output: 'o' } });
  assert.match(pauseHint(s.run, false)!.text, /^Паузу попросил этап «plan» \(итерация 2\): дальше нужен твой ответ\. Запиши решение/);
  s.run.artifacts = { items: [{ key: 'dec', title: 'Решения', file: 'd.md', size: 0, hash: '', mtimeMs: 0, decisions: true, versions: [] }], warnings: [] };
  assert.match(pauseHint(s.run, true)!.text, /допишется в артефакт «Решения»/);
  s.run.artifacts.items[0]!.decisions = undefined;
  assert.deepEqual(pauseHint(s.run, true), { text: 'Паузу попросил этап «plan» (итерация 2): дальше нужен твой ответ. Поправь артефакты и нажми «Возобновить».', openArtifacts: true });
  assert.equal(pauseHint(st().run, true), null);
});

test('сводка итерации: время группы — по самому долгому, ошибки, стоимость, вердикт или «идёт»', () => {
  const ps = [phase('a', 1, { group: 'g', durationMs: 3000 }), phase('b', 1, { group: 'g', durationMs: 5000, ok: false }), phase('c', 1, { durationMs: 2000 })];
  assert.deepEqual(iterSummary(ps, cond(1), false).map((p) => p.text), ['этапов 3', 'с ошибкой 1', '7с', '$0.35', '↻ условие не выполнено']);
  assert.deepEqual(iterSummary([], cond(1, { done: true }), true).map((p) => p.text), ['этапов 0', '$0.05', '⏳ идёт']);
  assert.deepEqual(iterSummary([], cond(1, { type: 'none', costUsd: 0 }), false).map((p) => p.text), ['этапов 0']);
});

test('этапы по итерациям: последняя итерация раскрыта, прошлые свёрнуты; идущий этап, отвеченный вопрос, условие', () => {
  const s = st({ iterations: 2, blocks: [block('main', { iterations: 2 })], phases: [phase('a', 1), phase('a', 2)], conditions: [cond(1)] });
  s.run.questions.push({ id: 'q', block: 'main', iteration: 2, phase: 'a', title: 'a', questions: [], askedAt: '', answers: { x: 'y' } });
  pend(s, { phase: 'b', iteration: 2, index: 1 });
  s.condPending = null;
  const { items, keys, unfold } = runSteps(s, fold());
  assert.deepEqual(items.map((i) => i.kind), ['iter', 'iter', 'phase', 'answered', 'running']);
  assert.deepEqual(keys, ['i:0:1', 'i:0:2']);
  assert.equal(unfold, false);
  const running = items.at(-1);
  assert.equal(running?.kind === 'running' && running.doing, 'выполняется…');
  // ручная свёртка и «ранние итерации»
  const f = fold();
  f.over.set('i:0:1', true);
  assert.deepEqual(runSteps(s, f).items.map((i) => i.kind), ['iter', 'phase', 'cond', 'iter', 'phase', 'answered', 'running']);
  const long = st({ iterations: 7, blocks: [block('main', { iterations: 7 })] });
  assert.deepEqual(runSteps(long, fold()).items.slice(0, 2).map((i) => (i.kind === 'older' ? `older ${i.to}` : i.kind)), ['older 2', 'iter']);
});

test('несколько блоков: текущий раскрыт, свёрнутый показывает стоимость; on_fail: continue; пауза — «пауза после группы»', () => {
  const s = st({
    blocks: [block('a', { status: 'max_iterations', onFail: 'continue', iterations: 1 }), block('b', { index: 1, iterations: 1 })],
    phases: [phase('x', 1, { block: 'a' }), phase('y', 1, { block: 'b' })], conditions: [cond(1, { block: 'a' })], pause: 'requested',
  });
  pend(s, { block: 'b', phase: 'z', index: 1 });
  pend(s, { block: 'b', phase: 'w', index: 2 });
  const { items } = runSteps(s, fold());
  const head = items[0]!;
  assert.equal(head.kind === 'block' && `${head.label} ${head.open} ${head.cost.toFixed(2)}`, 'Блок 1 · a false 0.15');
  assert.equal(items[1]!.kind, 'onfail');
  const runningItems = items.filter((i) => i.kind === 'running');
  assert.equal(runningItems[0]?.kind === 'running' && runningItems[0].doing, 'выполняется… пауза после группы');
});

test('лента: повторы одного замечания — группа ×N, «буксует» от 5 подряд, «впереди» до лимита; блок без цикла — цепочка', () => {
  const conds = [1, 2, 3, 4, 5, 6].map((it) => cond(it, { feedback: `нет тестов в строке ${it * 10}` }));
  const s = st({ iterations: 6, blocks: [block('main', { iterations: 6, maxIterations: 8 })], conditions: conds });
  const bs = blockIters(s, 0, null);
  assert.equal(bs.groups.length, 1);
  assert.deepEqual([bs.stuck?.from, bs.stuck?.to], [1, 6]);
  const [row] = ribbonRows(s, fold(), null);
  assert.equal(row?.strip?.total, 8);
  assert.deepEqual(row?.cells?.map((c) => [c.st, c.label, c.stuck]), [['fail', '✕ судья ×6', true], ['future', '', false], ['future', '', false]]);
  assert.equal(row?.cells?.[0]?.title, 'Итерации 1–6: одно и то же замечание. Показать последнюю');
  const multi = st({ blocks: [block('a', { looped: false, iterations: 1, status: 'done' }), block('b', { index: 1, status: 'pending', iterations: 0 })], phases: [phase('x', 1, { block: 'a' })] });
  const rows = ribbonRows(multi, fold(), [{ phases: [{ name: 'x', title: 'Икс' }, { name: 'y' }] }, { phases: [] }]);
  assert.deepEqual(rows[0]?.chain?.map((c) => `${c.mark} ${c.title}`), ['✓ Икс', '○ y']);
  assert.equal(rows[0]?.head?.note, 'один проход');
  assert.equal(rows[1]?.head?.note, '↺ до 3');
});

test('сводка живого: своё «сейчас», последний вердикт, буксует, ждёт ответа', () => {
  const s = st({ conditions: [cond(1, { summary: 'тесты падают' })] });
  pend(s, { phase: 'build', title: 'Сборка' });
  const v = summaryView(s, '', null, new Date('2026-10-24T10:02:05Z').getTime());
  assert.equal(v.now, 'Итерация 1/3 · этап «Сборка»');
  assert.deepEqual(v.last, { ok: false, text: 'Итерация 1 не прошла: тесты падают' });
  assert.equal(v.facts, 'итераций 1 · ≈$0.00 · 2м 5с');
  assert.equal(summaryView(s, 'итерация 2/5 · этап «x»', null).now, 'Итерация 2/5 · этап «x»');
  const ok = st({ conditions: [cond(1, { done: true, detail: 'exit 0' })] });
  assert.deepEqual(summaryView(ok, '', null).last, { ok: true, text: 'Итерация 1: условие выполнено — exit 0' });
});

test('итог: цифры, замечания последнего условия только при неуспехе, строки тегов', () => {
  const r = report({ status: 'max_iterations', iterations: 2, totalCostUsd: 1, finishedAt: '2026-10-24T10:01:30Z', conditions: [cond(1), cond(2, { feedback: 'ещё' })] });
  assert.deepEqual(finalFacts(r), ['итераций: 2', '≈$1.00', '1м 30с']);
  assert.equal(finalFeedback(r)?.iteration, 2);
  assert.equal(finalFeedback({ ...r, status: 'done' }), undefined);
  const tags = tagFinalLines({ tags: ['a', 'b', 'c'], tagSummaries: [{ tag: 'a', ok: true, costUsd: 0.1 }, { tag: 'b', ok: false, costUsd: 0, error: 'сбой' }], autoTag: { slug: 'a', costUsd: 0 } });
  assert.deepEqual(tags.lines.map((l) => [l.state, l.text, l.auto]), [
    ['ok', 'Саммари тега обновлено', true], ['error', 'Саммари тега не обновлено: сбой', false], ['skip', 'Саммари тега не обновлено', false],
  ]);
  assert.equal(tagFinalLines({ autoTag: { error: 'нет имени', costUsd: 0 } }).autoTagError, 'нет имени');
});

test('чипы карточки: модель и effort; контекст готового и идущего этапа', () => {
  assert.equal(phaseModelChip({}), null);
  assert.deepEqual(phaseModelChip({ effort: 'high' }), { label: 'high', title: 'Модель: не задана (по умолчанию) · effort: high' });
  const done = ctxChipInfo({ tokens: { contextStart: 1000, contextPeak: 172000, requests: 4, contextWindow: 1000000 } }, false);
  assert.equal(done?.text, 'ctx 172k / 1M · 17%');
  assert.equal(done?.title.split('\n')[0], 'Контекст этапа: пик 172k / 1M · 17%');
  const live = ctxChipInfo({ ctx: { peak: 185000, requests: 2, window: 200000 } }, true);
  assert.deepEqual([live?.level, live?.title], ['crit', 'Контекст этапа: пик 185k / 200k · 93%\nзапросов к модели: 2']);
  assert.equal(ctxChipInfo({ ctx: { peak: 90000, requests: 0 } }, true)?.title, 'Контекст этапа: пик 90k (окно модели неизвестно)');
  assert.equal(ctxChipInfo({}, true), null);
});

test('окно файла: markdown, кроме транскрипта, лога и JSON-вывода', () => {
  assert.equal(fileIsMarkdown('a.prompt.md', '# Привет'), true);
  assert.equal(fileIsMarkdown('a.transcript.md', '# Привет'), false);
  assert.equal(fileIsMarkdown('cond.log', 'x'), false);
  assert.equal(fileIsMarkdown('a.output.md', '{"a":1}'), false);
  assert.equal(fileIsMarkdown('a.output.md', 'текст'), true);
});

test('инспектор этапа: идёт, вход итерации из прошлых замечаний, файлы без вывода; готовый — история и сессия', () => {
  const s = st({ iterations: 2, phases: [phase('a', 1, { sessionId: 's1' })], conditions: [cond(1, { summary: 'не хватает тестов' })] });
  pend(s, { phase: 'a', iteration: 2, at: 1000, files: { prompt: 'p2', transcript: 't2', output: 'o2' } });
  const v = inspectView(s, { kind: 'phase', key: 'p:main:a', block: 'main', name: 'a' }, [{ phases: [{ name: 'a', title: 'Этап А', model: 'haiku' }] }], 61000);
  assert.equal(v.kind, 'phase');
  if (v.kind !== 'phase') return;
  assert.deepEqual([v.title, v.status.text, v.meta], ['Этап А', '● идёт · 1м 0с', ['итер. 2', 'haiku']]);
  assert.equal(v.input?.text, 'Итог итерации 1: не хватает тестов');
  assert.deepEqual(v.files.map((f) => f.title), ['Промпт · a', 'Транскрипт · a']);
  s.pending.clear();
  s.run.phases.push(phase('a', 2, { ok: false, subtype: 'error_max_turns', errors: ['стоп'] }));
  const d = inspectView(s, { kind: 'phase', key: 'p:main:a', block: 'main', name: 'a' }, undefined);
  if (d.kind !== 'phase') return assert.fail();
  assert.deepEqual([d.status.text, d.last?.text, d.last?.errors, d.hist.length], ['! ошибка', '3 ходов · 1с · $0.10 · error_max_turns', 'стоп', 2]);
  assert.equal(d.files[1]?.session, '');
  const c = inspectView(s, { kind: 'cond', key: 'c:main', block: 'main' }, [{ phases: [], loop: { until: { type: 'command', run: 'npm test' } } }]);
  assert.deepEqual(c.kind === 'cond' && [c.status.text, c.meta], ['✕ не выполнено', 'команда · $ npm test · итер. 1']);
});

test('переход из графа: ещё не выполнялся, карточка последней итерации, раскрыть блок и итерацию', () => {
  const s = st({ blocks: [block('a', { iterations: 2 }), block('b', { index: 1, iterations: 0, status: 'pending' })], phases: [phase('x', 1, { block: 'a' }), phase('x', 2, { block: 'a' })] });
  assert.deepEqual(gotoTarget(s, { kind: 'phase', key: '', block: 'b', name: 'y' }, false), { msg: 'Этап «y» ещё не выполнялся' });
  assert.deepEqual(gotoTarget(s, { kind: 'phase', key: '', block: 'a', name: 'x' }, false), { open: ['b:0', 'i:0:2'], target: 'a|2|x', bi: 0 });
  assert.deepEqual(gotoTarget(s, { kind: 'cond', key: '', block: 'a' }, false), { msg: 'Условие ещё не проверялось' });
  assert.deepEqual(gotoTarget(s, { kind: 'block', key: '', block: 'b' }, false), { open: ['b:1'], target: null, bi: 1 });
  assert.deepEqual(nodeFromKey('p:main:build'), { kind: 'phase', block: 'main', name: 'build', key: 'p:main:build' });
  assert.deepEqual(nodeFromKey('c:'), { kind: 'cond', block: '', key: 'c:' });
  assert.equal(nodeFromKey('start'), null);
});

test('чат: разметка с экранированием, строка над чатом', () => {
  assert.equal(chatText('a <b> `x` **ж**\n```js\ncode\n```'), 'a &lt;b&gt; <code>x</code> <b>ж</b>\n<pre>code</pre>');
  assert.equal(chatMeta([{ role: 'user' }, { role: 'note' }, { role: 'assistant' }], 0.5, true), 'сообщений 2 · потрачено $0.50 · агент отвечает…');
  assert.equal(chatMeta([], 0, false), '');
});
