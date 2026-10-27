// Что показывает страница запуска (порт renderRun, renderRunSummary, blockIters, renderRunRibbons, renderRunFinal,
// renderInspector, runGraphGoto из ui/app.js) — без React и DOM: компоненты только раскладывают готовые данные.
import type { BlockNext, ConditionReport, PhaseReport, QuestionRecord, RunFlowEdit, RunNote, RunReport, RunStatus, SessionTokens } from '@server/api-types';
import { dur, excerpt, usd } from '../format';
import { t } from '../i18n';
import { markdownFits } from '../md';
import { ctxLabel, ctxLevel, tokensShort } from '../graph/text';
import type { LiveState, PendingCond, PendingPhase, RunView } from './events';
import { runnerText } from './runner-text';

/** Блок для страницы запуска; у старых запусков (до блоков) — один неявный блок без имени. */
export type RunBlockView = {
  name?: string;
  title: string;
  status: string;
  iterations: number;
  maxIterations: number;
  looped: boolean;
  skipped?: boolean;
  /** Развилка next перешла через блок: он не выполнялся. */
  bypassed?: boolean;
  /** Куда развилка после блока повела запуск. */
  next?: BlockNext;
  onFail?: string;
};

export function runBlocks(r: Pick<RunReport, 'blocks' | 'status' | 'iterations' | 'maxIterations'>): RunBlockView[] {
  if (r.blocks?.length) return r.blocks;
  return [{ name: undefined, title: '', status: r.status, iterations: r.iterations, maxIterations: r.maxIterations, looped: true }];
}

/** Запуск закончен (карточка «Итог»). Запуск из CLI, открытый в UI, приходит с live: false и статусом running — итога ещё нет. */
export const runFinished = (r: { live?: boolean; status: string }): boolean => !r.live && r.status !== 'running';

/** Агент ждёт ответа на вопрос. */
export const runWaiting = (r: RunView): boolean => r.live && r.questions.some((q) => !q.answers);

/** Пауза идущего запуска (у законченного её нет). */
export const runPause = (r: RunView): 'requested' | 'paused' | undefined => (r.live ? r.pause : undefined);

/** Блок, открытый по умолчанию: идущий, иначе последний начатый (у завершённого запуска — где он остановился). */
export function currentBlockIndex(blocks: RunBlockView[]): number {
  const running = blocks.findIndex((b) => b.status === 'running');
  return running >= 0 ? running : blocks.findLastIndex((b) => b.status !== 'pending' && !b.skipped);
}

/** «Блок не выбран развилкой» или «пропущен» (продолжение) — подпись блока, который не выполнялся; иначе пусто. */
export const blockSkipNote = (b: Pick<RunBlockView, 'skipped' | 'bypassed'>): string =>
  b.bypassed ? t('не выбран развилкой') : b.skipped ? t('пропущен') : '';

/** «дальше: блок X» или «дальше: конец» после блока с развилкой next; пусто — развилки нет или она ещё не решена. */
export function blockNextNote(b: Pick<RunBlockView, 'next'>, blocks: Pick<RunBlockView, 'name' | 'title'>[]): string {
  if (!b.next) return '';
  if (b.next.to === 'end') return t('дальше: конец запуска');
  const to = blocks.find((x) => x.name === b.next!.to);
  return t('дальше: блок «{title}»', { title: to?.title || b.next.to });
}

export const COND_LABEL: Record<string, string> = { command: t('команда'), judge: t('судья'), marker: t('маркер'), none: t('без условия') };

/** Ключ карточки шага на странице запуска (data-step): по нему клик по узлу графа находит карточку. */
export const stepKey = (block: string | undefined, iteration: number, phase: string): string => `${block ?? ''}|${iteration}|${phase}`;

// ---------- шапка

/** Бейдж статуса в заголовке: ждёт ответа, на паузе, идёт или итог. */
export function headerStatus(r: RunView): string {
  const pause = runPause(r);
  return runWaiting(r) ? 'waiting' : pause === 'paused' ? 'paused' : r.live ? 'running' : r.status;
}

/** «итерация N/M» у одного блока, «блок k/n · итераций: N» у нескольких; ≈стоимость; идущее саммари тега. */
export function runMeta(r: RunView, tagPending: LiveState['tagPending']): string {
  const blocks = runBlocks(r);
  let progress = t('итерация {i}/{n}', { i: r.iterations, n: r.maxIterations ?? '?' });
  if (blocks.length > 1) {
    const cur = Math.max(0, blocks.findLastIndex((b) => b.status !== 'pending'));
    progress = t('блок {k}/{n} · итераций: {i}', { k: cur + 1, n: blocks.length, i: r.iterations });
  }
  return `${progress} · ≈${usd(r.totalCostUsd)}${tagPending ? ` · ${t('обновляю саммари тега {tag}…', { tag: tagPending.tag })}` : ''}`;
}

/** Лимит итераций можно менять у живого запуска, пока блок с циклом не завершился. */
export const limitEditable = (r: { live?: boolean }, b: RunBlockView): boolean =>
  Boolean(r.live) && b.looped && b.name !== undefined && (b.status === 'pending' || b.status === 'running');

/** Границы кнопок −/+ лимита: не меньше пройденных итераций и 1, не больше 50. */
export const limitMin = (b: RunBlockView): number => Math.max(1, b.iterations || 0);
export const LIMIT_MAX = 50;

/**
 * Видна ли «Продолжить с места остановки». Решает сервер (continuable); старый сервер поля не отдаёт — тогда прежнее правило:
 * завершённый не done запуск, у которого первый блок прошёл целиком или упёрся в лимит итераций.
 */
