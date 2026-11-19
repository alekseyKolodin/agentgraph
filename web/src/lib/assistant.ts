// Помощник: как разговор и шаги раскладываются в ленту. Ход — сообщение человека, шаги помощника и его ответ.
import type { AssistantAbout, AssistantMessage, AssistantStep, AssistantView } from '@server/assistant-types';

export type Turn = { turn: number; user?: AssistantMessage; steps: AssistantStep[]; reply?: AssistantMessage };

/** Лента по ходам: шаги стоят между сообщением человека и ответом, даже если ответ ещё не пришёл. */
export function turnsOf(v: Pick<AssistantView, 'messages' | 'steps'>): Turn[] {
  const byTurn = new Map<number, Turn>();
  const at = (n: number): Turn => {
    let t = byTurn.get(n);
    if (!t) byTurn.set(n, (t = { turn: n, steps: [] }));
    return t;
  };
  for (const m of v.messages) {
    const t = at(m.turn);
    if (m.role === 'user') t.user = m;
    else t.reply = m;
  }
  for (const s of v.steps) at(s.turn).steps.push(s);
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

/** Действия, которые закончились с прошлого опроса: по ним экран перечитывает списки (новый источник, новый flow). */
export function finishedActs(prev: AssistantStep[] | undefined, next: AssistantStep[]): AssistantStep[] {
  const was = new Map((prev ?? []).map((s) => [s.id, s.state]));
  return next.filter((s) => s.level === 'act' && s.state === 'ok' && was.get(s.id) !== 'ok');
}

/** Что помощник умеет — по уровням: смотрит сам, делает сам (шаг виден в ленте), остаётся за человеком. */
export function abilities(a: Pick<AssistantAbout, 'tools' | 'onlyYou'>): { reads: string[]; acts: string[]; onlyYou: string[] } {
  return { reads: a.tools.filter((t) => t.level === 'read').map((t) => t.label), acts: a.tools.filter((t) => t.level === 'act').map((t) => t.label), onlyYou: a.onlyYou };
}
