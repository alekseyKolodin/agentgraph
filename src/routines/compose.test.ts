// Рутина по описанию словами: сессия модели подменена, список источников и flow — свои. Проверяем, что черновик
// собирается по спискам человека, не выдумывает, чинит мелочи сам и просит модель поправить остальное.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionRequest, SessionResult } from '../agent.js';
import { COMPOSE_MODEL, createComposeRoutes, type ComposeContext } from './compose.js';
import type { ComposeView, DirCheck } from './types.js';

const ctx: ComposeContext = {
  sources: [
    { slug: 'gitlab-mr', title: 'GitLab · мои MR', kind: 'gitlab', canReply: true },
    { slug: 'fireflies', title: 'Fireflies', kind: 'command', canReply: false },
  ],
  kinds: [
    { kind: 'gitlab', title: 'GitLab', summary: 'MR на ревью', canReply: true, match: [
      { key: 'title', label: 'Заголовок', type: 'text' },
      { key: 'event', label: 'Что произошло', type: 'enum', options: ['review', 'update'] },
      { key: 'draft', label: 'Черновик', type: 'bool' },
    ] },
    { kind: 'command', title: 'Своя команда', summary: 'curl', canReply: false, match: [{ key: 'title', label: 'Заголовок', type: 'text' }] },
    { kind: 'slack', title: 'Slack', summary: 'сообщения', canReply: true, match: [] },
  ],
  flows: [
    { name: 'review-mr', description: 'Ревью MR', blocks: ['read', 'comment'] },
    { name: 'fix-bug', description: 'Починить баг', blocks: ['fix'] },
  ],
  spaces: [{ slug: 'billing', title: 'Биллинг', cwd: '/proj/billing' }],
};

const ok = (structured: unknown, costUsd = 0.01): SessionResult => ({ ok: true, subtype: 'success', text: '', structured, costUsd, turns: 1, durationMs: 1, errors: [] });
const base = { feasible: true, title: 'Ревью MR', trigger: 'source', source: 'gitlab-mr', flow: 'review-mr', mode: 'suggest', notes: ['Источник — твои MR'] };

const dirOf = (git: boolean): ((p: string) => Promise<DirCheck>) => async (p) => ({ path: p, exists: !p.includes('missing'), isDir: !p.includes('missing'), git });

function harness(answers: unknown[], dir = dirOf(true), context: ComposeContext = ctx) {
  const reqs: SessionRequest[] = [];
  let n = 0;
  const routes = createComposeRoutes(
    { context: () => context, dir },
    { newId: () => 'c1', now: () => new Date('2026-11-19T10:00:00Z'), session: async (req) => (reqs.push(req), ok(answers[Math.min(n++, answers.length - 1)])) },
  );
  return { routes, reqs };
}

async function settle(routes: ReturnType<typeof createComposeRoutes>, id = 'c1'): Promise<ComposeView> {
  for (let i = 0; i < 200; i++) {
    const v = routes.get(id)!;
    if (v.state !== 'working') return v;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('черновик завис в working');
}

test('сборка: working сразу, потом ready; рутина выключена и черновик; сессия без инструментов', async () => {
  const h = harness([{ ...base, match: [{ key: 'event', op: 'is', values: ['review'] }, { key: 'draft', op: 'is', values: ['false'] }], input: 'Проверь MR' }]);
  assert.equal(h.routes.start('  ревью моих MR  ').state, 'working');
  const v = await settle(h.routes);
  assert.ok(v.state === 'ready');
  assert.equal(v.spec.enabled, false);
  assert.equal(v.spec.draft, true);
  assert.deepEqual(v.spec.when, { source: 'gitlab-mr', match: { event: 'review', draft: false } });
  assert.deepEqual(v.spec.run, { flow: 'review-mr', input: 'Проверь MR' });
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.needs, {});
  const r = h.reqs[0]!;
  assert.equal(r.model, COMPOSE_MODEL);
  assert.deepEqual([r.tools, r.implicitTools, r.persist], [[], [], false]);
  assert.ok(r.guard!('Bash', {}, { cwd: '/' }));
  assert.match(r.prompt, /<source-data>\nревью моих MR\n<\/source-data>/);
  assert.match(r.prompt, /gitlab-mr/);
});

