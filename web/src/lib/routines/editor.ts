// Редактор рутины по разделам «Когда · Что сделать · Как узнаю» (Editor.dc.html): смена источника, счётчики воронки у
// строк условий, статус сохранения в шапке, сводка «Дополнительно», значения условия токенами. Без React и DOM — разделы
// собираются из этого и в редакторе, и в «Новой рутине».
import type { HistoryCheck, HistoryFunnel, MatchField, SourceView } from '@server/routines/types';
import { t } from '../i18n';
import { conditionReady, incompleteConds, type Condition, type MatchOp } from './match';
import { modelName } from './graph';
import { buildSpec, draftFromSpec, type RoutineDraft } from './spec';

/**
 * Сменили источник: условия на поля старого источника не годятся — уходят. Ответ «туда, откуда пришло» возможен, только
 * если новый источник умеет отвечать; иначе — первый другой источник с ответом или «Не сообщать» (сырое «source» у
 * источника без ответа давало бы ошибку в журнале на каждом событии).
 */
export function switchSource(d: Pick<RoutineDraft, 'reply' | 'replyTo'>, slug: string, sources: ReadonlyArray<Pick<SourceView, 'slug' | 'canReply'>>): Partial<RoutineDraft> {
  // условий не осталось — и «любое» сбрасывается: у одной строки режим скрыт, а потом всплыл бы сам
  const base: Partial<RoutineDraft> = { source: slug, conds: [], condsMode: 'all' };
  if (d.reply === 'off') return base;
  if (sources.find((s) => s.slug === slug)?.canReply) return { ...base, replyTo: 'source' };
  if (d.replyTo !== 'source' && d.replyTo !== slug) return base;
  const target = sources.find((s) => s.slug !== slug && s.canReply);
  return target ? { ...base, replyTo: target.slug } : { ...base, reply: 'off' };
}

/** Убрать строку условия. Строк стало меньше двух — режим снова «все условия»: переключатель скрыт, а в правило не идёт. */
export function dropCond(d: Pick<RoutineDraft, 'conds' | 'condsMode'>, i: number): Partial<RoutineDraft> {
  const conds = d.conds.filter((_, j) => j !== i);
  return conds.length < 2 && d.condsMode !== 'all' ? { conds, condsMode: 'all' } : { conds };
}

/** Итог проверки на истории и правило (JSON spec), по которому она сделана. */
export type CheckedHistory = { res: HistoryCheck; spec: string };

/**
 * Проверка на истории по правилу как оно есть сейчас: правило в форме ушло от проверенного — null, иначе счётчики в
 * разделах показали бы чужие числа. Считается в отрисовке экрана, а не эффектом: кадра со старыми числами нет.
 */
export function freshHistory(h: CheckedHistory | null | undefined, spec: unknown): HistoryCheck | null {
  return h && h.spec === JSON.stringify(spec) ? h.res : null;
}

/** Счётчик строки условия: сколько событий дошло до неё (from) и сколько её прошло (passed). */
export type CondCount = { from: number; passed: number };

/**
 * Счётчики воронки по строкам черновика: funnel.fields[i] — i-я заполненная строка (незаполненные в правило не идут и
 * получают null). При «все условия» строка сужает поток после предыдущей, при «любое» каждая считается от всех событий.
 * Поле строки не совпало с полем воронки (правило поменяли после проверки) — null: число было бы чужим.
 */
export function condCounts(conds: readonly Condition[], funnel: HistoryFunnel | undefined): Array<CondCount | null> {
  if (!funnel) return conds.map(() => null);
  const skip = new Set(incompleteConds(conds));
  let j = 0;
  return conds.map((c, i) => {
    if (skip.has(i)) return null;
    const f = funnel.fields[j];
    const prev = j > 0 ? funnel.fields[j - 1] : undefined;
    j++;
    if (!f || f.field !== c.field.trim()) return null;
    return { from: funnel.mode === 'any' || !prev ? funnel.total : prev.passed, passed: f.passed };
  });
}

/** Что сейчас с сохранением правила — для шапки. */
export type SaveState = {
  /** Рутина — черновик: сохраняется сама. */
  draft: boolean;
  /** Правило в форме отличается от сохранённого. */
  dirty: boolean;
  /** Не хватает настроек (draftMissing не пуст): сохранить нельзя. */
  missing: boolean;
  /** Последнее автосохранение не прошло. */
  autoFailed: boolean;
  /** Есть незаполненные строки условий (draftUnsavedConds): они не сохранятся, а по сравнению правил их не видно. */
  unsavedConds: boolean;
  /** Время последнего сохранения, «21:40»; null — в этом заходе ещё не сохраняли. */
  savedAt: string | null;
};

/**
 * Статус сохранения словами. «Черновик сохранён» не врёт: при незаполненном условии он говорит, что сохранено всё,
 * кроме него. warn — подсветить. null — говорить нечего (включённая рутина без правок).
 */
export function saveStatus(s: SaveState): { text: string; warn: boolean } | null {
  if (s.draft) {
    if (s.dirty && s.autoFailed) return { text: t('черновик не сохранён: причина выше. Поправь — сохранится сам'), warn: true };
    if (s.dirty && s.missing) return { text: t('черновик не сохранён: не хватает настроек'), warn: true };
    if (s.dirty) return { text: t('сохраняю черновик…'), warn: false };
    if (s.unsavedConds) return { text: t('черновик сохранён, кроме незаполненного условия'), warn: true };
    return { text: s.savedAt ? t('черновик сохранён в {time}', { time: s.savedAt }) : t('черновик сохранён'), warn: false };
  }
  if (s.dirty) return { text: t('есть несохранённые изменения'), warn: true };
  if (s.unsavedConds) return { text: t('незаполненное условие не сохранится'), warn: true };
  return null;
}

