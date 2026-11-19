// Пример события источника в редакторе рутины (узлы «Условия по полям» и «ИИ рутины»): какие поля добавить в список
// «Поле» условия и какое условие получается по клику на поле примера. Поля события приходят с сервера уже путями
// (src/routines/match.ts → eventFields) — теми же ключами, что пишутся в when.match.
import type { EventField, MatchField, RoutineEvent, SourceEvents, SourceSpec } from '@server/routines/types';
import type { Condition } from './match';

/** Источник «через Claude» без скрипта: каждую проверку делает модель, пробный опрос тратит лимит. */
export const pollsByModel = (spec: Pick<SourceSpec, 'kind' | 'config'>): boolean => spec.kind === 'connector' && !spec.config?.script;

/** Список «Поле» условия: поля вида и общие, потом поля из примера событий — подписью служит сам ключ. */
export function withSampleFields(fields: MatchField[], sample: Pick<SourceEvents, 'events'> | undefined): MatchField[] {
  const out = [...fields];
  for (const e of sample?.events ?? []) for (const f of e.fields) if (!out.some((o) => o.key === f.key)) out.push({ key: f.key, label: f.key, type: f.type });
  return out;
}

/** Общие поля события строками примера: ключи — как в BASE_FIELDS (lib/routines/match.ts). Пустые не показываются. */
export function baseSample(e: Pick<RoutineEvent, 'title' | 'author' | 'text'>): EventField[] {
  const rows: EventField[] = [
    { key: 'title', type: 'text', value: e.title ?? '' },
    { key: 'author', type: 'text', value: e.author ?? '' },
    { key: 'text', type: 'text', value: e.text ?? '' },
  ];
  return rows.filter((r) => r.value.trim());
}

const PICK_MAX = 60;

/**
 * Условие по клику на поле примера. Число и да/нет — «равно» значению. Короткий текст без запятой — «равно» (запятая у
 * «равно» значит «любое из»); длинный, обрезанный или с запятой — «содержит» начало первой строки. Список — «содержит»
 * первый элемент; список объектов (JSON) — «содержит» с пустым значением: что искать, человек допишет сам.
 */
export function pickCondition(f: EventField): Condition {
  if (f.type !== 'text') return { field: f.key, op: 'eq', value: f.value };
  if (f.list) return { field: f.key, op: 'contains', value: f.value.startsWith('[') ? '' : (f.value.split(', ')[0] ?? '').replace(/…$/, '') };
  const line = (f.value.split('\n')[0] ?? '').trim();
  const whole = line === f.value.trim() && !line.endsWith('…');
  if (whole && line.length <= PICK_MAX && !line.includes(',')) return { field: f.key, op: 'eq', value: line };
  const head = line.replace(/…$/, '').slice(0, PICK_MAX);
  // режем по слову: обрубок слова в «содержит» не совпал бы с другими событиями
  const cut = head.length < line.replace(/…$/, '').length && head.includes(' ') ? head.slice(0, head.lastIndexOf(' ')) : head;
  return { field: f.key, op: 'contains', value: cut.trim() };
}
