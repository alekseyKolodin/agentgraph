// Черновики пространств и «Предложить пространства» — состояние на модуль, как у «Анализа flow»: идущая сессия модели
// переживает уход на другой экран и возврат (fetch живёт, пока открыта вкладка; её закрытие — отмена на сервере).
// Ключ черновика — 'new' (новое пространство) или 'space:<slug>'. Ничего не пишется на диск: сохраняет человек.
import { useEffect, useState } from 'react';
import type { SpaceDetail, SpaceDraftBody, SpaceDraftFailure, SpaceDraftModel, SpaceDraftReply, SpaceGroupsReply } from '@server/api-types';
import { DraftError, draftSpace, errorText, proposeSpaces } from '../../api';
import type { FlowAiProgressEvent } from '../../api/flows';
import { t } from '../../lib/i18n';
import { dirLines } from '../../lib/spaces';
import { editOf, type DraftEdit, type DraftSourceItem } from '../../lib/space-draft';

/** Сколько последних строк хода показывать. */
const LOG_KEEP = 6;

function keyed<T>() {
  const map = new Map<string, T>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const fn of listeners) fn();
  };
  const store = {
    get: (k: string) => map.get(k),
    set(k: string, v: T | undefined) {
      if (v === undefined) map.delete(k);
      else map.set(k, v);
      emit();
    },
    patch(k: string, p: Partial<T> | ((cur: T) => Partial<T>)) {
      const cur = map.get(k);
      if (cur) store.set(k, { ...cur, ...(typeof p === 'function' ? p(cur) : p) });
    },
    use(k: string): T | undefined {
      const [, tick] = useState(0);
      useEffect(() => {
        const fn = () => tick((n) => n + 1);
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      }, []);
      return map.get(k);
    },
  };
  return store;
}

/** Ввод черновика: mode — «по описанию и проекту» или «из истории» (отмеченные sources из items). */
export type DraftSetup = {
  mode: 'about' | 'history';
  about: string;
  cwd: string;
  dirs: string;
  items: DraftSourceItem[];
  sources: string[];
  model: SpaceDraftModel;
  /** Новое: слаг и заголовок из формы или предложения. */
  slug: string;
  title: string;
  /** Предложение: его сессии привязать к созданному пространству. */
  bind: string[];
  fromGroups?: true;
};

export type DraftEntry = {
  setup: DraftSetup;
  phase: 'setup' | 'running' | 'done' | 'error';
  startedAt?: number;
  log: string[];
  model?: string;
  abort?: AbortController;
  reply?: SpaceDraftReply;
  edit?: DraftEdit;
  failure?: Pick<SpaceDraftFailure, 'error' | 'costUsd'> & { code?: SpaceDraftFailure['code'] };
  /** Новое уже заведено (документы не все записались): повтор пишет только оставшееся. */
  created?: string;
  bindOn: boolean;
  saving?: boolean;
  saveMsg?: { cls: string; text: string };
};

export const drafts = keyed<DraftEntry>();

export const draftKey = (slug?: string) => (slug ? `space:${slug}` : 'new');

/** Тело запроса из ввода: у существующего — его слаг, у нового — слаг из формы; источники — только «из истории». */
export function draftBody(setup: DraftSetup, space?: Pick<SpaceDetail, 'slug'>): SpaceDraftBody {
  const chosen = setup.mode === 'history' ? setup.items.filter((x) => setup.sources.includes(x.id)) : [];
  const sessions = chosen.filter((x) => x.kind === 'session').map((x) => x.id);
  const runs = chosen.filter((x) => x.kind === 'run').map((x) => x.id);
  return {
    ...(space ? { space: space.slug } : setup.slug.trim() ? { slug: setup.slug.trim() } : {}),
    ...(setup.about.trim() ? { about: setup.about.trim() } : {}),
    ...(setup.cwd.trim() ? { cwd: setup.cwd.trim() } : {}),
    dirs: dirLines(setup.dirs),
    ...(sessions.length ? { sessions } : {}),
    ...(runs.length ? { runs } : {}),
    model: setup.model,
  };
}

const logLine = (key: string, line: string) => drafts.patch(key, (cur) => ({ log: [...cur.log, line].slice(-LOG_KEEP) }));

const onProgress = (patchLog: (line: string) => void, setModel: (m: string) => void) => (e: FlowAiProgressEvent) => {
  if (e.type === 'log') patchLog(e.line);
  else if (e.type === 'progress' && e.model) setModel(e.model);
};

/** Черновик: сессия модели потоком; результат — правка, которую человек смотрит и сохраняет сам. */
export async function runDraft(key: string, space?: SpaceDetail): Promise<void> {
  const entry = drafts.get(key);
  if (!entry || entry.phase === 'running') return;
  const abort = new AbortController();
  drafts.patch(key, { phase: 'running', startedAt: Date.now(), log: [], abort, failure: undefined, model: undefined, saveMsg: undefined });
  try {
    const reply = await draftSpace(draftBody(entry.setup, space), onProgress((l) => logLine(key, l), (model) => drafts.patch(key, { model })), abort.signal);
    drafts.patch(key, { phase: 'done', reply, edit: editOf(reply.draft, space), abort: undefined, created: undefined });
  } catch (err) {
    if (abort.signal.aborted) return drafts.patch(key, { phase: 'setup', abort: undefined, failure: { error: t('Отменено: черновика нет'), costUsd: 0, code: 'aborted' } });
    const failure = err instanceof DraftError ? err.failure : { error: errorText(err), costUsd: 0 };
    drafts.patch(key, { phase: 'error', failure, abort: undefined });
  }
}

/** «Предложить пространства»: одна на страницу. */
export type GroupsEntry = {
  phase: 'setup' | 'running' | 'done' | 'error';
  model: SpaceDraftModel;
  startedAt?: number;
  log: string[];
  modelName?: string;
  abort?: AbortController;
  reply?: SpaceGroupsReply;
  failure?: { error: string; costUsd: number };
};

export const groups = keyed<GroupsEntry>();
export const GROUPS = 'groups';

export async function runGroups(): Promise<void> {
  const entry = groups.get(GROUPS);
  if (!entry || entry.phase === 'running') return;
  const abort = new AbortController();
  groups.patch(GROUPS, { phase: 'running', startedAt: Date.now(), log: [], abort, failure: undefined, modelName: undefined });
  try {
    const reply = await proposeSpaces(
      entry.model,
      onProgress((l) => groups.patch(GROUPS, (cur) => ({ log: [...cur.log, l].slice(-LOG_KEEP) })), (m) => groups.patch(GROUPS, { modelName: m })),
      abort.signal,
    );
    groups.patch(GROUPS, { phase: 'done', reply, abort: undefined });
  } catch (err) {
    if (abort.signal.aborted) return groups.patch(GROUPS, { phase: 'setup', abort: undefined });
    groups.patch(GROUPS, { phase: 'error', failure: err instanceof DraftError ? err.failure : { error: errorText(err), costUsd: 0 }, abort: undefined });
  }
}