export function continueVisible(r: RunView): boolean {
  if ('continuable' in r) return Boolean(r.continuable);
  const first = r.blocks?.[0]?.status;
  return !(r.live || r.status === 'done' || r.status === 'running' || (first !== 'done' && first !== 'max_iterations'));
}

/** Первая строка карточки паузы. */
export const pauseText = (pause: 'requested' | 'paused' | undefined): string =>
  pause === 'paused'
    ? t('Запуск на паузе: следующий шаг не начнётся, пока не нажмёшь «Возобновить».')
    : pause === 'requested' ? t('Пауза после текущего шага: идущая сессия доработает, следующая не начнётся.') : '';

/** Артефакт решений запуска: ответ на паузу допишется в него. Есть только у flow с артефактами. */
export const decisionsArtifact = (r: Pick<RunReport, 'artifacts'>): { key: string; title: string } | undefined => {
  const a = r.artifacts?.items.find((x) => x.decisions);
  return a ? { key: a.key, title: a.title || a.key } : undefined;
};

/** Причина паузы по просьбе агента: что делать человеку. artifacts — у запуска есть панель артефактов. */
export function pauseHint(r: RunView, artifacts: boolean): { text: string; openArtifacts: boolean } | null {
  const why = r.pauseReason;
  if (!why) return null;
  const head = t('Паузу попросил этап «{phase}» (итерация {it}): дальше нужен твой ответ.', { phase: why.phase, it: why.iteration });
  if (!artifacts) return { text: `${head} ${t('Запиши решение туда, куда просит агент, и нажми «Возобновить».')}`, openArtifacts: false };
  const dec = decisionsArtifact(r);
  if (dec) {
    return {
      text: `${head} ${t('Напиши его в поле «Ответ» ниже и нажми «Возобновить с ответом»: ответ допишется в артефакт «{title}». Поправить остальные артефакты можно в панели «Артефакты».', { title: dec.title })}`,
      openArtifacts: false,
    };
  }
  return { text: `${head} ${t('Поправь артефакты и нажми «Возобновить».')}`, openArtifacts: true };
}

/** Ответ на паузу — до 64 КБ в байтах, как на сервере. */
export const PAUSE_ANSWER_MAX = 64 * 1024;

// ---------- «починить и продолжить»: указания, правка flow на паузе, повтор итерации (src/run-fix.ts)

/** Пометка проверки у итерации, оборванной повтором: как RESTART_DETAIL в src/run-fix.ts. */
export const RESTART_DETAIL = 'перезапущено пользователем';
export const isRestart = (c: Pick<ConditionReport, 'detail'>): boolean => c.detail === RESTART_DETAIL;

/** Шаг проверки условия в applied указаний (судья): как COND_STEP в src/runner.ts. */
export const COND_STEP = '#cond';

/** Указания, применённые к шагу: этапу (phase — его имя) или проверке условия (COND_STEP). */
export function stepNotes(r: Pick<RunReport, 'notes'>, block: string | undefined, iteration: number, phase: string): RunNote[] {
  return (r.notes ?? []).filter((n) => n.applied?.some((a) => a.block === block && a.iteration === iteration && a.phase === phase));
}

/** Указания, которые ещё дойдут до этапов: next, пока его не применили, и run — до конца запуска. */
export const waitingNotes = (r: Pick<RunReport, 'notes'>): RunNote[] => (r.notes ?? []).filter((n) => n.scope === 'run' || !n.applied?.length);

/**
 * Что можно сделать на паузе: править снимок flow, взять flow из flows/ (у разового его там нет), повторить итерацию
 * идущего блока (если он её начал и лимит ещё можно поднять). Не на паузе — null.
 */
export function fixActions(r: RunView): { reload: boolean; restart: { block: RunBlockView; next: number; max: number } | null } | null {
  if (runPause(r) !== 'paused') return null;
  const cur = runBlocks(r).find((b) => b.status === 'running');
  const restart = cur && cur.name !== undefined && cur.iterations > 0 && cur.maxIterations < LIMIT_MAX
    ? { block: cur, next: cur.iterations + 1, max: cur.maxIterations + 1 }
    : null;
  return { reload: !r.adhoc, restart };
}

/**
 * Подсказка «Продолжить с места остановки»: по снимку, если flow этого запуска последней правкой поменяли только в нём
 * (как snapshotOnly в src/adhoc.ts; у продолжения такой цепочки сервер решает так же, а подсказка — общая).
 */
export function continueTitle(r: Pick<RunReport, 'flowEdits' | 'adhoc'>): string {
  const last = r.flowEdits?.at(-1);
  if (!r.adhoc && last?.source === 'edit' && !last.savedToFlows) return t('Новый запуск по снимку flow этого запуска (его правили на ходу): пройденные блоки не повторяются');
  return t('Новый запуск текущей версией flow: пройденные блоки не повторяются');
}

/** Строка шапки о правках flow на ходу: сколько их; в подсказке — что поменяла каждая. */
export function flowEditsLine(r: Pick<RunReport, 'flowEdits'>): { text: string; title: string } | null {
  const edits = r.flowEdits ?? [];
  if (!edits.length) return null;
  const how = (e: RunFlowEdit) =>
    `${e.version}. ${e.source === 'reload' ? t('из flows/') : t('правка снимка')}${e.savedToFlows ? ` · ${t('и в flows/')}` : ''}: ${e.changed.join('; ')}`;
  return { text: t('flow правили на ходу: {n}', { n: edits.length }), title: edits.map(how).join('\n') };
}
export const textBytes = (s: string): number => new TextEncoder().encode(s).length;

