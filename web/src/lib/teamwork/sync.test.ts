import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TeamConflict, TeamSync } from '@server/api-types';
import { agoShort, changesWord, conflictText, disconnectQuestion, fieldLabel, syncLine, unsavedLine } from './sync';

const now = Date.parse('2026-11-12T12:00:00Z');
const sync = (over: Partial<TeamSync>): TeamSync => ({ state: 'ok', unpushed: 0, conflicts: 0, ...over });
const conflict = (over: Partial<TeamConflict>): TeamConflict => ({ id: 'c1', file: 'projects/x/tasks/PAY-12.md', kind: 'field', ours: 1, theirs: 2, at: '', ...over });

test('синхронизация: «N с назад», минуты, часы, старше суток — дата', () => {
  assert.equal(agoShort(new Date(now - 12_000).toISOString(), now), '12 с назад');
  assert.equal(agoShort(new Date(now - 3 * 60_000).toISOString(), now), '3 мин назад');
  assert.equal(agoShort(new Date(now - 2 * 3600_000).toISOString(), now), '2 ч назад');
  assert.match(agoShort(new Date(now - 3 * 86400_000).toISOString(), now), /\d\d\.\d\d/);
  assert.equal(agoShort(new Date(now + 5000).toISOString(), now), '0 с назад', 'часы вперёд — не отрицательное');
  assert.equal(changesWord(1), '1 изменение');
  assert.equal(changesWord(3), '3 изменения');
  assert.equal(changesWord(5), '5 изменений');
});

test('синхронизация: строка по состоянию — текст, тон, действие, как в SyncStates', () => {
  const ok = syncLine(sync({ lastPushAt: new Date(now - 12_000).toISOString(), lastFetchAt: new Date(now - 60_000).toISOString() }), { now });
  assert.deepEqual(ok, { text: 'синхронизировано · 12 с назад', tone: 'ok' });
  assert.deepEqual(syncLine(sync({})), { text: 'синхронизировано', tone: 'ok' });
  assert.deepEqual(syncLine(sync({ state: 'pushing', unpushed: 2 })), { text: 'отправляется · 2 изменения', tone: 'live' });
  assert.deepEqual(syncLine(sync({ state: 'pushing' })), { text: 'отправляется…', tone: 'live' });
  assert.deepEqual(syncLine(sync({ state: 'pending', unpushed: 3, error: 'нет доступа к репо' })), {
    text: 'не отправлено: 3 изменения — нет доступа к репо', tone: 'wait', action: { kind: 'retry', label: 'Повторить' },
  });
  assert.equal(syncLine(sync({ state: 'pending', unpushed: 1 })).text, 'не отправлено: 1 изменение');
  assert.deepEqual(syncLine(sync({ state: 'conflict', conflicts: 1 }), { conflicts: [conflict({ task: 'PAY-12' })] }), {
    text: 'конфликт в PAY-12', tone: 'wait', action: { kind: 'resolve', label: 'Разобрать' },
  });
  assert.equal(syncLine(sync({ state: 'conflict', conflicts: 1 }), { conflicts: [conflict({ doc: 'prd' })] }).text, 'конфликт в prd.md');
  assert.equal(syncLine(sync({ state: 'conflict', conflicts: 1 }), { conflicts: [conflict({ doc: 'docs/notes.md' })] }).text, 'конфликт в docs/notes.md');
  assert.equal(syncLine(sync({ state: 'conflict', conflicts: 1 })).text, 'конфликт');
  assert.equal(syncLine(sync({ state: 'conflict', conflicts: 3 })).text, 'конфликтов: 3');
  assert.equal(conflictText({ conflicts: 2 }, [conflict({}), conflict({ id: 'c2' })]), 'конфликтов: 2');
  assert.deepEqual(syncLine(sync({ state: 'readonly' }), { format: 2 }), {
    text: 'только чтение: формат 2 новее этой версии agentgraph', tone: 'off', action: { kind: 'update', label: 'Обновить agentgraph' },
  });
  assert.equal(syncLine(sync({ state: 'readonly' })).text, 'только чтение: формат новее этой версии agentgraph');
});

