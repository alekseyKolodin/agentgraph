// Состояние открытого flow (ui/app.js state.flow, state.spec, state.dirty, state.ai, focus): живёт вне экрана и переживает уход
// и возврат, как в старом UI — несохранённый конструктор не теряется, пока открыта вкладка. Рабочая копия (spec) правится
// на месте, а version растёт на каждую правку: компоненты перерисовываются через useFlowStore().
import { useSyncExternalStore } from 'react';
import type { FlowEditStep, FlowSummary } from '@server/api-types';
import type { FlowSpec } from '@server/schema';
import type { FlowSaved } from '../../api';
import type { AiProgress } from '../../lib/flow/ai-progress';
import type { ChangeRow } from '../../lib/flow/assistant';
import { toEditable, type EditBlock, type EditPhase, type EditSpec, type SpecChanges } from '../../lib/flow/edit';

export type Tab = 'run' | 'edit' | 'history';
/** Что видно во вкладке «Правка»: схема с помощником или текст YAML. */
export type EditView = 'scheme' | 'yaml';
export type Msg = { text: string; tone: '' | 'ok' | 'err' | 'warn' };
export const NO_MSG: Msg = { text: '', tone: '' };
export const msgClass = (m: Msg, base = 'msg') => `${base}${m.tone ? ` ${m.tone}` : ''}`;

/** Открытый flow: файл из flows/ или черновик разового запуска (draft: файла нет, живёт только в этой вкладке). */
export type FlowDoc = { name: string; folder?: string; yaml: string; summary?: FlowSummary; spec?: FlowSpec; error?: string; draft?: boolean };

/**
 * Последняя правка ИИ: что вернуть по «Отменить», что поменялось, цена, модель и длительность; stale — пока ИИ работал,
 * конструктор правили.
 */
export type AiResult = {
  /** prev — правка ИИ перед этой (отмена идёт по цепочке); seq — editSeq до того, как эта правка легла в схему. */
  undo: { spec: EditSpec | null; dirty: boolean; prev?: AiResult | null; seq?: number }; summary: string; diff: SpecChanges; stale: boolean; cost: number; seq: number;
  model?: string; durationMs?: number;
  /** Сообщение помощника с этой правкой: «Отменить правку» помечает его отменённым. */
  msgId?: number;
};

/**
 * Сообщение в чате помощника «Правки»: запрос человека (queued — ждёт, пока закончится идущая правка) или ответ ИИ —
 * отрисованный итог, строки «Что изменилось», предупреждения, факты; шаги и технический лог правки — свёрнуто.
 */
export type ChatMsg =
  | { id: number; who: 'me'; text: string; queued?: boolean }
  | {
    id: number; who: 'ai'; status: 'done' | 'same' | 'aborted' | 'error'; intro: string; rows: ChangeRow[]; notes: string[];
    facts: string; error?: string; steps: FlowEditStep[]; log: string[]; stale?: boolean; undone?: boolean;
  };

/** Поле flow или блока, открытое в крупном редакторе справа (режим «поле»). */
export type BlockField = 'title' | 'until-run' | 'until-prompt' | 'until-marker' | 'knowledge';
export type FieldKey = { scope: 'flow'; key: 'description' | 'input' } | { scope: 'block'; block: EditBlock; b: number; key: BlockField };

/**
 * Что открыто в инспекторе справа: этап целиком, блок (цикл и условие) или одно поле. Ключ — сам объект этапа или блока,
 * а не индекс: после ↑/↓ инспектор остаётся на том же этапе; после сохранения (spec клонирован) — узнаём по месту и имени.
 */
export type Selection =
  | { kind: 'phase'; phase: EditPhase; b: number; idx: number }
  | { kind: 'block'; block: EditBlock; b: number }
  | { kind: 'field'; field: FieldKey }
  | null;

