// Встроенный источник «Проекты» (SPEC этап 4, 4.1–4.2): обход проектов пользователя — что брошено на полпути.
// Источник-снимок: каждая проверка отдаёт весь текущий список, пропавшее движок закрывает (kind.snapshot).
//   - ветки репозиториев пространств: грязный checkout, коммиты не отправлены, ветка впереди базы без MR — состояние
//     считает наблюдатель веток (src/things/branch.ts): git и glab/gh, без модели;
//   - сессии терминала, которые закончились на вопросе Claude или запросе разрешения (SessionRecord.ask) — без модели;
//   - разбор «Не доделано» (src/session-review.ts): вердикт модели «не доделано» / «последний шаг». Разбор идёт в фоне по
//     расписанию этого источника (config.review: 24h — раз в сутки; по умолчанию выключен) и только по сессиям с новыми ходами; итог —
//     на сервере, тот же, что у кнопки на главной, его вердикты — записи следующих проверок. Пробная проверка модель не зовёт.
// Список проектов — из пространств (src/spaces.ts): их репозитории; у события — проект (слаг пространства) и вещь
// (branch:/session: из src/things/keys.ts), поэтому дело рутины с task ложится на свою вещь и свой проект.
import path from 'node:path';
import { readReviewStore, reviewedNow, reviewNow, type ReviewKey, type ReviewSource, type ReviewStore } from '../../session-review.js';
import { listSpaces, projectOfPath, projectResolver } from '../../spaces.js';
import { exec as realExec, localBranches, worktreeList, type Exec } from '../../git.js';
import { branchWatcher } from '../../things/branch.js';
import { branchKey, sessionKey } from '../../things/keys.js';
import { desk } from '../../desk/index.js';
import type { DeskItem } from '../../desk/types.js';
import type { Thing, Watcher } from '../../things/types.js';
import { BASE_MATCH, type SourceCtx, type SourceKind } from '../kind.js';
import type { RoutineEvent } from '../types.js';
import { cfgList, cfgStr, truncate } from './util.js';

/** Пространство глазами источника: слаг, имя и репозитории (корни git), которые считаются его работой. */
export type ProjectSpace = { slug: string; title: string; repos: string[] };

export type ProjectsDeps = {
  exec?: Exec;
  /** Открытые пространства с репозиториями; репозиторий нескольких пространств — у одного (правило проекта по папке). */
  spaces?: () => ProjectSpace[];
  /** Проект папки (слаг пространства) — для сессии без пространства. */
  projectOf?: (dir: string) => string | undefined;
  /**
   * Сессии с вопросом последнего хода; журнал ходов — только тем, кому нужен разбор (turnsFor). undefined — сессий сейчас
   * не узнать (терминал не загрузился): это «нет данных», а не «пусто» — прошлые записи сессий остаются.
   */
  sessions?: (turnsFor?: (s: ReviewKey) => boolean) => Promise<ReviewSource[] | undefined>;
  /** Итог разбора на сервере. */
  reviewStore?: () => ReviewStore;
  /** Разбор моделью сейчас (итог пишется на сервер); цена — в расход источника. */
  review?: (signal: AbortSignal) => Promise<{ costUsd: number; error?: string }>;
  /** Открытые дела (desk().list({ open: true })): сессия и ветка, привязанные к делу другой вещи, — уже на его карточке. */
  openItems?: () => Promise<DeskItem[]>;
  /** Наблюдатель веток: по умолчанию branchWatcher на том же exec. */
  watcher?: Watcher;
  now?: () => number;
};

const MIN_POLL_MS = 5 * 60_000;
/** Разбор моделью — не чаще раза в час (по умолчанию выключен, см. reviewEvery). */
const REVIEW_MIN_MS = 3_600_000;
/** Веток одного репозитория в обходе: открытые в checkout — всегда, остальные — самые свежие. */
export const BRANCHES_MAX = 15;
/** Неоткрытая ветка без коммитов дольше — уже не «забыл», а бросил; открытая в checkout смотрится всегда. */
export const BRANCH_DAYS = 90;
const DAY_MS = 86_400_000;

