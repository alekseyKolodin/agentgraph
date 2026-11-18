import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import type { SessionRequest, SessionResult } from '../../agent.js';
import type { McpCaller, McpCallResult } from '../../mcp-call.js';
import { toResult } from '../../mcp-call.js';
import type { SourceSpec, SourceTestResult } from '../types.js';
import { BUILD_MODEL, CONNECTOR_MODEL, buildSpecOf, checkToolName, connectorKind, createConnectorBuilds, fillArgs, mcpServices, plainText, sampleProblem, scriptOf, textItems } from './connector.js';
import { makeCtx } from './testkit.js';

const TOOL = 'mcp__claude_ai_Fireflies__fireflies_get_transcripts';
const SEARCH = 'mcp__claude_ai_Slack__slack_search_public';
const READ = 'mcp__claude_ai_Slack__slack_read_channel';
const ok = (structured: unknown): SessionResult => ({ ok: true, subtype: 'success', text: '', structured, costUsd: 0.01, turns: 2, durationMs: 1, errors: [] });

/** Подменённые вызовы MCP: ответ по имени инструмента, все вызовы в calls. */
function fakeMcp(answers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let closed = 0;
  const mcp = (): McpCaller => ({
    call: async (tool, args): Promise<McpCallResult> => {
      calls.push({ tool, args });
      const a = answers[tool];
      const raw = typeof a === 'function' ? (a as (x: Record<string, unknown>) => unknown)(args) : a;
      return toResult(raw);
    },
    close: () => void closed++,
  });
  return { mcp, calls, closed: () => closed };
}
const textOf = (v: unknown) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });

test('connector без скрипта (источник до скриптов): сессия haiku с одним разрешённым инструментом, записи → события', async () => {
  const reqs: SessionRequest[] = [];
  const kind = connectorKind({
    session: async (req) => {
      reqs.push(req);
      return ok({ records: [{ id: 'm1', title: 'Планёрка', text: 'Обсудили релиз', link: 'https://f.test/m1', at: '2026-11-17T09:00:00Z', author: 'Анна' }, { id: '', title: 'Без id', link: 'https://f.test/m2' }, { title: '', id: '' }] });
    },
  });
  const events = await kind.poll!(makeCtx({ slug: 'ff', config: { tool: TOOL, request: 'Встречи за сутки' } }));
  assert.deepEqual(events.map((e) => [e.id, e.title, e.author, e.link]), [['m1', 'Планёрка', 'Анна', 'https://f.test/m1'], ['https://f.test/m2', 'Без id', undefined, 'https://f.test/m2']]);
  const r = reqs[0];
  assert.equal(r.model, CONNECTOR_MODEL);
  assert.deepEqual([r.tools, r.implicitTools, r.allow, r.persist], [[], [], [TOOL], false]);
  assert.match(r.prompt, /<source-data>\nВстречи за сутки\n<\/source-data>/);
  // хук пропускает только свой инструмент
  assert.equal(r.guard!(TOOL, {}, { cwd: '/' }), undefined);
  assert.match(r.guard!('Bash', {}, { cwd: '/' })!, /Разрешены только/);
  assert.match(r.guard!('mcp__claude_ai_Fireflies__delete_meeting', {}, { cwd: '/' })!, /Разрешены только/);
});

test('connector: со скриптом — раз в минуту и без модели, без скрипта — раз в 30 минут', () => {
  const k = connectorKind();
  const withScript: SourceSpec = { title: 's', kind: 'connector', config: { tools: [READ], script: { steps: [{ tool: READ, args: {}, say: 'Читает', json: { id: 'ts' } }] } } };
  const legacy: SourceSpec = { title: 's', kind: 'connector', config: { tool: TOOL } };
  assert.equal(k.minEveryFor!(withScript), 60_000);
  assert.equal(k.minEveryFor!(legacy), 30 * 60_000);
  assert.equal(k.delivery, 'poll');
  assert.ok(k.setup.every((f) => /[а-я]/i.test(f.label)));
  assert.equal(k.setup.find((f) => f.key === 'tools')!.pick, 'mcp-tool');
});

