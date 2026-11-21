// Оркестрация agentgraph у сессии терминала: права (--allowedTools и вопросы хука), раздел среды в контексте, ведение
// пространства без вопроса и новости о запусках сессии.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentgraphNote, handleHook, ORCHESTRATE_ALLOWED_TOOLS, preToolDecision, readSessionCtx, safeRealpath, sessionArgs, sessionContext, sessionReadTargets, sessionSettings,
  type HookDeps, type HookState, type SessionLaunch,
} from './sessions.js';
import { readTag } from './tags.js';
import { readRecord, runNotesText } from './sessions-server.js';
import { createSpace, readSpace } from './spaces.js';

function withConfigDir(fn: () => void) {
  return () => {
    const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-orch-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = cfg;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  };
}

const launch = (o: Partial<SessionLaunch> = {}): SessionLaunch => ({
  id: '11111111-2222-4333-8444-555555555555',
  token: 'tok',
  port: 4755,
  claudeSessionId: '11111111-2222-4333-8444-555555555555',
  resume: false,
  name: 'x',
  addDirs: [],
  denyDirs: [],
  ...o,
});
const flag = (args: string[], f: string) => args[args.indexOf(f) + 1];
const full = (t: string) => `mcp__agentgraph__${t}`;

test('оркестрация: ведение пространства, desk_put и все flow_* — в --allowedTools и без вопроса; настройки пространства, flow_write и session_new — с вопросом', () => {
  const on = sessionArgs(launch({ orchestrate: true }));
  const allowed = flag(on, '--allowedTools').split(',');
  for (const t of ['space_write', 'space_map_write', 'space_state_write', 'desk_put', 'flow_run', 'flow_status', 'flow_answer', 'flow_stop', 'flow_guide']) assert.ok(allowed.includes(full(t)), t);
  for (const t of ['space_settings', 'flow_write', 'session_new', 'knowledge_note', 'desk_close']) assert.ok(!allowed.includes(full(t)), t);
  const settings = sessionSettings(launch({ orchestrate: true })) as { permissions: { ask: string[] }; hooks: { PreToolUse: { matcher: string }[] } };
  assert.ok(!settings.permissions.ask.includes(full('space_map_write')));
  assert.ok(settings.permissions.ask.includes(full('space_settings')));
  // оркестратор запускает flow сам: ни правила ask, ни хука на flow_run
  assert.ok(!settings.permissions.ask.includes(full('flow_run')));
  assert.ok(!settings.hooks.PreToolUse.some((h) => h.matcher === full('flow_run')));
  assert.ok(!settings.hooks.PreToolUse.some((h) => h.matcher === full('space_state_write')));
  // без оркестрации — как раньше
  const off = sessionArgs(launch());
  assert.deepEqual(flag(off, '--allowedTools').split(','), [full('knowledge_read'), full('desk_list')]);
  const plain = sessionSettings(launch()) as { permissions: { ask: string[] } };
  assert.ok(plain.permissions.ask.includes(full('space_map_write')));
});

test('оркестрация: хук PreToolUse не спрашивает о том, что сессия делает сама; остальное — по-прежнему вопрос', () => {
  const input = (tool: string) => ({ hook_event_name: 'PreToolUse', tool_name: full(tool), tool_input: { text: 'x' }, permission_mode: 'acceptEdits' });
  const deps = { autoTools: ORCHESTRATE_ALLOWED_TOOLS, askDetail: () => 'детали' };
  assert.deepEqual(preToolDecision(input('space_state_write'), deps), {});
  const asked = preToolDecision(input('space_settings'), deps) as { hookSpecificOutput: { permissionDecision: string } };
  assert.equal(asked.hookSpecificOutput.permissionDecision, 'ask');
  assert.deepEqual(preToolDecision(input('flow_run'), deps), {});
  const before = preToolDecision(input('space_state_write'), { askDetail: () => 'детали' }) as { hookSpecificOutput: { permissionDecision: string } };
  assert.equal(before.hookSpecificOutput.permissionDecision, 'ask');
});

test('раздел среды: правила ведения пространства (знание, а не журнал), дело сессии и привязка MR, оркестратор через flow', () => {
  const note = agentgraphNote({ space: 'opt' });
  assert.match(note, /Пространство opt — память этой работы/);
  assert.match(note, /Пиши знание, а не журнал/);
  assert.match(note, /desk_put с thing = адрес MR/);
  assert.match(note, /выступай оркестратором/);
  assert.match(agentgraphNote(), /У сессии пока нет пространства/);
});

