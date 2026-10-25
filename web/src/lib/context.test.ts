import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextView } from '@server/api-types';
import {
  ctxAddDirs, ctxDirty, ctxEditState, ctxFlowOptions, ctxHome, ctxKnowledge, ctxListSum, ctxMcpServers, ctxMeta, ctxPhaseGroups, ctxProjectMd,
  ctxProjects, ctxQuery, ctxRows, ctxTokens, ctxTotals, type CtxEdit,
} from './context';

test('контекст: токены коротко и путь с «~»', () => {
  assert.equal(ctxTokens(0), '0');
  assert.equal(ctxTokens(999), '999');
  assert.equal(ctxTokens(1000), '1.0k');
  assert.equal(ctxTokens(9949), '9.9k');
  assert.equal(ctxTokens(10_000), '10k');
  assert.equal(ctxTokens(123_456), '123k');
  assert.equal(ctxHome('/Users/me/p/CLAUDE.md', '/Users/me'), '~/p/CLAUDE.md');
  assert.equal(ctxHome('/Users/meow/x', '/Users/me'), '/Users/meow/x');
  assert.equal(ctxHome('/x', ''), '/x');
});

test('контекст: запрос без пустых полей, force=1 у «Обновить»', () => {
  assert.equal(ctxQuery({ cwd: '/p q', flow: '', phase: '', model: '' }, false), 'cwd=%2Fp+q');
  assert.equal(ctxQuery({ cwd: '/p', flow: 'f', phase: 'a', model: 'm' }, true), 'cwd=%2Fp&flow=f&phase=a&model=m&force=1');
});

test('контекст: подсказки директорий — по умолчанию, последняя и существующие недавние, по алфавиту без повторов', () => {
  const recent = [{ path: '/b', label: 'b', exists: true }, { path: '/gone', label: 'gone', exists: false }, { path: '/a', label: 'a', exists: true }];
  assert.deepEqual(ctxProjects('/home', '/a', recent), ['/a', '/b', '/home']);
  assert.deepEqual(ctxProjects('/home', null, []), ['/home']);
});

test('контекст: flow — только валидные, «папка/имя»; этапы — группами при нескольких блоках', () => {
  const flows = [
    { name: 'a', file: '', folder: '', valid: true },
    { name: 'b', file: '', folder: 'dev', valid: true },
    { name: 'bad', file: '', folder: '', valid: false },
  ];
  assert.deepEqual(ctxFlowOptions(flows), [{ value: 'a', label: 'a' }, { value: 'b', label: 'dev/b' }]);
  assert.deepEqual(ctxPhaseGroups(undefined), []);
  assert.deepEqual(ctxPhaseGroups({ phases: [{ name: 'x', title: 'Икс' }, { name: 'y' }] }), [{ label: '', options: [{ value: 'x', label: 'Икс' }, { value: 'y', label: 'y' }] }]);
  assert.deepEqual(ctxPhaseGroups({ blocks: [{ name: 'one', phases: [{ name: 'x' }] }] }), [{ label: '', options: [{ value: 'x', label: 'x' }] }]);
  assert.deepEqual(ctxPhaseGroups({ blocks: [{ name: 'one', title: 'Первый', phases: [{ name: 'x' }] }, { name: 'two', phases: [{ name: 'y' }] }] }), [
    { label: 'Первый', options: [{ value: 'x', label: 'x' }] },
    { label: 'two', options: [{ value: 'y', label: 'y' }] },
  ]);
});

const view = (over: Partial<ContextView> = {}): ContextView => ({
  cwd: '/p', model: 'opus', totalTokens: 0, maxTokens: 0, percentage: 0, categories: [], memoryFiles: [], skills: [], agents: [], mcpTools: [],
  tools: null, systemPrompt: 'preset', addDirs: [], knowledge: [], warnings: [], at: '2026-10-24T10:05:00', ...over,
});

test('контекст: шапка — cwd, flow и этап, модель, время данных', () => {
  const now = new Date('2026-10-24T12:00:00');
  assert.equal(ctxMeta(view(), now), '/p · модель opus · данные на 10:05');
  assert.equal(ctxMeta(view({ flow: 'f', phase: 'a' }), now), '/p · flow f, этап a · модель opus · данные на 10:05');
  assert.equal(ctxMeta(view({ flow: 'f' }), now), '/p · flow f · модель opus · данные на 10:05');
});

