// Ход ИИ над flow («Новый flow» → «Сгенерировать», «Правка с ИИ» в конструкторе): события потока FlowAiStreamEvent →
// что показывает AiProgress. Без React и DOM: таймер тикает снаружи, время приходит параметром now.
import type { FlowAiStage, FlowAiStreamEvent, FlowEditStep } from '@server/api-types';
import { dur, plural, usd } from '../format';
import { t } from '../i18n';
import { PHASE_FIELDS } from './edit';

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
  /** «Правка с ИИ»: шаги словами (прочитал, добавил этап, правлю этап), правки одного места склеены. */
  steps: FlowEditStep[];
  /** Весь ход строками — «Технический лог»; держим последние LOG_MAX. */
  log: string[];
};

/** Сколько строк технического лога держим. */
export const LOG_MAX = 400;

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

export const startProgress = (kind: AiKind, now: number): AiProgress => ({ kind, startedAt: now, lastAt: now, lines: [], steps: [], log: [] });

/** Событие потока → новое состояние (старое не меняется: его держит React). done и error только отмечают время. */
export function aiProgressStep(s: AiProgress, e: FlowAiStreamEvent<unknown>, now: number): AiProgress {
  const next: AiProgress = { ...s, lastAt: now };
  if (e.type === 'log') {
    next.lines = [...s.lines, e.line].slice(-LINES_MAX);
    next.log = [...(s.log ?? []), e.line].slice(-LOG_MAX);
    next.retry = undefined;
  } else if (e.type === 'progress') {
    if (e.model) next.model = e.model;
    if (e.stage) next.stage = e.stage;
    if (e.step) next.steps = pushStep(s.steps ?? [], e.step);
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

// ---------- шаги «Правки с ИИ» словами

const sameTarget = (a: FlowEditStep, b: FlowEditStep) => a.kind !== 'read' && b.kind !== 'read' && a.what === b.what && a.name === b.name;

/**
 * Новый шаг в список: правки одного места склеиваются в один шаг (поля — вместе) и переезжают в конец — там то, что
 * правится сейчас; правка нового этапа остаётся «добавил»; удалённое после добавления пропадает совсем. «Прочитал» — один раз.
 */
export function pushStep(list: FlowEditStep[], step: FlowEditStep): FlowEditStep[] {
  if (step.kind === 'read') return list.some((s) => s.kind === 'read') ? list : [...list, step];
  const at = list.findIndex((s) => sameTarget(s, step));
  if (at < 0) return [...list, step];
  const was = list[at]!;
  const rest = list.filter((_, k) => k !== at);
  if (was.kind === 'read') return [...rest, step];
  if (step.kind === 'remove') return was.kind === 'add' ? rest : [...rest, step];
  if (was.kind === 'add') return [...rest, { ...was, ...(step.title ? { title: step.title } : {}) }];
  const fields = [...new Set([...(was.kind === 'edit' ? was.fields ?? [] : []), ...(step.fields ?? [])])];
  return [...rest, { ...step, kind: step.kind === 'add' ? 'add' : 'edit', ...(fields.length ? { fields } : {}) }];
}

const BLOCK_FIELDS: Record<string, string> = {
  title: 'название', loop: 'повторы и условие', on_fail: 'что делать, если условие не выполнено', knowledge: 'теги знаний', plugins: 'плагины',
  flow: 'вызываемый flow', input: 'задача вызова', next: 'развилка после блока',
};
const ART_FIELDS: Record<string, string> = { title: 'название', file: 'имя файла', initial: 'заготовка', decisions: 'ответы на паузы' };
const FLOW_FIELDS: Record<string, string> = { description: 'описание', input: 'задача по умолчанию', defaults: 'настройки по умолчанию' };
const FIELD_LABELS = { phase: PHASE_FIELDS, block: BLOCK_FIELDS, artifact: ART_FIELDS, flow: FLOW_FIELDS };

/** Поля шага словами: «промпт, что передать следующему этапу»; незнакомый ключ — как есть. */
export const stepFields = (what: keyof typeof FIELD_LABELS, fields: string[] | undefined): string =>
  (fields ?? []).map((f) => (FIELD_LABELS[what][f] ? t(FIELD_LABELS[what][f]!) : f)).join(', ');

export type StepView = { text: string; detail: string };

/** Шаг словами; current — последний шаг идущей правки: «Правлю этап…», у прошедших — «Поправил этап…». */
export function stepView(s: FlowEditStep, current: boolean): StepView {
  if (s.kind === 'read') {
    const parts = [
      s.blocks > 1 ? `${s.blocks} ${plural(s.blocks, 'блок', 'блока', 'блоков')}` : '',
      `${s.phases} ${plural(s.phases, 'этап', 'этапа', 'этапов')}`,
      s.artifacts ? `${s.artifacts} ${plural(s.artifacts, 'файл', 'файла', 'файлов')}` : '',
    ].filter(Boolean);
    return { text: t('Прочитал flow: {what}', { what: parts.join(', ') }), detail: '' };
  }
  const detail = s.kind === 'edit' ? stepFields(s.what, s.fields) : '';
  if (s.what === 'flow') return { text: current ? t('Правлю настройки flow') : t('Поправил настройки flow'), detail };
  if (s.what === 'block' && s.name === 'main' && !s.title && s.kind === 'edit') {
    return { text: current ? t('Правлю повторы и условие') : t('Поправил повторы и условие'), detail: (s.fields ?? []).every((f) => f === 'loop') ? '' : detail };
  }
  const name = s.what === 'artifact' ? s.title || `${s.name}.md` : s.title || s.name;
  const vars = { name };
  const text = {
    phase: { add: t('Добавил этап «{name}»', vars), edit: current ? t('Правлю этап «{name}»', vars) : t('Поправил этап «{name}»', vars), remove: t('Убрал этап «{name}»', vars) },
    block: { add: t('Добавил блок «{name}»', vars), edit: current ? t('Правлю блок «{name}»', vars) : t('Поправил блок «{name}»', vars), remove: t('Убрал блок «{name}»', vars) },
    artifact: { add: t('Добавил файл {name}', vars), edit: current ? t('Правлю файл {name}', vars) : t('Поправил файл {name}', vars), remove: t('Убрал файл {name}', vars) },
  }[s.what][s.kind];
  return { text, detail };
}

/** Этапы и блоки, которые идущая правка уже тронула: подсветка на схеме по мере правки. */
export function stepsTouched(steps: FlowEditStep[]): { phases: Set<string>; blocks: Set<string> } {
  const out = { phases: new Set<string>(), blocks: new Set<string>() };
  for (const s of steps) {
    if (s.kind === 'read' || s.kind === 'remove') continue;
    if (s.what === 'phase') out.phases.add(s.name);
    else if (s.what === 'block') out.blocks.add(s.name);
  }
  return out;
}

/** Заголовок идущей правки в помощнике: «Подключаюсь», «Правлю flow», «Исправляю ошибки валидации 1/2». */
export function workLabel(s: AiProgress): string {
  const st = s.stage;
  if (!st) return t('Подключаюсь');
  if (st.kind === 'repair') return t('Исправляю ошибки валидации {n}/{of}', { n: st.attempt, of: st.of });
  return st.kind === 'generate' ? t('Генерирую flow') : t('Правлю flow');
}