test('connector: инструмент записи не принимается, пустое имя и чужой формат — тоже', () => {
  assert.equal(checkToolName(TOOL), TOOL);
  assert.equal(checkToolName('mcp__claude_ai_Notion__notion-search'), 'mcp__claude_ai_Notion__notion-search');
  assert.equal(checkToolName('mcp__claude_ai_X__list_assets'), 'mcp__claude_ai_X__list_assets');
  assert.throws(() => checkToolName('mcp__claude_ai_Slack__slack_send_message'), /похож на запись/);
  assert.throws(() => checkToolName('mcp__claude_ai_Notion__createPage'), /похож на запись/);
  assert.throws(() => checkToolName('mcp__claude_ai_Claude_Docs__batch'), /похож на запись/);
  assert.throws(() => checkToolName('mcp__claude_ai_Slack__slack_schedule_message'), /похож на запись/);
  assert.throws(() => checkToolName('Bash'), /Выберите сервис/);
  assert.throws(() => checkToolName(undefined), /Выберите сервис/);
});

test('connector: сессия упала или ответ не список — понятная ошибка', async () => {
  const failed = connectorKind({ session: async () => ({ ...ok(undefined), ok: false, subtype: 'error_max_turns', errors: ['слишком долго'] }) });
  await assert.rejects(() => failed.poll!(makeCtx({ config: { tool: TOOL } })), /слишком долго/);
  const bad = connectorKind({ session: async () => ok({ nope: 1 }) });
  await assert.rejects(() => bad.poll!(makeCtx({ config: { tool: TOOL } })), /не вернула список/);
});

test('connector: обработчик на сигнале опроса снимается после каждого опроса (и при ошибке), слушатели не копятся', async () => {
  const ok1 = connectorKind({ session: async () => ok({ records: [] }) });
  const failing = connectorKind({ session: async () => { throw new Error('сеть'); } });
  const ctx = makeCtx({ config: { tool: TOOL } });
  for (let i = 0; i < 30; i++) await ok1.poll!(ctx);
  for (let i = 0; i < 30; i++) await assert.rejects(() => failing.poll!(ctx), /сеть/);
  assert.equal(getEventListeners(ctx.signal, 'abort').length, 0);
  // остановка источника по-прежнему доходит до сессии
  let aborted = false;
  const slow = connectorKind({ session: async (req) => { ctx.abort.abort(); aborted = req.abort!.signal.aborted; return ok({ records: [] }); } });
  await slow.poll!(ctx);
  assert.equal(aborted, true);
});

test('connector: в выбор попадают только читающие инструменты, описание и порядок сервера', () => {
  const tool = (t: string, o: { readOnly?: boolean; annotated?: boolean; description?: string } = {}) => ({
    name: `mcp__claude_ai_Slack__${t}`, tool: t, readOnly: o.readOnly ?? false, annotated: o.annotated ?? false, ...(o.description ? { description: o.description } : {}),
  });
  const [slack, local] = mcpServices([
    {
      server: 'claude.ai Slack', name: 'mcp__claude_ai_Slack', status: 'connected', scope: 'claudeai',
      tools: [
        tool('slack_read_channel', { readOnly: true, annotated: true }),
        tool('slack_send_message'),
        tool('slack_search_public', { readOnly: true, annotated: true, description: 'Search messages in public channels' }),
        // сервер разметил: не только чтение — прячем, хоть имя и безобидное
        tool('slack_fetch_later', { readOnly: false, annotated: true }),
      ],
    },
    { server: 'jira', name: 'mcp__jira', status: 'connected', scope: 'user', tools: [{ name: 'mcp__jira__list_issues', tool: 'list_issues', readOnly: false, annotated: false }] },
  ]);
  assert.deepEqual([slack.title, slack.origin, slack.hidden], ['Slack', 'claudeai', 2]);
  assert.deepEqual(slack.tools.map((x) => x.tool), ['slack_read_channel', 'slack_search_public']);
  assert.equal(slack.tools[1].description, 'Search messages in public channels');
  assert.deepEqual([local.title, local.origin, local.tools.map((x) => x.name)], ['jira', 'claude-code', ['mcp__jira__list_issues']]);
});

// ---------------------------------------------------------------- скрипт без модели

const scriptSpec = (steps: unknown[], tools = [SEARCH, READ]): SourceSpec => ({ title: 'Slack', kind: 'connector', config: { tools, request: 'баги', script: { steps } } });