type BranchState = 'dirty' | 'unpushed' | 'no_mr';
const BRANCH_TITLE: Record<BranchState, string> = { dirty: 'не закоммичено', unpushed: 'не отправлено', no_mr: 'без MR' };
const KINDS = ['dirty', 'unpushed', 'no_mr', 'question', 'review'] as const;

/**
 * Курсор: когда запись впервые попала в список (время сигнала дела), последние записи репозитория и сессий — на случай,
 * когда их не прочитать (сбой git, терминал не загрузился, битый итог разбора): пропажа значила бы «стало чисто».
 */
type Cursor = { first: Record<string, string>; roots: Record<string, RoutineEvent[]>; sessions?: RoutineEvent[]; reviewTried?: string };

function readCursor(v: unknown): Cursor {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Cursor>;
  const first = o.first && typeof o.first === 'object' ? Object.fromEntries(Object.entries(o.first).filter(([, at]) => typeof at === 'string')) : {};
  const roots = o.roots && typeof o.roots === 'object' ? Object.fromEntries(Object.entries(o.roots).filter(([, list]) => Array.isArray(list))) : {};
  return { first, roots, ...(Array.isArray(o.sessions) ? { sessions: o.sessions } : {}), ...(typeof o.reviewTried === 'string' ? { reviewTried: o.reviewTried } : {}) };
}

/** «24h», «12h», «off»; пусто — без модели (разбор тратит деньги — только когда включили явно). Чаще раза в час — раз в час. */
export function reviewEvery(spec: SourceKindSpec): number {
  const raw = (cfgStr(spec, 'review') ?? '').toLowerCase();
  if (!raw) return 0;
  if (['off', 'no', 'нет', 'выкл', '0'].includes(raw)) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d|м|ч|д)$/.exec(raw);
  if (!m) throw new Error(`review — интервал вроде 24h или off, а не «${raw}»`);
  const n = Number(m[1]) * ({ m: 60_000, м: 60_000, h: 3_600_000, ч: 3_600_000, d: DAY_MS, д: DAY_MS } as Record<string, number>)[m[2]!]!;
  return Math.max(REVIEW_MIN_MS, n);
}
type SourceKindSpec = SourceCtx['spec'];

const repoName = (root: string): string => path.basename(root) || root;

/** Вид состояния ветки из снимка наблюдателя: грязно → не отправлено → впереди без MR. */
function branchStateOf(facts: Record<string, unknown>): BranchState {
  if (Number(facts.dirty) > 0) return 'dirty';
  const unpushed = facts.upstream ? Number(facts.ahead) > 0 : !facts.mr && Number(facts.aheadOfBase) > 0;
  return unpushed ? 'unpushed' : 'no_mr';
}

