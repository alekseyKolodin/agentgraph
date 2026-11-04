import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelContext, modelContextReply } from './model-context.js';
import { phaseContextTail } from './runner.js';
import { sessionContext } from './sessions.js';
import { addSpaceDoc, createSpace, readSpace, spaceContext, updateSpace, writeSpaceState } from './spaces.js';
import { createTag, knowledgeLine, readTag, updateTag } from './tags.js';

function withConfigDir(fn: (root: string) => void) {
  return () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-modelctx-')));
    const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-cfg-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = cfg;
    try {
      fn(root);
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  };
}

test(
  'модель получит: тексты сессии и этапа — тем же кодом, что их отправляет; разбор — карта, состояние, документы, папки, строки тегов',
  withConfigDir((root) => {
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj);
    createSpace('press-alert', { title: 'Пуш', gist: 'суть' });
    updateSpace('press-alert', { dirs: [proj] });
    writeSpaceState('press-alert', '**Суть** пуш о тревоге', { id: 'r1', at: '', kind: 'run' });
    addSpaceDoc('press-alert', { name: 'spec.md', data: Buffer.from('# Спека\n').toString('base64') });
    createTag('qa', 'QA');
    updateTag('qa', { description: 'правила тестов', notes: 'гоняй npm test' });
    const v = modelContext({ space: 'press-alert', tags: ['qa'] })!;
    const space = readSpace('press-alert')!;
    const tag = readTag('qa')!;
    assert.equal(v.session, sessionContext({ space, knowledge: [tag] }, 'press-alert'));
    assert.equal(v.phase, phaseContextTail(spaceContext(space, { where: 'phase', mapLoaded: true }), [tag]));
    assert.match(v.phase, /Пространство agentgraph «Пуш» \(press-alert\)/);
    assert.ok(v.phase.includes(knowledgeLine(tag)));
    assert.deepEqual(
      { title: v.space!.title, chars: v.space!.map.chars > 0, state: v.space!.state, docs: v.space!.docs.map((d) => d.name), dirs: v.space!.dirs },
      { title: 'Пуш', chars: true, state: '**Суть** пуш о тревоге', docs: ['spec.md'], dirs: [proj] },
    );
    assert.deepEqual(v.knowledge, [{ slug: 'qa', title: 'QA', inline: false, text: knowledgeLine(tag) }]);
    // ничего не выбрано — пусто
    assert.deepEqual(modelContext({}), { session: '', phase: '', knowledge: [] });
  }),
);

test(
  'модель получит: нет пространства — 404, неверный слаг или нет тега знаний — 400',
  withConfigDir(() => {
    createSpace('p');
    assert.equal(modelContextReply(new URLSearchParams('space=p')).status, 200);
    assert.equal(modelContextReply(new URLSearchParams('space=nope')).status, 404);
    assert.equal(modelContextReply(new URLSearchParams('space=../x')).status, 400);
    assert.equal(modelContextReply(new URLSearchParams('tags=no-such')).status, 400);
  }),
);
