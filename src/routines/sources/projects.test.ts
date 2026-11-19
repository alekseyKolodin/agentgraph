// Источник «Проекты» (SPEC 4.1–4.2): ветки репозиториев пространств, сессии на вопросе и вердикты разбора — снимком,
// без модели (разбор — только по расписанию и только в настоящей проверке). git и наблюдатель веток подменены.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Exec } from '../../git.js';
import type { ReviewSource, ReviewStore } from '../../session-review.js';
import type { Thing, ThingState, Watcher } from '../../things/types.js';
import { BRANCH_DAYS, BRANCHES_MAX, projectsKind, reviewEvery, type ProjectsDeps } from './projects.js';
import { makeCtx } from './testkit.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const ROOT = '/code/app';

type Branch = { name: string; updated?: string; open?: boolean };

/** git: for-each-ref и worktree list по списку веток; ошибка репозитория — по root. */
function fakeGit(repos: Record<string, Branch[] | Error>): Exec {
  return async (_cmd, args, opts) => {
    const r = repos[opts?.cwd ?? ''];
    if (r instanceof Error) throw r;
    const list = r ?? [];
    if (args.includes('for-each-ref')) return list.map((b) => [b.name, '', b.updated ?? ago(1), 'subject', ''].join('\0')).join('\n');
    if (args[0] === 'worktree') return list.filter((b) => b.open).map((b, i) => `worktree ${opts?.cwd}${i ? `/wt${i}` : ''}\nbranch refs/heads/${b.name}`).join('\n\n');
    return '';
  };
}

/** Наблюдатель веток: состояние по имени ветки; спрошенные ветки — в asked. */
function fakeWatcher(states: Record<string, Partial<ThingState> & { facts?: Record<string, unknown> }>) {
  const asked: string[] = [];
  const w: Watcher = {
    type: 'branch',
    everyMs: 0,
    canWatch: () => true,
    async state(things: Thing[]) {
      const out = new Map<string, ThingState>();
      for (const t of things) {
        const b = String(t.ref.branch);
        asked.push(b);
        const s = states[b];
        out.set(t.key, { exists: true, turn: 'none', why: 'чисто', title: b, updatedAt: ago(1), facts: {}, ...s });
      }
      return out;
    },
  };
  return { w, asked };
}

const session = (id: string, o: Partial<ReviewSource> = {}): ReviewSource => ({ id, name: `Сессия ${id}`, cwd: ROOT, live: false, status: 'ended', lastActivityAt: ago(1), turns: [], ...o });
const emptyStore = (): ReviewStore => ({ costUsd: 0, items: [] });

function deps(o: Partial<ProjectsDeps> & { repos?: Record<string, Branch[] | Error>; states?: Parameters<typeof fakeWatcher>[0] } = {}): ProjectsDeps & { asked: string[] } {
  const { w, asked } = fakeWatcher(o.states ?? {});
  return {
    exec: fakeGit(o.repos ?? { [ROOT]: [] }),
    spaces: () => [{ slug: 'billing', title: 'Биллинг', repos: [ROOT] }],
    projectOf: () => 'billing',
    sessions: async () => [],
    reviewStore: emptyStore,
    review: async () => {
      throw new Error('модель не должна зваться');
    },
    watcher: w,
    now: () => NOW,
    ...o,
    asked,
  };
}

const ctx = (config: Record<string, unknown> = { review: 'off' }, cursor?: unknown, real = false) => {
  const c = makeCtx({ slug: 'proj', kind: 'projects', config, cursor });
  // у опроса движка есть учёт цены и scheduled, у пробной проверки — ничего
  return real ? Object.assign(c, { scheduled: true, costs: [] as number[], cost: (usd: number) => void (c as unknown as { costs: number[] }).costs.push(usd) }) : c;
};

