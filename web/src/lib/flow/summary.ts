// Сводки flow для экрана: состав в заголовке «Схемы» на вкладке «Запуск» (ui/app.js renderFlow). Без React и DOM.
import type { FlowSummary } from '@server/api-types';
import { plural } from '../format';
import { iterTo } from '../graph/text';
import { t } from '../i18n';

/**
 * Условие блока от сервера (describeCondition в src/flows.ts) — на язык интерфейса: сервер пишет его по-русски и не переводит.
 * Незнакомый текст остаётся как есть.
 */
export function conditionText(s: string): string {
  // у flow из нескольких блоков условия идут через « → » (describeFlowCondition)
  if (s.includes(' → ')) return s.split(' → ').map(conditionText).join(' → ');
  const pause = /, пауза по маркеру (.+)$/.exec(s);
  const base = pause ? s.slice(0, pause.index) : s;
  const tail = pause ? t(', пауза по маркеру {marker}', { marker: pause[1]! }) : '';
  const cmd = /^пока команда `([\s\S]*)` не вернёт 0$/.exec(base);
  if (cmd) return t('пока команда `{run}` не вернёт 0', { run: cmd[1]! }) + tail;
  const marker = /^пока в выводе этапа нет маркера (.+)$/.exec(base);
  if (marker) return t('пока в выводе этапа нет маркера {marker}', { marker: marker[1]! }) + tail;
  return t(base) + tail;
}

/** «3 этапа · до 5 итераций, пока судья не скажет «готово»», «2 блока · 4 этапа» или «3 блока · 2 вызова flow · 1 этап». */
export function schemeSummary(summary: FlowSummary): string {
  const blocks: { looped: boolean; maxIterations: number; condition: string; phases: unknown[]; flow?: string }[] =
    summary.blocks || [{ looped: true, maxIterations: summary.maxIterations ?? 1, condition: summary.condition ?? '', phases: summary.phases ?? [] }];
  const loopText = (b: { looped: boolean; maxIterations: number; condition: string }) => (b.looped ? t('до {n}, {condition}', { n: iterTo(b.maxIterations), condition: conditionText(b.condition).replace(/`/g, '') }) : t('один проход'));
  const phaseCount = blocks.reduce((n, b) => n + b.phases.length, 0);
  const phasesWord = plural(phaseCount, 'этап', 'этапа', 'этапов');
  const calls = blocks.filter((b) => b.flow !== undefined).length;
  const callsText = calls ? `${calls} ${plural(calls, 'вызов', 'вызова', 'вызовов')} flow` : '';
  if (blocks.length === 1) return calls ? `${callsText} ${blocks[0]!.flow} · ${loopText(blocks[0]!)}` : `${phaseCount} ${phasesWord} · ${loopText(blocks[0]!)}`;
  return [`${blocks.length} ${plural(blocks.length, 'блок', 'блока', 'блоков')}`, callsText, phaseCount || !calls ? `${phaseCount} ${phasesWord}` : ''].filter(Boolean).join(' · ');
}

/** Подпись узла вызова на графе: состав вызываемого flow по списку flow; нет в списке — так и сказать. */
export const callSubOf = (flows: FlowSummary[] | undefined) => (name: string): string | undefined => {
  if (!flows) return undefined;
  const f = flows.find((x) => x.name === name);
  if (!f) return t('нет в flows/');
  return f.valid === false ? t('невалиден') : schemeSummary(f);
};