test('контекст: полоса — только занятое ненулевое по долям; легенда — все ненулевые, цвет только у занятого', () => {
  const d = view({
    categories: [
      { name: 'System', tokens: 3000, kind: 'used' },
      { name: 'Zero', tokens: 0, kind: 'used' },
      { name: 'Tools', tokens: 1000, kind: 'used' },
      { name: 'Free', tokens: 150_000, kind: 'free' },
      { name: 'Odd', tokens: 5, kind: 'other' as 'free' },
    ],
  });
  const { bar, legend } = ctxTotals(d);
  assert.deepEqual(bar, [{ c: 0, width: '75%', title: 'System: 3000' }, { c: 1, width: '25%', title: 'Tools: 1000' }]);
  assert.deepEqual(legend, [
    { name: 'System', tokens: '3.0k', c: 0, used: true, kind: '' },
    { name: 'Tools', tokens: '1.0k', c: 1, used: true, kind: '' },
    { name: 'Free', tokens: '150k', c: null, used: false, kind: 'свободно' },
    { name: 'Odd', tokens: '5', c: null, used: false, kind: 'other' },
  ]);
  // цветов восемь, дальше по кругу
  const many = view({ categories: Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, tokens: 1, kind: 'used' as const })) });
  assert.deepEqual(ctxTotals(many).bar.map((p) => p.c), [0, 1, 2, 3, 4, 5, 6, 7, 0, 1]);
  assert.deepEqual(ctxTotals(view()).bar, []);
});

test('контекст: память — свой CLAUDE.md, доп. директории и теги знаний с ошибками', () => {
  assert.equal(ctxProjectMd(view({ memoryFiles: [{ path: '/p/CLAUDE.md', type: 'Project', tokens: 1, editable: true }] })), true);
  assert.equal(ctxProjectMd(view({ memoryFiles: [{ path: '/p/.claude/CLAUDE.md', type: 'Project', tokens: 1, editable: true }] })), true);
  assert.equal(ctxProjectMd(view({ memoryFiles: [{ path: '/p/sub/CLAUDE.md', type: 'Project', tokens: 1, editable: true }] })), false);
  assert.deepEqual(ctxAddDirs(view({ addDirs: [{ path: '/h/a', exists: true }, { path: '/b', exists: false }] }), '/h'), [
    { text: '~/a', err: false }, { text: '/b — нет', err: true },
  ]);
  assert.deepEqual(ctxKnowledge(view({ knowledge: [{ slug: 'fe', exists: true, kind: 'knowledge' }, { slug: 'x', exists: false }, { slug: 't', exists: true, kind: 'task' }] })), [
    { text: 'fe', err: false }, { text: 'x — нет', err: true }, { text: 't — тег задачи', err: true },
  ]);
});

test('контекст: списки по убыванию токенов, MCP по серверам', () => {
  const rows = [{ name: 'a', source: 'user', tokens: 10 }, { name: 'b', source: 'project', tokens: 2000 }];
  assert.deepEqual(ctxRows(rows).map((r) => r.name), ['b', 'a']);
  assert.equal(rows[0]!.name, 'a');
  assert.equal(ctxListSum(rows), '· 2, 2.0k');
  const d = view({ mcpTools: [{ name: 't1', server: 'gh', tokens: 100 }, { name: 't2', server: 'gh', tokens: 50 }, { name: 't3', server: 'jira', tokens: 5 }] });
  assert.deepEqual(ctxMcpServers(d), [{ name: 'gh', source: '2 инструмента', tokens: 150 }, { name: 'jira', source: '1 инструмент', tokens: 5 }]);
});

test('контекст: редактор — несохранённое только у редактируемого, кнопки и сообщение', () => {
  const e: CtxEdit = { path: '/p/CLAUDE.md', text: 'a', saved: 'a', mtimeMs: 1, editable: true, conflict: false, msg: '' };
  assert.equal(ctxDirty(null), false);
  assert.equal(ctxDirty(e), false);
  assert.deepEqual(ctxEditState(e), { save: true, saveDisabled: true, cancel: 'Отменить', reload: false, msgClass: 'msg', msg: '' });
  const d = { ...e, text: 'b' };
  assert.equal(ctxDirty(d), true);
  assert.equal(ctxEditState(d).msg, 'Есть несохранённая правка');
  assert.equal(ctxEditState(d).saveDisabled, false);
  assert.deepEqual(ctxEditState({ ...d, conflict: true, msg: 'Файл изменили' }), { save: true, saveDisabled: false, cancel: 'Отменить', reload: true, msgClass: 'msg err', msg: 'Файл изменили' });
  const ro = { ...e, editable: false, text: 'b' };
  assert.equal(ctxDirty(ro), false);
  assert.deepEqual(ctxEditState(ro), { save: false, saveDisabled: true, cancel: 'Закрыть', reload: false, msgClass: 'msg', msg: 'Только просмотр' });
});
