// Запросы сессий терминала (/api/sessions*). Экран терминала, кроме этого, держит WebSocket — screens/sessions/SessionTerminal.tsx.
// Список нужен сайдбару («Сейчас») и странице «Сессии»: пока есть живые сессии, он обновляется сам — статус
// «работает / ждёт тебя» меняется хуками claude, а не действиями в этой вкладке.
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { SessionList, SessionPermissionMode, SessionReviewEstimate, SessionReviewReply, SessionView } from '@server/api-types';
import { LS } from '../lib/storage';
import { api } from './client';
import type { FlowAiProgressEvent } from './flows';
import { draftStream } from './spaces';

const enc = encodeURIComponent;

/** Последняя папка новой сессии (общая с формой «Сессии»). */
export const SESSION_CWD_KEY = 'agentgraph.sessionCwd';
/** Папка по умолчанию для новой сессии: последняя папка сессии, папка запусков, папка сервера. */
export const defaultSessionCwd = (serverDefault?: string): string => LS.raw(SESSION_CWD_KEY) || LS.raw('agentgraph.cwd') || serverDefault || '';

export const sessionKeys = {
  list: ['sessions'] as const,
  one: (id: string) => ['sessions', id] as const,
};

export type NewSession = {
  cwd: string;
  /** Пространство (слаг): нового — пустое пространство; нет — без пространства. */
  space?: string;
  /** Теги знаний. */
  tags: string[];
  name?: string;
  model?: string;
  permissionMode?: SessionPermissionMode;
  saveState: boolean;
  /** Первое сообщение новой сессии. */
  prompt?: string;
  /** Начальный размер терминала: claude перерисуется под окно при подключении. */
  cols?: number;
  rows?: number;
};

export const createSession = (body: NewSession) => api<SessionView>('POST', '/api/sessions', body);
export const fetchSession = (id: string) => api<SessionView>('GET', `/api/sessions/${enc(id)}`);
export const setSessionTags = (id: string, tags: string[]) => api<SessionView>('PUT', `/api/sessions/${enc(id)}/tags`, { tags });
/** Пространство сессии: слаг или null — без пространства; живой сессии придёт со следующим шагом. */
export const setSessionSpace = (id: string, space: string | null) => api<SessionView>('PUT', `/api/sessions/${enc(id)}/space`, { space });
export const renameSession = (id: string, name: string) => api<SessionView>('PUT', `/api/sessions/${enc(id)}/name`, { name });
export const endSession = (id: string) => api<SessionView>('POST', `/api/sessions/${enc(id)}/end`);
/** «Продолжить»: тот же разговор (--resume), если есть транскрипт, иначе новый — в той же папке с текущими пространством и тегами. */
export const continueSession = (id: string) => api<SessionView>('POST', `/api/sessions/${enc(id)}/continue`, {});
/** «Перезапустить»: claude заново тем же разговором, папки пространства и тегов пересчитаны. */
export const restartSession = (id: string) => api<SessionView>('POST', `/api/sessions/${enc(id)}/restart`);
/** Оценка разбора «Не доделано» до запуска: модель не зовётся. */
export const estimateReview = () => api<SessionReviewEstimate>('POST', '/api/session-review', { estimate: true });
/** Разбор недавних сессий моделью (sonnet) потоком; сбой — DraftError с ценой. Ничего не пишет. */
export const reviewSessions = (onEvent: (e: FlowAiProgressEvent) => void, signal: AbortSignal) => draftStream<SessionReviewReply>('/api/session-review', {}, onEvent, signal);
/** «Обновить состояние»: ответ сразу, состояние пространства пишется в фоне (updatingState). */
export const updateSessionState = (id: string) => api<SessionView>('POST', `/api/sessions/${enc(id)}/state`);
export const deleteSession = (id: string) => api<{ ok: true }>('DELETE', `/api/sessions/${enc(id)}`);
/** Файл, перетащенный в терминал: сервер кладёт копию в папку сессии и отдаёт её путь. data — base64. */
export const uploadSessionFile = (id: string, name: string, data: string) => api<{ path: string }>('POST', `/api/sessions/${enc(id)}/files`, { name, data });

/** Пока есть живые сессии — раз в LIVE_POLL_MS: статус приходит из хуков claude. Без живых — изредка: сессию могли открыть в другой вкладке. */
const LIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 30_000;

/** Сессия обновилась (поток терминала, ответ на правку): в её кэше и в строке списка — сразу, без ожидания опроса. */
export function putSession(qc: QueryClient, v: SessionView): void {
  qc.setQueryData(sessionKeys.one(v.id), v);
  qc.setQueryData<SessionList>(sessionKeys.list, (l) => l && { ...l, sessions: l.sessions.map((x) => (x.id === v.id ? v : x)) });
}

/** Длина имени сессии — как SESSION_NAME_MAX в src/sessions.ts. */
export const SESSION_NAME_MAX = 80;

/**
 * Переименование: ответ сервера — сразу в кэш сессии и списка (шапка, таблица, «Сейчас», заголовок вкладки). Опрос,
 * начатый до правки, снимаем: его ответ вернул бы старое имя до следующего опроса.
 */
export function useRenameSession(): (id: string, name: string) => Promise<void> {
  const qc = useQueryClient();
  return async (id, name) => {
    const v = await renameSession(id, name);
    await Promise.all([qc.cancelQueries({ queryKey: sessionKeys.list, exact: true }), qc.cancelQueries({ queryKey: sessionKeys.one(id), exact: true })]);
    putSession(qc, v);
  };
}

export function useSessions(enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.list,
    queryFn: () => api<SessionList>('GET', '/api/sessions'),
    enabled,
    refetchInterval: (q) => (q.state.data?.sessions.some((s) => s.live) ? LIVE_POLL_MS : IDLE_POLL_MS),
  });
}
