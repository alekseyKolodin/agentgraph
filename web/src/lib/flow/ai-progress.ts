// Ход ИИ над flow («Новый flow» → «Сгенерировать», «Правка с ИИ» в конструкторе): события потока FlowAiStreamEvent →
// что показывает AiProgress. Без React и DOM: таймер тикает снаружи, время приходит параметром now.
import type { FlowAiStage, FlowAiStreamEvent } from '@server/api-types';
import { dur, usd } from '../format';
import { t } from '../i18n';

export type AiKind = 'generate' | 'edit';

export type AiProgress = {
  kind: AiKind;
  startedAt: number;
  /** Последнее событие потока (или старт): от него считается «нет вестей». */
  lastAt: number;
  /** Фактическая модель сессии: приходит первым событием после старта. */
  model?: string;
  stage?: FlowAiStage;
  /** Повтор запроса к API (перегрузка, 5xx): виден, пока не пришло следующее событие. */
  retry?: { attempt: number; maxRetries: number; delayMs: number; at: number };
  /** Последние строки хода: текст агента, вызовы инструментов и их результаты. */
  lines: string[];
};

/** Сколько строк хода держим: показываются последние. */
export const LINES_MAX = 4;

/**
 * Порог «нет вестей». Генерация после короткого чтения проекта думает молча и присылает весь flow одним ответом, так что
 * тишина длится большую часть генерации — у тяжёлой модели и большого flow это минуты, и предупреждать раньше 4 минут — пугать
 * зря. Правка вызывает Read/Edit каждые несколько секунд, и две минуты без единого события — уже повод проверить.
 */
export const SILENCE_MS: Record<AiKind, number> = { generate: 4 * 60_000, edit: 2 * 60_000 };

/**
 * Сколько уведомление о повторе висит после того, как повтор ушёл. Удачный повтор ничего не присылает: генерация дальше
 * думает молча, и «API не ответил» через минуту врало бы. Неудачный пришлёт следующий retry.
 */
export const RETRY_SHOW_MS = 15_000;

export const startProgress = (kind: AiKind, now: number): AiProgress => ({ kind, startedAt: now, lastAt: now, lines: [] });

/** Событие потока → новое состояние (старое не меняется: его держит React). done и error только отмечают время. */
export function aiProgressStep(s: AiProgress, e: FlowAiStreamEvent<unknown>, now: number): AiProgress {
  const next: AiProgress = { ...s, lastAt: now };
  if (e.type === 'log') {
    next.lines = [...s.lines, e.line].slice(-LINES_MAX);
    next.retry = undefined;
  } else if (e.type === 'progress') {
    if (e.model) next.model = e.model;
    if (e.stage) next.stage = e.stage;
    next.retry = e.retry ? { ...e.retry, at: now } : undefined;
  }
  return next;
}

/** Сколько длится тишина: ожидание перед повтором запроса — не тишина, отсчёт с момента, когда повтор должен был уйти. */
export function silenceMs(s: AiProgress, now: number): number {
  const from = s.retry ? Math.max(s.lastAt, s.retry.at + s.retry.delayMs) : s.lastAt;
  return Math.max(0, now - from);
}

/** Пора ли предупредить «нет вестей». */
export const isSilent = (s: AiProgress, now: number): boolean => silenceMs(s, now) >= SILENCE_MS[s.kind];

/** Таймер: «0:42», «12:05» — моноширинным, цифры не прыгают. */
export function elapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** Подпись шага: «генерирую flow», «правка», «исправляю ошибки валидации 1/2»; шага ещё нет — «подключаюсь». */
export function stageLabel(s: AiProgress): string {
  const st = s.stage;
  if (!st) return t('подключаюсь');
  if (st.kind === 'generate') return t('генерирую flow');
  if (st.kind === 'edit') return t('правка');
  return t('исправляю ошибки валидации {n}/{of}', { n: st.attempt, of: st.of });
}

/** Уведомление о повторе: «повтор 2 из 10 через 4 с», пока ждём; потом «повтор 2 из 10…» ещё RETRY_SHOW_MS. */
export function retryLabel(s: AiProgress, now: number): string {
  const r = s.retry;
  if (!r || now > r.at + r.delayMs + RETRY_SHOW_MS) return '';
  const left = Math.ceil((r.at + r.delayMs - now) / 1000);
  return left > 0
    ? t('API не ответил, повтор {n} из {of} через {s} с', { n: r.attempt, of: r.maxRetries, s: left })
    : t('API не ответил, повтор {n} из {of}…', { n: r.attempt, of: r.maxRetries });
}

/** Короткое имя модели для чипа: «claude-opus-5-5» → «opus-5-5», дата в конце отбрасывается. */
export const modelChip = (id: string): string => id.replace(/^claude-/, '').replace(/-\d{8}$/, '');

/** Итог ИИ одной строкой: «opus-5-5 · 1м 42с · ≈$0.31»; модели или длительности нет (сервер старше UI) — без них. */
export const aiFacts = (model: string | undefined, durationMs: number | undefined, cost: number | undefined): string =>
  [model && modelChip(model), typeof durationMs === 'number' && dur(durationMs), `≈${usd(cost)}`].filter(Boolean).join(' · ');

/** Подпись «по умолчанию» в выборе модели: фактическая модель (коротко), как только её назвала сессия. */
export const defaultModelLabel = (actual: string | undefined): string =>
  actual ? t('по умолчанию ({model})', { model: modelChip(actual) }) : t('по умолчанию');
