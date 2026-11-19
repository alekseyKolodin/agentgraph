// Вкладка «Запуск» экрана flow: форма запуска и схема по сохранённому flow. Вынесена из FlowScreen.tsx, чтобы её
// можно было переделывать отдельно от оболочки экрана (вкладки, шапка).
import { useCallback, useMemo, useState } from 'react';
import { useFeature, useFlows } from '../../api';
import { FlowGraph, type GraphHit } from '../../components/graph/FlowGraph';
import { ICON } from '../../components/shell/FlowList';
import { findPhase, toEditable } from '../../lib/flow/edit';
import { callSubOf, schemeSummary } from '../../lib/flow/summary';
import { flowGraphModel } from '../../lib/graph/model';
import { t } from '../../lib/i18n';
import { LS } from '../../lib/storage';
import type { RunTabState } from '../home/FlowPicker';
import { afterRender, openPhasePane } from './actions';
import { KnowledgeBadge } from './BlockEditor';
import { graphPick } from './Builder';
import { flowState, set, useFlowStore } from './store';
import { RunForm } from './RunForm';
import styles from './Flow.module.css';

const knowledgeChip = (t: string) => <KnowledgeBadge slug={t} />;

/**
 * Вкладка «Запуск»: форма запуска (вход из «Запустить…» с главной — location.state.intake) и «Схема» — граф по сохранённому
 * flow (не по рабочей копии конструктора).
 */
export function RunTab({ hidden, intake, intakeKey }: { hidden: boolean; intake: RunTabState['intake'] | undefined; intakeKey: string }) {
  const st = useFlowStore();
  const flow = st.flow!;
  const artifacts = useFeature('artifacts');
  const [open, setOpen] = useState(() => LS.get('agentgraph.graphOpen.flowTab', true));
  const flows = useFlows().data;
  const model = useMemo(() => (flow.spec ? flowGraphModel(toEditable(flow.spec), { artifacts, callSub: callSubOf(flows) }) : null), [flow.spec, artifacts, flows]);

  // клик по узлу: конструктор на этом этапе. Индексы у сохранённого flow и конструктора могут разойтись — этап ищем по имени
  const openBuilderAt = useCallback((n: GraphHit) => {
    if (!flowState.spec) return;
    set({ tab: 'edit', editView: 'scheme' });
    afterRender(() => {
      if (n.kind === 'phase') {
        const at = findPhase(flowState.spec!, n.name!);
        if (at) openPhasePane(at.bi, at.i, styles.flash!);
      } else graphPick(n);
    });
  }, []);

  return (
    <section className={styles.tabRun} hidden={hidden}>
      <div className={styles.flowPlan}>{!flow.summary && <p className="error">{t('Flow не проходит валидацию, поправь YAML.')}</p>}</div>
      {/* задача и проект — сверху, редкое — в «Дополнительно» (открытость запоминается), «Запустить» — в липкой панели */}
      <RunForm intake={intake} intakeKey={intakeKey} />
      {/* одна раскрывашка: в заголовке — состав flow, внутри — граф. Открытость запоминается */}
      {model && flow.summary && (
        <details
          className={styles.flowScheme}
          open={open}
          onToggle={(e) => {
            const v = e.currentTarget.open;
            setOpen(v);
            LS.set('agentgraph.graphOpen.flowTab', v);
          }}
        >
          <summary>
            <span className="caret">{ICON.caret}</span>
            <span className={styles.flowSchemeTitle}>{t('Схема')}</span>
            <span className={styles.flowSchemeSum}>{schemeSummary(flow.summary)}</span>
          </summary>
          {open && (
            <div className={styles.schemeGraph}>
              <FlowGraph model={model} mode="view" place="flow" host="flow" refitKey={`${flow.name}:${st.refit}`} chip={knowledgeChip} onNode={openBuilderAt} />
            </div>
          )}
        </details>
      )}
    </section>
  );
}