async function branchEvents(ctx: SourceCtx, space: ProjectSpace, root: string, o: { x: Exec; watcher: Watcher; now: number; prev: RoutineEvent[] }): Promise<RoutineEvent[]> {
  const [branches, trees] = await Promise.all([localBranches(root, o.x), worktreeList(root, o.x).catch(() => [])]);
  const open = new Set(trees.map((w) => w.branch).filter((b): b is string => Boolean(b)));
  const since = o.now - BRANCH_DAYS * DAY_MS;
  // открытые в checkout — первыми (грязным бывает только открытая), потом самые свежие (список уже по дате коммита)
  const pick = [...branches.filter((b) => open.has(b.name)), ...branches.filter((b) => !open.has(b.name) && Date.parse(b.updated) >= since)].slice(0, Math.max(BRANCHES_MAX, open.size));
  const things: Thing[] = pick.map((b) => ({ type: 'branch', key: branchKey(root, b.name), ref: { root, branch: b.name }, title: b.name }));
  const states = await o.watcher.state(things, ctx.signal);
  const out: RoutineEvent[] = [];
  // ветка есть, но выпала из окна обхода (16-я по свежести, без коммитов дольше BRANCH_DAYS): её не смотрели — прошлые
  // записи остаются как есть (дело закроет сверка по вещи, когда ветка станет чистой); удалённая ветка — пропадает
  const picked = new Set(pick.map((b) => b.name));
  const outside = new Set(branches.filter((b) => !picked.has(b.name)).map((b) => branchKey(root, b.name)));
  out.push(...o.prev.filter((e) => outside.has(e.things?.[0]?.key ?? '')));
  for (const t of things) {
    const st = states.get(t.key);
    // ветку снять не удалось (index.lock, таймаут git) или MR не проверить (офлайн, протух токен glab/gh) — не «стало
    // чисто»: прошлые записи этой ветки остаются, иначе дело закрылось бы и открылось снова
    if (!st?.exists || st.error || st.facts.mrError) {
      out.push(...o.prev.filter((e) => e.things?.[0]?.key === t.key));
      continue;
    }
    // ход не мой (чистая, MR открыт или смержен) — не забытое
    if (st.turn !== 'me') continue;
    const branch = String(t.ref.branch);
    const state = branchStateOf(st.facts);
    const mr = st.facts.mr && typeof st.facts.mr === 'object' ? (st.facts.mr as { url?: unknown }) : undefined;
    const link = typeof mr?.url === 'string' && /^https?:\/\//.test(mr.url) ? mr.url : undefined;
    out.push({
      source: ctx.slug,
      id: `${t.key}@${state}`,
      at: '',
      title: `${branch} · ${repoName(root)}: ${state === 'no_mr' && link ? 'MR не смержен' : BRANCH_TITLE[state]}`,
      text: st.why,
      ...(link ? { link } : {}),
      fields: {
        kind: state,
        project: space.slug,
        repo: root,
        branch,
        why: st.why,
        worktree: st.facts.worktree ?? null,
        dirty: st.facts.dirty ?? 0,
        ahead: st.facts.ahead ?? null,
        aheadOfBase: st.facts.aheadOfBase ?? null,
        ...(link ? { mr: link } : {}),
      },
      things: [{ ...t, ...(link ? { url: link } : {}) }],
      project: space.slug,
      why: st.why,
    });
  }
  return out;
}

const ASK_TITLE: Record<NonNullable<ReviewSource['ask']>['kind'], string> = {
  question: 'закончилась на вопросе',
  permission: 'закончилась на запросе разрешения',
  elicitation: 'закончилась на форме',
};
const VERDICT_TITLE = { continue: 'не доделано', wrap: 'последний шаг' } as const;

function sessionThing(s: ReviewSource): Thing {
  return { type: 'session', key: sessionKey(s.id), ref: { id: s.id }, title: s.name };
}

