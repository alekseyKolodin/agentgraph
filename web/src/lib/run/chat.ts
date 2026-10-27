// Чат запуска без React: строка над чатом, подписи шагов трассы, тексты кнопок действий и их итога, живой ход ответа.
// Подписи строятся здесь, а не на сервере: шаг в chat.json — инструмент и его аргумент, язык подписи — язык интерфейса.
import type { ChatAction, ChatLink, ChatLive, ChatMessage, ChatPayload, ChatStep, ChatStreamEvent } from '@server/api-types';
import { usd } from '../format';
import { plural, t } from '../i18n';

/** Строка над чатом: сообщений, потрачено, «агент отвечает…». */
export function chatMeta(messages: { role: string }[], totalCostUsd: number | undefined, busy: boolean): string {
  const n = messages.filter((m) => m.role !== 'note').length;
  return [n ? t('сообщений {n}', { n }) : '', totalCostUsd ? t('потрачено {cost}', { cost: usd(totalCostUsd) }) : '', busy ? t('агент отвечает…') : ''].filter(Boolean).join(' · ');
}

// ---------- трасса

/** Вид шага — значок и цвет в трассе: чтение, поиск, команда, правка, управление запуском, прочее. */
export type StepKind = 'read' | 'search' | 'cmd' | 'edit' | 'run' | 'other';

const RUN = 'mcp__run__';

export function stepKind(s: ChatStep): StepKind {
  switch (s.tool) {
    case 'Read':
    case `${RUN}run_status`:
    case `${RUN}run_log`:
    case `${RUN}artifacts`:
    case `${RUN}flow_read`:
      return 'read';
    case 'Grep':
    case 'Glob':
      return 'search';
    case 'Bash':
      return 'cmd';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case `${RUN}pause_run`:
    case `${RUN}resume_run`:
    case `${RUN}set_max_iterations`:
    case `${RUN}answer_question`:
    case `${RUN}run_note`:
      return 'run';
    default:
      return 'other';
  }
}

/** Подпись шага: «Читает iter-02/01-code.output.md», «Поставил на паузу». Команда — как есть, со знаком $. */
export function stepLabel(s: ChatStep): string {
  const target = s.target ?? '';
  switch (s.tool) {
    case 'Read': return t('Читает {target}', { target });
    case 'Edit':
    case 'NotebookEdit': return t('Правит {target}', { target });
    case 'Write': return t('Пишет {target}', { target });
    case 'Grep': return t('Ищет «{target}»', { target });
    case 'Glob': return t('Ищет файлы {target}', { target });
    case 'Bash': return `$ ${target}`;
    case 'Skill': return t('Скилл {target}', { target });
    case `${RUN}run_status`: return t('Смотрит состояние запуска');
    case `${RUN}run_log`: return t('Читает живой лог');
    case `${RUN}pause_run`: return t('Поставил на паузу');
    case `${RUN}resume_run`: return t('Возобновил запуск');
    case `${RUN}set_max_iterations`: return t('Лимит итераций: {target}', { target });
    case `${RUN}answer_question`: return t('Ответил на вопрос агента');
    case `${RUN}artifacts`: return target ? t('Читает артефакт {target}', { target }) : t('Смотрит артефакты');
    case `${RUN}flow_read`: return t('Читает flow');
    case `${RUN}run_note`: return t('Указание этапу: {target}', { target });
    default: {
      // mcp__<сервер>__<инструмент> — имя инструмента без сервера
      const name = s.tool.startsWith('mcp__') ? s.tool.split('__').slice(2).join('__') || s.tool : s.tool;
      return target ? `${name} ${target}` : name;
    }
  }
}

/** Свёрнутая трасса над ответом: «6 действий», с ошибками — «6 действий · 1 с ошибкой». */
export function stepsSummary(steps: ChatStep[]): string {
  const n = steps.length;
  const errors = steps.filter((s) => s.error).length;
  const head = `${n} ${plural(n, 'действие', 'действия', 'действий')}`;
  return errors ? `${head} · ${t('{n} с ошибкой', { n: errors })}` : head;
}

// ---------- кнопки действий

/**
 * Подтверждение перед действием: что именно произойдёт, подпись кнопки «да» по виду действия (не текст агента —
 * он мог бы противоречить вопросу), danger — красная кнопка.
 */