type State = {
  flow: FlowDoc | null;
  spec: EditSpec | null;
  dirty: boolean;
  /** Растёт при каждой ручной правке конструктора. */
  editSeq: number;
  ai: AiResult | null;
  /** AbortController идущей правки ИИ. */
  aiAbort: AbortController | null;
  /** Ход идущей правки ИИ: модель, шаг, строки, повторы. */
  aiProgress: AiProgress | null;
  /** Текст в поле «Правка с ИИ». */
  aiText: string;
  aiMsg: Msg;
  bMsg: Msg;
  yamlMsg: Msg;
  sel: Selection;
  /** Имя этапа, выбранного на графе конструктора: переживает перерисовку и сдвиг индексов. */
  graphSel: string | null;
  tab: Tab;
  editView: EditView;
  /** Другой flow: граф конструктора вписывается заново. */
  refit: number;
  /** Растёт, когда YAML в редакторе надо заменить текстом flow (открыли, сохранили). */
  yamlSeq: number;
  /** В редакторе YAML — версия из снимка запуска (вкладка «История»), ещё не сохранённая; null — текст flow. */
  yamlFrom: { text: string; label: string } | null;
  /** Явное открытие этапа или блока в инспекторе: прокрутка наверх, фокус в название. */
  openSeq: number;
  /** Чат помощника «Правки»: живёт, пока открыт этот flow. */
  chat: ChatMsg[];
  /** Уточнение, отправленное во время правки: уйдёт следующей правкой, когда эта закончится. */
  aiQueue: string | null;
  /** editSeq на старте идущей правки ИИ: ручные правки после него в результат не войдут. */
  aiStartSeq: number;
  /** Уход с экрана уже подтверждён (openFlow, удаление): блокировщик перехода не спрашивает второй раз. */
  approved: boolean;
  /** Растёт, когда форму запуска надо заполнить заново (renderFlow старого UI): flow открыли или сохранили. */
  formSeq: number;
  /** Растёт, когда вложения и доп. директории формы сбрасываются: открыли другой flow или черновик. */
  extrasSeq: number;
};

export const flowState: State = {
  flow: null, spec: null, dirty: false, editSeq: 0, ai: null, aiAbort: null, aiProgress: null, aiText: '', aiMsg: NO_MSG, bMsg: NO_MSG, yamlMsg: NO_MSG,
  sel: null, graphSel: null, tab: 'run', editView: 'scheme', refit: 0, yamlSeq: 0, yamlFrom: null, openSeq: 0, approved: false, formSeq: 0, extrasSeq: 0,
  chat: [], aiQueue: null, aiStartSeq: 0,
};

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Перерисовать всех, кто читает состояние. */
export function emit(): void {
  version++;
  for (const fn of listeners) fn();
}

/** Состояние flow; перерисовка на каждое emit(). */
export function useFlowStore(): State {
  useSyncExternalStore(subscribe, () => version);
  return flowState;
}

export function set(patch: Partial<State>): void {
  Object.assign(flowState, patch);
  emit();
}

/** Ручная правка конструктора. */
export function markDirty(): void {
  flowState.dirty = true;
  flowState.editSeq++;
  emit();
}

const progressListeners = new Set<() => void>();
let progressVersion = 0;
const subscribeProgress = (fn: () => void) => {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
};

/** Событие хода правки ИИ: перерисовывает только панель хода, а не весь конструктор с графом. */
export function setAiProgress(p: AiProgress | null): void {
  flowState.aiProgress = p;
  progressVersion++;
  for (const fn of progressListeners) fn();
}

/** Ход идущей правки ИИ; перерисовка на каждое событие потока (и на emit() — через useFlowStore рядом). */
export function useAiProgress(): AiProgress | null {
  useSyncExternalStore(subscribeProgress, () => progressVersion);
  return flowState.aiProgress;
}

/** Прервать идущую правку ИИ и забыть результат прошлой. */
export function resetAi(): void {
  flowState.aiAbort?.abort();
  // пузырь уточнения из очереди без правки остался бы навсегда «уйдёт, когда закончится…»
  Object.assign(flowState, { aiAbort: null, aiProgress: null, ai: null, aiText: '', aiMsg: NO_MSG, aiQueue: null, chat: flowState.chat.filter((m) => m.who !== 'me' || !m.queued) });
}