async function poll(ctx: SourceCtx, deps: ProjectsDeps): Promise<RoutineEvent[]> {
  const x = deps.exec ?? realExec;
  const now = (deps.now ?? Date.now)();
  const nowIso = new Date(now).toISOString();
  const prev = readCursor(ctx.cursor.get());
  const only = new Set(cfgList(ctx.spec, 'spaces'));
  const every = reviewEvery(ctx.spec);
  const spaces = (deps.spaces ?? defaultSpaces)().filter((s) => !only.size || only.has(s.slug));
  if (only.size && !spaces.length) throw new Error(`Нет открытых пространств ${[...only].join(', ')}`);
  const watcher = deps.watcher ?? branchWatcher({ exec: x });
  const events: RoutineEvent[] = [];
  const roots: Cursor['roots'] = {};
  const failed: string[] = [];

  // 1. ветки: репозиторий не прочитался — его прошлые записи остаются (пропажа значила бы «стало чисто»)
  for (const space of spaces) {
    for (const root of space.repos) {
      if (ctx.signal.aborted) break;
      try {
        roots[root] = await branchEvents(ctx, space, root, { x, watcher, now, prev: prev.roots[root] ?? [] });
      } catch (err) {
        failed.push(`${repoName(root)}: ${(err as Error).message}`);
        roots[root] = prev.roots[root] ?? [];
      }
      events.push(...roots[root]!);
    }
  }
  // опрос прервали (сервер останавливается) посреди обхода: неполный список не отдаём и курсор не трогаем
  if (ctx.signal.aborted) throw new Error('обход проектов прерван');
  if (failed.length) ctx.log(`не прочитались репозитории (прошлое состояние сохранено): ${failed.join('; ')}`);

  // 2. разбор моделью по расписанию — только в опросе движка (не в «Проверке на истории» и не в пробной) и не чаще review.
  // Идёт в фоне (до нескольких минут): опрос и очередь движка его не ждут, вердикты станут записями следующей проверки
  let reviewTried = prev.reviewTried;
  const cost = ctx.cost;
  if (every && cost && ctx.scheduled) {
    const store = (deps.reviewStore ?? defaultReviewStore)();
    const last = Math.max(store.at ? Date.parse(store.at) : 0, reviewTried ? Date.parse(reviewTried) : 0);
    if (now - last >= every) {
      reviewTried = nowIso;
      // попытка запоминается сразу: дальше опрос может упасть, а повтор разбора — не раньше review
      ctx.cursor.set({ ...prev, reviewTried } satisfies Cursor);
      void (deps.review ?? defaultReview)(ctx.signal).then(
        (r) => {
          if (r.costUsd > 0) cost(r.costUsd);
          if (r.error) ctx.log(`разбор сессий не прошёл: ${r.error}`);
        },
        (err: unknown) => ctx.log(`разбор сессий не прошёл: ${(err as Error).message}`),
      );
    }
  }

  // 3. сессии: закончилась на вопросе; вердикт разбора «не доделано» / «последний шаг» на той же активности.
  // Живая сессия — уже не «забытое» («Ждёт тебя» и «Сейчас» её показывают), но запись, которая уже была в списке, держится,
  // пока вопрос не снят (ответил — дело закрывается): открыл сессию с карточки — дело не пропадает посреди работы.
  const sessions = await (deps.sessions ?? defaultSessions)(() => false);
  const store = (deps.reviewStore ?? defaultReviewStore)();
  const sessionEvents: RoutineEvent[] = [];
  // сессий не узнать — прошлые записи сессий как есть; итог разбора не прочитался — прошлые вердикты как есть
  if (!sessions) sessionEvents.push(...(prev.sessions ?? []));
  else if (store.broken) {
    sessionEvents.push(...(prev.sessions ?? []).filter((e) => e.fields.kind === 'review'));
    ctx.log('итог разбора сессий не прочитался: прошлые вердикты сохранены');
  }
  const reviewed = new Map(store.items.map((r) => [r.id, r]));
  const current = reviewedNow(store);
  const projectOf = deps.projectOf ?? defaultProjectOf;
  const kept = (id: string, s: ReviewSource) => !s.live || (s.status === 'waiting' && id in prev.first);
  for (const s of sessions ?? []) {
    let project: string | undefined;
    try {
      project = s.space || projectOf(s.cwd);
    } catch {
      project = undefined;
    }
    if (only.size && (!project || !only.has(project))) continue;
    const thing = sessionThing(s);
    const base = { session: s.id, name: s.name, cwd: s.cwd, ...(project ? { project } : {}) };
    if (s.ask) {
      const id = `ask:${s.id}@${s.ask.at}`;
      if (kept(id, s)) {
        const why = `Claude ${s.ask.kind === 'question' ? 'спросил и ждёт' : s.ask.kind === 'permission' ? 'просит разрешения' : 'ждёт ответа в форме'}: ${truncate(s.ask.text, 200)}`;
        sessionEvents.push({
          source: ctx.slug, id, at: '', title: `«${truncate(s.name, 120)}» ${ASK_TITLE[s.ask.kind]}`, text: s.ask.text,
          fields: { kind: 'question', ask: s.ask.kind, askedAt: s.ask.at, ...base }, things: [thing], ...(project ? { project } : {}), why,
        });
      }
    }
    const r = reviewed.get(s.id);
    // вердикт на текущих ходах сессии: были новые ходы — до следующего разбора записи нет
    if (!store.broken && r && r.verdict !== 'done' && current(s)) {
      const id = `review:${s.id}@${r.turns ?? r.activityAt}`;
      if (kept(id, s)) {
        const lines = [r.left && `Осталось: ${r.left}`, r.next && `С чего продолжить: ${r.next}`].filter(Boolean).join('\n');
        sessionEvents.push({
          source: ctx.slug, id, at: '', title: `«${truncate(s.name, 120)}»: ${VERDICT_TITLE[r.verdict]}`, text: lines || r.done,
          fields: { kind: 'review', verdict: r.verdict, done: r.done, left: r.left, next: r.next, reviewedAt: r.at, ...base },
          things: [thing], ...(project ? { project } : {}), why: truncate(r.left || r.done || VERDICT_TITLE[r.verdict], 300),
        });
      }
    }
  }

  events.push(...sessionEvents);

  // время записи — когда она впервые попала в список: вернулась после пропажи — новое время, дело откроется снова
  const first: Cursor['first'] = {};
  for (const e of events) {
    e.at = prev.first[e.id] ?? nowIso;
    first[e.id] = e.at;
  }
  ctx.cursor.set({ first, roots, sessions: sessionEvents, ...(reviewTried ? { reviewTried } : {}) } satisfies Cursor);
  // сессия, начатая с карточки дела (links.sessions), и ветка дела (links.branch) — уже на карточке этого дела: второй
  // карточки «Забытое» о той же работе не нужно. Пропала отсюда — снимок закроет своё «Забытое» о ней
  const held = await heldByOtherItems(ctx, deps);
  return held.size ? events.filter((e) => !held.has(e.things?.[0]?.key ?? '')) : events;
}

