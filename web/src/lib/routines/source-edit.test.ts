import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceSpec } from '@server/routines/types';
import { applySourcePatch, everyShort, pollSegChoices, saveImpactText, sourceChanges, sourceMinEvery, sourceProblems } from './source-edit';

const cmd: SourceSpec = { title: 'Fireflies', kind: 'command', config: { command: 'ff list' }, every: '30m', map: { id: 'id', title: 'title' }, secrets: ['FF_KEY'] };

test('патч ложится поверх текущего spec: ответ и ключи, сохранённые отдельно, не теряются', () => {
  const now: SourceSpec = { ...cmd, config: { ...cmd.config, reply: { tool: 'mcp__s__send', args: {} } } };
  const next = applySourcePatch(now, { every: '1h', config: { command: ' ff list --all ', detail: '' } });
  assert.deepEqual(next.config, { command: 'ff list --all', reply: { tool: 'mcp__s__send', args: {} } });
  assert.equal(next.every, '1h');
  assert.deepEqual(next.secrets, ['FF_KEY']);
  assert.equal(applySourcePatch(cmd, { title: '  ' }).title, 'Fireflies');
  assert.deepEqual(applySourcePatch(cmd, { map: { id: '', title: ' name ', link: '' } }).map, { id: 'id', title: 'name' });
});

test('что изменилось: по разделам; правка туда и обратно — не изменение', () => {
  assert.deepEqual(sourceChanges(cmd, {}), []);
  assert.deepEqual(sourceChanges(cmd, { every: '30m', config: { command: 'ff list' }, title: 'Fireflies' }), []);
  assert.deepEqual(sourceChanges(cmd, { every: '1h', title: 'FF' }), ['название', 'частота опроса']);
  assert.deepEqual(sourceChanges(cmd, { config: { command: 'ff x' }, map: { id: 'id', title: 'name' } }), ['подключение', 'поля записи']);
});

test('строка у «Сохранить источник»: сколько рутин заденет', () => {
  assert.equal(saveImpactText([], 3), '');
  assert.equal(saveImpactText(['частота опроса'], 1), 'Изменено: частота опроса. Подействует на 1 рутину.');
  assert.equal(saveImpactText(['название', 'подключение'], 5), 'Изменено: название, подключение. Подействует на 5 рутин.');
  assert.equal(saveImpactText(['название'], 0), 'Изменено: название. Рутин с этим источником нет.');
});

test('что не даёт сохранить: пустая команда, пустое обязательное поле вида; ключи и необязательные — нет', () => {
  assert.deepEqual(sourceProblems(cmd, undefined), []);
  assert.deepEqual(sourceProblems({ ...cmd, config: { command: '  ' } }, undefined), ['Без команды источник не сохранится']);
  const jira = { setup: [{ key: 'jql', label: 'JQL' }, { key: 'host', label: 'Хост', optional: true }, { key: 'JIRA_TOKEN', label: 'Токен', secret: true }] };
  assert.deepEqual(sourceProblems({ title: 'J', kind: 'jira', config: {} }, jira), ['Без поля «JQL» источник не сохранится']);
  assert.deepEqual(sourceProblems({ title: 'J', kind: 'jira', config: { jql: 'project = X' } }, jira), []);
  assert.deepEqual(sourceProblems({ title: 'C', kind: 'connector', config: {} }, undefined), []);
});

test('минимум опроса: у «Сервиса через Claude» по скрипту, у остальных — вида', () => {
  assert.equal(sourceMinEvery({ kind: 'connector', config: { script: { steps: [] } } }, { minEvery: '1m' }), '1m');
  assert.equal(sourceMinEvery({ kind: 'connector', config: {} }, { minEvery: '1m' }), '30m');
  assert.equal(sourceMinEvery({ kind: 'jira', config: {} }, { minEvery: '2m' }), '2m');
  assert.equal(sourceMinEvery({ kind: 'x', config: {} }, undefined), undefined);
});

test('варианты частоты: не чаще минимума, минимум между шагами первым, нестандартное текущее — по порядку', () => {
  assert.deepEqual(pollSegChoices('30s', '5m'), ['5m', '15m', '30m', '1h', '6h']);
  assert.deepEqual(pollSegChoices('30m', '30m'), ['30m', '1h', '6h']);
  assert.deepEqual(pollSegChoices('10m', undefined), ['10m', '15m', '30m', '1h', '6h']);
  assert.deepEqual(pollSegChoices('1m', '2m'), ['2m', '5m', '15m', '30m', '1h', '6h']);
  assert.deepEqual(pollSegChoices('12h', undefined), ['12h']);
  assert.deepEqual(pollSegChoices(undefined, '1d'), ['5m', '15m', '30m', '1h', '6h', '1d']);
});

test('коротко для сегмента', () => {
  assert.equal(everyShort('30s'), '30 с');
  assert.equal(everyShort('5m'), '5 мин');
  assert.equal(everyShort('1h'), '1 час');
  assert.equal(everyShort('6h'), '6 часов');
  assert.equal(everyShort('1d'), '1d');
});