let chatSeq = 0;
/** Новое сообщение в чат помощника; id — чтобы потом поправить его (очередь ушла, правку отменили). */
export function pushChat<M extends ChatMsg>(msg: Omit<M, 'id'>): number {
  const id = ++chatSeq;
  flowState.chat = [...flowState.chat, { ...msg, id } as unknown as ChatMsg];
  emit();
  return id;
}

/** Поправить сообщение чата по id. */
export function patchChat(id: number, patch: Partial<ChatMsg>): void {
  flowState.chat = flowState.chat.map((m) => (m.id === id ? ({ ...m, ...patch } as ChatMsg) : m));
  emit();
}

/** Открыть flow, прочитанный с сервера: рабочая копия заново, правки и выбор сбрасываются. */
export function openLoaded(doc: FlowDoc, tab: Tab): void {
  const other = flowState.flow?.name !== doc.name || Boolean(flowState.flow?.draft) !== Boolean(doc.draft);
  resetAi();
  Object.assign(flowState, {
    flow: doc,
    spec: doc.spec ? toEditable(doc.spec) : null,
    dirty: false,
    sel: null,
    graphSel: null,
    // у черновика вкладки «История» нет; flow без разбора по схеме — сразу в YAML
    tab: !doc.spec ? 'edit' : doc.draft && tab === 'history' ? 'run' : tab,
    editView: !doc.spec ? 'yaml' : tab === 'edit' ? 'scheme' : flowState.editView,
    bMsg: NO_MSG,
    yamlMsg: doc.error ? { text: doc.error, tone: 'err' } : NO_MSG,
    yamlSeq: flowState.yamlSeq + 1,
    yamlFrom: null,
    refit: other ? flowState.refit + 1 : flowState.refit,
    formSeq: flowState.formSeq + 1,
    // повторное открытие того же flow вложения не стирает; у черновика они всегда новые
    extrasSeq: other || doc.draft ? flowState.extrasSeq + 1 : flowState.extrasSeq,
    // чат помощника — пока открыт этот flow
    chat: other ? [] : flowState.chat,
  });
  emit();
}

/** Закрыть flow (удалён, черновик брошен). */
export function closeFlow(): void {
  resetAi();
  Object.assign(flowState, { flow: null, spec: null, dirty: false, sel: null, graphSel: null, bMsg: NO_MSG, yamlMsg: NO_MSG, yamlFrom: null, chat: [] });
  emit();
}

/**
 * Ответ сохранения (конструктор или YAML): flow и рабочая копия — с сервера, правки ИИ забыты. Выбор в инспекторе
 * переносится на тот же этап или блок новой копии (по месту и имени); если его больше нет — снимается.
 * `from` — открытый flow и счётчик правок на момент отправки: пока шёл запрос, могли открыть другой flow (ответ ему
 * не нужен — false) или поправить конструктор (сохранённое — в flow, а рабочая копия с правками и «не сохранено» остаются).
 */
export function applySaved(r: FlowSaved & { yaml?: string }, yaml: string | undefined, renameDraft: boolean, from?: SaveStart): boolean {
  const flow = flowState.flow!;
  if (from && from.flow !== flow) return false;
  if (from && from.editSeq !== flowState.editSeq) {
    flowState.flow = { ...flow, ...(renameDraft ? { name: r.name } : {}), yaml: yaml ?? r.yaml ?? flow.yaml, summary: r.summary, spec: r.spec, error: undefined };
    flowState.yamlSeq++;
    flowState.yamlFrom = null;
    emit();
    return true;
  }
  const spec = toEditable(r.spec);
  const sel = remap(current(flowState.sel), spec);
  // как в старом saveBuilder/saveYaml: забывается только результат прошлой правки ИИ, идущая правка и текст инструкции остаются
  Object.assign(flowState, {
    ai: null,
    flow: { ...flow, ...(renameDraft ? { name: r.name } : {}), yaml: yaml ?? r.yaml ?? flow.yaml, summary: r.summary, spec: r.spec, error: undefined },
    spec,
    dirty: false,
    sel,
    yamlMsg: NO_MSG,
    yamlSeq: flowState.yamlSeq + 1,
    yamlFrom: null,
    // как renderFlow после сохранения: форма запуска заново, вложения остаются
    formSeq: flowState.formSeq + 1,
  });
  emit();
  return true;
}

