// Граф рутины (docs/ASSISTANTS.md §4): фиксированная цепочка узлов — Триггер → Условия по полям → ИИ рутины → Дело →
// Запустить flow → Ждать меня → Ответить. Здесь — что написать на узле по черновику формы (кто работает, что настроено,
// сколько событий дошло на истории) и путь одного срабатывания по тому же графу: какие узлы пройдены, где событие
// остановилось и почему. Без React и DOM.
import type { HistoryCheck, LogEntry, LogExplain } from '@server/routines/types';
import { MODELS } from '../flow/tools';
import { plural, t } from '../i18n';
import { describeSchedule, toCron } from './schedule';
import { everyLabel } from './source';
import { draftRuns, isSchedule, type RoutineDraft } from './spec';

export type NodeId = 'trigger' | 'conds' | 'ai' | 'task' | 'run' | 'wait' | 'reply';

/** Кто работает в узле: никто (без модели), модель, сам человек. */
export type NodeWho = { kind: 'none' | 'model' | 'me'; label: string };

export type GraphNode = {
  id: NodeId;
  title: string;
  /** Что настроено, одной строкой. */
  sub: string;
  who: NodeWho;
  /** Узел сейчас ничего не делает (ИИ без условия, дело не заводится, запуска нет): рисуется приглушённо. */
  off?: boolean;
  /** Сколько событий прошло узел на последней проверке на истории (у триггера — сколько пришло). */
  count?: number;
  /** Узел «ИИ рутины»: что он решил по событиям истории. */
  outcomes?: { run: number; skip: number; ask: number };
  /** Чего не хватает, чтобы правило заработало: подсказка на узле. */
  warn?: string;
};

