// Рабочая копия flow в конструкторе (порт ui/app.js «конструктор»): заготовки этапов и блоков, переменные промпта,
// перестановки, переименование, сборка spec для сохранения и разница двух версий для «Правки с ИИ». Без React и DOM.
// Рабочая копия всегда в полной форме (blocks) и правится на месте: короткую (loop + phases) сервер восстановит при сохранении.
import type { FlowSpec } from '@server/schema';
import { blockHeading, blockSteps, isGroupStep, NEXT_END, nextRulesOf, stepSource, type GraphBlock } from '../graph/model';
import { t } from '../i18n';

export { blockHeading };

export type EditUntil = { type: 'command' | 'judge' | 'marker' | 'none'; run?: string; timeout_sec?: number; prompt?: string; model?: string; marker?: string; phase?: string };
export type EditLoop = { max_iterations: number; until: EditUntil; pause_marker?: string };
/** Правило развилки: условие (как until, без none) или «всегда», и куда идти — блок ниже или end. */
export type EditNextRule = { if?: EditUntil; goto: string };
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
  /** Папки плагинов Claude Code этапа. */
  plugins?: string[] | undefined;
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
  /** Папки плагинов Claude Code для всех этапов блока. */
  plugins?: string[];
  /** У блока-вызова этапов нет: phases пустой, этапы — в вызываемом flow. */
  phases: EditPhase[];
  /** Блок-вызов: имя вызываемого flow ('' — ещё не выбран) и шаблон его задачи. */
  flow?: string;
  input?: string;
  /** Развилка после блока: строка (всегда туда) или правила по порядку. */
  next?: string | EditNextRule[];
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
  // у блока-вызова в YAML phases нет; в рабочей копии — пустой список, как ждут лента и правка ИИ
  for (const b of s.blocks) b.phases ??= [];
  return s;
}

export const isCall = (b: Pick<EditBlock, 'flow'>): boolean => b.flow !== undefined;
/** Правила next блока списком: строка — одно безусловное правило. */
export const nextRules = (b: Pick<EditBlock, 'next'>): EditNextRule[] => nextRulesOf(b as Pick<GraphBlock, 'next'>) as EditNextRule[];

