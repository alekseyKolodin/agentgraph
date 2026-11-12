// Правки агента в документе (spec §9.3, макет Prd.dc.html): дифф старого и нового markdown по блокам (заголовок, абзац,
// пункт списка, строка требования, код), внутри изменённого блока — по словам. У правок устойчивые id по содержимому,
// причины из notes.json привязываются по номеру требования или заголовку раздела, решения складываются в итоговый markdown.
// Чистые функции без React и DOM.
import type { TeamDraftNote } from '@server/api-types';
import { plural, t } from '../i18n';
import { REQ_RE } from './docs';

export type BlockKind = 'heading' | 'paragraph' | 'item' | 'requirement' | 'code' | 'other';

/** Блок документа: строки и пустые строки после него — так документ собирается обратно без потерь. */
export type Block = {
  kind: BlockKind;
  lines: string[];
  blanks: string[];
  /** Ключ сравнения: строки блока. */
  text: string;
  /** Текст без маркера списка, номера требования или решёток заголовка — для пословного диффа и показа. */
  content: string;
  level?: number;
  title?: string;
  requirement?: string;
};

export type ParsedDoc = { lead: string[]; blocks: Block[] };

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const TABLE_RE = /^\s*\|/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

const isBlank = (l: string): boolean => !l.trim();
const startsBlock = (l: string): boolean => FENCE_RE.test(l) || HEADING_RE.test(l) || ITEM_RE.test(l) || TABLE_RE.test(l) || HR_RE.test(l);

/** Markdown → блоки. Пустые строки уходят в blanks предыдущего блока (или в lead, если документ с них начинается). */
export function parseBlocks(md: string): ParsedDoc {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const lead: string[] = [];
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length && isBlank(lines[i]!)) lead.push(lines[i++]!);
  while (i < lines.length) {
    const first = lines[i]!;
    const body: string[] = [first];
    let kind: BlockKind = 'paragraph';
    const fence = first.match(FENCE_RE);
    if (fence) {
      kind = 'code';
      i++;
      while (i < lines.length) {
        const l = lines[i++]!;
        body.push(l);
        const m = l.match(FENCE_RE);
        if (m && m[1]![0] === fence[1]![0] && m[1]!.length >= fence[1]!.length && !l.trim().slice(m[1]!.length)) break;
      }
    } else if (HEADING_RE.test(first)) {
      kind = 'heading';
      i++;
    } else if (ITEM_RE.test(first)) {
      kind = REQ_RE.test(first) ? 'requirement' : 'item';
      i++;
      while (i < lines.length && !isBlank(lines[i]!) && /^\s/.test(lines[i]!) && !FENCE_RE.test(lines[i]!)) body.push(lines[i++]!);
    } else if (HR_RE.test(first)) {
      kind = 'other';
      i++;
    } else if (TABLE_RE.test(first)) {
      kind = 'other';
      i++;
      while (i < lines.length && TABLE_RE.test(lines[i]!)) body.push(lines[i++]!);
    } else {
      i++;
      while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!)) body.push(lines[i++]!);
    }
    const blanks: string[] = [];
    while (i < lines.length && isBlank(lines[i]!)) blanks.push(lines[i++]!);
    const text = body.join('\n');
    const block: Block = { kind, lines: body, blanks, text, content: text };
    if (kind === 'heading') {
      const h = first.match(HEADING_RE)!;
      block.level = h[1]!.length;
      block.title = h[2]!.trim();
      block.content = block.title;
    }
    if (kind === 'requirement') {
      const r = first.match(REQ_RE)!;
      block.requirement = `${r[1]}-${Number(r[2])}`;
      block.content = [r[3]!.trim(), ...body.slice(1).map((l) => l.trim())].join('\n');
    }
    if (kind === 'item') block.content = [first.replace(ITEM_RE, ''), ...body.slice(1).map((l) => l.trim())].join('\n');
    blocks.push(block);
  }
  return { lead, blocks };
}

export const serializeBlocks = (doc: ParsedDoc): string => [...doc.lead, ...doc.blocks.flatMap((b) => [...b.lines, ...b.blanks])].join('\n');

// ---------- LCS

type LcsOp = 'same' | 'del' | 'ins';

/** Самая большая DP-таблица: документы маленькие, а дальше середина считается просто заменой. */
const MAX_CELLS = 4_000_000;

