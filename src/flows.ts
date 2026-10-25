// Работа с файлами флоу в flows/: список, чтение, сохранение, удаление, валидация.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { ZodError } from 'zod';
import { compactSpec, flowBlocks, flowPhases, FlowSchema, type Block, type FlowSpec, type Phase } from './schema.js';
import { validateReferences } from './generate.js';
import { FLOWS_DIR } from './paths.js';
import type { FlowSummary, PhaseSummary } from './api-types.js';

export type { BlockSummary, FlowSummary } from './api-types.js';

const NAME_RE = /^[a-z0-9-]+$/;
// Папки — подкаталоги flows/ одного уровня; имя флоу остаётся уникальным через все папки.
const FOLDER_RE = /^(?!\.)[\p{L}\p{N} _.-]{1,60}$/u;

export function assertFlowName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`Недопустимое имя flow: ${name} (латиница, цифры, дефис)`);
}

export function assertFolderName(folder: string): void {
  if (!FOLDER_RE.test(folder) || folder !== folder.trim()) {
    throw new Error(`Недопустимое имя папки: ${folder} (буквы, цифры, пробел, _ . -, не с точки, до 60 символов)`);
  }
}

type FlowFile = { name: string; folder: string; file: string };

/** Все файлы флоу: сначала корень flows/, потом папки по алфавиту. */
function flowFiles(): FlowFile[] {
  if (!fs.existsSync(FLOWS_DIR)) return [];
  const scan = (dir: string, folder: string): FlowFile[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .map((f) => ({ name: f.replace(/\.ya?ml$/, ''), folder, file: path.join(dir, f) }));
  return [...scan(FLOWS_DIR, ''), ...listFolders().flatMap((d) => scan(path.join(FLOWS_DIR, d), d))];
}

/** Подкаталоги flows/ (включая пустые). */
function listFolders(): string[] {
  if (!fs.existsSync(FLOWS_DIR)) return [];
  return fs
    .readdirSync(FLOWS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function findFlowFile(name: string): FlowFile | undefined {
  return flowFiles().find((f) => f.name === name);
}

/** Папка файла флоу относительно flows/; файл вне flows/ (путь из CLI) считается корнем. */
function folderOf(file: string): string {
  const rel = path.relative(FLOWS_DIR, path.dirname(path.resolve(file)));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : '';
}

function folderDir(folder: string): string {
  if (!folder) return FLOWS_DIR;
  assertFolderName(folder);
  // на регистронезависимой ФС «Docs» и «docs» — одна папка: берём уже существующее написание
  const existing = listFolders().find((d) => d.toLowerCase() === folder.toLowerCase());
  return path.join(FLOWS_DIR, existing ?? folder);
}

/** Куда писать флоу: в его текущий файл (в какой бы папке он ни лежал), новый — в folder. */
function targetFile(name: string, folder = ''): string {
  const existing = findFlowFile(name);
  if (existing) return existing.file;
  const dir = folderDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.yaml`);
}

function removeFolderIfEmpty(folder: string): void {
  if (!folder) return;
  const dir = path.join(FLOWS_DIR, folder);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

export function flowExists(name: string): boolean {
  return Boolean(findFlowFile(name));
}

export function parseFlow(yamlText: string): FlowSpec {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(`Ошибка YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateSpec(raw);
}

/** Валидация произвольного объекта (из YAML или из JSON конструктора). */
export function validateSpec(raw: unknown): FlowSpec {
  try {
    const spec = FlowSchema.parse(raw);
    validateReferences(spec);
    return spec;
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
      throw new Error(`Невалидный flow:\n${issues}`);
    }
    throw err;
  }
}

/**
 * Сохранить спецификацию, пришедшую как JSON (из конструктора). Возвращает нормализованный spec и YAML.
 * Конструктор всегда шлёт blocks; один блок без названия сохраняется короткой формой.
 */
export function saveFlowSpec(name: string, raw: unknown): { spec: FlowSpec; yaml: string; file: string } {
  assertFlowName(name);
  const spec = compactSpec(validateSpec({ ...(raw as object), name }));
  const yaml = flowToYaml(spec);
  const file = targetFile(name);
  fs.writeFileSync(file, yaml);
  return { spec, yaml, file };
}

export function flowToYaml(spec: FlowSpec): string {
  return toYaml(spec, { lineWidth: 0 });
}

export function describeCondition(block: Block): string {
  const u = block.loop?.until;
  if (!u) return 'один проход';
  const pause = block.loop?.pause_marker ? `, пауза по маркеру ${block.loop.pause_marker}` : '';
  switch (u.type) {
    case 'command': return `пока команда \`${u.run.replace(/\s+/g, ' ').trim()}\` не вернёт 0${pause}`;
    case 'marker': return `пока в выводе этапа нет маркера ${u.marker}${pause}`;
    case 'judge': return `пока судья не скажет «готово»${pause}`;
    case 'none': return `без условия (все итерации)${pause}`;
  }
}

/** Условия всех блоков одной строкой: «пока судья не скажет «готово» → один проход → пока команда `npm test` не вернёт 0». */
export function describeFlowCondition(spec: FlowSpec): string {
  return flowBlocks(spec).map(describeCondition).join(' → ');
}

const phaseSummary = (p: Phase): PhaseSummary => ({ name: p.name, title: p.title, tools: p.tools, ...(p.group ? { group: p.group } : {}) });

/** file пустой — черновик разового запуска: файла и папки у него нет. */
export function summarize(name: string, file: string, spec: FlowSpec): FlowSummary {
  const blocks = flowBlocks(spec);
  return {
    name,
    file,
    folder: file ? folderOf(file) : '',
    valid: true,
    description: spec.description,
    input: spec.input,
    maxIterations: blocks.length === 1 ? (blocks[0].loop?.max_iterations ?? 1) : undefined,
    condition: describeFlowCondition(spec),
    phases: flowPhases(spec).map(phaseSummary),
    blocks: blocks.map((b) => ({
      name: b.name,
      title: b.title,
      looped: Boolean(b.loop),
      maxIterations: b.loop?.max_iterations ?? 1,
      condition: describeCondition(b),
      onFail: b.on_fail ?? 'stop',
      phases: b.phases.map(phaseSummary),
    })),
  };
}

export function listFlows(): FlowSummary[] {
  const seen = new Map<string, string>();
  return flowFiles().map(({ name, folder, file }) => {
    // имя — ключ флоу (URL, запуски, CLI); второй файл с тем же именем открыть нельзя, показываем его ошибкой
    const first = seen.get(name);
    if (first !== undefined) {
      return { name, file, folder, valid: false, error: `Имя ${name} уже занято flow ${first ? `в папке ${first}` : 'в корне flows/'}: переименуй файл` };
    }
    seen.set(name, folder);
    try {
      return summarize(name, file, parseFlow(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      return { name, file, folder, valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Принимает путь к файлу или имя флоу из flows/ (в любой папке). */
export function resolveFlowFile(nameOrPath: string): string {
  if (fs.existsSync(nameOrPath) && fs.statSync(nameOrPath).isFile()) return path.resolve(nameOrPath);
  const candidate = path.join(FLOWS_DIR, /\.ya?ml$/.test(nameOrPath) ? nameOrPath : `${nameOrPath}.yaml`);
  if (fs.existsSync(candidate)) return candidate;
  const found = findFlowFile(nameOrPath.replace(/\.ya?ml$/, ''));
  if (found) return found.file;
  throw new Error(`Flow не найден: ${nameOrPath}`);
}

export function flowFolder(name: string): string {
  return findFlowFile(name)?.folder ?? '';
}

export function loadFlow(nameOrPath: string): FlowSpec {
  return parseFlow(fs.readFileSync(resolveFlowFile(nameOrPath), 'utf8'));
}

export function readFlowYaml(name: string): string {
  assertFlowName(name);
  return fs.readFileSync(resolveFlowFile(name), 'utf8');
}

/**
 * Валидирует и сохраняет YAML. Имя файла берётся из аргумента, не из поля name.
 * Существующий флоу перезаписывается на месте, новый ложится в folder.
 */
export function saveFlowYaml(name: string, yamlText: string, folder = ''): { spec: FlowSpec; file: string } {
  assertFlowName(name);
  const spec = parseFlow(yamlText);
  const file = targetFile(name, folder);
  fs.writeFileSync(file, yamlText.endsWith('\n') ? yamlText : yamlText + '\n');
  return { spec, file };
}

export function deleteFlow(name: string): void {
  assertFlowName(name);
  const file = resolveFlowFile(name);
  fs.rmSync(file);
  removeFolderIfEmpty(folderOf(file));
}

/** Переложить флоу в другую папку ('' — корень flows/). Опустевшая папка удаляется. */
export function moveFlow(name: string, folder: string): { file: string; folder: string } {
  assertFlowName(name);
  const current = findFlowFile(name);
  if (!current) throw new Error(`Flow не найден: ${name}`);
  const dir = folderDir(folder.trim());
  const target = path.join(dir, path.basename(current.file));
  if (path.resolve(target) === path.resolve(current.file)) return { file: current.file, folder: current.folder };
  if (fs.existsSync(target)) throw new Error(`В папке уже есть файл ${path.basename(target)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(current.file, target);
  removeFolderIfEmpty(current.folder);
  return { file: target, folder: folderOf(target) };
}

/** Свободное имя для нового флоу (name, name-2, … — уникально через все папки) и файл в folder. */
export function flowFileName(name: string, folder = ''): { name: string; file: string } {
  const candidate = freeFlowName(name, new Set(flowFiles().map((f) => f.name)));
  return { name: candidate, file: targetFile(candidate, folder) };
}

/** Первое незанятое из name, name-2, name-3, … */
export function freeFlowName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let i = 2; taken.has(candidate); i++) candidate = `${name}-${i}`;
  return candidate;
}

export function blankFlowYaml(name: string): string {
  return `name: ${name}
description: Что делает этот flow
input: ""
loop:
  max_iterations: 3
  until:
    type: judge
    prompt: |
      Задача: {{input}}

      Выводы этапов текущей итерации:
      {{outputs}}

      Рубрика: done=true только если задача выполнена целиком. Иначе перечисли в feedback конкретные пробелы.
phases:
  - name: analyze
    title: Анализ
    tools: [Read, Grep, Glob]
    prompt: |
      Задача: {{input}}

      Замечания с прошлой итерации (пусто, если первая): {{feedback}}

      Изучи репозиторий и составь план. Ничего не правь.
      Закончи ответ разделом "## Результат": что нашёл, какие файлы затронуть, план правок.
  - name: implement
    title: Реализация
    tools: [Read, Edit, Write, Grep, Glob, Bash]
    prompt: |
      Задача: {{input}}

      План:
      {{prev}}

      Реализуй план. Закончи ответ разделом "## Результат": что изменено, какие команды запускал, что осталось.
`;
}
