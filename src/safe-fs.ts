// Файлы настроек agentgraph, которые читает и пишет сервер (пространства, теги знаний): этап с Bash или сессия могут
// подложить на место файла FIFO или ссылку. Чтение не ждёт на FIFO (O_NONBLOCK, иначе синхронный read повесил бы весь
// сервер) и берёт только обычный файл (fstat) не больше лимита. Запись — во временный файл с точкой в начале имени
// (не попадёт в списки документов), созданный с O_EXCL (подложенная ссылка на месте временного файла — отказ, а не
// запись по ней), затем rename поверх целевого: ссылка на месте самого файла заменяется, а не открывается.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Файл есть, но читать его нельзя: FIFO, папка, устройство, ссылка (при follow: false) или больше лимита. */
export class UnsafeFileError extends Error {}

/**
 * Текст обычного файла; нет файла — undefined. Не обычный файл или больше max байт — UnsafeFileError. follow: false —
 * ссылка на месте файла тоже ошибка (O_NOFOLLOW); по умолчанию ссылка разрешается, как её разрешит и Claude Code.
 */
export function readRegular(file: string, o: { max: number; follow?: boolean }): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NONBLOCK | (o.follow === false ? NOFOLLOW : 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    if (code === 'ELOOP') throw new UnsafeFileError(`${path.basename(file)} — ссылка`);
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new UnsafeFileError(`${path.basename(file)} — не обычный файл`);
    if (st.size > o.max) throw new UnsafeFileError(`${path.basename(file)} больше ${Math.ceil(o.max / 1024)} КБ`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (!n) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Начало обычного файла (до bytes байт) — для заголовка документа; не обычный файл или нет файла — undefined. */
export function readHead(file: string, bytes: number): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NONBLOCK | NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0)).toString('utf8');
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Запись файла целиком: скрытый временный файл рядом (O_EXCL), затем rename; при ошибке временный файл убирается. */
export function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