/** Операции выравнивания двух списков: общий префикс и суффикс снимаются, середина — по LCS. */
export function lcsOps<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): LcsOp[] {
  let head = 0;
  while (head < a.length && head < b.length && eq(a[head]!, b[head]!)) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && eq(a[a.length - 1 - tail]!, b[b.length - 1 - tail]!)) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const mid: LcsOp[] = [];
  if (n * m > MAX_CELLS) mid.push(...Array<LcsOp>(n).fill('del'), ...Array<LcsOp>(m).fill('ins'));
  else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = eq(a[head + i]!, b[head + j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (eq(a[head + i]!, b[head + j]!)) {
        mid.push('same');
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        mid.push('del');
        i++;
      } else {
        mid.push('ins');
        j++;
      }
    }
    while (i++ < n) mid.push('del');
    while (j++ < m) mid.push('ins');
  }
  return [...Array<LcsOp>(head).fill('same'), ...mid, ...Array<LcsOp>(tail).fill('same')];
}

// ---------- слова

export type WordSeg = { kind: 'same' | 'del' | 'ins'; text: string };

/**
 * Дифф по словам с чисткой: одиночное общее слово между двумя правками уходит в обе стороны правки, чтобы не дробить
 * фразу («Кодировка [файла — UTF-8.] [на выбор в форме: …, UTF-8 с BOM для Excel.]»).
 */
export function wordDiff(a: string, b: string): WordSeg[] {
  const wa = a.split(/\s+/).filter(Boolean);
  const wb = b.split(/\s+/).filter(Boolean);
  const ops = lcsOps(wa, wb);
  const segs: { kind: WordSeg['kind']; words: string[] }[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    let word: string;
    if (op === 'ins') word = wb[j++]!;
    else {
      word = wa[i++]!;
      if (op === 'same') j++;
    }
    const last = segs[segs.length - 1];
    if (last && last.kind === op) last.words.push(word);
    else segs.push({ kind: op, words: [word] });
  }
  // группы правок: подряд идущие del/ins; одиночное same между ними вливается в обе стороны
  type Group = { del: string[]; ins: string[] };
  const groups: (Group | { same: string[] })[] = [];
  for (const s of segs) {
    const last = groups[groups.length - 1];
    if (s.kind === 'same') groups.push({ same: s.words });
    else if (last && 'del' in last) last[s.kind].push(...s.words);
    else groups.push({ del: s.kind === 'del' ? [...s.words] : [], ins: s.kind === 'ins' ? [...s.words] : [] });
  }
  for (let k = 1; k < groups.length - 1; ) {
    const g = groups[k]!;
    const prev = groups[k - 1]!;
    const next = groups[k + 1]!;
    if ('same' in g && g.same.length <= 1 && 'del' in prev && 'del' in next) {
      prev.del = [...prev.del, ...g.same, ...next.del];
      prev.ins = [...prev.ins, ...g.same, ...next.ins];
      groups.splice(k, 2);
    } else k++;
  }
  const out: WordSeg[] = [];
  for (const g of groups) {
    if ('same' in g) out.push({ kind: 'same', text: g.same.join(' ') });
    else {
      if (g.del.length) out.push({ kind: 'del', text: g.del.join(' ') });
      if (g.ins.length) out.push({ kind: 'ins', text: g.ins.join(' ') });
    }
  }
  return out;
}

/** Построчный дифф для вкладки «Исходник». */
export function lineDiff(a: string, b: string): { kind: WordSeg['kind']; text: string }[] {
  const la = a.replace(/\r\n?/g, '\n').split('\n');
  const lb = b.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let j = 0;
  return lcsOps(la, lb).map((op) => {
    if (op === 'ins') return { kind: 'ins' as const, text: lb[j++]! };
    const text = la[i++]!;
    if (op === 'same') j++;
    return { kind: op, text };
  });
}

// ---------- правки

export type EditKind = 'added' | 'removed' | 'changed';
export type Decision = 'accept' | 'reject';
export type Decisions = Record<string, Decision>;

