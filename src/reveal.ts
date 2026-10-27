// «Показать в Finder» для путей в интерфейсе и выводе агента: браузер файл не откроет, поэтому это делает сервер
// (он слушает только 127.0.0.1 — Finder откроется у того же пользователя). Только macOS.
// Ничего не открывается и не запускается: Finder только выделяет путь в его папке (open -R), и папку тоже. Открыть папку
// окном (open -a Finder) нельзя: для пакета это двойной клик — .app, ссылка на него или папка с битом пакета запустились бы.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const canReveal = process.platform === 'darwin';

/** Хвост «:строка» или «:строка:колонка» у пути из вывода: src/a.ts:42. */
const LINE_SUFFIX = /(?::\d+){1,2}$/;

/**
 * Существующий абсолютный путь или undefined. Относительный путь ищется от баз по порядку (cwd запуска, его доп. папки,
 * папка запуска); «~/» — домашняя папка; хвост с номером строки отбрасывается, если пути с ним нет.
 */
export function resolveReveal(p: string, bases: (string | undefined)[], home = os.homedir()): string | undefined {
  const s = p.trim();
  if (!s || s.includes('\0')) return undefined;
  const dirs = bases.filter((b): b is string => Boolean(b) && path.isAbsolute(b!));
  for (const v of LINE_SUFFIX.test(s) ? [s, s.replace(LINE_SUFFIX, '')] : [s]) {
    const full = v === '~' || v.startsWith('~/') ? path.join(home, v.slice(1)) : v;
    const cands = path.isAbsolute(full) ? [full] : dirs.map((d) => path.resolve(d, full));
    const hit = cands.find((c) => fs.existsSync(c));
    if (hit) return path.normalize(hit);
  }
  return undefined;
}

type Exec = (cmd: string, args: string[], cb: (err: Error | null) => void) => void;

/**
 * Выделить путь в Finder: ссылка — её цель. Путь абсолютный, за флаг его open не примет; open — по полному пути, а не
 * из PATH (npm run ui ставит node_modules/.bin первым). Путь исчез после resolveReveal — ошибка с code ENOENT.
 */
export async function reveal(abs: string, deps: { execFile: Exec } = { execFile }): Promise<void> {
  const real = fs.realpathSync(abs);
  await new Promise<void>((resolve, reject) => deps.execFile('/usr/bin/open', ['-R', real], (err) => (err ? reject(err) : resolve())));
}
