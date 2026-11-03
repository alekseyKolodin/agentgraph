// Теги области знаний (knowledge): фронтенд, бэкенд, QA — заметки, пути и вложения, которые получают этапы блока flow с
// полем knowledge (или всего запуска) и сессии терминала: строка в промпте, полный текст — инструментом knowledge_read.
// Тег — папка ~/.agentgraph/tags/<slug>/: notes.md (заметки пользователя), attachments/ (вложения тега) и tag.json (вид,
// описание, режим inline, пути). Теги задач (kind task) старых версий заменены пространствами (spaces.ts): их папки не
// удаляются и переносятся в пространства, а здесь они только читаются (readTag) и в список тегов не попадают.
// Логика без HTTP: server.ts разбирает тело и отвечает, решения — здесь.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './settings.js';
import type { Tag, TagDetail, TagListItem, TagMeta } from './api-types.js';
import { ATTACHMENTS_COUNT_MAX, ATTACHMENTS_DIR, ATTACHMENTS_TOTAL_MAX, dedupeNames, safeAttachmentName, validateAttachments } from './attachments.js';
import { flowBlocks, type FlowSpec } from './schema.js';
import type { ApiReply } from './artifact-api.js';
import { readRegular, writeAtomic } from './safe-fs.js';

/** Слаг тега: строчные латинские буквы, цифры и дефис; он же имя папки. Тот же регэксп — TAG_SLUG_RE в schema.ts. */
export const TAG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Вид тега: область знаний; task — тег задачи старых версий (старый tag.json без поля — тоже task), его заменило пространство. */
export type { TagKind, TagListItem } from './api-types.js';
/** Заметки тега знаний: по запросу или целиком в промпте, поэтому с лимитом. */
export const TAG_NOTES_MAX = 4000;
/** Описание тега знаний («когда нужен»): одна строка в промпте каждого этапа блока, поэтому короткое. */
export const TAG_DESCRIPTION_MAX = 200;
/** Путей у тега не больше: каждый уходит доп. директорией во все этапы. */
export const TAG_DIRS_MAX = 20;
/** Тегов знаний на один запуск или сессию не больше: строка каждого — в промпте. */
export const RUN_TAGS_MAX = 10;
const PREVIEW_MAX = 200;

// тег — общий с UI: src/api-types.ts
export type { Tag, TagMeta, TagRun } from './api-types.js';

/** Каталог читается при каждом вызове, как configDir(): тесты подменяют AGENTGRAPH_CONFIG_DIR. */
export function tagsDir(): string {
  return path.join(configDir(), 'tags');
}

/** Папка тега по слагу; бросает ошибку на неверном слаге (в том числе ../). */
export function tagDir(slug: string): string {
  if (typeof slug !== 'string' || !TAG_SLUG_RE.test(slug)) {
    throw new Error(`Неверный тег «${String(slug)}»: строчные латинские буквы, цифры и дефис, до 64 знаков, начинается с буквы или цифры`);
  }
  const root = tagsDir();
  const dir = path.resolve(root, slug);
  if (path.dirname(dir) !== path.resolve(root)) throw new Error(`Неверный тег «${slug}»`);
  return dir;
}

const metaFile = (slug: string) => path.join(tagDir(slug), 'tag.json');
const summaryFile = (slug: string) => path.join(tagDir(slug), 'summary.md');
const notesFile = (slug: string) => path.join(tagDir(slug), 'notes.md');
/** Папка вложений тега: этапы читают их отсюда (она среди доп. директорий), промпт и knowledge_read перечисляют их абсолютными путями. */
export const attachDir = (slug: string) => path.join(tagDir(slug), ATTACHMENTS_DIR);

/** Текст тега (заметки, саммари старого тега задачи); FIFO или ссылка на папку вместо файла — пусто, а не зависший сервер. */
const TEXT_READ_MAX = 1024 * 1024;
function readText(file: string): string {
  try {
    return readRegular(file, { max: TEXT_READ_MAX }) ?? '';
  } catch {
    return '';
  }
}

