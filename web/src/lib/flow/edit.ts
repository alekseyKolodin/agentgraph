// Рабочая копия flow в конструкторе (порт ui/app.js «конструктор»): заготовки этапов и блоков, переменные промпта,
// перестановки, переименование, сборка spec для сохранения и разница двух версий для «Правки с ИИ». Без React и DOM.
// Рабочая копия всегда в полной форме (blocks) и правится на месте: короткую (loop + phases) сервер восстановит при сохранении.
import type { FlowSpec } from '@server/schema';
import { blockHeading, blockSteps, isGroupStep, stepSource, type GraphBlock } from '../graph/model';

export { blockHeading };

export type EditUntil = { type: 'command' | 'judge' | 'marker' | 'none'; run?: string; timeout_sec?: number; prompt?: string; model?: string; marker?: string; phase?: string };
export type EditLoop = { max_iterations: number; until: EditUntil; pause_marker?: string };
export type EditPhase = {
  name: string;
  title?: string;
  prompt: string;
  handoff?: string;
  system?: string;
  tools: string[];
  reads?: string[];
  writes?: string[];
  add_dirs?: string[] | undefined;
  /** Плагины этапа в конструкторе не правятся, но сохраняются как есть. */
  plugins?: string[];
  model?: string;
  effort?: string;
  /** Поля чисел — как в поле ввода: строка, пока не сохранили. */
  max_turns?: number | string;
  permission_mode?: string;
  max_budget_usd?: number | string;
  output_schema?: Record<string, unknown>;
  group?: string;
  /** Текст поля «Схема вывода», пока он правится: JSON разбирается при сохранении. */
  _schemaText?: string;
};
export type EditBlock = {
  name: string;
  title?: string;
  loop?: EditLoop;
  on_fail?: 'stop' | 'continue';
  knowledge?: string[];
  /** Плагины блока в конструкторе не правятся, но сохраняются как есть. */
  plugins?: string[];
  phases: EditPhase[];
  /** Цикл, снятый переключением «один проход»: вернётся при обратном переключении. */
  _savedLoop?: EditLoop;
};
export type EditSpec = {
  name: string;
  description?: string;
  input?: string;
  defaults?: Record<string, unknown>;
  artifacts?: Record<string, { title?: string; file?: string; initial?: string; decisions?: boolean }>;
  blocks: EditBlock[];
};

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');

/** Короткая форма flow (loop + phases) — один блок main. */
export function toEditable(spec: FlowSpec): EditSpec {
  const s = clone(spec) as unknown as EditSpec & { loop?: EditLoop; phases?: EditPhase[] };
  if (!s.blocks) {
    s.blocks = [{ name: 'main', ...(s.loop ? { loop: s.loop } : {}), phases: s.phases || [] }];
    delete s.loop;
    delete s.phases;
  }
  return s;
}

export const allPhases = (spec: EditSpec): EditPhase[] => spec.blocks.flatMap((b) => b.phases);
export const isMulti = (spec: EditSpec): boolean => spec.blocks.length > 1;
export const blockLabel = (b: { name: string; title?: string }, bi: number): string => b.title || (b.name === 'main' ? `Блок ${bi + 1}` : b.name);
export const phaseNum = (spec: EditSpec, bi: number, i: number): string => (isMulti(spec) ? `${bi + 1}.${i + 1}` : `${i + 1}`);
export const DEFAULT_JUDGE = 'Задача: {{input}}\n\nВыводы этапов текущей итерации:\n{{outputs}}\n\nРубрика: done=true только если задача выполнена целиком. Иначе перечисли в feedback конкретные пробелы.';

const asGraph = (b: EditBlock) => b as unknown as GraphBlock;

export type Variable = { key: string; label: string; hint: string };

