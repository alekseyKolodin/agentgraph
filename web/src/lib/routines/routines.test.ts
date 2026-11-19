import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry, MatchField, RoutineView, SourceView } from '@server/routines/types';
import { buildMatch, conditionText, matchFields, opsFor, parseMatch } from './match';
import { describeSchedule, formatNext, fromCron, nextRuns, parseCron, toCron } from './schedule';
import { buildSpec, draftFromSpec, draftMissing, emptyDraft, replyChoice, replySpec, SCHEDULE, slugify } from './spec';
import { logDetail as detailOf, taskVerdict } from './view';
import { defaultTitle, replyWhere, sentence, step2Title } from './phrase';
import {
  brokenSources, catchUpCount, catchUpRunLabel, catchUpText, chipCounts, chipOutcomes, decidedDeskKeys, decisionText, isDraft, logAction, logDetail, logTime, overviewMeta, pollCostText, routineNote, routineState,
  sourceState, stateLabel, stateTone, strip, verdict, waitButtons, weekCost,
} from './view';
import { commandSpec, everyLabel, everyOptions, foundRow, foundText, kindSpec, missingFields } from './source';

const FIELDS: MatchField[] = [
  { key: 'channel', label: 'Канал', type: 'text' },
  { key: 'thread', label: 'Тред', type: 'bool' },
  { key: 'duration', label: 'Длительность', type: 'number' },
  ...matchFields(),
];

test('условия: MatchRule разбирается в строки и собирается обратно с типами значений', () => {
  const rule = { channel: ['bugs', 'qa'], thread: false, 'duration>': 10, 'title~': 'billing', 'author!': 'bot' };
  const conds = parseMatch(rule);
  assert.deepEqual(conds.map(({ raw: _, ...c }) => c), [
    { field: 'channel', op: 'eq', value: 'bugs, qa' },
    { field: 'thread', op: 'eq', value: 'false' },
    { field: 'duration', op: 'gt', value: '10' },
    { field: 'title', op: 'contains', value: 'billing' },
    { field: 'author', op: 'ne', value: 'bot' },
  ]);
  assert.deepEqual(buildMatch(conds, FIELDS), rule);
  // нетронутая строка пишется как была: запятая в «равно» — не список, массив чисел — массив
  const tricky = { title: 'Ошибка, срочно', duration: [100, 200] };
  assert.deepEqual(buildMatch(parseMatch(tricky), FIELDS), tricky);
  // тронутая — по типу поля: «100, 200» у числа — список чисел
  const edited = parseMatch(tricky).map((c) => (c.field === 'duration' ? { ...c, value: '100, 300' } : c));
  assert.deepEqual(buildMatch(edited, FIELDS), { title: 'Ошибка, срочно', duration: [100, 300] });
  assert.equal(buildMatch([{ field: 'title', op: 'eq', value: '  ' }], FIELDS), undefined);
  assert.equal(conditionText(conds[1]!, FIELDS), 'Тред: нет');
  assert.equal(conditionText(conds[2]!, FIELDS), 'Длительность > 10');
  assert.deepEqual(opsFor('bool'), ['eq']);
});

test('matchFields: поля вида первыми, общие — без повторов', () => {
  const f = matchFields({ match: [{ key: 'author', label: 'Кто написал', type: 'text' }, { key: 'channel', label: 'Канал', type: 'text' }] });
  assert.deepEqual(f.map((x) => x.key), ['author', 'channel', 'title', 'text']);
  assert.equal(f[0]!.label, 'Кто написал');
});

