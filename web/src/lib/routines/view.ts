// Что показывать в списке рутин, журнале срабатываний и карточках главной: состояние рутины (точка и подпись), полоска
// последних срабатываний, исход строки журнала с цветом и действием, фильтры-чипы, кнопки карточки ожидания и «догнать».
import type { CatchUp, Feedback, HistoryCheck, LogEntry, LogOutcome, RoutineView, RoutineWait, SourceView } from '@server/routines/types';
import { usd } from '../format';
import { plural, t } from '../i18n';

/** Состояние рутины в списке (States → «Состояния рутины в списке»). */
export type RoutineState = 'waiting' | 'running' | 'source_error' | 'needs_secret' | 'problem' | 'paused' | 'draft' | 'ok';
/** Тон точки: цвет — только смысл (system.md → Signals). off — пустой кружок. */
export type Tone = 'ok' | 'live' | 'wait' | 'fail' | 'off' | 'muted';

/** Черновик — выключена и ни разу не срабатывала (отдельного поля в RoutineSpec нет). */
/** Черновик — сохранён с «Новой рутины» и ещё не включался (spec.draft); выключенная после работы рутина — на паузе. */
export const isDraft = (r: Pick<RoutineView, 'spec'>): boolean => r.spec.enabled === false && r.spec.draft === true;

const sourceOf = (r: RoutineView, sources: SourceView[]) => ('source' in r.spec.when ? sources.find((s) => s.slug === (r.spec.when as { source: string }).source) : undefined);

/** Идущие запуски: runId → статус ('running' и т. п.), из списка запусков. */
export type RunStatuses = ReadonlyMap<string, string>;
const LIVE = new Set(['running', 'pending', 'waiting', 'paused']);

export function routineState(r: RoutineView, sources: SourceView[], waits: RoutineWait[], runs: RunStatuses = new Map()): RoutineState {
  if (isDraft(r)) return 'draft';
  if (r.spec.enabled === false) return 'paused';
  if (r.stats.waiting > 0 || waits.some((w) => w.routine === r.slug)) return 'waiting';
  const src = sourceOf(r, sources);
  if (src?.status === 'needs_secret' || (src && src.missingSecrets.length)) return 'needs_secret';
  if (src?.status === 'error') return 'source_error';
  if (r.problems.length) return 'problem';
  if (r.recent.some((e) => e.outcome === 'started' && e.runId && LIVE.has(runs.get(e.runId) ?? ''))) return 'running';
  return 'ok';
}

export function stateTone(s: RoutineState): Tone {
  return { waiting: 'wait', running: 'live', source_error: 'fail', needs_secret: 'wait', problem: 'fail', paused: 'off', draft: 'muted', ok: 'ok' }[s] as Tone;
}

export function stateLabel(s: RoutineState): string {
  return {
    waiting: t('Ждёт тебя'),
    running: t('Идёт запуск'),
    source_error: t('Источник молчит'),
    needs_secret: t('Нет ключа'),
    problem: t('Есть ошибки'),
    paused: t('На паузе'),
    draft: t('Черновик'),
    ok: t('Включена'),
  }[s];
}

/** Пилюля в шапке редактора и журнала. */
export function pillLabel(r: Pick<RoutineView, 'spec' | 'stats' | 'recent'>): string {
  return isDraft(r) ? t('черновик') : r.spec.enabled === false ? t('на паузе') : t('включена');
}

/** Отметка полоски: o готово, f не довёл, w ждёт, l идёт, s пропуск, e ошибка, c — пусто (ещё не было). */
export type Tick = 'o' | 'f' | 'w' | 'l' | 's' | 'e' | 'c';

const FAILED = new Set(['failed', 'budget_exceeded', 'aborted', 'interrupted', 'max_iterations']);

function startedTick(e: LogEntry, runs: RunStatuses): Tick {
  const st = e.runId ? runs.get(e.runId) : undefined;
  if (st && LIVE.has(st)) return 'l';
  if (st && FAILED.has(st)) return 'f';
  return 'o';
}

export function tickOf(e: LogEntry, runs: RunStatuses = new Map()): Tick {
  switch (e.outcome) {
    case 'started':
      return startedTick(e, runs);
    case 'waiting':
      return 'w';
    case 'error':
      return 'e';
    default:
      return 's';
  }
}

/** Полоска последних n событий: старые слева, свежие справа; не хватает — пустые клетки в конце. recent — новые сверху. */
export function strip(recent: LogEntry[], runs: RunStatuses = new Map(), n = 14): Tick[] {
  const ticks = [...recent].sort((a, b) => a.at.localeCompare(b.at)).slice(-n).map((e) => tickOf(e, runs));
  while (ticks.length < n) ticks.push('c');
  return ticks;
}