/** Переменные, доступные этапу idx блока bi: чипы над промптом и строка «получает» на графе. */
export function variableList(spec: EditSpec, bi: number, idx: number): Variable[] {
  const block = spec.blocks[bi]!;
  const steps = blockSteps(asGraph(block));
  const si = steps.findIndex((s) => idx >= s.from && idx <= s.to);
  const step = steps[si];
  const prevStep = si > 0 ? steps[si - 1]! : null;
  const prevBlock = bi > 0 ? spec.blocks[bi - 1]! : null;
  const prevBlockEnd = prevBlock ? blockSteps(asGraph(prevBlock)).at(-1) : null;
  const ownLast = steps.at(-1);
  const ownEnd = isGroupStep(ownLast) ? `склейка выводов группы ${ownLast!.group} этого блока` : 'последнего этапа этого блока';
  let prev: { label: string; hint: string } = prevStep
    ? isGroupStep(prevStep)
      ? { label: `Выводы группы ${prevStep.group}`, hint: 'склейка выводов участников группы в порядке объявления' }
      : { label: `Вывод предыдущего (${block.phases[prevStep.from]!.name})`, hint: 'полный ответ предыдущего этапа' }
    : prevBlock
      ? {
          label: `Вывод блока «${blockLabel(prevBlock, bi - 1)}»`,
          hint: `${isGroupStep(prevBlockEnd) ? `склейка выводов группы ${prevBlockEnd!.group}, которой кончается предыдущий блок` : 'ответ последнего этапа предыдущего блока'}${block.loop ? `; на итерации 2+ — ${ownEnd}` : ''}`,
        }
      : { label: 'Вывод последнего этапа прошлой итерации', hint: `на первой итерации пусто${isGroupStep(ownLast) ? `; блок кончается группой — ${ownEnd}` : ''}` };
  // участники группы видят один {{prev}} — то, что было до группы
  if (isGroupStep(step)) prev = { label: 'Вывод до группы', hint: `${prev.label.toLowerCase()}: ${prev.hint}; одинаковый у всех участников группы ${step!.group}` };
  const list: Variable[] = [
    { key: 'input', label: 'Задача', hint: 'задача, введённая при запуске' },
    { key: 'prev', ...prev },
    { key: 'feedback', label: 'Замечания условия', hint: 'вывод команды или замечания судьи после прошлой итерации блока; пусто на первой' },
  ];
  // этапы этого и предыдущих блоков; этапы следующих блоков к этому моменту ещё не выполнялись
  spec.blocks.slice(0, bi + 1).forEach((b, j) => {
    for (const [k, p] of b.phases.entries()) {
      if (p === block.phases[idx]) continue;
      // соседи по группе идут одновременно: на их вывод ссылаться нельзя
      if (j === bi && isGroupStep(step) && k >= step!.from && k <= step!.to) continue;
      const from = j < bi ? ` (блок ${j + 1})` : '';
      list.push({ key: `phases.${p.name}`, label: `Вывод этапа ${p.name}${from}`, hint: 'последний вывод этого этапа' });
    }
  });
  list.push(
    { key: 'iteration', label: '№ итерации', hint: 'номер текущей итерации блока' },
    { key: 'outputs', label: 'Все выводы итерации', hint: 'выводы всех этапов текущей итерации блока' },
    { key: 'history', label: 'История', hint: 'все предыдущие выводы, большая' },
  );
  return list;
}

export const varRe = (key: string): RegExp => new RegExp(`\\{\\{\\s*${key.replace('.', '\\.')}\\s*\\}\\}`);
export const usesVar = (text: string | undefined, key: string): boolean => varRe(key).test(text || '');

/** Текст промпта и handoff: по нему подсвечиваются использованные переменные. */
export const phaseText = (p: EditPhase): string => `${p.prompt || ''}\n${p.handoff || ''}`;

/** Что этап получает: подстановки из его промпта и handoff. Пустой список граф помечает «ничего не получает». */
export function phaseInputs(spec: EditSpec, bi: number, i: number): string[] {
  const b = spec.blocks[bi]!;
  const p = b.phases[i]!;
  const steps = blockSteps(asGraph(b));
  const si = steps.findIndex((s) => i >= s.from && i <= s.to);
  const prevBlock = bi > 0 ? spec.blocks[bi - 1]! : null;
  const prevName = si > 0 ? stepSource(asGraph(b), steps[si - 1]!) : prevBlock ? stepSource(asGraph(prevBlock), blockSteps(asGraph(prevBlock)).at(-1)!) : null;
  const text = phaseText(p);
  return variableList(spec, bi, i)
    .filter((v) => usesVar(text, v.key))
    .map((v) => (v.key === 'prev' ? (prevName ? `← ${prevName}` : '← прошлая итерация') : v.key.startsWith('phases.') ? `← ${v.key.slice(7)}` : v.label.toLowerCase()));
}

