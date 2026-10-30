// Вкладка «Обзор» страницы запуска (ui/app.js renderRunFinal, renderRunSummary, renderRunRibbons, renderRun — «Этапы по итерациям»):
// итог завершённого запуска, сводка идущего, лента итераций, хвост живого лога, карточки этапов по итерациям, задача.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ConditionReport, PhaseReport, RunNote, RunReport } from '@server/api-types';
import { fetchRunFile, setMaxIterations, errorText } from '../../api';
import { Badge, TagBadge } from '../../components/Badge';
import { useConfirm } from '../../components/ConfirmDialog';
import { openRunFile, openTagSummary } from '../../components/file/FileDialog';
import { SafeMarkdown } from '../../components/MdText';
import { PathText } from '../../components/PathLink';
import { AnsweredCard } from '../../components/question/QuestionCard';
import { ICON } from '../../components/shell/FlowList';
import { dur, usd } from '../../lib/format';
import { toolsLabel } from '../../lib/flow/tools';
import { t } from '../../lib/i18n';
import { linkifyText } from '../../lib/md';
import type { LiveState, PendingPhase } from '../../lib/run/events';
import { runnerText } from '../../lib/run/runner-text';
import {
  blockNextNote, COND_STEP, ctxChipInfo, feedbackIsMarkdown, phaseSpent, spentChipInfo, fileIsMarkdown, finalFacts, finalFeedback, isRestart, LIMIT_MAX, limitEditable, limitMin, phaseModelChip, ribbonRows,
  runBlocks, runFinished, runPause, runSteps, stepKey, stepNotes, summaryView, tagFinalLines, type ChainStep, type Part, type RunBlockView, type SpecBlocks, type StepItem,
} from '../../lib/run/view';
import { Analysis } from './Analysis';
import { art } from './artStore';
import { ArtFinalLine, ArtIterMark, ArtStepLine } from './ArtifactsPanel';
import { NoteBox, StepNotes } from './FixPanel';
import { RunTail } from './RunLog';
import { bump, runState, setRunTab } from './store';
import styles from './Run.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

type Props = { st: LiveState; spec: SpecBlocks; graphNow: string; implicit: readonly string[] };

export function Overview({ st, spec, graphNow, implicit }: Props) {
  const r = st.run;
  const { items, keys, unfold } = runSteps(st, runState.fold);
  // поле указания — на первой идущей карточке (этап или проверка условия): указание получит следующий шаг
  const noteAt = r.live && runPause(r) !== 'paused' ? items.find((it) => it.kind === 'running') ?? items.find((it) => it.kind === 'condPending') : undefined;
  const foldAll = (open: boolean) => {
    for (const k of keys) runState.fold.over.set(k, open);
    bump();
  };
  return (
    <>
      {runFinished(r) && <RunFinal r={r} />}
      {r.live && <Summary st={st} spec={spec} graphNow={graphNow} />}
      {runFinished(r) && <Analysis runId={r.id} />}
      <Ribbons st={st} spec={spec} />
      {r.live && (
        <section className={styles.runTailBox}>
          <div className={styles.runSecHead}>
            <span className={styles.runLabel}>{t('Живой лог · последние строки')}</span>
            <button type="button" className="link-btn" onClick={() => setRunTab('log')}>{t('весь лог →')}</button>
          </div>
          <RunTail />
        </section>
      )}
      <div className={cx(styles.runSecHead, styles.runStepsHead)}>
        <span className={styles.runLabel}>{t('Этапы по итерациям')}</span>
        {keys.length >= 2 && (
          <div className={cx('row', styles.runFoldCtl)}>
            <button type="button" className="btn small ghost" onClick={() => foldAll(unfold)}>{unfold ? t('Развернуть все') : t('Свернуть все')}</button>
          </div>
        )}
      </div>
      <div className={styles.phases}>
        {items.map((it, i) => <Step key={stepId(it, i)} item={it} st={st} implicit={implicit} noteBox={it === noteAt} />)}
      </div>
      <div className={styles.runSecHead}><span className={styles.runLabel}>{t('Задача')}</span></div>
      {r.input && <p className={styles.runInput} dangerouslySetInnerHTML={{ __html: linkifyText(r.input) }} />}
    </>
  );
}