test('скрипт: JSON-ответ по полям, {{since}} — время прошлой проверки, модель не нужна', async () => {
  const f = fakeMcp({ [SEARCH]: textOf({ messages: [{ ts: '1731920000.1', text: 'Не грузится профиль\nпосле релиза', permalink: 'https://slack.test/p1', user: 'anna' }, { text: 'без ts' }] }) });
  const kind = connectorKind({ session: async () => assert.fail('модель не нужна'), mcp: f.mcp });
  const ctx = makeCtx({ slug: 'sl', config: scriptSpec([{ tool: SEARCH, args: { query: 'in:#bugs after:{{since_date}}', limit: 20 }, say: 'Ищет в #bugs', json: { items: 'messages', id: 'ts', title: 'text', text: 'text', link: 'permalink', author: 'user' } }]).config, cursor: '2026-11-17T10:00:00.000Z' });
  const events = await kind.poll!(ctx);
  assert.deepEqual(events.map((e) => [e.id, e.title, e.link, e.author]), [['1731920000.1', 'Не грузится профиль', 'https://slack.test/p1', 'anna']]);
  assert.deepEqual(f.calls, [{ tool: SEARCH, args: { query: 'in:#bugs after:2026-11-17', limit: 20 } }]);
  assert.equal(f.closed(), 1);
  // следующая проверка — от этой, с минутой внахлёст
  assert.ok(Date.now() - Date.parse(String(ctx.cursorValue())) < 2 * 60_000);
});

test('скрипт: текстовый ответ разбирается регулярками, без id — по ссылке', () => {
  const text = '### Anna (2026-11-18 09:00)\nНе грузится профиль\nhttps://slack.test/p1\n### Boris (2026-11-18 09:05)\nПадает оплата\nhttps://slack.test/p2';
  const events = textItems(text, { split: '^### ', author: '^(\\S+)', at: '\\((.+?)\\)', title: '\\n(.+)', link: '(https://\\S+)' }, 'sl');
  assert.deepEqual(events.map((e) => [e.id, e.title, e.author]), [['https://slack.test/p1', 'Не грузится профиль', 'Anna'], ['https://slack.test/p2', 'Падает оплата', 'Boris']]);
});

test('скрипт: текст в JSON-обёртке разбирается по самому тексту, шапка ответа — не запись', async () => {
  const body = '# Search Results for: in:#android-code-review\n\n### Ревью: MR !12 Авторизация\nTime: 2026-11-18 09:00\nhttps://slack.test/p1\n\n### Ревью: MR !13 Профиль\nTime: 2026-11-18 09:05\nhttps://slack.test/p2';
  assert.equal(plainText(toResult(textOf({ results: body }))), body);
  assert.equal(plainText(toResult(textOf('просто текст'))), 'просто текст');
  // массив — не обёртка: отдаём сырой текст
  assert.equal(plainText(toResult(textOf(['a', 'b']))), '["a","b"]');
  const f = fakeMcp({ [SEARCH]: textOf({ results: body }) });
  const kind = connectorKind({ session: async () => assert.fail('модель не нужна'), mcp: f.mcp });
  const steps = [{ tool: SEARCH, args: {}, say: 'Ищет', text: { split: '^### ', id: '(https://\\S+)', title: '^Ревью: (.+)' } }];
  const events = await kind.poll!(makeCtx({ config: scriptSpec(steps).config }));
  assert.deepEqual(events.map((e) => [e.id, e.title]), [['https://slack.test/p1', 'MR !12 Авторизация'], ['https://slack.test/p2', 'MR !13 Профиль']]);
});

test('скрипт: несколько шагов — записи вместе, повторы id один раз; ошибка инструмента — понятная', async () => {
  const f = fakeMcp({ [SEARCH]: textOf([{ id: 'a' }, { id: 'b' }]), [READ]: textOf([{ id: 'b' }, { id: 'c' }]) });
  const kind = connectorKind({ session: async () => assert.fail(), mcp: f.mcp });
  const steps = [{ tool: SEARCH, args: {}, say: '1', json: { id: 'id' } }, { tool: READ, args: {}, say: '2', json: { id: 'id' } }];
  const events = await kind.poll!(makeCtx({ config: scriptSpec(steps).config }));
  assert.deepEqual(events.map((e) => e.id), ['a', 'b', 'c']);
  const broken = connectorKind({ session: async () => assert.fail(), mcp: fakeMcp({ [SEARCH]: { content: [{ type: 'text', text: 'channel_not_found' }], isError: true } }).mcp });
  await assert.rejects(() => broken.poll!(makeCtx({ config: scriptSpec([steps[0]]).config })), /slack_search_public: channel_not_found/);
});

