import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readHead, readRegular, UnsafeFileError, writeAtomic } from './safe-fs.js';

function withDir(fn: (dir: string) => void) {
  return () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-safefs-')));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  'readRegular: обычный файл — текст, нет файла — undefined; FIFO не вешает процесс, папка и файл больше лимита — ошибка',
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'a.md'), 'привет');
    assert.equal(readRegular(path.join(dir, 'a.md'), { max: 100 }), 'привет');
    assert.equal(readRegular(path.join(dir, 'нет.md'), { max: 100 }), undefined);
    assert.equal(readRegular(path.join(dir, 'a.md', 'x'), { max: 100 }), undefined);
    assert.throws(() => readRegular(path.join(dir, 'a.md'), { max: 3 }), UnsafeFileError);
    assert.throws(() => readRegular(dir, { max: 100 }), UnsafeFileError);
    // mkfifo: без O_NONBLOCK синхронное чтение ждало бы писателя вечно
    const fifo = path.join(dir, 'STATE.md');
    execFileSync('mkfifo', [fifo]);
    assert.throws(() => readRegular(fifo, { max: 100 }), UnsafeFileError);
    assert.equal(readHead(fifo, 64), undefined);
  }),
);

test(
  'readRegular: ссылка по умолчанию разрешается, с follow: false — ошибка; readHead ссылку не читает',
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'real.md'), '# Заголовок\n');
    fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'link.md'));
    assert.equal(readRegular(path.join(dir, 'link.md'), { max: 100 }), '# Заголовок\n');
    assert.throws(() => readRegular(path.join(dir, 'link.md'), { max: 100, follow: false }), UnsafeFileError);
    assert.equal(readHead(path.join(dir, 'link.md'), 64), undefined);
    assert.equal(readHead(path.join(dir, 'real.md'), 6), '# За');
  }),
);

test(
  'writeAtomic: ссылка на месте файла заменяется, а не пишется насквозь; временный файл скрыт и после записи не остаётся',
  withDir((dir) => {
    const outside = path.join(dir, 'outside.md');
    fs.writeFileSync(outside, 'чужое');
    const docs = path.join(dir, 'docs');
    fs.mkdirSync(docs);
    fs.symlinkSync(outside, path.join(docs, 'x.md'));
    writeAtomic(path.join(docs, 'x.md'), 'новое');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'чужое');
    assert.equal(fs.lstatSync(path.join(docs, 'x.md')).isFile(), true);
    assert.equal(fs.readFileSync(path.join(docs, 'x.md'), 'utf8'), 'новое');
    assert.deepEqual(fs.readdirSync(docs), ['x.md']);
  }),
);
