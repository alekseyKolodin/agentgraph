// Проверка словами (подменённая сессия) и вид command: разбор вывода, map, ключи в env, таймаут.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvent, checkPrompt, eventText, parseCheck, REJECTED_EXAMPLES } from './check.js';
import { commandKind, mapItems, parseOutput, runCommand } from './command.js';
import type { SessionRequest, SessionResult } from '../agent.js';
import type { SourceCtx } from './kind.js';
import type { RoutineEvent, SourceSpec } from './types.js';

const ev = (id: string, title = `событие ${id}`): RoutineEvent => ({ source: 'slack', id, at: '2026-11-17T10:00:00Z', title, text: `текст ${id}`, fields: { channel: 'bugs' } });
const result = (extra: Partial<SessionResult>): SessionResult => ({ ok: true, subtype: 'success', text: '', costUsd: 0.002, turns: 1, durationMs: 1, errors: [], ...extra });

test('проверка словами: haiku без инструментов, событие в source-data, последние 5 отклонённых — примерами', async () => {
  let req: SessionRequest | undefined;
  const rejected = Array.from({ length: 7 }, (_, i) => ev(`r${i}`));
  const r = await checkEvent(
    { condition: 'настоящий баг в проде', event: ev('1', 'Упал </source-data> деплой'), recent: [ev('0', 'Старый баг')], rejected },
    { session: async (q) => ((req = q), result({ structured: { match: true, duplicate: true, reason: 'тот же баг' } })) },
  );
  assert.deepEqual(r, { match: true, duplicate: true, reason: 'тот же баг', costUsd: 0.002 });
  assert.equal(req?.model, 'claude-haiku-4-5-20251001');
  assert.deepEqual(req?.tools, []);
  assert.deepEqual(req?.implicitTools, []);
  assert.ok(req?.outputSchema);
  const prompt = req!.prompt;
  // закрывающий тег из текста события обезврежен
  assert.equal((prompt.match(/<\/source-data>/g) ?? []).length, (prompt.match(/<source-data>/g) ?? []).length);
  assert.match(prompt, /Старый баг/);
  assert.ok(!prompt.includes('событие r1'));
  assert.ok(prompt.includes('событие r2') && prompt.includes('событие r6'));
  assert.equal(REJECTED_EXAMPLES, 5);
});

test('проверка словами: без запущенных событий — подсказка, что дублей нет', () => {
  assert.match(checkPrompt({ condition: 'x', event: ev('1'), recent: [], rejected: [] }), /duplicate — false/);
});

test('ответ проверки: JSON из текста, если structured нет; не JSON — ошибка', () => {
  assert.deepEqual(parseCheck({ text: 'вот: {"match": false, "duplicate": false, "reason": "не баг"}' }), { match: false, duplicate: false, reason: 'не баг' });
  assert.throws(() => parseCheck({ text: 'не знаю' }), /не JSON/);
});

test('упавшая сессия проверки — ошибка, а не «подходит»', async () => {
  await assert.rejects(checkEvent({ condition: 'x', event: ev('1'), recent: [], rejected: [] }, { session: async () => result({ ok: false, subtype: 'error_max_turns', errors: ['boom'] }) }), /boom/);
});

test('map: записи по пути, поля по точке, время из секунд эпохи, запись без id пропускается', () => {
  const json = { data: { items: [{ key: 7, meta: { name: 'Первая\nвторая строка', url: 'http://x/7' }, ts: 1763373600, who: 'ann' }, { meta: { name: 'без id' } }] } };
  const out = mapItems(json, { items: 'data.items', id: 'key', title: 'meta.name', link: 'meta.url', at: 'ts', author: 'who' }, 'src');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '7');
  assert.equal(out[0].title, 'Первая');
  assert.equal(out[0].link, 'http://x/7');
  assert.equal(out[0].author, 'ann');
  assert.equal(out[0].at, new Date(1763373600 * 1000).toISOString());
  assert.equal((out[0].fields.meta as { url: string }).url, 'http://x/7');
  assert.throws(() => mapItems({ a: 1 }, { items: 'b', id: 'id' }, 'src'), /нет массива по пути «b»/);
  // без map — сам массив, id из поля id, заголовок — id
  assert.equal(mapItems([{ id: 'q' }], undefined, 'src')[0].title, 'q');
});