test('скрипт: неотмеченный или пишущий инструмент, шаг без правила разбора, битая регулярка — не выполняются', () => {
  assert.throws(() => scriptOf(scriptSpec([{ tool: READ, args: {}, say: '', json: { id: 'id' } }], [SEARCH])), /не отмечен/);
  assert.throws(() => scriptOf(scriptSpec([{ tool: 'mcp__claude_ai_Slack__slack_send_message', args: {}, say: '', json: { id: 'id' } }])), /похож на запись/);
  assert.throws(() => scriptOf(scriptSpec([{ tool: READ, args: {}, say: '' }])), /как достать записи/);
  assert.throws(() => scriptOf(scriptSpec([{ tool: READ, args: {}, say: '', text: { split: '\\n', id: '([' } }])), /не разбирается/);
  assert.deepEqual(fillArgs({ a: ['{{since_unix}}', 5] }, new Date('2026-11-18T00:00:00Z')), { a: ['1794960000', 5] });
});

// ---------------------------------------------------------------- сборка скрипта

const step = { tool: SEARCH, args_json: '{"query":"in:#bugs"}', say: 'Ищет сообщения в #bugs', format: 'json', map_items: 'messages', map_id: 'ts', map_title: 'text' };
const found = (total: number): SourceTestResult => ({ ok: true, request: 'r', sample: [], total });

async function settle(b: ReturnType<typeof createConnectorBuilds>, id: string) {
  for (let i = 0; i < 100; i++) {
    const v = b.get(id)!;
    if (v.state !== 'working') return v;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('сборка не закончилась');
}

test('сборка: модель собирает скрипт по отмеченным инструментам, прогон без модели — источник готов', async () => {
  const reqs: SessionRequest[] = [];
  const tested: SourceSpec[] = [];
  const b = createConnectorBuilds({
    session: async (req) => (reqs.push(req), ok({ ok: true, title: 'Slack · #bugs', expected: 2, steps: [step] })),
    testSource: async (spec) => (tested.push(spec), found(2)),
    newId: () => 'b1',
  });
  const v = await settle(b, b.start({ tools: [SEARCH, READ], request: 'новые сообщения в #bugs' }).id);
  assert.equal(v.state, 'ready');
  if (v.state !== 'ready') return;
  assert.equal(v.mode, 'script');
  assert.deepEqual(v.spec.config, { tools: [SEARCH, READ], request: 'новые сообщения в #bugs', script: { steps: [{ tool: SEARCH, args: { query: 'in:#bugs' }, say: 'Ищет сообщения в #bugs', json: { items: 'messages', id: 'ts', title: 'text' } }] } });
  assert.equal(v.spec.title, 'Slack · #bugs');
  assert.equal(tested.length, 1);
  const r = reqs[0];
  assert.equal(r.model, BUILD_MODEL);
  assert.deepEqual(r.allow, [SEARCH, READ]);
  assert.match(r.guard!('mcp__claude_ai_Slack__slack_read_thread', {}, { cwd: '/' })!, /Разрешены только/);
  assert.match(r.prompt, /<source-data>\nновые сообщения в #bugs/);
});

test('сборка: прогон не удался — модель правит по ошибке; не вышло и со второй — проверка через модель с объяснением', async () => {
  const prompts: string[] = [];
  const b = createConnectorBuilds({
    session: async (req) => (prompts.push(req.prompt), ok({ ok: true, expected: 3, steps: [step] })),
    testSource: async () => found(0),
    newId: () => 'b2',
  });
  const v = await settle(b, b.start({ tools: [SEARCH], request: 'баги' }).id);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /ничего не нашёл, хотя при сборке было видно записей: 3/);
  assert.equal(v.state, 'ready');
  if (v.state !== 'ready') return;
  assert.equal(v.mode, 'model');
  assert.match(v.problem!, /ничего не нашёл/);
  assert.equal(v.spec.every, '30m');
  assert.equal('script' in v.spec.config, false);
});

const sampleOf = (titles: Array<string | undefined>): SourceTestResult => ({
  ok: true,
  request: 'r',
  total: titles.length,
  sample: titles.map((title, i) => ({ source: 's', id: `1763456400.${i}`, at: '', title: title ?? `1763456400.${i}`, text: '', fields: {} })),
});

test('сборка: заголовок записи — её id — модель пересобирает с замечанием, итог готов', async () => {
  assert.match(sampleProblem(sampleOf([undefined]).sample)!, /^Заголовок у найденных записей — это их id \(«1763456400\.0»\)/);
  assert.equal(sampleProblem(sampleOf(['MR !12 Авторизация']).sample), undefined);
  assert.equal(sampleProblem([]), undefined);
  const prompts: string[] = [];
  const b = createConnectorBuilds({
    session: async (req) => (prompts.push(req.prompt), ok({ ok: true, expected: 1, steps: [step] })),
    testSource: async () => sampleOf([undefined]),
    newId: () => 'b3',
  });
  const v = await settle(b, b.start({ tools: [SEARCH], request: 'ревью' }).id);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Заголовок у найденных записей — это их id/);
  assert.match(prompts[1], /инструмент, который читает записи целиком/);
  assert.equal(v.state, 'ready');
});

