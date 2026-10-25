import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import { requestProblem } from './server-guard.js';

const status = (method: string, headers: IncomingHttpHeaders) => requestProblem(method, headers)?.status;
const json = { 'content-type': 'application/json', 'content-length': '2' };

test('Host: только 127.0.0.1, localhost и [::1], порт любой', () => {
  for (const host of ['127.0.0.1:4747', '127.0.0.1:9000', '127.0.0.1', 'localhost:4748', 'LOCALHOST:4747', '[::1]:4747', '[::1]']) {
    assert.equal(status('GET', { host }), undefined, host);
  }
  for (const host of [
    undefined,
    '',
    'evil.com',
    'evil.com:4747',
    'localhost.evil.com:4747',
    '127.0.0.1.nip.io:4747',
    'evil-localhost:4747',
    'localhost@evil.com',
    '127.0.0.1/x',
    '0.0.0.0:4747',
    '192.168.1.5:4747',
    '[::2]:4747',
  ]) {
    assert.equal(status('GET', { host }), 421, String(host));
  }
});

test('Host проверяется у любого метода, включая статику и SSE', () => {
  assert.equal(status('GET', { host: 'attacker.example:4747' }), 421);
  assert.equal(status('HEAD', { host: 'attacker.example:4747' }), 421);
  assert.equal(status('POST', { host: 'attacker.example:4747', origin: 'http://attacker.example:4747', ...json }), 421);
});

test('Origin у запросов кроме GET и HEAD: нет или тот же адрес сервера', () => {
  const host = '127.0.0.1:4747';
  // curl и хелпер скилла Origin не шлют
  assert.equal(status('POST', { host }), undefined);
  assert.equal(status('POST', { host, origin: 'http://127.0.0.1:4747', ...json }), undefined);
  assert.equal(status('PUT', { host: 'localhost:4747', origin: 'http://localhost:4747', ...json }), undefined);
  assert.equal(status('DELETE', { host: '[::1]:4747', origin: 'http://[::1]:4747' }), undefined);
  // порт по умолчанию: Host без порта и Origin без порта — один адрес
  assert.equal(status('POST', { host: '127.0.0.1', origin: 'http://127.0.0.1' }), undefined);

  for (const origin of [
    'null',
    'http://evil.com',
    'http://127.0.0.1:4748',
    'http://localhost:4747',
    'https://127.0.0.1:4747',
    'http://127.0.0.1.nip.io:4747',
    'file://',
    'garbage',
  ]) {
    assert.equal(status('POST', { host, origin, ...json }), 403, origin);
    assert.equal(status('DELETE', { host, origin }), 403, origin);
  }
  // GET с чужим Origin (fetch с чужой страницы) Origin не проверяет: чтение отсекает Host, а браузер не отдаст ответ без CORS
  assert.equal(status('GET', { host, origin: 'http://evil.com' }), undefined);
});

test('Тело запроса — только application/json', () => {
  const host = '127.0.0.1:4747';
  assert.equal(status('POST', { host, ...json }), undefined);
  assert.equal(status('POST', { host, 'content-type': 'Application/JSON; charset=utf-8', 'content-length': '10' }), undefined);
  assert.equal(status('POST', { host, 'content-type': 'application/json', 'transfer-encoding': 'chunked' }), undefined);
  // POST без тела (pause, resume, abort) Content-Type не шлёт
  assert.equal(status('POST', { host, 'content-length': '0' }), undefined);
  assert.equal(status('POST', { host }), undefined);

  for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'text/json']) {
    assert.equal(status('POST', { host, 'content-type': type, 'content-length': '5' }), 415, String(type));
    assert.equal(status('PUT', { host, 'content-type': type, 'transfer-encoding': 'chunked' }), 415, String(type));
  }
});