export const allPhases = (spec: EditSpec): EditPhase[] => spec.blocks.flatMap((b) => b.phases);
export const isMulti = (spec: EditSpec): boolean => spec.blocks.length > 1;
export const blockLabel = (b: { name: string; title?: string }, bi: number): string => b.title || (b.name === 'main' ? t('Блок {n}', { n: bi + 1 }) : b.name);
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
  const ownEnd = isGroupStep(ownLast) ? t('склейка выводов группы {g} этого блока', { g: ownLast!.group! }) : t('последнего этапа этого блока');
  let prev: { label: string; hint: string } = prevStep
    ? isGroupStep(prevStep)
      ? { label: t('Выводы группы {g}', { g: prevStep.group! }), hint: t('склейка выводов участников группы в порядке объявления') }
      : { label: t('Вывод предыдущего ({name})', { name: block.phases[prevStep.from]!.name }), hint: t('полный ответ предыдущего этапа') }
    : prevBlock && isCall(prevBlock)
      ? { label: t('Итог блока «{block}»', { block: blockLabel(prevBlock, bi - 1) }), hint: t('итог вызванного flow {flow}: вывод его последнего шага', { flow: prevBlock.flow || '…' }) }
      : prevBlock
      ? {
          label: t('Вывод блока «{block}»', { block: blockLabel(prevBlock, bi - 1) }),
          hint: `${isGroupStep(prevBlockEnd) ? t('склейка выводов группы {g}, которой кончается предыдущий блок', { g: prevBlockEnd!.group! }) : t('ответ последнего этапа предыдущего блока')}${block.loop ? t('; на итерации 2+ — {end}', { end: ownEnd }) : ''}`,
        }
      : { label: t('Вывод последнего этапа прошлой итерации'), hint: `${t('на первой итерации пусто')}${isGroupStep(ownLast) ? t('; блок кончается группой — {end}', { end: ownEnd }) : ''}` };
  // участники группы видят один {{prev}} — то, что было до группы
  if (isGroupStep(step)) prev = { label: t('Вывод до группы'), hint: t('{label}: {hint}; одинаковый у всех участников группы {g}', { label: prev.label.toLowerCase(), hint: prev.hint, g: step!.group! }) };
  const list: Variable[] = [
    { key: 'input', label: t('Задача'), hint: t('задача, введённая при запуске') },
    { key: 'prev', ...prev },
    { key: 'feedback', label: t('Замечания условия'), hint: t('вывод команды или замечания судьи после прошлой итерации блока; пусто на первой') },
  ];
  // этапы этого и предыдущих блоков; этапы следующих блоков к этому моменту ещё не выполнялись
  spec.blocks.slice(0, bi + 1).forEach((b, j) => {
    // итог блока-вызова — {{phases.<имя блока>}}
    if (isCall(b) && j < bi) list.push({ key: `phases.${b.name}`, label: t('Итог вызова {flow} (блок {n})', { flow: b.flow || '…', n: j + 1 }), hint: t('итог вызванного flow: вывод его последнего шага') });
    for (const [k, p] of b.phases.entries()) {
      if (p === block.phases[idx]) continue;
      // соседи по группе идут одновременно: на их вывод ссылаться нельзя
      if (j === bi && isGroupStep(step) && k >= step!.from && k <= step!.to) continue;
      const label = j < bi ? t('Вывод этапа {name} (блок {n})', { name: p.name, n: j + 1 }) : t('Вывод этапа {name}', { name: p.name });
      list.push({ key: `phases.${p.name}`, label, hint: t('последний вывод этого этапа') });
    }
  });
  list.push(
    { key: 'iteration', label: t('№ итерации'), hint: t('номер текущей итерации блока') },
    { key: 'outputs', label: t('Все выводы итерации'), hint: t('выводы всех этапов текущей итерации блока') },
    { key: 'history', label: t('История'), hint: t('все предыдущие выводы, большая') },
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
  if (isCall(b)) return callInputs(spec, bi);
  const p = b.phases[i]!;
  const steps = blockSteps(asGraph(b));
  const si = steps.findIndex((s) => i >= s.from && i <= s.to);
  const prevBlock = bi > 0 ? spec.blocks[bi - 1]! : null;
  const prevName = si > 0 ? stepSource(asGraph(b), steps[si - 1]!) : prevBlock ? blockSource(prevBlock) : null;
  const text = phaseText(p);
  return variableList(spec, bi, i)
    .filter((v) => usesVar(text, v.key))
    .map((v) => (v.key === 'prev' ? (prevName ? `← ${prevName}` : t('← прошлая итерация')) : v.key.startsWith('phases.') ? `← ${v.key.slice(7)}` : v.label.toLowerCase()));
}

/** Источник {{prev}} от конца блока: последний шаг блока этапов или сам блок-вызов. */
const blockSource = (b: EditBlock): string => (isCall(b) ? b.name : stepSource(asGraph(b), blockSteps(asGraph(b)).at(-1)!));

/** Шаблон задачи вызываемого flow по умолчанию — так его собирает раннер (callInput в src/compose.ts). */
export const DEFAULT_CALL_INPUT = '{{input}}\n\n## Результат предыдущего шага\n{{prev}}\n\n## Замечания проверки\n{{feedback}}';

/** Переменные задачи вызываемого flow: как у первого этапа блока, без {{outputs}} — до вызова выводов итерации ещё нет. */
export function callVariables(spec: EditSpec, bi: number): Variable[] {
  const b = spec.blocks[bi]!;
  const prevBlock = bi > 0 ? spec.blocks[bi - 1]! : null;
  const list: Variable[] = [
    { key: 'input', label: t('Задача'), hint: t('задача, введённая при запуске') },
    prevBlock
      ? { key: 'prev', label: t('Вывод блока «{block}»', { block: blockLabel(prevBlock, bi - 1) }), hint: b.loop ? t('на итерации 2+ — итог прошлого вызова') : t('вывод последнего шага предыдущего блока') }
      : { key: 'prev', label: t('Итог прошлого вызова'), hint: t('на первой итерации пусто') },
    { key: 'feedback', label: t('Замечания условия'), hint: t('вывод команды или замечания судьи после прошлой итерации блока; пусто на первой') },
  ];
  spec.blocks.slice(0, bi + 1).forEach((x, j) => {
    if (isCall(x)) {
      if (j < bi) list.push({ key: `phases.${x.name}`, label: t('Итог вызова {flow} (блок {n})', { flow: x.flow || '…', n: j + 1 }), hint: t('итог вызванного flow: вывод его последнего шага') });
      return;
    }
    for (const p of x.phases) list.push({ key: `phases.${p.name}`, label: t('Вывод этапа {name} (блок {n})', { name: p.name, n: j + 1 }), hint: t('последний вывод этого этапа') });
  });
  list.push(
    { key: 'iteration', label: t('№ итерации'), hint: t('номер текущей итерации блока') },
    { key: 'history', label: t('История'), hint: t('все предыдущие выводы, большая') },
  );
  return list;
}

