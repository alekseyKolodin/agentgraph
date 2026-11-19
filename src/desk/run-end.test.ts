// Конец запуска → дело: какой итог какое дело заводит, ключ цепочки, закрытие при открытии страницы, оборвавшиеся запуски.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PhaseReport, RunReport } from '../api-types.js';
import { openDesk } from './index.js';
import { endedAt, noteRunEnd, runItemKey, runRef, runSeen, stageOf, sweepInterrupted } from './run-end.js';

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-run-end-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'desk');
}

const phase = (extra: Partial<PhaseReport> = {}): PhaseReport => ({
  block: 'main', iteration: 1, index: 0, phase: 'tests', title: 'Тесты', tools: [], ok: true, subtype: 'success', costUsd: 0, turns: 1, durationMs: 1000, chars: 0, errors: [], files: {} as PhaseReport['files'], ...extra,
});

const report = (extra: Partial<RunReport> = {}): RunReport => ({
  id: '2026-11-19T10-00-00-aaaa', flow: 'релиз', input: '', cwd: '/tmp/app', status: 'failed', iterations: 1, maxIterations: 3, totalCostUsd: 0.42,
  blocks: [], phases: [], conditions: [], questions: [], runDir: '/tmp/r', startedAt: '2026-11-19T10:00:00.000Z', finishedAt: '2026-11-19T10:05:00.000Z', ...extra,
});

test('упал с ошибкой: дело в «Новом», заголовок, этап и причина, вещь — запуск', async (t) => {
  const d = openDesk(tmp(t));
  const r = report({ error: 'Сборка упала: нет модуля x\nстек…', phases: [phase(), phase({ phase: 'deploy', title: 'Выкладка', ok: false })] });
  assert.equal(await noteRunEnd(d, r, { project: 'shop', continuable: true }), 'failed');
  const [i] = await d.list();
  assert.equal(i.key, `run:${r.id}`);
  assert.equal(i.column, 'new');
  assert.equal(i.title, 'релиз остановился с ошибкой');
  assert.equal(i.why, 'этап «Выкладка» — Сборка упала: нет модуля x');
  assert.equal(i.project, 'shop');
  assert.equal(i.movedBy, 'flow');
  assert.deepEqual(runRef(i), { runId: r.id, flow: 'релиз', status: 'failed', stage: 'этап «Выкладка»', costUsd: 0.42, continuable: true });
});

test('лимиты и обрыв называются словами, не адресом API', async (t) => {
  const d = openDesk(tmp(t));
  await noteRunEnd(d, report({ id: 'a', status: 'budget_exceeded' }));
  await noteRunEnd(d, report({ id: 'b', status: 'max_iterations' }));
  await noteRunEnd(d, report({ id: 'c', status: 'interrupted', error: 'POST /api/runs/c/continue', blocks: [{ index: 0, name: 'main', title: 'Основной', status: 'interrupted' } as RunReport['blocks'][number]] }));
  const why = Object.fromEntries((await d.list()).map((i) => [i.key, i.why]));
  assert.equal(why['run:a'], 'кончился бюджет');
  assert.equal(why['run:b'], 'не уложился в число повторов');
  assert.equal(why['run:c'], 'блок «Основной» — приложение закрылось во время работы');
});

test('повторный конец того же запуска дела не плодит', async (t) => {
  const d = openDesk(tmp(t));
  const r = report({ error: 'бум' });
  await noteRunEnd(d, r);
  await noteRunEnd(d, r);
  const items = await d.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].signals.length, 1);
});

test('готов: «<flow> готов», одна строка итога без разметки', async (t) => {
  const d = openDesk(tmp(t));
  const r = report({ status: 'done', digest: { text: '## Итог\n- **Выложено** на стенд, 3 файла\nещё строка', block: 'main', iteration: 1, at: '2026-11-19T10:05:00.000Z' } });
  assert.equal(await noteRunEnd(d, r, { project: 'shop' }), 'ready');
  const [i] = await d.list();
  assert.equal(i.title, 'релиз готов');
  assert.equal(i.why, 'Итог');
  assert.equal(i.column, 'new');
  assert.equal(runRef(i)?.status, 'done');
});