// ---------- этапы по итерациям

export const STEP_ITERS = 5;

/** Свёртки страницы запуска: только то, что пользователь переключил сам; older — блоки с показанными ранними итерациями. */
export type RunFold = { over: Map<string, boolean>; older: Set<number> };
export const foldOpen = (fold: RunFold, key: string, byDefault: boolean): boolean => (fold.over.has(key) ? fold.over.get(key)! : byDefault);

/** Часть сводки итерации: класс — цвет. */
export type Part = { text: string; cls?: 'ok' | 'warn' | 'err' };

/** Сводка итерации в заголовке: видна и у свёрнутой. Время группы — по самому долгому участнику: они шли одновременно. */
export function iterSummary(phases: PhaseReport[], cond: ConditionReport | undefined, pending: boolean): Part[] {
  const cost = phases.reduce((n, p) => n + p.costUsd, 0) + (cond?.costUsd || 0);
  const longest = new Map<string, number>();
  for (const p of phases) {
    const key = p.group ? `g:${p.group}` : `p:${p.phase}`;
    longest.set(key, Math.max(longest.get(key) || 0, p.durationMs));
  }
  const ms = [...longest.values()].reduce((n, x) => n + x, 0);
  const failed = phases.filter((p) => !p.ok).length;
  const out: Part[] = [{ text: t('этапов {n}', { n: phases.length }) }];
  if (failed) out.push({ text: t('с ошибкой {n}', { n: failed }), cls: 'warn' });
  if (ms) out.push({ text: dur(ms) });
  if (cost) out.push({ text: usd(cost) });
  if (pending) out.push({ text: t('⏳ идёт') });
  else if (cond && isRestart(cond)) out.push({ text: t('↺ перезапущена'), cls: 'warn' });
  else if (cond && cond.type !== 'none') out.push(cond.done ? { text: t('✔ условие выполнено'), cls: 'ok' } : { text: t('↻ условие не выполнено'), cls: 'warn' });
  return out;
}

export type StepItem =
  | { kind: 'block'; bi: number; foldKey?: string; open: boolean; label: string; block: RunBlockView; cost: number }
  | { kind: 'onfail'; bi: number }
  | { kind: 'older'; bi: number; to: number }
  | { kind: 'iter'; bi: number; it: number; foldKey: string; open: boolean; sum: Part[]; block?: string }
  | { kind: 'phase'; p: PhaseReport }
  | { kind: 'running'; x: PendingPhase; doing: string }
  | { kind: 'answered'; q: QuestionRecord }
  | { kind: 'cond'; c: ConditionReport }
  | { kind: 'condPending'; c: PendingCond };

/** Список «Этапы по итерациям»: блоки, итерации, карточки шагов и свёртки (keys — все ключи, unfold — свёрнуто больше половины). */
export function runSteps(st: LiveState, fold: RunFold): { items: StepItem[]; keys: string[]; unfold: boolean } {
  const r = st.run;
  const waiting = runWaiting(r);
  const pause = runPause(r);
  const blocks = runBlocks(r);
  const multi = blocks.length > 1;
  const pend = [...st.pending.values()];
  const items: StepItem[] = [];
  const foldKeys = new Map<string, boolean>();
  const curBlock = currentBlockIndex(blocks);
  blocks.forEach((b, bi) => {
    const inBlock = (x: { block?: string }) => x.block === b.name;
    const phases = r.phases.filter(inBlock);
    const iters = Math.max(b.iterations || 0, ...phases.map((p) => p.iteration), 0);
    // у блока без цикла заголовки итераций — только когда итерацию повторили (fix.restart)
    const heads = b.looped || iters > 1;
    if (heads) for (let it = 1; it <= iters; it++) foldKeys.set(`i:${bi}:${it}`, foldOpen(fold, `i:${bi}:${it}`, it === iters));
    let blockOpen = true;
    if (multi) {
      if (iters > 0) {
        blockOpen = foldOpen(fold, `b:${bi}`, bi === curBlock);
        foldKeys.set(`b:${bi}`, blockOpen);
      }
      const cost = blockOpen ? 0 : phases.reduce((n, p) => n + p.costUsd, 0) + r.conditions.filter(inBlock).reduce((n, c) => n + c.costUsd, 0);
      items.push({ kind: 'block', bi, foldKey: iters > 0 ? `b:${bi}` : undefined, open: blockOpen, label: t('Блок {n} · {title}', { n: bi + 1, title: String(b.title || b.name) }), block: b, cost });
      if (b.status === 'max_iterations' && b.onFail === 'continue') items.push({ kind: 'onfail', bi });
    }
    if (!blockOpen) return;
    // длинный цикл: в списке последние STEP_ITERS итераций; ранние — по кнопке или если их раскрыли (лента, граф)
    const olderTo = b.looped && !fold.older.has(bi) ? iters - STEP_ITERS : 0;
    if (olderTo > 0) items.push({ kind: 'older', bi, to: olderTo });
    for (let it = 1; it <= iters; it++) {
      if (it <= olderTo && fold.over.get(`i:${bi}:${it}`) !== true) continue;
      if (heads) {
        const key = `i:${bi}:${it}`;
        const open = foldOpen(fold, key, it === iters);
        const pendingHere = pend.some((x) => x.block === b.name && x.iteration === it) || (st.condPending !== null && st.condPending.block === b.name && st.condPending.iteration === it);
        const sum = iterSummary(phases.filter((p) => p.iteration === it), r.conditions.find((c) => inBlock(c) && c.iteration === it), pendingHere);
        items.push({ kind: 'iter', bi, it, foldKey: key, open, sum, block: b.name });
        if (!open) continue;
      }
      // готовые и идущие этапы — в порядке объявления: участники группы заканчивают в любом порядке
      const done = phases.filter((p) => p.iteration === it).map((p) => ({ index: p.index ?? 0, p, x: undefined }));
      const running = pend.filter((x) => x.block === b.name && x.iteration === it).map((x) => ({ index: x.index ?? 0, p: undefined, x }));
      for (const c of [...done, ...running].sort((a, z) => a.index - z.index)) {
        if (c.p) items.push({ kind: 'phase', p: c.p });
        else {
          const doing = waiting ? t('ждёт твоего ответа') : pause ? (running.length > 1 ? t('выполняется… пауза после группы') : t('выполняется… пауза после этапа')) : t('выполняется…');
          items.push({ kind: 'running', x: c.x!, doing });
        }
        const name = c.p?.phase ?? c.x!.phase;
        for (const q of r.questions.filter((q) => q.iteration === it && q.phase === name && q.answers)) items.push({ kind: 'answered', q });
      }
      const cond = r.conditions.find((c) => inBlock(c) && c.iteration === it);
      const cp = st.condPending;
      if (cond) items.push({ kind: 'cond', c: cond });
      else if (cp && cp.block === b.name && cp.iteration === it) items.push({ kind: 'condPending', c: cp });
    }
  });
  const keys = [...foldKeys.keys()];
  const unfold = [...foldKeys.values()].filter((o) => !o).length * 2 > foldKeys.size;
  return { items, keys, unfold };
}