/**
 * Вставка переменной в текст: уже есть — вернуть её место для выделения, нет — вставить {{key}} на место выделения
 * (с пробелом, если перед ним не пробел и не перенос). caret — куда поставить курсор.
 */
export function insertVar(text: string, key: string, start: number, end: number): { text: string; select: [number, number] } {
  const m = text.match(varRe(key));
  if (m) {
    const pos = text.indexOf(m[0]);
    return { text, select: [pos, pos + m[0].length] };
  }
  const token = `{{${key}}}`;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const pad = before && !before.endsWith('\n') && !before.endsWith(' ') ? ' ' : '';
  const caret = before.length + pad.length + token.length;
  return { text: `${before}${pad}${token}${after}`, select: [caret, caret] };
}

export function newPhase(spec: EditSpec, bi: number): EditPhase {
  const block = spec.blocks[bi]!;
  const total = allPhases(spec).length + 1;
  let name = `stage-${total}`;
  for (let i = total; allPhases(spec).some((p) => p.name === name); i++) name = `stage-${i + 1}`;
  const n = block.phases.length + 1;
  const first = block.phases.length === 0;
  return {
    name,
    title: `Этап ${n}`,
    tools: ['Read', 'Grep', 'Glob'],
    prompt: first && bi === 0
      ? 'Задача: {{input}}\n\nЗамечания с прошлой итерации (пусто, если первая): {{feedback}}\n\n'
      : first
        ? 'Задача: {{input}}\n\nРезультат предыдущего блока:\n{{prev}}\n\n'
        : 'Задача: {{input}}\n\nРезультат предыдущего этапа:\n{{prev}}\n\n',
    handoff: 'раздел "## Результат": что сделано, какие файлы затронуты, что осталось.',
  };
}

export function newBlock(spec: EditSpec): EditBlock {
  const n = spec.blocks.length + 1;
  let name = `block-${n}`;
  for (let i = n; spec.blocks.some((b) => b.name === name); i++) name = `block-${i + 1}`;
  const block: EditBlock = { name, title: '', phases: [] };
  spec.blocks.push(block);
  block.phases.push(newPhase(spec, spec.blocks.length - 1));
  return block;
}

/** «+» на узле: новый этап после шага (у участника группы — после всей группы); «+» на рамке группы — ещё один участник. */
export function addPhaseAfter(spec: EditSpec, bi: number, i: number, group?: string): number {
  const block = spec.blocks[bi]!;
  const step = blockSteps(asGraph(block)).find((s) => i >= s.from && i <= s.to);
  const at = (step ? step.to : i) + 1;
  const p = newPhase(spec, bi);
  if (group) p.group = group;
  block.phases.splice(at, 0, p);
  return at;
}

/** Этап по имени в рабочей копии: индексы у сохранённого flow и конструктора могут разойтись. */
export function findPhase(spec: EditSpec, name: string): { bi: number; i: number } | null {
  for (const [bi, b] of spec.blocks.entries()) {
    const i = b.phases.findIndex((p) => p.name === name);
    if (i >= 0) return { bi, i };
  }
  return null;
}

/** ↑ / ↓ у этапа: внутри блока — обмен с соседом, с края блока — в соседний блок (группа снимается). Ошибка — текст для notify. */
export function movePhase(spec: EditSpec, bi: number, i: number, up: boolean): string | null {
  const b = spec.blocks[bi]!;
  const p = b.phases[i]!;
  const inside = up ? i > 0 : i < b.phases.length - 1;
  if (inside) {
    const j = up ? i - 1 : i + 1;
    [b.phases[j], b.phases[i]] = [b.phases[i]!, b.phases[j]!];
    return null;
  }
  // с края блока этап переезжает в соседний блок
  const target = spec.blocks[up ? bi - 1 : bi + 1];
  if (!target) return null;
  if (b.phases.length === 1) return 'В блоке должен остаться хотя бы один этап';
  b.phases.splice(i, 1);
  // группа живёт внутри блока: в соседнем блоке этап идёт сам по себе
  delete p.group;
  if (up) target.phases.push(p);
  else target.phases.unshift(p);
  return null;
}

