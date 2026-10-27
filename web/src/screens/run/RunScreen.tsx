// Страница запуска (ui/app.js openRun, subscribe, renderRun и #view-run в ui/index.html): шапка с управлением, то, что ждёт
// человека (ошибка, пауза и ответ на неё, вопросы агента), вкладки «Обзор / Граф / Лог / Артефакты». Состояние — store.ts,
// логика без React — lib/run/. Поток /api/runs/:id/events открыт, пока запуск идёт; на это время опрос /api/runs выключен.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useBlocker, useLocation, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { HomeRun, RunStreamEvent } from '@server/api-types';
import {
  abortRun, continueRun, deleteRun, errorText, keys, pauseRun, resumeRun, runFileUrl, setRunHidden, setRunStreamOpen, useConfig, useEventStream, useFeature,
  useRuns,
} from '../../api';
import { AdhocBadge, Badge, TagBadge } from '../../components/Badge';
import { useConfirm } from '../../components/ConfirmDialog';
import { MdText } from '../../components/MdText';
import { PathLink } from '../../components/PathLink';
import { QuestionCard } from '../../components/question/QuestionCard';
import { setDocRunTitle } from '../../components/shell/docTitle';
import { useToast } from '../../components/Toast';
import { when } from '../../lib/format';
import { graphRunState } from '../../lib/graph/run-state';
import { t } from '../../lib/i18n';
import type { GraphBlock } from '../../lib/graph/model';
import { LIVE_STATUSES, withoutQuestion } from '../../lib/home';
import { sourceLabel } from '../../lib/run-form';
import { deleteRunText } from '../../lib/runs';
import { artAttention } from '../../lib/run/artifacts';
import {
  continueVisible, flowEditsLine, headerStatus, limitEditable, pauseHint, pauseText, runBlocks, runFinished, runMeta, runPause,
} from '../../lib/run/view';
import { useOpenFlow } from '../flow/nav';
import { LimitCtl, Overview } from './Overview';
import {
  art, artBeforeContinue, artConfirmLeave, artDecisions, artEnsureLoaded, artOnEvent, artOnStreamOpen, artOpenRun, artReload, artResume, artTrackPause,
  closeWin, dirtyDrafts, setAnswerMsg, useArtStore,
} from './artStore';
import { ArtifactsPanel, artReveal } from './ArtifactsPanel';
import { ArtifactWindow } from './ArtifactWindow';
import { FixPanel } from './FixPanel';
import { answerKey, setPauseAnswer, usePauseAnswer } from './pauseAnswer';
import { RunChat } from './RunChat';
import { RunGraph } from './RunGraph';
import { LogBody } from './RunLog';
import { SaveFlowDialog } from './SaveFlowDialog';
import { bump, closeRun, loadContinuable, markAnswered, openRun, RUN_TABS, runEvent, runState, resetLog, setRunTab, shownTab, useRunStore, type RunTab } from './store';
import styles from './Run.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
const TAB_LABEL: Record<RunTab, string> = { overview: t('Обзор'), graph: t('Граф'), log: t('Лог'), artifacts: t('Артефакты') };
/** Переигранные вопросы и паузы не должны дёргать список запусков по разу на событие. */
const RUNS_SOON_MS = 300;
/** «идёт N мин» на графе стареет между событиями: у живого запуска освежаем раз в 30 секунд. */
const LIVE_TICK_MS = 30_000;

export function RunScreen() {
  const { id = '' } = useParams();
  return <RunPage key={id} id={id} />;
}

