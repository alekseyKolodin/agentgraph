// Ответ помощника «Правки» (screens/flow/Assistant.tsx): итог ИИ словами → вступление (markdown), фразы по этапам и
// предупреждения; разница двух версий flow → строки «Что изменилось» («новый · этап · фраза»), клик по строке ведёт к этапу.
// Итог ИИ пишет по правилу 9 редактора (src/edit.ts): «- `имя`: фраза» на этап, блок или файл и «! » перед тем, что
// стоит проверить. Модель может и не послушаться — тогда весь текст остаётся вступлением, а строки берут фразу из полей.
import { plural } from '../format';
import { t } from '../i18n';
import { blockLabel, PHASE_FIELDS, type EditBlock, type EditSpec } from './edit';

export type ChangeKind = 'new' | 'edit' | 'gone';
export type ChangeWhat = 'phase' | 'block' | 'artifact' | 'flow';
/** Строка «Что изменилось»: что (этап, блок, файл, настройки flow), его имя в файле, подпись и одна фраза. */
export type ChangeRow = { kind: ChangeKind; what: ChangeWhat; name: string; label: string; text: string };
export type AssistantReply = { intro: string; rows: ChangeRow[]; notes: string[] };

const NOTE = /^\s*(?:[-*]\s+)?(?:!\s+|⚠️?\s*|(?:Обрати внимание|Внимание|Note|Warning)\s*[:.]\s*)(.+)$/i;
const ITEM = /^\s*[-*+]\s+(?:(?:этап|блок|файл|артефакт|phase|block|file|artifact)\s+)?\**`?([A-Za-z0-9_.-]+)`?\**\s*(?::|—|–|\s-\s)\s*(.+)$/i;

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const sentence = (s: string) => {
  const x = cap(s.trim());
  return /[.!?…]$/.test(x) ? x : `${x}.`;
};

/**
 * Итог ИИ → вступление, фразы по именам и предупреждения. names — имена этапов, блоков и файлов обеих версий: строка
 * списка с другим именем — обычный текст вступления.
 */
export function parseReply(text: string, names: Set<string>): { intro: string; items: Map<string, string>; notes: string[] } {
  const items = new Map<string, string>();
  const notes: string[] = [];
  const intro: string[] = [];
  let fence = false;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const note = !fence && line.match(NOTE);
    if (note) {
      notes.push(note[1]!.trim());
      continue;
    }
    const item = !fence && line.match(ITEM);
    if (item && names.has(item[1]!) && !items.has(item[1]!)) {
      items.set(item[1]!, item[2]!.trim());
      continue;
    }
    intro.push(line);
  }
  return { intro: intro.join('\n').replace(/\n{3,}/g, '\n\n').trim(), items, notes };
}

const norm = (v: unknown) => (v === '' || v === undefined || (Array.isArray(v) && !v.length) ? null : v);
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const get = (o: object | undefined, k: string): unknown => (o as Record<string, unknown> | undefined)?.[k];
const fieldsText = (labels: string[]) => sentence(labels.join(', '));

const BLOCK_FIELDS: [keyof EditBlock, string][] = [
  ['title', 'название'], ['loop', 'повторы и условие'], ['on_fail', 'что делать, если условие не выполнено'], ['knowledge', 'теги знаний'],
  ['plugins', 'плагины'], ['flow', 'вызываемый flow'], ['input', 'задача вызова'], ['next', 'развилка после блока'],
];
const ART_FIELDS = [['title', 'название'], ['file', 'имя файла'], ['initial', 'заготовка'], ['decisions', 'ответы на паузы']] as const;
const FLOW_FIELDS = [['description', 'описание'], ['input', 'задача по умолчанию'], ['defaults', 'настройки по умолчанию']] as const;

const artFile = (key: string, a: { file?: string } | undefined) => a?.file || `${key}.md`;