test('расписание: пресеты ↔ cron, ближайшие запуски, фраза', () => {
  assert.equal(toCron({ preset: 'weekdays', time: '09:30' }), '30 9 * * 1-5');
  assert.equal(toCron({ preset: 'daily', time: '18:05' }), '5 18 * * *');
  assert.equal(toCron({ preset: 'hourly', time: '09:30' }), '0 * * * *');
  assert.deepEqual(fromCron('30 9 * * 1-5'), { preset: 'weekdays', time: '09:30' });
  assert.equal(fromCron('*/15 * * * *').preset, 'custom');
  assert.equal(parseCron('61 * * * *'), null);
  // вторник 17.11.2026, 12:10
  const now = new Date(2026, 10, 17, 12, 10);
  const wd = nextRuns('30 9 * * 1-5', now, 4);
  assert.deepEqual(wd.map((d) => d.getDate()), [18, 19, 20, 23]);
  assert.equal(formatNext(wd.slice(0, 3), now), 'ср 18.11, чт 19.11, пт 20.11 в 09:30');
  assert.equal(formatNext(nextRuns('0 * * * *', now, 3), now), 'сегодня в 13:00, 14:00, 15:00');
  assert.deepEqual(nextRuns('*/20 12 * * *', now, 2).map((d) => d.getMinutes()), [20, 40]);
  assert.equal(describeSchedule('30 9 * * 1-5'), 'По будням в 09:30');
  assert.equal(describeSchedule('0 * * * *'), 'Раз в час');
  assert.equal(describeSchedule('0 9 1 * *'), 'По расписанию «0 9 1 * *»');
});

test('ответ: три варианта шага 4 ↔ ReplySpec', () => {
  assert.deepEqual(replySpec('draft', 'source'), { to: 'source', on: ['pause', 'end'], draft: true });
  assert.deepEqual(replySpec('auto', 'telegram-me', ['end']), { to: 'telegram-me', on: ['end'], draft: false });
  assert.deepEqual(replySpec('off', 'source'), { to: 'none' });
  assert.equal(replyChoice(undefined), 'off');
  assert.equal(replyChoice({ to: 'source', draft: true }), 'draft');
  assert.equal(replyChoice({ to: 'source', draft: false }), 'auto');
});

test('сборка RoutineSpec из шагов: источник с условиями, проверка, остановка перед блоком, лимиты; и обратно', () => {
  const d = {
    ...emptyDraft(),
    title: 'Баг в #bugs → таска и фикс',
    source: 'slack-work',
    conds: [{ field: 'channel', op: 'eq' as const, value: 'bugs' }, { field: 'thread', op: 'eq' as const, value: 'false' }],
    check: ' Это баг-репорт ',
    flow: 'bug-to-fix',
    space: 'billing',
    worktree: 'new' as const,
    mode: 'until_pause' as const,
    pauseBefore: ['fix'],
    usd: '$3',
    perDay: '5',
  };
  const spec = buildSpec(d, FIELDS);
  assert.deepEqual(spec, {
    title: 'Баг в #bugs → таска и фикс',
    enabled: false,
    // новый узел «ИИ рутины» спрашивает, когда не уверен (checkAsk у нового черновика включён)
    when: { source: 'slack-work', match: { channel: 'bugs', thread: false }, check: 'Это баг-репорт', ask: true },
    run: { flow: 'bug-to-fix', space: 'billing', worktree: 'new', pause_before: ['fix'] },
    mode: 'until_pause',
    reply: { to: 'source', on: ['pause', 'end'], draft: true },
    limits: { usd: 3, per_day: 5 },
  });
  const back = draftFromSpec(spec);
  assert.equal(back.source, 'slack-work');
  assert.equal(back.check, 'Это баг-репорт');
  assert.deepEqual(back.pauseBefore, ['fix']);
  assert.equal(back.usd, '3');
  assert.deepEqual(buildSpec(back, FIELDS), spec);
});

test('сборка RoutineSpec: расписание с задачей, без ответа и лимитов; чего не хватает', () => {
  const d = { ...emptyDraft(), title: 'Утренняя сводка', source: SCHEDULE, flow: 'mr-digest', input: 'Что в моих MR требует ответа сегодня', mode: 'auto' as const, reply: 'off' as const };
  assert.deepEqual(buildSpec(d, []), {
    title: 'Утренняя сводка',
    enabled: false,
    when: { schedule: '30 9 * * 1-5', missed: 'ask' },
    run: { flow: 'mr-digest', input: 'Что в моих MR требует ответа сегодня' },
    mode: 'auto',
    reply: { to: 'none' },
  });
  assert.deepEqual(draftMissing(emptyDraft()), ['source', 'flow']);
  // признак черновика уходит в правило, только пока рутина выключена
  assert.equal(buildSpec({ ...d, enabled: false, draft: true }, []).draft, true);
  assert.equal(buildSpec({ ...d, enabled: true, draft: true }, []).draft, undefined);
  assert.equal(draftFromSpec({ ...buildSpec({ ...d, enabled: false, draft: true }, []) }).draft, true);
  assert.deepEqual(draftMissing({ ...d, mode: 'until_pause' }), ['block']);
});