test('нет сводки — строка итога из последнего шага', async (t) => {
  const d = openDesk(tmp(t));
  await noteRunEnd(d, report({ status: 'done', final: [{ block: 'main', iteration: 1, phase: 'p', title: 'P', ok: true, output: '\nВсё выложено\nподробности' }] }));
  assert.equal((await d.list())[0].why, 'Всё выложено');
});

test('прерван человеком, идущий, дочерний и скрытый запуск — дела нет', async (t) => {
  const d = openDesk(tmp(t));
  for (const extra of [{ status: 'aborted' as const }, { status: 'running' as const }, { parent: { runId: 'p', block: 'b', iteration: 1, flow: 'f' } }, { hidden: true }]) {
    assert.equal(await noteRunEnd(d, report({ id: `x${Math.random()}`, ...extra })), 'skipped');
  }
  assert.equal((await d.list()).length, 0);
});

test('готовый запуск рутины и тот, что смотрят на странице, дела не заводят; упавший рутины — заводит', async (t) => {
  const d = openDesk(tmp(t));
  assert.equal(await noteRunEnd(d, report({ id: 'r1', status: 'done' }), { routine: true }), 'skipped');
  assert.equal(await noteRunEnd(d, report({ id: 'r2', status: 'done' }), { watched: true }), 'skipped');
  assert.equal(await noteRunEnd(d, report({ id: 'r3', error: 'x' }), { routine: true }), 'failed');
  assert.deepEqual((await d.list()).map((i) => i.key), ['run:r3']);
});

test('запуск по делу (links.runs): итог пишет runEnded, второго дела нет', async (t) => {
  const d = openDesk(tmp(t));
  await d.put('own:1', { title: 'Своё', links: { runs: ['r1'] } }, 'me');
  assert.equal(await noteRunEnd(d, report({ id: 'r1', error: 'x' })), 'skipped');
  assert.equal((await d.list()).length, 1);
});

test('продолжение упавшего запуска — то же дело; снова упало — дело то же, ссылка на последний запуск', async (t) => {
  const d = openDesk(tmp(t));
  await noteRunEnd(d, report({ id: 'a', error: 'первая' }));
  const again = report({ id: 'b', root: 'a', error: 'вторая', finishedAt: '2026-11-19T11:00:00.000Z' });
  assert.equal(runItemKey(again), 'run:a');
  await noteRunEnd(d, again, { continuable: true });
  const items = await d.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].why, 'вторая');
  assert.equal(runRef(items[0])?.runId, 'b');
  assert.equal(items[0].signals.length, 2);
});

test('продолжение дошло до конца: дело упавшего закрывается вместе с оригиналом, «готов» не заводится', async (t) => {
  const d = openDesk(tmp(t));
  await noteRunEnd(d, report({ id: 'a', error: 'x' }));
  assert.equal(await noteRunEnd(d, report({ id: 'b', root: 'a', status: 'done' })), 'closed');
  const [i] = await d.list();
  assert.equal(i.column, 'done');
  assert.equal(i.closed?.reason, 'продолжили — запуск дошёл до конца');
  assert.equal((await d.list()).length, 1);
});

test('«Убрать» упавшего и новое падение: дело возвращается в «Новое»', async (t) => {
  const d = openDesk(tmp(t));
  await noteRunEnd(d, report({ id: 'a', error: 'x' }));
  await d.close('run:a', 'убрано', 'me');
  await noteRunEnd(d, report({ id: 'b', root: 'a', error: 'y', finishedAt: '2026-11-19T12:00:00.000Z' }));
  const [i] = await d.list();
  assert.equal(i.column, 'new');
  assert.equal(i.why, 'y');
  assert.equal(i.closed, undefined);
});

test('открыли страницу запуска: «готов» закрывается, упавший — нет', async (t) => {
  const d = openDesk(tmp(t));
  await noteRunEnd(d, report({ id: 'ok1', status: 'done', digest: { text: 'сделано', block: 'm', iteration: 1, at: '' } }));
  await noteRunEnd(d, report({ id: 'bad1', error: 'x' }));
  assert.equal(await runSeen(d, ['bad1']), 0);
  assert.equal((await d.get('run:bad1'))?.column, 'new');
  assert.equal(await runSeen(d, ['ok1']), 1);
  const i = await d.get('run:ok1');
  assert.equal(i?.column, 'done');
  assert.equal(i?.closed?.reason, 'открыт запуск');
  // второй раз и страница запуска без дела — ничего
  assert.equal(await runSeen(d, ['ok1']), 0);
  assert.equal(await runSeen(d, ['unknown']), 0);
});

