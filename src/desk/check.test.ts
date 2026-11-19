// Сверка «N из N» (check.ts): строки из итогов источников рутин и наблюдателей, «обычно N в день», порядок.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CheckResult, SourceView } from '../routines/types.js';
import { deskCheck, usualPerDay } from './check.js';
import { deskRoute } from './routes.js';
import { openStore } from './store.js';
import type { DeskCheckReply } from './types.js';

const START = new Date('2026-11-19T08:00:00.000Z');

function view(slug: string, status: SourceView['status'], check?: CheckResult, more: Partial<SourceView> = {}): SourceView {
  return { slug, spec: { title: slug.toUpperCase(), kind: 'gitlab', config: {} }, status, ...(check ? { check } : {}), missingSecrets: [], usedBy: ['r'], canReply: false, ...more };
}

test('источники: idle не в сверке, сломанное наверх, наблюдатели последней строкой', () => {
  const ok: CheckResult = { at: '2026-11-19T09:12:00.000Z', ok: true, total: 14, fresh: 2 };
  const bad: CheckResult = { at: '2026-11-19T09:10:00.000Z', ok: false, total: 0, fresh: 0, error: 'ключ не принят' };
  const r = deskCheck({
    sources: [view('gitlab', 'ok', ok), view('slack', 'idle'), view('jira', 'error', bad, { error: 'ключ не принят' }), view('meet', 'unchecked'), view('tw', 'needs_secret')],
    watcher: { at: '2026-11-19T09:15:00.000Z', ok: true, total: 3, fresh: 1 },
    startedAt: START,
  });
  assert.deepEqual(r.sources.map((s) => [s.slug, s.kind, s.status]), [
    ['jira', 'source', 'error'],
    ['tw', 'source', 'needs_secret'],
    ['meet', 'source', 'unchecked'],
    ['gitlab', 'source', 'ok'],
    ['desk', 'watcher', 'ok'],
  ]);
  assert.equal(r.sources[0].error, 'ключ не принят');
  assert.equal(r.sources[0].title, 'JIRA');
  assert.deepEqual(r.sources[3].result, ok);
  assert.equal(r.sources[2].result, undefined);
  // время сверки — самая свежая проверка
  assert.equal(r.at, '2026-11-19T09:15:00.000Z');
});

test('наблюдатели: итог с прошлого запуска приложения — «не проверялось», нет итога — тоже', () => {
  const old: CheckResult = { at: '2026-11-18T20:00:00.000Z', ok: true, total: 3, fresh: 0 };
  let w = deskCheck({ watcher: old, startedAt: START }).sources[0];
  assert.deepEqual([w.kind, w.status, w.result?.at], ['watcher', 'unchecked', old.at]);
  w = deskCheck({ startedAt: START }).sources[0];
  assert.deepEqual([w.status, w.result], ['unchecked', undefined]);
  const r = deskCheck({ startedAt: START });
  assert.equal(r.at, undefined);
  w = deskCheck({ watcher: { at: '2026-11-19T09:00:00.000Z', ok: false, total: 4, fresh: 0, error: 'не снято 1 из 4: нет доступа' }, startedAt: START }).sources[0];
  assert.deepEqual([w.status, w.error], ['error', 'не снято 1 из 4: нет доступа']);
});

test('«обычно N в день»: по приходам нового, мало данных — нет', () => {
  assert.equal(usualPerDay([]), undefined);
  assert.equal(usualPerDay(['2026-11-01T09:00:00Z', '2026-11-05T09:00:00Z']), undefined);
  // три прихода за пару часов — меньше суток, не «обычно»
  assert.equal(usualPerDay(['2026-11-01T09:00:00Z', '2026-11-01T10:00:00Z', '2026-11-01T11:00:00Z']), undefined);
  // 7 приходов за 2 дня — 3 в день
  const a = Array.from({ length: 7 }, (_, i) => new Date(Date.parse('2026-11-01T00:00:00Z') + i * 8 * 3600_000).toISOString());
  assert.equal(usualPerDay(a), 3);
  // порядок и мусор не мешают: 3 прихода за 10 дней — 0,2 в день
  assert.equal(usualPerDay(['2026-11-11T00:00:00Z', 'x', '2026-11-01T00:00:00Z', '2026-11-06T00:00:00Z']), 0.2);
});

test('usual — у источника с приходами; без arrivals поля нет', () => {
  const a = ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z'];
  const s = view('gitlab', 'empty', { at: '2026-11-19T09:00:00.000Z', ok: true, total: 0, fresh: 0, emptySince: '2026-11-03T00:00:00Z' });
  assert.equal(deskCheck({ sources: [s], arrivals: () => a, startedAt: START }).sources[0].usual, 1);
  assert.equal(deskCheck({ sources: [s], startedAt: START }).sources[0].usual, undefined);
});

test('GET /api/desk/check: из deps.check, без него — только наблюдатели из desk/check.json', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-desk-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  store.writeCheck({ at: new Date().toISOString(), ok: true, total: 2, fresh: 0 });
  let r = await deskRoute('GET', new URL('http://x/api/desk/check'), async () => undefined, { store });
  assert.equal(r?.status, 200);
  const body = r!.body as DeskCheckReply;
  assert.deepEqual(body.sources.map((s) => [s.slug, s.status]), [['desk', 'ok']]);
  const reply: DeskCheckReply = { sources: [], at: 'x' };
  r = await deskRoute('GET', new URL('http://x/api/desk/check'), async () => undefined, { store, check: () => reply });
  assert.equal(r!.body, reply);
  r = await deskRoute('POST', new URL('http://x/api/desk/check'), async () => ({}), { store });
  assert.equal(r?.status, 404);
});

test('источник: итог с прошлого запуска — «не проверялось»; не нужен рутинам (черновик без ключа) — не в сверке', () => {
  const old: CheckResult = { at: '2026-11-18T20:00:00.000Z', ok: true, total: 14, fresh: 0 };
  const r = deskCheck({
    sources: [view('gitlab', 'ok', old), view('meet', 'empty', { ...old, emptySince: '2026-11-10T00:00:00Z' }), view('draft', 'needs_secret', undefined, { usedBy: [] }), view('bad', 'error', undefined, { usedBy: [] })],
    startedAt: START,
  });
  assert.deepEqual(r.sources.map((s) => [s.slug, s.status, s.result?.at]), [
    ['gitlab', 'unchecked', old.at],
    ['meet', 'unchecked', old.at],
    ['desk', 'unchecked', undefined],
  ]);
});