test('ветки: грязная, неотправленная и без MR — события с вещью, проектом и причиной; чистая — нет', async () => {
  const d = deps({
    repos: { [ROOT]: [{ name: 'main', open: true }, { name: 'feat', open: true }, { name: 'push', updated: ago(3) }, { name: 'nomr', updated: ago(5) }, { name: 'clean' }] },
    states: {
      feat: { turn: 'me', why: '3 файла не закоммичено', facts: { dirty: 3 } },
      push: { turn: 'me', why: '2 коммита не отправлено в origin/push', facts: { dirty: 0, upstream: 'origin/push', ahead: 2 } },
      nomr: { turn: 'me', why: 'в ветке 4 коммита без MR', facts: { dirty: 0, upstream: 'origin/nomr', ahead: 0, aheadOfBase: 4, mr: null } },
      clean: { closed: 'done', why: 'ветка чистая' },
    },
  });
  const events = await projectsKind(d).poll!(ctx());
  assert.deepEqual(events.map((e) => [e.id, e.fields.kind]), [
    ['branch:/code/app#feat@dirty', 'dirty'],
    ['branch:/code/app#push@unpushed', 'unpushed'],
    ['branch:/code/app#nomr@no_mr', 'no_mr'],
  ]);
  const feat = events[0]!;
  assert.equal(feat.things?.[0]?.key, 'branch:/code/app#feat');
  assert.deepEqual(feat.things?.[0]?.ref, { root: ROOT, branch: 'feat' });
  assert.equal(feat.project, 'billing');
  assert.equal(feat.why, '3 файла не закоммичено');
  assert.equal(feat.title, 'feat · app: не закоммичено');
  assert.equal(feat.at, '2026-11-17T12:00:00.000Z');
  // открытые в checkout — первыми; без коммитов дольше BRANCH_DAYS — не смотрим
  assert.deepEqual(d.asked.slice(0, 2), ['main', 'feat']);
});

test('ветки: старые неоткрытые не смотрятся, свежих — не больше BRANCHES_MAX; открытые — всегда', async () => {
  const many = Array.from({ length: BRANCHES_MAX + 5 }, (_, i) => ({ name: `b${i}`, updated: ago(1) }));
  const d = deps({ repos: { [ROOT]: [{ name: 'old', updated: ago(BRANCH_DAYS + 1) }, { name: 'wip', open: true, updated: ago(BRANCH_DAYS + 30) }, ...many] } });
  await projectsKind(d).poll!(ctx());
  assert.equal(d.asked.length, BRANCHES_MAX);
  assert.equal(d.asked[0], 'wip');
  assert.ok(!d.asked.includes('old'));
});

test('ветки: репозиторий не прочитался — его прошлые записи остаются (иначе дела закрылись бы как «стало чисто»)', async () => {
  const states = { feat: { turn: 'me' as const, why: 'грязно', facts: { dirty: 1 } } };
  const ok = deps({ repos: { [ROOT]: [{ name: 'feat', open: true }] }, states });
  const c1 = ctx();
  const first = await projectsKind(ok).poll!(c1);
  assert.equal(first.length, 1);
  const broken = deps({ repos: { [ROOT]: new Error('git: not a repository') }, states, now: () => NOW + 3_600_000 });
  const c2 = ctx({ review: 'off' }, c1.cursorValue());
  const again = await projectsKind(broken).poll!(c2);
  assert.deepEqual(again.map((e) => e.id), ['branch:/code/app#feat@dirty']);
  // время записи — первое появление, не время этой проверки
  assert.equal(again[0]!.at, first[0]!.at);
  assert.match(c2.logs.join('\n'), /не прочитались репозитории/);
});

