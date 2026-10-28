// Запросы конструктора flow: файл flow, сохранение (YAML и spec), проверка черновика, создание, правка с ИИ, папки, удаление.
// Генерация и правка с ИИ идут потоком NDJSON (FlowAiStreamEvent): модель, повторы, шаги и строки хода — по мере прихода.
// Ответы со spec типизируются здесь: spec — FlowSpec из src/schema.ts (тип zod), его нет в src/api-types.ts без импортов.
import { useQuery } from '@tanstack/react-query';
import type { ConnectorsView, FlowAiDone, FlowAiStreamEvent, FlowSummary, TagListItem } from '@server/api-types';
import type { FlowSpec } from '@server/schema';
import { t } from '../lib/i18n';
import { api, streamNdjson } from './client';
import { keys } from './queries';

/** GET /api/flows/:name: файл flow; невалидный — без summary и spec, с error. */
export type FlowDetail = { name: string; folder?: string; yaml: string; summary?: FlowSummary; spec?: FlowSpec; error?: string };
/** Ответ сохранения и проверки: spec после схемы, YAML, сводка. */
export type FlowSaved = { name: string; spec: FlowSpec; summary: FlowSummary; yaml?: string };
/** POST /api/flows/generate: save: false — черновик со spec, иначе flow записан в flows/. */
export type FlowGenerated = { name: string; yaml: string; summary: FlowSummary; spec?: FlowSpec; costUsd?: number };
/** POST /api/flows/:name/edit: правка ИИ не записывается, changed: false — ИИ ничего не поменял. */
export type FlowEdited = { name: string; spec: FlowSpec; summary: string; changed: boolean; costUsd: number };
/** Событие хода ИИ без done: done — результат вызова. */
export type FlowAiProgressEvent = Exclude<FlowAiStreamEvent, { type: 'done' }>;

const enc = encodeURIComponent;

export const fetchFlow = (name: string) => api<FlowDetail>('GET', `/api/flows/${enc(name)}`);
export const saveFlowYaml = (name: string, yaml: string) => api<FlowSaved>('PUT', `/api/flows/${enc(name)}`, { yaml });
export const saveFlowSpec = (name: string, spec: unknown) => api<FlowSaved & { yaml: string }>('PUT', `/api/flows/${enc(name)}/spec`, { spec });
/** Черновик разового запуска: сервер только проверяет, в flows/ ничего не пишет. */
export const checkFlow = (body: { spec: unknown } | { yaml: string }) => api<FlowSaved & { yaml: string }>('POST', '/api/flows/check', body);
export const moveFlow = (name: string, folder: string) => api<{ name: string; folder: string }>('PUT', `/api/flows/${enc(name)}/folder`, { folder });
export const deleteFlow = (name: string) => api<{ ok: true }>('DELETE', `/api/flows/${enc(name)}`);
export const blankFlow = (name: string, folder: string) => api<{ name: string; yaml: string }>('POST', '/api/flows/blank', { name, folder });

/**
 * ИИ над flow потоком: onEvent — ход сессии (progress, log, error), результат — тело done с моделью и длительностью.
 * signal обрывает запрос, сервер прерывает сессию вместе с соединением. Ошибка сессии — исключение с её текстом.
 */
async function flowAi<B>(url: string, body: unknown, onEvent: (e: FlowAiProgressEvent) => void, signal?: AbortSignal): Promise<B & FlowAiDone> {
  let done: (B & FlowAiDone) | undefined;
  let error: string | undefined;
  await streamNdjson<FlowAiStreamEvent<B>>(url, body, (e) => {
    // сервер старше UI отвечает одним JSON-телом без type: это и есть результат
    if (!('type' in e)) done = e as B & FlowAiDone;
    else if (e.type === 'done') done = e.body;
    else {
      if (e.type === 'error') error = e.error;
      onEvent(e);
    }
  }, { signal, headers: { Accept: 'application/x-ndjson' } });
  if (error !== undefined) throw new Error(error);
  if (!done) throw new Error(t('Сервер оборвал ответ без результата'));
  return done;
}

/** model: '' — модель по умолчанию (её назовёт событие progress). */
export const generateFlow = (body: { task: string; cwd: string; model?: string; folder?: string; save?: false }, onEvent: (e: FlowAiProgressEvent) => void, signal?: AbortSignal) =>
  flowAi<FlowGenerated>('/api/flows/generate', body, onEvent, signal);
export const editFlow = (name: string, body: { instruction: string; spec?: unknown; yaml?: string; cwd: string; model?: string }, onEvent: (e: FlowAiProgressEvent) => void, signal: AbortSignal) =>
  flowAi<FlowEdited>(`/api/flows/${enc(name)}/edit`, body, onEvent, signal);
export const fetchConnectors = (force: boolean) => api<ConnectorsView>('GET', `/api/connectors${force ? '?force=1' : ''}`);

/** GET /api/tags: теги для подсказки «Теги знаний» блока. Без списка тег можно вписать руками. */
export function useTags(enabled: boolean) {
  return useQuery({ queryKey: keys.tags, queryFn: () => api<{ tags: TagListItem[] }>('GET', '/api/tags'), enabled });
}