export type TrackEdit = {
  /** Устойчивый id по содержимому правки: переживает перерисовку и запись других правок. */
  id: string;
  /** Порядковый номер в документе с 1. */
  n: number;
  kind: EditKind;
  block: BlockKind;
  /** Заголовок раздела «## », в котором стоит правка; пустой — до первого раздела. */
  section: string;
  requirement?: string;
  /** Старый и новый блок целиком, как в файле. */
  old?: string;
  next?: string;
  /** То же без маркера списка и номера требования — что показывать читателю. */
  oldContent?: string;
  nextContent?: string;
  /** Пословный дифф содержимого для changed. */
  words?: WordSeg[];
  why?: string;
  /** Старый текст уже не совпадает с документом: принимать только руками. */
  conflict?: boolean;
};

export type TrackRow =
  | { kind: 'same'; text: string; content: string; block: BlockKind; requirement?: string; title?: string; level?: number }
  | { kind: 'edit'; edit: TrackEdit };

export type TrackSection = { heading: string; rows: TrackRow[]; edits: TrackEdit[]; unresolved: number };

export type TrackDoc = {
  edits: TrackEdit[];
  sections: TrackSection[];
  total: number;
  resolved: number;
  /** «решено 1 из 4». */
  progress: string;
};

type PlanItem = { type: 'same'; a: Block; b: Block } | { type: 'edit'; edit: TrackEdit; a?: Block; b?: Block };
type Plan = { leadA: string[]; leadB: string[]; items: PlanItem[] };

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const KINDS: readonly BlockKind[] = ['heading', 'paragraph', 'item', 'code', 'other'];

/** Пары «старый блок → новый» в разрыве между общими блоками: требования по номеру, остальное по виду и порядку. */
function pairGap(dels: readonly Block[], inss: readonly Block[]): { a?: Block; b?: Block }[] {
  const pairs = new Map<Block, Block>();
  const usedB = new Set<Block>();
  const take = (a: Block, b: Block | undefined) => {
    if (!b) return;
    pairs.set(a, b);
    usedB.add(b);
  };
  for (const a of dels) if (a.requirement) take(a, inss.find((x) => !usedB.has(x) && x.requirement === a.requirement));
  for (const kind of KINDS) {
    const left = dels.filter((x) => x.kind === kind && !pairs.has(x));
    const right = inss.filter((x) => x.kind === kind && !usedB.has(x));
    left.forEach((a, i) => take(a, right[i]));
  }
  const byB = new Map([...pairs].map(([a, b]) => [b, a]));
  // удалённые блоки до первого удалённого «## » — перед новыми, остальные (удалённый раздел) — после
  const free = dels.filter((a) => !pairs.has(a));
  const cut = free.findIndex((a) => a.kind === 'heading' && a.level === 2);
  const head = cut < 0 ? free : free.slice(0, cut);
  const rest = cut < 0 ? [] : free.slice(cut);
  const out: { a?: Block; b?: Block }[] = head.map((a) => ({ a }));
  for (const b of inss) {
    const a = byB.get(b);
    out.push(a ? { a, b } : { b });
  }
  for (const a of rest) out.push({ a });
  return out;
}

