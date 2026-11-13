// Разбивка ТЗ на задачи (spec §8.5, §9.1, §9.3; макеты Backlog.dc.html и Split.dc.html): «Разбить ТЗ на задачи…» запускает
// черновик teamwork-split; пока он идёт — строка со ссылкой на запуск; готовый — предложение над бэклогом. У каждой задачи
// галочка и правка полей до принятия. Два вида: список по волнам с колонками «Ждёт» и «Блокирует» и граф по волнам слева
// направо (DepsGraphView). Справа — панель выбранной задачи: поля, «Ждёт» с × у каждой связи, «+ Зависимость», «Блокирует»,
// когда её можно начать. Сводка: волны, сколько можно начать сейчас, сколько ждут задач проекта, самая длинная цепочка в
// очках с «Показать», циклы. «Добавить N в бэклог» → POST …/drafts/:run/accept { tasks }; 400 dependencies подсвечивает
// ошибки по задачам. Принятые и отклонённые черновики запоминаются в браузере, чтобы предложение не всплывало снова.
import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDependencyReport, TeamDetail, TeamDraft, TeamDraftExisting, TeamProject, TeamProposedTask, TeamTask, TeamTaskType } from '@server/api-types';
import { ApiError, errorText } from '../../../api';
import { teamKeys, useDoc } from '../../../api/teamwork';
import { useToast } from '../../../components/Toast';
import { useNow } from '../../../components/useNow';
import { feedTime } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { LS } from '../../../lib/storage';
import { statusText, TASK_TYPES, tasksWord } from '../../../lib/teamwork/board';
import {
  acceptText, addDependency, canAccept, chainEdges, chainText, checkDependencies, depsSummary, existingNote, focusGraph, keyLabel, layoutGraph, removeDependency,
  startNote, unlocks, waitsOn, wavesCount, waveText, GRAPH_DEFAULTS, type DepsGraph, type ExistingTask, type GraphFocus,
} from '../../../lib/teamwork/deps';
import { draftStopText } from '../../../lib/teamwork/doc-view';
import { proposalCoverage } from '../../../lib/teamwork/docs';
import { ESTIMATES } from '../../../lib/teamwork/task';
import { cx } from '../parts';
import tw from '../Teamwork.module.css';
import { useFlowTrust } from '../FlowTrust';
import { acceptSplit, draftRunning, startDraft, taskKeys, useDraft, useDrafts } from './api';
import { Assignee } from './parts';
import styles from './Tasks.module.css';

// ---------- какие черновики разбивки уже разобраны (принят или отклонён): только в этом браузере

