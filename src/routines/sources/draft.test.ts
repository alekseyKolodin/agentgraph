import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionRequest, SessionResult } from '../../agent.js';
import type { DraftDeps } from '../kind.js';
import type { DraftView, SourceSpec, SourceTestResult } from '../types.js';
import { createDraftRoutes, DRAFT_MODEL, specOf } from './draft.js';

const answer = (over: Record<string, unknown> = {}) => ({
  api_found: true,
  reason: '',
  title: 'Fireflies.ai · записи встреч',
  command: `curl -sS https://api.fireflies.ai/graphql -H "Authorization: Bearer $FIREFLIES_API_KEY" -d '{"query":"{ transcripts { id title } }"}'`,
  every: '5m',
  map_items: 'data.transcripts',
  map_id: 'id',
  map_title: 'title',
  secrets: ['FIREFLIES_API_KEY'],
  how_to: 'Берётся в Fireflies: Settings → API.',
  ...over,
});
const session = (structured: unknown, over: Partial<SessionResult> = {}): SessionResult => ({ ok: true, subtype: 'success', text: '', structured, costUsd: 0, turns: 1, durationMs: 1, errors: [], ...over });
const goodTest = (spec: SourceSpec): SourceTestResult => ({ ok: true, request: String(spec.config.command), sample: [], total: 3 });

type Harness = {
  routes: ReturnType<typeof createDraftRoutes>;
  reqs: SessionRequest[];
  tests: Array<{ spec: SourceSpec; secrets?: Record<string, string> }>;
  saved: Array<{ slug: string; secrets?: Record<string, string> }>;
  secretsSaved: Record<string, string>;
};

