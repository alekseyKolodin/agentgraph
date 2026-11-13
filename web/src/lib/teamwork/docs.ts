// Документы проекта (spec §8.4, макеты PrdRead/PrdEdit): разделы markdown по «## » вне оград кода, оглавление, строки
// требований FR-N и NFR-N, покрытие требований задачами через covers, время чтения, правка раздела требований строками.
// Разбор требований и разделов повторяет сервер (src/teamwork.ts parseRequirements, splitSections). Без React и DOM.
import type { TeamDoc, TeamDocName, TeamMember, TeamProposedTask, TeamRequirement, TeamTask } from '@server/api-types';
import { plural, t } from '../i18n';
import { clock } from '../format';
import { memberByEmail, memberLabel } from './board';

/** Строка требования: «- FR-3. Текст», строго как на сервере (src/teamwork.ts). Группы: вид, номер, текст. */
export const REQ_RE = /^- (FR|NFR)-(\d+)\.\s+(.*)$/;
// ограда — с любым отступом, как на сервере (src/teamwork.ts FENCE_RE): разделы и их адрес у клиента и сервера совпадают
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const H2_RE = /^## (.*)$/;
const H1_RE = /^# (.*)$/;

export type ReqKind = 'FR' | 'NFR';

export const splitLines = (md: string): string[] => md.replace(/\r\n?/g, '\n').split('\n');

/** Какие строки лежат внутри оград кода (включая сами ограды). */
export function fencedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  for (const l of lines) {
    const m = l.match(FENCE_RE);
    if (fence) {
      out.push(true);
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && !l.trim().slice(m[1]!.length)) fence = null;
    } else if (m) {
      fence = m[1]!;
      out.push(true);
    } else out.push(false);
  }
  return out;
}

