// Сводки flow для экрана: состав в заголовке «Схемы» на вкладке «Запуск» (ui/app.js renderFlow). Без React и DOM.
import type { FlowSummary } from '@server/api-types';
import { plural } from '../format';
import { iterTo } from '../graph/text';

/** «3 этапа · до 5 итераций, пока судья не скажет «готово»» или «2 блока · 4 этапа». */
export function schemeSummary(summary: FlowSummary): string {
  const blocks = summary.blocks || [{ looped: true, maxIterations: summary.maxIterations ?? 1, condition: summary.condition ?? '', phases: summary.phases ?? [] }];
  const loopText = (b: { looped: boolean; maxIterations: number; condition: string }) => (b.looped ? `до ${iterTo(b.maxIterations)}, ${b.condition.replace(/`/g, '')}` : 'один проход');
  const phaseCount = blocks.reduce((n, b) => n + b.phases.length, 0);
  const phasesWord = plural(phaseCount, 'этап', 'этапа', 'этапов');
  return blocks.length === 1
    ? `${phaseCount} ${phasesWord} · ${loopText(blocks[0]!)}`
    : `${blocks.length} ${plural(blocks.length, 'блок', 'блока', 'блоков')} · ${phaseCount} ${phasesWord}`;
}
