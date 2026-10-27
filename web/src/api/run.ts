// Запросы страницы запуска: отчёт, снимок flow, файлы запуска, управление (пауза, лимит, остановка, продолжение),
// «Сохранить как flow», артефакты и чат запуска (ответ — поток NDJSON).
import type { ArtifactList, ArtifactRead, ArtifactSaved, ChatActionReply, ChatPayload, ChatStreamEvent, RunAnalysis, RunDetail } from '@server/api-types';
import type { Block, FlowSpec } from '@server/schema';
import { api, streamNdjson } from './client';
import { t } from '../lib/i18n';

/** GET /api/runs/:id/flow: снимок flow.yaml, по которому идёт запуск. */
export type RunFlowView = { name: string; blocks: Block[]; artifacts?: FlowSpec['artifacts'] };

const runUrl = (id: string) => `/api/runs/${encodeURIComponent(id)}`;

export const fetchRun = (id: string) => api<RunDetail>('GET', runUrl(id));
export const fetchRunFlow = (id: string) => api<RunFlowView>('GET', `${runUrl(id)}/flow`);

/** Файл папки запуска (промпт, транскрипт, вывод, лог условия, вложение). */
export const runFileUrl = (id: string, file: string) => `${runUrl(id)}/file?path=${encodeURIComponent(file)}`;

/** Текст файла запуска; не 2xx — «Не удалось прочитать: N». noStore — у идущего этапа транскрипт растёт, читаем заново. */
export async function fetchRunFile(id: string, file: string, noStore = false): Promise<{ ok: boolean; text: string }> {
  const res = await fetch(runFileUrl(id, file), noStore ? { cache: 'no-store' } : {});
  return res.ok ? { ok: true, text: await res.text() } : { ok: false, text: t('Не удалось прочитать: {status}', { status: res.status }) };
}

export const pauseRun = (id: string) => api<unknown>('POST', `${runUrl(id)}/pause`);
/** answer — ответ на паузу: сервер сначала допишет его в артефакт решений, при ошибке записи пауза остаётся. */
export const resumeRun = (id: string, answer?: string) => api<unknown>('POST', `${runUrl(id)}/resume`, answer ? { answer, via: 'ui' } : undefined);
export const abortRun = (id: string) => api<unknown>('POST', `${runUrl(id)}/abort`);
export const setMaxIterations = (id: string, block: string, value: number) => api<unknown>('POST', `${runUrl(id)}/max-iterations`, { block, value });
export const continueRun = (id: string) => api<{ id: string }>('POST', `${runUrl(id)}/continue`, {});
export const saveRunFlow = (id: string, body: { name?: string; folder: string }) => api<{ name: string; folder?: string }>('POST', `${runUrl(id)}/save-flow`, body);

/** Анализ flow по завершённому запуску: сохранённый (404 с code missing — ещё не делали) и новый, ответ — готовый анализ (запуск идёт — 409 live, уже анализируется — 409 busy). */
export const fetchAnalysis = (id: string) => api<RunAnalysis>('GET', `${runUrl(id)}/analysis`);
export const runAnalysis = (id: string, model?: string) => api<RunAnalysis>('POST', `${runUrl(id)}/analysis`, model ? { model } : {});

const artUrl = (id: string, key?: string) => `${runUrl(id)}/artifacts${key === undefined ? '' : `/${encodeURIComponent(key)}`}`;
export const fetchArtifacts = (id: string) => api<ArtifactList>('GET', artUrl(id));
/** Текущая версия артефакта или версия n. */
export const fetchArtifact = (id: string, key: string, n?: number) => api<ArtifactRead>('GET', `${artUrl(id, key)}${n ? `?version=${n}` : ''}`);
/** base — хэш версии, которую правили; resume — записать и сразу снять паузу. */
export const saveArtifact = (id: string, key: string, { text, base, resume }: { text: string; base: string | undefined; resume?: boolean }) =>
  api<ArtifactSaved>('PUT', artUrl(id, key), { text, base, via: 'ui', ...(resume ? { resume: true } : {}) });

export const fetchChat = (id: string) => api<ChatPayload>('GET', `${runUrl(id)}/chat`);
export const clearChat = (id: string) => api<ChatPayload>('DELETE', `${runUrl(id)}/chat`);
export const stopChat = (id: string) => api<unknown>('POST', `${runUrl(id)}/chat/stop`);

/** Сообщение в чат запуска: ответ читается потоком, каждая строка — событие. Не 2xx — ApiError. */
export const postChat = (id: string, body: { message: string; model?: string }, onEvent: (e: ChatStreamEvent) => void): Promise<void> =>
  streamNdjson<ChatStreamEvent>(`${runUrl(id)}/chat`, body, onEvent);

/** Клик по кнопке под ответом чата: сервер сверит состояние и выполнит действие один раз (409 busy — идёт ход, 409 used — уже нажимали). */
export const postChatAction = (id: string, body: { msgIndex: number; actionId: string; saveToFlows?: boolean }) =>
  api<ChatActionReply>('POST', `${runUrl(id)}/chat/action`, body);