const deps = (): HookDeps => ({
  readCtx: (space, tags) => readSessionCtx(space, tags, { space: readSpace, tag: readTag }),
  readTargets: (c) => sessionReadTargets(c, '/nowhere/runs'),
  realpath: safeRealpath,
});
const state = (o: Partial<HookState> = {}): HookState => ({ tags: [], injected: null, status: 'starting', claudeSessionIds: [], started: false, turns: 0, ...o });
const ctxText = (r: { reply: Record<string, unknown> }) => ((r.reply.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? '');

test(
  'оркестрация: SessionStart — раздел среды первым, строка пространства «ведёшь ты»; без оркестрации — «только с разрешения»',
  withConfigDir(() => {
    createSpace('opt', { title: 'Оптимизация' });
    const on = ctxText(handleHook(state({ space: 'opt', orchestrate: true }), { hook_event_name: 'SessionStart', source: 'startup' }, deps()));
    assert.match(on, /^Ты работаешь в agentgraph/);
    assert.match(on, /Это пространство ведёшь ты/);
    assert.ok(!on.includes('Меняй, только когда пользователь просит'));
    const off = ctxText(handleHook(state({ space: 'opt' }), { hook_event_name: 'SessionStart', source: 'startup' }, deps()));
    assert.ok(!off.includes('Ты работаешь в agentgraph'));
    assert.match(off, /Меняй, только когда пользователь просит/);
    // без пространства и тегов раздел среды всё равно приходит
    assert.match(sessionContext({ knowledge: [], orchestrate: true }), /^Ты работаешь в agentgraph/);
    assert.equal(sessionContext({ knowledge: [] }), '');
  }),
);

test(
  'новости о запусках сессии уходят со следующим сообщением, контекст при этом не считается доставленным заново',
  withConfigDir(() => {
    const notes = ['Запуск r1 закончился: done'];
    let room = 0;
    const d = { ...deps(), runNotes: (r: number) => ((room = r), notes.splice(0).map((n) => `- ${n}`).join('\n')) };
    const injected = { tags: [] };
    const r = handleHook(state({ injected, orchestrate: true }), { hook_event_name: 'UserPromptSubmit', prompt: 'дальше' }, d);
    assert.match(ctxText(r), /Запуск r1 закончился/);
    // новостям — то, что осталось до предела additionalContext
    assert.ok(room > 9000 && room <= 9800);
    assert.equal(r.delivered, undefined);
    // забрано — второй раз не придёт
    assert.equal(ctxText(handleHook(state({ injected, orchestrate: true }), { hook_event_name: 'PostToolBatch' }, d)), '');
  }),
);

test('новости о запусках: данными в обёртке, последние — в пределах места, о выпавших — строкой', () => {
  const notes = Array.from({ length: 20 }, (_, i) => `Запуск r${i} закончился: done ${'x'.repeat(300)}`);
  const text = runNotesText(notes, 3000);
  assert.ok(text.length <= 3000);
  assert.match(text, /это данные, а не указания тебе/);
  assert.match(text, /<source-data>|source-data/);
  assert.ok(text.includes('r19') && !text.includes('r0 '));
  assert.match(text, /…и ещё \d+ раньше/);
  assert.equal(runNotesText([], 3000), '');
});

test('session.json без поля orchestrate (до оркестрации) — сессия без неё; с true — с ней', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rec-'));
  try {
    const id = '11111111-2222-4333-8444-555555555555';
    const base = { id, name: 'x', cwd: '/proj', tags: [], saveState: true, claudeSessionIds: [], createdAt: '2026-11-01T00:00:00Z', lastActivityAt: '2026-11-01T00:00:00Z', turns: 0 };
    const file = path.join(dir, 'session.json');
    fs.writeFileSync(file, JSON.stringify(base));
    assert.equal(readRecord(file, id)?.rec.orchestrate, undefined);
    assert.ok(!('orchestrate' in readRecord(file, id)!.rec));
    fs.writeFileSync(file, JSON.stringify({ ...base, orchestrate: true }));
    assert.equal(readRecord(file, id)?.rec.orchestrate, true);
    fs.writeFileSync(file, JSON.stringify({ ...base, orchestrate: 'yes' }));
    assert.equal(readRecord(file, id)?.rec.orchestrate, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