test('сборка: у всех записей один заголовок — модель пересобирает с замечанием; на последней попытке скрипт как есть', async () => {
  const same = sampleOf(['Channel: #android-code-review (ID: C1)', 'Channel: #android-code-review (ID: C1)']);
  assert.match(sampleProblem(same.sample)!, /одинаковый заголовок: «Channel: #android-code-review \(ID: C1\)»/);
  assert.equal(sampleProblem(sampleOf(['Channel: #android-code-review (ID: C1)']).sample), undefined);
  const prompts: string[] = [];
  const b = createConnectorBuilds({
    session: async (req) => (prompts.push(req.prompt), ok({ ok: true, expected: 2, steps: [step] })),
    testSource: async () => same,
    newId: () => 'b4',
  });
  const v = await settle(b, b.start({ tools: [SEARCH], request: 'ревью' }).id);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /одинаковый заголовок/);
  assert.equal(v.state, 'ready');
  if (v.state !== 'ready') return;
  assert.equal(v.mode, 'script');
  assert.ok(v.spec.config.script);
});

test('сборка: сервис не подходит — ошибка словами модели; поправка словами помнит прошлый скрипт', async () => {
  let n = 0;
  const prompts: string[] = [];
  const b = createConnectorBuilds({
    session: async (req) => (prompts.push(req.prompt), n++ === 0 ? ok({ ok: true, expected: 1, steps: [step] }) : ok({ ok: false, reason: 'В Slack нет такого канала' })),
    testSource: async () => found(1),
    newId: () => `b${n}`,
  });
  const first = await settle(b, b.start({ tools: [SEARCH], request: 'баги' }).id);
  const second = await settle(b, b.start({ tools: [SEARCH], request: 'баги', note: 'только #bugs-prod', from: first.id }).id);
  assert.deepEqual(second, { id: second.id, state: 'error', error: 'В Slack нет такого канала' });
  assert.match(prompts[1], /только #bugs-prod/);
  assert.match(prompts[1], /Предыдущий вариант скрипта/);
  assert.throws(() => b.start({ tools: ['mcp__claude_ai_Slack__slack_send_message'], request: 'x' }), /похож на запись/);
});

test('сборка: ответ модели → spec; битые аргументы — пустой объект, текстовый формат — регулярки', () => {
  const a = buildSpecOf({ ok: true, steps: [{ tool: READ, args_json: 'не json', say: 'Читает', format: 'text', split: '^---', map_id: 'id: (\\S+)' }] }, { tools: [READ], request: 'r' });
  assert.equal(a.ok, true);
  if (a.ok) assert.deepEqual((a.spec.config.script as { steps: unknown[] }).steps, [{ tool: READ, args: {}, say: 'Читает', text: { split: '^---', id: 'id: (\\S+)' } }]);
  assert.deepEqual(buildSpecOf({ ok: true, steps: [] }, { tools: [READ], request: 'r' }), { ok: false, error: 'Сессия не вернула шагов скрипта', retry: true });
});

test('connector без скрипта: стоимость опроса моделью уходит в ctx.cost один раз — и когда записей нет, и когда сессия не удалась', async () => {
  const spent: number[] = [];
  const ctx = { ...makeCtx({ config: { tool: TOOL } }), cost: (usd: number) => void spent.push(usd) };
  const many = connectorKind({ session: async () => ok({ records: [{ id: 'a' }, { id: 'b' }] }) });
  assert.equal((await many.poll!(ctx)).length, 2);
  await connectorKind({ session: async () => ok({ records: [] }) }).poll!(ctx);
  const failed = connectorKind({ session: async () => ({ ...ok(undefined), ok: false, subtype: 'error_max_turns', errors: ['долго'], costUsd: 0.03 }) });
  await assert.rejects(() => failed.poll!(ctx), /долго/);
  assert.deepEqual(spent, [0.01, 0.01, 0.03]);
});

test('connector без скрипта: сессия бросила исключение с расходом — он всё равно уходит в ctx.cost, ошибка не теряется', async () => {
  const spent: number[] = [];
  const ctx = { ...makeCtx({ config: { tool: TOOL } }), cost: (usd: number) => void spent.push(usd) };
  const boom = connectorKind({ session: async () => { throw Object.assign(new Error('соединение оборвалось'), { costUsd: 0.04 }); } });
  await assert.rejects(() => boom.poll!(ctx), /соединение оборвалось/);
  assert.deepEqual(spent, [0.04]);
});

test('isSelf коннектора: автор совпал с профилем (имя, почта, id Slack) — не событие', () => {
  const profile = { names: ['Иван Петров'], emails: ['me@corp.test'], slackUserId: 'UME' };
  const k = connectorKind({ session: async () => ok({ records: [] }), profile: () => profile });
  const ctx = makeCtx({ kind: 'connector' });
  const ev = (author: string, fields: Record<string, unknown> = {}) => ({ source: 's', id: 'x', at: '', title: '', text: '', author, fields });
  assert.equal(k.isSelf!(ctx, ev('иван петров')), true);
  assert.equal(k.isSelf!(ctx, ev('Ваня <ME@corp.test>')), true);
  assert.equal(k.isSelf!(ctx, ev('', { user: 'UME' })), true);
  assert.equal(k.isSelf!(ctx, ev('Анна')), false);
  assert.equal(k.isSelf!(ctx, ev('Анна, Иван Петров')), false, 'участники встречи — не моя реплика');
  const empty = connectorKind({ session: async () => ok({}), profile: () => ({ names: [], emails: [] }) });
  assert.equal(empty.isSelf!(ctx, ev('')), false, 'пустой профиль никого не считает своим');
});

test('isSelf коннектора: без автора, регистр, «@логин», «Имя <почта>» и скобки', () => {
  const profile = { names: ['Иван  Петров'], emails: ['me@corp.test'], gitlab: 'ipet', slackUserId: 'UME' };
  const k = connectorKind({ session: async () => ok({}), profile: () => profile });
  const ctx = makeCtx({ kind: 'connector' });
  const ev = (author?: string, fields: Record<string, unknown> = {}) => ({ source: 's', id: 'x', at: '', title: '', text: '', ...(author === undefined ? {} : { author }), fields });
  assert.equal(k.isSelf!(ctx, ev()), false, 'без автора — не свой');
  assert.equal(k.isSelf!(ctx, ev(undefined, { user: 'U-other' })), false);
  assert.equal(k.isSelf!(ctx, ev('@IPet')), true);
  assert.equal(k.isSelf!(ctx, ev('  иван петров ')), true);
  assert.equal(k.isSelf!(ctx, ev('"Петров И." <Me@Corp.test>')), true);
  assert.equal(k.isSelf!(ctx, ev('Петров И. <other@corp.test>')), false);
  assert.equal(k.isSelf!(ctx, ev('@anna')), false);
  assert.equal(k.isSelf!(ctx, ev('Иван')), false, 'часть имени — не совпадение');
});