test('шаг «Дело»: без flow рутина только заводит дела — run и ответа нет, умолчания не пишутся', () => {
  const d = { ...emptyDraft(), title: 'Ревью из GitLab', source: 'gitlab', taskOn: true, taskKind: 'Ревью' };
  const spec = buildSpec(d, []);
  assert.deepEqual(spec, { title: 'Ревью из GitLab', enabled: false, when: { source: 'gitlab' }, mode: 'suggest', reply: { to: 'none' }, task: { kind: 'Ревью' } });
  assert.deepEqual(draftMissing(d), []);
  const back = draftFromSpec(spec);
  assert.equal(back.taskOn, true);
  assert.equal(back.flow, '');
  assert.deepEqual(buildSpec(back, []), spec);
  // дела из flow без flow заводить некому; вид дела обязателен
  assert.deepEqual(draftMissing({ ...d, taskFrom: 'flow' }), ['flow']);
  assert.deepEqual(draftMissing({ ...d, taskKind: ' ' }), ['kind']);
  // «условие словами» без условия не сохраняется молча как «вещь закрыта»
  assert.deepEqual(draftMissing({ ...d, taskClose: '' }), ['close']);
  // без flow пространство формы — проект дела; с flow — пространство запуска
  assert.equal(buildSpec({ ...d, space: 'billing' }, []).task?.project, 'billing');
  assert.equal(draftFromSpec(buildSpec({ ...d, space: 'billing' }, [])).space, 'billing');
  assert.equal(buildSpec({ ...d, space: 'billing', flow: 'review' }, []).task?.project, undefined);
});

test('шаг «Дело» с flow: все поля блока task туда и обратно', () => {
  const d = { ...emptyDraft(), title: 'Ревью', source: 'slack', flow: 'review', taskOn: true, taskKind: 'Ревью', taskColumn: 'plan' as const, taskSame: 'thread' as const, taskRepeat: 'keep' as const, taskClose: 'в треде ответили «готово»' };
  const spec = buildSpec(d, []);
  assert.equal(spec.run?.flow, 'review');
  assert.deepEqual(spec.task, { kind: 'Ревью', column: 'plan', same: 'thread', on_repeat: 'keep', close: 'в треде ответили «готово»' });
  assert.deepEqual(buildSpec(draftFromSpec(spec), []), spec);
  // «закрою сам» пишется, «когда вещь закрыта» — умолчание
  assert.equal(buildSpec({ ...d, taskClose: 'never' }, []).task?.close, 'never');
  assert.equal(buildSpec({ ...d, taskClose: 'thing' }, []).task?.close, undefined);
  // шаг выключен — блока task нет, run на месте
  assert.equal(buildSpec({ ...d, taskOn: false }, []).task, undefined);
});

test('проверка на истории: строка о деле — дело, в план, то же дело, закрыто', () => {
  assert.equal(taskVerdict(undefined), undefined);
  assert.equal(taskVerdict({ action: 'new', key: 'mr:a/b/1' })?.text, 'дело');
  assert.equal(taskVerdict({ action: 'plan', key: 'mr:a/b/1' })?.text, 'в план');
  assert.equal(taskVerdict({ action: 'same', key: 'mr:a/b/1' })?.text, 'то же дело');
  assert.deepEqual(taskVerdict({ action: 'closed', key: 'mr:a/b/1', note: 'MR смержен' }), { text: 'закрыто', why: 'MR смержен' });
});

test('slugify: транслит, без занятых и зарезервированных', () => {
  assert.equal(slugify('Баг в #bugs → таска и фикс'), 'bag-v-bugs-taska-i-fiks');
  assert.equal(slugify('Утренняя сводка', ['utrennyaya-svodka']), 'utrennyaya-svodka-2');
  assert.equal(slugify('new'), 'new-routine');
  assert.equal(slugify('→ !!'), 'routine');
});