const num = (s: string): string => s.trim().replace(',', '.').replace(/^\$/, '');

/** Свёрнутое «Дополнительно» одной строкой: «пространство: нет · рабочее дерево: нет · лимиты: нет · модель: как в flow». */
export function extrasSummary(d: Pick<RoutineDraft, 'space' | 'worktree' | 'usd' | 'perDay' | 'parallel' | 'model'>, o: { spaces: boolean }): string {
  const limits = [
    d.usd.trim() ? `$${num(d.usd)}` : '',
    d.perDay.trim() ? t('{n} в день', { n: num(d.perDay) }) : '',
    d.parallel.trim() ? t('{n} одновременно', { n: num(d.parallel) }) : '',
  ].filter(Boolean);
  return [
    ...(o.spaces ? [t('пространство: {v}', { v: d.space || t('нет') })] : []),
    t('рабочее дерево: {v}', { v: d.worktree === 'new' ? t('новое') : t('нет') }),
    t('лимиты: {v}', { v: limits.length ? limits.join(', ') : t('нет') }),
    t('модель: {v}', { v: modelName(d.model, t('как в flow')) }),
  ].join(' · ');
}

/** Значение условия «a, b» → токены поля «Значения». */
export const condTokens = (value: string): string[] => value.split(',').map((s) => s.trim()).filter(Boolean);
/** Токены → значение условия: список через запятую (buildMatch разберёт его так же). */
export const tokensValue = (list: readonly string[]): string => list.join(', ');

/** Что брать, в винительном: «Брать сообщение, если» — по виду источника. */
export function eventWord(kind: string | undefined): string {
  if (kind === 'slack' || kind === 'telegram' || kind === 'email') return t('сообщение');
  if (kind === 'gitlab' || kind === 'github' || kind === 'jira') return t('событие');
  return t('запись');
}

/** Условие словами в списке «Условие»: «не равно», «больше» — вместо значков фразы. */
export function opWord(op: MatchOp): string {
  return { eq: t('равно'), contains: t('содержит'), ne: t('не равно'), gt: t('больше'), lt: t('меньше') }[op];
}

/** Номер раздела «Новой рутины»: 1 «Когда», 2 «Что сделать», 3 «Как узнаю». */
export type SectionNo = 1 | 2 | 3;

/** Поля черновика по разделам: какой раздел правит поле. Название и включённость — ни в одном. */
const SECTION_FIELDS: Record<SectionNo, ReadonlyArray<keyof RoutineDraft>> = {
  1: ['source', 'conds', 'condsMode', 'check', 'checkModel', 'checkAsk', 'schedule', 'missed'],
  2: ['flow', 'input', 'space', 'cwd', 'worktree', 'pauseBefore', 'mode', 'usd', 'perDay', 'parallel', 'model', 'knowledge'],
  3: ['reply', 'replyTo', 'replyOn', 'taskOn', 'taskKind', 'taskColumn', 'taskFrom', 'taskSame', 'taskRepeat', 'taskClose', 'taskMerge', 'taskMergeModel', 'notifyOs'],
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const MERGED = ([1, 2, 3] as const).flatMap((n) => SECTION_FIELDS[n]);

/** Разделы, к которым относятся поля. */
export function sectionsOf(keys: ReadonlyArray<keyof RoutineDraft>): SectionNo[] {
  return ([1, 2, 3] as const).filter((n) => SECTION_FIELDS[n].some((k) => keys.includes(k)));
}

/** Результат помощника поверх формы: что получилось, в каких разделах он что-то поменял, какие поля человека оставлены. */
export type AssistantMerge = { next: RoutineDraft; changed: SectionNo[]; kept: Array<keyof RoutineDraft> };

/**
 * Черновик помощника (theirs) поверх формы человека (mine). base — форма, как она ушла помощнику с сообщением (нет —
 * mine): берутся только поля, которые помощник поменял относительно неё. Если то же поле человек тем временем поправил
 * сам и иначе — остаётся его значение, поле — в kept (экран говорит об этом). Сравнение — как правило (draftFromSpec ∘
 * buildSpec): значения по умолчанию и поля, которых в правиле нет, разницей не считаются. Недописанные строки условий
 * человека не теряются: они остаются после условий помощника. Название, включённость и признак черновика решает экран.
 */
export function mergeAssistant(base: RoutineDraft | undefined, mine: RoutineDraft, theirs: RoutineDraft, fields: MatchField[] = []): AssistantMerge {
  const norm = (x: RoutineDraft) => draftFromSpec(buildSpec(x, fields));
  const was = norm(base ?? mine);
  const now = norm(mine);
  const next: RoutineDraft = { ...mine };
  const taken: Array<keyof RoutineDraft> = [];
  const kept: Array<keyof RoutineDraft> = [];
  for (const k of MERGED) {
    if (same(theirs[k], was[k])) continue;
    if (same(now[k], was[k]) || same(now[k], theirs[k])) {
      (next as Record<string, unknown>)[k] = theirs[k];
      taken.push(k);
    } else kept.push(k);
  }
  if (taken.includes('conds')) next.conds = [...theirs.conds, ...mine.conds.filter((c) => !conditionReady(c))];
  return { next, changed: sectionsOf(taken), kept };
}
