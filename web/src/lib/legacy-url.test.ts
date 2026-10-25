import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyHashPath, legacyLocation } from './legacy-url';

test('старые хеши — пути роутера', () => {
  assert.equal(legacyHashPath('#run/2026-10-24_23-38-08-example-pause'), '/run/2026-10-24_23-38-08-example-pause');
  assert.equal(legacyHashPath('#flow/example-ask'), '/flow/example-ask');
  assert.equal(legacyHashPath('#tags'), '/tags');
  assert.equal(legacyHashPath('#tags/feature-x'), '/tags/feature-x');
  assert.equal(legacyHashPath('#context'), '/context');
  assert.equal(legacyHashPath('#draft'), '/');
});

test('не старый адрес — undefined', () => {
  for (const h of ['', '#', '#run/', '#run/a/b', '#flow/../x', '#tags/Bad_Slug', '#home', '#art-1', '#run/x?y']) {
    assert.equal(legacyHashPath(h), undefined, h);
  }
});

test('замена адреса — только на корне и с query', () => {
  assert.equal(legacyLocation({ pathname: '/', search: '', hash: '#run/abc' }), '/run/abc');
  assert.equal(legacyLocation({ pathname: '/', search: '?x=1', hash: '#flow/f' }), '/flow/f?x=1');
  assert.equal(legacyLocation({ pathname: '/', search: '', hash: '' }), undefined);
  // на путях нового UI хеш свой (якорь), его не трогаем
  assert.equal(legacyLocation({ pathname: '/run/abc', search: '', hash: '#run/x' }), undefined);
});