test('фраза-итог: источник, расписание, ожидание и ответ', () => {
  const src = { title: 'Fireflies.ai', kind: 'command' };
  const d = { ...emptyDraft(), source: 'fireflies', flow: 'meeting-to-tasks', space: 'billing', mode: 'auto' as const };
  assert.equal(sentence(d, src, FIELDS), 'Когда в Fireflies.ai появляется новая запись, запустить meeting-to-tasks в ◇ billing. Ответ уходит после твоей проверки.');
  const slack = { ...d, conds: [{ field: 'channel', op: 'eq' as const, value: 'bugs' }], check: 'баг', mode: 'until_pause' as const, pauseBefore: ['fix'], reply: 'off' as const };
  assert.equal(
    sentence(slack, { title: 'Slack · work', kind: 'slack' }, FIELDS),
    'Когда в Slack · work приходит новое сообщение, где Канал = bugs и оно подходит под условие словами, запустить meeting-to-tasks в ◇ billing. Остановится перед «fix».',
  );
  const sched = { ...emptyDraft(), source: SCHEDULE, flow: 'mr-digest', mode: 'auto' as const, reply: 'auto' as const };
  assert.equal(sentence(sched, undefined, []), 'По будням в 09:30 запустить mr-digest. О результате пишет сама.');
  assert.equal(sentence({ ...sched, mode: 'suggest' }, undefined, []), 'По будням в 09:30 запустить mr-digest. Перед запуском спросит тебя. О результате пишет сама.');
  assert.equal(defaultTitle(sched, undefined), 'По будням в 09:30 → mr-digest');
  assert.equal(step2Title('slack'), 'Какие сообщения');
  assert.equal(step2Title('command'), 'Какие записи');
  assert.equal(replyWhere('slack', 'source', []), 'в тред сообщения');
  assert.equal(replyWhere('command', 'tg', [{ slug: 'tg', spec: { title: 'Telegram', kind: 'telegram', config: {} } }]), 'мне в Telegram');
});

const entry = (p: Partial<LogEntry> & Pick<LogEntry, 'outcome' | 'at'>): LogEntry => ({ id: p.at, routine: 'bug', event: { source: 'slack', id: p.at, title: 't', at: p.at }, ...p });

const view = (p: Partial<RoutineView> = {}): RoutineView => ({
  slug: 'bug',
  spec: { title: 'Баг', when: { source: 'slack' }, run: { flow: 'bug-to-fix' }, mode: 'suggest' },
  yaml: '',
  problems: [],
  stats: { today: 0, started: 0, waiting: 0, costUsd: 0 },
  recent: [],
  ...p,
});
const src = (p: Partial<SourceView> = {}): SourceView => ({ slug: 'slack', spec: { title: 'Slack', kind: 'slack', config: {} }, status: 'ok', missingSecrets: [], usedBy: [], canReply: false, ...p });

test('состояние рутины: черновик, пауза, ждёт, источник, идёт, включена', () => {
  assert.equal(routineState(view({ spec: { ...view().spec, enabled: false, draft: true } }), [], []), 'draft');
  assert.ok(isDraft(view({ spec: { ...view().spec, enabled: false, draft: true } })));
  // выключенная рутина без срабатываний, но не черновик (поставили на паузу сразу после включения) — на паузе
  assert.equal(routineState(view({ spec: { ...view().spec, enabled: false } }), [], []), 'paused');
  const fired = { stats: { today: 1, started: 1, waiting: 0, costUsd: 0, lastAt: '2026-11-17T10:00:00Z' } };
  assert.equal(routineState(view({ ...fired, spec: { ...view().spec, enabled: false } }), [], []), 'paused');
  assert.equal(routineState(view(fired), [], [{ id: 'w', routine: 'bug' } as never]), 'waiting');
  assert.equal(routineState(view(fired), [src({ status: 'error', error: 'токен отозван' })], []), 'source_error');
  assert.equal(routineState(view(fired), [src({ missingSecrets: ['SLACK_TOKEN'] })], []), 'needs_secret');
  const recent = [entry({ outcome: 'started', at: '2026-11-17T10:00:00Z', runId: 'r1' })];
  assert.equal(routineState(view({ ...fired, recent }), [src()], [], new Map([['r1', 'running']])), 'running');
  assert.equal(routineState(view({ ...fired, recent }), [src()], [], new Map([['r1', 'done']])), 'ok');
});