function harness(opts: { answers: Array<unknown | (() => SessionResult)>; tests?: Array<(spec: SourceSpec) => SourceTestResult>; hasSecret?: (n: string) => boolean; saveSecret?: boolean }): Harness {
  const reqs: SessionRequest[] = [];
  const tests: Harness['tests'] = [];
  const saved: Harness['saved'] = [];
  const secretsSaved: Record<string, string> = {};
  let n = 0;
  let t = 0;
  const deps: DraftDeps = {
    saveSource: (slug, _spec, secrets) => void saved.push({ slug, secrets }),
    testSource: async (spec, secrets) => {
      tests.push({ spec, secrets });
      return (opts.tests?.[t++] ?? goodTest)(spec);
    },
    hasSecret: opts.hasSecret ?? (() => false),
    freeSlug: (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'source',
    ...(opts.saveSecret ? { saveSecret: (name: string, value: string) => void (secretsSaved[name] = value) } : {}),
  };
  const routes = createDraftRoutes(deps, {
    newId: () => 'd1',
    session: async (req) => {
      reqs.push(req);
      const a = opts.answers[Math.min(n++, opts.answers.length - 1)];
      return typeof a === 'function' ? (a as () => SessionResult)() : session(a);
    },
  });
  return { routes, reqs, tests, saved, secretsSaved };
}

/** Ждём, пока черновик выйдет из working. */
async function settle(h: Harness, id = 'd1'): Promise<DraftView> {
  for (let i = 0; i < 200; i++) {
    const v = h.routes.get(id)!;
    if (v.state !== 'working') return v;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('черновик завис в working');
}

test('start сразу отвечает working, потом needs_secret с подсказкой, где взять ключ; запрос сессии — sonnet, только поиск', async () => {
  const h = harness({ answers: [answer()] });
  const v = h.routes.start('  Новая запись встречи в Fireflies.ai  ');
  assert.equal(v.state, 'working');
  assert.equal(v.description, 'Новая запись встречи в Fireflies.ai');
  const s = await settle(h);
  assert.equal(s.state, 'needs_secret');
  assert.ok(s.state === 'needs_secret');
  assert.equal(s.secret, 'FIREFLIES_API_KEY');
  assert.equal(s.howTo, 'Берётся в Fireflies: Settings → API.');
  assert.equal(s.spec.kind, 'command');
  assert.deepEqual(s.spec.map, { id: 'id', items: 'data.transcripts', title: 'title' });
  const r = h.reqs[0];
  assert.equal(r.model, DRAFT_MODEL);
  assert.deepEqual([r.tools, r.implicitTools, r.persist], [['WebSearch', 'WebFetch'], [], false]);
  assert.match(r.prompt, /<source-data>\nНовая запись встречи в Fireflies.ai\n<\/source-data>/);
  // сессия без записи и Bash: хук отказывает всему, кроме поиска
  assert.equal(r.guard!('WebFetch', {}, { cwd: '/' }), undefined);
  assert.ok(r.guard!('Bash', {}, { cwd: '/' }));
  assert.ok(r.guard!('Write', {}, { cwd: '/' }));
  assert.equal(h.tests.length, 0);
});

test('ключ введён → проверка без модели → ready с примером и слагом; ключ уходит в saveSecret, а не в журнал', async () => {
  const h = harness({ answers: [answer()], saveSecret: true });
  h.routes.start('Fireflies');
  await settle(h);
  const working = h.routes.secret('d1', 'FIREFLIES_API_KEY', '  key-123  ');
  assert.equal(working?.state, 'working');
  const v = await settle(h);
  assert.ok(v.state === 'ready');
  assert.equal(v.slug, 'fireflies-ai');
  assert.equal(v.test.total, 3);
  assert.equal(h.reqs.length, 1, 'проверка не зовёт модель');
  assert.deepEqual(h.secretsSaved, { FIREFLIES_API_KEY: 'key-123' });
  assert.deepEqual(h.tests[0].secrets, { FIREFLIES_API_KEY: 'key-123' });
  assert.deepEqual(h.saved, [], 'источник сохраняет обычный PUT, не подключение словами');
});

test('без saveSecret ключ уходит вместе с источником на последнем шаге', async () => {
  const h = harness({ answers: [answer()] });
  h.routes.start('Fireflies');
  await settle(h);
  h.routes.secret('d1', 'FIREFLIES_API_KEY', 'k');
  const v = await settle(h);
  assert.equal(v.state, 'ready');
  assert.deepEqual(h.saved, [{ slug: 'fireflies-ai', secrets: { FIREFLIES_API_KEY: 'k' } }]);
});

test('ключ с тем же именем уже сохранён у другого источника: черновик берёт свободное имя и просит ввести ключ заново', async () => {
  const h = harness({ answers: [answer()], hasSecret: (n) => n === 'FIREFLIES_API_KEY', saveSecret: true });
  h.routes.start('Fireflies');
  const v = await settle(h);
  assert.ok(v.state === 'needs_secret');
  assert.equal(v.secret, 'FIREFLIES_API_KEY_2');
  assert.match(String(v.spec.config.command), /Bearer \$FIREFLIES_API_KEY_2"/);
  assert.deepEqual(v.spec.secrets, ['FIREFLIES_API_KEY_2']);
  assert.equal(h.tests.length, 0, 'чужой ключ на адрес из команды модели не уходит');
  h.routes.secret('d1', 'FIREFLIES_API_KEY_2', 'new');
  assert.equal((await settle(h)).state, 'ready');
  assert.deepEqual(h.secretsSaved, { FIREFLIES_API_KEY_2: 'new' });
  assert.deepEqual(h.tests[0].secrets, { FIREFLIES_API_KEY_2: 'new' });
});

test('сервис отказал новому ключу (401): снова needs_secret для этого ключа, модель не зовётся; со вторым вводом — ready', async () => {
  const denied = (): SourceTestResult => ({ ok: false, request: '', sample: [], total: 0, error: 'HTTP 401: invalid token' });
  const h = harness({ answers: [answer()], tests: [denied, goodTest], saveSecret: true });
  h.routes.start('Fireflies');
  await settle(h);
  h.routes.secret('d1', 'FIREFLIES_API_KEY', 'wrong');
  const v = await settle(h);
  assert.ok(v.state === 'needs_secret');
  assert.equal(v.secret, 'FIREFLIES_API_KEY');
  assert.match(v.howTo, /отказал в доступе.*401/s);
  assert.match(v.howTo, /Settings → API/);
  assert.equal(h.reqs.length, 1, 'модель не перегенерировала команду');
  h.routes.secret('d1', 'FIREFLIES_API_KEY', 'right');
  assert.equal((await settle(h)).state, 'ready');
  assert.deepEqual(h.tests[1].secrets, { FIREFLIES_API_KEY: 'right' });
});

test('ошибка проверки: до двух повторов сессии с текстом ошибки, потом ready', async () => {
  const bad = (): SourceTestResult => ({ ok: false, request: '', sample: [], total: 0, error: 'HTTP 502: bad gateway' });
  const h = harness({ answers: [answer(), answer({ command: 'curl -sS https://api.fireflies.ai/v2 -H "Authorization: Bearer $FIREFLIES_API_KEY"' })], tests: [bad, goodTest] });
  h.routes.start('Fireflies');
  await settle(h);
  h.routes.secret('d1', 'FIREFLIES_API_KEY', 'k');
  const v = await settle(h);
  assert.equal(v.state, 'ready');
  assert.equal(h.reqs.length, 2);
  assert.match(h.reqs[1].prompt, /Проверка предыдущего варианта не прошла/);
  assert.match(h.reqs[1].prompt, /HTTP 502: bad gateway/);
  assert.match(h.reqs[1].prompt, /graphql/, 'прошлая команда показана модели');
  assert.ok(v.state === 'ready' && String(v.spec.config.command).includes('/v2'));
});

test('три провала подряд (первая попытка и два повтора) — error с текстом последней ошибки и спекой', async () => {
  const bad = (n: number) => (): SourceTestResult => ({ ok: false, request: '', sample: [], total: 0, error: `ошибка ${n}` });
  const h = harness({ answers: [answer()], tests: [bad(1), bad(2), bad(3), bad(4)] });
  h.routes.start('Fireflies');
  await settle(h);
  h.routes.secret('d1', 'FIREFLIES_API_KEY', 'k');
  const v = await settle(h);
  assert.ok(v.state === 'error');
  assert.equal(v.error, 'ошибка 4');
  assert.ok(v.spec);
  assert.equal(h.reqs.length, 4, 'первая команда до ключа и три после: бюджет повторов считается заново от ввода ключа');
  assert.equal(h.tests.length, 4);
});

test('опасная команда не доходит до проверки: модель получает причину, исправленная команда проходит', async () => {
  const h = harness({ answers: [answer({ command: 'curl -sS https://x.test -o /tmp/a; rm -rf ~' }), answer()] });
  h.routes.start('x');
  await settle(h);
  h.routes.secret('d1', 'FIREFLIES_API_KEY', 'k');
  const v = await settle(h);
  assert.equal(v.state, 'ready');
  assert.equal(h.tests.length, 1);
  assert.match(h.reqs[1].prompt, /не прошла проверку/);
});

test('api_found: false — error с объяснением, без повторов', async () => {
  const h = harness({ answers: [{ api_found: false, reason: 'У сервиса нет публичного API' }] });
  h.routes.start('закрытый сервис');
  const v = await settle(h);
  assert.ok(v.state === 'error');
  assert.equal(v.error, 'У сервиса нет публичного API');
  assert.equal(h.reqs.length, 1);
});

test('сессия упала — error', async () => {
  const h = harness({ answers: [() => session(undefined, { ok: false, subtype: 'error_during_execution', errors: ['лимит исчерпан'] })] });
  h.routes.start('x');
  const v = await settle(h);
  assert.ok(v.state === 'error' && /лимит исчерпан/.test(v.error));
});

test('refine: поправка словами идёт в новую сессию вместе с прошлой командой; результат заменяет черновик', async () => {
  const h = harness({ answers: [answer(), answer({ title: 'Fireflies · только мои', map_title: 'title' })] });
  h.routes.start('Fireflies');
  await settle(h);
  const w = h.routes.refine('d1', 'не те записи, нужны только мои встречи');
  assert.equal(w?.state, 'working');
  const v = await settle(h);
  assert.ok(v.state === 'needs_secret' && v.spec.title === 'Fireflies · только мои');
  assert.match(h.reqs[1].prompt, /Поправки пользователя/);
  assert.match(h.reqs[1].prompt, /только мои встречи/);
  assert.match(h.reqs[1].prompt, /Предыдущий вариант источника/);
});

test('cancel удаляет черновик; устаревший ответ сессии состояние не трогает', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reqs: SessionRequest[] = [];
  const routes = createDraftRoutes(
    { saveSource: () => {}, testSource: async (s) => goodTest(s), hasSecret: () => true, freeSlug: () => 'x' },
    { newId: () => 'd1', session: async (req) => (reqs.push(req), await gate, session(answer())) },
  );
  routes.start('x');
  routes.cancel('d1');
  assert.equal(routes.get('d1'), undefined);
  assert.equal(reqs[0].abort?.signal.aborted, true);
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(routes.get('d1'), undefined);
});

test('неизвестный id и пустое описание', () => {
  const h = harness({ answers: [answer()] });
  assert.equal(h.routes.get('nope'), undefined);
  assert.equal(h.routes.secret('nope', 'A', 'b'), undefined);
  assert.equal(h.routes.refine('nope', 'x'), undefined);
  assert.doesNotThrow(() => h.routes.cancel('nope'));
  assert.throws(() => h.routes.start('   '), /Опишите/);
});

test('ключ с чужим именем не принимается; в другом состоянии secret ничего не меняет', async () => {
  const h = harness({ answers: [answer()] });
  h.routes.start('x');
  await settle(h);
  const v = h.routes.secret('d1', 'OTHER', 'v');
  assert.equal(v?.state, 'needs_secret');
  assert.equal(h.tests.length, 0);
});

test('specOf: интервал короче минуты и мусор заменяются 5m, плохое имя ключа и отсутствие id — ошибки с retry', () => {
  const a = specOf(answer({ every: '10s' }), 'описание');
  assert.ok(a.ok && a.spec.every === '5m');
  const b = specOf(answer({ every: '1h' }), 'описание');
  assert.ok(b.ok && b.spec.every === '1h');
  const c = specOf(answer({ secrets: ['api key'] }), 'описание');
  assert.ok(!c.ok && c.retry);
  const d = specOf(answer({ map_id: '' }), 'описание');
  assert.ok(!d.ok && d.retry);
  const e = specOf(answer({ title: '' }), 'Описание словами');
  assert.ok(e.ok && e.spec.title === 'Описание словами');
});
