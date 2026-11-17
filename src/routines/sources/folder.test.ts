import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { folderKind } from './folder.js';
import { makeCtx } from './testkit.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ag-folder-'));
}

test('папка: новые файлы — события, text — первые 4 КБ текстового файла', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), 'Привет\nмир');
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(10_000));
    fs.writeFileSync(path.join(dir, 'pic.bin'), Buffer.from([1, 2, 0, 3]));
    fs.writeFileSync(path.join(dir, '.hidden'), 'скрытый');
    fs.mkdirSync(path.join(dir, 'sub'));
    const events = await folderKind.poll!(makeCtx({ slug: 'dl', config: { path: dir } }));
    assert.deepEqual(events.map((e) => e.title).sort(), ['a.md', 'big.txt', 'pic.bin']);
    const by = Object.fromEntries(events.map((e) => [e.title, e]));
    assert.equal(by['a.md'].text, 'Привет\nмир');
    assert.equal(by['big.txt'].text.length, 4096);
    assert.equal(by['pic.bin'].text, '');
    assert.equal(by['a.md'].fields.ext, 'md');
    assert.equal(by['big.txt'].fields.size, 10_000);
    assert.match(by['a.md'].id, /^a\.md@\d+$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('папка: фильтр по расширениям и ссылки не разыменовываются', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.md'), 'a');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    fs.symlinkSync('/etc/hosts', path.join(dir, 'link.md'));
    const events = await folderKind.poll!(makeCtx({ config: { path: dir, ext: '.md, pdf' } }));
    assert.deepEqual(events.map((e) => e.title), ['a.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('папка: повторный опрос того же файла даёт тот же id', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'r.txt');
    fs.writeFileSync(f, 'v1');
    const ctx = makeCtx({ config: { path: dir } });
    const [a] = await folderKind.poll!(ctx);
    const [b] = await folderKind.poll!(ctx);
    assert.equal(a.id, b.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('папка: нет настройки или нет папки — понятная ошибка', async () => {
  await assert.rejects(() => folderKind.poll!(makeCtx({ config: {} })), /Не указана папка/);
  await assert.rejects(() => folderKind.poll!(makeCtx({ config: { path: '/nonexistent-ag-dir' } })), /не существует/);
});
