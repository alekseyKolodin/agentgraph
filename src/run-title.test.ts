import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { pickRunTitle } from './run-title.js';
import { withTagsInput } from './tags.js';
import type { SessionRequest, SessionResult } from './agent.js';

const result = (over: Partial<SessionResult> = {}): SessionResult =>
  ({ ok: true, subtype: 'success', text: '', costUsd: 0.001, turns: 1, durationMs: 10, errors: [], ...over });

/** Сессия, отвечающая structured (или over); все запросы — в reqs. */
function fake(structured: unknown, over: Partial<SessionResult> = {}) {
  const reqs: SessionRequest[] = [];
  const session = async (req: SessionRequest) => {
    reqs.push(req);
    return result({ structured, ...over });
  };
  return { reqs, session };
}

/** Сессия, которая отвечает только после abort (или никогда, если abort не слушать). */
function waitAbort(onAbort: () => void) {
  return (req: SessionRequest) =>
    new Promise<SessionResult>((resolve) => {
      req.abort!.signal.addEventListener('abort', () => {
        onAbort();
        setTimeout(() => resolve(result({ structured: { title: 'Поздно' } })), 5);
      });
    });
}

test('имя запуска: валидный ответ — имя и стоимость; запрос без инструментов, haiku, без сохранения', async () => {
  const f = fake({ title: 'Эндпоинт здоровья сервиса' });
  const r = await pickRunTitle('Добавь эндпоинт /health', { flow: 'feature' }, { session: f.session });
  assert.deepEqual(r, { title: 'Эндпоинт здоровья сервиса', costUsd: 0.001 });
  const req = f.reqs[0];
  assert.deepEqual(req.tools, []);
  assert.deepEqual(req.implicitTools, []);
  assert.equal(req.model, 'haiku');
  assert.equal(req.persist, false);
  assert.equal(req.cwd, os.tmpdir());
  assert.ok(req.abort);
  assert.ok(req.outputSchema);
});

test('имя запуска: промпт — flow и источник; задача и заголовок источника в source-data, блоки тегов сняты, длинная обрезана', async () => {
  const f = fake({ title: 'x' });
  const input = withTagsInput('Добавь экспорт CSV', [{ slug: 'other-tag', summary: 'саммари-чужого' }]);
  await pickRunTitle(input, { flow: 'feature', source: { type: 'jira', key: 'APP-1', title: 'Экспорт' } }, { session: f.session });
  const p = f.reqs[0].prompt;
  assert.match(p, /Flow: feature/);
  assert.match(p, /Источник: jira APP-1/);
  assert.match(p, /<source-data>\nЭкспорт\n<\/source-data>/);
  assert.match(p, /<source-data>\nДобавь экспорт CSV\n<\/source-data>/);
  for (const s of ['other-tag', 'саммари-чужого']) assert.ok(!p.includes(s), s);

  const long = fake({ title: 'x' });
  await pickRunTitle('а'.repeat(5000), {}, { session: long.session });
  assert.ok(long.reqs[0].prompt.includes('а'.repeat(2000) + '…'));
  assert.ok(!long.reqs[0].prompt.includes('а'.repeat(2001)));
});

test('имя запуска: переводы строк, управляющие символы и угловые скобки вычищены, длина до 60', async () => {
  const r = await pickRunTitle('задача', {}, { session: fake({ title: 'Бонусы\n\r\t<script>кофе</script>\u001b[31m' }).session });
  assert.equal(r.title, 'Бонусы scriptкофе/script [31m');
  const long = await pickRunTitle('задача', {}, { session: fake({ title: 'Очень '.repeat(30) }).session });
  assert.equal(long.title!.length <= 60, true);
  assert.equal(long.title, long.title!.trim());
});

test('имя запуска: пустое имя или мусор — { error } со стоимостью', async () => {
  for (const structured of [{ title: '' }, { title: ' \n<>\t ' }, { title: 5 }, {}, undefined]) {
    const r = await pickRunTitle('задача', {}, { session: fake(structured).session });
    assert.ok(r.error, JSON.stringify(structured));
    assert.equal(r.title, undefined);
    assert.equal(r.costUsd, 0.001);
  }
  const failed = await pickRunTitle('задача', {}, { session: fake({ title: 'x' }, { ok: false, subtype: 'error_max_turns' }).session });
  assert.match(failed.error!, /error_max_turns/);
});

test('имя запуска: сессия бросила — { error, costUsd: 0 } без исключения', async () => {
  const r = await pickRunTitle('задача', {}, { session: async () => { throw new Error('нет сети'); } });
  assert.deepEqual(r, { error: 'нет сети', costUsd: 0 });
});

test('имя запуска: таймаут — сессия снята через abort, { error } про таймаут', async () => {
  let aborted = false;
  const r = await pickRunTitle('задача', {}, { session: waitAbort(() => { aborted = true; }), timeoutMs: 20 });
  assert.match(r.error!, /таймаут/);
  assert.equal(r.title, undefined);
  assert.ok(aborted);
});

test('имя запуска: пустая задача (одни блоки тегов) — модель не вызывается', async () => {
  const f = fake({ title: 'x' });
  const r = await pickRunTitle(withTagsInput('', [{ slug: 'a', summary: 's' }]), {}, { session: f.session });
  assert.ok(r.error);
  assert.equal(r.costUsd, 0);
  assert.equal(f.reqs.length, 0);
});

test('имя запуска: внешний abort прерывает подбор сразу, даже если сессия abort не слушает', async () => {
  const stop = new AbortController();
  let aborted = false;
  // сессия не отвечает никогда: без гонки с внешним сигналом подбор висел бы до таймаута
  const session = (req: SessionRequest) =>
    new Promise<SessionResult>(() => {
      req.abort!.signal.addEventListener('abort', () => { aborted = true; });
    });
  const started = Date.now();
  const pending = pickRunTitle('задача', {}, { session, signal: stop.signal, timeoutMs: 10_000 });
  setTimeout(() => stop.abort(), 10);
  const r = await pending;
  assert.match(r.error!, /остановлен/);
  assert.ok(aborted);
  assert.ok(Date.now() - started < 5000);
  // уже остановленный запуск — сессия не вызывается
  const f = fake({ title: 'x' });
  const late = await pickRunTitle('задача', {}, { session: f.session, signal: stop.signal });
  assert.match(late.error!, /остановлен/);
  assert.equal(f.reqs.length, 0);
});
