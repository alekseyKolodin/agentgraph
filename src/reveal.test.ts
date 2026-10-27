import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveReveal, reveal } from './reveal.js';

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-reveal-')));
    try {
      fs.mkdirSync(path.join(dir, 'proj', 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'proj', 'src', 'a.ts'), '');
      fs.mkdirSync(path.join(dir, 'run', 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'run', 'artifacts', 'ideas.md'), '');
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  'показ в Finder: абсолютный путь, относительный от баз по порядку, ~ и хвост с номером строки',
  withDir((dir) => {
    const proj = path.join(dir, 'proj');
    const run = path.join(dir, 'run');
    const a = path.join(proj, 'src', 'a.ts');
    assert.equal(resolveReveal(a, []), a);
    assert.equal(resolveReveal('src/a.ts', [undefined, proj, run]), a);
    assert.equal(resolveReveal('./src/a.ts:42', [proj]), a);
    assert.equal(resolveReveal('src/a.ts:42:7', [proj]), a);
    // нет у первой базы — берётся следующая
    assert.equal(resolveReveal('artifacts/ideas.md', [proj, run]), path.join(run, 'artifacts', 'ideas.md'));
    assert.equal(resolveReveal('~/src/a.ts', [], proj), a);
    assert.equal(resolveReveal('~', [], proj), proj);
  }),
);

test(
  'показ в Finder: несуществующий, пустой, с нулевым байтом и относительный без баз — не найден',
  withDir((dir) => {
    const proj = path.join(dir, 'proj');
    assert.equal(resolveReveal('src/b.ts', [proj]), undefined);
    assert.equal(resolveReveal('  ', [proj]), undefined);
    assert.equal(resolveReveal('src/a.ts\0', [proj]), undefined);
    assert.equal(resolveReveal('src/a.ts', []), undefined);
    // относительная база не считается: от чего её резолвить — неизвестно
    assert.equal(resolveReveal('a.ts', ['src']), undefined);
  }),
);

test(
  'показ в Finder: файл, папка и ссылка на пакет без расширения — только выделить (open -R по цели), ничего не запустить',
  withDir(async (dir) => {
    const calls: [string, string[]][] = [];
    const ok = { execFile: (cmd: string, args: string[], cb: (err: Error | null) => void) => (calls.push([cmd, args]), cb(null)) };
    fs.mkdirSync(path.join(dir, 'Evil.app', 'Contents'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'Evil.app'), path.join(dir, 'proj', 'tools'));
    await reveal(path.join(dir, 'proj', 'src', 'a.ts'), ok);
    await reveal(path.join(dir, 'proj'), ok);
    await reveal(path.join(dir, 'proj', 'tools'), ok);
    assert.deepEqual(calls, [
      ['/usr/bin/open', ['-R', path.join(dir, 'proj', 'src', 'a.ts')]],
      ['/usr/bin/open', ['-R', path.join(dir, 'proj')]],
      ['/usr/bin/open', ['-R', path.join(dir, 'Evil.app')]],
    ]);
    await assert.rejects(reveal(path.join(dir, 'gone'), ok), { code: 'ENOENT' });
    const bad = { execFile: (_c: string, _a: string[], cb: (err: Error | null) => void) => cb(new Error('boom')) };
    await assert.rejects(reveal(path.join(dir, 'proj'), bad), /boom/);
  }),
);
