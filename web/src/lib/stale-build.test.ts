import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, markStale, shouldAutoReload } from './stale-build';

test('авто-перезагрузка: первая — да, через 5 секунд после прошлой — нет, через 11 — да', () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldAutoReload(0, now), true);
  assert.equal(shouldAutoReload(now - 5_000, now), false);
  assert.equal(shouldAutoReload(now - 11_000, now), true);
});

test('признак «сборка устарела»: нет до markStale(), есть после', () => {
  assert.equal(isStale(), false);
  markStale();
  assert.equal(isStale(), true);
});
