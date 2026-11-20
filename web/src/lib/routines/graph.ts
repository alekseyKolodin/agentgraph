// Путь одного срабатывания рутины по её шагам (docs/ASSISTANTS.md §4) — для «Срабатываний»: Триггер → Условия по полям
// → ИИ рутины → Дело → Запустить flow → Ждать меня → Ответить; какие шаги пройдены, где событие остановилось и почему.
// Редактор рисует правило разделами (screens/routines/sections), отсюда берёт подписи моделей. Без React и DOM.
import type { LogEntry, LogExplain } from '@server/routines/types';
import { MODELS } from '../flow/tools';
import { t } from '../i18n';

export type NodeId = 'trigger' | 'conds' | 'ai' | 'task' | 'run' | 'wait' | 'reply';

/** Подпись модели: название из общего списка, иначе id как есть; '' — «по умолчанию». */
export function modelName(id: string | undefined, fallback: string): string {
  const v = id?.trim();
  if (!v) return fallback;
  return MODELS.find(([m]) => m === v)?.[1] ?? v;
}

/** Модель узла «ИИ рутины» по умолчанию (CHECK_MODEL сервера — haiku): подпись, когда своя не выбрана. */
export const DEFAULT_CHECK_MODEL = t('haiku, по умолчанию');

// ---------------------------------------------------------------- путь срабатывания

/** pass — событие прошло узел; stop — здесь остановилось; ask — здесь ждёт человека; off — до узла не дошло. */
export type PathState = 'pass' | 'stop' | 'ask' | 'off';
export type PathNode = { id: NodeId; title: string; state: PathState; note: string; model?: string };

const TITLES: Record<NodeId, string> = {
  trigger: t('Триггер'),
  conds: t('Условия по полям'),
  ai: t('ИИ рутины'),
  task: t('Дело'),
  run: t('Запустить flow'),
  wait: t('Ждать меня'),
  reply: t('Ответить'),
};

const ORDER: NodeId[] = ['trigger', 'conds', 'ai', 'task', 'run', 'wait', 'reply'];

/** Узел, на котором событие остановилось, и состояние остановки. Нет — событие прошло весь путь. */
function stopOf(e: LogEntry, x: Pick<LogExplain, 'check'>): { at: NodeId; state: 'stop' | 'ask'; note: string } | undefined {
  const reason = e.reason?.trim() ?? '';
  switch (e.outcome) {
    case 'missed':
      return { at: 'trigger', state: 'stop', note: reason || t('пришло, пока приложение было закрыто') };
    case 'filtered':
      return { at: 'conds', state: 'stop', note: reason || t('не подошло по полям') };
    case 'check_no':
      return { at: 'ai', state: 'stop', note: reason || t('ИИ решил: не подходит') };
    case 'duplicate':
      // повтор «по смыслу» — ответ ИИ рутины. Повтор по вещи движок находит сам: до модели, а у рутины с делом — уже
      // после неё, когда дело получило сигнал, а запуск срезан
      if (!e.sameAs) return { at: 'ai', state: 'stop', note: reason || t('повтор недавнего') };
      return { at: e.deskKey ? 'task' : 'conds', state: 'stop', note: reason || t('повтор: по этой вещи запуск уже был') };
    case 'waiting':
      return e.unsure ? { at: 'ai', state: 'ask', note: e.why ? t('ИИ не уверен: {why}', { why: e.why }) : t('ИИ не уверен и спрашивает тебя') } : { at: 'wait', state: 'ask', note: t('ждёт тебя') };
    case 'rejected':
      return { at: e.unsure ? 'ai' : 'wait', state: 'stop', note: t('ты ответил: не то') };
    case 'limit':
      return { at: 'run', state: 'stop', note: reason || t('упёрлось в лимит') };
    case 'task':
      return { at: 'task', state: 'stop', note: reason || t('дело заведено, запуска нет') };
    case 'error':
      if (reason.startsWith('дело не завелось')) return { at: 'task', state: 'stop', note: reason };
      // проверка словами упала — у строки нет ни ответа ИИ, ни запуска, и причина не про запуск
      return { at: x.check && !e.why && !e.runId && !e.checkModel && !/запуск|flow/i.test(reason) ? 'ai' : 'run', state: 'stop', note: reason || t('ошибка') };
    default:
      return undefined;
  }
}

/** Путь одного срабатывания по узлам рутины: что прошло, где встало, до чего не дошло. */
export function eventPath(e: LogEntry, x: Pick<LogExplain, 'schedule' | 'conditions' | 'check' | 'answer'>, o: { hasTask?: boolean; runs?: boolean; replies?: boolean } = {}): PathNode[] {
  const ids: NodeId[] = x.schedule ? ['trigger', 'run', 'wait', 'reply'] : ['trigger', 'conds', 'ai', ...(o.hasTask ? (['task'] as const) : []), 'run', 'wait', 'reply'];
  const shown = ids.filter((id) => (id === 'run' || id === 'wait' || id === 'reply' ? o.runs !== false : true) && (id !== 'reply' || o.replies !== false));
  const stop = stopOf(e, x);
  // узла остановки на этом графе нет (дело убрали из правила, рутина без запуска) — событие встало на ближайшем узле до него
  const at = stop ? ORDER.indexOf(stop.at) : -1;
  const stopIdx = stop ? shown.reduce((best, id, i) => (ORDER.indexOf(id) <= at ? i : best), 0) : -1;
  return shown.map((id, i) => {
    if (stop && i > stopIdx) return { id, title: TITLES[id], state: 'off' as const, note: t('не дошло') };
    if (stop && i === stopIdx) return { id, title: TITLES[id], state: stop.state, note: stop.note, ...(id === 'ai' && e.checkModel ? { model: e.checkModel } : {}) };
    // ждёт человека до запуска (режим «перед запуском»): flow ещё не запускался, хотя узел стоит раньше «Ждать меня»
    if (stop?.at === 'wait' && id === 'run' && !e.runId) return { id, title: TITLES[id], state: 'off' as const, note: t('ещё не запущен') };
    let note = '';
    if (id === 'trigger') note = x.schedule ? t('по расписанию') : t('событие пришло');
    else if (id === 'conds') note = x.conditions.length ? t('условия совпали') : t('условий нет');
    else if (id === 'ai') note = x.check ? (e.why?.trim() || x.answer || t('подходит')) : t('выключен');
    else if (id === 'task') note = e.deskKey ? t('дело заведено') : t('без дела');
    else if (id === 'run') note = e.runId ? t('запуск начат') : '';
    else if (id === 'wait') note = e.outcome === 'started' ? t('ждать не пришлось или ты уже ответил') : '';
    else if (id === 'reply') note = e.replied ? t('ответ отправлен') : t('ответа не было');
    return { id, title: TITLES[id], state: 'pass' as const, note, ...(id === 'ai' && x.check && e.checkModel ? { model: e.checkModel } : {}) };
  });
}