const stepId = (it: StepItem, i: number): string => {
  switch (it.kind) {
    case 'phase': return `p|${stepKey(it.p.block, it.p.iteration, it.p.phase)}`;
    case 'running': return `r|${stepKey(it.x.block, it.x.iteration, it.x.phase)}`;
    case 'cond': return `c|${stepKey(it.c.block, it.c.iteration, '#cond')}`;
    case 'condPending': return `cp|${stepKey(it.c.block, it.c.iteration, '#cond')}`;
    case 'answered': return `q|${it.q.id}`;
    case 'iter': return `i|${it.foldKey}`;
    case 'block': return `b|${it.bi}`;
    default: return `${it.kind}|${i}`;
  }
};

// ---------- свёртки

export function FoldButton({ foldKey, open, children }: { foldKey: string; open: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className="fold-head"
      data-fold={foldKey}
      aria-expanded={open}
      title={open ? t('Свернуть') : t('Развернуть')}
      onClick={() => {
        runState.fold.over.set(foldKey, !open);
        bump();
      }}
    >
      <span className="caret">{ICON.caret}</span>{children}
    </button>
  );
}

/** Лимит блока; у живого запуска — с кнопками −/+. */
export function LimitCtl({ block }: { block: RunBlockView }) {
  const r = runState.st!.run;
  const { notify } = useConfirm();
  if (!limitEditable(r, block)) return <>{String(block.maxIterations)}</>;
  const n = block.maxIterations;
  const min = limitMin(block);
  const change = async (value: number) => {
    if (!runState.st?.run.live) return;
    try {
      await setMaxIterations(r.id, block.name!, value);
    } catch (err) {
      await notify(errorText(err));
    }
  };
  const btn = (value: number, label: string, title: string) => (
    <button type="button" className="btn ghost small" title={title} disabled={value < min || value > LIMIT_MAX} onClick={() => void change(value)}>{label}</button>
  );
  return <span className={styles.limitCtl}>{btn(n - 1, '−', t('Меньше итераций'))}<b>{n}</b>{btn(n + 1, '+', t('Больше итераций'))}</span>;
}

// «этапов 3 · <span class="warn">с ошибкой 1</span> · 7с»: соседний текст склеен в один узел, как в старом
function parts(list: Part[]): ReactNode[] {
  const out: ReactNode[] = [];
  let text = '';
  list.forEach((p, i) => {
    if (i > 0) text += ' · ';
    if (!p.cls) text += p.text;
    else {
      if (text) out.push(text);
      out.push(<span key={i} className={p.cls}>{p.text}</span>);
      text = '';
    }
  });
  if (text) out.push(text);
  return out;
}

// ---------- карточки шагов