/** Подсказка полоски: «Последние события: 9 запусков, 4 пропущено». */
export function stripTitle(ticks: Tick[]): string {
  const runs = ticks.filter((x) => x === 'o' || x === 'f' || x === 'w' || x === 'l').length;
  const skips = ticks.filter((x) => x === 's').length;
  return t('Последние события: {runs} {rw}, {skips} пропущено', { runs, rw: plural(runs, 'запуск', 'запуска', 'запусков'), skips });
}

/** Фильтры журнала: все, ждут тебя, запущено, пропущено; «ошибки» — только когда есть. */
export type LogChip = 'all' | 'wait' | 'run' | 'skip' | 'error';

export function chipOf(o: LogOutcome): Exclude<LogChip, 'all'> {
  if (o === 'waiting') return 'wait';
  if (o === 'started') return 'run';
  if (o === 'error') return 'error';
  return 'skip';
}

export function chipLabel(c: LogChip): string {
  return { all: t('все'), wait: t('ждут тебя'), run: t('запущено'), skip: t('пропущено'), error: t('ошибки') }[c];
}

/** Исходы на сервер для фильтра (?outcome=a,b). */
export function chipOutcomes(c: LogChip): LogOutcome[] | undefined {
  if (c === 'all') return undefined;
  const all: LogOutcome[] = ['started', 'waiting', 'filtered', 'check_no', 'duplicate', 'limit', 'rejected', 'missed', 'error'];
  return all.filter((o) => chipOf(o) === c);
}

export function chipCounts(entries: LogEntry[]): Array<{ chip: LogChip; n: number }> {
  const n = (c: LogChip) => (c === 'all' ? entries.length : entries.filter((e) => chipOf(e.outcome) === c).length);
  const chips: LogChip[] = ['all', 'wait', 'run', 'skip'];
  if (n('error')) chips.push('error');
  return chips.map((chip) => ({ chip, n: n(chip) }));
}

/** Исход строки журнала: слово и тон. Запуск уточняется статусом запуска (идёт, готово, не довёл). */
export function verdict(e: LogEntry, runs: RunStatuses = new Map()): { text: string; tone: Tone } {
  switch (e.outcome) {
    case 'started': {
      const tick = startedTick(e, runs);
      const st = e.runId ? runs.get(e.runId) : undefined;
      if (tick === 'l') return { text: t('идёт'), tone: 'live' };
      if (tick === 'f') return { text: t('не довёл'), tone: 'fail' };
      return st ? { text: t('готово'), tone: 'ok' } : { text: t('запущено'), tone: 'ok' };
    }
    case 'waiting':
      return { text: t('ждёт тебя'), tone: 'wait' };
    case 'filtered':
    case 'check_no':
      return { text: t('пропуск'), tone: 'muted' };
    case 'duplicate':
      return { text: t('повтор'), tone: 'muted' };
    case 'limit':
      return { text: t('лимит'), tone: 'muted' };
    case 'rejected':
      return { text: t('не то'), tone: 'muted' };
    case 'missed':
      return { text: t('простой'), tone: 'muted' };
    case 'error':
      return { text: t('ошибка'), tone: 'fail' };
  }
}

/** Кнопка строки журнала: open — открыть на главной, run — страница запуска, start — запустить по этому событию. */
export type LogAction = { kind: 'open' | 'run' | 'start'; label: string; primary?: boolean } | null;

export function logAction(e: LogEntry, runs: RunStatuses = new Map()): LogAction {
  if (e.outcome === 'waiting') return { kind: 'open', label: t('Открыть'), primary: true };
  if (e.outcome === 'started') {
    if (!e.runId) return null;
    return startedTick(e, runs) === 'f' ? { kind: 'run', label: t('Продолжить') } : { kind: 'run', label: t('Запуск') };
  }
  if (e.outcome === 'rejected') return null;
  return { kind: 'start', label: t('Запустить') };
}

/** Раскрытые детали строки: почему, что ушло наружу, сколько потрачено. */
export function logDetail(e: LogEntry): string {
  const parts: string[] = [];
  if (e.reason) parts.push(e.reason.trim().replace(/([^.!?…])$/, '$1.'));
  if (e.replied) parts.push(t('Ответ ушёл: «{text}».', { text: e.replied.text }));
  if (e.costUsd) parts.push(t('Потрачено {usd}.', { usd: usd(e.costUsd) }));
  if (!parts.length) parts.push(e.outcome === 'started' ? t('Запуск начат.') : t('Подробностей нет.'));
  return parts.join(' ');
}