/** ⧉: копия этапа сразу после него с именем <имя>-copy (занято — с двойками). */
export function duplicatePhase(spec: EditSpec, bi: number, i: number): number {
  const b = spec.blocks[bi]!;
  const p = b.phases[i]!;
  const copy = clone(p);
  copy.name = `${p.name}-copy`;
  while (allPhases(spec).some((x) => x.name === copy.name)) copy.name += '2';
  b.phases.splice(i + 1, 0, copy);
  return i + 1;
}

export function moveBlock(spec: EditSpec, bi: number, up: boolean): void {
  const j = up ? bi - 1 : bi + 1;
  if (j < 0 || j >= spec.blocks.length) return;
  [spec.blocks[j], spec.blocks[bi]] = [spec.blocks[bi]!, spec.blocks[j]!];
}

/** Переименование id этапа: ссылки {{phases.X}} в промптах, handoff, рубриках судьи и marker.phase идут следом. Ошибка — текст. */
export function renamePhase(spec: EditSpec, from: string, to: string): string | null {
  if (from === to) return null;
  if (allPhases(spec).some((x) => x.name === to)) return `Этап ${to} уже есть`;
  const re = new RegExp(`\\{\\{\\s*phases\\.${from}\\s*\\}\\}`, 'g');
  for (const x of allPhases(spec)) {
    if (x.name === from) x.name = to;
    x.prompt = (x.prompt || '').replace(re, `{{phases.${to}}}`);
    if (x.handoff) x.handoff = x.handoff.replace(re, `{{phases.${to}}}`);
  }
  for (const b of spec.blocks) {
    const u = b.loop?.until;
    if (u?.type === 'judge') u.prompt = (u.prompt || '').replace(re, `{{phases.${to}}}`);
    if (u?.type === 'marker' && u.phase === from) u.phase = to;
  }
  return null;
}

/** Режим блока: «один проход» снимает цикл и запоминает его, «цикл» возвращает прежний или ставит судью на 3 итерации. */
export function setBlockMode(b: EditBlock, loop: boolean): void {
  if (!loop) {
    b._savedLoop = b.loop;
    delete b.loop;
  } else {
    b.loop = b._savedLoop || { max_iterations: 3, until: { type: 'judge', prompt: DEFAULT_JUDGE } };
  }
}

/** Смена типа условия: заготовка нового типа, введённое раньше для этого типа не теряется. */
export function untilFor(type: string, old: EditUntil): EditUntil {
  return type === 'command' ? { type: 'command', run: old.run || 'npm test' }
    : type === 'judge' ? { type: 'judge', prompt: old.prompt || DEFAULT_JUDGE }
      : type === 'marker' ? { type: 'marker', marker: old.marker || '<DONE>' } : { type: 'none' };
}

export const TAG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Подпись «Дополнительно» у этапа: группа и число доп. директорий. */
export function advLabel(p: EditPhase): string {
  const n = (p.add_dirs || []).filter((x) => x.trim()).length;
  return ['Дополнительно', p.group ? `параллельная группа ${p.group}` : '', n ? `директорий: ${n}` : ''].filter(Boolean).join(' · ');
}

/** Текст поля «Схема вывода»: правится строкой, пока не сохранят. */
export const schemaText = (p: EditPhase): string => p._schemaText ?? (p.output_schema ? JSON.stringify(p.output_schema, null, 2) : '');

/** Поле, к которому перейти после ошибки сохранения: этап (индексы и класс поля) или ничего. */
export type FieldRef = { b: number; i: number; field: 'p-name' | 'p-schema' };
export class SpecError extends Error {
  readonly field: FieldRef | undefined;
  constructor(message: string, field?: FieldRef) {
    super(message);
    this.name = 'SpecError';
    this.field = field;
  }
}

