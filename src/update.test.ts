import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, type Exec } from './git.js';
import { applyUpdate, blockedReason, checkUpdate, rebuildPlan, Updater, updateTarget } from './update.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/** origin (bare), checkout app — «установленный» agentgraph — и dev, из которого публикуются новые коммиты. */
function repos() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-update-'));
  const origin = path.join(tmp, 'origin.git');
  const dev = path.join(tmp, 'dev');
  const app = path.join(tmp, 'app');
  sh(tmp, 'init', '--bare', '-q', '-b', 'main', origin);
  sh(tmp, 'init', '-q', '-b', 'main', dev);
  sh(dev, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(dev, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  fs.writeFileSync(path.join(dev, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(dev, 'src'));
  fs.writeFileSync(path.join(dev, 'src', 'a.ts'), 'a');
  sh(dev, 'add', '.');
  sh(dev, 'commit', '-q', '-m', 'init');
  sh(dev, 'push', '-q', 'origin', 'main');
  sh(tmp, 'clone', '-q', origin, app);
  const publish = (file: string, text: string, subject: string) => {
    fs.mkdirSync(path.dirname(path.join(dev, file)), { recursive: true });
    fs.writeFileSync(path.join(dev, file), text);
    sh(dev, 'add', '.');
    sh(dev, 'commit', '-q', '-m', subject);
    sh(dev, 'push', '-q', 'origin', 'main');
  };
  return { tmp, app, publish, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/**
 * git — настоящий, npm — подменён: вызовы копятся, fail роняет указанную команду (первый раз), install переписывает
 * package-lock.json, как npm другой версии.
 */
function fakeNpm(fail?: string) {
  const calls: string[] = [];
  let failed = false;
  const x: Exec = async (cmd, args, opts) => {
    if (cmd !== 'npm') return exec(cmd, args, opts);
    calls.push(args.join(' '));
    if (args[0] === 'install') fs.writeFileSync(path.join(opts!.cwd!, 'package-lock.json'), '{"lockfileVersion":3}');
    if (fail && !failed && args.join(' ').startsWith(fail)) {
      failed = true;
      throw new Error(`npm ${args[0]}: сломалось`);
    }
    return '';
  };
  return { x, calls };
}

test('план пересборки: зависимости, код сервера при сборке dist/, UI', () => {
  assert.deepEqual(rebuildPlan(['README.md'], { dist: true, web: true }), []);
  assert.deepEqual(rebuildPlan(['src/server.ts'], { dist: false, web: true }), []);
  assert.deepEqual(rebuildPlan(['src/server.ts'], { dist: true, web: true }), ['build']);
  assert.deepEqual(rebuildPlan(['web/src/App.tsx'], { dist: true, web: true }), ['web']);
  assert.deepEqual(rebuildPlan(['package-lock.json'], { dist: true, web: true }), ['install', 'build', 'web']);
  // сборки UI нет — собрать в любом случае
  assert.deepEqual(rebuildPlan(['README.md'], { dist: false, web: false }), ['web']);
});

test('не git checkout — обновлений нет, git не вызывается', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-update-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  const calls: string[] = [];
  const x: Exec = async (cmd) => {
    calls.push(cmd);
    return '';
  };
  try {
    assert.match(String(await updateTarget(dir, x)), /не из git checkout/);
    const u = new Updater({ dir, exec: x });
    await u.check();
    assert.deepEqual([u.status().state, calls], ['off', []]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('без upstream следим за origin/<ветка>', async () => {
  const r = repos();
  try {
    sh(r.app, 'branch', '--unset-upstream');
    assert.deepEqual(await updateTarget(r.app), { upstream: 'origin/main', remote: 'origin' });
  } finally {
    r.done();
  }
});

test('новые коммиты на origin: сколько, какие и новая версия', async () => {
  const r = repos();
  try {
    assert.equal((await checkUpdate(r.app) as { behind: number }).behind, 0);
    r.publish('src/b.ts', 'b', 'feat: b');
    r.publish('package.json', JSON.stringify({ version: '0.2.0' }), 'chore(release): v0.2.0');
    const c = await checkUpdate(r.app);
    assert.ok(typeof c !== 'string');
    assert.equal(c.upstream, 'origin/main');
    assert.equal(c.behind, 2);
    assert.equal(c.sha, sh(r.app, 'rev-parse', 'origin/main'));
    assert.equal(c.version, '0.1.0');
    assert.equal(c.latest, '0.2.0');
    assert.deepEqual(c.commits.map((x) => x.subject), ['chore(release): v0.2.0', 'feat: b']);
    assert.equal(blockedReason(c), undefined);
  } finally {
    r.done();
  }
});

test('локальные правки и свои коммиты блокируют автообновление', async () => {
  const r = repos();
  try {
    r.publish('src/b.ts', 'b', 'feat: b');
    fs.writeFileSync(path.join(r.app, 'src', 'a.ts'), 'правка');
    // неотслеживаемые файлы не мешают
    fs.writeFileSync(path.join(r.app, 'notes.txt'), 'x');
    let c = await checkUpdate(r.app);
    assert.ok(typeof c !== 'string');
    assert.match(blockedReason(c)!, /незакоммиченные изменения: src\/a\.ts$/);
    sh(r.app, 'commit', '-q', '-am', 'local');
    c = await checkUpdate(r.app);
    assert.ok(typeof c !== 'string');
    assert.match(blockedReason(c)!, /разошлась с origin\/main: своих коммитов 1/);
  } finally {
    r.done();
  }
});

test('обновление: fast-forward, npm install при смене зависимостей и сборка UI', async () => {
  const r = repos();
  try {
    fs.mkdirSync(path.join(r.app, 'dist', 'web'), { recursive: true });
    fs.writeFileSync(path.join(r.app, 'dist', 'web', 'index.html'), '');
    r.publish('package.json', JSON.stringify({ version: '0.2.0', dependencies: { x: '1' } }), 'feat: deps');
    r.publish('web/a.tsx', 'a', 'feat: ui');
    const { x, calls } = fakeNpm();
    const steps: string[] = [];
    await applyUpdate(r.app, (s) => steps.push(s), x);
    assert.equal(sh(r.app, 'rev-parse', 'HEAD'), sh(r.app, 'rev-parse', 'origin/main'));
    // lock, переписанный npm install, возвращён: следующая проверка не увидит «незакоммиченные изменения»
    assert.equal(sh(r.app, 'status', '--porcelain', '--untracked-files=no'), '');
    // dist/cli.js нет (запуск через tsx из src/) — tsc не нужен
    assert.deepEqual(calls, ['install --no-audit --no-fund', 'run build:web']);
    assert.deepEqual(steps, ['fetch', 'merge', 'install', 'web']);
  } finally {
    r.done();
  }
});

test('сборка упала — checkout откатывается, начатые шаги повторяются для прежней версии', async () => {
  const r = repos();
  try {
    const before = sh(r.app, 'rev-parse', 'HEAD');
    // сборка dist/ есть: build идёт в план и должен пересобраться после отката
    fs.mkdirSync(path.join(r.app, 'dist'));
    fs.writeFileSync(path.join(r.app, 'dist', 'cli.js'), '');
    r.publish('package.json', JSON.stringify({ version: '0.2.0' }), 'feat: deps');
    r.publish('package-lock.json', '{"v":2}', 'feat: lock');
    const { x, calls } = fakeNpm('run build:web');
    await assert.rejects(applyUpdate(r.app, () => {}, x), /^Error: npm run: сломалось$/);
    assert.equal(sh(r.app, 'rev-parse', 'HEAD'), before);
    assert.equal(sh(r.app, 'status', '--porcelain', '--untracked-files=no'), '');
    assert.deepEqual(calls, [
      'install --no-audit --no-fund', 'run build', 'run build:web',
      'install --no-audit --no-fund', 'run build', 'run build:web',
    ]);
  } finally {
    r.done();
  }
});

test('Updater: проверка, обновление и перезапуск', async () => {
  const r = repos();
  try {
    const order: string[] = [];
    let restarted!: () => void;
    const restartedP = new Promise<void>((res) => (restarted = res));
    const u = new Updater({
      dir: r.app,
      exec: fakeNpm().x,
      restart: () => {
        order.push('restart');
        restarted();
      },
      restartDelayMs: 0,
    });
    assert.equal(u.status().state, 'unknown');
    assert.match(u.apply()!, /новой версии нет/);
    await u.check();
    assert.equal(u.status().state, 'current');
    r.publish('src/b.ts', 'b', 'feat: b');
    await u.check();
    assert.equal(u.status().state, 'available');
    assert.equal(u.status().behind, 1);
    assert.equal(u.apply(), undefined);
    assert.equal(u.status().state, 'updating');
    assert.match(u.apply()!, /уже идёт/);
    await restartedP;
    assert.equal(u.status().state, 'restarting');
    assert.deepEqual(order, ['restart']);
    // проверка по таймеру во время перезапуска состояние не сбивает
    await u.check();
    assert.equal(u.status().state, 'restarting');
  } finally {
    r.done();
  }
});

test('Updater без restart: после обновления — перезапуск вручную', async () => {
  const r = repos();
  try {
    const u = new Updater({ dir: r.app, exec: fakeNpm().x });
    r.publish('src/b.ts', 'b', 'feat: b');
    await u.check();
    assert.equal(u.status().canRestart, false);
    assert.equal(u.apply(), undefined);
    for (let i = 0; i < 100 && u.status().state === 'updating'; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(u.status().state, 'updated');
  } finally {
    r.done();
  }
});

test('Updater выключен: состояние off с причиной, проверка ничего не делает', async () => {
  const r = repos();
  try {
    const u = new Updater({ dir: r.app, disabled: 'выключено' });
    await u.check();
    assert.deepEqual([u.status().state, u.status().reason], ['off', 'выключено']);
    assert.equal(u.apply(), 'выключено');
  } finally {
    r.done();
  }
});

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((res) => setTimeout(res, 20));
};

test('Updater: перезапуск отменён (окно осталось открытым) — обновлено, перезапуск вручную', async () => {
  const r = repos();
  try {
    const u = new Updater({ dir: r.app, exec: fakeNpm().x, restart: async () => false, restartDelayMs: 0 });
    r.publish('src/b.ts', 'b', 'feat: b');
    await u.check();
    assert.equal(u.apply(), undefined);
    await until(() => u.status().state === 'updated');
    assert.equal(u.status().state, 'updated');
  } finally {
    r.done();
  }
});

test('Updater: обновление сразу после начатой проверки ждёт её, проверка во время обновления ничего не делает', async () => {
  const r = repos();
  try {
    const fetches: number[] = [];
    let inFetch = 0;
    const npm = fakeNpm();
    const x: Exec = async (cmd, args, opts) => {
      if (args[0] !== 'fetch') return npm.x(cmd, args, opts);
      fetches.push(++inFetch);
      try {
        return await exec(cmd, args, opts);
      } finally {
        inFetch--;
      }
    };
    const u = new Updater({ dir: r.app, exec: x });
    r.publish('src/b.ts', 'b', 'feat: b');
    await u.check();
    const checking = u.check();
    assert.equal(u.apply(), undefined);
    await u.check();
    await checking;
    await until(() => u.status().state !== 'updating');
    assert.equal(u.status().state, 'updated', u.status().error ?? '');
    // fetch ни разу не шёл параллельно с другим
    assert.ok(fetches.every((n) => n === 1), String(fetches));
  } finally {
    r.done();
  }
});