// закрывающие «##» — как на сервере (src/teamwork.ts splitSections): «## Примеры ## » с пробелом в конце там «Примеры ##», и
// раздел адресуется этим заголовком
const cleanHeading = (s: string): string => s.replace(/[ \t]+#+$/, '').trim();

export type DocSection = {
  /** Заголовок без «## »; пустой — текст до первого раздела (название документа и вступление). */
  heading: string;
  /** Строки документа [start, end) с нуля. */
  start: number;
  end: number;
  /** Раздел целиком, с заголовком. */
  text: string;
  /** Текст без строки заголовка. */
  body: string;
};

/** Разделы по «## » вне оград кода. Текст до первого раздела — раздел с пустым заголовком, если он не пустой. */
export function splitSections(md: string): DocSection[] {
  const lines = splitLines(md);
  const fenced = fencedLines(lines);
  const heads: number[] = [];
  lines.forEach((l, i) => {
    if (!fenced[i] && H2_RE.test(l)) heads.push(i);
  });
  const make = (start: number, end: number, heading: string): DocSection => ({
    heading, start, end, text: lines.slice(start, end).join('\n'), body: lines.slice(heading ? start + 1 : start, end).join('\n'),
  });
  const out: DocSection[] = [];
  const first = heads[0] ?? lines.length;
  if (lines.slice(0, first).some((l) => l.trim())) out.push(make(0, first, ''));
  heads.forEach((h, i) => out.push(make(h, heads[i + 1] ?? lines.length, cleanHeading(lines[h]!.match(H2_RE)![1]!))));
  return out;
}

export const findSection = (sections: readonly DocSection[], heading: string): DocSection | undefined => sections.find((s) => s.heading === heading);

/** Название документа: первый «# » вне оград; нет — пусто. */
export function docTitle(md: string): string {
  const lines = splitLines(md);
  const fenced = fencedLines(lines);
  const i = lines.findIndex((l, k) => !fenced[k] && H1_RE.test(l));
  return i < 0 ? '' : cleanHeading(lines[i]!.match(H1_RE)![1]!);
}

// ---------- требования

export const requirementId = (kind: ReqKind, n: number): string => `${kind}-${n}`;

/** «FR-12» → { kind: 'FR', n: 12 }; не номер требования — undefined. */
export function parseRequirementId(id: string): { kind: ReqKind; n: number } | undefined {
  const m = id.trim().match(/^(FR|NFR)-(\d+)$/i);
  return m ? { kind: m[1]!.toUpperCase() as ReqKind, n: Number(m[2]) } : undefined;
}

/** Требования документа: строки «- FR-N. текст» вне оград кода, с заголовком своего раздела. */
export function parseRequirements(md: string): TeamRequirement[] {
  const lines = splitLines(md);
  const fenced = fencedLines(lines);
  const out: TeamRequirement[] = [];
  let section = '';
  lines.forEach((l, i) => {
    if (fenced[i]) return;
    const h = l.match(H2_RE);
    if (h) {
      section = cleanHeading(h[1]!);
      return;
    }
    const m = l.match(REQ_RE);
    if (m) out.push({ id: requirementId(m[1] as ReqKind, Number(m[2])), text: m[3]!.trim(), section });
  });
  return out;
}

/**
 * Следующий номер вида: максимум в документе плюс один, но не меньше last + 1, если проект помнит последний выданный номер
 * (удалённые номера никто не занимает).
 */
export function nextRequirementId(src: string | readonly TeamRequirement[], kind: ReqKind, last?: number): string {
  const reqs = typeof src === 'string' ? parseRequirements(src) : src;
  let max = last ?? 0;
  for (const r of reqs) {
    const p = parseRequirementId(r.id);
    if (p && p.kind === kind) max = Math.max(max, p.n);
  }
  return requirementId(kind, max + 1);
}

/** Короткая подпись требования для оглавления: первое предложение, не длиннее max символов, по границе слова. */
export function requirementShort(text: string, max = 48): string {
  const first = text.replace(/`/g, '').split(/(?<=[.!?;:])\s|\s[—–]\s/)[0]!.replace(/[.!?;:,]+$/, '').trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max).replace(/\s+\S*$/, '');
  return `${cut || first.slice(0, max)}…`;
}

export type TocItem = { heading: string; count?: number; items: { id: string; short: string }[] };

/** Оглавление: разделы «## » с подпунктами-требованиями; count — сколько требований в разделе. */
export function tocOf(md: string, reqs: readonly TeamRequirement[] = parseRequirements(md)): TocItem[] {
  return splitSections(md)
    .filter((s) => s.heading)
    .map((s) => {
      const items = reqs.filter((r) => r.section === s.heading).map((r) => ({ id: r.id, short: requirementShort(r.text) }));
      return items.length ? { heading: s.heading, count: items.length, items } : { heading: s.heading, items };
    });
}

/** Текущий раздел по прокрутке: последний, чей верх не ниже линии чтения. */
export function currentSection(tops: readonly { heading: string; top: number }[], line: number): string {
  let cur = tops[0]?.heading ?? '';
  for (const s of tops) if (s.top <= line) cur = s.heading;
  return cur;
}

// ---------- покрытие требований задачами

export type Coverage = {
  byReq: Map<string, TeamTask[]>;
  covered: number;
  total: number;
  missing: TeamRequirement[];
  /** «Задачи есть у 10 из 11 требований». */
  text: string;
  /** «FR-6 без задач»; пусто, если задачи есть у всех. */
  missingText: string;
};

export const reqsWord = (n: number): string => `${n} ${plural(n, 'требование', 'требования', 'требований')}`;

export function coverage(reqs: readonly TeamRequirement[], tasks: readonly Pick<TeamTask, 'covers' | 'id'>[]): Coverage {
  const byReq = new Map<string, TeamTask[]>();
  for (const r of reqs) byReq.set(r.id, []);
  for (const x of tasks) for (const id of x.covers) if (byReq.has(id)) byReq.get(id)!.push(x as TeamTask);
  const missing = reqs.filter((r) => !byReq.get(r.id)!.length);
  const covered = reqs.length - missing.length;
  return {
    byReq, covered, total: reqs.length, missing,
    text: t('Задачи есть у {covered} из {total} {word}', { covered, total: reqs.length, word: plural(reqs.length, 'требования', 'требований', 'требований') }),
    missingText: missing.length ? t('{ids} без задач', { ids: missing.map((r) => r.id).join(', ') }) : '',
  };
}

export type ProposalCover = { id: string; state: 'existing' | 'proposed' | 'none' };

/**
 * Покрытие требований предложением разбивки: уже есть задача в проекте, задача в этом предложении, без задач.
 * Строка: «Покрывают FR-3, FR-5, FR-8 · FR-6 остаётся без задач».
 */
export function proposalCoverage(
  reqs: readonly TeamRequirement[], proposed: readonly Pick<TeamProposedTask, 'covers'>[], existing: readonly Pick<TeamTask, 'covers'>[],
): { items: ProposalCover[]; text: string } {
  const inProposal = new Set(proposed.flatMap((p) => p.covers));
  const inProject = new Set(existing.flatMap((x) => x.covers));
  const items = reqs.map((r): ProposalCover => ({ id: r.id, state: inProposal.has(r.id) ? 'proposed' : inProject.has(r.id) ? 'existing' : 'none' }));
  const covers = items.filter((i) => i.state === 'proposed').map((i) => i.id);
  const none = items.filter((i) => i.state === 'none').map((i) => i.id);
  const parts = [
    covers.length ? t('Новые задачи покрывают {ids}', { ids: covers.join(', ') }) : t('Новые задачи не покрывают требований'),
    none.length ? t('{ids} {verb} без задач', { ids: none.join(', '), verb: plural(none.length, 'остаётся', 'остаются', 'остаются') }) : '',
  ];
  return { items, text: parts.filter(Boolean).join(' · ') };
}

// ---------- шапка документа

/** Слов в минуту при чтении технического текста по-русски. */
const WPM = 180;

export function readingMinutes(md: string): number {
  const words = md.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WPM));
}

export const readingText = (md: string): string => t('≈{n} мин чтения', { n: readingMinutes(md) });

export const DOC_TITLE: Record<'prd' | 'architecture' | 'design', string> = { prd: 'ТЗ', architecture: 'Архитектура', design: 'Дизайн' };

/** Имя файла документа: prd → prd.md, docs/x.md — как есть. */
export const docFile = (name: TeamDocName): string => (name.startsWith('docs/') ? name : `${name}.md`);

/** Подпись документа: ТЗ, Архитектура, Дизайн или имя файла в docs/. */
export const docLabel = (name: TeamDocName): string => (name in DOC_TITLE ? t(DOC_TITLE[name as keyof typeof DOC_TITLE]) : name.replace(/^docs\//, ''));

/** День относительно сегодня: «сегодня», «вчера», иначе дата «24.10, 20:59». */
export function relativeDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => Math.floor((x.getTime() - x.getTimezoneOffset() * 60000) / 86400000);
  const diff = day(now) - day(d);
  return diff === 0 ? t('сегодня') : diff === 1 ? t('вчера') : clock(iso, now);
}

/** «обновлено вчера, Мария»; без даты — пусто. */
export function updatedText(doc: Pick<TeamDoc, 'updatedAt' | 'updatedBy'>, members: readonly TeamMember[] = [], now: Date = new Date()): string {
  if (!doc.updatedAt) return '';
  const m = memberByEmail(members, doc.updatedBy);
  const who = m ? memberLabel(m) : doc.updatedBy?.split('@')[0];
  const when = relativeDay(doc.updatedAt, now);
  return who ? t('обновлено {when}, {who}', { when, who }) : t('обновлено {when}', { when });
}

/** Строка шапки: «prd.md · обновлено вчера, Мария · 11 требований · ≈4 мин чтения». */
export function docHeadLine(doc: Pick<TeamDoc, 'name' | 'text' | 'updatedAt' | 'updatedBy'>, members: readonly TeamMember[] = [], now: Date = new Date()): string {
  const reqs = parseRequirements(doc.text);
  return [docFile(doc.name), updatedText(doc, members, now), reqs.length ? reqsWord(reqs.length) : '', readingText(doc.text)].filter(Boolean).join(' · ');
}

// ---------- правка раздела требований строками

export type ReqRow = { id: string; text: string };
/** Раздел требований для правки: строки до первого требования, сами требования, строки после последнего. */
export type ReqSectionParts = { intro: string[]; rows: ReqRow[]; outro: string[] };

/** Тело раздела (без «## ») → строки требований. Строка-продолжение под требованием приклеивается к его тексту. */
export function parseRequirementRows(body: string): ReqSectionParts {
  const lines = splitLines(body);
  const fenced = fencedLines(lines);
  const rows: ReqRow[] = [];
  const intro: string[] = [];
  let tail: string[] = [];
  lines.forEach((l, i) => {
    const m = fenced[i] ? null : l.match(REQ_RE);
    if (m) {
      rows.push({ id: requirementId(m[1] as ReqKind, Number(m[2])), text: m[3]!.trim() });
      tail = [];
    } else if (!rows.length) intro.push(l);
    else if (l.trim() && /^\s/.test(l) && !tail.length) rows[rows.length - 1]!.text += ` ${l.trim()}`;
    else tail.push(l);
  });
  return { intro, rows, outro: tail };
}

/** Строки требований → тело раздела: «- FR-1. текст» по строке на требование, вступление и хвост как были. */
export function serializeRequirementRows(parts: ReqSectionParts): string {
  return [...parts.intro, ...parts.rows.map((r) => `- ${r.id}. ${r.text.trim()}`), ...parts.outro].join('\n');
}

/** Новая строка требования со следующим номером вида (не меньше last + 1). */
export function addRequirementRow(parts: ReqSectionParts, kind: ReqKind, allReqs: readonly TeamRequirement[], last?: number): { parts: ReqSectionParts; id: string } {
  const id = nextRequirementId([...allReqs, ...parts.rows.map((r) => ({ id: r.id, text: r.text, section: '' }))], kind, last);
  return { parts: { ...parts, rows: [...parts.rows, { id, text: '' }] }, id };
}

export const removeRequirementRow = (parts: ReqSectionParts, id: string): ReqSectionParts => ({ ...parts, rows: parts.rows.filter((r) => r.id !== id) });

/** Перенос строки from на позицию to (индексы в rows). */
export function moveRequirementRow(parts: ReqSectionParts, from: number, to: number): ReqSectionParts {
  const rows = [...parts.rows];
  const [row] = rows.splice(from, 1);
  if (!row) return parts;
  rows.splice(Math.max(0, Math.min(to, rows.length)), 0, row);
  return { ...parts, rows };
}

/** Подпись «+ Требование · FR-9». */
export const addRequirementText = (nextId: string): string => t('+ Требование · {id}', { id: nextId });

/** Сообщение коммита раздела: «ТЗ: Требования». */
export const sectionCommitMessage = (name: TeamDocName, heading: string): string => `${docLabel(name)}: ${heading}`;

/** «1 изменение · уйдёт коммитом «ТЗ: Требования»». */
export const changesText = (n: number, message: string): string =>
  t('{n} {w} · уйдёт коммитом «{message}»', { n, w: plural(n, 'изменение', 'изменения', 'изменений'), message });

// ---------- ссылки в тексте

export type TextRef = { kind: 'task' | 'requirement' | 'doc'; text: string; start: number; end: number };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Номера задач команды, требований и пути документов проекта в тексте — чтобы сделать их ссылками. */
export function findRefs(text: string, prefix: string): TextRef[] {
  const task = prefix ? `(?<task>${escapeRe(prefix)}-\\d+)|` : '';
  const re = new RegExp(`(?<![\\w-])(?:${task}(?<req>N?FR-\\d+)|(?<doc>(?:prd|architecture|design)\\.md|docs/[\\w./-]+\\.\\w+))(?![\\w-])`, 'g');
  const out: TextRef[] = [];
  for (const m of text.matchAll(re)) {
    const g = m.groups ?? {};
    const kind: TextRef['kind'] = g.task ? 'task' : g.req ? 'requirement' : 'doc';
    out.push({ kind, text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Текст кусками: простой текст и ссылки по порядку. */
export function splitRefs(text: string, prefix: string): ({ kind: 'text'; text: string } | TextRef)[] {
  const out: ({ kind: 'text'; text: string } | TextRef)[] = [];
  let at = 0;
  for (const r of findRefs(text, prefix)) {
    if (r.start > at) out.push({ kind: 'text', text: text.slice(at, r.start) });
    out.push(r);
    at = r.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}