test('полоска: старые слева, статусы запусков, пустые клетки в конце', () => {
  const recent = [
    entry({ outcome: 'waiting', at: '2026-11-17T10:40:00Z' }),
    entry({ outcome: 'filtered', at: '2026-11-17T10:31:00Z' }),
    entry({ outcome: 'started', at: '2026-11-17T08:12:00Z', runId: 'a' }),
    entry({ outcome: 'started', at: '2026-11-16T08:12:00Z', runId: 'b' }),
  ];
  assert.deepEqual(strip(recent, new Map([['a', 'done'], ['b', 'failed']]), 6), ['f', 'o', 's', 'w', 'c', 'c']);
});

test('журнал: исход, действие, детали, фильтры и деньги за неделю', () => {
  const runs = new Map([['a', 'failed'], ['b', 'running']]);
  assert.deepEqual(verdict(entry({ outcome: 'started', at: 'x', runId: 'a' }), runs), { text: 'не довёл', tone: 'fail' });
  assert.deepEqual(verdict(entry({ outcome: 'started', at: 'x', runId: 'b' }), runs), { text: 'идёт', tone: 'live' });
  assert.deepEqual(verdict(entry({ outcome: 'duplicate', at: 'x' })), { text: 'повтор', tone: 'muted' });
  assert.deepEqual(logAction(entry({ outcome: 'waiting', at: 'x' })), { kind: 'open', label: 'Открыть', primary: true });
  assert.deepEqual(logAction(entry({ outcome: 'started', at: 'x', runId: 'a' }), runs), { kind: 'run', label: 'Продолжить' });
  assert.deepEqual(logAction(entry({ outcome: 'limit', at: 'x' })), { kind: 'start', label: 'Запустить' });
  assert.equal(logAction(entry({ outcome: 'rejected', at: 'x' })), null);
  assert.equal(logDetail(entry({ outcome: 'check_no', at: 'x', reason: 'это вопрос, а не баг', costUsd: 0.002 })), 'это вопрос, а не баг. Потрачено $0.00.');
  const list = [entry({ outcome: 'waiting', at: '2026-11-17T10:00:00Z', costUsd: 0.4 }), entry({ outcome: 'filtered', at: '2026-11-01T10:00:00Z', costUsd: 5 }), entry({ outcome: 'error', at: '2026-11-17T09:00:00Z' })];
  assert.deepEqual(chipCounts(list), [{ chip: 'all', n: 3 }, { chip: 'wait', n: 1 }, { chip: 'run', n: 0 }, { chip: 'skip', n: 1 }, { chip: 'error', n: 1 }]);
  assert.deepEqual(chipOutcomes('skip'), ['filtered', 'check_no', 'duplicate', 'limit', 'rejected', 'missed']);
  assert.equal(weekCost(list, new Date('2026-11-17T12:00:00Z')), 0.4);
  const meta = overviewMeta([view({ stats: { today: 3, started: 3, waiting: 0, costUsd: 9 }, recent: [entry({ outcome: 'started', at: new Date().toISOString(), costUsd: 2.4 })] })]);
  assert.equal(meta, 'сегодня 3 запуска · $2.40');
});

test('время строки журнала: сегодня, вчера, раньше', () => {
  const now = new Date(2026, 10, 17, 12, 0);
  assert.equal(logTime(new Date(2026, 10, 17, 9, 5).toISOString(), now), '09:05');
  assert.equal(logTime(new Date(2026, 10, 16, 23, 0).toISOString(), now), 'вчера');
  assert.equal(logTime(new Date(2026, 10, 3, 8, 0).toISOString(), now), '03.11');
});