// ---------- карточки шагов

/** Чип «модель · effort» карточки этапа; ничего не известно — null, без висящих «·». */
export function phaseModelChip(x: { model?: string; effort?: string }): { label: string; title: string } | null {
  if (!x.model && !x.effort) return null;
  return {
    label: [x.model, x.effort].filter(Boolean).join(' · '),
    title: t('Модель: {model} · effort: {effort}', { model: x.model || t('не задана (по умолчанию)'), effort: x.effort || t('не задан (по умолчанию модели)') }),
  };
}

/**
 * Чип занятости контекстного окна этапа: «ctx 172k / 1M · 17%», пороги цвета 70% и 90%. Готовый этап — по tokens отчёта,
 * идущий — по снимку ctx из потока. Нет окна — только пик без процента; нет данных — null.
 */
export function ctxChipInfo(
  x: { tokens?: SessionTokens; ctx?: { peak: number; requests: number; window?: number } },
  live: boolean,
): { text: string; level: '' | 'warn' | 'crit'; title: string } | null {
  const peak = live ? x.ctx?.peak : x.tokens?.contextPeak;
  const window = live ? x.ctx?.window : x.tokens?.contextWindow;
  if (!(peak! > 0)) return null;
  const n = tokensShort;
  const parts = [`${t('Контекст этапа: пик {peak}', { peak: ctxLabel(peak!, window) })}${window ? '' : ` ${t('(окно модели неизвестно)')}`}`];
  if (!live) {
    const tk = x.tokens!;
    if (tk.contextStart > 0) parts.push(t('старт {n}', { n: n(tk.contextStart) }));
    if (tk.requests > 0) parts.push(t('запросов к модели: {n}', { n: tk.requests }));
    if (tk.input !== undefined) {
      parts.push(t('input {i} · output {o} · кэш: чтение {r}, запись {w} (по всем моделям сессии, включая сабагентов)', {
        i: n(tk.input) || 0, o: n(tk.output) || 0, r: n(tk.cacheRead) || 0, w: n(tk.cacheCreation) || 0,
      }));
    }
  } else if (x.ctx!.requests > 0) parts.push(t('запросов к модели: {n}', { n: x.ctx!.requests }));
  return { text: `ctx ${ctxLabel(peak!, window)}`, level: ctxLevel(peak!, window), title: parts.join('\n') };
}

/** Замечания судьи — markdown; у команды это хвост её вывода — моноширинно, как condition.command.log. */
export const feedbackIsMarkdown = (c: Pick<ConditionReport, 'type' | 'feedback'>): boolean => c.type !== 'command' && markdownFits(c.feedback);

/** Окно файла: промпт и вывод этапа, промпт судьи — markdown; транскрипт, лог команды, JSON-вывод и огромный файл — моноширинно. */
export function fileIsMarkdown(file: string, text: string): boolean {
  if (/\.transcript\.md$|\.log$/.test(file)) return false;
  if (!markdownFits(text)) return false;
  if (file.endsWith('.output.md')) {
    try {
      JSON.parse(text);
      return false;
    } catch {
      /* не JSON — обычный markdown */
    }
  }
  return true;
}

// ---------- «Обзор»: сводка и лента итераций

/**
 * Ключ замечания для сравнения итераций: цифры (строки, время, счётчики) не делают ошибку другой. Сравниваем сырые
 * замечания, а не итог модели: пересказ одного и того же каждый раз звучит по-разному.
 */
export const verdictKey = (c: Pick<ConditionReport, 'feedback' | 'detail'>): string => excerpt(c.feedback || c.detail || '', 200).replace(/\d+/g, '#').toLowerCase();

export const RIBBON_CELLS = 4;
export const STUCK_MIN = 5;

