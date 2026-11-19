import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock } from '../format';
import { usageLine, versionMeta, versionsNote } from './history';

const now = new Date('2026-11-19T18:00:00Z');

test('строка использования: за 30 дней и последний; не запускался; давно не запускался', () => {
  const last = { id: 'r', startedAt: '2026-11-18T10:00:00Z', status: 'done', title: 'Ревью' };
  const u = usageLine({ total: 7, runs30d: 5, last }, now);
  assert.deepEqual([u.month, u.last], ['5 запусков за 30 дней', `последний ${clock(last.startedAt, now)}`]);
  assert.match(u.title, /Всего запусков: 7\n«Ревью» · готово/);
  assert.equal(usageLine({ total: 1, runs30d: 1, last }, now).month, '1 запуск за 30 дней');
  assert.equal(usageLine({ total: 3, runs30d: 0, last }, now).month, 'за 30 дней не запускался');
  assert.deepEqual([usageLine({ total: 0, runs30d: 0 }, now).month, usageLine({ total: 0, runs30d: 0 }, now).last], ['ещё не запускался', '']);
});

test('подпись версии: запуски и диапазон дней; один день — одна дата; один запуск — его время', () => {
  const v = { runs: 3, firstAt: '2026-11-10T10:00:00Z', lastAt: '2026-11-18T10:00:00Z' };
  const d = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  assert.equal(versionMeta(v, now), `3 запуска · ${d(v.firstAt)} – ${d(v.lastAt)}`);
  assert.equal(versionMeta({ ...v, firstAt: '2026-11-18T09:00:00Z' }, now), `3 запуска · ${d(v.lastAt)}`);
  assert.equal(versionMeta({ ...v, runs: 1, firstAt: v.lastAt }, now), `1 запуск · ${clock(v.lastAt, now)}`);
  // другой год — с годом
  assert.match(versionMeta({ ...v, firstAt: '2025-12-30T10:00:00Z' }, now), /2025 – /);
});

test('заметка под версиями: текущая не запускалась, запуски без снимка; иначе пусто', () => {
  assert.equal(versionsNote({ versions: [], noSnapshot: 0, total: 2 }), '');
  assert.equal(
    versionsNote({ versions: [], noSnapshot: 2, currentUnrun: true, total: 2 }),
    'Файл flow поправили после последнего запуска: текущая версия ещё не запускалась. Без снимка flow.yaml — 2 запуска: их версия неизвестна.',
  );
});
