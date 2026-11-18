// Файлы рутин: правила и источники YAML, ключи 0600, состояние (seen, журнал, события, last-check) во временной папке.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARRIVALS_MAX, LOG_TRIM_BYTES, LogReadError, RoutineStore, SEEN_MAX } from './store.js';
import type { LogEntry, RoutineEvent } from './types.js';

function tmp(): { store: RoutineStore; root: string; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rstore-'));
  return { store: new RoutineStore(root), root, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const ev = (id: string): RoutineEvent => ({ source: 'src', id, at: '2026-11-17T10:00:00Z', title: `t${id}`, text: '', fields: {} });

test('правило: запись spec и YAML как есть, список с битым файлом и problems', () => {
  const { store, root, done } = tmp();
  try {
    store.writeRoutine('bugs', { title: 'Баги', when: { source: 'slack' }, run: { flow: 'demo' }, mode: 'auto' });
    store.writeRoutine('raw', '# комментарий\ntitle: Руками\nwhen: { schedule: "0 9 * * *" }\nrun: { flow: demo }\nmode: auto\n');
    fs.writeFileSync(path.join(root, 'routines', 'broken.yaml'), 'title: [');
    fs.writeFileSync(path.join(root, 'routines', 'Not A Slug.yaml'), 'title: x');
    const list = store.routines();
    assert.deepEqual(list.map((r) => r.slug), ['broken', 'bugs', 'raw']);
    assert.equal(list[1].spec?.title, 'Баги');
    assert.match(list[2].yaml, /^# комментарий/);
    assert.equal(list[0].spec, undefined);
    assert.ok(list[0].problems.length);
    // недопустимый слаг (ссылка из битого правила) — «нет файла», а не исключение; запись по нему — ошибка
    assert.equal(store.routine('../x'), undefined);
    assert.equal(store.source('Slack'), undefined);
    assert.throws(() => store.writeRoutine('../x', 'title: x'), /Недопустимый слаг/);
    assert.equal(store.deleteRoutine('bugs'), true);
    assert.equal(store.routine('bugs'), undefined);
  } finally {
    done();
  }
});

test('ключи: файл 0600, пустое значение удаляет, плохое имя — ошибка', () => {
  const { store, root, done } = tmp();
  try {
    store.setSecrets({ API_KEY: 'k1', OTHER: 'x' });
    assert.equal((fs.statSync(path.join(root, 'secrets.json')).mode & 0o777).toString(8), '600');
    store.setSecrets({ OTHER: '' });
    assert.deepEqual(store.secrets(), { API_KEY: 'k1' });
    assert.equal(store.hasSecret('API_KEY'), true);
    assert.equal(store.hasSecret('OTHER'), false);
    assert.throws(() => store.setSecrets({ 'bad-name': 'v' }), /Недопустимое имя ключа/);
  } finally {
    done();
  }
});

test('seen: без повторов и не больше SEEN_MAX, старые забываются', () => {
  const { store, done } = tmp();
  try {
    store.addSeen('src', ['a', 'b', 'a']);
    assert.deepEqual(store.seen('src'), ['a', 'b']);
    store.addSeen('src', Array.from({ length: SEEN_MAX }, (_, i) => `n${i}`));
    const seen = store.seen('src');
    assert.equal(seen.length, SEEN_MAX);
    assert.equal(store.hasSeen('src', 'a'), false);
    assert.equal(store.hasSeen('src', `n${SEEN_MAX - 1}`), true);
  } finally {
    done();
  }
});

test('журнал: новые сверху, фильтр по исходам, правка строки, битая строка пропускается', () => {
  const { store, root, done } = tmp();
  try {
    const entry = (id: string, outcome: LogEntry['outcome']): LogEntry => ({ id, at: `2026-11-17T10:00:0${id}Z`, routine: 'r', event: { source: 'src', id, title: id, at: '' }, outcome });
    store.appendLog(entry('1', 'filtered'));
    store.appendLog(entry('2', 'started'));
    fs.appendFileSync(path.join(root, 'routines-state', 'log', 'r.jsonl'), 'не json\n');
    store.appendLog(entry('3', 'error'));
    assert.deepEqual(store.log('r').map((e) => e.id), ['3', '2', '1']);
    assert.deepEqual(store.log('r', { outcomes: ['started', 'error'], limit: 1 }).map((e) => e.id), ['3']);
    store.updateLog('r', '2', { costUsd: 0.5 });
    assert.equal(store.log('r').find((e) => e.id === '2')?.costUsd, 0.5);
    assert.equal(store.updateLog('r', 'nope', {}), undefined);
  } finally {
    done();
  }
});

test('события рутины и история источника: повтор id заменяется, лимит держится', () => {
  const { store, done } = tmp();
  try {
    store.addEvent('r', 'started', ev('1'));
    store.addEvent('r', 'started', ev('1'));
    store.addEvent('r', 'rejected', ev('2'));
    assert.equal(store.events('r').started.length, 1);
    assert.deepEqual(store.events('r').rejected.map((e) => e.id), ['2']);
    store.addHistory('src', [ev('a'), ev('b')]);
    store.addHistory('src', [ev('a')]);
    assert.deepEqual(store.history('src').map((e) => e.id), ['b', 'a']);
    store.setLastCheck('src', 'T1');
    store.setLastCheck('schedule-r', 'T2');
    assert.deepEqual(store.lastChecks(), { src: 'T1', 'schedule-r': 'T2' });
    store.setCursor('src', { offset: 5 });
    assert.deepEqual(store.cursor('src'), { offset: 5 });
  } finally {
    done();
  }
});

const line = (id: string, extra: Partial<LogEntry> = {}): LogEntry => ({ id, at: '2026-11-17T10:00:00Z', routine: 'r', event: { source: 'src', id, title: `t${id}`, at: '2026-11-17T10:00:00Z' }, outcome: 'filtered', ...extra });

test('журнал: запись обрезает разросшийся файл, свежие запуски переживают обрезку', () => {
  const { store, root, done } = tmp();
  try {
    const started = new Date(Date.now() - 3600_000).toISOString();
    store.appendLog(line('run', { outcome: 'started', runId: 'r1', startedAt: started }));
    const reason = 'x'.repeat(1500);
    for (let i = 0; i < 1600; i++) store.appendLog(line(`f${i}`, { reason }));
    const file = path.join(root, 'routines-state', 'log', 'r.json');
    assert.ok(fs.statSync(file).size <= LOG_TRIM_BYTES, String(fs.statSync(file).size));
    const all = store.logAll('r');
    assert.ok(all.length > 0 && all.length < 1601);
    // последняя строка на месте, запуск за последние сутки — тоже (по нему per_day)
    assert.equal(all[all.length - 1].id, 'f1599');
    assert.equal(all[0].id, 'run');
  } finally {
    done();
  }
});

test('журнал больше 8 МБ читается хвостом, а не пустым; следующая запись его обрезает', () => {
  const { store, root, done } = tmp();
  try {
    const file = path.join(root, 'routines-state', 'log', 'r.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = JSON.stringify(line('old', { reason: 'y'.repeat(2000) })) + '\n';
    fs.writeFileSync(file, row.repeat(Math.ceil((9 * 1024 * 1024) / row.length)) + JSON.stringify(line('last', { outcome: 'started', startedAt: new Date().toISOString() })) + '\n');
    assert.ok(fs.statSync(file).size > 8 * 1024 * 1024);
    const all = store.logAll('r');
    assert.ok(all.length > 1000, String(all.length));
    assert.equal(all[all.length - 1].id, 'last');
    // битой первой строки хвоста нет: каждая строка — целая запись
    assert.ok(all.every((e) => e.routine === 'r'));
    store.appendLog(line('next'));
    assert.ok(fs.statSync(file).size <= LOG_TRIM_BYTES);
    assert.deepEqual(store.log('r', { limit: 2 }).map((e) => e.id), ['next', 'last']);
  } finally {
    done();
  }
});

test('журнал не обычный файл — LogReadError, а не пустой журнал; нет файла — пусто', () => {
  const { store, root, done } = tmp();
  try {
    assert.deepEqual(store.logAll('r'), []);
    const dir = path.join(root, 'routines-state', 'log');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, 'elsewhere.json'), JSON.stringify(line('a')) + '\n');
    fs.symlinkSync(path.join(root, 'elsewhere.json'), path.join(dir, 'r.json'));
    assert.throws(() => store.logAll('r'), (e) => e instanceof LogReadError && /ссылка/.test(e.message));
  } finally {
    done();
  }
});

test('seen: пришедший снова id освежается и не вытесняется новыми', () => {
  const { store, done } = tmp();
  try {
    store.addSeen('src', ['open']);
    for (let i = 0; i < SEEN_MAX; i += 100) {
      // долго открытая вещь приходит в каждом опросе вместе с новыми
      store.addSeen('src', ['open', ...Array.from({ length: 100 }, (_, j) => `n${i + j}`)]);
    }
    assert.equal(store.seen('src').length, SEEN_MAX);
    assert.ok(store.hasSeen('src', 'open'));
    assert.ok(!store.hasSeen('src', 'n0'));
    // без новостей файл не переписывается: порядок тот же
    const before = store.seen('src');
    store.addSeen('src', before.slice(-3));
    assert.deepEqual(store.seen('src'), before);
  } finally {
    done();
  }
});

test('итоги проверок источника: последняя проверка, приходы и расход по дням с пределами', () => {
  const { store, done } = tmp();
  try {
    assert.deepEqual(store.checks('src'), { arrivals: [], spent: {} });
    const arrivals = Array.from({ length: ARRIVALS_MAX + 10 }, (_, i) => new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString());
    const spent = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`, 0.1]));
    store.setChecks('src', { last: { at: 'x', ok: false, total: 0, fresh: 0, error: 'нет' }, arrivals, spent, alerted: 'error' });
    const c = store.checks('src');
    assert.equal(c.last?.error, 'нет');
    assert.equal(c.alerted, 'error');
    assert.equal(c.arrivals.length, ARRIVALS_MAX);
    assert.equal(c.arrivals[c.arrivals.length - 1], arrivals[arrivals.length - 1]);
    assert.equal(Object.keys(c.spent).length, 60);
    store.deleteChecks('src');
    assert.deepEqual(store.checks('src'), { arrivals: [], spent: {} });
  } finally {
    done();
  }
});
