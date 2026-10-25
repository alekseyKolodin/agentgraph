// Перед `npm run ui`: собирает UI в dist/web (сервер раздаёт его на /), если сборки нет или она старше исходников web/
// и package-lock.json. Так `npm install && npm run ui` работает из архива scripts/share.sh, где dist нет.
// Сборка не удалась — предупреждение и выход 0: API (скилл /agentgraph, CLI) от неё не зависит.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const BUILT = path.join(ROOT, 'dist', 'web', 'index.html');

/** Самое позднее изменение среди файлов папки (рекурсивно). */
function newest(dir: string): number {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    // lstat: битый симлинк (lock-файл редактора .#x.tsx) не роняет скрипт
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.lstatSync(p).mtimeMs);
  }
  return t;
}

const built = fs.statSync(BUILT, { throwIfNoEntry: false })?.mtimeMs ?? 0;
// без package-lock.json (pnpm, yarn) смотрим только на web/
const sources = Math.max(newest(WEB), fs.statSync(path.join(ROOT, 'package-lock.json'), { throwIfNoEntry: false })?.mtimeMs ?? 0);

if (built < sources) {
  console.log(built ? 'UI (web/) изменился — пересобираю dist/web…' : 'Собираю UI (web/) в dist/web…');
  try {
    const { build } = await import('vite');
    await build({ configFile: path.join(WEB, 'vite.config.ts'), logLevel: 'warn' });
  } catch (err) {
    // сервер стартует всё равно: API нужен и без UI (скилл /agentgraph, CLI); на / будет прошлая сборка или подсказка
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(fs.existsSync(BUILT) ? `UI не пересобрался, сервер отдаст прошлую сборку: ${msg}` : `UI не собрался, на / его не будет: ${msg}`);
    console.warn('Собрать вручную: npm run build:web');
  }
}
