// Чистая логика рутин: схемы и проблемы правила, слаги, интервалы, cron, условия на поля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeSlug, parseEvery, parseRoutineYaml, parseSourceYaml, routineProblems, slugify } from './schema.js';
import { cronMatches, dueSlots, nextAt, parseCron, scheduleEvent, type Cron } from './schedule.js';
import { matchOne, matchRule } from './match.js';
import type { RoutineEvent, RoutineSpec } from './types.js';

const routine = (extra: Partial<RoutineSpec> = {}): RoutineSpec => ({ title: 'Баги', when: { source: 'slack' }, run: { flow: 'demo' }, mode: 'auto', ...extra });
const ctx = { flowBlocks: (n: string) => (n === 'demo' ? ['analyze', 'fix'] : undefined), sourceExists: (s: string) => s === 'slack' };

test('правило из YAML проходит схему, лишнее поле и неверный mode — problems с путём', () => {
  const ok = parseRoutineYaml('title: Баги\nwhen: { source: slack, match: { channel: bugs, "text~": [упал, ошибка] } }\nrun: { flow: demo, pause_before: [fix] }\nmode: until_pause\nlimits: { per_day: 3 }\n');
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.spec?.limits?.per_day, 3);
  const bad = parseRoutineYaml('title: X\nwhen: { source: s }\nrun: { flow: demo, extra: 1 }\nmode: sometimes\n');
  assert.equal(bad.spec, undefined);
  assert.ok(bad.problems.some((p) => p.startsWith('mode')), bad.problems.join('\n'));
  assert.ok(bad.problems.some((p) => p.startsWith('run')), bad.problems.join('\n'));
});

test('битый YAML — одна проблема «не читается», а не исключение', () => {
  const r = parseRoutineYaml('title: [');
  assert.equal(r.spec, undefined);
  assert.match(r.problems[0], /YAML не читается/);
});

test('источник: every и имена ключей проверяются', () => {
  assert.deepEqual(parseSourceYaml('title: Свой\nkind: command\nconfig: { command: "echo []" }\nevery: 5m\nsecrets: [API_KEY]\n').problems, []);
  const bad = parseSourceYaml('title: Свой\nkind: command\nevery: часто\nsecrets: [api-key]\n');
  assert.ok(bad.problems.some((p) => p.startsWith('every')));
  assert.ok(bad.problems.some((p) => p.startsWith('secrets')));
});

test('проблемы правила: нет flow, нет блока из pause_before, источник не подключён, плохой cron', () => {
  assert.deepEqual(routineProblems(routine(), ctx), []);
  assert.deepEqual(routineProblems(routine({ run: { flow: 'nope' } }), ctx), ['flow nope не найден']);
  assert.deepEqual(routineProblems(routine({ run: { flow: 'demo', pause_before: ['fix', 'deploy'] } }), ctx), ['во flow demo нет блока «deploy» из pause_before']);
  assert.deepEqual(routineProblems(routine({ when: { source: 'tg' } }), ctx), ['источник tg не подключён']);
  assert.match(routineProblems(routine({ when: { schedule: '0 9 * *' } }), ctx)[0], /расписание: cron — 5 полей/);
  assert.match(routineProblems(routine({ reply: { to: 'tg' } }), ctx)[0], /ответ: источник tg не подключён/);
});

test('блок task: рутина без run только заводит дела; без run и task, from: flow без run — ошибка схемы', () => {
  const only = parseRoutineYaml('title: Ревью\nwhen: { source: gitlab }\nmode: auto\ntask: { kind: Ревью, same: thing, on_repeat: plan, close: thing }\n');
  assert.deepEqual(only.problems, []);
  assert.equal(only.spec?.run, undefined);
  assert.equal(only.spec?.task?.kind, 'Ревью');
  assert.deepEqual(routineProblems(only.spec!, { ...ctx, sourceExists: () => true }), []);
  assert.deepEqual(parseRoutineYaml('title: X\nwhen: { source: s }\nmode: auto\n').problems, ['run: нужен run.flow или блок task']);
  assert.deepEqual(parseRoutineYaml('title: X\nwhen: { source: s }\nmode: auto\ntask: { kind: Ревью, from: flow }\n').problems, ['run: task.from: flow — дела заводит flow, нужен run.flow']);
  assert.match(parseRoutineYaml('title: X\nwhen: { source: s }\nmode: auto\ntask: { kind: Ревью, same: mr }\n').problems[0], /^task\.same/);
  assert.match(parseRoutineYaml('title: X\nwhen: { source: s }\nmode: auto\ntask: { kind: " " }\n').problems[0], /^task\.kind/);
  // без запуска отвечать нечему — проблема правила, а не тихий пропуск
  assert.deepEqual(routineProblems({ ...only.spec!, reply: { to: 'source' } }, { ...ctx, sourceExists: () => true }), ['ответ: рутина без flow только заводит дела — отвечать в источник нечему']);
  // расписание без flow дел не заводит
  assert.match(routineProblems({ ...only.spec!, when: { schedule: '0 9 * * *' } }, ctx)[0], /^расписание без flow/);
});