test('открыли продолжение: дело цепочки находится по первому запуску', async (t) => {
  const d = openDesk(tmp(t));
  await noteRunEnd(d, report({ id: 'first', status: 'done' }));
  assert.equal(await runSeen(d, ['second', 'first']), 1);
});

test('этап: упавший этап, а у многоблочного ещё и блок; без этапов — блок, на котором оборвалось', () => {
  assert.equal(stageOf(report({ phases: [phase({ ok: false, title: 'Тесты' })] })), 'этап «Тесты»');
  const blocks = [{ index: 0, name: 'a', title: 'A', status: 'done' }, { index: 1, name: 'b', title: 'B', status: 'failed' }] as RunReport['blocks'];
  assert.equal(stageOf(report({ blocks, phases: [phase({ ok: false, block: 'b', title: 'Сборка' })] })), 'блок «b», этап «Сборка»');
  assert.equal(stageOf(report({ blocks })), 'блок «B»');
  assert.equal(stageOf(report()), undefined);
});

test('оборвавшийся запуск без finishedAt: время конца — последнее известное, стабильное', () => {
  const r = report({ status: 'interrupted', finishedAt: undefined, phases: [phase({ durationMs: 60_000 })] });
  assert.equal(endedAt(r), '2026-11-19T10:01:00.000Z');
  assert.equal(endedAt(r), endedAt(r));
});

test('обход оборвавшихся: первый раз только запоминает время, старые запуски дел не заводят', async (t) => {
  const dir = tmp(t);
  const d = openDesk(dir);
  const old = report({ id: 'old', status: 'interrupted', finishedAt: undefined });
  const now = new Date('2026-11-19T12:00:00.000Z');
  assert.equal(await sweepInterrupted(d, dir, () => [{ report: old, opts: {} }], () => now), 0);
  assert.equal((await d.list()).length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'runs-since')));
  // после — оборвавшийся позже метки получает дело, старый (до метки) — нет; повтор дела не плодит
  const fresh = report({ id: 'fresh', status: 'interrupted', finishedAt: undefined, startedAt: '2026-11-19T12:30:00.000Z' });
  const reports = () => [{ report: old, opts: {} }, { report: fresh, opts: { project: 'shop' } }, { report: report({ id: 'ok', status: 'done', startedAt: '2026-11-19T12:40:00.000Z' }), opts: {} }];
  assert.equal(await sweepInterrupted(d, dir, reports, () => now), 1);
  // тот же запуск при следующем старте: конец уже учтён — второго дела и второго сигнала нет
  assert.equal(await sweepInterrupted(d, dir, reports, () => now), 0);
  const items = await d.list();
  assert.deepEqual(items.map((i) => i.key), ['run:fresh']);
  assert.equal(items[0].signals.length, 1);
  assert.equal(items[0].project, 'shop');
});

test('обход видит старый оборвавшийся запуск цепочки, а дело уже о продолжении: дело не откатывается', async (t) => {
  const d = openDesk(tmp(t));
  const a = report({ id: 'a', status: 'interrupted', finishedAt: undefined });
  await noteRunEnd(d, a, { continuable: true });
  await noteRunEnd(d, report({ id: 'b', root: 'a', error: 'позже', finishedAt: '2026-11-19T11:00:00.000Z' }));
  assert.equal(await noteRunEnd(d, a, { continuable: true }), 'skipped');
  const i = await d.get('run:a');
  assert.equal(runRef(i!)?.runId, 'b');
  assert.equal(i?.why, 'позже');
});

test('обход двигает метку: следующий не перебирает те же запуски', async (t) => {
  const dir = tmp(t);
  const d = openDesk(dir);
  const now = new Date('2026-11-19T12:00:00.000Z');
  await sweepInterrupted(d, dir, () => [], () => now);
  const later = new Date('2026-11-19T13:00:00.000Z');
  await sweepInterrupted(d, dir, () => [], () => later);
  assert.equal(fs.readFileSync(path.join(dir, 'runs-since'), 'utf8'), later.toISOString());
});