test('расписание: cron проверяется, без источника; плохой cron — повтор с текстом ошибки', async () => {
  const h = harness([
    { ...base, trigger: 'schedule', schedule: 'каждое утро', source: undefined, mode: 'auto' },
    { ...base, trigger: 'schedule', schedule: '30 9 * * 1-5', source: undefined, mode: 'auto' },
  ]);
  h.routes.start('каждое утро собирай ревью');
  const v = await settle(h.routes);
  assert.ok(v.state === 'ready');
  assert.deepEqual(v.spec.when, { schedule: '30 9 * * 1-5', missed: 'ask' });
  assert.equal(h.reqs.length, 2);
  assert.match(h.reqs[1]!.prompt, /cron/);
});

test('выдуманный источник и flow: один повтор с проверкой; не помогло — ready с problems, а не выдумка', async () => {
  const bad = { ...base, source: 'jira-x', flow: 'ghost' };
  const h = harness([bad, bad]);
  h.routes.start('что-то');
  const v = await settle(h.routes);
  assert.ok(v.state === 'ready');
  assert.equal(h.reqs.length, 2);
  assert.match(h.reqs[1]!.prompt, /jira-x/);
  assert.match(h.reqs[1]!.prompt, /ghost/);
  assert.ok(v.problems.length >= 1);
});

test('нужного источника нет: new_source с видом — в needs, источник пустой, повтора нет', async () => {
  const h = harness([{ ...base, trigger: 'new_source', source: undefined, new_source: { description: 'сообщения в Slack', kind: 'slack' } }]);
  h.routes.start('сообщения в слаке → ревью');
  const v = await settle(h.routes);
  assert.ok(v.state === 'ready');
  assert.deepEqual(v.needs.source, { description: 'сообщения в Slack', kind: 'slack' });
  assert.deepEqual(v.spec.when, { source: '' });
  assert.equal(h.reqs.length, 1);
  assert.deepEqual(v.problems, []);
});

test('подходящего flow нет: needs.flow со словами человека, flow пустой', async () => {
  const h = harness([{ ...base, flow: '', flow_wanted: 'разобрать письмо и ответить' }]);
  h.routes.start('отвечай на письма');
  const v = await settle(h.routes);
  assert.ok(v.state === 'ready');
  assert.equal(v.needs.flow, 'разобрать письмо и ответить');
  assert.equal(v.spec.run?.flow, '');
});

test('только дело на доске: без flow, kind задан, пространство — проект дела', async () => {
  const h = harness([{ ...base, flow: '', space: 'billing', task: { kind: 'Ревью', close: 'thing' }, mode: 'suggest' }]);
  h.routes.start('заводи дела по моим MR');
  const v = await settle(h.routes);
  assert.ok(v.state === 'ready');
  assert.equal(v.spec.run, undefined);
  assert.deepEqual(v.spec.task, { kind: 'Ревью', close: 'thing', project: 'billing' });
  assert.deepEqual(v.needs, {});
});

test('условие по несуществующему полю не берётся, об этом сказано; значения да/нет и числа не строками', async () => {
  const h = harness([{ ...base, match: [{ key: 'nope', op: 'is', values: ['x'] }, { key: 'draft', op: 'is', values: ['true'] }] }]);
  h.routes.start('MR');
  const v = await settle(h.routes);
  assert.ok(v.state === 'ready');
  assert.deepEqual(v.spec.when, { source: 'gitlab-mr', match: { draft: true } });
  assert.ok(v.notes.some((n) => /nope/.test(n)));
});