test('сессии: закончилась на вопросе — событие о сессии с текстом вопроса; живая — нет, но уже бывшая в списке держится', async () => {
  const ask = { kind: 'question' as const, text: 'Коммитить сейчас или после ревью?', at: ago(1) };
  const list = [session('s1', { ask }), session('s2', { ask, live: true, status: 'waiting' }), session('s3')];
  const d = deps({ sessions: async () => list });
  const c1 = ctx();
  const events = await projectsKind(d).poll!(c1);
  assert.deepEqual(events.map((e) => e.id), [`ask:s1@${ask.at}`]);
  const e = events[0]!;
  assert.equal(e.things?.[0]?.key, 'session:s1');
  assert.equal(e.text, ask.text);
  assert.match(e.why ?? '', /^Claude спросил и ждёт: Коммитить/);
  assert.equal(e.project, 'billing');
  assert.equal(e.title, '«Сессия s1» закончилась на вопросе');
  // s1 открыли с карточки (живая, вопрос ещё не снят) — запись держится; ответил — вопроса нет, записи нет
  list[0] = session('s1', { ask, live: true, status: 'waiting' });
  const c2 = ctx({ review: 'off' }, c1.cursorValue());
  assert.deepEqual((await projectsKind(d).poll!(c2)).map((x) => x.id), [`ask:s1@${ask.at}`]);
  list[0] = session('s1', { live: true, status: 'working' });
  assert.deepEqual(await projectsKind(d).poll!(ctx({ review: 'off' }, c2.cursorValue())), []);
});

test('разбор: вердикт «не доделано» на той же активности — событие; новые ходы или «готово» — нет', async () => {
  const store: ReviewStore = {
    at: ago(0.5),
    costUsd: 0.1,
    items: [
      { id: 's1', name: 's1', verdict: 'continue', done: 'Экран', left: 'тесты не прогнаны', next: 'Прогони тесты', at: ago(0.5), activityAt: ago(2), turns: 3 },
      { id: 's2', name: 's2', verdict: 'wrap', done: 'Сделано', left: 'закоммитить', next: '', at: ago(0.5), activityAt: ago(3), turns: 2 },
      { id: 's3', name: 's3', verdict: 'done', done: 'Готово', left: '', next: '', at: ago(0.5), activityAt: ago(1) },
    ],
  };
  // s1 — активность новая, ходов столько же (закрыли терминал): вердикт в силе; s2 — новый ход
  const d = deps({ reviewStore: () => store, sessions: async () => [session('s1', { turnCount: 3 }), session('s2', { lastActivityAt: ago(0.1), turnCount: 3 }), session('s3')] });
  const events = await projectsKind(d).poll!(ctx());
  assert.deepEqual(events.map((e) => e.id), ['review:s1@3']);
  assert.equal(events[0]!.fields.verdict, 'continue');
  assert.equal(events[0]!.text, 'Осталось: тесты не прогнаны\nС чего продолжить: Прогони тесты');
  assert.equal(events[0]!.why, 'тесты не прогнаны');
  assert.equal(events[0]!.things?.[0]?.key, 'session:s1');
});

