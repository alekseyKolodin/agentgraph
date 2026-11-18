import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerKey, pauseAnswerOf, setPauseAnswer, sweepPauseAnswers } from '../screens/run/pauseAnswer';

/** Память вместо localStorage: node его не имеет. */
function fakeStorage(): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  } as Storage;
  return m;
}

test('черновик ответа на паузу: пишется с отметкой времени и читается обратно', () => {
  const m = fakeStorage();
  const key = answerKey('run-1', '2026-11-18T10:00:00.000Z');
  setPauseAnswer(key, 'Применить');
  const stored = JSON.parse(m.get(`agentgraph.pauseAnswer:${key}`)!) as { text: string; at: number };
  assert.equal(stored.text, 'Применить');
  assert.ok(Math.abs(stored.at - Date.now()) < 5000);
  assert.equal(pauseAnswerOf(key), 'Применить');
  setPauseAnswer(key, '');
  assert.equal(m.size, 0);
});

test('уборка при загрузке: старше недели уходят, свежие и записи в прежнем формате остаются (с отметкой), чужие ключи целы', () => {
  const m = fakeStorage();
  const now = Date.parse('2026-11-18T12:00:00.000Z');
  const day = 24 * 3600_000;
  m.set('agentgraph.pauseAnswer:old\np', JSON.stringify({ text: 'давно', at: now - 8 * day }));
  m.set('agentgraph.pauseAnswer:fresh\np', JSON.stringify({ text: 'недавно', at: now - 2 * day }));
  m.set('agentgraph.pauseAnswer:legacy\np', 'сырой текст прежней версии');
  m.set('agentgraph.other', 'x');
  sweepPauseAnswers(now);
  assert.equal(m.has('agentgraph.pauseAnswer:old\np'), false);
  assert.equal(JSON.parse(m.get('agentgraph.pauseAnswer:fresh\np')!).text, 'недавно');
  assert.deepEqual(JSON.parse(m.get('agentgraph.pauseAnswer:legacy\np')!), { text: 'сырой текст прежней версии', at: now });
  assert.equal(m.get('agentgraph.other'), 'x');
});
