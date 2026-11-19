// Вкладка «Запуск» экрана flow (docs/flow-redesign/SPEC.md → «Запуск»): слева — форма (карточка задачи и три строки
// настроек) и «Прошлые запуски», справа — «Что произойдёт» по сохранённому flow. Схемы здесь нет: «Открыть схему» ведёт
// на «Правку».
import { useCallback, useMemo } from 'react';
import { useFlowHistory } from '../../api';
import { findPhase, toEditable } from '../../lib/flow/edit';
import { runPlan } from '../../lib/flow/plan';
import { t } from '../../lib/i18n';
import type { RunTabState } from '../home/FlowPicker';
import { afterRender, openPhasePane } from './actions';
import { PastRuns } from './PastRuns';
import { RunForm } from './RunForm';
import { RunPlan } from './RunPlan';
import { flowState, set, useFlowStore } from './store';
import flowStyles from './Flow.module.css';
import styles from './RunTab.module.css';

export function RunTab({ hidden, intake, intakeKey }: { hidden: boolean; intake: RunTabState['intake'] | undefined; intakeKey: string }) {
  const st = useFlowStore();
  const flow = st.flow!;
  const runs = useFlowHistory(flow.name, flow.yaml, !flow.draft).data?.runs;
  const plan = useMemo(() => (flow.spec && flow.summary ? runPlan(toEditable(flow.spec)) : null), [flow.spec, flow.summary]);

  const openScheme = useCallback(() => set({ tab: 'edit', editView: 'scheme' }), []);
  // этап из «Что произойдёт» — на схеме «Правки»: у сохранённого flow и рабочей копии индексы могут разойтись, ищем по имени
  const openStep = useCallback((n: number) => {
    const name = flow.spec ? toEditable(flow.spec).blocks[0]?.phases[n - 1]?.name : undefined;
    openScheme();
    afterRender(() => {
      const at = name && flowState.spec ? findPhase(flowState.spec, name) : null;
      if (at) openPhasePane(at.bi, at.i, flowStyles.flash!);
    });
  }, [flow.spec, openScheme]);

  return (
    <section className={styles.tab} hidden={hidden}>
      {!flow.summary && <p className="error">{t('Flow не проходит валидацию, поправь YAML.')}</p>}
      {/* на узком экране — одной колонкой: форма, «Что произойдёт», прошлые запуски */}
      <div className={styles.grid}>
        <div className={styles.form}>
          <RunForm intake={intake} intakeKey={intakeKey} />
        </div>
        {plan && <RunPlan plan={plan} runs={runs} onScheme={openScheme} onPhase={openStep} />}
        {runs && <PastRuns runs={runs} />}
      </div>
    </section>
  );
}