test('разбор по расписанию: в фоне, только в настоящей проверке, не чаще review; цена — в расход источника; сбой не валит опрос', async () => {
  let calls = 0;
  let store = emptyStore();
  const d = deps({
    reviewStore: () => store,
    review: async () => {
      calls += 1;
      store = { at: new Date(NOW).toISOString(), costUsd: 0.2, items: [] };
      return { costUsd: 0.2 };
    },
  });
  // пробная проверка (нет учёта цены) и «Проверка на истории» (цена есть, но не опрос по расписанию) — модель не зовётся
  await projectsKind(d).poll!(ctx({}));
  await projectsKind(d).poll!(Object.assign(ctx({}), { cost: () => {} }));
  assert.equal(calls, 0);
  // review не задан — по умолчанию без модели и в настоящей проверке
  await projectsKind(d).poll!(ctx({}, undefined, true));
  assert.equal(calls, 0);
  const c1 = ctx({ review: '24h' }, undefined, true);
  await projectsKind(d).poll!(c1);
  assert.equal(calls, 1);
  // разбор идёт в фоне: цена приходит, когда он кончился
  await new Promise((r) => setImmediate(r));
  assert.deepEqual((c1 as unknown as { costs: number[] }).costs, [0.2]);
  // сутки не прошли — второго разбора нет
  await projectsKind(d).poll!(ctx({ review: '24h' }, c1.cursorValue(), true));
  assert.equal(calls, 1);
  // review: off — без модели вовсе
  await projectsKind({ ...d, now: () => NOW + 2 * 86_400_000 }).poll!(ctx({ review: 'off' }, c1.cursorValue(), true));
  assert.equal(calls, 1);
  // сбой разбора: опрос идёт, повтор — не раньше интервала (попытка запомнена)
  const failing = deps({ review: async () => ((calls += 1), { costUsd: 0.05, error: 'потолок цены' }) });
  const c2 = ctx({ review: '12h' }, undefined, true);
  assert.deepEqual(await projectsKind(failing).poll!(c2), []);
  await new Promise((r) => setImmediate(r));
  assert.match(c2.logs.join('\n'), /разбор сессий не прошёл: потолок цены/);
  await projectsKind({ ...failing, now: () => NOW + 3_600_000 }).poll!(ctx({ review: '12h' }, c2.cursorValue(), true));
  assert.equal(calls, 2);
});

test('настройки: пространства по слагу — ветки и сессии только их; интервал разбора', async () => {
  const d = deps({
    spaces: () => [{ slug: 'billing', title: 'Б', repos: [ROOT] }, { slug: 'kai', title: 'K', repos: ['/code/kai'] }],
    repos: { [ROOT]: [{ name: 'feat', open: true }], '/code/kai': [{ name: 'x', open: true }] },
    states: { feat: { turn: 'me', why: 'грязно', facts: { dirty: 1 } }, x: { turn: 'me', why: 'грязно', facts: { dirty: 2 } } },
    sessions: async () => [session('s1', { space: 'kai', ask: { kind: 'permission', text: 'Bash: rm -rf dist', at: ago(1) } }), session('s2', { ask: { kind: 'question', text: '?', at: ago(1) } })],
    projectOf: () => undefined,
  });
  const events = await projectsKind(d).poll!(ctx({ spaces: 'kai', review: 'off' }));
  assert.deepEqual(events.map((e) => e.id), ['branch:/code/kai#x@dirty', `ask:s1@${ago(1)}`]);
  assert.match(events[1]!.why ?? '', /^Claude просит разрешения: Bash/);
  await assert.rejects(projectsKind(d).poll!(ctx({ spaces: 'nope', review: 'off' })), /Нет открытых пространств nope/);
  assert.equal(reviewEvery({ title: '', kind: 'projects', config: {} }), 0);
  assert.equal(reviewEvery({ title: '', kind: 'projects', config: { review: '24h' } }), 86_400_000);
  assert.equal(reviewEvery({ title: '', kind: 'projects', config: { review: 'off' } }), 0);
  assert.equal(reviewEvery({ title: '', kind: 'projects', config: { review: '10m' } }), 3_600_000);
  assert.equal(reviewEvery({ title: '', kind: 'projects', config: { review: '12h' } }), 12 * 3_600_000);
  assert.throws(() => reviewEvery({ title: '', kind: 'projects', config: { review: 'часто' } }), /интервал/);
  assert.equal(projectsKind(d).snapshot, true);
});

test('ветки: снять ветку не удалось или MR не проверить — прошлая запись этой ветки держится', async () => {
  const repos = { [ROOT]: [{ name: 'feat', open: true }, { name: 'nomr' }] };
  const c1 = ctx();
  const first = await projectsKind(deps({ repos, states: { feat: { turn: 'me', why: 'грязно', facts: { dirty: 1 } }, nomr: { turn: 'me', why: 'без MR', facts: { upstream: 'origin/nomr', ahead: 0, aheadOfBase: 2 } } } })).poll!(c1);
  assert.equal(first.length, 2);
  const broken = deps({ repos, states: { feat: { exists: false, error: 'git status: index.lock', facts: {} }, nomr: { turn: 'none', why: 'MR проверить не удалось', facts: { aheadOfBase: 2, mrError: 'glab: 401' } } } });
  const again = await projectsKind(broken).poll!(ctx({ review: 'off' }, c1.cursorValue()));
  assert.deepEqual(again.map((e) => e.id), first.map((e) => e.id));
});

