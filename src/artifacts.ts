// Контракт артефактов запуска: объявления, права этапов, валидация flow, подстановка и карта большого артефакта,
// раздел промпта, guard.
// Без файловой системы: то, что нужно знать о диске (realpath, lstat), guard и canonical получают через PathProbe,
// а реализация на fs и само хранилище — в artifact-store.ts. Валидация и права диск не трогают вовсе.
import os from 'node:os';
import path from 'node:path';
import { isMap, isPair, isScalar, isSeq, parseDocument } from 'yaml';
import { flowBlocks, phaseSteps, type FlowSpec, type Phase } from './schema.js';
import { referencedArtifacts } from './template.js';

export const ARTIFACT_KEY_RE = /^[a-zA-Z0-9_-]+$/;
/** Ключ артефакта по правилам: латиница, цифры, - и _, но не __proto__ (ключи уходят в объекты подстановок и отчёта). */
export function isArtifactKey(key: unknown): key is string {
  return typeof key === 'string' && ARTIFACT_KEY_RE.test(key) && key !== '__proto__';
}
const FILE_RE = /^[a-z0-9._-]+$/i;
export const ARTIFACT_EXTS = ['md', 'txt', 'json', 'yaml', 'yml'] as const;
/** Такие файлы Claude Code грузит из доп. директории как инструкции. */
const RESERVED_FILES = ['claude.md', 'claude.local.md'];
/** Раскладка папки запуска: runs/<id>/artifacts, artifacts-history, artifacts-quarantine. */
export const ARTIFACTS_DIR = 'artifacts';
export const HISTORY_DIR = 'artifacts-history';
export const QUARANTINE_DIR = 'artifacts-quarantine';
/** Порог подстановки содержимого {{artifacts.KEY}}: больше — начало файла и путь. */
export const INLINE_MAX = 32 * 1024;

// ---------- типы отчёта

export type {
  ArtifactAuthor, ArtifactLite, ArtifactMeta, ArtifactsReport, ArtifactTasks, ArtifactVersion, Denial, DenialReason, Editability, EditReason, StepArtifacts,
  StepDelta,
} from './api-types.js';
import type {
  ArtifactAuthor, ArtifactLite, ArtifactMeta, ArtifactsReport, ArtifactTasks, ArtifactVersion, Denial, DenialReason, Editability, StepArtifacts, StepDelta,
} from './api-types.js';

/** Артефакт, доступный этапу для инструмента чтения по ключу: ключ, название, абсолютный путь, имя файла. */
export type ArtifactSource = { key: string; title: string; path: string; file: string };

/** Что этап получает от хранилища на старте шага: папка, права, раздел промпта, подстановки. */
export type PhaseArtifacts = {
  dir: string;
  access: ArtifactAccess;
  /** Раздел «Артефакты запуска»; пустой, если доступа нет. */
  section: string;
  snapshot: Record<string, { text: string; path: string }>;
  /** Свои артефакты этапа для инструмента чтения по ключу (artifact-tools); нет — инструмента нет. */
  sources?: ArtifactSource[];
};

// ---------- объявления

export type DeclaredArtifact = { key: string; title: string; file: string; initial?: string; decisions: boolean };

export function declaredArtifacts(spec: Pick<FlowSpec, 'artifacts'>): DeclaredArtifact[] {
  return Object.entries(spec.artifacts ?? {}).map(([key, a]) => ({
    key,
    title: a.title?.trim() || key,
    file: a.file ?? `${key}.md`,
    ...(a.initial !== undefined ? { initial: a.initial } : {}),
    decisions: a.decisions === true,
  }));
}

/** У flow есть артефакты: только тогда включается всё новое (папки, раздел промпта, guard, поля отчёта). */
export function hasArtifacts(spec: Pick<FlowSpec, 'artifacts'>): boolean {
  return Object.keys(spec.artifacts ?? {}).length > 0;
}

/** Почему имя файла артефакта не годится; undefined — годится. То же правило для file из run.json. */
export function artifactFileProblem(file: unknown): string | undefined {
  if (typeof file !== 'string' || !file) return 'пустое имя файла';
  if (/[\\/]/.test(file)) return `file ${file}: только имя файла, без каталогов`;
  if (!FILE_RE.test(file)) return `file ${file}: только латиница, цифры, точка, _ и -`;
  if (file.startsWith('.')) return `file ${file}: имя не может начинаться с точки`;
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!(ARTIFACT_EXTS as readonly string[]).includes(ext)) return `file ${file}: расширение ${ARTIFACT_EXTS.join(', ')}`;
  if (RESERVED_FILES.includes(file.toLowerCase())) return `file ${file}: имя зарезервировано — такие файлы Claude Code грузит как инструкции`;
  return undefined;
}

// ---------- права этапов

export type ImplicitTool = 'Read' | 'Edit' | 'Write';
/**
 * Права этапа: read = reads ∪ writes ∪ подстановки в prompt и handoff, write = writes. implicit — инструменты,
 * которые этап получает только ради своих артефактов: Read при любом доступе, Edit и Write при writes, если их нет в tools.
 */