const doneKey = (team: string, project: string) => `agentgraph.teamwork.splitDone.${team}.${project}`;
const readDone = (team: string, project: string): string[] => {
  const v = LS.get<unknown>(doneKey(team, project), []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};
const markDone = (team: string, project: string, run: string) => LS.set(doneKey(team, project), [...readDone(team, project).filter((x) => x !== run), run].slice(-20));

const isSplit = (d: TeamDraft) => d.kind === 'split';

/** Над бэклогом: кнопка разбивки, строка идущего черновика, предложение готового. */
export function SplitArea({ team, project, tasks, readonly }: { team: TeamDetail; project: TeamProject; tasks: TeamTask[]; readonly: boolean }) {
  const qc = useQueryClient();
  const drafts = useDrafts(team.slug, project.slug);
  const [done, setDone] = useState(() => readDone(team.slug, project.slug));
  const [asking, setAsking] = useState(false);
  const latest = (drafts.data ?? []).filter(isSplit)[0];
  const running = latest && draftRunning(latest.status);
  const show = latest && !running && !done.includes(latest.run) ? latest : undefined;
  const finish = (run: string) => {
    markDone(team.slug, project.slug, run);
    setDone(readDone(team.slug, project.slug));
  };
  const started = () => {
    setAsking(false);
    void qc.invalidateQueries({ queryKey: taskKeys.drafts(team.slug, project.slug) });
  };
  return (
    <>
      <div className={styles.tabBar}>
        <span className={styles.grow} />
        {!readonly && (
          <button
            type="button"
            className="btn small"
            disabled={Boolean(running)}
            title={running ? t('Разбивка уже идёт') : t('Агент предложит задачи по ТЗ, архитектуре и дизайну; ничего не запишется без вашего решения')}
            onClick={() => setAsking(true)}
          >
            {t('Разбить ТЗ на задачи…')}
          </button>
        )}
      </div>
      {asking && <SplitStart team={team.slug} project={project.slug} onClose={() => setAsking(false)} onStarted={started} />}
      {latest && running && (
        <div className={styles.running} role="status">
          <span className={cx(tw.dot, (latest.status === 'waiting' || latest.status === 'paused') && tw.wait)} aria-hidden="true" />
          <span>{latest.status === 'waiting' ? t('Агент разбивает ТЗ и ждёт ответа') : latest.status === 'paused' ? t('Разбивка ТЗ на паузе') : t('Агент разбивает ТЗ на задачи')}</span>
          <span className={styles.meta}>{latest.flow}</span>
          <Link to={`/run/${encodeURIComponent(latest.run)}`}>{latest.status === 'waiting' ? t('Ответить') : t('Открыть запуск')}</Link>
        </div>
      )}
      {show && (
        <SplitReview
          key={show.run}
          team={team}
          project={project}
          draft={show}
          tasks={tasks}
          readonly={readonly}
          onDone={() => finish(show.run)}
          onRetry={() => setAsking(true)}
        />
      )}
    </>
  );
}

/** Задание разбивки: пусто — «Разбить всё ТЗ». */
function SplitStart({ team, project, onClose, onStarted }: { team: string; project: string; onClose: () => void; onStarted: () => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const trust = useFlowTrust();
  useEffect(() => {
    dlg.current?.showModal();
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      // flow разбивки изменили и здесь не одобряли — диалог доверия; «Отмена» — без запуска, задание остаётся
      if (!(await trust.guard(() => startDraft(team, project, { kind: 'split', ...(brief.trim() ? { brief: brief.trim() } : {}) })))) return;
      onStarted();
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog ref={dlg} className={styles.dlg} aria-labelledby="tw-split-title" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <form className={styles.dlgBody} onSubmit={(e) => void submit(e)}>
        <h2 id="tw-split-title">{t('Разбить ТЗ на задачи')}</h2>
        <p>{t('Агент читает ТЗ, архитектуру, дизайн и задачи проекта и предлагает новые задачи с зависимостями. Предложение появится над бэклогом, в репо ничего не запишется без вашего решения.')}</p>
        <div className={styles.f}>
          <label htmlFor="tw-split-brief">{t('Что разбить')}</label>
          <textarea id="tw-split-brief" value={brief} autoFocus style={{ minHeight: 80, fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-small)' }} placeholder={t('Разбить всё ТЗ')} onChange={(e) => setBrief(e.target.value)} />
        </div>
        {err && <p className="msg err">{err}</p>}
        <div className={styles.dfoot}>
          <span className={styles.grow} />
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? t('Запускаю…') : t('Разбить')}</button>
        </div>
      </form>
      {trust.dialog}
    </dialog>
  );
}

type View = 'graph' | 'list';
/** Размеры макета Split.dc.html, узел на 6 px выше: две строки заголовка и строка требований без обрезки. */
const GRAPH = { ...GRAPH_DEFAULTS, nodeH: 82 };
const VIEW_KEY = 'agentgraph.teamwork.splitView';

const existingOf = (draft: TeamDraftExisting[] | undefined, tasks: TeamTask[]): ExistingTask[] =>
  draft ?? tasks.filter((x) => !x.error).map((x) => ({ id: x.id, status: x.status, title: x.title, assignee: x.assignee, sprint: x.sprint, estimate: x.estimate }));

/** Предложение разбивки: правка, связи, принятие. */
function SplitReview({ team, project, draft, tasks, readonly, onDone, onRetry }: {
  team: TeamDetail; project: TeamProject; draft: TeamDraft; tasks: TeamTask[]; readonly: boolean; onDone: () => void; onRetry: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const now = useNow(30_000);
  const q = useDraft(team.slug, project.slug, draft.run);
  const prd = useDoc(team.slug, project.slug, 'prd').data;
  const d = q.data;
  const [proposal, setProposal] = useState<TeamProposedTask[]>();
  const [off, setOff] = useState<string[]>([]);
  const [view, setViewState] = useState<View>(() => (LS.get<string>(VIEW_KEY, 'graph') === 'list' ? 'list' : 'graph'));
  const [selected, setSelected] = useState<string>();
  const [chainOn, setChainOn] = useState(false);
  const [serverReport, setServerReport] = useState<TeamDependencyReport>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (d?.tasks && !proposal) setProposal(d.tasks);
  }, [d]);
  const setView = (v: View) => {
    setViewState(v);
    LS.set(VIEW_KEY, v);
  };
  const existing = useMemo(() => existingOf(d?.existing, tasks), [d?.existing, tasks]);
  const all = proposal ?? [];
  const picked = all.filter((x) => !off.includes(x.key));
  const layoutRep = useMemo(() => checkDependencies(all, existing), [all, existing]);
  const rep = useMemo(() => checkDependencies(picked, existing), [picked, existing]);
  const graph = useMemo(() => layoutGraph(all, existing, layoutRep, GRAPH), [all, existing, layoutRep]);
  const focus = selected && graph.nodes.some((n) => n.key === selected) ? focusGraph(graph, selected) : undefined;

  if (q.isError) return <div className={styles.prop}><p className="msg err">{errorText(q.error)}</p></div>;
  if (!d) return null;
  const head = (
    <div className={styles.propH}>
      <h2>{d.error ? t('Разбивка не получилась') : t('Агент предложил {tasks} по ТЗ', { tasks: tasksWord(all.length) })}</h2>
      <span className={styles.meta}>{d.flow} · {feedTime(d.finishedAt ?? d.startedAt, new Date(now))}</span>
      {d.brief && <span className={styles.hint} title={d.brief}>«{d.brief.length > 60 ? `${d.brief.slice(0, 60)}…` : d.brief}»</span>}
      <span className={styles.grow} />
      <Link to={`/run/${encodeURIComponent(d.run)}`}>{t('Открыть запуск')}</Link>
    </div>
  );
  if (d.error || !proposal) {
    return (
      <section className={styles.prop} aria-label={t('Предложение агента')}>
        {head}
        {d.error && <p className="msg err">{d.error}</p>}
        {!d.error && d.status !== 'done' && <p className="msg">{t('Задач нет: {why}.', { why: draftStopText(d.status) })}</p>}
        <div className={styles.propF}>
          {!readonly && <button type="button" className="btn" onClick={onRetry}>{t('Повторить черновик')}</button>}
          <button type="button" className="btn ghost" onClick={onDone}>{t('Скрыть')}</button>
        </div>
      </section>
    );
  }

  /** Связь на задачу предложения без галочки — для сервера «неизвестная задача»; человеку — что она не отмечена. */
  const offText = new Map(off.map((k) => [t('неизвестная задача «{dep}»', { dep: k }), t('ждёт задачу {key}, а она не отмечена', { key: keyLabel(k) })]));
  const errorsOf = (key: string): string[] => [
    ...new Set([...rep.errors, ...(serverReport?.errors ?? [])].filter((e) => e.key === key).map((e) => labelKeys(offText.get(e.error) ?? e.error))),
  ];
  const edit = (key: string, patch: Partial<TeamProposedTask>) => setProposal((list) => (list ?? []).map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const link = (key: string, dep: string) => setProposal((list) => addDependency(list ?? [], existing, key, dep).tasks);
  const unlink = (key: string, dep: string) => setProposal((list) => removeDependency(list ?? [], existing, key, dep).tasks);
  const togglePick = (key: string) => setOff((o) => (o.includes(key) ? o.filter((x) => x !== key) : [...o, key]));

  const accept = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setErr('');
    setServerReport(undefined);
    try {
      const r = await acceptSplit(team.slug, project.slug, d.run, picked);
      const n = 'tasks' in r ? r.tasks.length : picked.length;
      toast(t('В бэклог добавлено задач: {n}', { n }));
      void qc.invalidateQueries({ queryKey: teamKeys.tasks(team.slug, project.slug) });
      void qc.invalidateQueries({ queryKey: teamKeys.team(team.slug) });
      void qc.invalidateQueries({ queryKey: teamKeys.project(team.slug, project.slug) });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'dependencies') {
        const report = (e.data as { report?: TeamDependencyReport } | undefined)?.report;
        if (report) setServerReport(report);
        setErr(t('Сервер не принял связи: ошибки подсвечены у задач'));
      } else setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const reqs = prd?.requirements ?? [];
  const cover = reqs.length ? proposalCoverage(reqs, picked, tasks) : undefined;
  const missing = cover?.items.filter((i) => i.state === 'none').map((i) => i.id) ?? [];
  const summary = depsSummary(picked, existing, rep).map(labelKeys);
  const sel = selected ? all.find((x) => x.key === selected) : undefined;
  const ok = canAccept(rep) && picked.length > 0;
  return (
    <section className={styles.prop} aria-label={t('Предложение агента')}>
      {head}
      {cover && (
        <div className={styles.cov}>
          <div className={styles.frs} role="img" aria-label={cover.text}>
            {cover.items.map((i) => <div key={i.id} className={cx(styles.fr, styles[i.state])} title={i.state === 'proposed' ? t('в этом предложении') : i.state === 'existing' ? t('уже есть задача') : t('без задач')}><i /><span>{i.id}</span></div>)}
          </div>
          <span>{cover.text}</span>
        </div>
      )}
      {d.warnings?.map((w) => <p key={w} className="msg warn">{w}</p>)}
      <div className={styles.ctl}>
        <span className={styles.seg} role="group" aria-label={t('Вид', undefined, 'view')}>
          <button type="button" className={cx(view === 'graph' && styles.on)} aria-pressed={view === 'graph'} onClick={() => setView('graph')}>{t('Граф')}</button>
          <button type="button" className={cx(view === 'list' && styles.on)} aria-pressed={view === 'list'} onClick={() => setView('list')}>{t('Список')}</button>
        </span>
        <span className={styles.sum}>
          {summary.map((s, i) => <span key={i} className={i === 3 ? (rep.cycle ? styles.tFail : styles.tOk) : undefined}>{s}{i < summary.length - 1 ? ' ·' : ''}</span>)}
        </span>
      </div>
      <div className={styles.work}>
        <div className={styles.gcol}>
          {view === 'graph' ? (
            <>
              <p className={styles.hint}>{t('Нажмите на задачу, чтобы увидеть её связи. Новая связь — протяните от правого края одной задачи к другой.')}</p>
              <DepsGraphView
                graph={graph}
                focus={focus}
                chain={chainOn ? chainEdges(graph, rep) : undefined}
                off={off}
                errorsOf={errorsOf}
                members={team.memberList}
                selected={selected}
                onSelect={(k) => setSelected((s) => (s === k ? undefined : k))}
                onLink={readonly ? undefined : (to, from) => link(to, from)}
              />
              <div className={styles.under}>
                {rep.chain.keys.length > 0 && (
                  <span>
                    {labelKeys(chainText(rep))}{' '}
                    <button type="button" className={styles.linkBtn} aria-pressed={chainOn} onClick={() => setChainOn((v) => !v)}>{chainOn ? t('Скрыть') : t('Показать')}</button>
                  </span>
                )}
                {graph.nodes.some((n) => n.existing) && <span className={styles.lg}><i />{t('пунктир — задача уже есть в проекте')}</span>}
              </div>
            </>
          ) : (
            <ProposalList all={all} off={off} layoutRep={layoutRep} existing={existing} selected={selected} errorsOf={errorsOf} onSelect={setSelected} onPick={togglePick} readonly={readonly} />
          )}
        </div>
        {sel && (
          <Inspector
            key={sel.key}
            task={sel}
            all={all}
            index={all.indexOf(sel)}
            picked={!off.includes(sel.key)}
            existing={existing}
            report={layoutRep}
            errors={errorsOf(sel.key)}
            project={project}
            members={team.memberList}
            readonly={readonly}
            onPick={() => togglePick(sel.key)}
            onEdit={(patch) => edit(sel.key, patch)}
            onLink={(dep) => link(sel.key, dep)}
            onUnlink={(dep) => unlink(sel.key, dep)}
            onClose={() => setSelected(undefined)}
          />
        )}
      </div>
      {err && <p className="msg err">{err}</p>}
      <div className={styles.propF}>
        {!readonly && (
          <button type="button" className="btn primary" disabled={!ok || busy} title={!canAccept(rep) ? t('Сначала уберите ошибки связей') : undefined} onClick={() => void accept()}>
            {busy ? t('Добавляю…') : acceptText(picked.length)}
          </button>
        )}
        {!readonly && <button type="button" className="btn ghost" onClick={onRetry}>{t('Повторить черновик')}</button>}
        <button type="button" className="btn ghost" onClick={onDone} title={t('Предложение останется в запуске, здесь его больше не покажем')}>{t('Отклонить')}</button>
        {missing.length > 0 && <span className={cx(styles.note, styles.tWait)}>{t('{ids} без задач', { ids: missing.join(', ') })}</span>}
      </div>
    </section>
  );
}


/** Ключи предложения в тексте разбора (t3 → 3), как на графе и в списке; номера задач проекта (PAY-3) не трогаются. */
const labelKeys = (text: string): string => text.replace(/(^|[^\p{L}\p{N}_-])t(\d+)(?![\p{L}\p{N}_])/gu, '$1$2');

// ---------- список по волнам

function ProposalList({ all, off, layoutRep, existing, selected, errorsOf, onSelect, onPick, readonly }: {
  all: TeamProposedTask[]; off: string[]; layoutRep: TeamDependencyReport; existing: ExistingTask[]; selected?: string; errorsOf: (key: string) => string[];
  onSelect: (key: string) => void; onPick: (key: string) => void; readonly: boolean;
}) {
  const n = wavesCount(layoutRep);
  const groups: { wave?: number; items: TeamProposedTask[] }[] = Array.from({ length: n }, (_, i) => ({ wave: i + 1, items: all.filter((x) => layoutRep.waves[x.key] === i + 1) }));
  const cyc = all.filter((x) => layoutRep.waves[x.key] === undefined);
  if (cyc.length) groups.push({ items: cyc });
  const label = (id: string) => (all.some((x) => x.key === id) ? keyLabel(id) : id);
  return (
    <div aria-label={t('Предложенные задачи')}>
      <div className={styles.lh} aria-hidden="true"><span /><span>№</span><span>{t('Задача')}</span><span>{t('Ждёт')}</span><span>{t('Блокирует')}</span><span>{t('ТЗ')}</span><span style={{ textAlign: 'right' }}>{t('Оц.')}</span></div>
      {groups.filter((g) => g.items.length).map((g) => (
        <div key={g.wave ?? 'cycle'}>
          <div className={styles.wvh}>{g.wave === undefined ? t('Цикл', undefined, 'deps') : t('Волна {n}', { n: g.wave })}{g.wave === 1 && <span className={styles.meta}>{t('можно начать сейчас')}</span>}</div>
          {g.items.map((x) => {
            const errs = errorsOf(x.key);
            const waits = x.dependsOn;
            const opens = all.filter((y) => y.dependsOn.includes(x.key)).map((y) => y.key);
            return (
              <div
                key={x.key}
                tabIndex={0}
                aria-current={selected === x.key ? 'true' : undefined}
                className={cx(styles.lr, selected === x.key && styles.on, off.includes(x.key) && styles.off)}
                onClick={() => onSelect(x.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(x.key);
                  }
                }}
              >
                <input type="checkbox" checked={!off.includes(x.key)} disabled={readonly} aria-label={t('Добавить задачу {key}', { key: keyLabel(x.key) })} onClick={(e) => e.stopPropagation()} onChange={() => onPick(x.key)} />
                <span className={styles.k}>{keyLabel(x.key)}</span>
                <span className={styles.t}>
                  {x.title}
                  {x.description && <span className={styles.d}>{x.description}</span>}
                  {errs.map((e) => <span key={e} className={cx(styles.err, styles.tFail)}>{e}</span>)}
                </span>
                <span className={cx(styles.dp, styles.wt)}>
                  {waits.length ? waits.map((w) => {
                    const ex = existing.find((y) => y.id === w);
                    return <span key={w}>{label(w)}{ex && <span className={styles.s}> {statusText(ex.status)}</span>}</span>;
                  }) : <span className={styles.no}>—</span>}
                </span>
                <span className={cx(styles.dp, styles.op)}>{opens.length ? opens.map(keyLabel).join(', ') : <span className={styles.no}>—</span>}</span>
                <span className={styles.frC}>{x.covers.map((c) => <span key={c} className={styles.frc}>{c}</span>)}</span>
                <span className={styles.e}>{x.estimate ?? ''}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------- граф

/**
 * Граф по волнам: узлы — кнопки поверх SVG со стрелками от предшественника к последователю. Существующие задачи — пунктиром
 * со статусом и исполнителем. Ручка на правом краю узла тянет новую связь: бросок на предложенную задачу делает её
 * зависимой от той, откуда тянули.
 */
export function DepsGraphView({ graph, focus, chain, off, errorsOf, members, selected, onSelect, onLink }: {
  graph: DepsGraph; focus?: GraphFocus; chain?: boolean[]; off: string[]; errorsOf: (key: string) => string[]; members: TeamDetail['memberList'];
  selected?: string; onSelect: (key: string) => void; onLink?: (to: string, from: string) => void;
}) {
  const o = graph.options;
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: string; x1: number; y1: number; x2: number; y2: number; over?: string }>();
  const width = Math.max(graph.width, 320);
  const height = Math.max(graph.height, 140);
  const startLink = (from: string, e: ReactPointerEvent) => {
    if (!onLink) return;
    e.preventDefault();
    e.stopPropagation();
    const n = graph.nodes.find((x) => x.key === from);
    const r = box.current?.getBoundingClientRect();
    if (!n || !r) return;
    const x1 = n.x + o.nodeW;
    const y1 = n.y + o.nodeH / 2;
    setDrag({ from, x1, y1, x2: e.clientX - r.left, y2: e.clientY - r.top });
  };
  useEffect(() => {
    if (!drag) return;
    const target = (e: PointerEvent): string | undefined => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-node]');
      const key = el?.dataset.node;
      const node = graph.nodes.find((n) => n.key === key);
      return node && !node.existing && key !== drag.from ? key : undefined;
    };
    const move = (e: PointerEvent) => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      // кнопку отпустили вне окна (pointerup не пришёл) — связь не тянется дальше
      if (e.pointerType === 'mouse' && e.buttons === 0) return setDrag(undefined);
      setDrag((d) => (d ? { ...d, x2: e.clientX - r.left, y2: e.clientY - r.top, over: target(e) } : d));
    };
    const up = (e: PointerEvent) => {
      const to = target(e);
      const from = drag.from;
      setDrag(undefined);
      if (to) onLink?.(to, from);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrag(undefined);
    };
    // касание отменил браузер (прокрутка, жест) — линия не должна висеть до следующего pointerup
    const cancel = () => setDrag(undefined);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', esc);
    };
  }, [drag?.from]);
  if (!graph.nodes.length) return <p className={styles.hint}>{t('Задач нет')}</p>;
  const lit = (i: number) => (chain ? chain[i] : focus ? focus.edges[i] : false);
  return (
    <div className={styles.gbox} role="region" aria-label={t('Граф зависимостей')}>
      <div ref={box} className={cx(styles.g, drag && styles.linking)} style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="tw-ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" className={cx(styles.arrow, styles.lit)} /></marker>
            <marker id="tw-ad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" className={styles.arrow} /></marker>
          </defs>
          {graph.edges.map((e, i) => (
            <path
              key={`${e.from}>${e.to}`}
              d={e.path}
              className={cx(styles.edge, lit(i) && (chain ? styles.chain : styles.lit), (focus || chain) && !lit(i) && styles.dim)}
              markerEnd={lit(i) ? 'url(#tw-ah)' : 'url(#tw-ad)'}
            />
          ))}
          {drag && <path d={`M${drag.x1} ${drag.y1} L${drag.x2} ${drag.y2}`} className={cx(styles.edge, styles.temp)} />}
        </svg>
        {graph.columns.map((c) => (
          <span key={c.col} className={styles.wv} style={{ left: c.x, width: o.nodeW }}>{c.label}{c.note && <span className={styles.meta}>{c.note}</span>}</span>
        ))}
        {graph.nodes.map((n) => {
          const st = focus?.nodes[n.key];
          const bad = !n.existing && errorsOf(n.key).length > 0;
          const label = n.existing ? n.key : keyLabel(n.key);
          return (
            <div key={n.key} className={styles.ndWrap} style={{ left: n.x, top: n.y, width: o.nodeW, height: o.nodeH }}>
              <button
                type="button"
                data-node={n.key}
                className={cx(
                  styles.nd, n.existing && styles.gh, st === 'selected' && styles.selected, st === 'dim' && styles.dim, off.includes(n.key) && styles.off,
                  drag?.over === n.key && styles.target, bad && styles.bad,
                )}
                aria-pressed={selected === n.key}
                title={bad ? errorsOf(n.key).join('\n') : undefined}
                onClick={() => onSelect(n.key)}
              >
                <span className={styles.t1}>
                  <span className={styles.k}>{label}</span>
                  {n.existing && n.ref ? statusText(n.ref.status) : n.task?.type}
                  <span className={styles.grow} />
                  {n.existing ? <Assignee email={n.ref?.assignee} members={members} /> : n.task?.estimate !== undefined && <span className={styles.e}>{n.task.estimate}</span>}
                </span>
                <span className={styles.tt}>{n.existing ? n.ref?.title ?? n.key : n.task?.title}</span>
                <span className={styles.fr2}>{n.existing && n.ref ? existingNote(n.ref).where : (n.task?.covers ?? []).join(' · ')}</span>
              </button>
              {onLink && (
                <span
                  className={styles.handle}
                  role="presentation"
                  title={t('Протяните к задаче, которая будет ждать эту')}
                  onPointerDown={(e) => startLink(n.key, e)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- панель задачи предложения

function Inspector({ task, all, index, picked, existing, report, errors, project, members, readonly, onPick, onEdit, onLink, onUnlink, onClose }: {
  task: TeamProposedTask; all: TeamProposedTask[]; index: number; picked: boolean; existing: ExistingTask[]; report: TeamDependencyReport; errors: string[];
  project: TeamProject; members: TeamDetail['memberList']; readonly: boolean;
  onPick: () => void; onEdit: (patch: Partial<TeamProposedTask>) => void; onLink: (dep: string) => void; onUnlink: (dep: string) => void; onClose: () => void;
}) {
  const [dep, setDep] = useState('');
  const waits = waitsOn(task.key, all, existing, report);
  const opens = unlocks(task.key, all, report);
  const cands = [
    ...all.filter((x) => x.key !== task.key && !task.dependsOn.includes(x.key)).map((x) => ({ id: x.key, label: `${keyLabel(x.key)} · ${x.title}` })),
    ...existing.filter((x) => !task.dependsOn.includes(x.id)).map((x) => ({ id: x.id, label: `${x.id} · ${x.title ?? ''} (${statusText(x.status)})` })),
  ];
  const wave = report.waves[task.key];
  const id = `tw-insp-${task.key}`;
  return (
    <aside className={styles.insp} aria-label={t('Задача {key}', { key: keyLabel(task.key) })}>
      <div className={styles.inspH}>
        <span className={styles.cap} style={{ margin: 0 }}>{t('Задача {key} из {n} · {wave}', { key: keyLabel(task.key), n: all.length, wave: waveText(wave) })}</span>
        <span className={styles.grow} />
        <button type="button" className={styles.x} aria-label={t('Закрыть')} onClick={onClose}>×</button>
      </div>
      {readonly ? <h3>{task.title}</h3> : (
        <input className={styles.inp} style={{ fontSize: 'var(--fs-h3)', fontWeight: 500 }} aria-label={t('Заголовок')} value={task.title} onChange={(e) => onEdit({ title: e.target.value })} />
      )}
      <label className={styles.chk}><input type="checkbox" checked={picked} disabled={readonly} onChange={onPick} />{t('Добавить в бэклог')}</label>
      {errors.map((e) => <p key={e} className={cx('msg', styles.tFail)}>{e}</p>)}
      <div className={styles.pf}>
        <label htmlFor={`${id}-type`}>{t('Тип')}</label>
        <select id={`${id}-type`} value={task.type} disabled={readonly} onChange={(e) => onEdit({ type: e.target.value as TeamTaskType })}>
          {TASK_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <label htmlFor={`${id}-est`}>{t('Оценка')}</label>
        <select id={`${id}-est`} value={task.estimate ?? ''} disabled={readonly} onChange={(e) => onEdit({ estimate: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">—</option>
          {[...new Set([...ESTIMATES, ...(task.estimate !== undefined ? [task.estimate] : [])])].sort((a, b) => a - b).map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <label htmlFor={`${id}-repo`}>{t('Репо')}</label>
        <select id={`${id}-repo`} value={task.repo ?? ''} disabled={readonly} onChange={(e) => onEdit({ repo: e.target.value || undefined })}>
          <option value="">—</option>
          {project.repos.map((r) => <option key={r.key} value={r.key}>{r.key}</option>)}
          {task.repo && !project.repos.some((r) => r.key === task.repo) && <option value={task.repo}>{task.repo}</option>}
        </select>
        <label htmlFor={`${id}-covers`}>{t('Требования')}</label>
        <input id={`${id}-covers`} className={styles.mono} value={task.covers.join(', ')} disabled={readonly} placeholder="FR-1, FR-2" onChange={(e) => onEdit({ covers: e.target.value.split(/[\s,]+/).filter(Boolean) })} />
        <label htmlFor={`${id}-desc`}>{t('Описание')}</label>
        <textarea id={`${id}-desc`} value={task.description} disabled={readonly} onChange={(e) => onEdit({ description: e.target.value })} />
        <label htmlFor={`${id}-acc`}>{t('Критерии')}</label>
        <textarea id={`${id}-acc`} value={task.acceptance.join('\n')} disabled={readonly} title={t('Один критерий на строку')} onChange={(e) => onEdit({ acceptance: e.target.value.split('\n') })} onBlur={(e) => onEdit({ acceptance: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
      </div>
      <div>
        <h4 className={styles.cap}>{t('Ждёт')}</h4>
        <div className={styles.deps}>
          {waits.map((r) => (
            <div key={r.id} className={styles.dep}>
              <span className={styles.k}>{r.existing ? r.id : keyLabel(r.id)}</span>
              <span className={styles.tx} title={r.title}>{r.title}</span>
              <span className={styles.st}>
                {r.existing && <Assignee email={r.assignee} members={members} />}
                {r.existing && r.status ? statusText(r.status) : waveText(r.wave)}
                {!readonly && <button type="button" className={styles.x} aria-label={t('Убрать зависимость от {id}', { id: r.existing ? r.id : keyLabel(r.id) })} onClick={() => onUnlink(r.id)}>×</button>}
              </span>
            </div>
          ))}
          {!waits.length && <div className={styles.dep}><span className={styles.no}>—</span><span className={styles.hint}>{t('ничего', undefined, 'deps')}</span><span /></div>}
        </div>
        {!readonly && (
          <div className={styles.addDep}>
            <select className={styles.inp} aria-label={t('Новая зависимость')} value={dep} onChange={(e) => setDep(e.target.value)}>
              <option value="">{t('+ Зависимость: чего она ждёт')}</option>
              {cands.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <button type="button" className="btn ghost small" disabled={!dep} onClick={() => { onLink(dep); setDep(''); }}>{t('Добавить')}</button>
          </div>
        )}
      </div>
      <div>
        <h4 className={styles.cap}>{t('Блокирует')}</h4>
        <div className={styles.deps}>
          {opens.map((r) => (
            <div key={r.id} className={styles.dep}><span className={cx(styles.k, styles.meta)}>{keyLabel(r.id)}</span><span className={styles.tx}>{r.title}</span><span className={styles.st}>{waveText(r.wave)}</span></div>
          ))}
          {!opens.length && <div className={styles.dep}><span className={styles.no}>—</span><span className={styles.hint}>{t('никого')}</span><span /></div>}
        </div>
      </div>
      <p className={styles.when}>{startNote(task.key, all, existing, report, members)}</p>
      <span className={styles.hint}>{t('{n}-я в предложении', { n: index + 1 })}</span>
    </aside>
  );
}
