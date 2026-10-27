import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatAction, ChatMessage, ChatPayload } from '@server/api-types';
import { setLangForTest } from '../i18n';
import { actionConfirm, actionMeta, actionState, applyLive, chatMeta, emptyLive, liveOf, repliesAt, stepKind, stepLabel, stepsSummary } from './chat';

test('строка над чатом: сообщения без заметок, потрачено, агент отвечает', () => {
  assert.equal(chatMeta([{ role: 'user' }, { role: 'note' }, { role: 'assistant' }], 0.5, true), 'сообщений 2 · потрачено $0.50 · агент отвечает…');
  assert.equal(chatMeta([], 0, false), '');
});

test('подписи шагов: файл, команда, управление запуском, артефакт со ключом и без, чужой MCP-инструмент — имя без сервера', () => {
  assert.equal(stepLabel({ tool: 'Read', target: 'iter-02/01-code.output.md', runFile: 'iter-02/01-code.output.md' }), 'Читает iter-02/01-code.output.md');
  assert.equal(stepLabel({ tool: 'Bash', target: 'npm test' }), '$ npm test');
  assert.equal(stepLabel({ tool: 'mcp__run__pause_run' }), 'Поставил на паузу');
  assert.equal(stepLabel({ tool: 'mcp__run__set_max_iterations', target: 'impl → 40' }), 'Лимит итераций: impl → 40');
  assert.equal(stepLabel({ tool: 'mcp__run__artifacts', target: 'plan' }), 'Читает артефакт plan');
  assert.equal(stepLabel({ tool: 'mcp__run__artifacts' }), 'Смотрит артефакты');
  assert.equal(stepLabel({ tool: 'mcp__claude_ai_Atlassian__getJiraIssue' }), 'getJiraIssue');
  assert.equal(stepLabel({ tool: 'ToolSearch' }), 'ToolSearch');
  assert.deepEqual(['Read', 'Grep', 'Bash', 'Edit', 'mcp__run__resume_run', 'Skill'].map((tool) => stepKind({ tool })), ['read', 'search', 'cmd', 'edit', 'run', 'other']);
});

test('свёрнутая трасса: число действий с формой слова и ошибки; по-английски — перевод', () => {
  assert.equal(stepsSummary([{ tool: 'Read' }]), '1 действие');
  assert.equal(stepsSummary([{ tool: 'Read' }, { tool: 'Bash', error: 'Exit code 1' }, { tool: 'Grep' }]), '3 действия · 1 с ошибкой');
  assert.equal(stepsSummary(Array.from({ length: 11 }, () => ({ tool: 'Read' }))), '11 действий');
  setLangForTest('en');
  try {
    assert.equal(stepsSummary([{ tool: 'Read' }, { tool: 'Bash', error: 'x' }]), '2 actions · 1 failed');
    assert.equal(stepLabel({ tool: 'mcp__run__pause_run' }), 'Paused the run');
    assert.equal(actionState({ id: 'a1', kind: 'abort', label: 'Стоп', state: 'done' })!.text, '✓ done');
  } finally {
    setLangForTest('ru');
  }
});

const action = (over: Partial<ChatAction>): ChatAction => ({ id: 'a1', kind: 'abort', label: 'Остановить', ...over });