export type ArtifactAccess = { read: string[]; write: string[]; implicit: ImplicitTool[] };

export function artifactAccess(phase: Pick<Phase, 'reads' | 'writes' | 'prompt' | 'handoff' | 'tools'>): ArtifactAccess {
  const refs = [phase.prompt, phase.handoff ?? ''].flatMap((t) => {
    const r = referencedArtifacts(t);
    return [...r.content, ...r.path];
  });
  const write = [...new Set(phase.writes ?? [])];
  const read = [...new Set([...(phase.reads ?? []), ...write, ...refs])];
  const implicit: ImplicitTool[] = [];
  if (read.length && !phase.tools.includes('Read')) implicit.push('Read');
  if (write.length && !phase.tools.includes('Edit')) implicit.push('Edit');
  if (write.length && !phase.tools.includes('Write')) implicit.push('Write');
  return { read, write, implicit };
}

/** Судья читает все артефакты; Read у него и так есть. */
export function judgeAccess(spec: Pick<FlowSpec, 'artifacts'>): ArtifactAccess {
  return { read: Object.keys(spec.artifacts ?? {}), write: [], implicit: [] };
}

/**
 * Режимы разрешений, при которых отказ PreToolUse-хука не держится: этапу с неявными правами такой режим ставить нельзя.
 * Пусто: scripts/check-sdk-hooks.mts (Agent SDK 0.3.285, 2026-10-15) показал отказ при default, acceptEdits,
 * bypassPermissions, dontAsk и auto; plan не проверен — модель в нём правку не вызвала. После обновления SDK — прогнать заново.
 */
export const IMPLICIT_UNSAFE_MODES: readonly string[] = [];

// ---------- валидация flow

/** Ошибки контракта артефактов: имена, ссылки, decisions, параллельные группы. Пустой список — всё в порядке. */
export function artifactProblems(spec: FlowSpec): string[] {
  const problems: string[] = [];
  const declared = declaredArtifacts(spec);
  const known = new Set(declared.map((a) => a.key));
  const files = new Map<string, string>();
  for (const a of declared) {
    if (!isArtifactKey(a.key)) problems.push(`артефакт ${a.key}: ключ — латиница, цифры, - и _`);
    const fp = artifactFileProblem(a.file);
    if (fp) problems.push(`артефакт ${a.key}: ${fp}`);
    const lower = a.file.toLowerCase();
    const dup = files.get(lower);
    if (dup !== undefined) problems.push(`артефакты ${dup} и ${a.key}: один и тот же файл ${a.file} (имена файлов сравниваются без учёта регистра)`);
    else files.set(lower, a.key);
  }
  const decisions = declared.filter((a) => a.decisions).map((a) => a.key);
  if (decisions.length > 1) problems.push(`decisions: true у нескольких артефактов (${decisions.join(', ')}): ответы на паузу пишутся в один`);

  const unknownRefs = (where: string, tpl: string | undefined) => {
    const r = referencedArtifacts(tpl ?? '');
    for (const k of r.content) if (!known.has(k)) problems.push(`${where}: {{artifacts.${k}}} — неизвестный артефакт ${k}`);
    for (const k of r.path) if (!known.has(k)) problems.push(`${where}: {{artifacts.${k}.path}} — неизвестный артефакт ${k}`);
  };
  const blocks = flowBlocks(spec);
  const defaultsMode = spec.defaults?.permission_mode;
  for (const b of blocks) {
    for (const p of b.phases) {
      for (const field of ['reads', 'writes'] as const) {
        for (const k of p[field] ?? []) if (!known.has(k)) problems.push(`этап ${p.name}: ${field} — неизвестный артефакт ${k}`);
      }
      unknownRefs(`этап ${p.name}`, p.prompt);
      unknownRefs(`этап ${p.name} (handoff)`, p.handoff);
      const mode = p.permission_mode ?? defaultsMode;
      if (mode && IMPLICIT_UNSAFE_MODES.includes(mode) && artifactAccess(p).implicit.length) {
        problems.push(`этап ${p.name}: permission_mode ${mode} не держит защиту артефактов, а у этапа права на них без своих Read/Edit/Write — добавь инструменты в tools или смени режим`);
      }
    }
    const until = b.loop?.until;
    if (until?.type === 'judge') unknownRefs(`${blocks.length > 1 ? `блок ${b.name}, ` : ''}судья`, until.prompt);

    for (const step of phaseSteps(b)) {
      if (!step.group || step.phases.length < 2) continue;
      const members = step.phases.map(({ phase }) => ({ name: phase.name, access: artifactAccess(phase) }));
      const writers = new Map<string, string[]>();
      for (const m of members) for (const k of m.access.write) writers.set(k, [...(writers.get(k) ?? []), m.name]);
      for (const [k, names] of writers) {
        if (names.length > 1) problems.push(`группа ${step.group}: артефакт ${k} пишут несколько этапов (${names.join(', ')}) — они идут одновременно`);
      }
      for (const m of members) {
        for (const k of m.access.read) {
          if (m.access.write.includes(k)) continue;
          const other = (writers.get(k) ?? []).find((n) => n !== m.name);
          if (other) problems.push(`этап ${m.name}: читает артефакт ${k}, который пишет этап ${other} из той же группы ${step.group} — они идут одновременно`);
        }
      }
    }
  }
  return problems;
}

