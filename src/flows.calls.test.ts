// Вызовы flow на диске: сохранение проверяет вызываемые flow, удаление вызываемого запрещено.
// Папка flows/ — временная: AGENTGRAPH_HOME задаётся до импорта (paths.ts читает его при загрузке).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-calls-'));
process.env.AGENTGRAPH_HOME = home;
const { deleteFlow, flowCallers, listFlows, saveFlowSpec, saveFlowYaml } = await import('./flows.js');
const { draftSpec } = await import('./adhoc.js');

const leaf = (name: string) => `name: ${name}\nphases:\n  - { name: a, tools: [], prompt: x }\n`;
const caller = (name: string, callee: string) => `name: ${name}\nblocks:\n  - name: call\n    flow: ${callee}\n`;

test('сохранение: вызываемый flow должен быть в flows/, круг вызовов не сохраняется', () => {
  assert.throws(() => saveFlowYaml('parent', caller('parent', 'child')), /flow child не загружается: нет такого flow в flows\//);
  saveFlowYaml('child', leaf('child'), 'lib');
  saveFlowYaml('parent', caller('parent', 'child'));
  // child в папке lib — вызов по имени находит его в любой папке
  assert.deepEqual(listFlows().find((f) => f.name === 'parent')?.blocks?.map((b) => b.flow), ['child']);
  // child теперь вызывал бы parent: parent → child → parent
  assert.throws(() => saveFlowYaml('child', caller('child', 'parent')), /вызовы замыкаются в круг child → parent → child/);
  assert.throws(() => saveFlowSpec('loop', { blocks: [{ name: 'a', flow: 'loop' }] }), /вызывает сам себя/);
  assert.throws(() => draftSpec({ yaml: caller('draft', 'nope') }), /flow nope не загружается/);
  assert.equal(draftSpec({ yaml: caller('draft', 'child') }).blocks?.[0].flow, 'child');
});

test('удаление: вызываемый flow не удаляется, пока его вызывают', () => {
  assert.deepEqual(flowCallers('child'), ['parent']);
  assert.throws(() => deleteFlow('child'), /Flow child вызывают parent: сначала убери вызовы из них/);
  deleteFlow('parent');
  deleteFlow('child');
  assert.deepEqual(listFlows(), []);
  fs.rmSync(home, { recursive: true, force: true });
});
