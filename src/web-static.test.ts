import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyRedirect, resolveWebFile, type WebAnswer } from './web-static.js';

/** Сборка как у Vite: index.html, assets/ с хешами, вложенная папка и файл рядом с dist/web, до которого не должно быть пути. */
function build(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-web-'));
  const dir = path.join(root, 'web');
  fs.mkdirSync(path.join(dir, 'assets', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(dir, 'assets', 'index-AbC123.js'), 'export {}');
  fs.writeFileSync(path.join(dir, 'assets', 'index-AbC123.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'assets', 'fonts', 'mono-x1.woff2'), '');
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'nope');
  return dir;
}

const fileOf = (a: WebAnswer) => (a.kind === 'file' ? path.basename(a.file) : a.kind);

test('index.html на корне / и на маршрутах роутера, без кэша', () => {
  const dir = build();
  for (const p of ['/', '/flow/my-flow', '/run/20261024-abc', '/tags/', '/tags/feature-x']) {
    const a = resolveWebFile(dir, p);
    assert.equal(fileOf(a), 'index.html', p);
    assert.ok(a.kind === 'file' && a.type.startsWith('text/html') && a.cache === 'no-cache', p);
  }
});

test('файлы из assets/ и вложенных папок — с immutable, остальные — без кэша', () => {
  const dir = build();
  const js = resolveWebFile(dir, '/assets/index-AbC123.js');
  assert.ok(js.kind === 'file' && js.type.startsWith('text/javascript') && js.cache.includes('immutable'));
  const css = resolveWebFile(dir, '/assets/index-AbC123.css');
  assert.ok(css.kind === 'file' && css.type.startsWith('text/css'));
  const font = resolveWebFile(dir, '/assets/fonts/mono-x1.woff2');
  assert.ok(font.kind === 'file' && font.type === 'font/woff2' && font.cache.includes('immutable'));
  const icon = resolveWebFile(dir, '/favicon.svg');
  assert.ok(icon.kind === 'file' && icon.type === 'image/svg+xml' && icon.cache === 'no-cache');
});

test('нет файла сборки — 404, а не index.html', () => {
  const dir = build();
  assert.equal(resolveWebFile(dir, '/assets/index-old.js').kind, 'not-found');
  assert.equal(resolveWebFile(dir, '/robots.txt').kind, 'not-found');
});

test('/api/… — не маршрут UI: 404, а не index.html', () => {
  const dir = build();
  for (const p of ['/api', '/api/', '/api/nope', '/api%2Fnope']) assert.equal(resolveWebFile(dir, p).kind, 'not-found', p);
  // похожие имена — обычные маршруты роутера
  assert.equal(fileOf(resolveWebFile(dir, '/apis')), 'index.html');
});

test('старые адреса /next/… — на те же пути без префикса, с query', () => {
  assert.equal(legacyRedirect('/next'), '/');
  assert.equal(legacyRedirect('/next/'), '/');
  assert.equal(legacyRedirect('/next', '?a=1'), '/?a=1');
  assert.equal(legacyRedirect('/next/run/20261024-abc'), '/run/20261024-abc');
  assert.equal(legacyRedirect('/next/flow/my-flow', '?x=1'), '/flow/my-flow?x=1');
  assert.equal(legacyRedirect('/next/tags/feature-x'), '/tags/feature-x');
  assert.equal(legacyRedirect('/next/assets/index-AbC123.js'), '/assets/index-AbC123.js');
  // не уводит на другой хост: //evil.example — адрес без схемы
  assert.equal(legacyRedirect('/next//evil.example/x'), '/evil.example/x');
  for (const p of ['/', '/run/x', '/nextflow', '/next-ui/', '/api/next']) assert.equal(legacyRedirect(p), undefined, p);
});

test('выход из папки сборки отклоняется: .., %2e%2e, %2f, обратный слеш, нулевой байт', () => {
  const dir = build();
  for (const p of [
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/assets%2f..%2f..%2fsecret.txt',
    '/..%5csecret.txt',
    '/..',
    '/index.html%00.js',
    '/%E0%A4%A',
  ]) {
    assert.equal(resolveWebFile(dir, p).kind, 'bad-path', p);
  }
});

test('симлинк из сборки наружу не отдаётся', () => {
  const dir = build();
  fs.symlinkSync(path.join(dir, '..', 'secret.txt'), path.join(dir, 'assets', 'leak.txt'));
  assert.equal(resolveWebFile(dir, '/assets/leak.txt').kind, 'bad-path');
});

test('без сборки — not-built', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-web-'));
  assert.equal(resolveWebFile(dir, '/').kind, 'not-built');
  assert.equal(resolveWebFile(path.join(dir, 'missing'), '/assets/a.js').kind, 'not-built');
});

test('index.html — с CSP без inline-скриптов и встраивания во фрейм, файлы сборки — без неё', () => {
  const dir = build();
  for (const p of ['/', '/run/abc']) {
    const a = resolveWebFile(dir, p);
    const csp = a.kind === 'file' ? a.headers?.['Content-Security-Policy'] : undefined;
    assert.ok(csp?.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"), p);
  }
  const js = resolveWebFile(dir, '/assets/index-AbC123.js');
  assert.ok(js.kind === 'file' && js.headers === undefined);
});