// ---------- подстановка и раздел промпта

/**
 * Подстановка {{artifacts.KEY}}: файл до INLINE_MAX байт — текст целиком, больше — карта всего содержимого
 * (artifactMap). Обрезки «первые N КБ» нет: этап видит структуру всего файла и дочитывает нужное по строкам.
 */
export function substitution(content: string, o: MapOptions): { text: string; mapped: boolean } {
  const size = o.size ?? Buffer.byteLength(content);
  if (size <= INLINE_MAX) return { text: content, mapped: false };
  return { text: artifactMap(content, { ...o, size }).text, mapped: true };
}

/** Ключи, чью карту (а не текст) получил этап: упомянуты в его шаблонах как {{artifacts.KEY}}, а в снимке — карта. */
export function mappedKeys(templates: string[], snapshot: Record<string, { mapped?: boolean }>): string[] {
  const keys = new Set(templates.flatMap((t) => referencedArtifacts(t).content));
  return [...keys].filter((k) => Object.hasOwn(snapshot, k) && snapshot[k].mapped);
}

/** Ключи, чей текст целиком получил этап: упомянуты в его шаблонах как {{artifacts.KEY}}, а в снимке — текст, не карта. */
export function inlineKeys(templates: string[], snapshot: Record<string, { mapped?: boolean }>): string[] {
  const keys = new Set(templates.flatMap((t) => referencedArtifacts(t).content));
  return [...keys].filter((k) => Object.hasOwn(snapshot, k) && !snapshot[k].mapped);
}

// ---------- карта большого артефакта

/** Карта не больше этого (байт UTF-8, вместе с шапкой). */
export const MAP_MAX = 8 * 1024;
/** Части файла без заголовков и большого раздела. */
export const PART_LINES = 200;
/** Раздел больше этого режется на части. */
const SECTION_SPLIT = 16 * 1024;
const ABOUT_MAX = 160;

/** Раздел карты: from–to — строки как у Read (с 1, включительно); level — глубина для сворачивания. */
export type MapSection = { key: string; from: number; to: number; bytes: number; about: string; level: number };
export type ArtifactMapResult = { sections: MapSection[]; lines: number; text: string };
export type MapOptions = {
  title: string;
  /** Абсолютный путь файла — в шапке карты. */
  path: string;
  /** Имя файла: по расширению выбирается разбор (json/yaml — по ключам, остальное — как markdown). */
  file: string;
  size?: number;
  /** Этапу доступен инструмент artifact_read: шапка подсказывает читать по ключу. */
  tool?: boolean;
  maxBytes?: number;
  /** Полная карта для artifact_map: без сворачивания и без фразы про порог подстановки. */
  full?: boolean;
};

/** Строки файла без переводов строк; завершающий перевод строки не даёт лишней пустой строки (как у Read). */
export function splitLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Текст строк from–to (с 1, включительно) вместе с их переводами строк: ровно то, что отдаст Read с offset и limit. */
export function sliceLines(content: string, from: number, to: number): string {
  let start = 0;
  for (let i = 1; i < from; i++) {
    const nl = content.indexOf('\n', start);
    if (nl === -1) return '';
    start = nl + 1;
  }
  let end = start;
  for (let i = from; i <= to; i++) {
    const nl = content.indexOf('\n', end);
    if (nl === -1) return content.slice(start);
    end = nl + 1;
  }
  return content.slice(start, end);
}

/**
 * Карта большого артефакта — детерминированно, без модели. Разделы вместе покрывают весь файл без пропусков и
 * пересечений: md/txt — по заголовкам вне оград кода (ключ — путь заголовков через « › », дубли « (2)», текст до
 * первого заголовка — «(начало)»; раздел больше 16 КБ и файл без заголовков — части по 200 строк); json/yaml — по
 * ключам верхнего уровня (у массива — по элементам) с откатом к тексту, если файл не разбирается. Текст карты —
 * не больше 8 КБ: при нехватке места соседние разделы нижних уровней сворачиваются в диапазоны.
 */
export function artifactMap(content: string, o: MapOptions): ArtifactMapResult {
  const lines = splitLines(content);
  // байтовые смещения начал строк: размер раздела — разность, перевод строки считается за строкой
  const offs = [0];
  for (let i = 0; i < lines.length; i++) offs.push(offs[i] + Buffer.byteLength(lines[i]) + (i < lines.length - 1 || content.endsWith('\n') ? 1 : 0));
  const bytes: Bytes = (from, to) => offs[to] - offs[from - 1];
  const ext = path.extname(o.file).slice(1).toLowerCase();
  const structured = ext === 'json' || ext === 'yaml' || ext === 'yml' ? structuredSections(content, lines, bytes) : undefined;
  const sections = structured ?? textSections(lines, bytes);
  return { sections, lines: lines.length, text: renderMap(sections, lines.length, o) };
}