function Step({ item, st, implicit, noteBox }: { item: StepItem; st: LiveState; implicit: readonly string[]; noteBox: boolean }) {
  const r = st.run;
  switch (item.kind) {
    case 'block': {
      const b = item.block;
      const how = b.bypassed ? t('не выбран развилкой') : b.skipped ? t('пропущен (уже пройден)') : b.looped ? null : t('один проход');
      const next = blockNextNote(b, runBlocks(r));
      return (
        <div className={styles.blockHead}>
          {item.foldKey ? <FoldButton foldKey={item.foldKey} open={item.open}>{item.label}</FoldButton> : <span>{item.label}</span>}
          {!b.bypassed && <Badge status={b.status} />}
          <span className="muted">
            {how !== null
              ? `${how}${item.cost ? ` · ${usd(item.cost)}` : ''}`
              : limitEditable(r, b)
                ? <>{`${t('итераций {n}', { n: b.iterations || 0 })}/`}<LimitCtl block={b} />{item.cost ? ` · ${usd(item.cost)}` : ''}</>
                : `${t('итераций {i}/{n}', { i: b.iterations || 0, n: b.maxIterations })}${item.cost ? ` · ${usd(item.cost)}` : ''}`}
            {next && ` · ${next}`}
          </span>
        </div>
      );
    }
    case 'onfail':
      return <div className="muted small">{t('Условие не выполнено, но у блока on_fail: continue — запуск пошёл дальше.')}</div>;
    case 'older':
      return (
        <button
          type="button"
          className={cx('btn small ghost', styles.runOlder)}
          onClick={() => {
            runState.fold.older.add(item.bi);
            bump();
          }}
        >
          {t('Показать ранние итерации · 1–{to}', { to: item.to })}
        </button>
      );
    case 'iter':
      return (
        <div className={styles.iterHead}>
          <FoldButton foldKey={item.foldKey} open={item.open}>{t('Итерация {it}', { it: item.it })}</FoldButton>
          <span className={styles.iterSum}>{parts(item.sum)}</span>
          {art.on && <ArtIterMark block={item.block} it={item.it} />}
        </div>
      );
    case 'phase':
      return <PhaseCard p={item.p} runId={r.id} implicit={implicit} notes={stepNotes(r, item.p.block, item.p.iteration, item.p.phase)} />;
    case 'running':
      return (
        <RunningCard x={item.x} maxDone={Math.max(0, ...r.phases.map((p) => phaseSpent(p.tokens)))} doing={item.doing} runId={r.id} implicit={implicit} notes={stepNotes(r, item.x.block, item.x.iteration, item.x.phase)}>
          {noteBox && <NoteBox r={r} placeholder={t('Указание следующему шагу: что поправить или учесть — этот этап уже идёт')} />}
        </RunningCard>
      );
    case 'answered':
      return <AnsweredCard q={item.q} />;
    case 'cond':
      return <CondCard c={item.c} runId={r.id} notes={stepNotes(r, item.c.block, item.c.iteration, COND_STEP)} />;
    case 'condPending': {
      const c = item.c;
      return (
        <div className={cx(styles.card, styles.cond, styles.pending)} data-step={stepKey(c.block, c.iteration, '#cond')}>
          <div className={styles.head}>
            <span className={styles.status}>⏳</span>
            <span className={styles.title}>{t('Условие ({kind})', { kind: c.kind })}</span>
            <span className={styles.stats}>{c.detail}</span>
            {c.file && <button className="btn small" onClick={() => void openRunFile(r.id, c.file!, t('Промпт судьи · итерация {it}', { it: c.iteration }))}>{t('промпт судьи')}</button>}
          </div>
          <StepNotes notes={stepNotes(r, c.block, c.iteration, COND_STEP)} />
          {noteBox && <NoteBox r={r} placeholder={t('Указание следующему шагу: что поправить или учесть — проверка уже идёт')} />}
        </div>
      );
    }
  }
}

const GroupTag = ({ group }: { group?: string }) =>
  group ? <span className={styles.pgroup} title={t('Параллельная группа: этапы шли одновременно')}>{`∥ ${group}`}</span> : null;

function ModelChip({ x }: { x: { model?: string; effort?: string } }) {
  const m = phaseModelChip(x);
  return m ? <span className={styles.pmodel} title={m.title}>{m.label}</span> : null;
}

function CtxChip({ x, live }: { x: Parameters<typeof ctxChipInfo>[0]; live: boolean }) {
  const info = ctxChipInfo(x, live);
  return info ? <span className={cx(styles.pctx, info.level && styles[info.level])} title={info.title}>{info.text}</span> : null;
}

function SpentChip({ x, live, maxDone }: { x: Parameters<typeof spentChipInfo>[0]; live: boolean; maxDone?: number }) {
  const info = spentChipInfo(x, live, maxDone);
  return info ? <span className={cx(styles.pctx, info.level && styles[info.level])} title={info.title}>{info.text}</span> : null;
}

