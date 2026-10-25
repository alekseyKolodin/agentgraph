// Вложения к задаче запуска: файлы из формы (base64 в JSON) кладутся в runs/<id>/attachments/, агент открывает их через Read.
import fs from 'node:fs';
import path from 'node:path';

export type AttachmentInput = { name: string; data: string };
/** Проверенное вложение: безопасное уникальное имя и байты. */
export type Attachment = { name: string; bytes: Buffer };

/** Read открывает картинки и PDF, остальное — текст. .docx Read не разбирает, поэтому его нет. */
export const ATTACHMENT_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'json', 'log', 'yaml', 'yml', 'xml'];
export const ATTACHMENT_FILE_MAX = 10 * 1024 * 1024;
export const ATTACHMENTS_TOTAL_MAX = 25 * 1024 * 1024;
export const ATTACHMENTS_COUNT_MAX = 10;
/** Папка вложений внутри папки запуска. */
export const ATTACHMENTS_DIR = 'attachments';

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// предел ФС — 255 байт, берём с запасом
const NAME_MAX_BYTES = 200;

/** stem + suffix + ext не длиннее NAME_MAX_BYTES: режем stem по кодовым точкам, чтобы не разрезать эмодзи пополам. */
function fitName(stem: string, suffix: string, ext: string): string {
  const cps = [...stem];
  while (cps.length && Buffer.byteLength(cps.join('') + suffix + ext) > NAME_MAX_BYTES) cps.pop();
  return cps.join('') + suffix + ext;
}

// attachments/ уходит в additionalDirectories, а с ним Claude Code грузит CLAUDE.md оттуда как инструкции агента
const RESERVED_NAMES = new Set(['claude.md', 'claude.local.md']);

/** Только имя файла: без каталогов, `..`, разделителей и управляющих символов (имя уходит в промпт), не длиннее 200 байт. Пустое — file.
 *  CLAUDE.md и CLAUDE.local.md (без учёта регистра) получают префикс attached-, чтобы вложение не стало инструкциями агентов. */
export function safeAttachmentName(raw: string): string {
  const base = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, '').split(/[\\/]/).pop() ?? '';
  let name = base.trim().replace(/^\.+/, '');
  if (Buffer.byteLength(name) > NAME_MAX_BYTES) {
    const ext = path.extname(name);
    name = fitName(name.slice(0, name.length - ext.length), '', ext);
  }
  name ||= 'file';
  return RESERVED_NAMES.has(name.toLowerCase()) ? `attached-${name}` : name;
}

/** Дубли имён получают суффикс: a.png, a-2.png, a-3.png. Сравнение без учёта регистра (macOS). Длинное имя укорачивается так, чтобы суффикс уместился. */
export function dedupeNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    const ext = path.extname(n);
    const stem = n.slice(0, n.length - ext.length);
    let out = n;
    for (let i = 2; used.has(out.toLowerCase()); i++) out = fitName(stem, `-${i}`, ext);
    used.add(out.toLowerCase());
    return out;
  });
}

const extOf = (name: string) => path.extname(name).slice(1).toLowerCase();
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} МБ`;

/** Проверяет список из запроса: тип, base64, лимиты. Бросает ошибку с понятным текстом. */
export function validateAttachments(list: unknown): Attachment[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('attachments — список { name, data }');
  if (list.length > ATTACHMENTS_COUNT_MAX) throw new Error(`Вложений больше ${ATTACHMENTS_COUNT_MAX}`);
  let total = 0;
  const out: Attachment[] = [];
  for (const item of list as Partial<AttachmentInput>[]) {
    if (!item || typeof item.name !== 'string' || typeof item.data !== 'string') throw new Error('Вложение — { name, data }: имя и содержимое в base64');
    const name = safeAttachmentName(item.name);
    if (!ATTACHMENT_EXTS.includes(extOf(name))) throw new Error(`${name}: такой тип не поддерживается. Можно: ${ATTACHMENT_EXTS.join(', ')}`);
    // Buffer.from молча выкидывает чужие символы, поэтому формат проверяем сами
    const data = item.data.replace(/\s+/g, '');
    if (data.length % 4 !== 0 || !BASE64_RE.test(data)) throw new Error(`${name}: содержимое не в base64`);
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > ATTACHMENT_FILE_MAX) throw new Error(`${name}: файл больше ${mb(ATTACHMENT_FILE_MAX)}`);
    total += bytes.length;
    if (total > ATTACHMENTS_TOTAL_MAX) throw new Error(`Вложения вместе больше ${mb(ATTACHMENTS_TOTAL_MAX)}`);
    out.push({ name, bytes });
  }
  const names = dedupeNames(out.map((a) => a.name));
  return out.map((a, i) => ({ ...a, name: names[i] }));
}

/** Пишет вложения в dir/attachments/. Возвращает пути относительно dir (папки запуска). */
export function saveAttachments(runDir: string, list: Attachment[]): string[] {
  if (!list.length) return [];
  const dir = path.join(runDir, ATTACHMENTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const written = new Set<string>();
  return list.map((a) => {
    const file = path.resolve(dir, safeAttachmentName(a.name));
    if (path.dirname(file) !== path.resolve(dir)) throw new Error(`Недопустимое имя вложения: ${a.name}`);
    // имена уже уникальны после validateAttachments; второй файл с тем же именем молча затёр бы первый
    if (written.has(file.toLowerCase())) throw new Error(`Повторное имя вложения: ${a.name}`);
    written.add(file.toLowerCase());
    fs.writeFileSync(file, a.bytes);
    return path.posix.join(ATTACHMENTS_DIR, path.basename(file));
  });
}

/** Продолжение запуска: копирует attachments/ прошлого запуска в новый. Нет папки — ничего не делает.
 *  Имена проходят safeAttachmentName: в старом запуске мог остаться CLAUDE.md. */
export function copyAttachments(fromRunDir: string, toRunDir: string): string[] {
  const from = path.join(fromRunDir, ATTACHMENTS_DIR);
  if (!fs.statSync(from, { throwIfNoEntry: false })?.isDirectory()) return [];
  const files = fs.readdirSync(from).filter((f) => fs.statSync(path.join(from, f)).isFile()).sort();
  if (!files.length) return [];
  const to = path.join(toRunDir, ATTACHMENTS_DIR);
  fs.mkdirSync(to, { recursive: true });
  const names = dedupeNames(files.map(safeAttachmentName));
  return files.map((f, i) => {
    fs.copyFileSync(path.join(from, f), path.join(to, names[i]));
    return path.posix.join(ATTACHMENTS_DIR, names[i]);
  });
}

/** Content-Type вложения по расширению: картинки и PDF открываются в браузере. undefined — отдавать как текст. */
export function attachmentContentType(file: string): string | undefined {
  const ext = extOf(file);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png' || ext === 'gif' || ext === 'webp') return `image/${ext}`;
  if (ext === 'pdf') return 'application/pdf';
  return undefined;
}
