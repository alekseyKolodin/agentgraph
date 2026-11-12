// Экраны документов проекта (волна 3, ui-docs; spec §8.4, §9.2–9.3; макеты PrdRead, PrdEdit, Prd): куски раздела для
// чтения (markdown и строки требований), где задача на полях, куда ведёт ссылка из текста, пустой документ, вид новых
// требований раздела, черновики документа, слияние принятых правок агента с текущей версией документа (три стороны по
// блокам), обёртка выделения разметкой. Чистые функции без React и DOM.
import type { TeamColumns, TeamDocName, TeamDraft, TeamSprint, TeamTask } from '@server/api-types';
import { t } from '../i18n';
import { statusText } from './board';
import {
  fencedLines, parseRequirementRows, REQ_RE, requirementId, serializeRequirementRows, splitLines, splitSections, type ReqKind, type ReqRow, type TextRef,
} from './docs';
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

/**
 * Можно ли править раздел строками требований без потерь: сборка строк обратно даёт тот же текст с точностью до пустых
 * строк. Подзаголовки, абзацы, таблицы или вложенные пункты между требованиями строки не хранят — такой раздел
 * правится в Markdown.
 */
export function rowsLossless(body: string): boolean {
  const solid = (text: string) => splitLines(text).filter((l) => l.trim()).map((l) => l.trimEnd());
  const a = solid(body);
  const b = solid(serializeRequirementRows(parseRequirementRows(body)));
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

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

/** Операция над theirs: блоки [lo, hi) заменяются blocks; bi, bj — какие блоки base она покрывает (для слияния соседних). */
type Op = { lo: number; hi: number; blocks: Block[]; bi: number; bj: number };

/** Итог слияния: текст и чужие блоки (их правки после старта черновика), которые он заменил, — показать человеку. */
export type MergeResult = { text: string; lost: string[] };

/**
 * Три стороны по блокам markdown: base — с чего начали правки, ours — base с принятыми правками, theirs — документ сейчас.
 * Каждый наш кусок правок (base → ours) накладывается на theirs:
 * - его старые блоки в theirs на месте — заменяются ровно они (чужие вставки между ними остаются);
 * - вставка — сразу за общим соседом сверху, а если его поменяли — перед общим соседом снизу; та же вставка уже есть —
 *   не повторяется;
 * - старые блоки у них поменяли или убрали — конфликт: кусок между ближайшими блоками, общими для всех трёх, берётся из
 *   ours целиком (такие правки человек принял вручную, markConflicts), а чужие блоки, которые он заменил, — в lost.
 * Пересекающиеся куски сливаются в один конфликт. Пустые строки — со стороны, откуда взят блок; у общего блока перед
 * нашей вставкой — как в ours.
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  const B = parseBlocks(base).blocks;
  const O = parseBlocks(ours);
  const T = parseBlocks(theirs);
  const mo = matchBlocks(B, O.blocks);
  const mt = matchBlocks(B, T.blocks);
  const both = (k: number) => mo[k]! >= 0 && mt[k]! >= 0;
  /** Конфликт над блоками base [bi, bj): между ближайшими соседями, общими для всех трёх, берём ours. */
  const conflict = (bi: number, bj: number): Op => {
    let pk = bi - 1;
    while (pk >= 0 && !both(pk)) pk--;
    let nk = bj;
    while (nk < B.length && !both(nk)) nk++;
    const lo = pk >= 0 ? mt[pk]! + 1 : 0;
    const hi = nk < B.length ? mt[nk]! : T.blocks.length;
    const oi = pk >= 0 ? mo[pk]! + 1 : 0;
    const oj = nk < B.length ? mo[nk]! : O.blocks.length;
    return { lo, hi, blocks: O.blocks.slice(oi, oj), bi: pk + 1, bj: nk };
  };
  const ops: Op[] = [];
  let bi = 0;
  let oi = 0;
  let i = 0;
  let j = 0;
  let open = false;
  const close = () => {
    if (!open) return;
    open = false;
    const bj = i;
    const oj = j;
    const blocks = O.blocks.slice(oi, oj);
    if (bj === bi) {
      // вставка: за общим соседом сверху; его поменяли — перед общим соседом снизу; нет обоих — конфликт
      const lo = bi > 0 && mt[bi - 1]! >= 0 ? mt[bi - 1]! + 1 : bi < B.length && mt[bi]! >= 0 ? mt[bi]! : -1;
      if (lo < 0) {
        ops.push(conflict(bi, bj));
        return;
      }
      if (blocks.every((b, k) => T.blocks[lo + k]?.text === b.text)) return;
      ops.push({ lo, hi: lo, blocks, bi, bj });
      return;
    }
    const at = mt.slice(bi, bj);
    if (!at.every((x) => x >= 0)) {
      ops.push(conflict(bi, bj));
      return;
    }
    if (at.every((x, k) => k === 0 || x === at[k - 1]! + 1)) {
      ops.push({ lo: at[0]!, hi: at[at.length - 1]! + 1, blocks, bi, bj });
      return;
    }
    // старые блоки на месте, но у них между ними вставки: меняем только их, вставки остаются
    if (blocks.length === at.length) at.forEach((x, k) => ops.push({ lo: x, hi: x + 1, blocks: [blocks[k]!], bi: bi + k, bj: bi + k + 1 }));
    else at.forEach((x, k) => ops.push({ lo: x, hi: x + 1, blocks: k === 0 ? blocks : [], bi: bi + k, bj: bi + k + 1 }));
  };
  for (const op of lcsOps(B, O.blocks, (x, y) => x.text === y.text)) {
    if (op === 'same') {
      close();
      i++;
      j++;
      continue;
    }
    if (!open) {
      open = true;
      bi = i;
      oi = j;
    }
    if (op === 'del') i++;
    else j++;
  }
  close();
  // пересекающиеся куски — один конфликт по объединённым блокам base
  ops.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const merged: Op[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && (op.lo < last.hi || (op.lo === last.lo && op.hi === last.hi && op.lo === op.hi))) {
      merged[merged.length - 1] = conflict(Math.min(last.bi, op.bi), Math.max(last.bj, op.bj));
    } else merged.push(op);
  }
  type Item = { block: Block; side: 'o' | 't'; base?: number };
  const baseOf = new Map<number, number>();
  mt.forEach((x, k) => x >= 0 && baseOf.set(x, k));
  const items: Item[] = T.blocks.map((block, k) => ({ block, side: 't', ...(baseOf.has(k) ? { base: baseOf.get(k)! } : {}) }));
  const lost: string[] = [];
  for (const op of [...merged].reverse()) {
    const put = new Set(op.blocks.map((b) => b.text));
    lost.unshift(...T.blocks.slice(op.lo, op.hi).filter((b, k) => !baseOf.has(op.lo + k) && !put.has(b.text)).map((b) => b.text));
    items.splice(op.lo, op.hi - op.lo, ...op.blocks.map((block): Item => ({ block, side: 'o' })));
  }
  const out: string[] = [...T.lead];
  items.forEach((it, k) => {
    const next = items[k + 1];
    let blanks = it.block.blanks;
    // общий блок, за которым идёт наша вставка: пустые строки после него — как в ours (пункт списка не отрывается)
    if (it.side === 't' && next?.side === 'o' && it.base !== undefined && mo[it.base]! >= 0) blanks = O.blocks[mo[it.base]!]!.blanks;
    out.push(...it.block.lines, ...blanks);
    if (next && !blanks.length && next.side !== it.side && !(listish(it.block.kind) && listish(next.block.kind))) out.push('');
  });
  return { text: out.join('\n'), lost };
}

/**
 * Что отправить в «Записать принятые»: документ не менялся со старта — решения поверх base и хэш base; менялся — новые
 * решения сливаются с текущей версией (merge3) от того, что уже записано раньше (written — записанные правки), и уходят
 * с хэшем текущей. lost — чужие блоки, которые запись заменит. Документ удалили после старта — gone.
 */
export function draftResult(
  doc: { base: string; next: string; current: string; moved: boolean; baseHash: string; currentHash: string },
  decisions: Decisions,
  written: Decisions = {},
): { text: string; base: string; lost: string[]; gone?: true } {
  const ours = applyDecisions(doc.base, doc.next, decisions);
  if (!doc.moved) return { text: ours, base: doc.baseHash, lost: [] };
  if (!doc.current.trim() && doc.base.trim()) return { text: '', base: doc.currentHash, lost: [], gone: true };
  const own = Object.keys(written).length ? applyDecisions(doc.base, doc.next, written) : doc.base;
  const m = merge3(own, ours, doc.current);
  return { text: m.text, base: doc.currentHash, lost: m.lost };
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
