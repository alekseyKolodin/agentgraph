// Тексты рутины, которые видит человек и которые уходят наружу (вопрос карточки, ответ в тред): на языке события.
// Язык — по словам заголовка и текста события (taskLang), как у текстов вспомогательных моделей (src/lang.ts).
import { taskLang, type ReplyLang } from '../lang.js';
import type { RoutineEvent } from './types.js';

export type RoutineTexts = {
  /** suggest: событие ждёт «Запустить?». */
  suggest: (routine: string, title: string) => string;
  /** pause: запуск стоит перед блоком. */
  fix: (title: string) => string;
  replyReady: (title: string) => string;
  taken: (title: string) => string;
  takenWaiting: (title: string, block: string) => string;
  whereSource: (source: string) => string;
  where: (source: string) => string;
};

const RU: RoutineTexts = {
  suggest: (r, t) => `Запустить «${r}»: ${t}?`,
  fix: (t) => `Чинить: ${t}?`,
  replyReady: (t) => `Ответ готов: ${t}`,
  taken: (t) => `Взял в работу: ${t}`,
  takenWaiting: (t, b) => `Взял в работу: ${t}. Жду подтверждения перед «${b}»`,
  whereSource: (s) => `в «${s}» (туда, откуда событие)`,
  where: (s) => `в «${s}»`,
};

const EN: RoutineTexts = {
  suggest: (r, t) => `Run "${r}": ${t}?`,
  fix: (t) => `Fix: ${t}?`,
  replyReady: (t) => `Reply ready: ${t}`,
  taken: (t) => `On it: ${t}`,
  takenWaiting: (t, b) => `On it: ${t}. Waiting for a go-ahead before "${b}"`,
  whereSource: (s) => `to "${s}" (where the event came from)`,
  where: (s) => `to "${s}"`,
};

export function eventLang(e: Pick<RoutineEvent, 'title' | 'text'>): ReplyLang {
  return taskLang(`${e.title}\n${e.text}`);
}

export function routineTexts(e: Pick<RoutineEvent, 'title' | 'text'>): RoutineTexts {
  return eventLang(e) === 'en' ? EN : RU;
}
