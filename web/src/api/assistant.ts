// Запросы помощника (docs/ASSISTANTS.md): один механизм на все разделы, раздел отличается адресом (base).
// GET base — что помощник знает и умеет; POST base — начать разговор; дальше по id: состояние, сообщение, стоп, закрыть.
// Пока идёт ход, состояние перечитывается раз в 0.8 с: лента шагов растёт на глазах.
import { useQuery } from '@tanstack/react-query';
import type { AssistantAbout, AssistantView } from '@server/assistant-types';
import { api } from './client';

const enc = encodeURIComponent;

export const assistantKeys = {
  about: (base: string) => ['assistant', base, 'about'] as const,
  chat: (base: string, id: string) => ['assistant', base, 'chat', id] as const,
};

export function useAssistantAbout(base: string, enabled = true) {
  return useQuery({ queryKey: assistantKeys.about(base), queryFn: () => api<AssistantAbout>('GET', base), enabled, staleTime: Infinity, retry: false });
}

/** model — выбор человека; '' — модель раздела по умолчанию. extra — что экран шлёт вместе с сообщением (состояние формы). */
export const startAssistant = <R>(base: string, text: string, model: string, extra?: Record<string, unknown>) => api<AssistantView<R>>('POST', base, { ...extra, text, model });
export const sendAssistant = <R>(base: string, id: string, text: string, model: string, extra?: Record<string, unknown>) => api<AssistantView<R>>('POST', `${base}/${enc(id)}`, { ...extra, text, model });
export const stopAssistant = <R>(base: string, id: string) => api<AssistantView<R>>('POST', `${base}/${enc(id)}/stop`, {});
export const closeAssistant = (base: string, id: string) => api<{ ok: true }>('DELETE', `${base}/${enc(id)}`);

export function useAssistantChat<R>(base: string, id: string | null) {
  return useQuery({
    queryKey: assistantKeys.chat(base, id ?? ''),
    queryFn: () => api<AssistantView<R>>('GET', `${base}/${enc(id!)}`),
    enabled: Boolean(id),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => (q.state.data?.state === 'working' ? 800 : false),
  });
}