/** Ключи сессий и веток, привязанных к открытым делам о другой вещи. Доска не ответила — ничего не прячем. */
async function heldByOtherItems(ctx: SourceCtx, deps: ProjectsDeps): Promise<Set<string>> {
  const out = new Set<string>();
  let items: DeskItem[];
  try {
    items = await (deps.openItems ?? (() => desk().list({ open: true })))();
  } catch (err) {
    ctx.log(`дела не прочитались — сессии и ветки дел не отсеяны: ${(err as Error).message}`);
    return out;
  }
  for (const i of items) {
    if (i.closed) continue;
    for (const id of i.links?.sessions ?? []) if (sessionKey(id) !== i.key) out.add(sessionKey(id));
    if (i.links?.branch && i.links.branch !== i.key) out.add(i.links.branch);
  }
  return out;
}

// ------------------------------------------------------------ настоящие зависимости

/** Открытые пространства; репозиторий нескольких — у того, чей он по правилу проекта (самое старое из привязавших). */
function defaultSpaces(): ProjectSpace[] {
  const resolver = projectResolver();
  return listSpaces()
    .filter((s) => !s.closedAt)
    .map((s) => ({ slug: s.slug, title: s.title || s.slug, repos: (s.repos ?? []).filter((r) => (resolver.path(r).space ?? s.slug) === s.slug) }));
}
const defaultProjectOf = (dir: string): string | undefined => projectOfPath(dir).space ?? undefined;
const defaultReviewStore = (): ReviewStore => readReviewStore();
// сессии — из менеджера сессий сервера (терминал, ws): модуль подгружается при первом обходе, а не с движком рутин
async function defaultSessions(turnsFor?: (s: ReviewKey) => boolean): Promise<ReviewSource[] | undefined> {
  const { sessionReviewSources, sessionsAvailable } = await import('../../sessions-server.js');
  // терминал не загрузился (node-pty, нет claude) — сессий не узнать, а не «сессий нет»
  if (!(await sessionsAvailable().catch(() => false))) return undefined;
  return sessionReviewSources(turnsFor);
}
async function defaultReview(signal: AbortSignal): Promise<{ costUsd: number; error?: string }> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  if (signal.aborted) abort.abort();
  else signal.addEventListener('abort', stop, { once: true });
  let r: Awaited<ReturnType<typeof reviewNow>>;
  try {
    r = await reviewNow({ load: async (turnsFor) => (await defaultSessions(turnsFor)) ?? [], hooks: { abort, log: () => {}, onEvent: () => {}, onModel: () => {}, onStage: () => {} } });
  } finally {
    // сигнал опроса общий на весь процесс: слушатель каждого разбора снимается
    signal.removeEventListener('abort', stop);
  }
  // 200 — итог с ценой разбора; 502 — сбой с тем, что успели потратить (SpaceDraftFailure)
  const body = r.body as { costUsd?: unknown; error?: unknown; code?: unknown };
  const costUsd = typeof body.costUsd === 'number' ? body.costUsd : 0;
  // разбор уже идёт (кнопка на главной) — не ошибка: его итог источник прочитает
  if (r.status === 200 || body.code === 'busy') return { costUsd };
  return { costUsd, error: typeof body.error === 'string' ? body.error : `ответ ${r.status}` };
}

