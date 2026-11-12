// Правка раздела документа живёт вне компонента: уход на другую вкладку проекта и обратно не теряет текст, а строка
// «не сохранено» в шапке проекта и оглавление видят несохранённый раздел (spec §8.4). Один раздел на документ; ключ —
// команда, проект, документ. Перезагрузка страницы с несохранённым разделом спрашивает подтверждение браузера.
import { useSyncExternalStore } from 'react';
import type { TeamDocName } from '@server/api-types';
import type { ReqSectionParts } from '../../../lib/teamwork/docs';

export type SectionEdit = {
  heading: string;
  /** Хэш раздела на момент начала правки: сервер ответит 409, если раздел за это время поменял кто-то другой. */
  hash: string;
  /** Строка заголовка как в файле («## Требования»); у начала документа пусто. */
  headLine: string;
  /** Тело раздела на начало правки и сейчас (без строки заголовка). */
  original: string;
  body: string;
  /** Строки требований (вид «Текст» раздела требований): тело собирается из них при сохранении. */
  rows?: ReqSectionParts;
  originalRows?: ReqSectionParts;
  /** «Текст» — живая разметка и строки требований; «Markdown» — исходник раздела. */
  mode: 'text' | 'md';
  /** 409: раздел в репо сейчас и его хэш. */
  theirs?: { text: string; hash: string };
};

const edits = new Map<string, SectionEdit>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (team: string, project: string, doc: TeamDocName) => `${team}\u0000${project}\u0000${doc}`;

function emit() {
  version++;
  for (const l of listeners) l();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getEdit = (team: string, project: string, doc: TeamDocName): SectionEdit | undefined => edits.get(keyOf(team, project, doc));

export function setEdit(team: string, project: string, doc: TeamDocName, edit: SectionEdit | undefined): void {
  const k = keyOf(team, project, doc);
  if (edit) edits.set(k, edit);
  else edits.delete(k);
  emit();
}

export function patchEdit(team: string, project: string, doc: TeamDocName, patch: Partial<SectionEdit>): void {
  const cur = getEdit(team, project, doc);
  if (cur) setEdit(team, project, doc, { ...cur, ...patch });
}

/**
 * Тело раздела, которое уйдёт на сервер: в виде «Текст» раздела требований — из строк; пустая строка требования не
 * сохраняется («- FR-9.» без текста не узнаётся как требование, и номер потом выдали бы снова).
 */
export function editBody(e: SectionEdit, serialize: (p: ReqSectionParts) => string): string {
  return e.mode === 'text' && e.rows ? serialize({ ...e.rows, rows: e.rows.rows.filter((r) => r.text.trim()) }) : e.body;
}

/**
 * Правка изменила раздел (без хвостовых пустых строк). Раздел требований сравнивается с исходными строками, собранными
 * так же: сборка строк убирает пустые строки между требованиями, и это ещё не правка.
 */
export const isDirty = (e: SectionEdit, serialize: (p: ReqSectionParts) => string): boolean =>
  editBody(e, serialize).trimEnd() !== (e.originalRows ? serialize(e.originalRows) : e.original).trimEnd();

/** Правка раздела документа; перерисовка при любой смене правок. */
export function useEdit(team: string, project: string, doc: TeamDocName): SectionEdit | undefined {
  useSyncExternalStore(subscribe, () => version);
  return getEdit(team, project, doc);
}

/** Все открытые правки проекта: документ и правка — для строки «не сохранено» в шапке проекта. */
export function useProjectEdits(team: string, project: string): { doc: TeamDocName; edit: SectionEdit }[] {
  useSyncExternalStore(subscribe, () => version);
  const prefix = `${team}\u0000${project}\u0000`;
  return [...edits].filter(([k]) => k.startsWith(prefix)).map(([k, edit]) => ({ doc: k.slice(prefix.length) as TeamDocName, edit }));
}

let guarded = false;
/** Перезагрузка и закрытие вкладки с несохранённым разделом — вопрос браузера. */
export function guardUnload(dirty: () => boolean): void {
  if (guarded) return;
  guarded = true;
  window.addEventListener('beforeunload', (e) => {
    if (!dirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

export const anyEdits = (): SectionEdit[] => [...edits.values()];
