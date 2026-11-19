import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDesk, runFlow, tallyDesk, type RunOptions } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';
import { DESK_TOOLS_ALLOW } from './desk/tools.js';
import type { DeskApi, DeskBy, DeskItem, DeskPatch } from './desk/types.js';

const result = (text: string, over: Partial<SessionResult> = {}): SessionResult => ({ ok: true, subtype: 'success', text, costUsd: 0.01, turns: 1, durationMs: 10, errors: [], ...over });
const isJudge = (req: SessionRequest) => Boolean(req.outputSchema && 'done' in ((req.outputSchema as { properties?: object }).properties ?? {}));

const spec = {
  name: 'triage',
  input: 'разбери',
  blocks: [{ name: 'one', phases: [{ name: 'work', tools: [], prompt: 'сделай' }], loop: { max_iterations: 1, until: { type: 'judge', prompt: 'ок?' } } }],
} as unknown as FlowSpec;

/** Хранилище в памяти: заводит по ключу, повтор — тот же элемент. */
function memDesk() {
  const items = new Map<string, DeskItem>();
  const puts: { key: string; patch: DeskPatch; by: DeskBy }[] = [];
  let opened = 0;
  const api: DeskApi = {
    async put(key, patch, by) {
      puts.push({ key, patch, by });
      const prev = items.get(key);
      const it: DeskItem = prev ?? {
        id: key, key, kind: patch.kind ?? '', title: patch.title ?? key, column: 'new', why: patch.why ?? '', signals: [], links: { runs: [], sessions: [] }, createdAt: '', movedAt: '', movedBy: by,
      };
      const next = { ...it, signals: [...it.signals, ...(patch.signal ? [patch.signal] : [])], links: { ...it.links, runs: [...it.links.runs, ...(patch.links?.runs ?? [])] } };
      items.set(key, next);
      return next;
    },
    close: async (key, reason) => {
      const it = items.get(key);
      if (!it) return undefined;
      const out = { ...it, closed: { at: '', reason } };
      items.set(key, out);
      return out;
    },
    move: async () => undefined,
    list: async () => [...items.values()],
    get: async (key) => items.get(key),
  };
  return { puts, items, opened: () => opened, open: () => (opened++, api) };
}

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
/** Вызвать инструмент in-process MCP-сервера напрямую (как это сделал бы Agent SDK). */
const callTool = (req: SessionRequest, server: string, name: string, args: Record<string, unknown>) =>
  ((req.mcpServers![server] as unknown as { instance: { _registeredTools: Record<string, { handler: Handler }> } }).instance._registeredTools[name].handler(args, {}));