test('карточка ожидания: глагол из вопроса, «Это не баг», строка решения', async () => {
  assert.deepEqual(waitButtons({ question: 'Чинить: заказ висит в pending?', kind: 'pause' }), { run: 'Чинить', later: 'Не сейчас', reject: 'Это не баг' });
  assert.deepEqual(waitButtons({ question: 'Разобрать встречу «Планёрка»?', kind: 'suggest' }), { run: 'Запустить', later: 'Не сейчас', reject: 'Не то' });
  assert.deepEqual(waitButtons({ question: 'Ответ готов', kind: 'reply' }), { run: 'Отправить', later: 'Не сейчас', reject: 'Не отправлять' });
  assert.equal(decisionText('run', { kind: 'reply', replyDraft: { text: 'x', where: 'в тред' } }, true), 'Ответ ушёл: в тред.');
  const w = { kind: 'pause' as const, replyDraft: { text: 'Взял в работу', where: 'в тред Slack' } };
  assert.equal(decisionText('run', w, true), 'Запуск продолжен. Ответ ушёл: в тред Slack.');
  assert.equal(decisionText('later', w, false), 'Отложено. Запуск ждёт в срабатываниях рутины. Наружу ничего не ушло.');
  // «Не сейчас» с галочкой: ответ не уходит и строка этого не обещает
  assert.equal(decisionText('later', w, true), 'Отложено. Запуск ждёт в срабатываниях рутины. Наружу ничего не ушло.');
  const { replySent, activeWaits } = await import('./view');
  assert.equal(replySent('later', w, true), false);
  assert.equal(replySent('run', w, true), true);
  assert.equal(replySent('run', w, false), false);
  assert.equal(replySent('run', { kind: 'reply', replyDraft: w.replyDraft }, false), true);
  assert.deepEqual(activeWaits([{ snoozedAt: 'x' }, {}]), [{}]);
});

test('догнать: подходящие события и пропущенное расписание', () => {
  const list = [
    { id: 'a', routine: 'bug', routineTitle: 'Баг', events: 9, matching: 1 },
    { id: 'b', routine: 'digest', routineTitle: 'Сводка', events: 0, matching: 0, missedAt: '2026-11-17T06:30:00Z' },
  ];
  assert.equal(catchUpCount(list), 2);
  assert.equal(catchUpRunLabel(list), 'Запустить оба');
  assert.equal(catchUpText(list), 'Пока приложение было закрыто, пришло 9 событий для рутин, 2 подходят.');
  assert.equal(catchUpText([list[1]!]), 'Пока приложение было закрыто, пришло 1 событие для рутин.');
});

test('источник: интервалы, своя команда, форма вида без секретов в файле', () => {
  assert.deepEqual(everyOptions('30m'), ['30m', '1h', '3h']);
  assert.equal(everyLabel('5m'), 'каждые 5 минут');
  assert.equal(everyLabel('1h'), 'каждый час');
  assert.deepEqual(commandSpec("gh api notifications --jq '.'", '', { id: 'id', title: ' subject.title ', text: '' }, '5m'), {
    title: 'gh api',
    kind: 'command',
    config: { command: "gh api notifications --jq '.'" },
    every: '5m',
    map: { id: 'id', title: 'subject.title' },
  });
  const kind = { kind: 'slack', title: 'Slack', setup: [{ key: 'channels', label: 'Каналы' }, { key: 'SLACK_TOKEN', label: 'Токен', secret: true }, { key: 'team', label: 'Команда', optional: true }] };
  assert.deepEqual(kindSpec(kind, { channels: 'bugs', SLACK_TOKEN: 'xoxp-1' }, '', undefined), {
    spec: { title: 'Slack', kind: 'slack', config: { channels: 'bugs' }, secrets: ['SLACK_TOKEN'] },
    secrets: { SLACK_TOKEN: 'xoxp-1' },
  });
  assert.deepEqual(missingFields(kind.setup, { channels: 'bugs' }).map((f) => f.key), ['SLACK_TOKEN']);
  assert.deepEqual(missingFields(kind.setup, { channels: 'bugs' }, ['SLACK_TOKEN']), []);
  assert.equal(foundText(3), 'Сервис отвечает. Нашёл 3 записи.');
  assert.equal(foundText(2, true), 'Команда отработала. Нашёл 2 записи.');
  const now = new Date(2026, 10, 17, 12, 0);
  assert.deepEqual(foundRow({ id: 'x', title: '', text: 'Планёрка billing\nещё', at: new Date(2026, 10, 17, 10, 0).toISOString() }, now), { title: 'Планёрка billing', meta: 'сегодня 10:00' });
  assert.equal(foundRow({ id: 'x', title: '1:1', text: '', at: new Date(2026, 10, 16, 15, 30).toISOString() }, now).meta, 'вчера 15:30');
});