/** Время строки журнала в узкой колонке: сегодня — «10:40», вчера — «вчера», раньше — «16.11». */
export function logTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t('вчера');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

/** «за 7 дней · $9.80»: сумма по строкам за неделю. */
export function weekCost(entries: LogEntry[], now: Date = new Date()): number {
  const from = now.getTime() - 7 * 24 * 3600_000;
  return entries.filter((e) => new Date(e.at).getTime() >= from).reduce((s, e) => s + (e.costUsd ?? 0), 0);
}

/** Шапка списка: «сегодня 3 запуска · $2.40» — запуски из stats.today, деньги — по строкам журнала за сегодня. */
export function overviewMeta(routines: RoutineView[], now: Date = new Date()): string {
  const runs = routines.reduce((s, r) => s + r.stats.today, 0);
  const today = now.toDateString();
  const cost = routines.flatMap((r) => r.recent).filter((e) => new Date(e.at).toDateString() === today).reduce((s, e) => s + (e.costUsd ?? 0), 0);
  const head = t('сегодня {n} {w}', { n: runs, w: plural(runs, 'запуск', 'запуска', 'запусков') });
  return cost ? `${head} · ${usd(cost)}` : head;
}

/** Подпись под названием рутины: «Slack · work → bug-to-fix», расписание — «Расписание · По будням в 09:30 → mr-digest». */
export function routineSub(r: RoutineView, sources: SourceView[], scheduleText: (cron: string) => string): string {
  const w = r.spec.when;
  const from = 'schedule' in w ? `${t('Расписание')} · ${scheduleText(w.schedule)}` : (sources.find((s) => s.slug === w.source)?.spec.title ?? w.source);
  return `${from} → ${r.spec.run.flow}`;
}

/**
 * Кнопки карточки ожидания. Вопрос вида «Чинить: …?» даёт глагол кнопке запуска, а «Это не баг» — отказу; иначе
 * «Продолжить» (запуск стоит перед блоком) или «Запустить» (suggest) и «Не то».
 */
export function waitButtons(w: Pick<RoutineWait, 'question' | 'kind'>): { run: string; later: string; reject: string } {
  // запуск кончился, ответ-черновик ждёт отправки
  if (w.kind === 'reply') return { run: t('Отправить'), later: t('Не сейчас'), reject: t('Не отправлять') };
  const m = /^([^\s:?]{2,24}):\s/.exec(w.question.trim());
  const verb = m?.[1];
  const run = verb ?? (w.kind === 'pause' ? t('Продолжить') : t('Запустить'));
  const reject = verb && /^чинить$/i.test(verb) ? t('Это не баг') : t('Не то');
  return { run, later: t('Не сейчас'), reject };
}

/** Строка после решения по карточке. */
export function decisionText(action: 'run' | 'later' | 'reject', w: Pick<RoutineWait, 'kind' | 'replyDraft'>, replied: boolean): string {
  const where = w.replyDraft?.where;
  if (w.kind === 'reply') return action === 'run' ? t('Ответ ушёл: {where}.', { where: where ?? '' }) : action === 'reject' ? t('Ответ не отправлен.') : t('Отложено. Ответ ждёт в срабатываниях рутины.');
  const tail = !w.replyDraft ? '' : replied ? t(' Ответ ушёл: {where}.', { where: where ?? '' }) : t(' Наружу ничего не ушло.');
  if (action === 'run') return (w.kind === 'pause' ? t('Запуск продолжен.') : t('Запуск начат.')) + tail;
  // «Не сейчас» ответ не отправляет: сервер только откладывает ожидание
  if (action === 'later') return t('Отложено. Запуск ждёт в срабатываниях рутины.') + (w.replyDraft ? t(' Наружу ничего не ушло.') : '');
  return t('Закрыто как «не то». Рутина учтёт это в следующий раз.') + (w.replyDraft ? t(' Наружу ничего не ушло.') : '');
}

/** Ушёл ли ответ вместе с решением: «Ответ готов» — только «Отправить»; иначе — галочка, кроме «Не сейчас» и отказа. */
export function replySent(action: 'run' | 'later' | 'reject', w: Pick<RoutineWait, 'kind' | 'replyDraft'>, checked: boolean): boolean {
  if (w.kind === 'reply') return action === 'run';
  return Boolean(w.replyDraft) && checked && action === 'run';
}

/** Ожидания для главной и счётчика рельса: отложенные («Не сейчас») там не показываются. */
export const activeWaits = <W extends Pick<RoutineWait, 'snoozedAt'>>(waits: W[]): W[] => waits.filter((w) => !w.snoozedAt);

