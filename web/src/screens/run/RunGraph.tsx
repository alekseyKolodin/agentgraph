// Вкладка «Граф» страницы запуска (ui/app.js loadRunGraph, applyRunGraph, inspectNode, renderInspector, followCurrent, runGraphGoto):
// граф по снимку flow.yaml со статусами узлов, строка «Сейчас», «следовать за текущим» и инспектор выбранного узла.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FlowGraph, type GraphHit } from '../../components/graph/FlowGraph';
import { Badge, TagBadge } from '../../components/Badge';
import { openRunFile } from '../../components/file/FileDialog';
import { flowGraphModel, type GraphSpec } from '../../lib/graph/model';
import type { GraphRunState } from '../../lib/graph/run-state';
import { dur, usd } from '../../lib/format';
import { toolsLabel } from '../../lib/flow/tools';
import { linkifyText } from '../../lib/md';
import type { LiveState } from '../../lib/run/events';
import { gotoTarget, inspectView, nodeFromKey, type InspectSel } from '../../lib/run/view';
import { LS } from '../../lib/storage';
import { Feedback } from './Overview';
import { openWin } from './artStore';
import { ArtGraphInfo, artLocked } from './ArtifactsPanel';
import { PhaseTail } from './RunLog';
import { bump, runState, setRunTab } from './store';
import styles from './Run.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
const knowledgeChip = (t: string) => <TagBadge slug={t} kind="knowledge" />;

type Props = {
  st: LiveState;
  spec: GraphSpec & { blocks: NonNullable<GraphSpec['blocks']> };
  rs: GraphRunState;
  /** Колонка артефактов (у запуска они объявлены). */
  artifacts: boolean;
  shown: boolean;
  implicit: readonly string[];
  /** «Открыть flow в конструкторе» или «Сохранить как flow» у разового; null — кнопки нет. */
  flowAction: { label: string; run: () => void } | null;
};

export function inspectNode(sel: InspectSel | null): void {
  runState.inspect = sel;
  bump();
}

/** «Показать в «Обзоре»»: раскрыть блок и итерацию, перейти на «Обзор» без запоминания вкладки и подвести к карточке. */
function goto(st: LiveState, sel: InspectSel, sole: boolean, msg: (t: string) => void) {
  const t = gotoTarget(st, sel, sole);
  if (!t) return;
  if ('start' in t) {
    runState.scrollTo = { step: '#input', block: 'center' };
    setRunTab('overview', false);
    return;
  }
  if ('msg' in t) return msg(t.msg);
  for (const k of t.open) runState.fold.over.set(k, true);
  runState.scrollTo = t.target ? { step: t.target, block: 'center' } : { fold: [`b:${t.bi}`], block: 'center' };
  setRunTab('overview', false);
}

export function RunGraph({ st, spec, rs, artifacts, shown, implicit, flowAction }: Props) {
  const r = st.run;
  const model = useMemo(() => flowGraphModel(spec, { artifacts }), [spec, artifacts]);
  const [msg, setMsg] = useState('');
  const msgTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showMsg = (text: string) => {
    setMsg(text);
    clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(''), 3000);
  };
  useEffect(() => () => clearTimeout(msgTimer.current), []);

  // идущий этап: холст к нему и, если инспектор не занят выбором руками, — в инспектор (только на видимой вкладке)
  useEffect(() => {
    if (!shown || !runState.follow || !rs.current || rs.current === runState.followShown) return;
    runState.followShown = rs.current;
    runState.reveal = { key: rs.current, seq: (runState.reveal?.seq ?? 0) + 1 };
    bump();
    // инспектор — через кадр: холст сперва впишется по полной ширине, как graphAutoFit до followCurrent в старом
    // (перерисовка от bump эффект не отменяет: проверки — внутри, при уходе со страницы runState.st пуст)
    const key = rs.current;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!runState.st || runState.followShown !== key || (runState.inspect && !runState.inspect.auto)) return;
      const node = nodeFromKey(key);
      if (node) inspectNode({ ...node, auto: true });
    }));
  });

  const pick = (n: GraphHit) => {
    // артефакт — окно артефакта; фокус вернётся на узел
    if (n.kind === 'artifact') {
      if (artifacts) void openWin(n.art!, document.activeElement instanceof HTMLElement ? document.activeElement : null);
      return;
    }
    inspectNode({ kind: n.kind, name: n.name, block: n.block, key: n.key });
  };
  const sel = runState.inspect;
  const startChips = [...(r.tags || []).map((t) => <TagBadge key={`t${t}`} slug={t} />), ...(r.knowledge || []).map((t) => <TagBadge key={`k${t}`} slug={t} kind="knowledge" />)];

  return (
    <section
      className={styles.graphBox}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Escape' && runState.inspect) inspectNode(null);
      }}
    >
      <div className={styles.graphBoxHead}>
        {rs.now && <span className={styles.runNow}>{rs.now}</span>}
        <span className="muted small" role="status" aria-live="polite">{msg}</span>
        <span className="row">
          <label className={styles.followCheck} title="Холст сам держит в кадре идущий этап, а инспектор показывает его, пока ты не выбрал другой узел">
            <input
              type="checkbox"
              checked={runState.follow}
              onChange={(e) => {
                runState.follow = e.target.checked;
                LS.set('agentgraph.graphFollow', runState.follow);
                runState.followShown = '';
                bump();
              }}
            />{' '}
            Следовать за текущим
          </label>
          {flowAction && <button type="button" className="btn small ghost" onClick={flowAction.run}>{flowAction.label}</button>}
        </span>
      </div>
      <div className={cx(styles.runGraphSplit, sel && styles.withInsp)}>
        <div className={styles.graphCol}>
          <FlowGraph
            model={model}
            mode="run"
            place="run"
            host="run"
            fill
            refitKey={r.id}
            run={rs}
            chip={knowledgeChip}
            startSub={r.input || ''}
            startChips={startChips.length ? startChips : undefined}
            selectedKey={sel?.key ?? null}
            onNode={pick}
            artInfo={artifacts ? (key) => <ArtGraphInfo artKey={key} r={r} /> : undefined}
            artLocked={artifacts ? artLocked : undefined}
            reveal={runState.reveal}
          />
        </div>
        {sel && <Inspector st={st} sel={sel} spec={spec} implicit={implicit} onGoto={() => goto(st, sel, spec.blocks.length === 1, showMsg)} />}
      </div>
    </section>
  );
}