export type ChainStep = { mark: string; cls: 'ok' | 'err' | 'live' | 'off'; title: string };
export type IterState = 'future' | 'wait' | 'live' | 'ok' | 'fail' | 'stop';
export type IterItem = { it: number; st: IterState; mark: string; text: string; key: string; chain?: ChainStep[] };
export type IterGroup = IterItem & { from: number; to: number };
export type BlockIters = {
  iters: number;
  total: number;
  ongoing: boolean;
  items: IterItem[];
  groups: IterGroup[];
  stuck: IterGroup | null;
  chain: (it: number) => ChainStep[];
};

/** Этапы блока по снимку flow: порядок цепочки итерации. Без снимка — по факту. */
export type SpecBlocks = { phases?: { name: string; title?: string }[] }[] | null | undefined;

/** Итерации блока для ленты и сводки: состояние каждой, группы повторов и признак «буксует». */
export function blockIters(st: LiveState, bi: number, spec: SpecBlocks): BlockIters {
  const r = st.run;
  const blocks = runBlocks(r);
  const waiting = runWaiting(r);
  const b = blocks[bi]!;
  const sole = blocks.length === 1;
  const inBlock = (x: { block?: string }) => sole || x.block === b.name;
  const phases = r.phases.filter(inBlock);
  const pend = [...st.pending.values()].filter(inBlock);
  const condRun = st.condPending && inBlock(st.condPending) ? st.condPending : null;
  const iters = Math.max(b.iterations || 0, ...phases.map((p) => p.iteration), ...pend.map((x) => x.iteration), condRun?.iteration || 0, 0);
  const ongoing = b.status === 'running' || b.status === 'pending';
  // у закончившегося блока пустые «впереди» врут: лимит не понадобился — показываем только пройденные
  const total = ongoing ? Math.max(b.maxIterations || 0, iters, 1) : Math.max(iters, 1);
  // цепочка этапов итерации: ✓ готов, ! с ошибкой, ● идёт, ○ впереди
  const chain = (it: number): ChainStep[] => {
    const names = spec?.[bi]?.phases?.map((p) => ({ name: p.name, title: p.title || p.name }))
      ?? [...phases.filter((p) => p.iteration === it), ...pend.filter((x) => x.iteration === it)].map((x) => ({ name: x.phase, title: x.title || x.phase }));
    return names.map(({ name, title }) => {
      const done = phases.find((p) => p.iteration === it && p.phase === name);
      const run = pend.some((x) => x.iteration === it && x.phase === name);
      const [mark, cls]: [string, ChainStep['cls']] = run ? ['●', 'live'] : done ? (done.ok ? ['✓', 'ok'] : ['!', 'err']) : ['○', 'off'];
      return { mark, cls, title };
    });
  };
  const items: IterItem[] = [];
  for (let it = 1; it <= total; it++) {
    const c = r.conditions.find((x) => inBlock(x) && x.iteration === it);
    const running = pend.some((x) => x.iteration === it) || condRun?.iteration === it;
    const asking = waiting && r.questions.some((q) => !q.answers && q.iteration === it && (sole || q.block === b.name));
    const item: IterItem = { it, st: 'future', mark: '', text: '', key: '' };
    if (asking) Object.assign(item, { st: 'wait', mark: t('ждёт ответа'), chain: chain(it) });
    else if (running) Object.assign(item, { st: 'live', mark: condRun?.iteration === it ? t('проверка') : t('идёт'), chain: chain(it) });
    else if (c && isRestart(c)) Object.assign(item, { st: 'stop', mark: t('↺ перезапущена'), text: excerpt(c.feedback, 120) });
    else if (c) {
      const ok = c.done || c.type === 'none';
      item.st = ok ? 'ok' : 'fail';
      item.mark = `${ok ? '✓' : '✕'} ${COND_LABEL[c.type] || c.type}`;
      // итог модели, пока его нет — начало замечаний
      item.text = c.summary || excerpt(ok ? runnerText(c.detail, c.type) || t('условие выполнено') : runnerText(c.feedback || c.detail, c.type) || t('условие не выполнено'), 120);
      if (!ok) item.key = verdictKey(c);
    } else if (it <= iters) Object.assign(item, { st: 'stop', mark: t('прервана'), chain: chain(it) });
    items.push(item);
  }
  const groups: IterGroup[] = [];
  for (const x of items.slice(0, iters)) {
    const g = groups.at(-1);
    if (g && x.st === 'fail' && g.st === 'fail' && g.key === x.key) g.to = x.it;
    else groups.push({ ...x, from: x.it, to: x.it });
  }
  // буксует: последняя законченная группа — длинная серия одинаковых провалов, а блок ещё крутится
  const lastDone = groups.filter((g) => g.st !== 'live' && g.st !== 'wait').at(-1);
  const stuck = ongoing && lastDone?.st === 'fail' && lastDone.to - lastDone.from + 1 >= STUCK_MIN ? lastDone : null;
  return { iters, total, ongoing, items, groups, stuck, chain };
}

export type RibbonCell = IterGroup & { n: number; stuck: boolean; open: boolean; title: string; label: string };
export type RibbonRow = {
  bi: number;
  /** Шапка строки у нескольких блоков; у одного — нет. */
  head?: { title: string; status: string; note: string };
  /** Блок без цикла: цепочка этапов. */
  chain?: ChainStep[];
  strip?: { total: number; ticks: (IterItem & { open: boolean; stuck: boolean; title: string })[] };
  cells?: RibbonCell[];
  more?: number;
};