function RunPage({ id }: { id: string }) {
  useRunStore();
  useArtStore();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { askConfirm, notify } = useConfirm();
  const toast = useToast();
  const openFlow = useOpenFlow();
  const config = useConfig().data!;
  const canFlow = useFeature('run-flow');
  const canManage = useFeature('run-manage');
  const canAdhoc = useFeature('adhoc-runs');
  const canChat = useFeature('run-chat');
  const artOn = useFeature('artifacts');
  art.on = artOn;
  const feedOn = useFeature('feed');
  const runs = useRuns().data;
  const [saveOpen, setSaveOpen] = useState(false);

  useEffect(() => {
    if (artOn) artOpenRun(id);
    openRun(id, canFlow).catch(() => navigate('/', { replace: true }));
    return () => {
      // уход со страницы запуска: окно артефакта закрывается, черновик остаётся
      closeWin(true);
      closeRun();
    };
  }, [id]);

  const st = runState.id === id ? runState.st : null;
  const r = st?.run;

  // ---------- поток
  const runsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const runsSoon = useCallback(() => {
    clearTimeout(runsTimer.current);
    runsTimer.current = setTimeout(() => void qc.invalidateQueries({ queryKey: keys.runs }), RUNS_SOON_MS);
  }, [qc]);
  useEffect(() => () => clearTimeout(runsTimer.current), []);
  const streaming = Boolean(st && runState.streaming);
  useEventStream<RunStreamEvent>(streaming ? `/api/runs/${encodeURIComponent(id)}/events` : null, {
    // при переподключении сервер заново шлёт все события: лог собираем с нуля, список артефактов перечитываем
    onOpen: () => {
      resetLog();
      if (artOn) artOnStreamOpen();
    },
    onEvent: (e) => {
      // снимок артефактов правит только панель, значки и окно — без перерисовки страницы целиком
      if (e.type === 'artifacts') {
        if (artOn) artOnEvent(e);
        return;
      }
      const eff = runEvent(e);
      if (eff?.runsSoon) runsSoon();
      if (eff?.ended) void loadContinuable(id);
      if (eff?.close && artOn) artReload();
    },
  });
  useEffect(() => {
    setRunStreamOpen(streaming);
    return () => setRunStreamOpen(false);
  }, [streaming]);

  // заголовок вкладки, «идёт N мин» (уход со страницы с черновиком или недописанным ответом — beforeunload в artStore.ts)
  const title = r ? r.title || r.flow : '';
  useEffect(() => {
    setDocRunTitle(title);
    return () => setDocRunTitle('');
  }, [title]);
  const live = Boolean(r?.live);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(bump, LIVE_TICK_MS);
    return () => clearInterval(t);
  }, [live]);

  // переход к карточке после перерисовки: из ленты итераций и из графа — прокрутить и мигнуть
  useLayoutEffect(() => {
    const go = runState.scrollTo;
    if (!go) return;
    runState.scrollTo = null;
    const root = document.getElementById('run-pane-overview');
    const el = go.step === '#input'
      ? root?.querySelector(`.${styles.runInput}`)
      : go.step
        ? [...(root?.querySelectorAll<HTMLElement>('[data-step]') ?? [])].find((x) => x.dataset.step === go.step)
        : go.fold?.map((k) => root?.querySelector(`[data-fold="${k}"]`)).find(Boolean);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: go.block });
    if (go.step === '#input') return;
    el.classList.add(styles.flash!);
    setTimeout(() => el.classList.remove(styles.flash!), 1200);
  });

  // ответ на паузу: недописанный — по запуску и паузе; сообщение под полем — только для своей паузы
  const aKey = answerKey(id, r?.pauseReason?.at || '');
  const answer = usePauseAnswer(aKey);

  // артефакты: список грузится, пока он нужен панели; смена паузы — возобновили ли не отсюда
  const artPanel = artOn && Boolean(r?.artifacts);
  useEffect(() => {
    if (artPanel && runState.st?.run.id === id) artEnsureLoaded();
  });
  useEffect(() => {
    if (artPanel && r) artTrackPause(r);
  }, [artPanel, r?.id, r?.live, r?.pause, r?.pauseReason?.at]);
  // запуск из CLI: этот сервер не получает его событий, список перечитываем, когда вкладка снова на виду
  useEffect(() => {
    const onVis = () => {
      const cur = runState.st?.run;
      if (!document.hidden && artOn && cur?.id === id && cur.artifacts && !cur.live && cur.status === 'running') artReload();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [id, artOn]);
  // переход к другому запуску с несохранённой правкой артефакта здесь — подтверждение (artConfirmLeave)
  const blocker = useBlocker(({ nextLocation }) => {
    const next = nextLocation.pathname.match(/^\/run\/([^/]+)/)?.[1];
    return Boolean(artOn && next && next !== id && dirtyDrafts(id).length);
  });
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void artConfirmLeave(id, askConfirm).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker.state]);

  if (!st || !r) return null;

  const blocks = runBlocks(r);
  const multi = blocks.length > 1;
  const pause = runPause(r);
  const flow = runState.flow?.id === id ? runState.flow.spec : null;
  const rs = flow ? graphRunState(flow.blocks as GraphBlock[], r, st.pending, { condPending: st.condPending, now: Date.now() }) : null;
  // строка «Сейчас: …» из графа — без переведённой приставки (ключ тот же, что в lib/graph/run-state.ts)
  const nowPre = t('Сейчас: {parts}', { parts: '' });
  const graphNow = rs ? (rs.now.startsWith(nowPre) ? rs.now.slice(nowPre.length) : rs.now) : '';
  const available = new Set<RunTab>(['overview', 'log', ...(flow ? ['graph' as const] : []), ...(artPanel ? ['artifacts' as const] : [])]);
  const tab = shownTab(available);
  const manage = canManage && !r.live && !LIVE_STATUSES.includes(r.status);
  const hint = pause ? pauseHint(r, artPanel) : null;

  // ---------- действия
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      await notify(errorText(err));
    }
  };
  const abort = async () => {
    if (!(await askConfirm(t('Остановить запуск? Текущая сессия будет прервана.'), { ok: t('Остановить запуск'), danger: true }))) return;
    await act(() => abortRun(id));
  };
  const resume = () => (artOn ? artResume(id, undefined, { notify, toast }) : act(() => resumeRun(id)));
  const hide = async () => {
    const hidden = !r.hidden;
    try {
      await setRunHidden(id, hidden);
    } catch (err) {
      await notify(errorText(err));
      return;
    }
    if (runState.st?.run.id === id) {
      runState.st.run.hidden = hidden;
      bump();
    }
    if (feedOn) void qc.invalidateQueries({ queryKey: keys.feed });
    await qc.invalidateQueries({ queryKey: keys.runs });
  };
  const remove = async () => {
    const known = runs?.find((x) => x.id === id) ?? r;
    if (!(await askConfirm(deleteRunText(id, known), { ok: t('Удалить'), danger: true }))) return;
    try {
      await deleteRun(id);
    } catch (err) {
      await notify(errorText(err));
      return;
    }
    void navigate('/');
    if (feedOn) void qc.invalidateQueries({ queryKey: keys.feed });
    await qc.invalidateQueries({ queryKey: keys.runs });
  };
  const cont = async () => {
    if (artOn && !(await artBeforeContinue(id, { notify, toast }))) return;
    let res;
    try {
      res = await continueRun(id);
    } catch (err) {
      await notify(errorText(err));
      return;
    }
    await qc.invalidateQueries({ queryKey: keys.runs });
    void navigate(`/run/${res.id}`);
  };
  const flowAction = r.adhoc
    ? canAdhoc ? { label: t('Сохранить как flow'), run: () => setSaveOpen(true) } : null
    : { label: t('Открыть flow в конструкторе'), run: () => void openFlow(r.flow, 'builder') };

  // ---------- ответ на паузу: поле под карточкой паузы у flow с артефактом решений
  const dec = artPanel && r.live && pause && r.pauseReason ? artDecisions() : undefined;
  const answerMsg = art.answerMsg.key === aKey ? art.answerMsg : { text: '', kind: '' as const };
  const resumeLabel = dec && pause === 'paused' && answer.trim() ? t('Возобновить с ответом') : t('Возобновить');

  const from = r.continuedFrom;
  const fromKnown = from && runs?.some((x) => x.id === from);
  const sub = [
    <span key="when">{when(r.startedAt)}</span>,
    r.cwd && <PathLink key="cwd" className={styles.subPath} path={r.cwd} />,
    r.hidden && <span key="hidden">{t('скрыт из списка')}</span>,
    from && (fromKnown ? <Link key="from" to={`/run/${from}`} title={from}>{t('продолжение запуска')}</Link> : <span key="from" title={from}>{t('продолжение запуска')}</span>),
  ].filter(Boolean);
  const extras = [
    r.attachments?.length ? (
      <span key="att">
        {t('Вложения:')}{' '}
        {r.attachments.map((f, i) => (
          <span key={f}>{i > 0 && ', '}<a href={runFileUrl(r.id, f)} target="_blank" rel="noopener">{f.split('/').pop()}</a></span>
        ))}
      </span>
    ) : null,
    r.addDirs?.length ? (
      <span key="dirs">
        {t('Доп. директории:')}{' '}
        {r.addDirs.map((d, i) => <span key={d}>{i > 0 && ', '}<PathLink className={styles.subPath} path={d} /></span>)}
      </span>
    ) : null,
    // только в новом UI: откуда запуск — задача Jira, MR (GitLab, !N) или PR (GitHub, #N), ветка; и его worktree
    r.source ? (
      <span key="src">
        {`${sourceLabel(r.source)}: `}
        {r.source.url ? <a href={r.source.url} target="_blank" rel="noopener">{r.source.key}</a> : r.source.key}
        {r.source.title ? ` — ${r.source.title}` : ''}
      </span>
    ) : null,
    r.worktree ? <PathLink key="wt" path={r.worktree.path}>{`worktree${r.worktree.branch ? ` · ${r.worktree.branch}` : ''}`}</PathLink> : null,
  ].filter(Boolean);
  const openQuestions = r.live ? r.questions.filter((q) => !q.answers) : [];
  // правки flow на паузе (FixPanel): сколько, а что поменяли — в подсказке
  const edits = flowEditsLine(r);
  const shownTabs = RUN_TABS.filter((t) => available.has(t));
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = shownTabs.indexOf(tab);
    const next = shownTabs[(i + (e.key === 'ArrowRight' ? 1 : shownTabs.length - 1)) % shownTabs.length]!;
    setRunTab(next);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-run-tab="${next}"]`)?.focus());
  };

  return (
    // data-run — база для относительных путей в выводе (components/PathLink): сервер ищет их от cwd запуска
    <div className={styles.runRoot} data-run={id}>
      <header className={cx('view-head', styles.viewHead)}>
        <div>
          <h1>
            {r.title || r.flow}
            {r.adhoc && <AdhocBadge />}
            {(r.tags || []).map((t) => <TagBadge key={`t${t}`} slug={t} />)}
            {(r.knowledge || []).map((t) => <TagBadge key={`k${t}`} slug={t} kind="knowledge" />)}
            {' '}<Badge status={headerStatus(r)} />
          </h1>
          {r.title && (
            <p className={cx('muted small', styles.runFlow)}>
              {r.adhoc ? <>{`flow ${r.flow} `}<span className="muted">{t('(разовый)')}</span></> : <>flow <Link to={`/flow/${r.flow}`} title={t('Открыть flow')}>{r.flow}</Link></>}
            </p>
          )}
          <p title={t('Стоимость: оценка по прайсу API; с подписки не списывается')}>{runMeta(r, st.tagPending)}</p>
          <p className={cx('muted small', styles.runSub)}>{sub.flatMap((x, i) => (i ? [<span key={`s${i}`}>·</span>, x] : [x]))}</p>
          {extras.length > 0 && <p className={cx('muted small', styles.runExtras)}>{extras.flatMap((x, i) => (i ? [<span key={`e${i}`}>·</span>, x] : [x]))}</p>}
          {edits && <p className="muted small" title={edits.title}>{edits.text}</p>}
          {!multi && limitEditable(r, blocks[0]!) && <p className={cx('muted', styles.runLimit)}>{t('Лимит итераций:')} <LimitCtl block={blocks[0]!} /></p>}
        </div>
        <div className="row">
          {!r.adhoc && <button className="btn ghost" onClick={() => void openFlow(r.flow)}>{t('К flow')}</button>}
          {r.adhoc && canAdhoc && <button className="btn" title={t('Разовый запуск: сохранить его flow в flows/, чтобы запускать снова')} onClick={() => setSaveOpen(true)}>{t('Сохранить как flow')}</button>}
          {r.live && !pause && <button className="btn" title={t('Текущий этап доработает, следующий не начнётся')} onClick={() => void act(() => pauseRun(id))}>{t('Пауза')}</button>}
          {pause && <button className="btn primary" onClick={() => void resume()}>{resumeLabel}</button>}
          {continueVisible(r) && <button className="btn primary" title={t('Новый запуск текущей версией flow: пройденные блоки не повторяются')} onClick={() => void cont()}>{t('Продолжить с места остановки')}</button>}
          {r.live && <button className="btn danger" onClick={() => void abort()}>{t('Остановить запуск')}</button>}
          {manage && <button className="btn ghost" title={t('Убрать из списка запусков слева; файлы останутся')} onClick={() => void hide()}>{r.hidden ? t('Вернуть в список') : t('Скрыть')}</button>}
          {manage && <button className="btn danger" title={t('Удалить папку запуска из runs/')} onClick={() => void remove()}>{t('Удалить')}</button>}
        </div>
      </header>
      {/* то, что ждёт человека, — над вкладками: видно с любой из них */}
      <div className={styles.runAttn}>
        {r.error && !runFinished(r) && <p className="error">{r.error}</p>}
        {pause && (
          <div className="run-paused">
            <div>{pauseText(pause)}</div>
            {hint && (
              <>
                <div>
                  {hint.text}
                  {hint.openArtifacts && <>{' '}<button type="button" className="btn small" onClick={artReveal}>{t('Открыть артефакты')}</button></>}
                </div>
                <MdText text={r.pauseReason!.text} />
              </>
            )}
            {pause === 'paused' && <FixPanel r={r} onResume={resume} />}
          </div>
        )}
        {dec && (
          <PauseAnswer
            key={aKey}
            answerKey={aKey}
            title={dec.title}
            waiting={pause !== 'paused'}
            msg={answerMsg}
            focus={Boolean((location.state as { focusAnswer?: boolean } | null)?.focusAnswer)}
          />
        )}
        {openQuestions.length > 0 && (
          <div>
            {openQuestions.map((q) => (
              <QuestionCard
                key={q.id}
                q={q}
                run={{ id: r.id, flow: r.flow, title: r.title, blocks: r.blocks }}
                onAnswered={(answers) => {
                  markAnswered(r.id, q.id, answers);
                  qc.setQueryData<{ runs: HomeRun[] }>(keys.home, (d) => (d ? { ...d, runs: withoutQuestion(d.runs, r.id, q.id) } : d));
                }}
                onFailed={() => void qc.invalidateQueries({ queryKey: keys.home })}
              />
            ))}
          </div>
        )}
      </div>
      {/* вкладки страницы запуска; выбранная запоминается (agentgraph.runTab) */}
      <nav className={cx('tabs', styles.runTabs)} role="tablist" aria-label={t('Разделы запуска')} onKeyDown={onTabKey}>
        {shownTabs.map((t) => (
          <button
            key={t}
            type="button"
            className={cx('tab', t === tab && 'active')}
            role="tab"
            data-run-tab={t}
            aria-controls={`run-pane-${t}`}
            aria-selected={t === tab}
            tabIndex={t === tab ? 0 : -1}
            onClick={() => setRunTab(t)}
          >
            {TAB_LABEL[t]}
            {t === 'log' && r.live && <span className={cx(styles.tabDot, styles.live)} />}
            {t === 'artifacts' && artAttention(r) && <span className={cx(styles.tabDot, styles.attn)} />}
          </button>
        ))}
      </nav>
      <section id="run-pane-overview" className={styles.runPane} role="tabpanel" hidden={tab !== 'overview'}>
        <Overview st={st} spec={flow?.blocks} graphNow={graphNow} implicit={config.implicitTools} />
        {canChat && <RunChat runId={id} onAfterTurn={runsSoon} />}
      </section>
      <section id="run-pane-graph" className={styles.runPane} role="tabpanel" hidden={tab !== 'graph'}>
        {flow && rs && (
          <RunGraph
            st={st}
            spec={{ blocks: flow.blocks as GraphBlock[], artifacts: flow.artifacts }}
            rs={rs}
            artifacts={artPanel}
            shown={tab === 'graph'}
            implicit={config.implicitTools}
            flowAction={flowAction}
          />
        )}
      </section>
      <section id="run-pane-log" className={cx(styles.runPane, styles.logPane)} role="tabpanel" hidden={tab !== 'log'}>
        <div className={styles.log}>
          <p className="muted small">{t('Последние 3000 строк всех сессий. Весь лог этапа — кнопка «транскрипт» у этапа.')}</p>
          <LogBody shown={tab === 'log'} />
        </div>
      </section>
      <section id="run-pane-artifacts" className={styles.runPane} role="tabpanel" hidden={tab !== 'artifacts'}>
        {artPanel && <ArtifactsPanel r={r} onContinue={() => void cont()} />}
      </section>
      {artOn && <ArtifactWindow onContinue={() => void cont()} />}
      {r.adhoc && <SaveFlowDialog runId={id} flow={r.flow} open={saveOpen} onClose={() => setSaveOpen(false)} />}
    </div>
  );
}

/** Поле ответа на паузу: недописанный ответ живёт в памяти вкладки по запуску и паузе; до конца шага поля нет. */
function PauseAnswer({ answerKey: key, title, waiting, msg, focus }: {
  answerKey: string;
  title: string;
  waiting: boolean;
  msg: { text: string; kind: '' | 'err' };
  focus: boolean;
}) {
  const value = usePauseAnswer(key);
  const ta = useRef<HTMLTextAreaElement>(null);
  // «Ответить» с главной: фокус в поле
  useEffect(() => {
    if (!focus || waiting || !ta.current) return;
    ta.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    ta.current.focus({ preventScroll: true });
  }, [focus, waiting]);
  const shownMsg = waiting ? { text: t('Жду конца шага: поле ответа появится, когда запуск встанет на паузу.'), kind: '' as const } : msg;
  return (
    <div className={styles.runAnswer}>
      {!waiting && <label htmlFor="run-answer-text">{t('Ответ — допишется в артефакт «{title}»', { title })}</label>}
      {!waiting && (
        <textarea
          ref={ta}
          id="run-answer-text"
          rows={3}
          aria-describedby="run-answer-msg"
          placeholder={t('Решение для агента: допишется в артефакт решений, затем запуск пойдёт дальше')}
          value={value}
          onChange={(e) => {
            setPauseAnswer(key, e.target.value);
            if (msg.kind === 'err') setAnswerMsg(key, '');
          }}
        />
      )}
      <p id="run-answer-msg" className={`msg${shownMsg.kind ? ` ${shownMsg.kind}` : ''}`} role="status" aria-live="polite">{shownMsg.text}</p>
    </div>
  );
}