test('слаг: кириллица транслитом, занятый — с номером, пустой — запасной', () => {
  assert.equal(slugify('Баги из Slack!'), 'bagi-iz-slack');
  assert.equal(slugify('  '), 'routine');
  const taken = new Set(['bagi', 'bagi-2']);
  assert.equal(freeSlug('Баги', (s) => taken.has(s)), 'bagi-3');
});

test('интервал: 30s, 5m, 1h; мусор — undefined', () => {
  assert.equal(parseEvery('30s'), 30_000);
  assert.equal(parseEvery('5m'), 300_000);
  assert.equal(parseEvery('1h'), 3_600_000);
  assert.equal(parseEvery('5 минут'), undefined);
  assert.equal(parseEvery(undefined), undefined);
});

test('cron: ошибки по полям, списки, диапазоны, шаги и имена', () => {
  assert.match(parseCron('* * *') as string, /5 полей/);
  assert.match(parseCron('61 * * * *') as string, /минута/);
  assert.match(parseCron('* * * * funday') as string, /день недели/);
  const c = parseCron('*/15 9-18 * * mon-fri') as Cron;
  assert.deepEqual([...c.minute], [0, 15, 30, 45]);
  assert.deepEqual([...c.dow].sort(), [1, 2, 3, 4, 5]);
  // 7 — тоже воскресенье
  assert.ok((parseCron('0 0 * * 7') as Cron).dow.has(0));
});

test('cron: день месяца и день недели вместе — совпадение по любому', () => {
  const c = parseCron('0 12 1 * 1') as Cron;
  assert.ok(cronMatches(c, new Date(2026, 10, 1, 12, 0))); // 1 ноября — воскресенье, но 1-е число
  assert.ok(cronMatches(c, new Date(2026, 10, 2, 12, 0))); // понедельник
  assert.ok(!cronMatches(c, new Date(2026, 10, 3, 12, 0)));
});

test('nextAt и dueSlots: ближайшая минута и все минуты в промежутке', () => {
  const c = parseCron('30 9 * * *') as Cron;
  assert.equal(nextAt(c, new Date(2026, 10, 17, 9, 30))?.getTime(), new Date(2026, 10, 18, 9, 30).getTime());
  assert.equal(nextAt(c, new Date(2026, 10, 17, 8, 0))?.getTime(), new Date(2026, 10, 17, 9, 30).getTime());
  const slots = dueSlots(c, new Date(2026, 10, 15, 0, 0), new Date(2026, 10, 17, 9, 30));
  assert.equal(slots.length, 3);
  // max — самые поздние
  assert.equal(dueSlots(c, new Date(2026, 10, 15, 0, 0), new Date(2026, 10, 17, 9, 30), 1)[0].getDate(), 17);
  assert.equal(nextAt(parseCron('0 0 30 2 *') as Cron, new Date(2026, 0, 1)), undefined);
});

test('событие расписания: id — рутина и ISO минуты', () => {
  const e = scheduleEvent('daily', 'Сводка', new Date('2026-11-17T09:30:42.123Z'));
  assert.equal(e.id, 'daily@2026-11-17T09:30:00.000Z');
  assert.equal(e.source, 'schedule');
});

const ev: RoutineEvent = {
  source: 'slack',
  id: '1',
  at: '2026-11-17T10:00:00Z',
  title: 'Упал деплой',
  text: 'Ошибка 500 на оплате',
  author: 'Ivan',
  fields: { channel: 'Bugs', thread: false, duration: 42, labels: ['p1', 'backend'], user: { name: 'ivan' } },
};

test('условия: равно без регистра, массив значений — любое из, поле-массив — любой элемент', () => {
  assert.ok(matchRule({ channel: 'bugs' }, ev).ok);
  assert.ok(matchRule({ channel: ['alerts', 'BUGS'] }, ev).ok);
  assert.ok(matchRule({ labels: 'P1' }, ev).ok);
  assert.ok(matchRule({ 'user.name': 'IVAN', author: 'ivan' }, ev).ok);
  assert.ok(matchRule({ thread: false }, ev).ok);
  assert.ok(matchRule({ 'labels.1': 'backend' }, ev).ok);
  assert.ok(matchRule(undefined, ev).ok);
});

test('условия: ~ содержит, ! не равно, > < числа; reason — какое условие не прошло', () => {
  assert.ok(matchRule({ 'text~': ['500', 'timeout'] }, ev).ok);
  assert.ok(matchRule({ 'channel!': 'random' }, ev).ok);
  assert.ok(matchRule({ 'duration>': 30, 'duration<': 60 }, ev).ok);
  assert.ok(matchRule({ 'missing!': 'x' }, ev).ok);
  const r = matchRule({ channel: 'bugs', 'duration>': 100 }, ev);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^duration: «42» не больше «100»/);
  assert.match(matchOne(ev, 'nope', 'x').reason!, /нет поля/);
  assert.equal(matchOne(ev, 'labels!', 'p1').ok, false);
});

test('clipContext: короткий как есть, длинный — по границе строки с многоточием', async () => {
  const { clipContext } = await import('./engine.js');
  assert.equal(clipContext('  коротко  '), 'коротко');
  const text = `${'а'.repeat(1200)}\n${'б'.repeat(600)}`;
  assert.equal(clipContext(text), `${'а'.repeat(1200)}\n…`);
  assert.equal(clipContext('в'.repeat(2000)).length, 1502);
});
