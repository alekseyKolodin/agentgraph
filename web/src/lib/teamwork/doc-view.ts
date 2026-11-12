// Экраны документов проекта (волна 3, ui-docs; spec §8.4, §9.2–9.3; макеты PrdRead, PrdEdit, Prd): куски раздела для
// чтения (markdown и строки требований), где задача на полях, куда ведёт ссылка из текста, пустой документ, вид новых
// требований раздела, черновики документа, слияние принятых правок агента с текущей версией документа (три стороны по
// блокам), обёртка выделения разметкой. Чистые функции без React и DOM.
import type { TeamColumns, TeamDocName, TeamDraft, TeamSprint, TeamTask } from '@server/api-types';
import { t } from '../i18n';
import { statusText } from './board';
import { fencedLines, REQ_RE, requirementId, splitLines, splitSections, type ReqKind, type ReqRow, type TextRef } from './docs';
import { applyDecisions, lcsOps, parseBlocks, type Block, type BlockKind, type Decisions } from './track';

// ---------- чтение

export type ReadChunk = { kind: 'md'; text: string } | { kind: 'reqs'; rows: ReqRow[] };

/**
 * Тело раздела кусками: markdown как есть и строки требований подряд (пустые строки между ними не рвут группу; строка с
 * отступом под требованием — его продолжение). withReqs = false — всё markdown: у архитектуры и дизайна блоков требований нет.
 */
export function readChunks(body: string, withReqs = true): ReadChunk[] {
  if (!withReqs) return body.trim() ? [{ kind: 'md', text: body }] : [];
  const lines = splitLines(body);
  const fenced = fencedLines(lines);
  const out: ReadChunk[] = [];
  let md: string[] = [];
  let rows: ReqRow[] | null = null;
  const flushMd = () => {
    if (md.some((l) => l.trim())) out.push({ kind: 'md', text: md.join('\n') });
    md = [];
  };
  const flushRows = () => {
    if (rows?.length) out.push({ kind: 'reqs', rows });
    rows = null;
  };
  let pendingBlank: string[] = [];
  lines.forEach((l, i) => {
    const m = fenced[i] ? null : l.match(REQ_RE);
    if (m) {
      flushMd();
      rows ??= [];
      rows.push({ id: requirementId(m[1] as ReqKind, Number(m[2])), text: m[3]!.trim() });
      pendingBlank = [];
      return;
    }
    if (rows) {
      if (!l.trim()) {
        pendingBlank.push(l);
        return;
      }
      if (/^\s/.test(l) && !pendingBlank.length) {
        const last = rows[rows.length - 1]!;
        last.text += ` ${l.trim()}`;
        return;
      }
      flushRows();
      md.push(...pendingBlank);
      pendingBlank = [];
    }
    md.push(l);
  });
  flushRows();
  flushMd();
  return out;
}

