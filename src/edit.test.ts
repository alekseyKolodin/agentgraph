import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EDITOR_SYSTEM, editFlow } from './edit.js';
import type { FlowAiStage } from './api-types.js';
import type { runSession, SessionEvent, SessionRequest, SessionResult } from './agent.js';

const BASE = `name: demo
description: d
phases:
  - name: work
    tools: [Read]
    prompt: "Задача: {{input}}"
`;
const EDITED = BASE.replace('tools: [Read]', 'tools: [Read, Grep]');
// не проходит валидацию: у этапа нет prompt
const BROKEN = BASE.replace(/    prompt: .*\n/, '');

/** Поддельная сессия правки: пишет в flow.yaml рабочей папки очередной текст из files, как агент инструментом Edit. */
function fakeEditor(files: string[], during?: (call: number) => void): typeof runSession & { calls: SessionRequest[] } {
  const calls: SessionRequest[] = [];
  const fn = async (req: SessionRequest, log: (line: string) => void): Promise<SessionResult> => {
    calls.push(req);
    req.onModel?.('claude-haiku-test');
    const retry: SessionEvent = { kind: 'retry', attempt: 2, maxRetries: 10, delayMs: 4000, status: 529 };
    req.onEvent?.(retry);
    log('▸ Edit {"file_path":"flow.yaml"}');
    fs.writeFileSync(path.join(req.cwd, 'flow.yaml'), files[calls.length - 1] ?? files.at(-1)!);
    during?.(calls.length);
    return { ok: true, subtype: 'success', text: '- этап work: добавлен Grep', costUsd: 0.1, turns: 3, durationMs: 5, errors: [], model: 'claude-haiku-test' };
  };
  return Object.assign(fn, { calls });
}

test('правка отдаёт ход сессии и шаг «правка»', async () => {
  const stages: FlowAiStage[] = [];
  const models: string[] = [];
  const events: SessionEvent[] = [];
  const lines: string[] = [];
  const session = fakeEditor([EDITED]);
  const r = await editFlow('demo', 'добавь Grep', { yaml: BASE }, {
    onStage: (s) => stages.push(s), onModel: (m) => models.push(m), onEvent: (e) => events.push(e), log: (l) => lines.push(l), deps: { session },
  });
  assert.deepEqual(stages, [{ kind: 'edit' }]);
  assert.deepEqual(models, ['claude-haiku-test']);
  assert.equal(events[0]?.kind, 'retry');
  assert.equal(lines.length, 1);
  assert.equal(r.changed, true);
  assert.deepEqual(r.spec.phases?.[0]?.tools, ['Read', 'Grep']);
});

test('правка возвращает модель, длительность и цену всех сессий', async () => {
  const r = await editFlow('demo', 'добавь Grep', { yaml: BASE }, { model: 'claude-haiku-4-5-20251001', deps: { session: fakeEditor([BROKEN, EDITED]) } });
  assert.equal(r.model, 'claude-haiku-test');
  assert.equal(typeof r.durationMs, 'number');
  assert.ok(r.durationMs >= 0);
  assert.equal(r.costUsd, 0.2);
});

test('починка после невалидной правки идёт шагами «исправляю ошибки валидации N/2»', async () => {
  const stages: FlowAiStage[] = [];
  const session = fakeEditor([BROKEN, BROKEN, EDITED]);
  const r = await editFlow('demo', 'добавь Grep', { yaml: BASE }, { onStage: (s) => stages.push(s), deps: { session } });
  assert.deepEqual(stages, [{ kind: 'edit' }, { kind: 'repair', attempt: 1, of: 2 }, { kind: 'repair', attempt: 2, of: 2 }]);
  assert.equal(session.calls.length, 3);
  assert.match(session.calls[1]!.prompt, /не проходит валидацию/);
  assert.equal(r.changed, true);
});

test('после двух неудачных починок — ошибка валидации, третьей не будет', async () => {
  const session = fakeEditor([BROKEN]);
  await assert.rejects(editFlow('demo', 'добавь Grep', { yaml: BASE }, { deps: { session } }), /не проходит валидацию/);
  assert.equal(session.calls.length, 3);
});

test('abort во время правки останавливает и починки', async () => {
  const abort = new AbortController();
  const stages: FlowAiStage[] = [];
  // правка сломала flow, и тут пользователь нажал «Прервать»: починка (новая платная сессия) не начинается
  const session = fakeEditor([BROKEN, EDITED], () => abort.abort());
  await assert.rejects(editFlow('demo', 'добавь Grep', { yaml: BASE }, { abort, onStage: (s) => stages.push(s), deps: { session } }), /Правка прервана/);
  assert.equal(session.calls.length, 1);
  assert.deepEqual(stages, [{ kind: 'edit' }]);
});

test('прерванная до старта правка не запускает ни одной сессии', async () => {
  const abort = new AbortController();
  abort.abort();
  const stages: FlowAiStage[] = [];
  const session = fakeEditor([EDITED]);
  await assert.rejects(editFlow('demo', 'добавь Grep', { yaml: BASE }, { abort, onStage: (s) => stages.push(s), deps: { session } }), /Правка прервана/);
  assert.equal(session.calls.length, 0);
  assert.deepEqual(stages, []);
});

test('выбранная модель уходит в каждую сессию правки', async () => {
  const session = fakeEditor([BROKEN, EDITED]);
  await editFlow('demo', 'добавь Grep', { yaml: BASE }, { model: 'claude-sonnet-5-5', deps: { session } });
  assert.deepEqual(session.calls.map((c) => c.model), ['claude-sonnet-5-5', 'claude-sonnet-5-5']);
});

test('редактор знает блоки-вызовы и next: не трогает их без запроса и не добавляет вызову этапы', () => {
  assert.match(EDITOR_SYSTEM, /Call block: instead of phases a block may have "flow"/);
  assert.match(EDITOR_SYSTEM, /Keep call blocks \("flow", "input"\) and every "next" exactly as they are unless the request is about them; never add phases to a call block/);
});
