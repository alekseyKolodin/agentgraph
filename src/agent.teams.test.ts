// Последняя линия S-2 (spec §14): сессия SDK не стартует с рабочей папкой в клоне репо команды — его .claude/settings.json
// (хуки) и .mcp.json грузились бы как настройки проекта. Agent SDK подменён: query не должен быть вызван вовсе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-agent-teams-')));
process.env.AGENTGRAPH_CONFIG_DIR = cfg;
const { runSession, sessionOptions } = await import('./agent.js');
const { teamsDir } = await import('./teamwork.js');

test('runSession с рабочей папкой в папке команд — неудачная сессия с причиной, query не вызван; снаружи — вызван', async () => {
  const clone = path.join(teamsDir(), 'pay', 'repo', 'projects', 'p');
  fs.mkdirSync(clone, { recursive: true });
  let calls = 0;
  const query = (() => {
    calls++;
    return (async function* () {})();
  }) as never;
  const r = await runSession({ prompt: 'p', cwd: clone }, () => {}, { query });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /папки команд Teamwork/);
  assert.equal(calls, 0);
  assert.throws(() => sessionOptions({ prompt: 'p', cwd: path.join(cfg, 'TEAMS', 'pay') }), /папки команд Teamwork/);
  // доп. папка из клона: без .claude — можно; pull принёс .claude посреди запуска — следующая сессия этапа не стартует
  const outside = path.join(cfg, 'code');
  fs.mkdirSync(outside);
  assert.deepEqual(sessionOptions({ prompt: 'p', cwd: outside, additionalDirectories: [clone] }).additionalDirectories, [clone]);
  fs.mkdirSync(path.join(clone, '.claude', 'skills', 'x'), { recursive: true });
  const r2 = await runSession({ prompt: 'p', cwd: outside, additionalDirectories: [clone] }, () => {}, { query });
  assert.match(r2.errors.join('\n'), /есть папка \.claude/);
  assert.equal(calls, 0);
  await runSession({ prompt: 'p', cwd: cfg }, () => {}, { query });
  assert.equal(calls, 1);
  fs.rmSync(cfg, { recursive: true, force: true });
});