/** Есть ли в документе хоть что-то, кроме заголовков разделов заготовки: пустой ТЗ показывает призыв «Черновик с моделью». */
export function isDocEmpty(md: string): boolean {
  const sections = splitSections(md);
  const withHeading = sections.filter((s) => s.heading);
  if (!withHeading.length) return !md.replace(/^#\s.*$/m, '').trim();
  return withHeading.every((s) => !s.body.trim());
}

/** Раздел требований ТЗ: в нём уже есть строки FR/NFR или он так называется («Требования», «Нефункциональные требования»). */
export const isReqSection = (heading: string, body: string): boolean =>
  /требован|requirement/i.test(heading) || splitLines(body).some((l) => REQ_RE.test(l));

/** Какой номер получит «+ Требование» в разделе: как у последней строки; без строк — NFR для нефункциональных, иначе FR. */
export function reqKindFor(heading: string, rows: readonly Pick<ReqRow, 'id'>[]): ReqKind {
  const last = rows[rows.length - 1];
  if (last) return last.id.startsWith('NFR-') ? 'NFR' : 'FR';
  return /нефункц|non-?functional|nfr/i.test(heading) ? 'NFR' : 'FR';
}

/** Последний выданный номер вида из TeamDoc.nextRequirement («FR-9» → 8): удалённые номера не возвращаются. */
export function lastIssued(next: { FR: string; NFR: string } | undefined, kind: ReqKind): number | undefined {
  const m = next?.[kind]?.match(/-(\d+)$/);
  return m ? Number(m[1]) - 1 : undefined;
}

/** Якорь раздела в документе: по порядку, заголовки могут повторяться. */
export const sectionAnchor = (i: number): string => `s-${i}`;
/** Якорь требования: «FR-3» — тот же текст, что и в адресе ссылки. */
export const reqAnchor = (id: string): string => id.toUpperCase();

/** Где задача на полях требования: «бэклог», «спринт 3» (не активный), иначе статус по колонке; tone ok — готово. */
export function taskWhere(task: Pick<TeamTask, 'status' | 'sprint'>, sprints: readonly Pick<TeamSprint, 'number' | 'status'>[], columns?: TeamColumns): { text: string; tone: '' | 'ok' } {
  if (task.status === 'done') return { text: columns ? columns.done.toLowerCase() : statusText('done'), tone: 'ok' };
  if (task.sprint == null) return { text: t('бэклог'), tone: '' };
  const sprint = sprints.find((s) => s.number === task.sprint);
  if (!sprint || sprint.status !== 'active') return { text: t('спринт {n}', { n: task.sprint }), tone: '' };
  return { text: columns ? columns[task.status].toLowerCase() : statusText(task.status), tone: '' };
}

// ---------- ссылки из текста

/** Куда ведёт ссылка: задача — панель ?task=; требование — якорь в ТЗ (из другого документа — вкладка ТЗ); документ — его вкладка. */
export type RefTarget =
  | { kind: 'task'; id: string }
  | { kind: 'req'; id: string; tab?: 'prd' }
  | { kind: 'doc'; tab: 'prd' | 'architecture' | 'design' | 'docs'; name?: TeamDocName };

export function refTarget(ref: Pick<TextRef, 'kind' | 'text'>, current: TeamDocName): RefTarget {
  if (ref.kind === 'task') return { kind: 'task', id: ref.text };
  if (ref.kind === 'requirement') return current === 'prd' ? { kind: 'req', id: ref.text.toUpperCase() } : { kind: 'req', id: ref.text.toUpperCase(), tab: 'prd' };
  const m = ref.text.match(/^(prd|architecture|design)\.md$/);
  if (m) return { kind: 'doc', tab: m[1] as 'prd' | 'architecture' | 'design' };
  return { kind: 'doc', tab: 'docs', name: ref.text as TeamDocName };
}

// ---------- черновики документа

/** Черновик ещё идёт глазами сервера: агент пишет артефакты или ждёт ответа. */
export const draftRunning = (status: string): boolean => status === 'running' || status === 'waiting' || status === 'paused';
/** Черновик кончился без результата: ошибка, остановка, прерывание, бюджет. */
export const draftFailed = (status: string): boolean => !draftRunning(status) && status !== 'done' && status !== 'max_iterations';

/** Последний черновик документа (список сервера — от новых к старым). */
export const latestDraftFor = (drafts: readonly TeamDraft[], doc: TeamDocName): TeamDraft | undefined =>
  drafts.find((d) => d.kind !== 'split' && (d.docs ?? []).includes(doc as never));

/** Строка черновика на вкладке документа: «Черновик идёт», «ждёт вашего ответа», «готов», «не получился». */
export function draftLine(d: Pick<TeamDraft, 'status' | 'section'>): { text: string; tone: 'live' | 'wait' | 'ok' | 'fail' } {
  const where = d.section !== undefined ? t(' · раздел «{section}»', { section: d.section || t('начало') }) : '';
  if (d.status === 'waiting' || d.status === 'paused') return { text: t('Черновик ждёт вашего ответа') + where, tone: 'wait' };
  if (draftRunning(d.status)) return { text: t('Черновик идёт') + where, tone: 'live' };
  if (draftFailed(d.status)) return { text: t('Черновик не получился') + where, tone: 'fail' };
  return { text: t('Черновик готов') + where, tone: 'ok' };
}

// ---------- слияние принятых правок с документом, который успели поменять

const listish = (k: BlockKind): boolean => k === 'item' || k === 'requirement';

/** Сопоставление блоков base → other по LCS: индекс в other или -1. */
function matchBlocks(a: readonly Block[], b: readonly Block[]): number[] {
  const out = new Array<number>(a.length).fill(-1);
  let i = 0;
  let j = 0;
  for (const op of lcsOps(a, b, (x, y) => x.text === y.text)) {
    if (op === 'same') out[i++] = j++;
    else if (op === 'del') i++;
    else j++;
  }
  return out;
}

/** Кусок наших правок: блоки base [bi, bj) заменены блоками ours [oi, oj); куда он ложится в theirs — [lo, hi). */
type Patch = { bi: number; bj: number; oi: number; oj: number; lo: number; hi: number };

/**
 * Три стороны по блокам markdown: base — с чего начал агент, ours — base с принятыми правками, theirs — документ сейчас.
 * Каждый наш кусок правок накладывается на theirs: его старые блоки в theirs на месте — заменяем ровно их, вставка —
 * сразу за общим соседом; старые блоки там поменяли или убрали — это конфликт (markConflicts пометил такие правки, человек
 * принял их вручную), и наш кусок заменяет всё между ближайшими общими соседями. Чужие правки вне наших кусков остаются.
 * Пустые строки — со стороны, откуда взят блок; у общего блока перед нашей вставкой — как в ours.
 */
export function merge3(base: string, ours: string, theirs: string): string {
  const B = parseBlocks(base).blocks;
  const O = parseBlocks(ours);
  const T = parseBlocks(theirs);
  const mo = matchBlocks(B, O.blocks);
  const mt = matchBlocks(B, T.blocks);
  const patches: Patch[] = [];
  let cur: Patch | undefined;
  let i = 0;
  let j = 0;
  for (const op of lcsOps(B, O.blocks, (x, y) => x.text === y.text)) {
    if (op === 'same') {
      if (cur) patches.push(cur);
      cur = undefined;
      i++;
      j++;
      continue;
    }
    cur ??= { bi: i, bj: i, oi: j, oj: j, lo: 0, hi: 0 };
    if (op === 'del') cur.bj = ++i;
    else cur.oj = ++j;
  }
  if (cur) patches.push(cur);
  for (const p of patches) {
    const at = mt.slice(p.bi, p.bj);
    if (at.length && at.every((x, k) => x >= 0 && (k === 0 || x === at[k - 1]! + 1))) {
      p.lo = at[0]!;
      p.hi = at[at.length - 1]! + 1;
      continue;
    }
    let lo = 0;
    for (let k = p.bi - 1; k >= 0; k--) if (mt[k]! >= 0) { lo = mt[k]! + 1; break; }
    let hi = T.blocks.length;
    for (let k = p.bj; k < B.length; k++) if (mt[k]! >= 0) { hi = mt[k]!; break; }
    p.lo = lo;
    p.hi = p.bj === p.bi ? lo : hi;
  }
  // та же вставка уже есть в theirs (наша прошлая запись или такая же правка у них) — второй раз не вставляем
  const already = (p: Patch) =>
    p.bj === p.bi && p.oj > p.oi && O.blocks.slice(p.oi, p.oj).every((b, k) => T.blocks[p.lo + k]?.text === b.text);
  const todo = patches.filter((p) => !already(p));
  // конфликтные куски, чьи места в theirs пересекаются, сливаются в один
  const merged: Patch[] = [];
  for (const p of todo) {
    const last = merged[merged.length - 1];
    if (last && p.lo < last.hi) {
      last.bj = p.bj;
      last.oj = p.oj;
      last.hi = Math.max(last.hi, p.hi);
    } else merged.push({ ...p });
  }
  type Item = { block: Block; side: 'o' | 't'; base?: number };
  const baseOf = new Map<number, number>();
  mt.forEach((x, k) => x >= 0 && baseOf.set(x, k));
  const items: Item[] = T.blocks.map((block, k) => ({ block, side: 't', ...(baseOf.has(k) ? { base: baseOf.get(k)! } : {}) }));
  for (const p of [...merged].reverse()) items.splice(p.lo, p.hi - p.lo, ...O.blocks.slice(p.oi, p.oj).map((block): Item => ({ block, side: 'o' })));
  const out: string[] = [...T.lead];
  items.forEach((it, k) => {
    const next = items[k + 1];
    let blanks = it.block.blanks;
    // общий блок, за которым идёт наша вставка: пустые строки после него — как в ours (пункт списка не отрывается)
    if (it.side === 't' && next?.side === 'o' && it.base !== undefined && mo[it.base]! >= 0) blanks = O.blocks[mo[it.base]!]!.blanks;
    out.push(...it.block.lines, ...blanks);
    if (next && !blanks.length && next.side !== it.side && !(listish(it.block.kind) && listish(next.block.kind))) out.push('');
  });
  return out.join('\n');
}

/**
 * Что отправить в «Записать принятые»: документ не менялся со старта — решения поверх base и хэш base; менялся — решения
 * сливаются с текущей версией (merge3) и уходят с хэшем текущей.
 */
export function draftResult(doc: { base: string; next: string; current: string; moved: boolean; baseHash: string; currentHash: string }, decisions: Decisions): { text: string; base: string } {
  const ours = applyDecisions(doc.base, doc.next, decisions);
  if (!doc.moved) return { text: ours, base: doc.baseHash };
  return { text: merge3(doc.base, ours, doc.current), base: doc.currentHash };
}

// ---------- правка

/**
 * Обернуть выделение [from, to) разметкой (** — жирный, * — курсив, ` — код); уже обёрнутое — развернуть. Пустое
 * выделение — пара меток с курсором между ними. Возвращает новый текст и выделение.
 */
export function wrapMark(text: string, from: number, to: number, mark: string): { text: string; from: number; to: number } {
  const n = mark.length;
  const sel = text.slice(from, to);
  if (sel.length >= 2 * n && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(n, sel.length - n);
    return { text: text.slice(0, from) + inner + text.slice(to), from, to: from + inner.length };
  }
  if (text.slice(from - n, from) === mark && text.slice(to, to + n) === mark && (mark !== '*' || (text[from - n - 1] !== '*' && text[to + n] !== '*'))) {
    return { text: text.slice(0, from - n) + sel + text.slice(to + n), from: from - n, to: to - n };
  }
  return { text: text.slice(0, from) + mark + sel + mark + text.slice(to), from: from + n, to: to + n };
}

/** Сколько изменений в строках требований: добавлено, удалено, текст поменялся, порядок поменялся (одно на всё). */
export function rowChanges(before: readonly ReqRow[], after: readonly ReqRow[]): number {
  const was = new Map(before.map((r) => [r.id, r.text.trim()]));
  const now = new Map(after.map((r) => [r.id, r.text.trim()]));
  let n = 0;
  for (const [id, text] of now) if (!was.has(id) || was.get(id) !== text) n++;
  for (const id of was.keys()) if (!now.has(id)) n++;
  const order = (rows: readonly ReqRow[], keep: Map<string, string>) => rows.map((r) => r.id).filter((id) => keep.has(id));
  if (order(before, now).join() !== order(after, was).join()) n++;
  return n;
}

/** Подпись раздела для строки «не сохранено» и коммитов: пустой заголовок — «начало». */
export const sectionName = (heading: string): string => heading || t('начало');
