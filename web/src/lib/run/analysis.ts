// Карточка «Анализ flow» на вкладке «Обзор»: подписи вердикта, вида и серьёзности рекомендаций, группировка по серьёзности,
// строки таблицы фактов по этапам, строка «анализ от … · модель · $». Без React и DOM.
import type { AnalysisFacts, AnalysisKind, AnalysisPhase, AnalysisSeverity, AnalysisSuggestion, AnalysisVerdict, RunAnalysis } from '@server/api-types';
import { dur, usd, when } from '../format';
import { ctxBadge, ctxLabel, ctxLevel } from '../graph/text';

/** Вердикт: подпись и класс бейджа (цвета статусов из base.css: зелёный, жёлтый, красный). */
export const VERDICT: Record<AnalysisVerdict, { label: string; cls: string; title: string }> = {
  keep: { label: 'оставить как есть', cls: 'done', title: 'Структура flow оправдана фактами запуска: правок не нужно' },
  improve: { label: 'доработать', cls: 'max_iterations', title: 'Точечные правки: см. рекомендации' },
  rework: { label: 'пересобрать', cls: 'failed', title: 'Структуру flow стоит собрать заново' },
};

export const KIND_LABEL: Record<AnalysisKind, string> = {
  merge: 'объединить',
  split: 'разбить',
  remove: 'убрать',
  tools: 'инструменты',
  condition: 'условие',
  prompt: 'промпт',
  context: 'контекст',
  parallel: 'параллель',
  other: 'прочее',
};

export const SEVERITY_LABEL: Record<AnalysisSeverity, string> = { high: 'Важно', medium: 'Стоит сделать', low: 'Мелочи' };
const SEVERITY_ORDER: AnalysisSeverity[] = ['high', 'medium', 'low'];

export type SuggestionGroup = { severity: AnalysisSeverity; label: string; items: AnalysisSuggestion[] };

/** Рекомендации по серьёзности, high сверху; пустые группы пропущены, порядок внутри группы — как у модели. */
export function groupSuggestions(list: AnalysisSuggestion[]): SuggestionGroup[] {
  return SEVERITY_ORDER.map((severity) => ({ severity, label: SEVERITY_LABEL[severity], items: list.filter((s) => s.severity === severity) })).filter((g) => g.items.length > 0);
}

/** Доля окна: «45%»; неизвестна — «—». */
export const pctLabel = (pct: number | undefined): string => (pct === undefined ? '—' : `${pct}%`);

export type CtxCell = { text: string; title: string; level: '' | 'warn' | 'crit' };

/** Ячейка контекста: максимум пика по запускам как доля окна («45%»), без окна — пик в токенах, без данных — «—». */
export function ctxCell(p: Pick<AnalysisPhase, 'contextPeak' | 'contextWindow' | 'runs'>): CtxCell {
  if (!p.contextPeak) return { text: '—', title: p.runs ? 'SDK не прислал usage' : 'Этап не выполнялся', level: '' };
  const label = ctxLabel(p.contextPeak, p.contextWindow);
  return {
    text: ctxBadge(p.contextPeak, p.contextWindow),
    title: `Пик контекста по запускам этапа: ${label}${p.contextWindow ? '' : ' (окно модели неизвестно)'}`,
    level: ctxLevel(p.contextPeak, p.contextWindow),
  };
}

export type PhaseRow = {
  name: string;
  title: string;
  block: string;
  tools: string;
  writer: boolean;
  runs: string;
  turns: string;
  ctx: CtxCell;
  cost: string;
  time: string;
  /** Что стоит заметить: лимит ходов, отказы инструментов, этап не выполнялся. */
  notes: string[];
};

/** Строки таблицы фактов по этапам в порядке flow. */
export function phaseRows(facts: AnalysisFacts): PhaseRow[] {
  return facts.phases.map((p) => {
    const notes: string[] = [];
    if (!p.runs) notes.push('не выполнялся');
    if (p.maxTurnsHits) notes.push(`упёрся в лимит ходов: ${p.maxTurnsHits}`);
    if (p.denials) notes.push(`отказов инструментов: ${p.denials}`);
    if (p.failed) notes.push(`с ошибкой: ${p.failed}`);
    return {
      name: p.name,
      title: p.title,
      block: p.block,
      tools: p.tools.join(', ') || 'без инструментов',
      writer: p.writer,
      runs: String(p.runs),
      turns: p.runs ? `${p.turnsAvg} / ${p.turnsMax}${p.maxTurns !== undefined ? ` из ${p.maxTurns}` : ''}` : '—',
      ctx: ctxCell(p),
      cost: p.runs ? usd(p.costUsd) : '—',
      time: p.runs ? dur(p.durationMs) : '—',
      notes,
    };
  });
}

/** «анализ от 24.10.2026, 20:59 · claude-sonnet-5-5 · $0.03». */
export const analysisMeta = (a: Pick<RunAnalysis, 'at' | 'model' | 'costUsd'>): string =>
  [`анализ от ${when(a.at)}`, a.model, usd(a.costUsd)].filter(Boolean).join(' · ');