/** Карта файла, который не читается целиком (больше 8 МБ): части по 200 строк без описаний. */
export function artifactMapParts(lineCount: number, o: MapOptions): ArtifactMapResult {
  const sections: MapSection[] = [];
  for (let from = 1, k = 1; from <= lineCount; from += PART_LINES, k++) {
    sections.push({ key: `часть ${k}`, from, to: Math.min(lineCount, from + PART_LINES - 1), bytes: 0, about: '', level: 1 });
  }
  return { sections, lines: lineCount, text: renderMap(sections, lineCount, o) };
}

/** Размер строк from–to в байтах вместе с переводами строк. */
type Bytes = (from: number, to: number) => number;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/** Пункт чек-листа: маркер -, * или + с любым отступом, [ ] — открыт, [x]/[X] — закрыт. */
const TASK_RE = /^\s*[-*+]\s+\[([ xX])\]/;

/** Какие строки в оградах кода (вместе со строками самих оград): закрывает тот же символ не короче открывающего, строка ограды целиком. */
function fencedLines(lines: string[]): boolean[] {
  let fence: { ch: string; len: number } | undefined;
  return lines.map((l) => {
    const f = l.match(FENCE_RE);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && l.trim() === f[1]) fence = undefined;
      return true;
    }
    if (f) fence = { ch: f[1][0], len: f[1].length };
    return Boolean(f);
  });
}

/** Пункты чек-листа вне оград кода; undefined — пунктов нет. */
export function countTasks(text: string): ArtifactTasks | undefined {
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  let open = 0;
  let done = 0;
  lines.forEach((l, i) => {
    if (fenced[i]) return;
    const box = l.match(TASK_RE);
    if (box?.[1] === ' ') open++;
    else if (box) done++;
  });
  return open || done ? { open, done } : undefined;
}

/** Пункты чек-листа артефакта: считаются только у markdown (в yaml «- [ ]» — список, а не пункт). */
export function artifactTasks(file: string, text: string): ArtifactTasks | undefined {
  return path.extname(file).toLowerCase() === '.md' ? countTasks(text) : undefined;
}