function PhaseCard({ p, runId, implicit, notes }: { p: PhaseReport; runId: string; implicit: readonly string[]; notes: RunNote[] }) {
  const files = p.files || {};
  return (
    <div className={cx(styles.card, p.group && styles.grouped)} data-step={stepKey(p.block, p.iteration, p.phase)}>
      <div className={styles.head}>
        <span className={styles.status}>{p.ok ? <span className="ok">✓</span> : <span className="warn">!</span>}</span>
        <span className={styles.title}>{p.title || p.phase}</span>
        <GroupTag group={p.group} />
        <span className={styles.tools}>{p.call ? <CallLink call={p.call} /> : `[${toolsLabel(p.tools, implicit)}]`}</span>
        <ModelChip x={p} />
        <CtxChip x={p} live={false} />
        <SpentChip x={p} live={false} />
        <span className={styles.stats} title={t('{n} знаков в ответе', { n: p.chars })}>{`${p.call ? '' : `${t('{n} ходов', { n: p.turns })} · `}${dur(p.durationMs)} · ${usd(p.costUsd)}${p.ok ? '' : ` · ${p.subtype}`}`}</span>
      </div>
      {p.errors?.length > 0 && <div className="error">{p.errors.join('\n')}</div>}
      <StepNotes notes={notes} />
      {art.on && <ArtStepLine rep={p} phase={p.phase} />}
      {Object.keys(files).length > 0 && (
        <div className={styles.actions}>
          <button className="btn small" onClick={() => void openRunFile(runId, files.prompt, t('Промпт · {name}', { name: p.phase }))}>{t('промпт')}</button>
          <button className="btn small" onClick={() => void openRunFile(runId, files.transcript, t('Транскрипт · {name}', { name: p.phase }), p.sessionId || '')}>{t('транскрипт')}</button>
          <button className="btn small" onClick={() => void openRunFile(runId, files.output, t('Вывод · {name}', { name: p.phase }))}>{t('вывод')}</button>
        </div>
      )}
    </div>
  );
}

/** Шаг блока-вызова: ссылка на его дочерний запуск вместо инструментов. */
const CallLink = ({ call }: { call: { runId: string; flow: string } }) => (
  <Link to={`/run/${call.runId}`} title={t('Открыть вызванный запуск {id}', { id: call.runId })}>{t('↪ запуск flow {flow}', { flow: call.flow })}</Link>
);

function RunningCard({ x, maxDone, doing, runId, implicit, notes, children }: { x: PendingPhase; maxDone: number; doing: string; runId: string; implicit: readonly string[]; notes: RunNote[]; children?: ReactNode }) {
  // промпт записан до старта этапа, транскрипт пишется по ходу; вывода до phase_end ещё нет. У старых запусков files нет.
  const pf = x.files;
  return (
    <div className={cx(styles.card, styles.pending, x.group && styles.grouped)} data-step={stepKey(x.block, x.iteration, x.phase)}>
      <div className={styles.head}>
        <span className={styles.status}>⏳</span>
        <span className={styles.title}>{x.title}</span>
        <GroupTag group={x.group} />
        <span className={styles.tools}>{x.call ? <CallLink call={x.call} /> : `[${toolsLabel(x.tools, implicit)}]`}</span>
        <ModelChip x={x} />
        <CtxChip x={x} live />
        <SpentChip x={x} live maxDone={maxDone} />
        <span className={styles.stats}>{doing}</span>
      </div>
      <StepNotes notes={notes} />
      {pf && (
        <div className={styles.actions}>
          <button className="btn small" onClick={() => void openRunFile(runId, pf.prompt, t('Промпт · {name}', { name: x.phase }))}>{t('промпт')}</button>
          <button className="btn small" onClick={() => void openRunFile(runId, pf.transcript, t('Транскрипт · {name} (на момент открытия)', { name: x.phase }))}>{t('транскрипт')}</button>
        </div>
      )}
      {children}
    </div>
  );
}

/** Замечания судьи — markdown; у команды — хвост её вывода моноширинно. */
export const Feedback = ({ c }: { c: ConditionReport }) => (feedbackIsMarkdown(c) ? <SafeMarkdown text={runnerText(c.feedback, c.type)} /> : <pre><PathText text={runnerText(c.feedback, c.type)} /></pre>);

