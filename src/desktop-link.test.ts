import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_BUNDLE_ID, linkedElectronDrift, linkPlist, linkStub, linkTargetDir } from './desktop-link.js';

test('Info.plist ярлыка: имя AgentGraph, свой идентификатор и значок; версии нет — бандл не меняется от релиза к релизу', () => {
  const plist = new Map(linkPlist());
  assert.equal(plist.get('CFBundleName'), 'AgentGraph');
  assert.equal(plist.get('CFBundleDisplayName'), 'AgentGraph');
  assert.equal(plist.get('CFBundleIdentifier'), LINK_BUNDLE_ID);
  assert.notEqual(LINK_BUNDLE_ID, 'dev.agentgraph.desktop', 'у упакованного приложения идентификатор другой');
  assert.equal(plist.get('CFBundleIconFile'), 'icon.icns');
  assert.equal(plist.has('CFBundleShortVersionString'), false);
});

test('заглушка грузит main.js checkout\'а по file-ссылке: пробел и кавычка в пути не ломают импорт', () => {
  const stub = linkStub('/Users/me/My "code"/agentgraph');
  const pkg = JSON.parse(stub['package.json']) as Record<string, string>;
  assert.deepEqual(pkg, { name: 'agentgraph', productName: 'AgentGraph', type: 'module', main: 'main.js' });
  const line = stub['main.js'].split('\n').find((l) => l.startsWith('import '))!;
  assert.equal(line, 'import "file:///Users/me/My%20%22code%22/agentgraph/dist/desktop/main.js";');
});

test('ярлык ставится в «Программы», без права записи туда — в ~/Applications', () => {
  assert.equal(linkTargetDir('/Users/me', () => true), '/Applications');
  assert.equal(linkTargetDir('/Users/me', () => false), '/Users/me/Applications');
});

test('Electron в checkout\'е разошёлся с Electron ярлыка — версии для подсказки, иначе ничего', () => {
  assert.deepEqual(linkedElectronDrift('45.0.0', () => ({ version: '46.1.0' })), { running: '45.0.0', installed: '46.1.0' });
  assert.equal(linkedElectronDrift('45.0.0', () => ({ version: '45.0.0' })), undefined);
  assert.equal(linkedElectronDrift('45.0.0', () => ({})), undefined);
  assert.equal(linkedElectronDrift('45.0.0', () => {
    throw new Error('Cannot find module');
  }), undefined);
});