export type GraphCtx = {
  /** Источник черновика: название, вид, частота опроса. */
  source?: { title: string; kind: string; every?: string };
  /** Как приходят события вида: live — сразу, poll — опрос, model — каждую проверку читает модель. */
  delivery?: 'live' | 'poll' | 'model';
  /** Куда уйдёт ответ, словами («в тред Slack»). */
  replyWhere?: string;
  /** Последняя проверка на истории: по ней счётчики узлов. */
  hist?: HistoryCheck | null;
  /** Чего не хватает (draftMissing). */
  missing?: string[];
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Подпись модели: название из общего списка, иначе id как есть; '' — «по умолчанию». */
export function modelName(id: string | undefined, fallback: string): string {
  const v = id?.trim();
  if (!v) return fallback;
  return MODELS.find(([m]) => m === v)?.[1] ?? v;
}

/** Модель узла «ИИ рутины» по умолчанию (CHECK_MODEL сервера — haiku): подпись, когда своя не выбрана. */
export const DEFAULT_CHECK_MODEL = t('haiku, по умолчанию');

const NONE: NodeWho = { kind: 'none', label: t('без модели') };

/** Счётчики узлов по проверке на истории: сколько событий пришло, прошло условия, что решил ИИ, сколько запустилось бы. */
export function historyCounts(hist: HistoryCheck | null | undefined): { total: number; conds: number; run: number; skip: number; ask: number } | undefined {
  if (!hist) return undefined;
  const ev = hist.events;
  const passed = ev.filter((e) => e.outcome !== 'filtered');
  const ask = passed.filter((e) => e.unsure).length;
  const run = passed.filter((e) => !e.unsure && (e.outcome === 'started' || e.outcome === 'waiting')).length;
  return { total: ev.length, conds: passed.length, run, ask, skip: passed.length - run - ask };
}

/** Узлы графа по черновику: расписание — без условий и ИИ (событий нет), рутина только с делом — запуск приглушён. */
export function routineNodes(d: RoutineDraft, ctx: GraphCtx = {}): GraphNode[] {
  const sched = isSchedule(d);
  const runs = draftRuns(d);
  const c = sched ? undefined : historyCounts(ctx.hist);
  const missing = ctx.missing ?? [];
  const out: GraphNode[] = [];

  if (sched) {
    out.push({ id: 'trigger', title: t('Триггер'), sub: t('Расписание: {when}', { when: describeSchedule(toCron(d.schedule)) }), who: NONE });
  } else {
    const src = ctx.source;
    const how = ctx.delivery === 'live' ? t('события приходят сразу') : src?.every ? t('опрос {every}', { every: everyLabel(src.every) }) : t('опрос');
    out.push({
      id: 'trigger',
      title: t('Триггер'),
      sub: src ? `${src.title} · ${how}` : t('источник не выбран'),
      // «Сервис через Claude» без скрипта читает сервис моделью на каждой проверке — это видно на узле
      who: ctx.delivery === 'model' ? { kind: 'model', label: t('модель на каждой проверке') } : NONE,
      ...(c ? { count: c.total } : {}),
      ...(missing.includes('source') ? { warn: t('выбери, что запускает') } : {}),
    });
    out.push({
      id: 'conds',
      title: t('Условия по полям'),
      sub: d.conds.length ? t('{n} {w}', { n: d.conds.length, w: plural(d.conds.length, 'условие', 'условия', 'условий') }) : t('условий нет: проходит любое событие'),
      who: NONE,
      off: !d.conds.length,
      ...(c ? { count: c.conds } : {}),
    });
    const check = d.check.trim();
    out.push({
      id: 'ai',
      title: t('ИИ рутины'),
      sub: check ? clip(check, 110) : t('выключен: проходит всё, что прошло условия'),
      who: check ? { kind: 'model', label: modelName(d.checkModel, DEFAULT_CHECK_MODEL) } : NONE,
      off: !check,
      ...(c && check ? { count: c.run + c.ask, outcomes: { run: c.run, skip: c.skip, ask: c.ask } } : {}),
    });
  }

  out.push({
    id: 'task',
    title: t('Дело'),
    sub: d.taskOn ? (d.taskFrom === 'flow' ? t('«{kind}» заводит flow', { kind: d.taskKind || '…' }) : t('«{kind}» в «{col}»', { kind: d.taskKind || '…', col: d.taskColumn === 'plan' ? t('В плане') : t('Новое') })) : t('не заводить'),
    who: NONE,
    off: !d.taskOn,
    ...(missing.includes('kind') ? { warn: t('назови вид дела') } : missing.includes('close') ? { warn: t('напиши, когда закрыть дело') } : {}),
  });

  const where = [d.space, d.worktree === 'new' ? t('новое рабочее дерево') : ''].filter(Boolean).join(' · ');
  out.push({
    id: 'run',
    title: t('Запустить flow'),
    sub: !runs ? t('ничего — только завести дело') : d.flow ? [d.flow, where].filter(Boolean).join(' · ') : t('flow не выбран'),
    who: runs ? { kind: 'model', label: modelName(d.model, t('модель flow')) } : NONE,
    off: !runs,
    ...(c && runs ? { count: c.run } : {}),
    ...(missing.includes('flow') ? { warn: t('выбери flow') } : {}),
  });
  out.push({
    id: 'wait',
    title: t('Ждать меня'),
    sub: !runs ? t('ждать нечего') : d.mode === 'suggest' ? t('перед запуском') : d.mode === 'until_pause' ? (d.pauseBefore.length ? t('перед блоком «{block}»', { block: d.pauseBefore.join('», «') }) : t('перед блоком — блок не выбран')) : t('не ждать'),
    who: runs && d.mode !== 'auto' ? { kind: 'me', label: t('ты') } : NONE,
    off: !runs || d.mode === 'auto',
    ...(missing.includes('block') ? { warn: t('выбери блок, перед которым ждать') } : {}),
  });
  out.push({
    id: 'reply',
    title: t('Ответить'),
    sub: !runs || d.reply === 'off' ? t('не сообщать') : `${ctx.replyWhere ?? t('в источник')}, ${d.reply === 'draft' ? t('после твоей проверки') : t('сразу')}`,
    who: runs && d.reply === 'draft' ? { kind: 'me', label: t('ты проверяешь') } : NONE,
    off: !runs || d.reply === 'off',
  });
  return out;
}

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
