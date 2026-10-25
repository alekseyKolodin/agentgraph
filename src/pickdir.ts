// Системный диалог выбора папки: браузер полный путь не отдаёт, поэтому открывает его сервер (он слушает только 127.0.0.1 — диалог появится у того же пользователя).
// Только macOS (osascript).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const canPickDir = process.platform === 'darwin';

let open = false;

/** Путь выбранной папки или null, если пользователь нажал «Отменить». Второй диалог поверх открытого — ошибка busy. */
export async function pickDir(o: { prompt?: string; start?: string } = {}): Promise<string | null> {
  if (!canPickDir) throw Object.assign(new Error('Выбор папки через диалог есть только на macOS'), { code: 'unsupported' });
  if (open) throw Object.assign(new Error('Диалог выбора папки уже открыт'), { code: 'busy' });
  const start = existingDir(o.start);
  // текст и путь идут аргументами, а не внутрь скрипта: кавычки в них не ломают AppleScript; activate выводит диалог поверх браузера
  const script = [
    'on run argv',
    'activate',
    start
      ? 'set f to choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))'
      : 'set f to choose folder with prompt (item 1 of argv)',
    'return POSIX path of f',
    'end run',
  ];
  const args = script.flatMap((line) => ['-e', line]).concat(o.prompt || 'Выбери директорию', start ?? '');
  open = true;
  try {
    return await new Promise((resolve, reject) => {
      execFile('osascript', args, (err, stdout, stderr) => {
        if (!err) return resolve(trimSlash(stdout.trim()));
        if (/-128|User canceled/i.test(String(stderr))) return resolve(null);
        reject(new Error(String(stderr).trim() || err.message));
      });
    });
  } finally {
    open = false;
  }
}

function existingDir(p: string | undefined): string | null {
  const s = (p ?? '').trim();
  if (!s) return null;
  const abs = path.resolve(s.startsWith('~') ? path.join(os.homedir(), s.slice(1)) : s);
  try {
    return fs.statSync(abs).isDirectory() ? abs : null;
  } catch {
    return null;
  }
}

// POSIX path папки кончается на «/», а пути в запусках и localStorage — без него
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