function makePlan(oldMd: string, nextMd: string): Plan {
  const A = parseBlocks(oldMd);
  const B = parseBlocks(nextMd);
  const ops = lcsOps(A.blocks, B.blocks, (x, y) => x.text === y.text);
  const items: PlanItem[] = [];
  const seen = new Map<string, number>();
  let section = '';
  let n = 0;
  let dels: Block[] = [];
  let inss: Block[] = [];
  const flush = () => {
    for (const { a, b } of pairGap(dels, inss)) {
      const kind: EditKind = a && b ? 'changed' : a ? 'removed' : 'added';
      const src = b ?? a!;
      if (src.kind === 'heading' && src.level === 2 && b) section = b.title ?? '';
      const key = `${kind}|${a?.text ?? ''}|${b?.text ?? ''}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      const edit: TrackEdit = { id: count > 1 ? `${fnv(key)}-${count}` : fnv(key), n: ++n, kind, block: src.kind, section };
      if (src.requirement) edit.requirement = src.requirement;
      if (a) {
        edit.old = a.text;
        edit.oldContent = a.content;
      }
      if (b) {
        edit.next = b.text;
        edit.nextContent = b.content;
      }
      if (a && b) edit.words = wordDiff(a.content, b.content);
      items.push({ type: 'edit', edit, a, b });
    }
    dels = [];
    inss = [];
  };
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === 'del') dels.push(A.blocks[i++]!);
    else if (op === 'ins') inss.push(B.blocks[j++]!);
    else {
      flush();
      const a = A.blocks[i++]!;
      const b = B.blocks[j++]!;
      if (a.kind === 'heading' && a.level === 2) section = a.title ?? '';
      items.push({ type: 'same', a, b });
    }
  }
  flush();
  return { leadA: A.lead, leadB: B.lead, items };
}

const normAt = (s: string): string => s.trim().replace(/^#+\s*/, '').replace(/\s+#+$/, '').replace(/\s+/g, ' ').toLowerCase();

/** Запись notes.json; у teamwork-architecture ещё doc — к какому из двух документов относится причина. */
export type DraftNote = TeamDraftNote & { doc?: string };

/**
 * Причины из notes.json: по номеру требования — к его правкам, по заголовку раздела — по порядку к правкам раздела без
 * причины. doc отбирает записи своего документа: без поля doc запись подходит любому.
 */
export function attachNotes(edits: readonly TrackEdit[], notes: readonly DraftNote[], doc?: string): TrackEdit[] {
  const out = edits.map((e) => ({ ...e }));
  const add = (e: TrackEdit, why: string) => {
    e.why = e.why ? `${e.why} ${why}` : why;
  };
  const bySection: TeamDraftNote[] = [];
  for (const note of notes) {
    if (doc && note.doc && note.doc !== doc) continue;
    const at = String(note.at ?? '').trim();
    const why = String(note.why ?? '').trim();
    if (!at || !why) continue;
    if (/^N?FR-\d+$/i.test(at)) {
      const id = at.toUpperCase();
      const hits = out.filter((e) => e.requirement === id);
      if (hits.length) {
        for (const e of hits) add(e, why);
        continue;
      }
    }
    bySection.push({ at, why });
  }
  for (const note of bySection) {
    const inSection = out.filter((e) => normAt(e.section) === normAt(note.at));
    if (!inSection.length) continue;
    const target = inSection.find((e) => !e.why) ?? inSection[inSection.length - 1]!;
    add(target, note.why);
  }
  return out;
}

export const progressText = (resolved: number, total: number): string => t('решено {resolved} из {total}', { resolved, total });

/** Документ с правками: строки по разделам, счётчики нерешённых, причины (doc — для notes с полем doc). */
export function trackChanges(oldMd: string, nextMd: string, notes: readonly DraftNote[] = [], decisions: Decisions = {}, doc?: string): TrackDoc {
  const plan = makePlan(oldMd, nextMd);
  const edits = attachNotes(plan.items.filter((x): x is Extract<PlanItem, { type: 'edit' }> => x.type === 'edit').map((x) => x.edit), notes, doc);
  const byId = new Map(edits.map((e) => [e.id, e]));
  const sections: TrackSection[] = [];
  let cur: TrackSection | undefined;
  const open = (heading: string) => {
    cur = { heading, rows: [], edits: [], unresolved: 0 };
    sections.push(cur);
  };
  for (const item of plan.items) {
    if (item.type === 'same') {
      const a = item.a;
      if (a.kind === 'heading' && a.level === 2) open(a.title ?? '');
      else if (!cur) open('');
      const row: TrackRow = { kind: 'same', text: a.text, content: a.content, block: a.kind };
      if (a.requirement) row.requirement = a.requirement;
      if (a.kind === 'heading') {
        row.title = a.title;
        row.level = a.level;
      }
      cur!.rows.push(row);
    } else {
      const e = byId.get(item.edit.id)!;
      const src = item.b ?? item.a!;
      if (src.kind === 'heading' && src.level === 2 && item.b) open(src.title ?? '');
      else if (!cur) open('');
      cur!.rows.push({ kind: 'edit', edit: e });
      cur!.edits.push(e);
      if (!decisions[e.id]) cur!.unresolved++;
    }
  }
  const resolved = edits.filter((e) => decisions[e.id]).length;
  return { edits, sections, total: edits.length, resolved, progress: progressText(resolved, edits.length) };
}

const listish = (k: BlockKind): boolean => k === 'item' || k === 'requirement';

/**
 * Итоговый markdown по решениям: принятая правка берёт новый текст, отклонённая и нерешённая — старый.
 * Пустые строки идут из старого документа; перед принятым добавленным блоком — из нового, а между блоками из разных
 * документов, у которых пустой строки не было, она добавляется, чтобы абзацы не слиплись.
 */
export function applyDecisions(oldMd: string, nextMd: string, decisions: Decisions): string {
  const plan = makePlan(oldMd, nextMd);
  const hadOld = plan.items.some((it) => it.type === 'same' || it.a);
  const out: string[] = [...(hadOld ? plan.leadA : plan.leadB)];
  let prev: { kind: BlockKind; blanks: number; side: 'a' | 'b' } | undefined;
  const emit = (block: Block, side: 'a' | 'b', blanks: string[]) => {
    if (prev && prev.blanks === 0 && prev.side !== side && !(listish(prev.kind) && listish(block.kind))) out.push('');
    out.push(...block.lines, ...blanks);
    prev = { kind: block.kind, blanks: blanks.length, side };
  };
  const accepted = (k: number): boolean => {
    const it = plan.items[k];
    return Boolean(it && it.type === 'edit' && decisions[it.edit.id] === 'accept');
  };
  plan.items.forEach((item, k) => {
    if (item.type === 'same') {
      const nextAdded = accepted(k + 1) && (plan.items[k + 1] as Extract<PlanItem, { type: 'edit' }>).edit.kind === 'added';
      emit(item.a, 'a', nextAdded ? item.b.blanks : item.a.blanks);
      return;
    }
    const ok = decisions[item.edit.id] === 'accept';
    const { a, b } = item;
    if (a && b) emit(ok ? b : a, ok ? 'b' : 'a', a.blanks);
    else if (a && !ok) emit(a, 'a', a.blanks);
    else if (a && ok && prev && prev.blanks === 0 && a.blanks.length) {
      out.push(...a.blanks);
      prev.blanks = a.blanks.length;
    } else if (b && ok) emit(b, 'b', b.blanks);
  });
  return out.join('\n');
}

/** Все нерешённые правки — принять. */
export function acceptRest(edits: readonly TrackEdit[], decisions: Decisions): Decisions {
  const out = { ...decisions };
  for (const e of edits) out[e.id] ??= 'accept';
  return out;
}

/** Следующая (dir 1) или предыдущая (dir -1) правка от текущей; с конца — по кругу. Нет правок — undefined. */
export function stepEdit(edits: readonly TrackEdit[], current: string | undefined, dir: 1 | -1): TrackEdit | undefined {
  if (!edits.length) return undefined;
  const i = current ? edits.findIndex((e) => e.id === current) : -1;
  if (i < 0) return dir > 0 ? edits[0] : edits[edits.length - 1];
  return edits[(i + dir + edits.length) % edits.length];
}

/** Первая нерешённая правка после текущей; все решены — undefined. */
export function nextUnresolved(edits: readonly TrackEdit[], decisions: Decisions, current?: string): TrackEdit | undefined {
  const start = current ? edits.findIndex((e) => e.id === current) + 1 : 0;
  for (let k = 0; k < edits.length; k++) {
    const e = edits[(start + k) % edits.length]!;
    if (!decisions[e.id]) return e;
  }
  return undefined;
}

/** Правки, чей старый текст уже не совпадает с текущим документом (его поменяли после старта черновика), помечаются конфликтом. */
export function markConflicts(edits: readonly TrackEdit[], currentMd: string): TrackEdit[] {
  const texts = new Set(parseBlocks(currentMd).blocks.map((b) => b.text));
  return edits.map((e) => (e.old !== undefined && !texts.has(e.old) ? { ...e, conflict: true } : { ...e }));
}

/** «1 из 4», и решение: «принято», «отклонено». */
export const editLabel = (e: Pick<TrackEdit, 'n'>, total: number): string => t('{n} из {total}', { n: e.n, total });
export const decisionText = (d: Decision | undefined): string => (d === 'accept' ? t('принято') : d === 'reject' ? t('отклонено') : '');

/** «Цель и проблема, Для кого, Сценарии — без правок» для свёрнутых разделов подряд. */
export const foldText = (headings: readonly string[]): string => t('{list} — без правок', { list: headings.join(', ') });

/** Строка над документом: «Черновик агента: 4 правки». */
export const draftTitle = (total: number): string => t('Черновик агента: {n} {w}', { n: total, w: plural(total, 'правка', 'правки', 'правок') });