function CondCard({ c, runId, notes }: { c: ConditionReport; runId: string; notes: RunNote[] }) {
  const none = c.type === 'none';
  // итерацию оборвал повтор (FixPanel): проверки не было, в замечаниях — то, что получит следующая
  const restart = isRestart(c);
  const label = { command: t('команда'), judge: t('судья'), marker: t('маркер'), none: t('без условия') }[c.type] || c.type;
  const foldKey = `f:${c.block ?? ''}:${c.iteration}`;
  return (
    <div className={cx(styles.card, styles.cond)} data-step={stepKey(c.block, c.iteration, '#cond')}>
      <div className={styles.head}>
        <span className={styles.status}>{restart ? <span className="warn">↺</span> : none ? <span className="muted">•</span> : c.done ? <span className="ok">✔</span> : <span className="warn">↻</span>}</span>
        <span className={styles.title}>{restart ? t('Итерация перезапущена') : none ? t('Итерация завершена') : c.done ? t('Условие выполнено') : t('Условие не выполнено')}</span>
        {!restart && <span className={styles.tools}>{`[${label}]`}</span>}
        <span className={styles.stats}>{`${runnerText(c.detail, c.type)}${c.costUsd ? ` · ${usd(c.costUsd)}` : ''}`}</span>
        {c.logFile && <button className="btn small" onClick={() => void openRunFile(runId, c.logFile!, t('Условие · итерация {it}', { it: c.iteration }))}>{t('лог')}</button>}
      </div>
      {c.summary && <div className={styles.condSum}>{c.summary}</div>}
      <StepNotes notes={notes} />
      {art.on && <ArtStepLine rep={c} phase={null} />}
      {c.feedback && (
        // <details> пересоздаётся вместе с карточкой: раскрыт ли он, помним на запуск
        <details
          open={runState.fold.over.get(foldKey) ?? false}
          onToggle={(e) => {
            runState.fold.over.set(foldKey, e.currentTarget.open);
          }}
        >
          <summary>{t('Замечания для следующей итерации')}</summary>
          <Feedback c={c} />
        </details>
      )}
    </div>
  );
}

// ---------- «Итог»

// выводы последнего шага: файл читаем один раз на запуск и путь
const finalOutputs = new Map<string, { text: string; md: boolean } | null>();

function useFinalOutput(runId: string, file: string): { text: string; md: boolean } | null {
  const key = `${runId}\n${file}`;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (finalOutputs.has(key)) return;
    finalOutputs.set(key, null);
    fetchRunFile(runId, file)
      .then((res) => finalOutputs.set(key, { text: res.text, md: res.ok && fileIsMarkdown(file, res.text) }))
      .catch((err) => finalOutputs.set(key, { text: errorText(err), md: false }))
      .finally(() => setTick((n) => n + 1));
  }, [key, runId, file]);
  return finalOutputs.get(key) ?? null;
}

function FinalOut({ runId, f, multi }: { runId: string; f: NonNullable<RunReport['final']>[number]; multi: boolean }) {
  const loaded = useFinalOutput(runId, f.output || '');
  const shown = f.output ? loaded : { text: t('Вывода нет'), md: false };
  const where = [multi ? f.block : '', t('итерация {it}', { it: f.iteration })].filter(Boolean).join(' · ');
  return (
    <div className={styles.finalOut}>
      <div className={styles.head}>
        <span className={styles.status}>{f.ok ? <span className="ok">✓</span> : <span className="warn">!</span>}</span>
        <span className={styles.title}>{f.title || f.phase}</span>
        <span className={styles.stats}>{where}</span>
        {f.output && <button className="btn small" onClick={() => void openRunFile(runId, f.output, t('Вывод · {name}', { name: f.phase }))}>{t('вывод')}</button>}
      </div>
      <div className={styles.finalBody}>
        {!shown ? <div className="muted small">{t('Загружаю…')}</div> : shown.md ? <SafeMarkdown text={shown.text} /> : <pre><PathText text={shown.text} /></pre>}
      </div>
    </div>
  );
}