function collectPhase(p: EditPhase, num: string, seen: Set<string>, at: { b: number; i: number }): Record<string, unknown> {
  const fail = (message: string, field: FieldRef['field']) => new SpecError(message, { ...at, field });
  const out: Record<string, unknown> = { name: slug(p.name), title: (p.title || '').trim(), prompt: p.prompt || '', tools: p.tools || [] };
  const name = out.name as string;
  if (!name) throw fail(`Этап ${num}: пустой идентификатор`, 'p-name');
  if (seen.has(name)) throw fail(`Этап ${num}: идентификатор ${name} повторяется (имена этапов уникальны в пределах flow)`, 'p-name');
  seen.add(name);
  if (!out.title) delete out.title;
  if ((p.handoff || '').trim()) out.handoff = p.handoff!.trim();
  const dirs = (p.add_dirs || []).map((x) => x.trim()).filter(Boolean);
  if (dirs.length) out.add_dirs = dirs;
  if ((p.system || '').trim()) out.system = p.system!.trim();
  if ((p.model || '').trim()) out.model = p.model!.trim();
  if (p.effort) out.effort = p.effort;
  if (p.permission_mode) out.permission_mode = p.permission_mode;
  if (Number(p.max_turns) > 0) out.max_turns = Number(p.max_turns);
  if (Number(p.max_budget_usd) > 0) out.max_budget_usd = Number(p.max_budget_usd);
  if (slug(p.group || '')) out.group = slug(p.group!);
  // доступ к артефактам в конструкторе не правится, но сохраняется как есть: иначе сохранение выбросило бы контракт
  if (Array.isArray(p.reads) && p.reads.length) out.reads = [...p.reads];
  if (Array.isArray(p.writes) && p.writes.length) out.writes = [...p.writes];
  // плагины тоже не правятся в конструкторе: сохранение их не теряет
  if (Array.isArray(p.plugins) && p.plugins.length) out.plugins = [...p.plugins];
  const text = p._schemaText !== undefined ? p._schemaText : p.output_schema ? JSON.stringify(p.output_schema) : '';
  if (text.trim()) {
    try {
      out.output_schema = JSON.parse(text);
    } catch {
      throw fail(`Этап ${name}: схема вывода — невалидный JSON`, 'p-schema');
    }
  }
  return out;
}

/** spec для сохранения: чистые поля, проверки id. Ошибка — SpecError с полем этапа, к которому перейти. */
export function collectSpec(spec: EditSpec): Record<string, unknown> {
  const s = clone(spec) as Omit<EditSpec, 'blocks'> & { blocks: unknown[] };
  const seenPhases = new Set<string>();
  const seenBlocks = new Set<string>();
  const multi = s.blocks.length > 1;
  s.blocks = (s.blocks as EditBlock[]).map((b, bi) => {
    const out: Record<string, unknown> = { name: slug(b.name) };
    const name = out.name as string;
    if (!name) throw new SpecError(`Блок ${bi + 1}: пустой идентификатор`);
    if (seenBlocks.has(name)) throw new SpecError(`Блок ${bi + 1}: идентификатор ${name} повторяется`);
    seenBlocks.add(name);
    if ((b.title || '').trim()) out.title = b.title!.trim();
    if (b.loop) out.loop = b.loop;
    // у одиночного блока on_fail не показывается в конструкторе, поэтому и не сохраняется
    if (multi && b.loop && b.on_fail === 'continue') out.on_fail = 'continue';
    if (Array.isArray(b.knowledge) && b.knowledge.length) out.knowledge = [...b.knowledge];
    if (Array.isArray(b.plugins) && b.plugins.length) out.plugins = [...b.plugins];
    out.phases = b.phases.map((p, i) => collectPhase(p, `${bi + 1}.${i + 1}`, seenPhases, { b: bi, i }));
    return out;
  });
  if (!(s.description || '').trim()) delete s.description;
  else s.description = s.description!.trim();
  if (!(s.input || '').trim()) delete s.input;
  else s.input = s.input!.trim();
  return s as unknown as Record<string, unknown>;
}

// ---------- правка flow ИИ: что поменялось между двумя версиями

