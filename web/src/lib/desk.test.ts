import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskItem } from '@server/desk/types';
import { deskLeftRows, deskMrRows } from './desk';

const item = (o: Partial<DeskItem>): DeskItem => ({
  id: 'x',
  key: 'own:x',
  kind: 'Своё',
  title: 'x',
  column: 'new',
  why: '',
  signals: [],
  links: { runs: [], sessions: [] },
  createdAt: '2026-11-19T09:00:00.000Z',
  movedAt: '2026-11-19T09:00:00.000Z',
  movedBy: 'me',
  ...o,
});

const mr = (n: number, o: Partial<DeskItem> = {}) =>
  item({ key: `mr:gitlab.example.com/grp/app/${n}`, kind: 'Ревью', title: `MR ${n}`, thing: { type: 'mr', ref: { forge: 'gitlab', host: 'gitlab.example.com', project: 'grp/app', number: n }, url: `https://gitlab.example.com/grp/app/-/merge_requests/${n}` }, ...o });

test('дела о MR на Главной: открытые с моим ходом, без уже показанных «Подключениями»', () => {
  const rows = deskMrRows(
    [mr(1, { why: 'автор ответил' }), mr(2, { column: 'waiting' }), mr(3, { column: 'done', closed: { at: 'x', reason: 'смержен' } }), mr(4), item({ key: 'own:a' })],
    ['https://gitlab.example.com/grp/app/-/merge_requests/4/'],
  );
  assert.deepEqual(rows.map((r) => [r.key, r.sign, r.num, r.why]), [['mr:gitlab.example.com/grp/app/1', '!', '1', 'автор ответил']]);
});

test('дела о PR GitHub — со знаком #', () => {
  const pr = item({ key: 'mr:github.com/o/r/5', thing: { type: 'mr', ref: { forge: 'github', number: 5 } } });
  assert.deepEqual(deskMrRows([pr], []).map((r) => [r.sign, r.num, r.url]), [['#', '5', undefined]]);
});

test('«Не доделано»: сессии, ветки и «Забытое»; сессии из разбора не дублируются', () => {
  const rows = deskLeftRows(
    [
      item({ key: 'session:s1', kind: 'Сессия', thing: { type: 'session', ref: { id: 's1' } } }),
      item({ key: 'session:s2', kind: 'Сессия', thing: { type: 'session', ref: { id: 's2' } }, why: 'кончилась вопросом' }),
      item({ key: 'branch:/r#feat', kind: 'Ветка', thing: { type: 'branch', ref: {} }, column: 'plan' }),
      item({ key: 'own:f', kind: 'Забытое' }),
      item({ key: 'own:g', kind: 'Своё' }),
      item({ key: 'branch:/r#old', thing: { type: 'branch', ref: {} }, column: 'waiting' }),
    ],
    ['s1'],
  );
  assert.deepEqual(rows.map((r) => [r.key, r.session]), [['session:s2', 's2'], ['branch:/r#feat', undefined], ['own:f', undefined]]);
});

test('дел нет — строк нет', () => {
  assert.deepEqual(deskMrRows(undefined, []), []);
  assert.deepEqual(deskLeftRows([], []), []);
});

test('ссылка дела — только http(s)', () => {
  const x = item({ key: 'mr:h/g/a/9', thing: { type: 'mr', ref: { number: 9 }, url: 'javascript:alert(1)' }, signals: [{ source: 's', at: 'x', link: 'https://h/g/a/-/merge_requests/9' }] });
  assert.equal(deskMrRows([x], [])[0]?.url, 'https://h/g/a/-/merge_requests/9');
});

test('PR GitHub без forge в вещи (desk_put, CLI) — знак # по хосту ключа', () => {
  const pr = item({ key: 'mr:github.com/o/r/8', thing: { type: 'mr', ref: { host: 'github.com', project: 'o/r', number: 8 } } });
  const mrGl = item({ key: 'mr:gitlab.example.com/g/a/9', thing: { type: 'mr', ref: { host: 'gitlab.example.com', project: 'g/a', number: 9 } } });
  assert.deepEqual(deskMrRows([pr, mrGl], []).map((r) => r.sign), ['#', '!']);
});