/** Строки ленты: полоска-история (если итераций больше ячеек) и подробные ячейки последних групп. */
export function ribbonRows(st: LiveState, fold: RunFold, spec: SpecBlocks): RibbonRow[] {
  const blocks = runBlocks(st.run);
  const sole = blocks.length === 1;
  const rows: RibbonRow[] = [];
  blocks.forEach((b, bi) => {
    const head = sole ? undefined : { title: b.title || b.name || '', status: b.status, note: blockSkipNote(b) || (b.looped ? t('↺ до {n}', { n: b.maxIterations ?? '?' }) : t('один проход')) };
    const bs = blockIters(st, bi, spec);
    if (!b.looped || b.skipped) {
      if (!sole) rows.push({ bi, head, chain: bs.iters > 0 && !b.skipped ? bs.chain(1) : undefined });
      return;
    }
    const isOpen = (it: number) => it <= bs.iters && foldOpen(fold, `i:${bi}:${it}`, it === bs.iters);
    const inStuck = (it: number) => Boolean(bs.stuck && it >= bs.stuck.from && it <= bs.stuck.to);
    const strip = bs.total > RIBBON_CELLS
      ? {
        total: bs.total,
        ticks: bs.items.map((x) => ({ ...x, open: isOpen(x.it), stuck: inStuck(x.it), title: `${x.it} · ${x.st === 'future' ? t('впереди') : x.mark}${x.text ? ` — ${x.text}` : ''}` })),
      }
      : undefined;
    // подробные ячейки: последние группы, у идущего блока — добиваем ближайшими «впереди»
    const groups: IterGroup[] = bs.groups.slice(-RIBBON_CELLS);
    for (const x of bs.items.slice(bs.iters)) {
      if (groups.length >= RIBBON_CELLS) break;
      groups.push({ ...x, from: x.it, to: x.it });
    }
    const cells = groups.map((g): RibbonCell => {
      const n = g.to - g.from + 1;
      return {
        ...g,
        n,
        stuck: Boolean(bs.stuck && g.from === bs.stuck.from),
        open: g.st !== 'future' && isOpen(g.to),
        title: g.st === 'future' ? t('Впереди') : n > 1 ? t('Итерации {from}–{to}: одно и то же замечание. Показать последнюю', { from: g.from, to: g.to }) : t('Показать этапы итерации'),
        label: n > 1 ? `${g.mark} ×${n}` : g.mark,
      };
    });
    const more = !bs.ongoing && b.maxIterations > bs.iters ? b.maxIterations : undefined;
    rows.push({ bi, head, strip, cells, more });
  });
  return rows;
}

export type SummaryView = {
  now: string;
  digest?: string;
  last?: { ok: boolean; text: string };
  stuck?: { from: number; to: number };
  waiting: boolean;
  paused: boolean;
  facts: string;
};

/** Сводка «где мы сейчас» у живого запуска. graphNow — строка «Сейчас» из графа без «Сейчас: »; пусто — собираем свою. */
export function summaryView(st: LiveState, graphNow: string, spec: SpecBlocks, now: number = Date.now()): SummaryView {
  const r = st.run;
  const blocks = runBlocks(r);
  const sole = blocks.length === 1;
  const ci = currentBlockIndex(blocks);
  const cur = blocks[Math.max(0, ci)];
  let text = graphNow;
  if (!text) {
    const names = [...st.pending.values()].map((x) => t('«{name}»', { name: x.title || x.phase }));
    text = [
      cur?.looped ? t('итерация {i}/{n}', { i: cur.iterations || 1, n: cur.maxIterations ?? '?' }) : '',
      names.length ? t(names.length > 1 ? 'этапы {names}' : 'этап {names}', { names: names.join(', ') }) : st.condPending ? t('проверка условия') : t('между шагами'),
    ].filter(Boolean).join(' · ');
  }
  const out: SummaryView = { now: text.charAt(0).toUpperCase() + text.slice(1), waiting: runWaiting(r), paused: runPause(r) === 'paused', facts: '' };
  if (r.digest?.text) out.digest = r.digest.text;
  // почему блок крутится ещё раз: последнее условие идущего блока
  const last = cur ? r.conditions.filter((c) => sole || c.block === cur.name).at(-1) : undefined;
  if (last && last.type !== 'none') {
    out.last = last.done
      ? { ok: true, text: t('Итерация {it}: {text}', { it: last.iteration, text: last.summary || `${t('условие выполнено')}${last.detail ? ` — ${excerpt(runnerText(last.detail, last.type))}` : ''}` }) }
      : { ok: false, text: t('Итерация {it} не прошла: {text}', { it: last.iteration, text: last.summary || excerpt(runnerText(last.feedback || last.detail, last.type)) || t('условие не выполнено') }) };
  }
  const stuck = ci >= 0 && blocks[ci]!.looped ? blockIters(st, ci, spec).stuck : null;
  if (stuck) out.stuck = { from: stuck.from, to: stuck.to };
  const took = r.startedAt ? now - new Date(r.startedAt).getTime() : 0;
  out.facts = [t('итераций {n}', { n: r.iterations }), `≈${usd(r.totalCostUsd)}`, took > 0 ? dur(took) : ''].filter(Boolean).join(' · ');
  return out;
}

// ---------- «Итог»

/** Цифры карточки «Итог»: итераций, стоимость, длительность. */
export function finalFacts(r: RunReport): string[] {
  const took = r.finishedAt && r.startedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : 0;
  return [t('итераций: {n}', { n: r.iterations }), `≈${usd(r.totalCostUsd)}`, took > 0 ? dur(took) : ''].filter(Boolean);
}