/** Что поменялось между версиями flow: строки по этапам, блокам, файлам и настройкам; фраза — из items, нет — поля словами. */
export function changeRows(before: EditSpec, after: EditSpec, items: Map<string, string> = new Map()): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const phrase = (name: string, fallback: string) => (items.has(name) ? sentence(items.get(name)!) : fallback);

  const top = FLOW_FIELDS.filter(([k]) => !same(before[k], after[k])).map(([, l]) => t(l));
  if (top.length) rows.push({ kind: 'edit', what: 'flow', name: '', label: t('Настройки flow'), text: fieldsText(top) });

  const single = after.blocks.length === 1 && before.blocks.length === 1;
  const oldBlocks = new Map(before.blocks.map((b) => [b.name, b]));
  after.blocks.forEach((b, bi) => {
    const old = oldBlocks.get(b.name);
    if (!old) {
      rows.push({ kind: 'new', what: 'block', name: b.name, label: t('Блок «{block}»', { block: blockLabel(b, bi) }), text: phrase(b.name, t('Новый блок.')) });
      return;
    }
    const keys = BLOCK_FIELDS.filter(([k]) => !same(old[k], b[k]));
    const order = old.phases.map((p) => p.name).filter((n) => b.phases.some((q) => q.name === n));
    const now = b.phases.map((p) => p.name).filter((n) => old.phases.some((q) => q.name === n));
    const labels = keys.map(([, l]) => t(l));
    if (!same(order, now)) labels.push(t('порядок этапов'));
    if (!labels.length) return;
    // у одиночного блока менять, кроме цикла, почти нечего: «Условие повтора», как на схеме
    const label = single && keys.every(([k]) => k === 'loop') && labels.length === 1 ? t('Условие повтора') : t('Блок «{block}»', { block: blockLabel(b, bi) });
    rows.push({ kind: 'edit', what: 'block', name: b.name, label, text: phrase(b.name, fieldsText(labels)) });
  });
  for (const [bi, b] of before.blocks.entries()) {
    if (!after.blocks.some((x) => x.name === b.name)) rows.push({ kind: 'gone', what: 'block', name: b.name, label: t('Блок «{block}»', { block: blockLabel(b, bi) }), text: phrase(b.name, t('Блок удалён.')) });
  }

  const was = new Map(before.blocks.flatMap((b) => b.phases.map((p) => [p.name, { p, b: b.name }] as const)));
  const seen = new Set<string>();
  for (const b of after.blocks) {
    for (const p of b.phases) {
      seen.add(p.name);
      const label = p.title || p.name;
      const o = was.get(p.name);
      if (!o) {
        rows.push({ kind: 'new', what: 'phase', name: p.name, label, text: phrase(p.name, t('Новый этап.')) });
        continue;
      }
      const labels = Object.entries(PHASE_FIELDS).filter(([k]) => !same(get(o.p, k), get(p, k))).map(([, l]) => t(l));
      if (o.b !== b.name) labels.push(t('перенесён в другой блок'));
      if (labels.length) rows.push({ kind: 'edit', what: 'phase', name: p.name, label, text: phrase(p.name, fieldsText(labels)) });
    }
  }
  for (const [name, o] of was) if (!seen.has(name)) rows.push({ kind: 'gone', what: 'phase', name, label: o.p.title || name, text: phrase(name, t('Этап удалён.')) });

  const oldArt = before.artifacts ?? {};
  const newArt = after.artifacts ?? {};
  for (const [key, a] of Object.entries(newArt)) {
    const o = oldArt[key];
    const label = t('Файл {file}', { file: artFile(key, a) });
    if (!o) rows.push({ kind: 'new', what: 'artifact', name: key, label, text: phrase(key, t('Новый файл запуска.')) });
    else {
      const labels = ART_FIELDS.filter(([k]) => !same(o[k], a[k])).map(([, l]) => t(l));
      if (labels.length) rows.push({ kind: 'edit', what: 'artifact', name: key, label, text: phrase(key, fieldsText(labels)) });
    }
  }
  for (const [key, o] of Object.entries(oldArt)) {
    if (!(key in newArt)) rows.push({ kind: 'gone', what: 'artifact', name: key, label: t('Файл {file}', { file: artFile(key, o) }), text: phrase(key, t('Файл удалён.')) });
  }
  return rows;
}