function RunFinal({ r }: { r: RunReport }) {
  const blocks = r.blocks ?? [];
  const multi = blocks.length > 1;
  const facts = finalFacts(r);
  const fb = finalFeedback(r);
  const tags = r.tags?.length || r.autoTag?.error ? tagFinalLines(r) : null;
  const final = r.final ?? [];
  return (
    <div>
      <div className={cx(styles.card, styles.runFinal)}>
        <div className={styles.head}>
          <span className={styles.title}>{t('Итог')}</span>
          <Badge status={r.status} />
          <span className={styles.stats}>{facts.map((x, i) => <Fragment key={i}>{i > 0 && <span>·</span>}<span>{x}</span></Fragment>)}</span>
        </div>
        {r.digest?.text && <div className={styles.sumDigest}>{r.digest.text}</div>}
        {multi && (
          <div className={styles.finalBlocks}>
            {blocks.map((b, i) => <span key={i}>{`${b.title || b.name} `}{b.bypassed ? <span className="muted">{t('не выбран')}</span> : <Badge status={b.status} />}</span>)}
          </div>
        )}
        {r.error && <div className="error">{r.error}</div>}
        {art.on && r.artifacts && <ArtFinalLine />}
        {tags?.autoTagError && <div className={styles.tagLine}><span className="warn">{t('Тег не заведён: {why}', { why: tags.autoTagError })}</span></div>}
        {tags?.lines.map((l) => (
          <div key={l.tag} className={styles.tagLine}>
            <Link to={`/tags/${l.tag}`}><TagBadge slug={l.tag} /></Link>
            {l.auto && <span className="muted small">{t('заведён автоматически')}</span>}
            {l.state === 'ok' ? (
              <>
                <span className="ok">{l.text}</span>
                <span className="muted">{`≈${usd(l.costUsd)}`}</span>
                <button className="btn small" onClick={() => void openTagSummary(l.tag)}>{t('саммари')}</button>
              </>
            ) : <span className={l.state === 'error' ? 'warn' : 'muted'}>{l.text}</span>}
          </div>
        ))}
        {fb && (
          <details>
            <summary>{`${t('Замечания последнего условия')}${multi ? ` · ${fb.block}` : ''} · ${t('итерация {it}', { it: fb.iteration })}${fb.summary ? `: ${fb.summary}` : ''}`}</summary>
            <Feedback c={fb} />
          </details>
        )}
        {final.length
          ? final.map((f, i) => <FinalOut key={i} runId={r.id} f={f} multi={multi} />)
          : <div className="muted small">{t('Этапы не выполнялись: выводить нечего.')}</div>}
      </div>
    </div>
  );
}

// ---------- сводка и лента

function Summary({ st, spec, graphNow }: { st: LiveState; spec: SpecBlocks; graphNow: string }) {
  const v = summaryView(st, graphNow, spec);
  return (
    <section className={styles.runSummary}>
      <div className={styles.runSecHead}><span className={styles.runLabel}>{t('Сводка')}</span><span className={styles.sumFacts}>{v.facts}</span></div>
      <div className={styles.sumNow}>{v.now}</div>
      {v.digest && <div className={styles.sumDigest}>{v.digest}</div>}
      {v.last && <div className={styles.sumLine}><span className={v.last.ok ? 'ok' : 'err'}>{v.last.ok ? '✓' : '✕'}</span>{` ${v.last.text}`}</div>}
      {v.stuck && (
        <div className={cx(styles.sumLine, styles.attn)}>
          {t('Агент буксует: итерации {from}–{to} ({n} подряд) падают с одним и тем же замечанием. Можно поставить паузу и поправить промпт или условие.', {
            from: v.stuck.from, to: v.stuck.to, n: v.stuck.to - v.stuck.from + 1,
          })}
        </div>
      )}
      {v.waiting
        ? <div className={cx(styles.sumLine, styles.attn)}>{t('Агент ждёт твоего ответа — вопрос над вкладками.')}</div>
        : v.paused && <div className={cx(styles.sumLine, styles.attn)}>{t('Запуск на паузе.')}</div>}
    </section>
  );
}

const Chain = ({ steps }: { steps: ChainStep[] }) => (
  <>
    {steps.map((s, i) => (
      <Fragment key={i}>
        {i > 0 && <span className={styles.rbSep}>·</span>}
        <span className={cx(styles.rbStep, styles[s.cls])}>{`${s.mark} ${s.title}`}</span>
      </Fragment>
    ))}
  </>
);