function Inspector({ st, sel, spec, implicit, onGoto }: { st: LiveState; sel: InspectSel; spec: Props['spec']; implicit: readonly string[]; onGoto: () => void }) {
  const r = st.run;
  const v = inspectView(st, sel, spec.blocks as Parameters<typeof inspectView>[2]);
  const fileBtn = (f: { file: string; title: string; session?: string }) => (
    <button key={f.title} type="button" className="btn small" onClick={() => void openRunFile(r.id, f.file, f.title, f.session || '')}>{f.title.split(' · ')[0]!.toLowerCase()}</button>
  );
  let top;
  let body = null;
  if (v.kind === 'phase') {
    top = (
      <>
        <div className={styles.inspTitle}>{v.title}</div>
        <span className={cx(styles.inspSt, styles[v.status.cls])}>{v.status.text}</span>
        <div className={styles.inspMeta}>{[...v.meta, `[${toolsLabel(v.tools, implicit)}]`].join(' · ')}</div>
      </>
    );
    body = (
      <>
        {v.input && (
          <div className={styles.inspSec}>
            <div className={styles.runLabel}>{v.input.label}</div>
            <div className={styles.inspText} title={v.input.title}>{v.input.text}</div>
          </div>
        )}
        {v.running && (
          <div className={styles.inspSec}>
            <div className={styles.runLabel}>Сейчас</div>
            <PhaseTail phase={sel.name || ''} />
          </div>
        )}
        {v.last && (
          <div className={styles.inspSec}>
            <div className={styles.runLabel}>{`Итерация ${v.last.iteration}`}</div>
            <div className={`${styles.inspText} mono`}>{v.last.text}</div>
            {v.last.errors && <div className="error">{v.last.errors}</div>}
          </div>
        )}
        {v.hist.length > 0 && (
          <div className={styles.inspSec}>
            <div className={styles.runLabel}>Все итерации</div>
            <ul className={styles.inspHist}>
              {v.hist.map((p) => (
                <li key={p.iteration}><span>{p.iteration}</span><span className={p.ok ? 'ok' : 'err'}>{p.ok ? '✓' : '!'}</span><span>{dur(p.durationMs)}</span><span>{usd(p.costUsd)}</span></li>
              ))}
            </ul>
          </div>
        )}
        <div className={styles.inspActions}>{v.files.map(fileBtn)}</div>
      </>
    );
  } else if (v.kind === 'cond') {
    const c = v.c;
    top = (
      <>
        <div className={styles.inspTitle}>Условие</div>
        <span className={cx(styles.inspSt, styles[v.status.cls])}>{v.status.text}</span>
        <div className={styles.inspMeta}>{v.meta}</div>
      </>
    );
    body = c && (
      <>
        {c.detail && <div className={styles.inspSec}><div className={styles.inspText}>{c.detail}</div></div>}
        {c.feedback && (
          <div className={styles.inspSec}>
            <div className={styles.runLabel}>{c.done ? 'Вывод проверки' : 'Замечания для следующей итерации'}</div>
            <div className={styles.inspFeedback}><Feedback c={c} /></div>
          </div>
        )}
        <div className={styles.inspActions}>{c.logFile && fileBtn({ file: c.logFile, title: `Лог · условие, итерация ${c.iteration}` })}</div>
      </>
    );
  } else if (v.kind === 'start') {
    top = <div className={styles.inspTitle}>Задача</div>;
    body = <div className={styles.inspSec}><div className={styles.inspText} dangerouslySetInnerHTML={{ __html: linkifyText(v.input) }} /></div>;
  } else {
    top = (
      <>
        <div className={styles.inspTitle}>{v.title}</div>
        {v.status && <Badge status={v.status} />}
        <div className={styles.inspMeta}>{v.meta}</div>
      </>
    );
  }
  return (
    <aside className={styles.runInspector} aria-label="Выбранный узел">
      <div className={styles.inspHead}>
        <div className={styles.inspWhere}>{v.where}</div>
        <button type="button" className="btn small ghost insp-close" aria-label="Закрыть инспектор" title="Закрыть (Esc)" onClick={() => inspectNode(null)}>×</button>
      </div>
      <div className={styles.inspTop}>{top}</div>
      {body}
      <button type="button" className={cx('link-btn', styles.inspGoto)} onClick={onGoto}>Показать в «Обзоре» →</button>
    </aside>
  );
}