test('синхронизация: несохранённый раздел вместо строки', () => {
  assert.deepEqual(unsavedLine(['Требования']), { text: 'не сохранено: раздел «Требования»', tone: 'wait' });
  assert.equal(unsavedLine(['A', 'B'])?.text, 'не сохранено: разделы «A», «B»');
  assert.equal(unsavedLine([]), undefined);
});

test('подпись поля конфликта: заголовок задачи, название проекта или спринта, незнакомое поле — как в файле', () => {
  assert.equal(fieldLabel('title', true), 'Заголовок');
  assert.equal(fieldLabel('title'), 'Название');
  assert.equal(fieldLabel('blockedBy', true), 'Ждёт');
  assert.equal(fieldLabel('pr', true), 'PR');
  assert.equal(fieldLabel('x_custom'), 'x_custom');
  assert.equal(fieldLabel('constructor'), 'constructor');
});

test('строка «не отправлено»: без ошибки кнопка отправляет сейчас, с ошибкой — «Повторить»', () => {
  assert.deepEqual(syncLine(sync({ state: 'pending', unpushed: 2 })).action, { kind: 'retry', label: 'Отправить сейчас' });
  assert.deepEqual(syncLine(sync({ state: 'pending', unpushed: 2, error: 'нет сети' })).action, { kind: 'retry', label: 'Повторить' });
});

test('синхронизация: ошибка без неотправленного (нет сети, история переписана, клон посреди rebase руками) — текстом сервера, а не «синхронизировано»', () => {
  const rewritten = 'История репо команды переписана: у клона нет с ней общих коммитов. Отключи команду и подключись заново';
  assert.deepEqual(syncLine(sync({ error: rewritten, lastFetchAt: new Date(now - 60_000).toISOString() }), { now }), {
    text: `не синхронизировано — ${rewritten}`, tone: 'wait', action: { kind: 'retry', label: 'Повторить' },
  });
  // при конфликтах причина сбоя тоже видна, кнопка — «Разобрать»
  assert.deepEqual(syncLine(sync({ state: 'conflict', conflicts: 2, error: 'Команду сейчас синхронизирует другой процесс agentgraph: попробуй позже' })), {
    text: 'конфликтов: 2 — Команду сейчас синхронизирует другой процесс agentgraph: попробуй позже', tone: 'wait', action: { kind: 'resolve', label: 'Разобрать' },
  });
});

test('отключение: вопрос называет и неотправленные коммиты, и нерешённые конфликты — «моё» в них пропадёт вместе с клоном', () => {
  assert.equal(disconnectQuestion({ unpushed: 0, commits: [], conflicts: 2 }), 'Нерешённых конфликтов: 2 — ваши версии из них есть только в этом клоне.\nЭто пропадёт вместе с клоном. Всё равно отключить?');
  assert.equal(
    disconnectQuestion({ unpushed: 2, commits: ['PAY-12: статус → Ревью', 'PAY-13: создана'], conflicts: 1 }),
    'Не отправлено изменений: 2.\n· PAY-12: статус → Ревью\n· PAY-13: создана\nНерешённых конфликтов: 1 — ваши версии из них есть только в этом клоне.\nЭто пропадёт вместе с клоном. Всё равно отключить?',
  );
  // старый сервер без conflicts и без unpushed — по числу коммитов
  assert.equal(disconnectQuestion({ commits: ['PAY-1: x'] }), 'Не отправлено изменений: 1.\n· PAY-1: x\nЭто пропадёт вместе с клоном. Всё равно отключить?');
  assert.doesNotMatch(disconnectQuestion({ unpushed: 0, conflicts: 3 }), /Не отправлено изменений: 0/);
});