test('подтверждение кнопки: что именно случится; «да» — по виду действия, а не текст агента; остановка и перезапуск итерации — красная кнопка; модель и лимит нового запуска', () => {
  assert.deepEqual(actionConfirm(action({ label: 'Сохранить заметку' }), 'demo'), { text: 'Остановить запуск? Текущая сессия будет прервана.', ok: 'Остановить запуск', danger: true });
  assert.equal(actionConfirm(action({ kind: 'restart_iteration' }), 'demo').danger, true);
  const save = actionConfirm(action({ kind: 'save_flow', target: 'flows/demo.yaml' }), 'demo');
  assert.equal(save.danger, false);
  assert.match(save.text, /flows\/demo\.yaml\? Это общий файл[^]*запуски и продолжения flow demo\./);
  // последнюю правку на ходу в flows/ не сохраняли: продолжение этого запуска файл не возьмёт — подтверждение так и говорит
  const keeps = actionConfirm(action({ kind: 'save_flow', target: 'flows/demo.yaml', keepsSnapshot: true }), 'demo').text;
  assert.match(keeps, /все следующие запуски flow demo\. Продолжение этого запуска останется на его снимке/);
  assert.equal(actionConfirm(action({ kind: 'continue', model: 'haiku', maxBudgetUsd: 0.2 }), 'demo').text, 'Продолжить запуск с места остановки новым запуском (модель haiku, лимит $0.20)?');
  assert.equal(actionConfirm(action({ kind: 'rerun' }), 'demo').text, 'Запустить flow demo заново с той же задачей?');
  assert.match(actionConfirm(action({ kind: 'rerun', keepsSnapshot: true }), 'demo').text, /Возьмётся файл из flows\/: правка flow на ходу этого запуска в него не войдёт/);
  assert.equal(actionMeta(action({ kind: 'continue', target: 'x', model: 'haiku' })), 'x · модель haiku');
  // вид из будущей версии сервера в старой вкладке — подпись кнопки, а не падение
  assert.deepEqual(actionConfirm(action({ kind: 'new_kind' as ChatAction['kind'], label: 'Сделать' }), 'demo'), { text: 'Сделать', ok: 'Выполнить', danger: false });
});

test('итог кнопки: выполнено, не вышло, устарело; не нажимали — null', () => {
  assert.equal(actionState(action({})), null);
  assert.deepEqual(actionState(action({ state: 'done' })), { text: '✓ выполнено', tone: 'ok' });
  assert.deepEqual(actionState(action({ state: 'failed' })), { text: '✕ не вышло', tone: 'fail' });
  assert.deepEqual(actionState(action({ state: 'expired' })), { text: 'устарело', tone: 'off' });
});

test('варианты ответа — только у последнего ответа агента и пока пользователь не написал после него; старые истории без виджетов', () => {
  const ask = (widgets?: ChatMessage['widgets']): ChatMessage => ({ role: 'assistant', text: 'x', at: '', ...(widgets ? { widgets } : {}) });
  const user: ChatMessage = { role: 'user', text: 'y', at: '' };
  const note: ChatMessage = { role: 'note', text: 'Начат новый разговор', at: '' };
  const replies = [{ type: 'replies' as const, items: ['Да'] }];
  assert.equal(repliesAt([user, ask(replies)]), 1);
  assert.equal(repliesAt([user, ask(replies), note]), 1);
  assert.equal(repliesAt([ask(replies), user]), -1);
  assert.equal(repliesAt([ask(replies), user, ask()]), -1);
  assert.equal(repliesAt([user, { role: 'assistant', text: 'старый ответ', at: '', openRun: 'r2' }]), -1);
  assert.equal(repliesAt([]), -1);
});

test('живой ход: шаг по номеру (тот же номер — уточнение с ошибкой), последний текст, виджеты по порядку; прочие события ход не трогают', () => {
  const live = emptyLive();
  assert.equal(applyLive(live, { type: 'step', index: 0, step: { tool: 'Bash', target: 'npm test' } }), true);
  applyLive(live, { type: 'step', index: 1, step: { tool: 'Read', target: 'a' } });
  applyLive(live, { type: 'step', index: 0, step: { tool: 'Bash', target: 'npm test', error: 'Exit code 1' } });
  applyLive(live, { type: 'text', text: 'Смотрю' });
  applyLive(live, { type: 'widget', widget: { type: 'replies', items: ['Да'] } });
  assert.equal(applyLive(live, { type: 'effect', kind: 'run' }), false);
  assert.deepEqual(live, { steps: [{ tool: 'Bash', target: 'npm test', error: 'Exit code 1' }, { tool: 'Read', target: 'a' }], text: 'Смотрю', widgets: [{ type: 'replies', items: ['Да'] }] });

  // ход с сервера — копия: поток правит её, а не ответ запроса
  const payload: ChatPayload = { messages: [], totalCostUsd: 0, busy: true, live: { steps: [{ tool: 'Read' }], widgets: [] } };
  const copy = liveOf(payload);
  applyLive(copy, { type: 'step', index: 1, step: { tool: 'Grep' } });
  assert.equal(payload.live!.steps.length, 1);
  assert.deepEqual(liveOf(null), emptyLive());
});
