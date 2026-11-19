// Проверка папки для рутины («Папка проекта», «Рабочее дерево»): есть ли она, папка ли это, репозиторий ли git и на какой
// ветке. Форма «Новой рутины» показывает ответ словами сразу, а не ошибкой при первом запуске: «не git-репозиторий».
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, repoRoot, type Exec } from '../git.js';
import type { DirCheck } from './types.js';

/** «~» и «~/…» — домашняя папка, относительный путь — от папки сервера (как resolveDir запуска). */
export function expandDir(input: string): string {
  const s = input.trim();
  if (s === '~' || s.startsWith('~/')) return path.join(os.homedir(), s.slice(1));
  return path.resolve(s);
}

export async function checkDir(input: string, x: Exec = exec): Promise<DirCheck> {
  const abs = expandDir(input);
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st) return { path: abs, exists: false, isDir: false, git: false };
  if (!st.isDirectory()) return { path: abs, exists: true, isDir: false, git: false };
  const root = await repoRoot(abs, x);
  if (!root) return { path: abs, exists: true, isDir: true, git: false };
  let branch: string | undefined;
  try {
    branch = (await x('git', ['branch', '--show-current'], { cwd: abs, timeoutMs: 10_000 })).trim() || undefined;
  } catch {
    /* ветка — подсказка, не условие */
  }
  return { path: abs, exists: true, isDir: true, git: true, root, ...(branch ? { branch } : {}) };
}