export function actionConfirm(a: ChatAction, flow: string): { text: string; ok: string; danger: boolean } {
  const what = a.target ?? '';
  const run = [a.model ? t('модель {model}', { model: a.model }) : '', a.maxBudgetUsd ? t('лимит {cost}', { cost: usd(a.maxBudgetUsd) }) : ''].filter(Boolean).join(', ');
  const extra = run ? ` (${run})` : '';
  switch (a.kind) {
    case 'abort': return { text: t('Остановить запуск? Текущая сессия будет прервана.'), ok: t('Остановить запуск'), danger: true };
    case 'write_artifact': return { text: t('Записать артефакт {what} текстом, который предложил агент? Прежняя версия останется в истории артефакта.', { what }), ok: t('Записать'), danger: false };
    case 'answer_pause': return { text: t('Записать ответ в {what} и возобновить запуск?', { what }), ok: t('Ответить и возобновить'), danger: false };
    case 'save_flow': {
      const text = a.keepsSnapshot
        ? t('Сохранить flow в {what}? Это общий файл: правка подействует на все следующие запуски flow {flow}. Продолжение этого запуска останется на его снимке: правку на ходу в flows/ не сохраняли.', { what, flow })
        : t('Сохранить flow в {what}? Это общий файл: правка подействует на все следующие запуски и продолжения flow {flow}.', { what, flow });
      return { text, ok: t('Сохранить в flows/'), danger: false };
    }
    case 'continue': return { text: t('Продолжить запуск с места остановки новым запуском{extra}?', { extra }), ok: t('Продолжить'), danger: false };
    case 'rerun': {
      const text = a.keepsSnapshot
        ? t('Запустить flow {flow} заново с той же задачей{extra}? Возьмётся файл из flows/: правка flow на ходу этого запуска в него не войдёт.', { flow, extra })
        : t('Запустить flow {flow} заново с той же задачей{extra}?', { flow, extra });
      return { text, ok: t('Запустить заново'), danger: false };
    }
    case 'apply_flow': return { text: t('Применить правку flow к этому запуску? Запуск продолжит по новой версии.'), ok: t('Применить'), danger: false };
    case 'reload_flow': return { text: t('Подхватить в этот запуск текущий файл flow из flows/?'), ok: t('Подхватить'), danger: false };
    case 'restart_iteration': return { text: t('Перезапустить текущую итерацию? Её этапы пойдут заново, когда запуск возобновят.'), ok: t('Перезапустить итерацию'), danger: true };
    default: return { text: a.label, ok: t('Выполнить'), danger: false };
  }
}

/** Пояснение под кнопкой: что именно она сделает (цель, модель, лимит). */
export function actionMeta(a: ChatAction): string {
  return [
    a.target ?? '',
    a.model ? t('модель {model}', { model: a.model }) : '',
    a.maxBudgetUsd ? t('лимит {cost}', { cost: usd(a.maxBudgetUsd) }) : '',
  ].filter(Boolean).join(' · ');
}

/** Итог нажатой кнопки; null — ещё не нажимали. */
export function actionState(a: ChatAction): { text: string; tone: 'ok' | 'fail' | 'off' } | null {
  switch (a.state) {
    case 'done': return { text: t('✓ выполнено', undefined, 'action'), tone: 'ok' };
    case 'failed': return { text: t('✕ не вышло'), tone: 'fail' };
    case 'expired': return { text: t('устарело'), tone: 'off' };
    default: return null;
  }
}

/** Варианты ответа видны только у последнего ответа агента, пока пользователь ничего не написал после него. */
export function repliesAt(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') return -1;
    if (m.role === 'assistant') return m.widgets?.some((w) => w.type === 'replies') ? i : -1;
  }
  return -1;
}

/** Подпись ссылки: своя от агента или ref; у этапа — с блоком. */
export function linkLabel(l: ChatLink): string {
  if (l.label) return l.label;
  return l.kind === 'phase' && l.block ? `${l.block} · ${l.ref}` : l.ref;
}

// ---------- живой ход ответа

/** Пустой ход: шагов, текста и виджетов ещё нет. */
export const emptyLive = (): ChatLive => ({ steps: [], widgets: [] });

/**
 * Событие потока в живой ход: step — новый или тот же с ошибкой (по index), text — последний текст, widget — в конец.
 * Остальные события ход не меняют. true — ход изменился, нужна перерисовка.
 */
export function applyLive(live: ChatLive, e: ChatStreamEvent): boolean {
  if (e.type === 'step') {
    live.steps[e.index] = e.step;
    return true;
  }
  if (e.type === 'text') {
    live.text = e.text;
    return true;
  }
  if (e.type === 'widget') {
    live.widgets.push(e.widget);
    return true;
  }
  return false;
}

/** Ход с сервера (вернулись посреди ответа или ответ идёт в другой вкладке): копия, чтобы поток правил свою. */
export const liveOf = (p: ChatPayload | null): ChatLive =>
  p?.live ? { steps: [...p.live.steps], widgets: [...p.live.widgets], ...(p.live.text ? { text: p.live.text } : {}) } : emptyLive();