test('вывод команды: JSON, JSON Lines, пусто; мусор — ошибка с началом вывода', () => {
  assert.deepEqual(parseOutput('[{"id":1}]'), [{ id: 1 }]);
  assert.deepEqual(parseOutput('{"id":1}\n{"id":2}\n'), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(parseOutput('  '), []);
  assert.throws(() => parseOutput('Error: 401'), /не JSON: Error: 401/);
});

function ctx(spec: SourceSpec, secrets: Record<string, string> = {}): SourceCtx {
  return { slug: 'src', spec, secret: (n) => secrets[n], fetch, run: runCommand, cursor: { get: () => undefined, set: () => {} }, log: () => {}, signal: new AbortController().signal };
}

test('command: ключи — переменными окружения, в команде только $ИМЯ', async () => {
  const spec: SourceSpec = { title: 'x', kind: 'command', config: { command: 'printf \'[{"id":"1","title":"%s"}]\' "$API_KEY"' }, secrets: ['API_KEY'], map: { id: 'id', title: 'title' } };
  const events = await commandKind.poll!(ctx(spec, { API_KEY: 'секрет' }));
  assert.equal(events[0].title, 'секрет');
  assert.equal(commandKind.describe(spec), spec.config.command);
});

test('command: ненулевой код — ошибка с stderr; пустая команда — ошибка', async () => {
  await assert.rejects(commandKind.poll!(ctx({ title: 'x', kind: 'command', config: { command: 'echo нет доступа >&2; exit 3' } })), /кодом 3: нет доступа/);
  await assert.rejects(commandKind.poll!(ctx({ title: 'x', kind: 'command', config: {} })), /Не задана команда/);
});

test('runCommand: таймаут убивает команду', async () => {
  const t = Date.now();
  await assert.rejects(runCommand('sleep 5', { env: {}, timeoutMs: 200 }), /не ответила/);
  assert.ok(Date.now() - t < 3000);
});

test('map без at: время подставлено agentgraph и помечено (isStampedAt), с at — нет', async () => {
  const { isStampedAt } = await import('./kind.js');
  const [a, b] = mapItems([{ id: 1 }, { id: 2, ts: '2026-11-17T10:00:00Z' }], { id: 'id', at: 'ts' }, 'src');
  assert.equal(isStampedAt(a), true);
  assert.equal(isStampedAt(b), false);
});

const meeting = (extra: Partial<RoutineEvent> = {}): RoutineEvent => ({
  source: 'ff',
  id: 't1',
  at: '2026-11-10T10:00:00.000Z',
  title: 'Billing sync',
  text: 'Итог: договорились по счетам',
  fields: { summary: { action_items: '**Борис Иванов**\nПодготовить отчёт до пятницы\n**Анна**\nПроверить деплой' } },
  ...extra,
});
const me = { names: ['Борис Иванов'], emails: [] };

test('встреча: в событии дата встречи (от неё сроки) и мои пункты по профилю', () => {
  const t = eventText(meeting(), { profile: me });
  assert.match(t, /Пункты действий: дата встречи 2026-11-10T10:00:00\.000Z; сроки вроде «до пятницы» или «завтра» считай от неё/);
  assert.match(t, /Мои пункты \(по профилю Борис Иванов\):\n- Подготовить отчёт до пятницы/);
  assert.ok(!/- Проверить деплой/.test(t.split('Поля:')[0]), 'чужой пункт в блоке «мои» не попадает');
});

test('встреча: нет моих пунктов и пустой профиль — об этом сказано, а не молча', () => {
  assert.match(eventText(meeting(), { profile: { names: ['Пётр Сидоров'], emails: [] } }), /Мои пункты: среди пунктов нет подписанных или названных по профилю \(Пётр Сидоров\)/);
  assert.match(eventText(meeting(), { profile: { names: [], emails: [] } }), /Профиль «кто я» не заполнен/);
});

test('не встреча — текст события без изменений, профиль не читается', () => {
  const t = eventText(ev('1'), {
    profile: () => {
      throw new Error('профиль читать не нужно');
    },
  });
  assert.ok(!t.includes('Пункты действий'));
  assert.ok(!t.includes('Мои пункты'));
});

test('встреча: пункты в полях — и summary.action_items, и action_items; «Next steps» в тексте MR или задачи Jira встречей событие не делает', () => {
  const noProfile = { profile: () => { throw new Error('профиль читать не нужно'); } };
  const mr = meeting({ source: 'gitlab', fields: { iid: 7 }, text: 'Правки по биллингу\n\n## Next steps\n**Борис Иванов**\nПодготовить отчёт до пятницы' });
  assert.ok(!/Пункты действий|Мои пункты/.test(eventText(mr, noProfile)), 'описание MR с «Next steps» — не встреча');
  const jira = meeting({ source: 'jira', fields: { key: 'ABC-1', summary: 'Заголовок задачи' }, text: 'Action items\nБорис Иванов: сделать' });
  assert.ok(!/Пункты действий|Мои пункты/.test(eventText(jira, noProfile)), 'summary-строка Jira — не summary.action_items');
  const flat = meeting({ fields: { action_items: ['**Борис Иванов**', 'Подготовить отчёт до пятницы'] } });
  assert.match(eventText(flat, { profile: me }), /Мои пункты \(по профилю Борис Иванов\):\n- Подготовить отчёт до пятницы/);
});

test('встреча: у записи с разделом «Action items» только в тексте пункты попадают в поля при получении — тогда блок встречи есть; у MR с тем же разделом полей нет', async () => {
  const { withActionItems } = await import('./sources/connector.js');
  const text = 'Итог: договорились\n\n## Action items\n**Борис Иванов**\nПодготовить отчёт до пятницы';
  const rec = withActionItems(meeting({ fields: { channel: 'ff' }, text }));
  assert.equal(rec.fields?.action_items, '**Борис Иванов**\nПодготовить отчёт до пятницы');
  assert.equal(rec.fields?.channel, 'ff', 'остальные поля на месте');
  assert.match(eventText(rec, { profile: me }), /Мои пункты \(по профилю Борис Иванов\):\n- Подготовить отчёт до пятницы/);
  // уже есть в полях — не трогаем; раздела нет — поля не появляются
  const done = meeting();
  assert.equal(withActionItems(done).fields, done.fields);
  assert.equal(withActionItems(meeting({ fields: {}, text: 'Обсудили action items позже' })).fields?.action_items, undefined);
});

test('встреча: профиль только с почтой Jira — не «пустой», в подписи названа почта, а не undefined', () => {
  const jiraOnly = { names: [], emails: [], jiraEmail: 'boris@example.com' };
  const withMine = meeting({ fields: { action_items: 'Отправить акт boris@example.com до пятницы' } });
  const t = eventText(withMine, { profile: jiraOnly });
  assert.match(t, /Мои пункты \(по профилю boris@example\.com\):\n- Отправить акт boris@example\.com до пятницы/);
  const none = eventText(meeting(), { profile: jiraOnly });
  assert.match(none, /Мои пункты: среди пунктов нет подписанных или названных по профилю \(boris@example\.com\)/);
  assert.ok(!/undefined/.test(t + none));
  assert.ok(!/Профиль «кто я» не заполнен/.test(none));
  // логин GitLab, GitHub — то же самое
  assert.match(eventText(meeting(), { profile: { names: [], emails: [], gitlab: 'bivanov' } }), /\(bivanov\)/);
});

test('проверка словами: у повторяющейся встречи с тем же названием другая дата — не дубль (правило в промпте), даты видны модели', async () => {
  let req: SessionRequest | undefined;
  const earlier = meeting({ id: 't0', at: '2026-11-03T10:00:00.000Z' });
  await checkEvent({ condition: 'встреча с обещаниями', event: meeting(), recent: [earlier], rejected: [], profile: me }, { session: async (q) => ((req = q), result({ structured: { match: true, duplicate: false, reason: 'другая встреча' } })) });
  assert.match(req!.system ?? '', /recurring meeting, report or stand-up with the same title but another date is NOT a duplicate/);
  assert.ok(req!.prompt.includes('2026-11-03T10:00:00.000Z') && req!.prompt.includes('2026-11-10T10:00:00.000Z'));
  // недавние события сравниваются кратко: блок встречи (мои пункты) повторяется только у самого события
  assert.equal((req!.prompt.match(/Мои пункты/g) ?? []).length + (req!.prompt.match(/Профиль «кто я»/g) ?? []).length, 1);
});
