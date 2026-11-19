// «Правка» → «Схема» (ui/app.js renderBuilder, renderGraph, graphPick, graphAdd): граф — главный холст слева, под ним тихие
// «Добавить этап» и «Настройки flow». Клик по узлу открывает его поля в правой панели (EditSide.tsx), правка с ИИ —
// там же, в помощнике (Assistant.tsx); «Сохранить» — в плашке над схемой (UnsavedBar.tsx).
import { useCallback, useDeferredValue, useMemo } from 'react';
import { useConfig, useFeature, useFlows } from '../../api';
import { FlowGraph, type GraphHit } from '../../components/graph/FlowGraph';
import { stepsTouched } from '../../lib/flow/ai-progress';
import { addPhaseAfter, isCall, newPhase, phaseInputs, type EditSpec } from '../../lib/flow/edit';
import { callSubOf } from '../../lib/flow/summary';
import { toolsLabel } from '../../lib/flow/tools';
import { flowGraphModel, type GraphNode } from '../../lib/graph/model';
import { t } from '../../lib/i18n';
import { openBlockPane, openFlowSettings, openPhasePane } from './actions';
import { KnowledgeBadge } from './BlockEditor';
import { flowState, markDirty, selBlockAt, selPhaseAt, useAiSteps, useFlowStore, type Selection } from './store';
import styles from './Flow.module.css';

const knowledgeChip = (t: string) => <KnowledgeBadge slug={t} />;
/** Граф конструктора вписывается не мельче: названия узлов при 85% — 11 px, подписи — 9,4 px; шире — прокрутка холста. */
const FIT_MIN = 0.85;

/**
 * Выбранное в правой панели — ключ на графе, вокруг которого он вписывается: этап, блок, задача flow. У блока с
 * циклом — его ромб: панель правит условие, и широкий блок, который целиком не влез, показан хотя бы до ромба.
 */
function graphFocus(spec: EditSpec, sel: Selection): string | null {
  const at = selPhaseAt(spec, sel);
  if (at) return `p:${spec.blocks[at.b]!.name}:${spec.blocks[at.b]!.phases[at.i]!.name}`;
  const block = spec.blocks[selBlockAt(spec, sel)];
  if (block) return `${block.loop ? 'c' : 'b'}:${block.name}`;
  return sel?.kind === 'field' && sel.field.scope === 'flow' && sel.field.key === 'input' ? 'start' : null;
}

export function Builder({ hidden }: { hidden: boolean }) {
  const st = useFlowStore();
  const spec = st.spec;
  const config = useConfig().data!;
  const artifacts = useFeature('artifacts');
  // рабочая копия правится на месте: модель — заново на каждую правку, но с низким приоритетом (как задержка 250 мс в старом),
  // чтобы ввод в промпт не ждал раскладки графа
  const editSeq = useDeferredValue(st.editSeq);
  // узел вызова подписан составом вызываемого flow — из списка flow
  const flows = useFlows().data;
  const graphModel = useMemo(
    () => (spec ? flowGraphModel(spec, { inputsOf: (bi, i) => phaseInputs(spec, bi, i), artifacts, callSub: callSubOf(flows) }) : null),
    [spec, artifacts, editSeq, flows],
  );
  const toolsOf = useCallback((n: GraphNode) => toolsLabel(flowState.spec?.blocks[n.b!]?.phases[n.i!]?.tools, config.implicitTools), [config.implicitTools]);
  // пока ИИ правит — этапы загораются по мере правки; потом — что поменяла правка целиком
  const steps = useAiSteps();
  const touched = useMemo(() => stepsTouched(steps), [steps]);
  const running = Boolean(st.aiProgress);

  const pick = useCallback((n: GraphHit) => graphPick(n), []);
  const add = useCallback((n: GraphHit) => {
    const s = flowState.spec;
    if (!s || n.b === undefined || n.i === undefined) return;
    const at = addPhaseAfter(s, n.b, n.i, n.kind === 'group' ? n.group : undefined);
    flowState.graphSel = s.blocks[n.b]!.phases[at]!.name;
    markDirty();
    openPhasePane(n.b, at, styles.flash!);
  }, []);

  if (!st.flow) return null;
  const selBlock = spec ? selBlockAt(spec, st.sel) : -1;
  // панель сменила содержимое — граф вписывается заново вокруг выбранного
  const autoFit = { min: FIT_MIN, focus: spec ? graphFocus(spec, st.sel) : null };

  return (
    <div className={styles.tabBuilder} hidden={hidden} data-edit-graph>
      {spec && graphModel ? (
        <FlowGraph
          model={graphModel}
          mode="edit"
          place="builder"
          host="builder"
          refitKey={st.refit}
          selectedName={st.graphSel}
          selectedBlock={selBlock}
          changed={running ? touched.phases : st.ai?.diff.phases}
          changedBlocks={running ? touched.blocks : st.ai?.diff.blocks}
          chip={knowledgeChip}
          toolsOf={toolsOf}
          onNode={pick}
          onAdd={add}
          autoFit={autoFit}
        />
      ) : (
        <p className="error">{t('Flow не проходит валидацию: поправь его во вкладке YAML или опиши помощнику справа, что починить.')}</p>
      )}
      {spec && (
        <div className={styles.underGraph}>
          <span className="muted small">{t('Клик по этапу открывает его поля справа.')}</span>
          <span className={styles.grow} />
          <button type="button" className="btn ghost small" title={t('Новый этап в конце выбранного блока')} onClick={() => addPhase(spec)}>{t('Добавить этап')}</button>
          <button type="button" className="btn ghost small" title={t('Описание, задача по умолчанию, файлы, блоки')} onClick={() => openFlowSettings()}>{t('Настройки flow')}</button>
        </div>
      )}
    </div>
  );
}

/** «Добавить этап» под схемой: в конец выбранного блока (или блока выбранного этапа), иначе — последнего блока с этапами. */
function addPhase(spec: EditSpec) {
  const sel = flowState.sel;
  const at = selPhaseAt(spec, sel);
  let bi = at ? at.b : selBlockAt(spec, sel);
  if (bi < 0 && flowState.graphSel) bi = spec.blocks.findIndex((b) => b.phases.some((p) => p.name === flowState.graphSel));
  if (bi < 0 || isCall(spec.blocks[bi]!)) bi = spec.blocks.findLastIndex((b) => !isCall(b));
  if (bi < 0) return openFlowSettings();
  const block = spec.blocks[bi]!;
  block.phases.push(newPhase(spec, bi));
  markDirty();
  openPhasePane(bi, block.phases.length - 1, styles.flash!);
}

/** Клик по узлу схемы: этап — его поля справа, блок или условие — цикл блока там же, «Задача» и файлы — «Настройки flow». */
export function graphPick(n: GraphHit) {
  const spec = flowState.spec;
  if (!spec) return;
  if (n.kind === 'phase') openPhasePane(n.b!, n.i!, styles.flash!);
  else if (n.kind === 'block' || n.kind === 'cond' || n.kind === 'call') openBlockPane(n.b!);
  else if (n.kind === 'start') openFlowSettings('input');
  else if (n.kind === 'artifact') openFlowSettings('artifacts');
}