/** При неуспехе — чего не хватило по мнению последнего условия (принятое замечаний не показывает). */
export function finalFeedback(r: RunReport): ConditionReport | undefined {
  const last = r.status !== 'done' ? (r.conditions ?? []).at(-1) : undefined;
  return last && !last.done && last.feedback ? last : undefined;
}

export type TagLine = { tag: string; state: 'ok' | 'error' | 'skip'; text: string; costUsd?: number; auto: boolean };

/** Строки о тегах в «Итоге»: обновилось ли саммари каждого тега; autoTagError — тег не заведён. */
export function tagFinalLines(r: Pick<RunReport, 'tags' | 'tagSummaries' | 'autoTag'>): { autoTagError?: string; lines: TagLine[] } {
  const byTag = new Map((r.tagSummaries || []).map((s) => [s.tag, s]));
  const lines = (r.tags || []).map((tag): TagLine => {
    const s = byTag.get(tag);
    const auto = r.autoTag?.slug === tag;
    if (s?.ok) return { tag, state: 'ok', text: t('Саммари тега обновлено'), costUsd: s.costUsd, auto };
    if (s?.error) return { tag, state: 'error', text: t('Саммари тега не обновлено: {why}', { why: s.error }), auto };
    return { tag, state: 'skip', text: s?.skipped ? t('Саммари тега не обновлено: {why}', { why: s.skipped }) : t('Саммари тега не обновлено'), auto };
  });
  return { ...(r.autoTag?.error ? { autoTagError: r.autoTag.error } : {}), lines };
}

// ---------- граф: инспектор и переход в «Обзор»

/** Выбранный узел графа; auto — выбран режимом «следовать за текущим». */
export type InspectSel = { kind: string; key: string; name?: string; block?: string; auto?: boolean };

/** Узел по ключу графа (p:<блок>:<этап>, c:<блок>) — для режима «следовать». */
export function nodeFromKey(key: string): InspectSel | null {
  const p = /^p:(.*):([^:]+)$/.exec(key);
  if (p) return { kind: 'phase', block: p[1], name: p[2], key };
  const c = /^c:(.*)$/.exec(key);
  if (c) return { kind: 'cond', block: c[1], key };
  return null;
}

type SpecPhase = { name: string; title?: string; tools?: string[]; model?: string; handoff?: string };
type SpecBlock = { phases: SpecPhase[]; flow?: string; loop?: { until?: { type?: string; run?: string } } };

export type InspectPhase = {
  kind: 'phase';
  title: string;
  status: { cls: 'wait' | 'live' | 'ok' | 'err' | 'off'; text: string };
  meta: string[];
  tools?: string[];
  /** Вход итерации: замечания прошлой проверки (их агент получил в {{feedback}}); или что этап передаёт дальше. */
  input?: { label: string; text: string; title?: string };
  /** Идёт: хвост лога этапа. */
  running: boolean;
  last?: { iteration: number; text: string; errors?: string };
  hist: PhaseReport[];
  files: { file: string; title: string; session?: string }[];
  /** Блок-вызов: вызываемый flow и его дочерние запуски по итерациям, последний — внизу; у идущего статуса ещё нет. */
  call?: { flow: string; runs: { iteration: number; runId: string; status?: RunStatus }[] };
};
export type InspectCond = {
  kind: 'cond';
  status: { cls: 'live' | 'ok' | 'err' | 'off'; text: string };
  meta: string;
  c?: ConditionReport;
};
export type InspectView =
  | { where: string } & (InspectPhase | InspectCond | { kind: 'start'; input: string } | { kind: 'block'; title: string; status?: string; meta: string });