export type SaveStart = { flow: FlowDoc | null; editSeq: number };

/** Версия из снимка запуска — в редактор YAML, без сохранения: вернуть её — «Сохранить» там же. */
export function loadYamlVersion(text: string, label: string, msg: Msg): void {
  set({ yamlFrom: { text, label }, yamlSeq: flowState.yamlSeq + 1, tab: 'edit', editView: 'yaml', yamlMsg: msg });
}

/** Убрать версию из редактора: снова текст flow. */
export function dropYamlVersion(): void {
  set({ yamlFrom: null, yamlSeq: flowState.yamlSeq + 1, yamlMsg: NO_MSG });
}
/** Что открыто сейчас — запомнить перед запросом сохранения (см. applySaved). */
export const saveStart = (): SaveStart => ({ flow: flowState.flow, editSeq: flowState.editSeq });

/** Выбор с текущими индексами: после ↑/↓ этап и блок стоят не там, где их выбрали. */
function current(sel: Selection): Selection {
  const spec = flowState.spec;
  if (!spec || !sel) return sel;
  if (sel.kind === 'phase') {
    const at = selPhaseAt(spec, sel);
    return at ? { ...sel, b: at.b, idx: at.i } : sel;
  }
  const b = selBlockAt(spec, sel);
  if (b < 0) return sel;
  return sel.kind === 'block' ? { ...sel, b } : sel.field.scope === 'block' ? { kind: 'field', field: { ...sel.field, b } } : sel;
}

function remap(sel: Selection, spec: EditSpec): Selection {
  if (!sel) return null;
  if (sel.kind === 'phase') {
    const p = spec.blocks[sel.b]?.phases[sel.idx];
    return p && p.name === sel.phase.name ? { kind: 'phase', phase: p, b: sel.b, idx: sel.idx } : null;
  }
  if (sel.kind === 'block') {
    const b = spec.blocks[sel.b];
    return b && b.name === sel.block.name ? { kind: 'block', block: b, b: sel.b } : null;
  }
  if (sel.field.scope === 'flow') return sel;
  const f = sel.field;
  const b = spec.blocks[f.b];
  return b && b.name === f.block.name ? { kind: 'field', field: { ...f, block: b } } : null;
}

/** Где сейчас этап или блок выбора: индексы в текущей копии (после ↑/↓ они другие), -1 — пропал. */
export function selPhaseAt(spec: EditSpec, sel: Selection): { b: number; i: number } | null {
  if (sel?.kind !== 'phase') return null;
  for (const [b, block] of spec.blocks.entries()) {
    const i = block.phases.indexOf(sel.phase);
    if (i >= 0) return { b, i };
  }
  return null;
}
export function selBlockAt(spec: EditSpec, sel: Selection): number {
  const block = sel?.kind === 'block' ? sel.block : sel?.kind === 'field' && sel.field.scope === 'block' ? sel.field.block : null;
  return block ? spec.blocks.indexOf(block) : -1;
}

/** Вписанный, но ещё не добавленный тег знаний блока: общий для поля в ленте, в инспекторе и крупного редактора. */
export const knowledgeDraft = new WeakMap<EditBlock, string>();

const NO_STEPS: FlowEditStep[] = [];
/** Шаги идущей правки ИИ: перерисовка только когда пришёл новый шаг, а не на каждую строку лога (граф схемы). */
export function useAiSteps(): FlowEditStep[] {
  return useSyncExternalStore(subscribeProgress, () => flowState.aiProgress?.steps ?? NO_STEPS);
}