/** Имена этапов, блоков и файлов обеих версий: по ним итог ИИ раскладывается на строки. */
function namesOf(...specs: (EditSpec | null)[]): Set<string> {
  const out = new Set<string>();
  for (const s of specs) {
    if (!s) continue;
    for (const b of s.blocks) {
      out.add(b.name);
      for (const p of b.phases) out.add(p.name);
    }
    for (const k of Object.keys(s.artifacts ?? {})) out.add(k);
  }
  return out;
}

/**
 * Ответ помощника целиком. before — что было до правки (null — сломанный flow правили по YAML: строк нет, итог
 * ИИ остаётся текстом). Фразы ИИ про то, чего в разнице нет, не теряются — уходят во вступление пунктами.
 */
export function assistantReply(summary: string, before: EditSpec | null, after: EditSpec): AssistantReply {
  const { intro, items, notes } = parseReply(summary, namesOf(before, after));
  if (!before) return { intro: [intro, ...[...items].map(([k, v]) => `- \`${k}\`: ${v}`)].filter(Boolean).join('\n'), rows: [], notes };
  const rows = changeRows(before, after, items);
  const used = new Set(rows.map((r) => r.name));
  const extra = [...items].filter(([k]) => !used.has(k)).map(([k, v]) => `- \`${k}\`: ${v}`);
  return { intro: [intro, extra.join('\n')].filter(Boolean).join('\n\n'), rows, notes };
}

/** Плашка над схемой: «1 новый этап и 3 изменённых — они выделены зелёным». Этапов нет — «2 изменения». */
export function rowsSummary(rows: ChangeRow[]): string {
  const added = rows.filter((r) => r.what === 'phase' && r.kind === 'new').length;
  const edited = rows.filter((r) => r.what === 'phase' && r.kind === 'edit').length;
  const parts = [
    added ? `${added} ${plural(added, 'новый этап', 'новых этапа', 'новых этапов')}` : '',
    edited ? (added ? `${edited} ${plural(edited, 'изменённый', 'изменённых', 'изменённых')}` : `${edited} ${plural(edited, 'изменённый этап', 'изменённых этапа', 'изменённых этапов')}`) : '',
  ].filter(Boolean);
  if (parts.length) return t('{what} — они выделены зелёным.', { what: parts.join(t(' и ')) });
  return rows.length ? t('{n} {word} — выделены зелёным.', { n: rows.length, word: plural(rows.length, 'изменение', 'изменения', 'изменений') }) : '';
}

/** «Попросить ИИ поправить этап»: начало запроса в поле помощника. */
export const phaseAsk = (num: string, title: string): string => t('Этап {num} «{title}»: ', { num, title });

/**
 * Уточнение из очереди уходит отдельной сессией без памяти: модель получает и прошлый запрос — его результат уже в
 * файле. Текст уходит в модель, поэтому без t().
 */
export const followUp = (prev: string, text: string): string =>
  `Предыдущий запрос (уже выполнен, его результат — в файле flow):\n${prev}\n\nУточнение к нему — что поменять сейчас:\n${text}`;

/** Правка ИИ для цепочки отмен: seq — счётчик правок после неё, undo.seq — до неё, undo.prev — правка ИИ перед ней. */
export type UndoLink<T> = { seq: number; undo: { prev?: T | null; seq?: number } };

/**
 * «Отменить правку»: какая правка ИИ снова последняя. Если руками не правили ни после этой правки, ни между ней и
 * прошлой, прошлая получает текущий счётчик — её отмена не спросит «ты менял схему». Иначе — спросит, как и должна.
 */
export function prevAfterUndo<T extends UndoLink<T>>(cur: T, editSeq: number): T | null {
  const prev = cur.undo.prev ?? null;
  if (prev && editSeq === cur.seq && cur.undo.seq === prev.seq) prev.seq = editSeq;
  return prev;
}