/** Разделы markdown и текста: заголовки вне оград кода; большие разделы и файл без заголовков — части по 200 строк. */
function textSections(lines: string[], lineBytes: Bytes): MapSection[] {
  const n = lines.length;
  const heads: { line: number; level: number; title: string }[] = [];
  const fenced = fencedLines(lines);
  lines.forEach((l, i) => {
    if (fenced[i]) return;
    const h = l.match(HEADING_RE);
    if (h) heads.push({ line: i + 1, level: h[1].length, title: (h[2] ?? '').replace(/[ \t]+#+$/, '').trim() || '(без названия)' });
  });
  const raw: { key: string; from: number; to: number; level: number; heading: boolean }[] = [];
  if (!heads.length) raw.push({ key: '', from: 1, to: n, level: 0, heading: false });
  else {
    if (heads[0].line > 1) raw.push({ key: '(начало)', from: 1, to: heads[0].line - 1, level: 1, heading: false });
    const stack: { level: number; title: string }[] = [];
    const seen = new Map<string, number>();
    heads.forEach((h, i) => {
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
      stack.push(h);
      const base = stack.map((x) => x.title).join(' › ');
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      raw.push({ key: count > 1 ? `${base} (${count})` : base, from: h.line, to: (heads[i + 1]?.line ?? n + 1) - 1, level: stack.length, heading: true });
    });
  }
  const out: MapSection[] = [];
  for (const r of raw) {
    const bytes = lineBytes(r.from, r.to);
    // файл без заголовков — всегда частями; раздел — только если больше 16 КБ
    if (!r.key || bytes > SECTION_SPLIT) {
      for (let from = r.from, k = 1; from <= r.to; from += PART_LINES, k++) {
        const to = Math.min(r.to, from + PART_LINES - 1);
        out.push({ key: r.key ? `${r.key} · часть ${k}` : `часть ${k}`, from, to, bytes: lineBytes(from, to), about: describe(lines, from, to, r.heading && k === 1), level: r.level + 1 });
      }
    } else out.push({ key: r.key, from: r.from, to: r.to, bytes, about: describe(lines, r.from, r.to, r.heading), level: r.level });
  }
  return out;
}

/** Первая содержательная строка раздела (не заголовок, не пустая, не ограда кода) до 160 символов и счётчики пунктов. */
function describe(lines: string[], from: number, to: number, skipHeading: boolean): string {
  let first = '';
  let items = 0;
  let boxes = 0;
  let done = 0;
  for (let i = from; i <= to; i++) {
    const l = lines[i - 1];
    if (i === from && skipHeading) continue;
    const t = l.trim();
    if (!first && t && !FENCE_RE.test(l) && !HEADING_RE.test(l)) first = t;
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(l)) items++;
    const box = l.match(TASK_RE);
    if (box) {
      boxes++;
      if (box[1] !== ' ') done++;
    }
  }
  const head = [...first].length > ABOUT_MAX ? [...first].slice(0, ABOUT_MAX - 1).join('') + '…' : first;
  const counts = boxes ? `пунктов: ${items}, отмечено ${done} из ${boxes}` : items ? `пунктов: ${items}` : '';
  return [head, counts && `(${counts})`].filter(Boolean).join(' ');
}

/** json/yaml: ключи верхнего уровня (у массива — элементы) с типом и превью; undefined — не разобрался, режем как текст. */
function structuredSections(content: string, lines: string[], lineBytes: Bytes): MapSection[] | undefined {
  let doc;
  try {
    doc = parseDocument(content, { prettyErrors: false, uniqueKeys: false });
  } catch {
    return undefined;
  }
  const root = doc.contents;
  if (doc.errors.length || !(isMap(root) || isSeq(root)) || !root.items.length) return undefined;
  const starts: number[] = [0];
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const n = lines.length;
  const items = root.items.map((it, i) => {
    const node = isPair(it) ? it.value : it;
    const keyNode = isPair(it) ? it.key : it;
    const range = (keyNode as { range?: [number, number, number] } | null)?.range;
    const endRange = (node as { range?: [number, number, number] } | null)?.range ?? range;
    const key = isPair(it) ? String(isScalar(it.key) ? it.key.value : it.key) : `[${i}]`;
    return { key, start: range?.[0] ?? 0, end: endRange?.[2] ?? range?.[2] ?? 0, about: describeNode(node) };
  });
  const firstLines = items.map((x) => lineOf(x.start));
  const ordered = firstLines.every((l, i) => i === 0 || l > firstLines[i - 1]);
  // разделы по строкам, если каждый ключ начинается со своей строки; иначе (файл в одну строку) — по ключам без диапазонов
  return items.map((x, i) => {
    const from = ordered ? (i === 0 ? 1 : firstLines[i]) : firstLines[i];
    const to = ordered ? (i + 1 < items.length ? firstLines[i + 1] - 1 : n) : lineOf(Math.max(x.start, x.end - 1));
    const bytes = ordered ? lineBytes(from, to) : Buffer.byteLength(content.slice(x.start, x.end));
    return { key: x.key, from, to, bytes, about: x.about, level: 1 };
  });
}

function describeNode(node: unknown): string {
  if (isMap(node)) {
    const keys = node.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
    return `объект, ключей: ${keys.length}${keys.length ? ` — ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''}` : ''}`;
  }
  if (isSeq(node)) return `массив, элементов: ${node.items.length}`;
  if (isScalar(node)) {
    const v = node.value;
    const type = v === null ? 'null' : typeof v === 'string' ? 'строка' : typeof v === 'number' ? 'число' : typeof v === 'boolean' ? 'логическое' : typeof v;
    const text = String(v).replace(/\s+/g, ' ').trim();
    const preview = [...text].length > 80 ? [...text].slice(0, 79).join('') + '…' : text;
    return v === null ? 'null' : `${type}: ${preview}`;
  }
  return 'null';
}

/**
 * Текст карты: шапка и строки разделов. Не влезает в 8 КБ — подразделы, начиная с самых глубоких, вливаются в
 * родительский раздел (его описание остаётся, к ключу — «+ подразделов: N»); не хватает и этого — соседние строки
 * сворачиваются группами по k. Строки карты всегда покрывают весь файл подряд.
 */
function renderMap(sections: MapSection[], lineCount: number, o: MapOptions): string {
  const size = o.size ?? sections.reduce((n, s) => n + s.bytes, 0);
  const how = o.tool
    ? 'инструментом artifact_read по ключу раздела или Read с offset = первой строке диапазона и limit = числу строк'
    : 'Read с offset = первой строке диапазона и limit = числу строк';
  const head = [
    `Карта артефакта «${o.title}» — ${fmtSize(size)}, строк: ${lineCount}, файл ${o.path}`,
    o.full
      ? `Все разделы: ключ, строки, размер, о чём он. Раздел целиком: ${how}.`
      : `Файл больше ${fmtSize(INLINE_MAX)}, поэтому вместо текста — карта всего содержимого: раздел, строки, размер, о чём он. Нужный раздел дочитай целиком: ${how}.`,
  ].join('\n');
  const max = o.full ? Infinity : (o.maxBytes ?? MAP_MAX);
  const cut = (k: string) => ([...k].length > 60 ? [...k].slice(0, 59).join('') + '…' : k);
  /** Строка карты — разделы i..j; parent — первый раздел остаётся собой, остальные — его подразделы. */
  type Row = { i: number; j: number; parent: boolean };
  const bytesOf = (r: Row) => sections.slice(r.i, r.j + 1).reduce((n, s) => n + s.bytes, 0);
  const line = (r: Row) => {
    const a = sections[r.i];
    const b = sections[r.j];
    const bytes = bytesOf(r);
    const tail = `${range(a.from, b.to)}${bytes ? `, ${fmtSize(bytes)}` : ''}`;
    if (r.i === r.j) return `- ${a.key} — ${tail}${a.about ? `: ${a.about}` : ''}`;
    if (r.parent) return `- ${a.key} (+ подразделов: ${r.j - r.i}) — ${tail}${a.about ? `: ${a.about}` : ''}`;
    return `- разделы ${r.i + 1}–${r.j + 1} — ${tail}: от «${cut(a.key)}» до «${cut(b.key)}»`;
  };
  const render = (rows: Row[]) => [head, ...rows.map(line)].join('\n');
  const fits = (rows: Row[]) => Buffer.byteLength(render(rows)) <= max;

  let rows: Row[] = sections.map((_, i) => ({ i, j: i, parent: false }));
  if (fits(rows)) return render(rows);
  const maxLevel = Math.max(...sections.map((s) => s.level));
  for (let level = maxLevel; level >= 2; level--) {
    const next: Row[] = [];
    for (const r of rows) {
      const prev = next[next.length - 1];
      const deep = sections[r.i].level >= level;
      // подраздел уровня level и глубже вливается в предыдущую строку, если она — раздел уровнем выше
      if (deep && prev && (prev.parent || prev.i === prev.j) && sections[prev.i].level < level) next[next.length - 1] = { i: prev.i, j: r.j, parent: true };
      else if (deep && prev && !prev.parent && prev.i !== prev.j && sections[prev.j].level >= level) next[next.length - 1] = { i: prev.i, j: r.j, parent: false };
      else next.push(r);
    }
    rows = next;
    if (fits(rows)) return render(rows);
  }
  for (let k = 2; ; k *= 2) {
    const grouped: Row[] = [];
    for (let x = 0; x < rows.length; x += k) {
      const part = rows.slice(x, x + k);
      grouped.push(part.length === 1 ? part[0] : { i: part[0].i, j: part[part.length - 1].j, parent: false });
    }
    if (fits(grouped) || grouped.length === 1) return render(grouped);
  }
}

const range = (from: number, to: number) => (from === to ? `строка ${from}` : `строки ${from}–${to} (${to - from + 1})`);

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Дата и время по местному времени: «15.10 12:03». */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Кто и когда последним изменил артефакт — для раздела промпта. Голос пользователя — только у правок через UI и скилл. */
export function describeAuthor(a: ArtifactAuthor, fromRun?: string): string {
  const from = fromRun ? ` (из запуска ${fromRun})` : '';
  switch (a.kind) {
    case 'phase': return `изменён этапом ${a.phase}, итерация ${a.iteration}, ${fmtWhen(a.at)}${from}`;
    case 'unknown': return `изменён во время этапа ${a.phase} (итерация ${a.iteration}) не этапом с правом записи, ${fmtWhen(a.at)}${from}, источник не установлен`;
    case 'user': return `последнюю правку сделал пользователь ${fmtWhen(a.at)}${from}: учитывай её и не откатывай`;
    case 'outside': return `изменён вне этапов между шагами ${fmtWhen(a.at)}${from}, источник не установлен`;
    case 'condition': return `изменён при проверке условия, итерация ${a.iteration}, ${fmtWhen(a.at)}${from}`;
    case 'initial': return `заготовка flow${from}`;
    case 'empty': return `ещё не заполнялся${from}`;
  }
}

/**
 * mapped — этап получил в промпте карту этого артефакта, а не текст; inline — текст целиком;
 * decisions — журнал ответов на паузу, туда дописывают, а не переписывают.
 */
export type SectionItem = { title: string; path: string; write: boolean; author: ArtifactAuthor; fromRun?: string; mapped?: boolean; inline?: boolean; decisions?: boolean };

/** Раздел «Артефакты запуска» в конце промпта. Без артефактов — пустая строка. tool — у сессии есть инструмент чтения по ключу. */
export function artifactSection(items: SectionItem[], o: { tool?: boolean } = {}): string {
  if (!items.length) return '';
  const lines = items.map((i) => `- ${i.title} — ${i.path} — ${i.write ? 'запись' : 'чтение'} — ${describeAuthor(i.author, i.fromRun)}`);
  const names = (xs: SectionItem[]) => xs.map((i) => `«${i.title}»`).join(', ');
  // карта снята на начало шага: после правки этапа диапазоны строк в ней устаревают
  const remap = items.filter((i) => i.write && i.mapped);
  // текст уже в промпте — без этой строки этапы перечитывают файл перед каждой правкой
  const inline = items.filter((i) => i.inline && !i.mapped);
  // журнал итераций раздувает промпт следующих этапов, а историю и так хранят версии
  const state = items.filter((i) => i.write && !i.decisions);
  return [
    'Артефакты запуска:',
    ...lines,
    'Пиши только в артефакты с доступом «запись».',
    'Пути к артефактам — только отсюда, а не из выводов прошлых этапов.',
    ...(inline.length ? [`Текст ${names(inline)} уже есть выше на начало шага: читать файл ради содержимого не нужно.`] : []),
    ...(state.length ? [`${names(state)} — текущее состояние, а не журнал: обновляй так, чтобы файл описывал, как есть сейчас. Списки (файлы, исправления) пополняй и уточняй, а историю попыток по итерациям не дописывай — версии хранит раннер.`] : []),
    ...(remap.length ? [`Карта ${names(remap)} снята на начало шага: после своих правок перечитай файл — строки сдвинулись.`] : []),
    ...(o.tool ? ['Артефакты можно читать по разделам: artifact_map — карта, artifact_read — раздел целиком по ключу из карты, artifact_search — поиск строк.'] : []),
  ].join('\n');
}

// ---------- пути и guard

/** Что guard знает о диске. Реализация на fs — nodeProbe в artifact-store.ts, в тестах — подмена. */
export type PathProbe = {
  /** realpath существующего пути; undefined — пути нет. */
  realpath: (p: string) => string | undefined;
  /** lstat без следования ссылке; undefined — пути нет. */
  lstat: (p: string) => { file: boolean; symlink: boolean; nlink: number } | undefined;
};

/** ~ раскрывается, относительный путь — от cwd, затем лексическая нормализация. */
export function expandPath(p: string, cwd: string): string {
  const home = p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(cwd, home);
}

/**
 * Канонический путь для сравнения: expandPath, затем realpath ближайшего существующего предка плюс остаток.
 * На APFS realpath.native даёт настоящий регистр имён, поэтому дальше сравнение точное.
 */
export function canonical(p: string, cwd: string, probe: Pick<PathProbe, 'realpath'>): string {
  const abs = expandPath(p, cwd);
  const rest: string[] = [];
  for (let cur = abs; ; ) {
    const real = probe.realpath(cur);
    if (real !== undefined) return rest.length ? path.join(real, ...rest.reverse()) : real;
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.push(path.basename(cur));
    cur = parent;
  }
}

export function isInside(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

export const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const PATH_TOOLS = ['Read', ...WRITE_TOOLS];
/** Имена инструмента сабагентов: Agent, в старых версиях Claude Code — Task. */
const AGENT_TOOLS = ['Agent', 'Task'];

/** Путь из входа инструмента: file_path у Read/Edit/Write/MultiEdit, notebook_path у NotebookEdit. */
export function toolPath(tool: string, input: Record<string, unknown>): unknown {
  return tool === 'NotebookEdit' ? input.notebook_path : input.file_path;
}

/** Что guard знает об этапе и запуске. dir и runsDir — канонические (realpath) пути. */
export type GuardScope = {
  access: ArtifactAccess;
  /** Свои инструменты этапа (tools), без неявных. */
  tools: string[];
  dir: string;
  runsDir: string;
  /** Канонический путь файла артефакта -> ключ. */
  files: Map<string, string>;
  titles: Map<string, string>;
  probe: PathProbe;
};

export type GuardDecision = { reason: DenialReason; message: string };

/**
 * Решение перед вызовом инструмента; undefined — разрешено.
 * - Неявный инструмент (Read/Edit/Write не из tools этапа) — только для своих артефактов (Edit/Write — из write,
 *   Read — из read), только обычный файл с одной жёсткой ссылкой или отсутствующий файл для Write. Иначе отказ (fail-closed).
 * - Явный инструмент записи: в папке артефактов — только свои артефакты из write, в остальной папке запусков — отказ,
 *   вне неё — как без артефактов.
 * - Сабагент с isolation у этапа с неявными правами — отказ: он работает с другой рабочей директорией или вне машины.
 */
export function artifactGuardDecision(scope: GuardScope, tool: string, input: Record<string, unknown>, cwd: string): GuardDecision | undefined {
  const { access } = scope;
  if (AGENT_TOOLS.includes(tool) && access.implicit.length && input.isolation !== undefined && input.isolation !== null && input.isolation !== '') {
    return {
      reason: 'isolation',
      message: 'Сабагент с isolation этому этапу недоступен: права этапа на артефакты держатся проверкой в этой сессии, а изолированный сабагент работает вне неё. Запусти сабагента без isolation.',
    };
  }
  if (!PATH_TOOLS.includes(tool)) return undefined;
  const implicit = (access.implicit as string[]).includes(tool) && !scope.tools.includes(tool);
  const writing = WRITE_TOOLS.includes(tool);
  const own = (writing ? access.write : access.read).map((k) => scope.titles.get(k) ?? k);
  const ownList = own.length ? own.map((t) => `«${t}»`).join(', ') : 'нет';
  const raw = toolPath(tool, input);
  if (typeof raw !== 'string' || !raw.trim()) {
    return implicit ? { reason: 'not-artifact', message: `${tool} без пути к файлу: этому этапу ${tool} разрешён только для его артефактов (${ownList}).` } : undefined;
  }
  const p = canonical(raw, cwd, scope.probe);
  const key = scope.files.get(p);
  const inDir = isInside(p, scope.dir);

  if (implicit || (writing && inDir)) {
    const allowed = key !== undefined && (writing ? access.write : access.read).includes(key);
    if (!allowed) {
      if (key !== undefined && writing && access.read.includes(key)) {
        return { reason: 'artifact-readonly', message: `Артефакт «${scope.titles.get(key) ?? key}» этому этапу доступен только для чтения. Писать можно только в артефакты с доступом «запись»: ${ownList}.` };
      }
      if (inDir) {
        const what = key !== undefined ? `артефакт «${scope.titles.get(key) ?? key}» этому этапу недоступен` : `${raw} — не объявленный артефакт`;
        return {
          reason: writing && key !== undefined ? 'artifact-readonly' : 'not-artifact',
          message: `В папке артефактов ${writing ? 'писать' : 'читать'} можно только свои артефакты (${ownList}); ${what}.`,
        };
      }
      return { reason: 'outside-artifacts', message: `${tool} этому этапу разрешён только для его артефактов (${ownList}); ${raw} — не артефакт этапа. Инструмента ${tool} для остальных файлов у этапа нет.` };
    }
    const st = scope.probe.lstat(p);
    const ok = st ? st.file && !st.symlink && st.nlink === 1 : tool === 'Write';
    if (!ok) {
      return { reason: 'not-artifact', message: `Файл артефакта «${scope.titles.get(key) ?? key}» сейчас ${st ? 'не обычный файл (ссылка)' : 'отсутствует'}: ${tool} отклонён. Перед следующим шагом раннер восстановит артефакт.` };
    }
    return undefined;
  }
  if (writing && isInside(p, scope.runsDir)) {
    return { reason: 'runs-dir', message: `В папку запусков писать нельзя: её файлы пишут раннер и сервер. Твои артефакты для записи: ${ownList}.` };
  }
  return undefined;
}

// ---------- правка пользователем

/** Правка через UI и скилл — до 1 МБ в байтах; файл больше — только чтение. */
export const EDIT_MAX = 1024 * 1024;

// Почему артефакт сейчас (не) правится через API — EditReason и Editability в api-types.ts.

export type EditState = {
  /** Запуск идёт в этом сервере (у него живое хранилище и блокировка). */
  live: boolean;
  /** Этапы идущего шага, которые пишут артефакт. */
  lockedBy: string[];
  /** Этапы, чей вопрос ждёт ответа пользователя. */
  pendingQuestion: string[];
  /** Запуск идёт из CLI: running в run.json, процесс жив, этот сервер им не управляет. */
  cliAlive: boolean;
  /** Ответ canContinue для неживого запуска: можно ли продолжить и почему нельзя. */
  continuable: boolean;
  continueReason?: string;
  /** Размер файла артефакта в байтах. */
  size: number;
  /** Путь к файлу: подпись «больше 1 МБ» называет его. */
  path?: string;
};

/**
 * Можно ли править артефакт через API сейчас — одно правило для UI, хелпера скилла и самой записи.
 * У живого запуска: пишущий шаг или ждущий ответа пишущий этап блокируют, остальное правится (на паузе — надёжнее).
 * У неживого: CLI — чтение, done — чтение, продолжить нельзя — чтение, иначе правка попадёт в продолжение.
 * report — отчёт глазами сервера: у оборвавшегося запуска статус interrupted, а не running.
 */
export function artifactEditability(report: { status: string }, s: EditState): Editability {
  const big: Editability = {
    editable: false,
    reason: 'too-big',
    message: `Артефакт больше ${fmtSize(EDIT_MAX)} (${fmtSize(s.size)}): в UI только чтение${s.path ? `, файл — ${s.path}` : ''}`,
  };
  if (s.live) {
    if (s.lockedBy.length) {
      const asker = s.lockedBy.filter((p) => s.pendingQuestion.includes(p));
      if (asker.length) {
        return { editable: false, reason: 'asking', phases: asker, message: `Этап ${asker.join(', ')} ждёт твоего ответа и пишет этот артефакт: ответь в вопросе или поправь после шага` };
      }
      return { editable: false, reason: 'writing', phases: [...s.lockedBy], message: `Пишет этап ${s.lockedBy.join(', ')}: правка откроется после конца шага` };
    }
    return s.size > EDIT_MAX ? big : { editable: true };
  }
  if (s.cliAlive) return { editable: false, reason: 'cli', message: 'Запуск идёт из CLI: править можно после его конца' };
  if (report.status === 'done') return { editable: false, reason: 'done', message: 'Запуск завершён: правка ни на что не повлияет' };
  if (!s.continuable) {
    return { editable: false, reason: 'not-continuable', message: `Продолжить этот запуск нельзя${s.continueReason ? ` (${lowerFirst(s.continueReason)})` : ''}: правка ни на что не повлияет` };
  }
  if (s.size > EDIT_MAX) return big;
  return { editable: true, reason: 'continuable', message: 'Правка попадёт в продолжение этого запуска' };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
