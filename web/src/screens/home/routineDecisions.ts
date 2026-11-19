// Решения по карточкам ожидания рутин: уходят на сервер через 5 секунд (lib/routines/pending.ts), до этого — «Отменить».
// Живёт вне React: уход с главной не теряет решение, а строка решения переживает возврат. Закрытие вкладки отправляет
// всё, что ждёт, сразу.
import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { RoutineWait, WaitAction } from '@server/routines/types';
import { errorText } from '../../api';
import { answerWait, routineKeys } from '../../api/routines';
import { createDelayed } from '../../lib/routines/pending';
import { decidedDeskKeys } from '../../lib/routines/view';

export type DecisionLine = { id: string; text: string; run: boolean; state: 'pending' | 'sent' | 'failed'; /** Дело ожидания (рутина с task): его карточка прячет кнопки, пока решение в пути. */ deskKey?: string };
type Payload = { body: WaitAction; line: Omit<DecisionLine, 'state'> };

let ctx: { qc: QueryClient; toast: (text: string) => void } | null = null;
/** Главная отдаёт клиент запросов и всплывашку: им сообщать «ушло» и ошибки (провайдеры живут дольше главной). */
export const bindDecisions = (qc: QueryClient, toast: (text: string) => void) => {
  ctx = { qc, toast };
};

const lines = new Map<string, DecisionLine>();
// вкладка закрывается: ждущие решения уходят сразу и с keepalive — иначе браузер оборвёт запрос
let unloading = false;
let version = 0;
const subs = new Set<() => void>();
const bump = () => {
  version++;
  subs.forEach((fn) => fn());
};

const queue = createDelayed<Payload>((id, p) => {
  lines.set(id, { ...p.line, state: 'sent' });
  bump();
  answerWait(id, p.body, unloading)
    .then(() => void ctx?.qc.invalidateQueries({ queryKey: routineKeys.all }))
    .catch((e: unknown) => {
      // не ушло — карточка возвращается
      lines.delete(id);
      bump();
      ctx?.toast(errorText(e));
      void ctx?.qc.invalidateQueries({ queryKey: routineKeys.all });
    });
});
queue.subscribe(bump);

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    unloading = true;
    queue.ids().forEach((id) => queue.flush(id));
  });
  // вкладку вернули из bfcache: дальше — обычные запросы
  window.addEventListener('pageshow', () => {
    unloading = false;
  });
}

/** Решение по карточке: строка «Запуск продолжен…» сразу, запрос — через 5 секунд. */
export function decide(w: RoutineWait, body: WaitAction, text: string): void {
  const line = { id: w.id, text, run: body.action === 'run', ...(w.deskKey ? { deskKey: w.deskKey } : {}) };
  lines.set(w.id, { ...line, state: 'pending' });
  queue.schedule(w.id, { body, line });
}

/** «Отменить»: true — успели, карточка вернулась. */
export function undo(id: string): boolean {
  if (!queue.cancel(id)) return false;
  lines.delete(id);
  bump();
  return true;
}

/** Решение уже ушло на сервер (для «Отменить» во всплывашке после срока). */
export const isSent = (id: string): boolean => lines.get(id)?.state === 'sent';

export function dismiss(id: string): void {
  lines.delete(id);
  bump();
}

/** Строки решений, id карточек ожиданий, которые прятать (решение ждёт или ушло), и дела с принятым решением. */
export function useDecisions(): { lines: DecisionLine[]; hidden: Set<string>; decidedKeys: Set<string> } {
  useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => version,
  );
  const list = [...lines.values()];
  return { lines: list.filter((l) => l.state !== 'failed'), hidden: new Set(list.filter((l) => l.state !== 'failed').map((l) => l.id)), decidedKeys: decidedDeskKeys(list) };
}