test('обратная связь: что предложить у строки журнала, отметка, строка проверки на истории, оценка', async () => {
  const { estimateText, feedbackNote, feedbackOptions, historyVerdict } = await import('./view');
  assert.deepEqual(feedbackOptions({ outcome: 'check_no' }), ['match']);
  assert.deepEqual(feedbackOptions({ outcome: 'duplicate' }), ['not_duplicate']);
  assert.deepEqual(feedbackOptions({ outcome: 'started' }), ['no_match']);
  assert.deepEqual(feedbackOptions({ outcome: 'check_no', feedback: 'match' }), []);
  assert.deepEqual(feedbackOptions({ outcome: 'limit' }), []);
  assert.equal(feedbackNote('not_duplicate'), 'ты отметил: не повтор');
  const ev = { source: 's', id: '1', at: '', title: 't', text: '', fields: {} };
  assert.deepEqual(historyVerdict({ event: ev, outcome: 'check_no', reason: 'нет шагов воспроизведения.', past: 'match', disagrees: true }), {
    text: 'пропуск',
    run: false,
    disagrees: true,
    why: 'Ты отметил это как подходящее, правило пропустило. нет шагов воспроизведения.',
  });
  assert.equal(historyVerdict({ event: ev, outcome: 'started', past: 'match', disagrees: false }).disagrees, false);
  assert.equal(estimateText({ runsPerWeek: 4.2, usdPerWeek: 9.8 }), '≈ 4.2 запуска в неделю · $9.80');
  assert.equal(estimateText({ runsPerWeek: 5, usdPerWeek: 0 }), '≈ 5 запусков в неделю');
  assert.equal(estimateText(undefined), '');
});

test('отложенное решение: уходит через 5 с, отмена до этого, замена и немедленная отправка', async () => {
  const { createDelayed } = await import('./pending');
  const sent: string[] = [];
  const queue = new Map<number, () => void>();
  let seq = 0;
  const timers = { set: (fn: () => void) => (queue.set(++seq, fn), seq), clear: (h: unknown) => void queue.delete(h as number) };
  const d = createDelayed<string>((id, p) => void sent.push(`${id}:${p}`), 5000, timers);
  let changes = 0;
  d.subscribe(() => changes++);
  d.schedule('w1', 'run');
  d.schedule('w2', 'later');
  assert.deepEqual(d.ids(), ['w1', 'w2']);
  assert.equal(d.cancel('w1'), true);
  assert.equal(d.cancel('w1'), false);
  d.schedule('w2', 'reject');
  assert.equal(queue.size, 1);
  [...queue.values()].forEach((fn) => fn());
  assert.deepEqual(sent, ['w2:reject']);
  d.schedule('w3', 'run');
  d.flush('w3');
  assert.deepEqual(sent, ['w2:reject', 'w3:run']);
  assert.equal(d.has('w3'), false);
  assert.ok(changes >= 6);
});

test('состояние рутины по источнику: не отвечает, молчит дольше обычного, ещё не проверялся — понятными словами', () => {
  const now = new Date(2026, 10, 17, 12, 0);
  const on = view({ spec: { ...view().spec, mode: 'auto' } });
  const check = { at: now.toISOString(), ok: true, total: 3, fresh: 0, emptySince: new Date(2026, 10, 14, 9, 0).toISOString() };
  assert.equal(routineState(on, [src({ status: 'empty', check })], []), 'source_empty');
  assert.equal(routineState(on, [src({ status: 'unchecked' })], []), 'unchecked');
  assert.equal(routineState(on, [src({ status: 'error', error: '401' })], []), 'source_error');
  assert.equal(stateLabel('source_error'), 'Источник не отвечает');
  assert.equal(stateLabel('source_empty'), 'Источник молчит дольше обычного');
  assert.equal(stateLabel('unchecked'), 'Источник ещё не проверялся');
  assert.deepEqual([stateTone('source_error'), stateTone('source_empty'), stateTone('unchecked')], ['fail', 'wait', 'muted']);
  assert.deepEqual(routineNote('source_empty', on, src({ status: 'empty', check }), now), { text: 'нет новых записей с 14.11 — дольше обычного', tone: 'wait' });
  assert.deepEqual(routineNote('source_error', on, src({ status: 'error', error: '401 токен отозван' })), { text: '401 токен отозван', tone: 'fail' });
  assert.equal(routineNote('ok', on, src()), null);
});