/** Описание тега — одна строка: оно идёт строкой списка в промпт, перевод строки сломал бы формат «по строке на тег». */
const oneLine = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ');

function readMeta(slug: string): TagMeta | undefined {
  // неверный слаг — своя ошибка, а не «не читается»
  const file = metaFile(slug);
  let raw: Partial<TagMeta>;
  try {
    const text = readRegular(file, { max: TEXT_READ_MAX });
    if (text === undefined) return undefined;
    raw = JSON.parse(text) as Partial<TagMeta>;
  } catch (err) {
    throw new Error(`Не читается тег ${slug}: ${(err as Error).message}`);
  }
  const now = new Date(0).toISOString();
  const dirs = Array.isArray(raw.dirs) ? raw.dirs.filter((d): d is string => typeof d === 'string') : [];
  return {
    slug,
    // тег до появления видов — тег задачи
    kind: raw.kind === 'knowledge' ? 'knowledge' : 'task',
    ...(raw.title ? { title: raw.title } : {}),
    ...(raw.title && raw.autoTitle === true ? { autoTitle: true as const } : {}),
    // описание и режим «целиком» — только у тега знаний: у тега задачи заметки и так идут в задачу
    ...(raw.kind === 'knowledge' && typeof raw.description === 'string' && oneLine(raw.description) ? { description: oneLine(raw.description) } : {}),
    ...(raw.kind === 'knowledge' && raw.inline === true ? { inline: true as const } : {}),
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? now,
    ...(dirs.length ? { dirs } : {}),
    runs: Array.isArray(raw.runs) ? raw.runs : [],
  };
}

function writeMeta(meta: TagMeta): void {
  fs.mkdirSync(tagDir(meta.slug), { recursive: true });
  writeAtomic(metaFile(meta.slug), JSON.stringify(meta, null, 2) + '\n');
}

/** Имена файлов вложений тега, по алфавиту. */
function attachmentNames(slug: string): string[] {
  const dir = attachDir(slug);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.') && fs.lstatSync(path.join(dir, f), { throwIfNoEntry: false })?.isFile()).sort();
}

export function readTag(slug: string): Tag | undefined {
  const meta = readMeta(slug);
  if (!meta) return undefined;
  // саммари может ещё не быть: тег заведён, но успешного запуска с ним не было
  return { ...meta, summary: readText(summaryFile(slug)), notes: readText(notesFile(slug)), attachments: attachmentNames(slug) };
}

/** Тег знаний по слагу; нет тега — undefined, тег задачи (перенесён в пространство) — ошибка с подсказкой. */
export function readKnowledgeTag(slug: string): Tag | undefined {
  const tag = readTag(slug);
  if (tag && tag.kind !== 'knowledge') throw new Error(taskTagGone(slug));
  return tag;
}

/** Тег задачи больше не тег: его заменило пространство с тем же слагом. */
export const taskTagGone = (slug: string) =>
  `${slug} — тег задачи, а теги задач заменены пространствами: выбери пространство ${slug} (в поле «Пространство»), а в теги — только теги знаний`;