export function projectsKind(deps: ProjectsDeps = {}): SourceKind {
  return {
    kind: 'projects',
    title: 'Проекты',
    summary: 'Брошенное в проектах пространств: незакоммиченные и неотправленные ветки, ветки без MR, сессии на вопросе и «не доделано»',
    delivery: 'poll',
    minEveryMs: MIN_POLL_MS,
    snapshot: true,
    setup: [
      { key: 'spaces', label: 'Пространства', placeholder: 'kai, billing', optional: true, hint: 'Слаги через запятую. Пусто — все открытые пространства и все сессии.' },
      {
        key: 'review',
        label: 'Разбор сессий моделью',
        placeholder: 'off',
        optional: true,
        hint: 'Как часто модель (sonnet) разбирает сессии с новыми ходами: «не доделано» и «последний шаг» станут делами. ≈ $0.05–0.6 за разбор. Пусто или off — без модели; 24h — раз в сутки.',
      },
    ],
    match: [
      ...BASE_MATCH.filter((f) => f.key !== 'author'),
      { key: 'kind', label: 'Что брошено', type: 'enum', options: [...KINDS] },
      { key: 'project', label: 'Пространство', type: 'text' },
      { key: 'branch', label: 'Ветка', type: 'text' },
      { key: 'repo', label: 'Репозиторий', type: 'text' },
      { key: 'verdict', label: 'Вердикт разбора', type: 'enum', options: ['continue', 'wrap'] },
    ],
    poll: (ctx) => poll(ctx, deps),
    describe: (spec) => {
      const only = cfgList(spec, 'spaces');
      let review: string;
      try {
        const ms = reviewEvery(spec);
        review = ms ? `раз в ${Math.round(ms / 3_600_000)} ч разбор моделью (sonnet) сессий с новыми ходами` : 'без разбора моделью';
      } catch (err) {
        review = (err as Error).message;
      }
      return `Обход ${only.length ? `пространств ${only.join(', ')}` : 'всех открытых пространств'}: ветки их репозиториев (git status, ahead/behind, MR через glab/gh) и сессии терминала, закончившиеся на вопросе; ${review}. Только чтение. Пропало из списка — дело закрывается.`;
    },
  };
}