/** Что получает вызов: подстановки из шаблона input, без него — задача, итог прошлого шага и замечания. */
export function callInputs(spec: EditSpec, bi: number): string[] {
  const b = spec.blocks[bi]!;
  const text = b.input ?? DEFAULT_CALL_INPUT;
  const prevBlock = bi > 0 ? spec.blocks[bi - 1]! : null;
  return callVariables(spec, bi)
    .filter((v) => usesVar(text, v.key))
    .map((v) => (v.key === 'prev' ? (prevBlock ? `← ${blockSource(prevBlock)}` : t('← прошлая итерация')) : v.key.startsWith('phases.') ? `← ${v.key.slice(7)}` : v.label.toLowerCase()));
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

/** Новый блок в конце: с одним этапом или, с flow, блок-вызов этого flow ('' — выбрать потом). */
export function newBlock(spec: EditSpec, flow?: string): EditBlock {
  const n = spec.blocks.length + 1;
  let name = `block-${n}`;
  // имя блока-вызова — и имя его итога {{phases.<имя>}}: не совпадает и с этапами
  const taken = (x: string) => spec.blocks.some((b) => b.name === x) || allPhases(spec).some((p) => p.name === x);
  for (let i = n; taken(name); i++) name = `block-${i + 1}`;
  const block: EditBlock = { name, title: '', phases: [], ...(flow !== undefined ? { flow } : {}) };
  spec.blocks.push(block);
  if (flow === undefined) block.phases.push(newPhase(spec, spec.blocks.length - 1));
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
  if (isCall(target)) return t('Соседний блок вызывает flow: этапов у него нет, перенеси этап в блок с этапами');
  if (b.phases.length === 1) return t('В блоке должен остаться хотя бы один этап');
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
  if (allPhases(spec).some((x) => x.name === to)) return t('Этап {name} уже есть', { name: to });
  const re = new RegExp(`\\{\\{\\s*phases\\.${from}\\s*\\}\\}`, 'g');
  for (const x of allPhases(spec)) {
    if (x.name === from) x.name = to;
    x.prompt = (x.prompt || '').replace(re, `{{phases.${to}}}`);
    if (x.handoff) x.handoff = x.handoff.replace(re, `{{phases.${to}}}`);
  }
  renameRefs(spec, re, to);
  for (const b of spec.blocks) {
    const u = b.loop?.until;
    if (u?.type === 'marker' && u.phase === from) u.phase = to;
    for (const r of nextRules(b)) if (r.if?.type === 'marker' && r.if.phase === from) r.if.phase = to;
  }
  return null;
}

/** {{phases.<from>}} → {{phases.<to>}} вне промптов этапов: рубрики судей цикла и развилки, задачи вызовов. */
function renameRefs(spec: EditSpec, re: RegExp, to: string): void {
  const sub = (text: string | undefined) => (text || '').replace(re, `{{phases.${to}}}`);
  for (const b of spec.blocks) {
    const u = b.loop?.until;
    if (u?.type === 'judge') u.prompt = sub(u.prompt);
    if (b.input !== undefined) b.input = sub(b.input);
    for (const r of nextRules(b)) if (r.if?.type === 'judge') r.if.prompt = sub(r.if.prompt);
  }
}

/**
 * Переименование id блока: переходы next идут следом; у блока-вызова имя — ещё и его итог {{phases.<имя>}}, ссылки на него
 * в промптах и рубриках тоже. Ошибка — текст.
 */
export function renameBlock(spec: EditSpec, from: string, to: string): string | null {
  if (from === to) return null;
  if (spec.blocks.some((b) => b.name === to)) return t('Блок {name} уже есть', { name: to });
  const block = spec.blocks.find((b) => b.name === from);
  if (!block) return null;
  if (isCall(block)) {
    if (allPhases(spec).some((p) => p.name === to)) return t('Этап {name} уже есть', { name: to });
    const re = new RegExp(`\\{\\{\\s*phases\\.${from}\\s*\\}\\}`, 'g');
    for (const p of allPhases(spec)) {
      p.prompt = (p.prompt || '').replace(re, `{{phases.${to}}}`);
      if (p.handoff) p.handoff = p.handoff.replace(re, `{{phases.${to}}}`);
    }
    renameRefs(spec, re, to);
  }
  block.name = to;
  for (const b of spec.blocks) {
    if (typeof b.next === 'string') {
      if (b.next === from) b.next = to;
    } else for (const r of b.next || []) if (r.goto === from) r.goto = to;
  }
  return null;
}

/** Куда может вести правило next блока bi: блоки ниже и конец запуска. */
export function nextTargets(spec: EditSpec, bi: number): { value: string; label: string }[] {
  return [
    ...spec.blocks.slice(bi + 1).map((b, k) => ({ value: b.name, label: blockHeading(b, bi + 1 + k) })),
    { value: NEXT_END, label: t('конец запуска') },
  ];
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

/** Подпись «Дополнительно» у этапа: группа, число доп. директорий и плагинов. */
export function advLabel(p: EditPhase): string {
  const n = (p.add_dirs || []).filter((x) => x.trim()).length;
  const np = (p.plugins || []).filter((x) => x.trim()).length;
  return [t('Дополнительно'), p.group ? t('параллельная группа {g}', { g: p.group }) : '', n ? t('директорий: {n}', { n }) : '', np ? t('плагинов: {n}', { n: np }) : ''].filter(Boolean).join(' · ');
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
  if (!name) throw fail(t('Этап {num}: пустой идентификатор', { num }), 'p-name');
  if (seen.has(name)) throw fail(t('Этап {num}: идентификатор {name} повторяется (имена этапов уникальны в пределах flow)', { num, name }), 'p-name');
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
  const plugins = (p.plugins || []).map((x) => x.trim()).filter(Boolean);
  if (plugins.length) out.plugins = plugins;
  const text = p._schemaText !== undefined ? p._schemaText : p.output_schema ? JSON.stringify(p.output_schema) : '';
  if (text.trim()) {
    try {
      out.output_schema = JSON.parse(text);
    } catch {
      throw fail(t('Этап {name}: схема вывода — невалидный JSON', { name }), 'p-schema');
    }
  }
  return out;
}

/** next для сохранения: одно безусловное правило — строкой, пустой список — без поля. Условие — только его поля. */
function collectNext(b: EditBlock): string | Record<string, unknown>[] | undefined {
  const rules = nextRules(b);
  if (!rules.length) return undefined;
  if (rules.length === 1 && !rules[0]!.if) return rules[0]!.goto;
  return rules.map((r) => {
    if (!r.if) return { goto: r.goto };
    const u = r.if;
    const cond = u.type === 'command' ? { type: u.type, run: u.run || '', ...(u.timeout_sec ? { timeout_sec: u.timeout_sec } : {}) }
      : u.type === 'judge' ? { type: u.type, prompt: u.prompt || '', ...(u.model ? { model: u.model } : {}) }
        : { type: 'marker', marker: u.marker || '', ...(u.phase ? { phase: u.phase } : {}) };
    return { if: cond, goto: r.goto };
  });
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
    if (!name) throw new SpecError(t('Блок {n}: пустой идентификатор', { n: bi + 1 }));
    if (seenBlocks.has(name)) throw new SpecError(t('Блок {n}: идентификатор {name} повторяется', { n: bi + 1, name }));
    seenBlocks.add(name);
    if ((b.title || '').trim()) out.title = b.title!.trim();
    if (isCall(b)) {
      const flow = (b.flow || '').trim();
      if (!flow) throw new SpecError(t('Блок {n}: не выбран вызываемый flow', { n: bi + 1 }));
      out.flow = flow;
      // пустая задача — та, что по умолчанию: поле input не пишется
      if ((b.input || '').trim()) out.input = b.input;
      // имя блока-вызова — имя его итога {{phases.<имя>}}: с этапами не совпадает
      if (seenPhases.has(name)) throw new SpecError(t('Блок {n}: идентификатор {name} уже занят этапом', { n: bi + 1, name }));
      seenPhases.add(name);
    }
    if (b.loop) out.loop = b.loop;
    // у одиночного блока on_fail не показывается в конструкторе, поэтому и не сохраняется
    if (multi && b.loop && b.on_fail === 'continue') out.on_fail = 'continue';
    if (Array.isArray(b.knowledge) && b.knowledge.length) out.knowledge = [...b.knowledge];
    const plugins = (b.plugins || []).map((x) => x.trim()).filter(Boolean);
    if (plugins.length) out.plugins = plugins;
    const next = collectNext(b);
    if (next !== undefined) out.next = next;
    if (!isCall(b)) out.phases = b.phases.map((p, i) => collectPhase(p, `${bi + 1}.${i + 1}`, seenPhases, { b: bi, i }));
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
const ADV_FIELDS = ['name', 'add_dirs', 'plugins', 'system', 'model', 'effort', 'max_turns', 'permission_mode', 'max_budget_usd', 'output_schema', 'group'];
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
    .filter(([k]) => !same(before[k], after[k])).map(([, label]) => t(label));
  if (top.length) out.lines.push({ text: `Flow: ${top.join(', ')}` });

  const where = (spec: EditSpec) => new Map(spec.blocks.flatMap((b, bi) => b.phases.map((p) => [p.name, { p, b, bi }] as const)));
  const was = where(before);
  const now = where(after);
  const oldBlocks = new Map(before.blocks.map((b) => [b.name, b]));
  const names = (list: EditPhase[], other: EditPhase[]) => list.map((p) => p.name).filter((n) => other.some((q) => q.name === n));
  after.blocks.forEach((b, bi) => {
    const label = t('Блок «{block}»', { block: blockLabel(b, bi) });
    const old = oldBlocks.get(b.name);
    if (!old) {
      out.lines.push({ text: t('{label}: добавлен', { label }) });
      out.blocks.add(b.name);
      return;
    }
    const f: string[] = [];
    if (!same(old.title, b.title)) f.push(t('название'));
    if (!same(old.loop, b.loop)) f.push(t(old.loop && b.loop ? 'цикл и условие' : b.loop ? 'стал циклом' : 'стал одним проходом'));
    if (!same(old.on_fail, b.on_fail)) f.push(t('что делать, если условие не выполнено'));
    if (!same(old.knowledge, b.knowledge)) f.push(t('теги знаний'));
    if (!same(old.plugins, b.plugins)) f.push(t('плагины'));
    if (!same(old.flow, b.flow)) f.push(t('вызываемый flow'));
    if (!same(old.input, b.input)) f.push(t('задача вызова'));
    if (!same(old.next, b.next)) f.push(t('развилка после блока'));
    if (!same(names(old.phases, b.phases), names(b.phases, old.phases))) f.push(t('порядок этапов'));
    if (f.length) {
      out.lines.push({ text: `${label}: ${f.join(', ')}` });
      out.blocks.add(b.name);
    }
  });
  for (const b of before.blocks) if (!after.blocks.some((x) => x.name === b.name)) out.lines.push({ text: t('Блок «{block}»: удалён', { block: b.title || b.name }) });

  for (const [name, n] of now) {
    const label = t('Этап {name}', { name: n.p.title ? `«${n.p.title}» (${name})` : name });
    const o = was.get(name);
    if (ADV_FIELDS.some((k) => !same(field(o?.p, k), field(n.p, k)))) out.adv.add(name);
    if (!o) {
      out.lines.push({ text: t('{label}: добавлен', { label }), phase: name });
      out.phases.add(name);
      continue;
    }
    const f = Object.entries(PHASE_FIELDS).filter(([k]) => !same(field(o.p, k), field(n.p, k))).map(([, l]) => t(l));
    if (o.b.name !== n.b.name) f.push(t('перенесён в блок «{block}»', { block: blockLabel(n.b, n.bi) }));
    if (f.length) {
      out.lines.push({ text: `${label}: ${f.join(', ')}`, phase: name });
      out.phases.add(name);
    }
  }
  for (const name of was.keys()) if (!now.has(name)) out.lines.push({ text: t('Этап {name}: удалён', { name }) });
  return out;
}
