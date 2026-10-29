// Автообновление agentgraph (src/update.ts): состояние и запуск. Пока обновление идёт или процесс перезапускается,
// состояние опрашивается каждую секунду (сервер в это время пропадает — ошибки опроса ожидаемы); пока сервер ещё не
// проверял (первая проверка — через 10 секунд после старта) — раз в 15 секунд; иначе раз в 10 минут: сам сервер
// делает fetch раз в час.
import { useQuery } from '@tanstack/react-query';
import type { UpdateStatus } from '@server/api-types';
import { api } from './client';

export const updateKey = ['update'] as const;

const FAST_MS = 1000;
const FIRST_MS = 15_000;
const SLOW_MS = 10 * 60_000;

/** check — fetch на сервере сейчас, а не по таймеру (POST: побочный эффект, чужая страница его не дёрнет). */
export const fetchUpdate = (check = false) => (check ? api<UpdateStatus>('POST', '/api/update/check') : api<UpdateStatus>('GET', '/api/update'));
/** Начать обновление: ответ сразу (state updating), 409 — нельзя (нет новой версии, локальные правки, уже идёт). */
export const startUpdate = () => api<UpdateStatus>('POST', '/api/update');

export function useUpdate(enabled: boolean) {
  return useQuery({
    queryKey: updateKey,
    queryFn: () => fetchUpdate(),
    enabled,
    refetchInterval: (q) => {
      const st = q.state.data?.state;
      return st === 'updating' || st === 'restarting' ? FAST_MS : st === 'unknown' ? FIRST_MS : SLOW_MS;
    },
  });
}
