// Текущая ветка папки без вызова git: ближайший .git вверх по пути (папка или файл worktree «gitdir: …») → его HEAD.
// Нужна списку сессий (поиск по ветке): сотня сессий — сотня мелких чтений, без процессов git.
import fs from 'node:fs';
import path from 'node:path';

const readSmall = (file: string): string | undefined => {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
};

/** Ветка, на которой стоит папка: «main», «claude/desk-6»; не git, detached HEAD, нечитаемо — undefined. */
export function headBranch(p: string): string | undefined {
  if (!p || !path.isAbsolute(p)) return undefined;
  for (let dir = path.resolve(p); ; ) {
    const git = path.join(dir, '.git');
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(git, { throwIfNoEntry: false });
    } catch {
      // путь — файл или нет прав: ищем выше
    }
    let gitdir = '';
    if (st?.isDirectory()) gitdir = git;
    else if (st?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(git) ?? '');
      if (!m) return undefined;
      gitdir = path.resolve(dir, m[1]!);
    }
    if (gitdir) {
      const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(readSmall(path.join(gitdir, 'HEAD')) ?? '');
      return m?.[1];
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** headBranch с памятью на один проход по списку: у многих сессий одна папка. */
export function branchCache(): (p: string) => string | undefined {
  const seen = new Map<string, string | undefined>();
  return (p) => {
    if (!seen.has(p)) seen.set(p, headBranch(p));
    return seen.get(p);
  };
}
