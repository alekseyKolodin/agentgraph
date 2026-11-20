// Страница источника (/routines/sources/:slug): правки держатся патчем поверх сохранённого spec, а не его копией —
// ответ (config.reply), сохранённый панелью «Как отвечать», или правка из потока `routines` не затираются «Сохранить
// источник». Здесь — наложение патча, что изменилось, на сколько рутин подействует, варианты частоты опроса.
import type { FieldMap, SourceKindView, SourceSpec } from '@server/routines/types';
import { plural, t } from '../i18n';
import { pollsByModel } from './sample';
import { everyMs } from './source';

/**
 * Несохранённые правки источника. config — поля настроек вида (команда, канал, JQL…): '' — убрать поле. map — поля записи
 * своей команды целиком. Ключей тут нет: они сохраняются сразу и отдельно.
 */
export type SourcePatch = { title?: string; every?: string; config?: Record<string, string>; map?: FieldMap };

/** Поля записи без пустых путей; id обязателен (как commandSpec). */
function cleanMap(map: FieldMap): FieldMap {
  const out = Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, (v as string).trim()])) as FieldMap;
  return { ...out, id: out.id || 'id' };
}

/** Патч поверх текущего spec с сервера: остальное (reply, script, tools, secrets) — как сохранено сейчас. */
export function applySourcePatch(spec: SourceSpec, patch: SourcePatch): SourceSpec {
  const config = { ...spec.config };
  for (const [k, v] of Object.entries(patch.config ?? {})) {
    if (v.trim()) config[k] = v.trim();
    else delete config[k];
  }
  return {
    ...spec,
    ...(patch.title !== undefined ? { title: patch.title.trim() || spec.title } : {}),
    ...(patch.every !== undefined ? { every: patch.every } : {}),
    config,
    ...(patch.map ? { map: cleanMap(patch.map) } : {}),
  };
}

/** Что изменилось после наложения патча — словами, в порядке разделов страницы; правки «туда и обратно» не считаются. */
export function sourceChanges(spec: SourceSpec, patch: SourcePatch): string[] {
  const next = applySourcePatch(spec, patch);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return [
    next.title !== spec.title ? t('название') : '',
    !same(next.config, spec.config) ? t('подключение') : '',
    (next.every ?? '') !== (spec.every ?? '') ? t('частота опроса') : '',
    !same(next.map, spec.map) ? t('поля записи') : '',
  ].filter(Boolean);
}

/** Строка у «Сохранить источник»: что изменено и на сколько рутин подействует. Ничего не изменено — ''. */
export function saveImpactText(changes: string[], routines: number): string {
  if (!changes.length) return '';
  const what = changes.join(', ');
  if (!routines) return t('Изменено: {what}. Рутин с этим источником нет.', { what });
  return t('Изменено: {what}. Подействует на {n} {w}.', { what, n: routines, w: plural(routines, 'рутину', 'рутины', 'рутин') });
}

/**
 * Что не даёт сохранить источник: у своей команды пустая команда, у готового вида — пустое обязательное поле настройки
 * (ключи и выбор инструментов MCP не в счёт: они правятся не здесь). Сервер такое примет, а опрос потом сломается.
 */
export function sourceProblems(spec: SourceSpec, kind: Pick<SourceKindView, 'setup'> | undefined): string[] {
  const empty = (v: unknown) => typeof v !== 'string' || !v.trim();
  if (spec.kind === 'command') return empty(spec.config.command) ? [t('Без команды источник не сохранится')] : [];
  if (spec.kind === 'connector') return [];
  const missing = (kind?.setup ?? []).filter((f) => !f.secret && !f.pick && !f.optional && (spec.config[f.key] === undefined || typeof spec.config[f.key] === 'string') && empty(spec.config[f.key]));
  return missing.map((f) => t('Без поля «{field}» источник не сохранится', { field: f.label }));
}

/**
 * Самый частый опрос источника. У «Сервиса через Claude» минимум зависит от источника: скрипт без модели — минута,
 * опрос моделью — 30 минут (как minEveryFor на сервере); у остальных — минимум вида.
 */
export function sourceMinEvery(spec: Pick<SourceSpec, 'kind' | 'config'>, kind: Pick<SourceKindView, 'minEvery'> | undefined): string | undefined {
  if (spec.kind === 'connector') return pollsByModel(spec) ? '30m' : '1m';
  return kind?.minEvery;
}

/** Опрос по умолчанию, если в spec его нет (DEFAULT_EVERY_MS движка). */
export const DEFAULT_EVERY = '5m';

const SEG_STEPS = ['5m', '15m', '30m', '1h', '6h'];

/**
 * Варианты частоты для сегментов страницы источника: 5 мин · 15 мин · 30 мин · 1 час · 6 часов, не чаще минимума.
 * Минимум между шагами (10m) встаёт первым; текущее нестандартное значение — на своё место по порядку.
 */
export function pollSegChoices(minEvery: string | undefined, current: string | undefined): string[] {
  const min = minEvery ? everyMs(minEvery) : 0;
  const list = SEG_STEPS.filter((s) => !(everyMs(s) < min));
  if (minEvery && min > everyMs(SEG_STEPS[0]!) && !list.includes(minEvery)) list.unshift(minEvery);
  if (!list.length) list.push(minEvery ?? DEFAULT_EVERY);
  if (current && !list.includes(current)) list.push(current);
  const ms = (v: string) => (Number.isNaN(everyMs(v)) ? Infinity : everyMs(v));
  return list.sort((a, b) => ms(a) - ms(b));
}

/** Коротко для сегмента: «30 с», «5 мин», «1 час», «6 часов». Не разобрать — как есть. */
export function everyShort(every: string): string {
  const m = /^(\d+)\s*(s|m|h)$/.exec(every.trim());
  if (!m) return every;
  const n = Number(m[1]);
  if (m[2] === 's') return t('{n} с', { n });
  if (m[2] === 'm') return t('{n} мин', { n });
  return `${n} ${plural(n, 'час', 'часа', 'часов')}`;
}