/** Начало саммари для списка: строки-заголовки («## …», «**Суть**») пропускаются, чтобы было видно суть. */
export function summaryPreview(summary: string): string {
  const lines = summary.split('\n').map((l) => l.trim());
  const body = lines.filter((l) => l && !/^#{1,6}\s/.test(l) && !/^\*\*[^*]+\*\*:?$/.test(l));
  return body.join('\n').slice(0, PREVIEW_MAX);
}

/** Теги знаний, свежие сверху. Папки без tag.json, с неверным именем и теги задач (они теперь пространства) пропускаются. */
export function listTags(): TagListItem[] {
  let names: string[];
  try {
    names = fs.readdirSync(tagsDir());
  } catch {
    return [];
  }
  const out: TagListItem[] = [];
  for (const name of names) {
    if (!TAG_SLUG_RE.test(name)) continue;
    let tag: Tag | undefined;
    try {
      tag = readTag(name);
    } catch {
      continue;
    }
    if (!tag || tag.kind !== 'knowledge') continue;
    out.push({
      slug: tag.slug,
      kind: tag.kind,
      ...(tag.title ? { title: tag.title } : {}),
      updatedAt: tag.updatedAt,
      runs: tag.runs.length,
      // превью — описание («когда нужен»), без описания — начало заметок
      preview: tag.description ?? summaryPreview(tag.notes),
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Заводит тег знаний; существующий не трогает (заголовок дописывается, если его не было). Слаг старого тега задачи
 * занят: его папка осталась, а сам он перенесён в пространство.
 */
export function createTag(slug: string, title?: string): Tag {
  const existing = readMeta(slug);
  const t = title?.trim();
  if (existing) {
    if (existing.kind !== 'knowledge') throw new Error(`${slug} — слаг старого тега задачи (он перенесён в пространство ${slug}): выбери другой слаг`);
    if (t && !existing.title) writeMeta({ ...existing, title: t });
    return readTag(slug)!;
  }
  const now = new Date().toISOString();
  writeMeta({ slug, kind: 'knowledge', ...(t ? { title: t } : {}), createdAt: now, updatedAt: now, runs: [] });
  return readTag(slug)!;
}


/** kind в патче игнорируется. description — «когда нужен» тег, inline — «заметки всегда в промпте целиком». */
export type TagPatch = { title?: unknown; notes?: unknown; dirs?: unknown; kind?: unknown; description?: unknown; inline?: unknown };

/** Пути тега: абсолютные, без повторов, не больше TAG_DIRS_MAX. Существование не проверяется: проверит запуск. */
function checkDirs(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((d) => typeof d !== 'string')) throw new Error('dirs — список путей');
  const dirs = [...new Set((raw as string[]).map((d) => d.trim()).filter(Boolean))];
  if (dirs.length > TAG_DIRS_MAX) throw new Error(`Путей у тега больше ${TAG_DIRS_MAX}`);
  for (const d of dirs) if (!path.isAbsolute(d)) throw new Error(`Путь тега — абсолютный: ${d}`);
  return dirs.map((d) => path.resolve(d));
}

/** Правка тега знаний со страницы «Знания»: переданные поля заменяются целиком, остальные не трогаются. Тег должен быть. */
export function updateTag(slug: string, patch: TagPatch): Tag | undefined {
  const meta = readMeta(slug);
  if (!meta || meta.kind !== 'knowledge') return undefined;
  for (const k of ['title', 'notes', 'description'] as const) {
    if (patch[k] !== undefined && typeof patch[k] !== 'string') throw new Error(`${k} — строка`);
  }
  if (patch.inline !== undefined && typeof patch.inline !== 'boolean') throw new Error('inline — true или false');
  const notes = patch.notes as string | undefined;
  if (notes !== undefined && notes.trim().length > TAG_NOTES_MAX) throw new Error(`Заметки длиннее ${TAG_NOTES_MAX} знаков`);
  const description = patch.description === undefined ? meta.description : oneLine(patch.description as string);
  if (description !== undefined && description.length > TAG_DESCRIPTION_MAX) throw new Error(`Описание длиннее ${TAG_DESCRIPTION_MAX} знаков`);
  const inline = patch.inline === undefined ? meta.inline : patch.inline === true ? (true as const) : undefined;
  const dirs = patch.dirs === undefined ? meta.dirs : checkDirs(patch.dirs);
  const title = patch.title === undefined ? meta.title : (patch.title as string).trim();
  if (notes !== undefined) writeAtomic(notesFile(slug), notes.trim() ? notes.trim() + '\n' : '');
  // переписанный руками заголовок — уже текст пользователя
  const autoTitle = meta.autoTitle && title === meta.title;
  const { title: _t, autoTitle: _a, dirs: _d, description: _desc, inline: _i, ...rest } = meta;
  writeMeta({
    ...rest,
    ...(title ? { title } : {}),
    ...(autoTitle ? { autoTitle: true as const } : {}),
    ...(description ? { description } : {}),
    ...(inline ? { inline } : {}),
    ...(dirs?.length ? { dirs } : {}),
    updatedAt: new Date().toISOString(),
  });
  return readTag(slug)!;
}

/** Удаляет тег знаний. Папку старого тега задачи не трогаем: из неё перенесено пространство. */
export function deleteTag(slug: string): boolean {
  const dir = tagDir(slug);
  if (!fs.existsSync(dir) || readMeta(slug)?.kind === 'task') return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// --- вложения тега: те же типы и лимиты, что у вложений запуска. В папку запуска не копируются: этапы читают их
// из папки тега (она среди доп. директорий), а knowledge_read перечисляет их абсолютными путями

/** Добавляет вложение { name, data(base64) } к тегу; имя — уникальное среди уже лежащих. Возвращает итоговое имя. */
export function addTagAttachment(slug: string, item: unknown): string {
  if (readMeta(slug)?.kind !== 'knowledge') throw new Error(`Тега знаний ${slug} нет`);
  const [a] = validateAttachments([item]);
  const existing = attachmentNames(slug);
  if (existing.length >= ATTACHMENTS_COUNT_MAX) throw new Error(`У тега уже ${ATTACHMENTS_COUNT_MAX} вложений`);
  const dir = attachDir(slug);
  const size = existing.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  if (size + a.bytes.length > ATTACHMENTS_TOTAL_MAX) throw new Error(`Вложения тега вместе больше ${Math.round(ATTACHMENTS_TOTAL_MAX / 1024 / 1024)} МБ`);
  const name = dedupeNames([...existing, a.name]).pop()!;
  fs.mkdirSync(dir, { recursive: true });
  // через временный файл и rename: подложенная ссылка с этим именем заменится, запись по ней не уйдёт
  writeAtomic(path.join(dir, name), a.bytes);
  return name;
}

export function deleteTagAttachment(slug: string, name: string): boolean {
  // папка старого тега задачи не трогается: он перенесён в пространство
  if (readMeta(slug)?.kind !== 'knowledge') throw new Error(`Тега знаний ${slug} нет`);
  const dir = attachDir(slug);
  const file = path.resolve(dir, name);
  if (path.dirname(file) !== path.resolve(dir) || name !== safeAttachmentName(name)) throw new Error(`Неверное имя вложения: ${name}`);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return false;
  fs.rmSync(file);
  return true;
}

// --- блоки тегов задач во вводе старых запусков: <!-- tag:slug -->…<!-- /tag --> вставляли теги задач до пространств

/** Маркеры блока внутри текста обезвреживаются: иначе регэксп снятия блоков (stripTagBlocks) резал бы старый ввод посередине. */
export function defuseMarkers(text: string): string {
  return text.replace(/<!--(\s*\/?\s*tag\b)/gi, '‹!--$1');
}

/** Все блоки тегов задач во вводе старого запуска. */
export const TAG_BLOCKS_RE = /<!-- tag:[a-z0-9-]+ -->[\s\S]*?<!-- \/tag -->\n*/g;

/**
 * Ввод без блоков тегов задач: сама задача — для превью в списке запусков, проверки «задача пуста», промптов
 * вспомогательных сессий и продолжения старого запуска (блок с устаревшим саммари заменяет раздел пространства).
 */
export function stripTagBlocks(input: string): string {
  return input.replace(TAG_BLOCKS_RE, '').trim();
}

/** Ввод без блока одного тега задачи (слаг проверен регэкспом слага: в регэкспе он буквальный); прочие блоки остаются. */
export function stripTagBlock(input: string, slug: string): string {
  if (!TAG_SLUG_RE.test(slug)) return input;
  return input.replace(new RegExp(`<!-- tag:${slug} -->[\\s\\S]*?<!-- \\/tag -->\\n*`, 'g'), '').trim();
}

/**
 * Пути тега, которые есть на диске: папка — как есть, у файла — его папка; плюс папка вложений тега, если они есть.
 * Уходят доп. директориями этапов.
 */
export function existingTagPaths(tag: Pick<Tag, 'slug'> & Partial<Pick<Tag, 'dirs' | 'attachments'>>): { listed: string[]; dirs: string[] } {
  const listed: string[] = [];
  const dirs: string[] = [];
  for (const p of tag.dirs ?? []) {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    listed.push(p);
    dirs.push(st.isDirectory() ? p : path.dirname(p));
  }
  if (tag.attachments?.length) dirs.push(attachDir(tag.slug));
  return { listed, dirs };
}

/** Тег знаний для промпта этапа: описание, заметки, пути и вложения, режим inline; саммари у него нет. */
export type KnowledgeTag = Pick<Tag, 'slug'> & Partial<Pick<Tag, 'title' | 'autoTitle' | 'description' | 'inline' | 'notes' | 'dirs' | 'attachments'>>;

/**
 * Заголовок в шапке блока — вне обёртки source-data, поэтому только заголовок пользователя. Автозаголовок модели не
 * выводится: он пересказ той же задачи, а придуман по недоверенному тексту (тикет пишет кто угодно).
 */
export const titleSuffix = (tag: Pick<KnowledgeTag, 'title' | 'autoTitle'>) => (tag.title && !tag.autoTitle ? ` — ${defuseMarkers(tag.title)}` : '');

/**
 * Полный раздел тега знаний (режим inline, он же ответ GET /api/tags/:slug.input): шапка и пути — от нас, заметки — текст
 * пользователя (инструкции, без обёртки source-data). Пустой тег говорит, где его заполнить.
 */
export function knowledgeSection(tag: KnowledgeTag): string {
  const body = [`Область знаний ${tag.slug}${titleSuffix(tag)}`];
  const notes = tag.notes?.trim();
  if (notes) body.push(defuseMarkers(notes));
  const paths = existingTagPaths(tag).listed;
  if (paths.length) body.push(`Пути (только чтение): ${paths.join(', ')}`);
  if (tag.attachments?.length) {
    body.push('Вложения (открой инструментом Read):', ...tag.attachments.map((f) => `- ${path.join(attachDir(tag.slug), f)}`));
  }
  if (body.length === 1) body.push('Тег пуст: заполни заметки, пути или вложения на странице «Знания».');
  return body.join('\n');
}

/** Имя инструмента, которым этап получает полный текст тега знаний по запросу (src/knowledge-tools.ts). */
export const KNOWLEDGE_READ_TOOL = 'knowledge_read';
/** Шапка списка тегов по запросу в промпте этапа. */
export const KNOWLEDGE_LIST_HEAD = `Области знаний (подробности — инструментом ${KNOWLEDGE_READ_TOOL} со слагом; открывай только когда нужно):`;
/** Первая строка заметок в строке списка — не длиннее. */
export const KNOWLEDGE_LINE_MAX = 120;

/** Пустой ли тег знаний: ни заметок, ни существующих путей, ни вложений. */
export const knowledgeEmpty = (tag: KnowledgeTag): boolean =>
  !tag.notes?.trim() && !existingTagPaths(tag).listed.length && !tag.attachments?.length;

/**
 * Строка списка тегов по запросу: «- slug — Заголовок: описание (знаков заметок: N, вложений: M, путей: K)». Без описания —
 * первая непустая строка заметок до KNOWLEDGE_LINE_MAX знаков, без заметок — «описания нет»; хвост в скобках — только
 * ненулевое. Пустой тег вместо хвоста получает пометку, где его заполнить.
 */
export function knowledgeLine(tag: KnowledgeTag): string {
  const notes = tag.notes?.trim() ?? '';
  const firstLine = notes.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const brief = tag.description?.trim()
    || ([...firstLine].length > KNOWLEDGE_LINE_MAX ? [...firstLine].slice(0, KNOWLEDGE_LINE_MAX - 1).join('') + '…' : firstLine)
    || 'описания нет';
  const paths = existingTagPaths(tag).listed.length;
  const stats = [
    ...(notes ? [`знаков заметок: ${notes.length}`] : []),
    ...(tag.attachments?.length ? [`вложений: ${tag.attachments.length}`] : []),
    ...(paths ? [`путей: ${paths}`] : []),
  ];
  const tail = knowledgeEmpty(tag) ? ' (тег пуст: заполни на странице «Знания»)' : stats.length ? ` (${stats.join(', ')})` : '';
  return `- ${tag.slug}${titleSuffix(tag)}: ${defuseMarkers(brief)}${tail}`;
}

/**
 * Единственный составитель раздела знаний для конца промпта этапа. Теги по запросу — одним списком под шапкой
 * KNOWLEDGE_LIST_HEAD: по строке на тег, полный текст этап получит инструментом knowledge_read. Теги с inline — полным
 * разделом knowledgeSection каждый, после списка. Без тегов — пустая строка.
 */
export function knowledgeBlock(tags: KnowledgeTag[]): string {
  const onDemand = tags.filter((t) => !t.inline);
  const inline = tags.filter((t) => t.inline);
  const parts: string[] = [];
  if (onDemand.length) parts.push([KNOWLEDGE_LIST_HEAD, ...onDemand.map(knowledgeLine)].join('\n'));
  parts.push(...inline.map(knowledgeSection));
  return parts.join('\n\n');
}

/** Слаги тегов знаний запуска или сессии из тела запроса или флагов CLI, проверенные, без повторов; [] — без тегов. */
export function runTagSlugs(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string')) throw new Error('tags — список слагов тегов');
  const slugs = [...new Set((raw as string[]).map((s) => s.trim()).filter(Boolean))];
  if (slugs.length > RUN_TAGS_MAX) throw new Error(`Тегов на запуск больше ${RUN_TAGS_MAX}`);
  for (const s of slugs) tagDir(s);
  return slugs;
}

/**
 * Выбранные на запуск или сессию теги знаний, порядок сохраняется. Тега нет — ошибка (теги знаний заводят на странице
 * «Знания», пустой из формы бесполезен), тег задачи — ошибка с подсказкой про пространство. Делят сервер, сессии и CLI.
 */
export function knowledgeTags(slugs: string[]): Tag[] {
  return slugs.map((slug) => {
    const tag = readKnowledgeTag(slug);
    if (!tag) throw new Error(`Тега знаний ${slug} нет — заведи его на странице «Знания»`);
    return tag;
  });
}

/**
 * Теги знаний каждого блока: block.knowledge ∪ теги знаний запуска, без повторов, в порядке «блок, потом запуск».
 * Тега нет или это тег задачи — ошибка с именем блока: ловится до первого этапа (как checkAddDirs) и на сервере (400).
 */
export function resolveKnowledge(spec: FlowSpec, runKnowledge: string[] = []): Map<string, Tag[]> {
  const cache = new Map<string, Tag>();
  const get = (slug: string, where: string): Tag => {
    let tag = cache.get(slug);
    if (!tag) {
      tag = readTag(slug);
      if (!tag) throw new Error(`${where}: тега знаний ${slug} нет — заведи его на странице «Знания»`);
      if (tag.kind !== 'knowledge') throw new Error(`${where}: ${slug} — старый тег задачи (теперь пространство), а не область знаний; в knowledge идут только теги знаний`);
      cache.set(slug, tag);
    }
    return tag;
  };
  const out = new Map<string, Tag[]>();
  for (const b of flowBlocks(spec)) {
    const slugs = [...new Set([...(b.knowledge ?? []), ...runKnowledge])];
    out.set(b.name, slugs.map((s) => get(s, b.knowledge?.includes(s) ? `блок ${b.name}` : 'запуск')));
  }
  return out;
}

/** Папки чтения тегов знаний блока: пути тегов (у файла — его папка) и папки вложений, без повторов. */
export function knowledgeDirs(tags: KnowledgeTag[]): string[] {
  return [...new Set(tags.flatMap((t) => existingTagPaths(t).dirs))];
}

// --- API: тонкие обёртки для server.ts

const bad = (err: unknown): ApiReply => ({ status: 400, body: { error: err instanceof Error ? err.message : String(err) } });
const notFound = (slug: string): ApiReply => ({ status: 404, body: { error: `Тега ${slug} нет` } });
/** Старый тег задачи — не тег знаний: 404 с подсказкой, где он теперь. */
const movedToSpace = (slug: string): ApiReply => ({ status: 404, body: { error: `Тег задачи ${slug} перенесён в пространство ${slug}: открой его на странице «Пространства»`, code: 'moved_to_space' } });

export function tagsListReply(): ApiReply {
  return { status: 200, body: { tags: listTags() } };
}

/** Запись тега знаний: описание, заметки, пути, вложения и готовый раздел input для промптов этапов (режим «целиком»). */
export function tagReply(slug: string): ApiReply {
  let tag: Tag | undefined;
  try {
    tag = readTag(slug);
  } catch (err) {
    return bad(err);
  }
  if (!tag) return notFound(slug);
  if (tag.kind !== 'knowledge') return movedToSpace(slug);
  return { status: 200, body: { ...tag, input: knowledgeSection(tag) } satisfies TagDetail };
}

/** Новый тег — только знаний: kind task (теги задач) — 400 с подсказкой про пространства. */
export function createTagReply(body: { slug?: unknown; title?: unknown; kind?: unknown }): ApiReply {
  if (typeof body.slug !== 'string') return { status: 400, body: { error: 'slug — строка' } };
  if (body.title !== undefined && typeof body.title !== 'string') return { status: 400, body: { error: 'title — строка' } };
  if (body.kind === 'task') return { status: 400, body: { error: 'Теги задач заменены пространствами: заведи пространство на странице «Пространства» (POST /api/spaces)' } };
  if (body.kind !== undefined && body.kind !== 'knowledge') return { status: 400, body: { error: 'kind — knowledge' } };
  try {
    const existed = Boolean(readMeta(body.slug.trim()));
    const tag = createTag(body.slug.trim(), body.title);
    return { status: existed ? 200 : 201, body: { ...tag, input: knowledgeSection(tag) } };
  } catch (err) {
    return bad(err);
  }
}

export function updateTagReply(slug: string, body: TagPatch): ApiReply {
  try {
    if (readMeta(slug)?.kind === 'task') return movedToSpace(slug);
    const tag = updateTag(slug, body ?? {});
    return tag ? { status: 200, body: { ...tag, input: knowledgeSection(tag) } } : notFound(slug);
  } catch (err) {
    return bad(err);
  }
}

export function deleteTagReply(slug: string): ApiReply {
  try {
    if (readMeta(slug)?.kind === 'task') return movedToSpace(slug);
    return deleteTag(slug) ? { status: 200, body: { ok: true } } : notFound(slug);
  } catch (err) {
    return bad(err);
  }
}

export function addTagAttachmentReply(slug: string, body: unknown): ApiReply {
  try {
    const name = addTagAttachment(slug, body);
    return { status: 201, body: { name, attachments: attachmentNames(slug) } };
  } catch (err) {
    return bad(err);
  }
}

export function deleteTagAttachmentReply(slug: string, name: string): ApiReply {
  try {
    if (readMeta(slug)?.kind === 'task') return movedToSpace(slug);
    return deleteTagAttachment(slug, name)
      ? { status: 200, body: { attachments: attachmentNames(slug) } }
      : { status: 404, body: { error: `Вложения ${name} нет` } };
  } catch (err) {
    return bad(err);
  }
}
