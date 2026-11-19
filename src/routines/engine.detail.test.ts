// Подробности события (config.detail у источника-команды): вторая команда для одного события перед запуском flow —
// flow получает полную запись целиком, а не только то, что было в списке.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandKind } from './command.js';
import { detailBlock, eventBlock, EVENT_DETAIL_MAX, RoutineEngine, type RoutineRunRequest } from './engine.js';
import { routinesRoute } from './routes.js';
import { RoutineStore } from './store.js';
import type { EventDetail, RoutineEvent } from './types.js';

type Call = { cmd: string; env: Record<string, string> };

function setup(o: { detail?: string | false; detailOut?: () => { code: number; stdout: string; stderr?: string } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-detail-'));
  const store = new RoutineStore(root);
  const calls: Call[] = [];
  const started: RoutineRunRequest[] = [];
  const list: Array<Record<string, unknown>> = [];
  const engine = new RoutineEngine({
    jiraHosts: () => [],
    store,
    kinds: () => [commandKind],
    startRun: async (r) => (started.push(r), `run-${started.length}`),
    resumeRun: () => {},
    stopRun: () => {},
    flowBlocks: (n) => (n === 'demo' ? ['fix'] : undefined),
    now: () => new Date('2026-11-17T10:00:00.000Z'),
    timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    check: async () => ({ match: true, duplicate: false, reason: 'да', costUsd: 0 }),
    run: async (cmd, opts) => {
      calls.push({ cmd, env: opts.env });
      if (cmd === 'list') return { code: 0, stdout: JSON.stringify(list), stderr: '' };
      const r = o.detailOut?.() ?? { code: 0, stdout: `Аня: привет\nБорис: ${opts.env.EVENT_ID}\n` };
      return { stderr: '', ...r };
    },
  });
  store.writeSource('src', {
    title: 'Встречи',
    kind: 'command',
    config: { command: 'list', ...(o.detail === false ? {} : { detail: o.detail ?? 'one' }) },
    map: { id: 'id', title: 'title', text: 'summary', link: 'url', at: 'date' },
    secrets: ['API_KEY'],
  });
  store.setSecrets({ API_KEY: 'sekret-123' });
  store.setLastCheck('src', '2026-11-17T09:00:00.000Z');
  const meeting = (id: string) => ({ id, title: `Встреча ${id}`, summary: 'коротко', url: `http://m/${id}`, date: '2026-11-17T10:00:05.000Z' });
  const routine = (mode: 'auto' | 'suggest' = 'auto') => engine.saveRoutine('r', { spec: { title: 'Р', when: { source: 'src' }, run: { flow: 'demo' }, mode } });
  const poll = async (...ids: string[]) => {
    list.push(...ids.map(meeting));
    await engine.pollSource('src');
    await engine.idle();
  };
  return { root, store, engine, calls, started, routine, poll, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('подробности события: перед запуском источник дозапрашивает запись, flow получает её целиком после события', async () => {
  const t = setup();
  try {
    t.routine();
    await t.poll('m1');
    assert.equal(t.started.length, 1);
    const block = t.started[0]!.eventBlock;
    assert.ok(block.startsWith('Событие:\n<source-data>'));
    assert.match(block, /Заголовок: Встреча m1/);
    assert.match(block, /\n\nПодробности события — полная запись из источника:\n<source-data>\nАня: привет\nБорис: m1\n<\/source-data>$/);
    // команда подробностей получает событие и ключи переменными окружения, в текст команды событие не вставляется
    const one = t.calls.find((c) => c.cmd === 'one')!;
    assert.deepEqual(one.env, { API_KEY: 'sekret-123', EVENT_ID: 'm1', EVENT_LINK: 'http://m/m1', EVENT_TITLE: 'Встреча m1' });
    assert.equal(t.calls.filter((c) => c.cmd === 'one').length, 1);
  } finally {
    t.done();
  }
});

test('подробности события: запрашиваются только для события, которое дошло до запуска', async () => {
  const t = setup();
  try {
    t.engine.saveRoutine('r', { spec: { title: 'Р', when: { source: 'src', match: { title: 'Встреча m2' } }, run: { flow: 'demo' }, mode: 'suggest' } });
    await t.poll('m1', 'm2');
    // m1 отсеяли условия, m2 ждёт «Запустить?» — команда подробностей ещё не звалась
    assert.equal(t.calls.filter((c) => c.cmd === 'one').length, 0);
    await t.engine.waitAction(t.engine.waits()[0]!.id, { action: 'run' });
    assert.deepEqual(t.calls.filter((c) => c.cmd === 'one').map((c) => c.env.EVENT_ID), ['m2']);
    assert.match(t.started[0]!.eventBlock, /Борис: m2/);
  } finally {
    t.done();
  }
});

test('подробности события: не настроены — вход flow прежний, второй команды нет', async () => {
  const t = setup({ detail: false });
  try {
    t.routine();
    await t.poll('m1');
    assert.equal(t.started[0]!.eventBlock.includes('Подробности события'), false);
    assert.deepEqual(t.calls.map((c) => c.cmd), ['list']);
    assert.equal(t.engine.sourceViews()[0]!.detail, undefined);
  } finally {
    t.done();
  }
});

test('подробности события: не получены — запуск не начинается, событие ждёт повтора с причиной без ключа', async () => {
  const t = setup({ detailOut: () => ({ code: 22, stdout: '', stderr: 'curl: 401 для sekret-123' }) });
  try {
    t.routine();
    await t.poll('m1');
    assert.equal(t.started.length, 0);
    const row = t.engine.logOf('r', {})[0]!;
    assert.equal(row.outcome, 'limit');
    assert.match(row.reason ?? '', /запуск не начался: подробности события не получены: Команда подробностей завершилась с кодом 22/);
    assert.equal((row.reason ?? '').includes('sekret-123'), false);
    assert.equal(t.store.queue().length, 1);
  } finally {
    t.done();
  }
});

test('подробности события: пустой ответ команды — ошибка, а не запуск без записи', async () => {
  const t = setup({ detailOut: () => ({ code: 0, stdout: '  \n' }) });
  try {
    t.routine();
    await t.poll('m1');
    assert.equal(t.started.length, 0);
    assert.match(t.engine.logOf('r', {})[0]!.reason ?? '', /ничего не напечатала/);
  } finally {
    t.done();
  }
});

test('подробности события: длиннее предела — обрезаны с пометкой', () => {
  const long = 'я'.repeat(EVENT_DETAIL_MAX + 10);
  const block = detailBlock(long);
  assert.match(block, new RegExp(`обрезано: первые ${EVENT_DETAIL_MAX} знаков из ${EVENT_DETAIL_MAX + 10}`));
  assert.equal(block.includes('я'.repeat(EVENT_DETAIL_MAX + 1)), false);
  const e: RoutineEvent = { source: 's', id: '1', at: '2026-11-17T10:00:00.000Z', title: 'T', text: '', fields: {} };
  assert.equal(eventBlock(e, ''), eventBlock(e));
});

test('подробности события: источник помечен, «Получит» показывает их тем же запросом без запуска', async () => {
  const t = setup();
  try {
    assert.equal(t.engine.sourceViews()[0]!.detail, true);
    const call = (url: string, body: unknown) => routinesRoute('POST', new URL(url, 'http://localhost'), async () => body, { engine: t.engine, drafts: null });
    const got = (await call('/api/routines/sources/src/detail', { id: 'm7', link: 'http://m/m7', title: 'Встреча' }))?.body as EventDetail;
    assert.equal(got.block, detailBlock('Аня: привет\nБорис: m7'));
    assert.equal(got.chars, 'Аня: привет\nБорис: m7'.length);
    assert.equal(got.max, EVENT_DETAIL_MAX);
    assert.equal(t.started.length, 0);
    assert.equal((await call('/api/routines/sources/src/detail', {}))?.status, 400);
    assert.equal((await call('/api/routines/sources/nope/detail', { id: '1' }))?.status, 404);
  } finally {
    t.done();
  }
});

test('подробности события: «Получит» отдаёт ошибку команды текстом, источник без подробностей — 400', async () => {
  const bad = setup({ detailOut: () => ({ code: 1, stdout: '', stderr: 'нет доступа' }) });
  const none = setup({ detail: false });
  try {
    const got = await bad.engine.detailPreview('src', { id: 'm1' });
    assert.match(got.error ?? '', /подробности события не получены: .*нет доступа/);
    assert.equal(got.block, undefined);
    await assert.rejects(none.engine.detailPreview('src', { id: 'm1' }), (e: Error & { status?: number }) => e.status === 400);
  } finally {
    bad.done();
    none.done();
  }
});
