// Состояние формы запуска (ui/app.js #run-form, state.attach, state.runTags, runTagInfo, attachGen, attachReads; ui/dash.js
// state.runLink): живёт вне компонента, как store.ts, — асинхронное чтение файлов, запрос тега и worktree сверяются с поколением
// формы и не трогают форму, которую за это время сбросили. Сброс — по flowState.formSeq (открыли или сохранили flow),
// вложения и доп. директории — только по flowState.extrasSeq (другой flow, черновик) и после запуска.
import { useSyncExternalStore } from 'react';
import type { FlowSummary } from '@server/api-types';
import { LS } from '../../lib/storage';
import type { Attach, RunLink, TagInfo } from '../../lib/run-form';
import { NO_MSG, type Msg } from './store';

export type RunFormState = {
  input: string;
  cwd: string;
  maxIterations: string;
  budget: string;
  model: string;
  /** Модель на момент сброса: её значение не из списка остаётся отдельным пунктом, пока форму не сбросят снова. */
  modelBase: string;
  /** «Дополнительно» раскрыто; запоминается (agentgraph.runMore). */
  more: boolean;
  /** Вписанный, но ещё не добавленный тег. */
  tagText: string;
  tags: string[];
  tagInfo: Map<string, TagInfo>;
  tagMsg: Msg;
  saveTag: boolean;
  autoTag: boolean;
  attach: Attach[];
  addDirs: string;
  link: RunLink | null;
  wtProject: string;
  wtBranch: string;
  wtMsg: Msg;
  wtBusy: boolean;
  msg: Msg;
  busy: boolean;
  /** Поколение формы: flowState.formSeq, по которому она сброшена. */
  formSeq: number;
  /** Поколение вложений (attachGen старого UI): дочитанный после сброса файл в новую форму не попадает. */
  extrasSeq: number;
  /** Поколение тегов: ответ GET /api/tags/:slug после сброса или удаления тега не применяется. */
  tagSeq: number;
  /** location.key перехода, чей вход из «Запустить…» уже в форме. */
  intakeKey: string;
  /** Растёт, когда фокус надо поставить в задачу в начало (вход из «Запустить…»). */
  focusSeq: number;
};

export const runForm: RunFormState = {
  input: '', cwd: '', maxIterations: '', budget: '', model: '', modelBase: '', more: LS.get('agentgraph.runMore', false), tagText: '', tags: [], tagInfo: new Map(), tagMsg: NO_MSG,
  saveTag: true, autoTag: false, attach: [], addDirs: '', link: null, wtProject: '', wtBranch: '', wtMsg: NO_MSG, wtBusy: false,
  msg: NO_MSG, busy: false, formSeq: -1, extrasSeq: -1, tagSeq: 0, intakeKey: '', focusSeq: 0,
};

/** Незавершённые чтения файлов: «Запустить» дожидается их перед отправкой. */
export const attachReads = new Set<Promise<void>>();
let attachId = 0;
export const nextAttachId = () => ++attachId;

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useRunForm(): RunFormState {
  useSyncExternalStore(subscribe, () => version);
  return runForm;
}

export function setForm(patch: Partial<RunFormState>): void {
  Object.assign(runForm, patch);
  version++;
  for (const fn of listeners) fn();
}

/** Вложения и доп. директории — разовые для запуска: у другого flow их не переносим (resetRunExtras). */
export function resetExtras(extrasSeq: number = runForm.extrasSeq + 1): void {
  setForm({ attach: [], addDirs: '', extrasSeq });
}

/**
 * Форма заново по flow (renderFlow старого UI): задача по умолчанию, запомненные директория, бюджет и модель; теги, привязка
 * и сообщения сброшены. Тег не запоминается: это осознанный выбор на каждый запуск.
 */
export function resetForm(summary: FlowSummary | undefined, defaultCwd: string, formSeq: number): void {
  setForm({
    input: summary?.input || '',
    cwd: LS.raw('agentgraph.cwd') || defaultCwd,
    maxIterations: String(summary?.maxIterations ?? ''),
    budget: LS.raw('agentgraph.budget') || '',
    model: LS.raw('agentgraph.model') || '',
    modelBase: LS.raw('agentgraph.model') || '',
    tagText: '',
    tags: [],
    tagInfo: new Map(),
    tagMsg: NO_MSG,
    saveTag: true,
    // автотег запоминается, как бюджет и модель; по умолчанию выключен: иначе тег заводился бы на каждый запуск молча
    autoTag: LS.raw('agentgraph.autoTag') === '1',
    tagSeq: runForm.tagSeq + 1,
    link: null,
    wtBranch: '',
    wtProject: '',
    wtMsg: NO_MSG,
    msg: NO_MSG,
    formSeq,
  });
}
