import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { digestPrompt, feedbackKey, writeDigest, type DigestInput } from './run-digest.js';
import { withTagsInput } from './tags.js';
import type { SessionRequest, SessionResult } from './agent.js';

const result = (over: Partial<SessionResult> = {}): SessionResult =>
  ({ ok: true, subtype: 'success', text: '', costUsd: 0.004, turns: 1, durationMs: 10, errors: [], ...over });

function fake(structured: unknown, over: Partial<SessionResult> = {}) {
  const reqs: SessionRequest[] = [];
  const session = async (req: SessionRequest) => {
    reqs.push(req);
    return result({ structured, ...over });
  };
  return { reqs, session };
}

const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  flow: 'feature',
  task: 'Добавь экспорт CSV',
  block: { title: 'Реализация', index: 0, total: 2, iteration: 2, maxIterations: 5, looped: true },
  phases: [{ title: 'Код', output: 'Сделал эндпоинт /export' }],
  condition: { type: 'judge', done: false, detail: 'нет тестов', feedback: 'Добавь тесты на экспорт' },
  next: 'итерация 3 из 5: этапы получат замечания проверки',
  ...over,
});

test('итог: валидный ответ — итог итерации, сводка и стоимость; запрос без инструментов, haiku, без сохранения', async () => {
  const f = fake({ iteration: 'Сделан эндпоинт, судья просит тесты.', run: 'Экспорт почти готов, нужны тесты.' });
  const r = await writeDigest(input(), { session: f.session });
  assert.deepEqual(r, { iteration: 'Сделан эндпоинт, судья просит тесты.', run: 'Экспорт почти готов, нужны тесты.', costUsd: 0.004 });
  const req = f.reqs[0];
  assert.deepEqual(req.tools, []);
  assert.deepEqual(req.implicitTools, []);
  assert.equal(req.model, 'haiku');
  assert.equal(req.persist, false);
  assert.equal(req.cwd, os.tmpdir());
  assert.ok(req.abort);
  assert.ok(req.outputSchema);
});

test('итог: промпт — блок, итерация, что дальше; задача, выводы и замечания в source-data; блоки тегов сняты, длинное обрезано', () => {
  const p = digestPrompt(input({
    task: withTagsInput('Добавь экспорт CSV', [{ slug: 'other-tag', summary: 'саммари-чужого' }]),
    prev: 'Начали экспорт',
    phases: [{ title: 'Код', output: 'н'.repeat(3000) + 'КОНЕЦ' }],
  }));
  assert.match(p, /Блок 1 из 2: Реализация/);
  assert.match(p, /Итерация 2 из 5/);
  assert.match(p, /Дальше: итерация 3 из 5/);
  assert.match(p, /Проверка условия \(judge\): не выполнено/);
  for (const s of ['Добавь экспорт CSV', 'Начали экспорт', 'нет тестов', 'Добавь тесты на экспорт']) {
    assert.match(p, new RegExp(`<source-data>\\n${s}\\n</source-data>`), s);
  }
  // у вывода этапа оставлен конец: там итог этапа
  assert.ok(p.includes('…' + 'н'.repeat(1495) + 'КОНЕЦ'));
  assert.ok(!p.includes('н'.repeat(1501)));
  for (const s of ['other-tag', 'саммари-чужого']) assert.ok(!p.includes(s), s);
});

test('итог: блок без цикла — без проверки условия и номера итерации', () => {
  const p = digestPrompt(input({ condition: undefined, block: { title: 'Ревью', index: 1, total: 2, iteration: 1, maxIterations: 1, looped: false }, next: 'запуск завершается' }));
  assert.match(p, /Блок без цикла/);
  assert.ok(!p.includes('Проверка условия'));
  assert.ok(!p.includes('Итерация 1 из 1'));
});

test('итог: переводы строк вычищены, длинное обрезано; одно пустое поле — только другое', async () => {
  const r = await writeDigest(input(), { session: fake({ iteration: 'Строка\nвторая\t\u001b', run: 'с'.repeat(1000) }).session });
  assert.equal(r.iteration, 'Строка вторая');
  assert.equal(r.run!.length, 400);
  assert.ok(r.run!.endsWith('…'));
  const one = await writeDigest(input(), { session: fake({ iteration: '  ', run: 'Где мы' }).session });
  assert.deepEqual(one, { run: 'Где мы', costUsd: 0.004 });
});

test('итог: пустой ответ, мусор или ошибка сессии — { error } со стоимостью', async () => {
  for (const structured of [{ iteration: '', run: '' }, { iteration: 5 }, {}, undefined]) {
    const r = await writeDigest(input(), { session: fake(structured).session });
    assert.ok(r.error, JSON.stringify(structured));
    assert.equal(r.iteration, undefined);
    assert.equal(r.costUsd, 0.004);
  }
  const failed = await writeDigest(input(), { session: fake({ iteration: 'x', run: 'y' }, { ok: false, subtype: 'error_max_turns' }).session });
  assert.match(failed.error!, /error_max_turns/);
});

test('итог: исключение сессии, таймаут и остановка — { error } без стоимости, наружу не бросает', async () => {
  const thrown = await writeDigest(input(), { session: async () => { throw new Error('сеть'); } });
  assert.deepEqual(thrown, { error: 'сеть', costUsd: 0 });

  // сессия, которая abort не слушает: таймаут всё равно отпускает
  const hang = () => new Promise<SessionResult>(() => {});
  const slow = await writeDigest(input(), { session: hang, timeoutMs: 20 });
  assert.match(slow.error!, /таймаут/);

  const stop = new AbortController();
  const pending = writeDigest(input(), { session: hang, signal: stop.signal });
  stop.abort();
  assert.deepEqual(await pending, { error: 'запуск остановлен', costUsd: 0 });
  assert.deepEqual(await writeDigest(input(), { session: hang, signal: stop.signal }), { error: 'запуск остановлен', costUsd: 0 });
});

test('итог: ключ повтора — цифры, регистр и пробелы не делают замечания другими', () => {
  assert.equal(feedbackKey('Тесты падают: 3 ошибки\n в  строке 12'), feedbackKey('тесты падают: 2 ошибки в строке 40'));
  assert.notEqual(feedbackKey('Тесты падают'), feedbackKey('Нет README'));
});