/** Клик по ячейке ленты: раскрыть эту итерацию (остальные итерации блока свернуть) и подвести к её этапам. */
export function openIteration(bi: number, it: number, keys: string[]): void {
  for (const k of keys) if (k.startsWith(`i:${bi}:`)) runState.fold.over.set(k, false);
  runState.fold.over.set(`i:${bi}:${it}`, true);
  if (runState.st && runBlocks(runState.st.run).length > 1) runState.fold.over.set(`b:${bi}`, true);
  runState.scrollTo = { fold: [`i:${bi}:${it}`, `b:${bi}`], block: 'start' };
  bump();
}

function Ribbons({ st, spec }: { st: LiveState; spec: SpecBlocks }) {
  const rows = ribbonRows(st, runState.fold, spec);
  if (!rows.length) return null;
  const keys = runSteps(st, runState.fold).keys;
  const open = (bi: number, it: number) => openIteration(bi, it, keys);
  // саммари в ячейках обрезано тремя строками; кнопку «полностью» показываем, только когда что-то и правда обрезано
  const [full, setFull] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const bodies = ref.current?.querySelectorAll<HTMLElement>(`.${styles.rbBody}`) ?? [];
      setClipped([...bodies].some((el) => el.scrollHeight > el.clientHeight + 1));
    };
    if (full) return;
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  return (
    <section ref={ref} className={cx(styles.runRibbons, full && styles.rbFull)}>
      <div className={styles.runSecHead}>
        <span className={styles.runLabel}>{t('Итерации')}</span>
        {(full || clipped) && <button type="button" className="link-btn" onClick={() => setFull(!full)}>{full ? t('свернуть') : t('показать полностью')}</button>}
      </div>
      {rows.map((row) => (
        <div key={row.bi} className={styles.rbRow}>
          {row.head && (
            <div className={styles.rbHead}>
              <span className={styles.rbBn}>{t('Блок {n}', { n: row.bi + 1 })}</span>
              <span className={styles.rbTitle}>{row.head.title}</span>
              {row.head.status && <Badge status={row.head.status} />}
              <span className="muted small">{row.head.note}</span>
            </div>
          )}
          {row.chain && <div className={styles.rbChain}><Chain steps={row.chain} /></div>}
          {row.strip && (
            <div className={styles.rbStrip} role="group" aria-label={t('История итераций')}>
              <span className={styles.rbEdge}>1</span>
              <div className={styles.rbTicks}>
                {row.strip.ticks.map((x) => (
                  <button
                    key={x.it}
                    type="button"
                    className={cx(styles.rbTick, styles[x.st], x.open && styles.open, x.stuck && styles.stuck)}
                    disabled={x.st === 'future'}
                    title={x.title}
                    aria-label={t('Итерация {it}', { it: x.it })}
                    onClick={() => open(row.bi, x.it)}
                  />
                ))}
              </div>
              <span className={styles.rbEdge}>{row.strip.total}</span>
            </div>
          )}
          {row.cells && (
            <div className={styles.rbCells}>
              {row.cells.map((g) => (
                <button
                  key={g.from}
                  type="button"
                  className={cx(styles.rbCell, styles[g.st], g.stuck && styles.stuck, g.open && styles.open)}
                  disabled={g.st === 'future'}
                  title={g.title}
                  onClick={() => open(row.bi, g.to)}
                >
                  <span className={styles.rbTop}>
                    <span className={styles.rbN}>{g.n > 1 ? `${g.from}–${g.to}` : g.from}</span>
                    <span className={styles.rbMark}>{g.label}</span>
                  </span>
                  {g.stuck && <span className={styles.rbStuck}>{t('буксует')}</span>}
                  {g.chain ? <span className={styles.rbBody}><Chain steps={g.chain} /></span> : g.text && <span className={styles.rbBody}>{g.text}</span>}
                </button>
              ))}
              {row.more !== undefined && <span className={styles.rbMore}>{t('из {n}', { n: row.more })}</span>}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