function withRoot(fn: (o: RunOptions) => Promise<void>) {
  return async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rdesk-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = path.join(root, 'cfg');
    try {
      await fn({ cwd: root, runsDir: root, runDir: path.join(root, 'run') });
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  'дела у этапа flow: сервер desk разрешён без вопроса, запуск и рутина в деле, итог — в report.desk и run.json; у судьи инструментов нет',
  withRoot(async (o) => {
    const d = memDesk();
    const reqs: SessionRequest[] = [];
    const texts: string[] = [];
    const session = async (req: SessionRequest): Promise<SessionResult> => {
      reqs.push(req);
      if (isJudge(req)) return result('', { structured: { done: true, reason: '', feedback: '' } });
      texts.push((await callTool(req, 'desk', 'desk_put', { thing: 'https://gitlab.com/grp/app/-/merge_requests/5', why: 'просят ревью' })).content[0].text);
      texts.push((await callTool(req, 'desk', 'desk_put', { thing: 'mr:gitlab.com/grp/app/5', text: 'ещё раз' })).content[0].text);
      texts.push((await callTool(req, 'desk', 'desk_put', { title: 'Своё' })).content[0].text);
      const bad = await callTool(req, 'desk', 'desk_put', { thing: 'не ключ' });
      assert.equal(bad.isError, true);
      // закрыть можно своё и дело о вещи запуска, чужое — нет
      const foreign = await callTool(req, 'desk', 'desk_close', { thing: 'own:foreign', reason: 'done' });
      texts.push(foreign.content[0].text);
      assert.equal(foreign.isError, true);
      const own = d.puts[2].key;
      assert.equal((await callTool(req, 'desk', 'desk_close', { thing: own, reason: 'сделано' })).isError, undefined);
      return result('out');
    };
    const source = { type: 'routine' as const, key: 'review-slack', title: 'Ревью', thing: { type: 'mr' as const, key: 'mr:gitlab.com/grp/app/5', ref: {}, title: 'Фикс' } };
    // чужое дело: завела сессия, не этот запуск
    await d.open().put('own:foreign', { title: 'Чужое', links: { sessions: ['s1'] } }, 'session');
    d.puts.length = 0;
    const r = await runFlow(spec, { ...o, session, desk: d.open, source });
    assert.equal(r.status, 'done');
    const work = reqs.find((q) => !q.outputSchema)!;
    assert.deepEqual(Object.keys(work.mcpServers ?? {}), ['desk']);
    assert.deepEqual(work.allow, DESK_TOOLS_ALLOW);
    const judge = reqs.find(isJudge)!;
    assert.equal(judge.mcpServers, undefined, 'судье дел не даём');
    assert.match(texts[0], /^Дело заведено: mr:gitlab\.com\/grp\/app\/5/);
    assert.match(texts[1], /^Сигнал добавлен к делу/);
    assert.match(texts[3], /^Дело own:foreign завёл не этот запуск/);
    assert.equal(d.items.get('own:foreign')?.closed, undefined);
    assert.equal(d.items.get(d.puts[2].key)?.closed?.reason, 'сделано');
    assert.equal(d.puts[0].by, 'flow');
    assert.deepEqual(d.puts[0].patch.links?.runs, [r.id]);
    assert.equal(d.puts[0].patch.signal?.source, 'flow');
    assert.equal(d.puts[0].patch.signal?.routine, 'review-slack');
    assert.equal(d.puts[2].patch.why, 'из запуска triage');
    assert.equal(r.desk?.created, 2);
    assert.equal(r.desk?.signals, 1);
    assert.equal(r.desk?.keys.length, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(o.runDir!, 'run.json'), 'utf8')).desk, r.desk);
  }),
);

test(
  'без опции desk у этапа нет инструментов дел и итога; хранилище не открывается, пока инструмент не вызван',
  withRoot(async (o) => {
    const reqs: SessionRequest[] = [];
    const session = async (req: SessionRequest) => (reqs.push(req), isJudge(req) ? result('', { structured: { done: true, reason: '', feedback: '' } }) : result('out'));
    const r = await runFlow(spec, { ...o, session });
    assert.equal(reqs[0].mcpServers, undefined);
    assert.equal(r.desk, undefined);
    const d = memDesk();
    const o2 = { ...o, runDir: path.join(o.runsDir, 'run2') };
    const r2 = await runFlow(spec, { ...o2, session, desk: d.open });
    assert.equal(d.opened(), 0, 'хранилище не открыто');
    assert.equal(r2.desk, undefined);
  }),
);

test('итог дел: новое и повтор считаются отдельно, ключ один раз; итог вызванного flow — в итог родителя', () => {
  let t = tallyDesk(undefined, 'own:a', true);
  t = tallyDesk(t, 'own:a', false);
  t = tallyDesk(t, 'own:b', true);
  assert.deepEqual(t, { created: 2, signals: 1, keys: ['own:a', 'own:b'] });
  assert.deepEqual(addDesk(t, { created: 1, signals: 2, keys: ['own:b', 'own:c'] }), { created: 3, signals: 3, keys: ['own:a', 'own:b', 'own:c'] });
  assert.equal(addDesk(undefined, undefined), undefined);
  assert.deepEqual(addDesk(undefined, { created: 1, signals: 0, keys: ['x'] }), { created: 1, signals: 0, keys: ['x'] });
});