const PHASE_FIELDS: Record<string, string> = {
  title: 'название', prompt: 'промпт', handoff: 'что передать следующему этапу', tools: 'инструменты', add_dirs: 'дополнительные директории', system: 'системный промпт',
  model: 'модель', effort: 'effort', max_turns: 'лимит ходов', permission_mode: 'права', max_budget_usd: 'лимит стоимости',
  output_schema: 'схема вывода', group: 'параллельная группа', reads: 'читает артефакты', writes: 'пишет артефакты', plugins: 'плагины',
};
const ADV_FIELDS = ['name', 'add_dirs', 'system', 'model', 'effort', 'max_turns', 'permission_mode', 'max_budget_usd', 'output_schema', 'group'];
const norm = (v: unknown) => (v === '' || v === undefined ? null : v);
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const field = (o: object | undefined, k: string): unknown => (o as Record<string, unknown> | undefined)?.[k];

export type SpecChanges = {
  lines: { text: string; phase?: string }[];
  /** Изменённые этапы и блоки — подсветка на графе и в ленте; adv — у кого раскрыть «Дополнительно». */
  phases: Set<string>;
  blocks: Set<string>;
  adv: Set<string>;
};

/** Что поменялось между двумя версиями flow: строки для списка + имена изменённых этапов и блоков для подсветки. */
export function specChanges(before: EditSpec | null, after: EditSpec): SpecChanges {
  const out: SpecChanges = { lines: [], phases: new Set(), blocks: new Set(), adv: new Set() };
  if (!before) return out;
  const top = ([['description', 'описание'], ['input', 'задача по умолчанию'], ['defaults', 'настройки по умолчанию'], ['artifacts', 'артефакты']] as const)
    .filter(([k]) => !same(before[k], after[k])).map(([, label]) => label);
  if (top.length) out.lines.push({ text: `Flow: ${top.join(', ')}` });

  const where = (spec: EditSpec) => new Map(spec.blocks.flatMap((b, bi) => b.phases.map((p) => [p.name, { p, b, bi }] as const)));
  const was = where(before);
  const now = where(after);
  const oldBlocks = new Map(before.blocks.map((b) => [b.name, b]));
  const names = (list: EditPhase[], other: EditPhase[]) => list.map((p) => p.name).filter((n) => other.some((q) => q.name === n));
  after.blocks.forEach((b, bi) => {
    const label = `Блок «${blockLabel(b, bi)}»`;
    const old = oldBlocks.get(b.name);
    if (!old) {
      out.lines.push({ text: `${label}: добавлен` });
      out.blocks.add(b.name);
      return;
    }
    const f: string[] = [];
    if (!same(old.title, b.title)) f.push('название');
    if (!same(old.loop, b.loop)) f.push(old.loop && b.loop ? 'цикл и условие' : b.loop ? 'стал циклом' : 'стал одним проходом');
    if (!same(old.on_fail, b.on_fail)) f.push('что делать, если условие не выполнено');
    if (!same(old.knowledge, b.knowledge)) f.push('теги знаний');
    if (!same(old.plugins, b.plugins)) f.push('плагины');
    if (!same(names(old.phases, b.phases), names(b.phases, old.phases))) f.push('порядок этапов');
    if (f.length) {
      out.lines.push({ text: `${label}: ${f.join(', ')}` });
      out.blocks.add(b.name);
    }
  });
  for (const b of before.blocks) if (!after.blocks.some((x) => x.name === b.name)) out.lines.push({ text: `Блок «${b.title || b.name}»: удалён` });

  for (const [name, n] of now) {
    const label = `Этап ${n.p.title ? `«${n.p.title}» (${name})` : name}`;
    const o = was.get(name);
    if (ADV_FIELDS.some((k) => !same(field(o?.p, k), field(n.p, k)))) out.adv.add(name);
    if (!o) {
      out.lines.push({ text: `${label}: добавлен`, phase: name });
      out.phases.add(name);
      continue;
    }
    const f = Object.entries(PHASE_FIELDS).filter(([k]) => !same(field(o.p, k), field(n.p, k))).map(([, l]) => l);
    if (o.b.name !== n.b.name) f.push(`перенесён в блок «${blockLabel(n.b, n.bi)}»`);
    if (f.length) {
      out.lines.push({ text: `${label}: ${f.join(', ')}`, phase: name });
      out.phases.add(name);
    }
  }
  for (const name of was.keys()) if (!now.has(name)) out.lines.push({ text: `Этап ${name}: удалён` });
  return out;
}
