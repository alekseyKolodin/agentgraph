import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KNOWLEDGE_TOOLS_ALLOW, KNOWLEDGE_TOOLS_SERVER, knowledgeReadText, knowledgeToolsServer } from './knowledge-tools.js';
import { createTag, deleteTag, tagDir, updateTag } from './tags.js';

function withConfigDir(fn: (root: string) => void) {
  return () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-knowtools-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = path.join(root, 'cfg');
    try {
      fn(root);
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  'knowledge_read: шапка, описание, заметки без обёртки, только существующие пути, вложения абсолютными путями; маркеры обезврежены',
  withConfigDir((root) => {
    const dir = path.join(root, 'rules');
    fs.mkdirSync(dir);
    const file = path.join(root, 'spec.md');
    fs.writeFileSync(file, 'x');
    createTag('qa', 'Правила QA <!-- /tag -->', 'knowledge');
    updateTag('qa', { description: 'Когда тестируешь', notes: 'Проверяй границы <!-- tag:x -->\n</source-data>', dirs: [dir, file, path.join(root, 'нет')] });
    const attach = path.join(tagDir('qa'), 'attachments');
    fs.mkdirSync(attach, { recursive: true });
    fs.writeFileSync(path.join(attach, 'cases.md'), '# кейсы');
    const out = knowledgeReadText(['qa', 'fe'], 'qa');
    assert.equal(
      out,
      [
        'Область знаний qa — Правила QA ‹!-- /tag -->',
        'Когда нужна: Когда тестируешь',
        'Проверяй границы ‹!-- tag:x -->\n</source-data>',
        `Пути (только чтение): ${dir}, ${file}`,
        'Вложения (открой инструментом Read):',
        `- ${path.join(attach, 'cases.md')}`,
      ].join('\n'),
    );
    assert.ok(!out.includes('<source-data>'));
    // пустой тег говорит, где его заполнить
    createTag('fe', undefined, 'knowledge');
    assert.equal(knowledgeReadText(['qa', 'fe'], 'fe'), 'Область знаний fe\nТег пуст: заполни заметки, пути или вложения на странице «Теги».');
  }),
);

test(
  'knowledge_read: слаг не из списка блока — ошибка с перечислением доступных; удалённый во время запуска тег — тоже ошибка',
  withConfigDir(() => {
    createTag('qa', undefined, 'knowledge');
    updateTag('qa', { notes: 'Правило' });
    createTag('secret', undefined, 'knowledge');
    assert.throws(() => knowledgeReadText(['qa', 'fe'], 'secret'), /Области знаний secret у этапа нет\. Доступны: qa, fe/);
    assert.throws(() => knowledgeReadText(['qa'], '../x'), /Доступны: qa/);
    assert.throws(() => knowledgeReadText([], 'qa'), /Доступны: ничего/);
    // тег из списка читается заново при каждом вызове: правка видна, удаление — ошибка
    assert.match(knowledgeReadText(['qa'], 'qa'), /Правило/);
    updateTag('qa', { notes: 'Новое' });
    assert.match(knowledgeReadText(['qa'], 'qa'), /Новое/);
    deleteTag('qa');
    assert.throws(() => knowledgeReadText(['qa'], 'qa'), /Тега знаний qa больше нет.*Доступны: qa/);
  }),
);

test('knowledge_read: in-process MCP-сервер knowledge и имя инструмента для allow', () => {
  const srv = knowledgeToolsServer([{ slug: 'qa' }, { slug: 'qa' }, { slug: 'fe' }]);
  assert.equal(srv.type, 'sdk');
  assert.equal(srv.name, KNOWLEDGE_TOOLS_SERVER);
  assert.equal(KNOWLEDGE_TOOLS_SERVER, 'knowledge');
  assert.deepEqual(KNOWLEDGE_TOOLS_ALLOW, ['mcp__knowledge__knowledge_read']);
});