/** Инспектор узла на вкладке «Граф»: что этап получил на вход, что делает сейчас, его итерации и файлы. */
export function inspectView(st: LiveState, sel: InspectSel, specBlocks: SpecBlock[] | undefined, now: number = Date.now()): InspectView {
  const r = st.run;
  const blocks = runBlocks(r);
  const sole = blocks.length === 1;
  const inBlock = (x: { block?: string }) => sole || x.block === sel.block;
  const bi = sole ? 0 : blocks.findIndex((b) => b.name === sel.block);
  const b = blocks[bi];
  const specBlock = specBlocks?.[bi];
  const where = !sole && b ? t('Блок {n} · {title}', { n: bi + 1, title: String(b.title || b.name) }) : '';
  if (sel.kind === 'phase') {
    const spec = specBlock?.phases.find((p) => p.name === sel.name);
    const done = r.phases.filter((p) => inBlock(p) && p.phase === sel.name).sort((a, z) => a.iteration - z.iteration);
    const run = [...st.pending.values()].find((x) => inBlock(x) && x.phase === sel.name);
    const rep = done.at(-1);
    const it = run ? run.iteration : rep?.iteration;
    const asking = Boolean(run && r.live && r.questions.some((q) => !q.answers && q.phase === sel.name));
    const status: InspectPhase['status'] = asking ? { cls: 'wait', text: t('● ждёт ответа') }
      : run ? { cls: 'live', text: `${t('● идёт')}${run.at ? ` · ${dur(now - run.at)}` : ''}` }
      : rep ? (rep.ok ? { cls: 'ok', text: t('✓ готово') } : { cls: 'err', text: t('! ошибка') })
      : { cls: 'off', text: t('○ ещё не выполнялся') };
    const tools = spec?.tools ?? run?.tools ?? rep?.tools;
    const prev = it && it > 1 ? r.conditions.find((c) => inBlock(c) && c.iteration === it - 1 && !c.done && c.type !== 'none') : undefined;
    const input = prev
      ? {
        label: t('Получил на вход'),
        title: excerpt(runnerText(prev.feedback || prev.detail, prev.type), 400),
        text: prev.summary
          ? t('Итог итерации {it}: {text}', { it: prev.iteration, text: prev.summary })
          : t('Замечания итерации {it}: {text}', { it: prev.iteration, text: excerpt(runnerText(prev.feedback || prev.detail, prev.type), 260) }),
      }
      : spec?.handoff ? { label: t('Передаёт дальше'), text: spec.handoff } : undefined;
    const f = (run || rep)?.files;
    const files = [
      f?.prompt ? { file: f.prompt, title: t('Промпт · {name}', { name: String(sel.name) }) } : null,
      f?.transcript ? { file: f.transcript, title: t('Транскрипт · {name}', { name: String(sel.name) }), session: rep && !run ? rep.sessionId || '' : '' } : null,
      !run && f?.output ? { file: f.output, title: t('Вывод · {name}', { name: String(sel.name) }) } : null,
    ].filter((x): x is NonNullable<typeof x> => Boolean(x));
    const flow = specBlock?.flow ?? rep?.call?.flow ?? run?.call?.flow;
    const calls: NonNullable<InspectPhase['call']>['runs'] = done.flatMap((p) => (p.call ? [{ iteration: p.iteration, runId: p.call.runId, status: p.call.status }] : []));
    if (run?.call) calls.push({ iteration: run.iteration, runId: run.call.runId });
    return {
      where,
      kind: 'phase',
      title: spec?.title || run?.title || rep?.title || sel.name || '',
      status,
      meta: [it ? t('итер. {it}', { it }) : '', (run || rep)?.model || spec?.model || ''].filter(Boolean),
      tools,
      input,
      running: Boolean(run),
      last: rep && !run
        ? { iteration: rep.iteration, text: `${t('{n} ходов', { n: rep.turns })} · ${dur(rep.durationMs)} · ${usd(rep.costUsd)}${rep.ok ? '' : ` · ${rep.subtype}`}`, errors: rep.errors?.length ? rep.errors.join('\n') : undefined }
        : undefined,
      hist: done.length > 1 ? done.slice(-6) : [],
      files,
      ...(flow ? { call: { flow, runs: calls.slice(-6) } } : {}),
    };
  }
  if (sel.kind === 'cond') {
    const conds = r.conditions.filter(inBlock);
    const cp = st.condPending && inBlock(st.condPending) ? st.condPending : null;
    const c = conds.at(-1);
    const until = specBlock?.loop?.until;
    const status: InspectCond['status'] = cp ? { cls: 'live', text: t('● проверка') }
      : c ? (c.done || c.type === 'none' ? { cls: 'ok', text: t('✓ выполнено') } : { cls: 'err', text: t('✕ не выполнено') })
      : { cls: 'off', text: t('○ ещё не проверялось') };
    const meta = [until?.type ? COND_LABEL[until.type] || until.type : '', until?.run ? `$ ${until.run}` : '', c ? t('итер. {it}', { it: c.iteration }) : ''].filter(Boolean).join(' · ');
    return { where, kind: 'cond', status, meta, c };
  }
  if (sel.kind === 'start') return { where, kind: 'start', input: r.input || '' };
  return { where, kind: 'block', title: b ? b.title || b.name || t('Блок') : t('Блок'), status: b?.status, meta: b?.looped ? t('итераций {i} / {n}', { i: b.iterations || 0, n: b.maxIterations }) : t('один проход') };
}

/**
 * «Показать в «Обзоре»»: этап — карточка его последней итерации, условие — карточка условия, блок — его заголовок.
 * open — свёртки, которые надо раскрыть; target — data-step карточки (или null — заголовок блока); msg — ещё не выполнялся.
 */
export function gotoTarget(
  st: LiveState,
  sel: InspectSel,
  soleSpec: boolean,
): { start: true } | { msg: string } | { open: string[]; target: string | null; bi: number } | null {
  const r = st.run;
  if (sel.kind === 'start') return { start: true };
  const blocks = runBlocks(r);
  const bi = soleSpec ? 0 : blocks.findIndex((b) => b.name === sel.block);
  const b = blocks[bi];
  if (!b) return null;
  const inBlock = (x: { block?: string }) => soleSpec || x.block === sel.block;
  let target: { it: number; key: string } | null = null;
  if (sel.kind === 'phase') {
    const done = r.phases.filter((p) => inBlock(p) && p.phase === sel.name);
    const run = [...st.pending.values()].find((x) => inBlock(x) && x.phase === sel.name);
    const it = run ? run.iteration : Math.max(0, ...done.map((p) => p.iteration));
    if (!it) return { msg: t('Этап «{name}» ещё не выполнялся', { name: String(sel.name) }) };
    const rep = run || done.find((p) => p.iteration === it)!;
    target = { it, key: stepKey(rep.block, it, sel.name!) };
  } else if (sel.kind === 'cond') {
    const conds = r.conditions.filter(inBlock);
    const cp = st.condPending && inBlock(st.condPending) ? st.condPending : null;
    const it = cp ? cp.iteration : Math.max(0, ...conds.map((c) => c.iteration));
    if (!it) return { msg: t('Условие ещё не проверялось') };
    target = { it, key: stepKey(cp ? cp.block : conds.find((c) => c.iteration === it)!.block, it, '#cond') };
  }
  const open: string[] = [];
  if (blocks.length > 1) open.push(`b:${bi}`);
  if (target && b.looped) open.push(`i:${bi}:${target.it}`);
  return { open, target: target?.key ?? null, bi };
}