test('папка не git: worktree new снимается и человеку сказано; папки нет — поле пустое', async () => {
  const h = harness([{ ...base, cwd: '/proj/app', worktree: 'new' }], dirOf(false));
  h.routes.start('в отдельной ветке');
  const v = await settle(h.routes);
  assert.ok(v.state === 'ready');
  assert.equal(v.spec.run?.cwd, '/proj/app');
  assert.equal(v.spec.run?.worktree, undefined);
  assert.ok(v.notes.some((n) => /не git-репозиторий/.test(n)));

  const h2 = harness([{ ...base, cwd: '/missing/dir', worktree: 'new' }]);
  h2.routes.start('в отдельной ветке');
  const v2 = await settle(h2.routes);
  assert.ok(v2.state === 'ready');
  assert.equal(v2.spec.run?.cwd, undefined);
  assert.ok(v2.notes.some((n) => /нет/.test(n)));
});

test('git-папка: worktree new сохраняется; until_pause без названного блока — ждёт перед последним', async () => {
  const h = harness([{ ...base, flow: 'review-mr', cwd: '/proj/app', worktree: 'new', mode: 'until_pause' }]);
  h.routes.start('сам, но перед ответом спроси');
  const v = await settle(h.routes);
  assert.ok(v.state === 'ready');
  assert.equal(v.spec.run?.worktree, 'new');
  assert.equal(v.spec.mode, 'until_pause');
  assert.deepEqual(v.spec.run?.pause_before, ['comment']);
});

test('ответ в источник, куда писать нельзя, не включается', async () => {
  const h = harness([{ ...base, source: 'fireflies', reply: { to: 'source' } }]);
  h.routes.start('встречи');
  const v = await settle(h.routes);
  assert.ok(v.state === 'ready');
  assert.deepEqual(v.spec.reply, { to: 'none' });
  assert.ok(v.notes.some((n) => /Ответ в источник/.test(n)));
});

test('описание не про рутину и сбой сессии — error с понятной фразой; отмена убирает черновик', async () => {
  const h = harness([{ feasible: false, reason: 'Напиши, что должно запускать рутину', title: '', trigger: 'source', mode: 'suggest', notes: [] }]);
  h.routes.start('привет');
  const v = await settle(h.routes);
  assert.ok(v.state === 'error');
  assert.equal(v.error, 'Напиши, что должно запускать рутину');

  const failing = createComposeRoutes({ context: () => ctx }, { newId: () => 'c1', session: async () => ({ ...ok(undefined), ok: false, errors: ['лимит'] }) });
  failing.start('x');
  const e = await settle(failing);
  assert.ok(e.state === 'error' && /лимит/.test(e.error));

  const h2 = harness([base]);
  h2.routes.start('MR');
  h2.routes.cancel('c1');
  assert.equal(h2.routes.get('c1'), undefined);
  assert.throws(() => h2.routes.start('  '), /Опиши/);
});

test('собранная рутина проходит схему после подстановки того, чего не хватает (источник и flow выбирает человек)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-compose-'));
  try {
    const h = harness([{ ...base, cwd: dir }]);
    h.routes.start('MR');
    const v = await settle(h.routes);
    assert.ok(v.state === 'ready');
    assert.equal(v.spec.run?.cwd, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('модель: выбор человека уходит в сессию и виден в ответе; без выбора — модель по умолчанию; фактическая модель сессии её заменяет', async () => {
  const reqs: SessionRequest[] = [];
  let n = 0;
  const routes = createComposeRoutes(
    { context: () => ctx, dir: dirOf(true) },
    { newId: () => `m${++n}`, session: async (req) => {
      reqs.push(req);
      // модель сессия называет не сразу: до этого виден выбор человека
      await new Promise((r) => setImmediate(r));
      req.onModel?.('claude-opus-5-5');
      return ok(base);
    } },
  );
  assert.equal(routes.start('ревью моих MR', ' opus ').model, 'opus');
  const chosen = await settle(routes, 'm1');
  assert.equal(reqs[0]!.model, 'opus');
  assert.equal(chosen.model, 'claude-opus-5-5');
  assert.equal(routes.start('ревью моих MR').model, COMPOSE_MODEL);
  await settle(routes, 'm2');
  assert.equal(reqs[1]!.model, COMPOSE_MODEL);
});