/** «догнать»: сколько всего ждёт решения — подходящие события и пропущенные запуски по расписанию. */
export function catchUpCount(list: CatchUp[]): number {
  return list.reduce((s, c) => s + (c.missedAt ? 1 : c.matching), 0);
}

export function catchUpText(list: CatchUp[]): string {
  const n = catchUpCount(list);
  const events = list.reduce((s, c) => s + (c.missedAt ? 0 : c.events), 0);
  if (events > n) return t('Пока приложение было закрыто, пришло {e} {ew} для рутин, {n} {nw}.', { e: events, ew: plural(events, 'событие', 'события', 'событий'), n, nw: plural(n, 'подходит', 'подходят', 'подходят') });
  return t('Пока приложение было закрыто, пришло {n} {w} для рутин.', { n, w: plural(n, 'событие', 'события', 'событий') });
}

/** Кнопка «Запустить оба» / «Запустить все» / «Запустить». */
export function catchUpRunLabel(list: CatchUp[]): string {
  const n = catchUpCount(list);
  return n === 1 ? t('Запустить') : n === 2 ? t('Запустить оба') : t('Запустить все');
}

/** Строка раскрытого «догнать»: что и по какой рутине. */
export function catchUpLine(c: CatchUp, clockOf: (iso: string) => string): string {
  if (c.missedAt) return t('запуск в {time} не состоялся', { time: clockOf(c.missedAt) });
  return t('пришло {e}, подходят {n}', { e: c.events, n: c.matching });
}

// ---------------------------------------------------------------- обратная связь и оценка

export type Verdict = Feedback['verdict'];

/** Кнопка обратной связи: «Это баг» (match), «Не баг» (no_match), «Не повтор» (not_duplicate). */
export function feedbackLabel(v: Verdict): string {
  return { match: t('Это баг'), no_match: t('Не баг'), not_duplicate: t('Не повтор') }[v];
}

/** Подсказка кнопки: что рутина сделает с ответом. */
export function feedbackTitle(v: Verdict): string {
  return {
    match: t('Это подходило: проверка словами возьмёт как пример того, что запускать'),
    no_match: t('Это не подходило: проверка словами возьмёт как пример того, что пропускать'),
    not_duplicate: t('Это не повтор: такие события больше не отсеивать как дубли'),
  }[v];
}

/** Какие ответы предложить у строки журнала: пропуск — «это подходило», запуск — «не подходило», повтор — «не повтор». */
export function feedbackOptions(e: Pick<LogEntry, 'outcome' | 'feedback'>): Verdict[] {
  if (e.feedback) return [];
  if (e.outcome === 'duplicate') return ['not_duplicate'];
  if (e.outcome === 'filtered' || e.outcome === 'check_no') return ['match'];
  if (e.outcome === 'started' || e.outcome === 'waiting') return ['no_match'];
  return [];
}

/** Отметка у строки: «ты отметил: это баг». */
export function feedbackNote(v: Verdict): string {
  return { match: t('ты отметил: это баг'), no_match: t('ты отметил: не баг'), not_duplicate: t('ты отметил: не повтор') }[v];
}

/** «≈ 4 запуска в неделю · $9.80»; нет оценки — ''. */
export function estimateText(est: HistoryCheck['estimate']): string {
  if (!est) return '';
  const n = Math.round(est.runsPerWeek * 10) / 10;
  const runs = t('≈ {n} {w} в неделю', { n, w: plural(Math.round(n), 'запуск', 'запуска', 'запусков') });
  return est.usdPerWeek ? `${runs} · ${usd(est.usdPerWeek)}` : runs;
}

/** Строка проверки на истории: слово исхода и расходится ли с прошлым ответом человека. */
export function historyVerdict(e: HistoryCheck['events'][number]): { text: string; run: boolean; disagrees: boolean; why: string } {
  const run = e.outcome === 'started' || e.outcome === 'waiting';
  const text = run ? t('запуск') : e.outcome === 'duplicate' ? t('повтор') : t('пропуск');
  const disagrees = Boolean(e.disagrees && e.past);
  const why = disagrees
    ? [{ match: t('Ты отметил это как подходящее, правило пропустило.'), no_match: t('Ты отметил это как неподходящее, правило запустило бы.'), not_duplicate: t('Ты отметил, что это не повтор, правило отсеяло как дубль.') }[e.past!], e.reason ?? ''].filter(Boolean).join(' ')
    : (e.reason ?? '');
  return { text, run, disagrees, why };
}
