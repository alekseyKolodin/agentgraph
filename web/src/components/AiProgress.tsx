// Ход ИИ над flow (генерация в «Новый flow», «Правка с ИИ» в конструкторе): что за модель, какой шаг, сколько идёт,
// последние строки хода, повтор запроса к API, «нет вестей» и «Прервать». Логика — lib/flow/ai-progress.ts.
// Здесь же выбор модели для ИИ: один на диалог и конструктор, запоминается в localStorage.
import { useSyncExternalStore } from 'react';
import { defaultModelLabel, elapsed, isSilent, modelChip, retryLabel, silenceMs, stageLabel, type AiProgress as Progress } from '../lib/flow/ai-progress';
import { modelOptions } from '../lib/flow/tools';
import { t } from '../lib/i18n';
import { LS } from '../lib/storage';
import { useNow } from './useNow';
import styles from './AiProgress.module.css';

const TICK_MS = 1000;

/** onAbort — своя кнопка «Прервать»; нет — она стоит снаружи (в липкой панели конструктора). */
export function AiProgress({ progress: p, onAbort, className }: { progress: Progress; onAbort?: () => void; className?: string }) {
  const now = useNow(TICK_MS);
  const silent = isSilent(p, now);
  const retry = retryLabel(p, now);
  return (
    <div className={className ? `${styles.aiProgress} ${className}` : styles.aiProgress} role="status" aria-live="polite">
      <div className={styles.head}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.stage}>{stageLabel(p)}</span>
        {p.model
          ? <span className={styles.chip} title={t('Модель сессии: {model}', { model: p.model })}>{modelChip(p.model)}</span>
          : <span className={`${styles.chip} ${styles.pending}`} title={t('Модель станет известна, когда сессия запустится')}>{t('модель…')}</span>}
        <span className={styles.timer} role="timer" title={t('Сколько идёт')}>{elapsed(now - p.startedAt)}</span>
        {onAbort && <button type="button" className="btn small ghost" onClick={onAbort} title={t('Остановить сессию: траты прекратятся, flow не изменится')}>{t('Прервать')}</button>}
      </div>
      {retry && <p className={styles.warn}>{retry}</p>}
      {p.lines.length > 0 ? (
        <ul className={styles.lines}>
          {p.lines.map((l, k) => <li key={k} className={l.trimStart().startsWith('↳') ? styles.result : undefined} title={l}>{l}</li>)}
        </ul>
      ) : (
        <p className={styles.quiet}>
          {p.kind === 'generate'
            ? t('Генератор работает без инструментов: думает молча и присылает flow целиком в конце.')
            : t('Здесь появятся шаги ИИ: чтение и правки файла flow.')}
        </p>
      )}
      {silent && (
        <p className={styles.warn}>
          {t('Нет вестей {time}. Модель может долго думать молча; если это дольше обычного — прерви и попробуй снова.', { time: elapsed(silenceMs(p, now)) })}
        </p>
      )}
    </div>
  );
}

// --- модель ИИ: '' — по умолчанию (модель Claude Code); фактическую модель по умолчанию запоминаем, когда её назвала сессия
const MODEL_KEY = 'agentgraph.flowAiModel';
const DEFAULT_KEY = 'agentgraph.flowAiDefaultModel';

let model = LS.get<string>(MODEL_KEY, '');
let actualDefault = LS.get<string>(DEFAULT_KEY, '') || undefined;
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const changed = () => {
  version++;
  for (const fn of listeners) fn();
};

/** Выбранная модель ИИ ('' — по умолчанию): то, что уходит в запрос. */
export const aiModel = (): string => model;

/** Сессия назвала модель: при выборе «по умолчанию» это и есть модель по умолчанию — подпись пункта её покажет. */
export function noteAiModel(sent: string, actual: string): void {
  if (sent || actual === actualDefault) return;
  actualDefault = actual;
  LS.set(DEFAULT_KEY, actual);
  changed();
}

export function AiModelSelect({ disabled, className }: { disabled?: boolean; className?: string }) {
  useSyncExternalStore(subscribe, () => version);
  return (
    <select
      className={className ?? styles.model}
      aria-label={t('Модель ИИ')}
      title={actualDefault && !model
        ? t('Модель, которая генерирует и правит flow. «По умолчанию» — модель Claude Code по умолчанию, сейчас {model}.', { model: actualDefault })
        : t('Модель, которая генерирует и правит flow. «По умолчанию» — модель Claude Code по умолчанию.')}
      disabled={disabled}
      value={model}
      onChange={(e) => {
        model = e.target.value;
        LS.set(MODEL_KEY, model);
        changed();
      }}
    >
      {modelOptions(model).map(([id, label]) => <option key={id} value={id}>{id ? label : defaultModelLabel(actualDefault)}</option>)}
    </select>
  );
}
