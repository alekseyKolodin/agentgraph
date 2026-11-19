// Шаги «Правки с ИИ» словами: после каждого Read/Edit/Write агента над файлом flow сервер сравнивает текст файла
// с прошлым снимком и отдаёт, что поменялось — этап добавлен, у этапа правится промпт, добавлен файл. UI пишет из этого
// «Добавил этап «…»», «Правлю этап «…»: промпт» вместо сырого лога. Сравнение — по сырому YAML, без валидации:
// посреди правки flow бывает временно невалиден (этап уже читает артефакт, которого ещё нет), а шаг всё равно виден.
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { FlowEditStep } from './api-types.js';
import type { SessionEvent } from './agent.js';

type Obj = Record<string, unknown>;
type Phase = { name: string; title?: string; raw: Obj };
type Block = { name: string; title?: string; raw: Obj; phases: Phase[] };
/** Разобранный снимок файла: блоки (короткая форма — один блок main), этапы, артефакты, поля flow. */
export type FlowShape = { blocks: Block[]; phases: Map<string, Phase>; artifacts: Map<string, Obj>; top: Obj };

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Текст flow.yaml → форма для сравнения; не YAML или не объект — null (снимок не меняется). */
export function flowShape(yaml: string): FlowShape | null {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : [{ name: 'main', loop: raw.loop, phases: raw.phases }];
  const phases = new Map<string, Phase>();
  const blocks: Block[] = rawBlocks.filter(isObj).map((b, bi) => {
    const list = (Array.isArray(b.phases) ? b.phases : []).filter(isObj).map((p, i): Phase => ({ name: str(p.name) ?? `#${bi}.${i}`, title: str(p.title), raw: p }));
    for (const p of list) phases.set(p.name, p);
    return { name: str(b.name) ?? `#${bi}`, title: str(b.title), raw: b, phases: list };
  });
  const artifacts = new Map<string, Obj>();
  if (isObj(raw.artifacts)) for (const [k, v] of Object.entries(raw.artifacts)) artifacts.set(k, isObj(v) ? v : {});
  return { blocks, phases, artifacts, top: raw };
}

/** Поля, которые отличаются у двух объектов (порядок — как в новом, потом пропавшие). */
function fieldsDiff(a: Obj, b: Obj, skip: readonly string[] = []): string[] {
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !skip.includes(k));
  return keys.filter((k) => !same(a[k], b[k]));
}

const TOP_FIELDS = ['description', 'input', 'defaults'] as const;
const BLOCK_SKIP = ['name', 'phases'] as const;

/** Что поменялось от снимка before к after: шаги в порядке «flow → блоки → этапы → файлы». */
export function shapeSteps(before: FlowShape, after: FlowShape): FlowEditStep[] {
  const out: FlowEditStep[] = [];
  const top = TOP_FIELDS.filter((k) => !same(before.top[k], after.top[k]));
  if (top.length) out.push({ kind: 'edit', what: 'flow', name: '', fields: [...top] });

  const oldBlocks = new Map(before.blocks.map((b) => [b.name, b]));
  for (const b of after.blocks) {
    const old = oldBlocks.get(b.name);
    const title = b.title;
    if (!old) {
      out.push({ kind: 'add', what: 'block', name: b.name, ...(title ? { title } : {}) });
      continue;
    }
    const fields = fieldsDiff(old.raw, b.raw, BLOCK_SKIP);
    if (fields.length) out.push({ kind: 'edit', what: 'block', name: b.name, ...(title ? { title } : {}), fields });
  }
  const newBlocks = new Set(after.blocks.map((b) => b.name));
  for (const b of before.blocks) if (!newBlocks.has(b.name)) out.push({ kind: 'remove', what: 'block', name: b.name, ...(b.title ? { title: b.title } : {}) });

  for (const p of after.phases.values()) {
    const old = before.phases.get(p.name);
    const title = p.title;
    if (!old) {
      out.push({ kind: 'add', what: 'phase', name: p.name, ...(title ? { title } : {}) });
      continue;
    }
    const fields = fieldsDiff(old.raw, p.raw, ['name']);
    if (fields.length) out.push({ kind: 'edit', what: 'phase', name: p.name, ...(title ? { title } : {}), fields });
  }
  for (const p of before.phases.values()) if (!after.phases.has(p.name)) out.push({ kind: 'remove', what: 'phase', name: p.name, ...(p.title ? { title: p.title } : {}) });

  for (const [key, a] of after.artifacts) {
    const old = before.artifacts.get(key);
    const file = str(a.file);
    if (!old) out.push({ kind: 'add', what: 'artifact', name: key, ...(file ? { title: file } : {}) });
    else {
      const fields = fieldsDiff(old, a);
      if (fields.length) out.push({ kind: 'edit', what: 'artifact', name: key, ...(file ? { title: file } : {}), fields });
    }
  }
  for (const [key, a] of before.artifacts) if (!after.artifacts.has(key)) out.push({ kind: 'remove', what: 'artifact', name: key, ...(str(a.file) ? { title: str(a.file) } : {}) });
  return out;
}

/** «Прочитал flow»: сколько блоков, этапов и файлов. */
export const readStep = (s: FlowShape): FlowEditStep => ({ kind: 'read', blocks: s.blocks.length, phases: s.phases.size, artifacts: s.artifacts.size });

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);

/**
 * Следит за ходом сессии правки: вызов Read/Edit/Write с путём file → по его результату читает файл и отдаёт шаги.
 * Первый Read — шаг «прочитал»; правки — что поменялось с прошлого снимка (несколько правок одного этапа UI склеит сам).
 * Ошибка инструмента или нечитаемый файл — шага нет, снимок прежний.
 */
export function stepWatcher(file: string, readFile: () => string, onStep: (s: FlowEditStep) => void): (e: SessionEvent) => void {
  const pending = new Map<string, string>();
  let snap = flowShape(safeRead(readFile));
  let read = false;
  // наблюдатель зовут синхронно из цикла сессии: его сбой (например, YAML с циклическим якорем) не роняет правку — шага просто нет
  return (e) => {
    try {
      watch(e);
    } catch {
      /* без шага */
    }
  };
  function watch(e: SessionEvent): void {
    if (e.kind === 'tool_use') {
      // путь агент пишет как хочет (абсолютный, через /var вместо /private/var, относительный): файл во временной
      // папке правки один, и читаем всё равно только его — достаточно имени
      const p = typeof e.input.file_path === 'string' ? e.input.file_path : '';
      if (FILE_TOOLS.has(e.name) && p && path.basename(p) === path.basename(file) && !e.parent) pending.set(e.id, e.name);
      return;
    }
    if (e.kind !== 'tool_result') return;
    const tool = pending.get(e.toolUseId);
    if (!tool) return;
    pending.delete(e.toolUseId);
    if (e.isError) return;
    if (tool === 'Read') {
      if (!read && snap) onStep(readStep(snap));
      read = true;
      return;
    }
    const next = flowShape(safeRead(readFile));
    if (!next) return;
    if (snap) for (const s of shapeSteps(snap, next)) onStep(s);
    snap = next;
  }
}

function safeRead(readFile: () => string): string {
  try {
    return readFile();
  } catch {
    return '';
  }
}