test('обход прервали (сервер останавливается) — ошибка, а не неполный список; курсор не тронут', async () => {
  const c = ctx();
  c.abort.abort();
  const d = deps({ repos: { [ROOT]: [{ name: 'feat', open: true }] }, states: { feat: { turn: 'me', why: 'грязно', facts: { dirty: 1 } } } });
  await assert.rejects(projectsKind(d).poll!(c), /прерван/);
  assert.equal(c.cursorValue(), undefined);
});

test('ветки: выпавшая из окна обхода (старая, сверх BRANCHES_MAX) держит прошлую запись; удалённая — пропадает', async () => {
  const states = { wip: { turn: 'me' as const, why: 'без MR', facts: { upstream: 'origin/wip', ahead: 0, aheadOfBase: 3 } } };
  const c1 = ctx();
  const first = await projectsKind(deps({ repos: { [ROOT]: [{ name: 'wip', updated: ago(10) }] }, states })).poll!(c1);
  assert.deepEqual(first.map((e) => e.id), ['branch:/code/app#wip@no_mr']);
  // прошло время: ветка старше BRANCH_DAYS — её не смотрим, но и не «стала чистой»
  const old = deps({ repos: { [ROOT]: [{ name: 'wip', updated: ago(BRANCH_DAYS + 1) }] }, states });
  const c2 = ctx({}, c1.cursorValue());
  assert.deepEqual((await projectsKind(old).poll!(c2)).map((e) => e.id), ['branch:/code/app#wip@no_mr']);
  assert.ok(!old.asked.includes('wip'));
  // ветку удалили — записи нет
  assert.deepEqual(await projectsKind(deps({ repos: { [ROOT]: [] }, states })).poll!(ctx({}, c2.cursorValue())), []);
});

test('сессии: терминал не загрузился (сессий не узнать) — прошлые записи сессий держатся; итог разбора битый — прошлые вердикты', async () => {
  const ask = { kind: 'question' as const, text: 'Так или иначе?', at: ago(1) };
  const store: ReviewStore = { at: ago(0.5), costUsd: 0, items: [{ id: 's2', name: 's2', verdict: 'continue', done: 'd', left: 'l', next: 'n', at: ago(0.5), activityAt: ago(1), turns: 2 }] };
  const list = [session('s1', { ask }), session('s2', { turnCount: 2 })];
  const c1 = ctx();
  const first = await projectsKind(deps({ sessions: async () => list, reviewStore: () => store })).poll!(c1);
  assert.deepEqual(first.map((e) => e.id), [`ask:s1@${ask.at}`, 'review:s2@2']);
  const c2 = ctx({}, c1.cursorValue());
  assert.deepEqual((await projectsKind(deps({ sessions: async () => undefined, reviewStore: () => store })).poll!(c2)).map((e) => e.id), first.map((e) => e.id));
  // сессии есть, итог разбора не прочитался — вопросы по сессиям как сейчас, вердикты — прошлые
  const c3 = ctx({}, c2.cursorValue());
  const broken = await projectsKind(deps({ sessions: async () => [session('s2', { turnCount: 2 })], reviewStore: () => ({ costUsd: 0, items: [], broken: true }) })).poll!(c3);
  assert.deepEqual(broken.map((e) => e.id), ['review:s2@2']);
  assert.match(c3.logs.join('\n'), /итог разбора сессий не прочитался/);
});