test('источник в списке: тон и подпись по статусу; расход опроса моделью', () => {
  assert.deepEqual(sourceState(src({ status: 'error', error: 'нет сети' })), { tone: 'fail', label: 'Не отвечает', note: 'нет сети' });
  assert.equal(sourceState(src({ status: 'unchecked' })).tone, 'muted');
  assert.equal(sourceState(src({ status: 'empty' })).note, 'нет новых записей дольше обычного');
  assert.equal(sourceState(src({ status: 'needs_secret', missingSecrets: ['SLACK_TOKEN'] })).note, 'нет ключа SLACK_TOKEN');
  assert.deepEqual(sourceState(src()), { tone: 'ok', label: 'Отвечает' });
  assert.equal(pollCostText(src({ pollCostUsd: { today: 0.12, week: 0.8 } })), 'опрос моделью: сегодня $0.12 · 7 дней $0.80');
  assert.equal(pollCostText(src()), '');
});

test('главная: сломанные источники рутин — сначала не отвечающие; неиспользуемые и исправные не показываются', () => {
  const list = brokenSources([
    src({ slug: 'a', status: 'empty', usedBy: ['r1'], spec: { title: 'Почта', kind: 'email', config: {} } }),
    src({ slug: 'b', status: 'error', error: '401 токен отозван', usedBy: ['r1', 'r2'] }),
    src({ slug: 'c', status: 'error', error: 'нет сети', usedBy: [] }),
    src({ slug: 'd', status: 'ok', usedBy: ['r3'] }),
    src({ slug: 'e', status: 'needs_secret', missingSecrets: ['TOKEN'], usedBy: ['r4'] }),
  ]);
  assert.deepEqual(list.map((b) => [b.slug, b.tone]), [['b', 'fail'], ['a', 'wait'], ['e', 'wait']]);
  assert.equal(list[0]!.text, 'Источник «Slack» не отвечает');
  assert.equal(list[0]!.detail, '401 токен отозван');
  assert.equal(list[0]!.routines, 2);
  assert.equal(list[1]!.text, 'Источник «Почта» молчит');
});

test('главная: источник, который читают только рутины на паузе, не горит; хоть одна включённая — горит', () => {
  const sources = [src({ slug: 'b', status: 'error', error: 'нет сети', usedBy: ['p', 'q'] })];
  const r = (slug: string, enabled: boolean) => view({ slug, spec: { ...view().spec, enabled } });
  assert.deepEqual(brokenSources(sources, new Date(), [r('p', false), r('q', false)]), []);
  const one = brokenSources(sources, new Date(), [r('p', false), r('q', true)]);
  assert.deepEqual(one.map((b) => [b.slug, b.routines]), [['b', 1]]);
});

test('шапка списка: расход опроса источников за сегодня входит в деньги дня', () => {
  const meta = overviewMeta([view({ stats: { today: 1, started: 1, waiting: 0, costUsd: 1 }, recent: [entry({ outcome: 'started', at: new Date().toISOString(), costUsd: 1 })] })], new Date(), [src({ pollCostUsd: { today: 0.5, week: 2 } })]);
  assert.equal(meta, 'сегодня 1 запуск · $1.50');
});

test('строка журнала: сколько дел завёл запуск', () => {
  const e = { id: '1', at: '2026-11-17T10:00:00.000Z', routine: 'r', event: { source: 's', id: 'e', title: 'x', at: '2026-11-17T10:00:00.000Z' }, outcome: 'started' as const, desk: { created: 2, signals: 1 } };
  assert.match(detailOf(e), /Запуск завёл 2 дела\. Дописал в дела сигналов: 1\./);
});

test('решение по ожиданию дела: пока оно в пути, карточка без кнопок; не ушло или отменено — кнопки вернулись', () => {
  const lines = [
    { state: 'pending', deskKey: 'mr:gitlab.com/a/b/1' },
    { state: 'sent', deskKey: 'mr:gitlab.com/a/b/2' },
    { state: 'failed', deskKey: 'mr:gitlab.com/a/b/3' },
    // решение по ожиданию без дела (чинить баг, пауза запуска): карточки нет — прятать нечего
    { state: 'pending' },
  ];
  assert.deepEqual([...decidedDeskKeys(lines)], ['mr:gitlab.com/a/b/1', 'mr:gitlab.com/a/b/2']);
  assert.equal(decidedDeskKeys([]).size, 0);
});
