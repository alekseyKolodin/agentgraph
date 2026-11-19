import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeskItem } from '@server/desk/types';
import { deskByKey, deskEmpty, deskHref, deskLinkText, deskMeta } from './desk';

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

test('дело по ключу вещи: только открытые', () => {
  const m = deskByKey([item({ key: 'mr:h/g/1', column: 'plan' }), item({ key: 'jira:h/A-1', closed: { at: 'x', reason: 'смержен' } })]);
  assert.equal(m.get('mr:h/g/1')?.column, 'plan');
  assert.equal(m.has('jira:h/A-1'), false);
  assert.equal(deskByKey(undefined).size, 0);
});

test('ссылка на дело: ключ в параметре адреса, подпись — колонка', () => {
  assert.equal(deskHref('mr:gitlab.example.com/grp/app/7'), '/?desk=mr%3Agitlab.example.com%2Fgrp%2Fapp%2F7');
  assert.equal(new URLSearchParams(deskHref('branch:/r#feat').slice(2)).get('desk'), 'branch:/r#feat');
  assert.equal(deskLinkText({ column: 'waiting' }), 'Дело · Ждёт других');
});

test('шапка: число открытых дел без готовых и сколько новых', () => {
  const now = new Date('2026-11-18T10:00:00');
  const day = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const items = [item({ column: 'new' }), item({ column: 'new' }), item({ column: 'plan' }), item({ column: 'done' }), item({ column: 'plan', closed: { at: 'x', reason: 'y' } })];
  assert.equal(deskMeta(items, now), `${day} · 3 дела, 2 новых`);
  assert.equal(deskMeta([item({ column: 'work' })], now), `${day} · 1 дело`);
  assert.equal(deskMeta([item({ column: 'new' })], now), `${day} · 1 дело, 1 новое`);
  assert.equal(deskMeta([], now), `${day} · дел нет`);
  assert.equal(deskMeta(undefined, now), day);
});

test('пустая доска — только когда ответили и дел, и рутин нет', () => {
  assert.equal(deskEmpty([], []), true);
  assert.equal(deskEmpty(undefined, []), false);
  assert.equal(deskEmpty([], undefined), false);
  assert.equal(deskEmpty([item({})], []), false);
  assert.equal(deskEmpty([], [{}]), false);
});
