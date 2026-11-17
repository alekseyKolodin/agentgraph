// Папка на диске: новые файлы (опрос списка). text — первые 4 КБ текстового файла.
import fs from 'node:fs';
import path from 'node:path';
import { BASE_MATCH, type SourceCtx, type SourceKind } from '../kind.js';
import type { RoutineEvent } from '../types.js';
import { cfgList, cfgStr, expandHome } from './util.js';

const MIN_POLL_MS = 5_000;
const MAX_FILES = 100;
const TEXT_BYTES = 4096;

/** Первые байты файла как текст; бинарный (есть нулевой байт) — пусто. */
function readHead(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(TEXT_BYTES);
    const n = fs.readSync(fd, buf, 0, TEXT_BYTES, 0);
    const head = buf.subarray(0, n);
    return head.includes(0) ? '' : head.toString('utf8').replace(/�+$/, '');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function poll(ctx: SourceCtx): Promise<RoutineEvent[]> {
  const raw = cfgStr(ctx.spec, 'path');
  if (!raw) throw new Error('Не указана папка');
  const dir = path.resolve(expandHome(raw));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    throw new Error(`Папка не читается: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? `${dir} не существует` : (err as Error).message}`);
  }
  const exts = cfgList(ctx.spec, 'ext').map((e) => e.replace(/^\./, '').toLowerCase());
  const files: Array<{ name: string; full: string; st: fs.Stats }> = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const ext = path.extname(name).slice(1).toLowerCase();
    if (exts.length && !exts.includes(ext)) continue;
    const full = path.join(dir, name);
    try {
      // lstat: ссылки не разыменовываем — папка может указывать в чужие места
      const st = fs.lstatSync(full);
      if (st.isFile()) files.push({ name, full, st });
    } catch {
      // файл исчез между списком и stat — пропускаем
    }
  }
  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  return files.slice(0, MAX_FILES).map(({ name, full, st }) => ({
    source: ctx.slug,
    // создан = новый; перезапись файла новым содержимым (другой birthtime) — новое событие
    id: `${name}@${Math.round(st.birthtimeMs || st.mtimeMs)}`,
    at: st.mtime.toISOString(),
    title: name,
    text: readHead(full),
    link: `file://${full}`,
    fields: { name, ext: path.extname(name).slice(1).toLowerCase(), size: st.size, path: full, dir },
  }));
}

export const folderKind: SourceKind = {
  kind: 'folder',
  title: 'Папка на диске',
  summary: 'Новые файлы в папке',
  delivery: 'poll',
  minEveryMs: MIN_POLL_MS,
  setup: [
    { key: 'path', label: 'Папка', placeholder: '~/Downloads/reports', hint: 'Смотрим файлы прямо в этой папке, без вложенных.' },
    { key: 'ext', label: 'Расширения', placeholder: 'pdf, md, txt', optional: true, hint: 'Пусто — любые файлы.' },
  ],
  match: [...BASE_MATCH.filter((f) => f.key !== 'author'), { key: 'ext', label: 'Расширение', type: 'text' }, { key: 'size', label: 'Размер, байт', type: 'number' }],
  poll,
  describe: (spec) => `Папка ${cfgStr(spec, 'path') ?? '(не указана)'}: новый файл — событие; в text — первые 4 КБ текстового файла. Только чтение.`,
};
