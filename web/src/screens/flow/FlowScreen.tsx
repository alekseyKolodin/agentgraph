// Экран flow (ui/app.js openFlow, renderFlow, setTab, saveYaml, removeFlow, renderFlowTabGraph): шапка с описанием, папкой и
// меню, строка «запусков за 30 дней · последний», вкладки «Конструктор / Запуск / YAML / Версии» (версии — из снимков flow.yaml
// его запусков, lib/flow/history.ts; версию можно открыть или взять в редактор YAML). /flow/<имя> — файл из flows/, /draft — черновик разового запуска (только в памяти
// вкладки). Уход с несохранённого конструктора и с черновика спрашивает, как openHome/openRun/leaveDraft в старом UI.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useBlocker, useLocation, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { checkFlow, deleteFlow, errorText, fetchFlow, fetchFlowVersion, keys, saveFlowYaml, useFeature, useFlowHistory, useFlows, useTags } from '../../api';
import { openRunFile } from '../../components/file/FileDialog';
import { AdhocBadge } from '../../components/Badge';
import { useConfirm } from '../../components/ConfirmDialog';
import { FlowGraph, type GraphHit } from '../../components/graph/FlowGraph';
import { ICON } from '../../components/shell/FlowList';
import { findPhase, toEditable } from '../../lib/flow/edit';
import { usageLine, versionMeta, versionsNote } from '../../lib/flow/history';
import { callSubOf, schemeSummary } from '../../lib/flow/summary';
import { flowGraphModel } from '../../lib/graph/model';
import { t } from '../../lib/i18n';
import { LS } from '../../lib/storage';
import type { RunTabState } from '../home/FlowPicker';
import { afterRender, openPhasePane } from './actions';
import { KnowledgeBadge } from './BlockEditor';
import { Builder, graphPick } from './Builder';
import { DIRTY_TEXT, leaveDraft, revealFlow, useMoveFlow } from './nav';
import { applySaved, closeFlow, dropYamlVersion, flowState, loadYamlVersion, msgClass, openLoaded, saveStart, set, useFlowStore, type Tab } from './store';
import { RunForm } from './RunForm';
import { YamlEditor, type YamlEditorHandle } from './YamlEditor';
import styles from './Flow.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
const knowledgeChip = (t: string) => <KnowledgeBadge slug={t} />;

// несохранённый конструктор, черновик разового запуска живут только в памяти страницы
window.addEventListener('beforeunload', (e) => {
  if (flowState.dirty || flowState.flow?.draft) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/** Вкладки экрана; у черновика разового запуска «Версий» нет — запусков у него не было. */
const FLOW_TABS: readonly (readonly [Tab, string])[] = [['builder', 'Конструктор'], ['run', 'Запуск'], ['yaml', 'YAML'], ['versions', 'Версии']];

/** Состояние перехода на экран flow: вкладка и вход из «Запустить…» с главной. */
type FlowNavState = Partial<RunTabState> & { tab?: Tab };

export function FlowScreen({ draft = false }: { draft?: boolean }) {
  const st = useFlowStore();
  const { name = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { askConfirm } = useConfirm();
  const nav = (location.state ?? null) as FlowNavState | null;

  // переход сюда уже подтверждён (openFlow, удаление) — следующий уход спрашивает снова
  useEffect(() => {
    flowState.approved = false;
  }, [location.key]);

  // открыт по адресу (ссылка, «назад», перезагрузка): flow с сервера; тот же flow, уже открытый, остаётся как есть
  useEffect(() => {
    if (draft) return;
    const f = flowState.flow;
    if (f && !f.draft && f.name === name) {
      if (nav?.tab && nav.tab !== flowState.tab) set({ tab: nav.tab });
      return;
    }
    let live = true;
    fetchFlow(name).then(
      (doc) => {
        if (!live) return;
        openLoaded(doc, nav?.tab ?? 'run');
        revealFlow(doc.folder);
      },
      () => {
        if (!live) return;
        set({ approved: true });
        void navigate('/', { replace: true });
      },
    );
    return () => {
      live = false;
    };
  }, [name, location.key, draft]);

  // уход с экрана: черновик пропадёт; несохранённый конструктор — на главную, к запуску и к другому flow — с вопросом
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    // подтверждённый переход; флаг снимает эффект по location.key уже на новом адресе — пока переход идёт, экран черновика
    // ещё перерисовывается и без флага увёл бы на главную
    if (flowState.approved) return false;
    if (nextLocation.pathname === currentLocation.pathname) return false;
    return Boolean(flowState.flow?.draft) || flowState.dirty;
  });
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
        void (async () => {
      const left = flowState.flow;
      if (!(await leaveDraft(askConfirm, false))) return blocker.reset();
      if (!left?.draft && flowState.dirty && !(await askConfirm(DIRTY_TEXT, { ok: t('Перейти') }))) return blocker.reset();
      blocker.proceed();
      // «без сохранения»: черновик и несохранённые правки пропадают (в старом их при возврате всё равно перечитывал openFlow).
      // Уже после перехода: экран черновика без него увёл бы на главную. Если тем временем открылся другой flow — его не трогаем
      setTimeout(() => {
        if (flowState.flow === left) closeFlow();
      });
    })();
  }, [blocker.state]);

  // черновика нет (перезагрузка, «назад» на /draft) — на главную; открыт другой flow и переход к нему уже идёт — ждём его
  if (draft && !st.flow?.draft) return flowState.approved ? null : <Navigate to="/" replace />;
  const flow = st.flow;
  if (!flow || (!draft && (flow.draft || flow.name !== name))) return null;

  const setTab = async (tab: Tab) => {
    if (tab === 'yaml' && flowState.dirty && !(await askConfirm(t('В конструкторе есть несохранённые изменения, во вкладке YAML их не будет. Перейти?'), { ok: t('Перейти') }))) return;
    set({ tab });
  };

  return (
    <div className={styles.viewFlow}>
      <FlowHead />
      <nav className="tabs page-tabs" role="tablist" aria-label={t('Разделы flow')}>
        {(flow.draft ? FLOW_TABS.slice(0, 3) : FLOW_TABS).map(([id, label]) => (
          <button key={id} type="button" className={cx('tab', st.tab === id && 'active')} role="tab" aria-selected={st.tab === id} onClick={() => void setTab(id)}>{t(label)}</button>
        ))}
      </nav>
      <Builder hidden={st.tab !== 'builder'} />
      <RunTab hidden={st.tab !== 'run'} intake={nav?.intake} intakeKey={location.key} />
      <YamlTab hidden={st.tab !== 'yaml'} />
      {!flow.draft && st.tab === 'versions' && <VersionsTab />}
      <KnowledgeTags />
    </div>
  );
}

/** Подсказки поля «Теги знаний» блока: теги со страницы «Знания». */
function KnowledgeTags() {
  const tags = useTags(useFeature('tags')).data?.tags ?? [];
  return (
    <datalist id="knowledge-tag-list">
      {tags.filter((t) => t.kind === 'knowledge').map((t) => <option key={t.slug} value={t.slug}>{t.title || ''}</option>)}
    </datalist>
  );
}

/** Шапка: имя (у черновика — «разовый»), описание с «ещё», папка, меню «⋯» с удалением. */
function FlowHead() {
  const st = useFlowStore();
  const flow = st.flow!;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { askConfirm, notify } = useConfirm();
  const move = useMoveFlow();
  const desc = useRef<HTMLParagraphElement>(null);
  const [descOpen, setDescOpen] = useState(false);
  const [descMore, setDescMore] = useState(false);
  const [folder, setFolder] = useState(flow.folder || '');
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  const description = flow.summary?.description || '';

  // принятое значение поля: Enter и следующий blur — один перенос, как одно событие change в старом
  const committed = useRef(flow.folder || '');
  useEffect(() => {
    setFolder(flow.folder || '');
    committed.current = flow.folder || '';
  }, [flow.folder, flow.name]);
  useEffect(() => setDescOpen(false), [flow.name, description]);

  // «ещё» — только если описание не влезает в две строки; пересчёт при смене окна
  useLayoutEffect(() => {
    const measure = () => {
      const el = desc.current;
      setDescMore(Boolean(el) && (descOpen || el!.scrollHeight > el!.clientHeight + 1));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [descOpen, description]);

  // меню: клик мимо и Esc закрывают, фокус — на первый пункт
  useEffect(() => {
    if (!menu) return;
    menuBox.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const onClick = (e: MouseEvent) => {
      if (!menuBox.current?.contains(e.target as Node) && e.target !== menuBtn.current) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(false);
      menuBtn.current?.focus();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const cancelled = useRef(false);
  const commitFolder = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = folder.trim();
    if (flow.draft || next === committed.current) return;
    committed.current = next;
    // после переноса или ошибки — значение с сервера: неудачный перенос можно повторить
    void move(flow.name, next, flowState.flow?.folder || '').then(() => {
      committed.current = flowState.flow?.folder || '';
      setFolder(committed.current);
    });
  };

  const remove = async () => {
    if (flow.draft) return;
    if (!(await askConfirm(t('Удалить flow «{name}»?\nФайл flows/{name}.yaml будет удалён, прошлые запуски останутся.', { name: flow.name }), { ok: t('Удалить'), danger: true }))) return;
    try {
      await deleteFlow(flow.name);
    } catch (err) {
      await notify(errorText(err));
      return;
    }
    closeFlow();
    set({ approved: true });
    void navigate('/', { replace: true });
    await qc.invalidateQueries({ queryKey: keys.flows });
  };

  return (
    <header className="view-head">
      <div>
        <h1>{flow.name}{flow.draft && <AdhocBadge />}</h1>
        <p ref={desc} className={cx('muted', styles.flowDesc, descOpen && styles.open)}>{description}</p>
        {descMore && <button type="button" className="link-btn" onClick={() => setDescOpen(!descOpen)}>{descOpen ? t('свернуть') : t('ещё')}</button>}
        {!flow.draft && <FlowUsage name={flow.name} yaml={flow.yaml} />}
        {!flow.draft && (
          <label className={styles.folderField} title={t('Папка в flows/. Пусто — корень. Можно перетащить flow на папку слева')}>
            <span className={styles.folderIcon}>{ICON.folder}</span>
            <input
              list="folder-options"
              placeholder={t('без папки')}
              autoComplete="off"
              spellCheck={false}
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              onBlur={commitFolder}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitFolder();
                if (e.key === 'Escape') {
                  // Esc — вернуть значение и уйти из поля, ничего не перенося (blur из этого же рендера видит набранный текст)
                  cancelled.current = true;
                  setFolder(committed.current);
                  e.currentTarget.blur();
                }
              }}
            />
          </label>
        )}
      </div>
      {/* редкие и опасные действия с flow — в меню, а не рядом с вкладками */}
      {!flow.draft && (
        <div className="row menu-wrap">
          <button
            ref={menuBtn}
            type="button"
            className="btn ghost icon-more"
            aria-haspopup="menu"
            aria-expanded={menu}
            title={t('Действия с flow')}
            onClick={(e) => {
              e.stopPropagation();
              setMenu(!menu);
            }}
          >
            ⋯
          </button>
          <div ref={menuBox} className="menu" role="menu" hidden={!menu}>
            <button
              type="button"
              className="menu-item danger"
              role="menuitem"
              title={t('Удалить файл flow из flows/ — с подтверждением')}
              onClick={() => {
                setMenu(false);
                void remove();
              }}
            >
              {t('Удалить flow…')}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}

/**
 * Вкладка «Запуск»: форма запуска (вход из «Запустить…» с главной — location.state.intake) и «Схема» — граф по сохранённому
 * flow (не по рабочей копии конструктора).
 */
function RunTab({ hidden, intake, intakeKey }: { hidden: boolean; intake: RunTabState['intake'] | undefined; intakeKey: string }) {
  const st = useFlowStore();
  const flow = st.flow!;
  const artifacts = useFeature('artifacts');
  const [open, setOpen] = useState(() => LS.get('agentgraph.graphOpen.flowTab', true));
  const flows = useFlows().data;
  const model = useMemo(() => (flow.spec ? flowGraphModel(toEditable(flow.spec), { artifacts, callSub: callSubOf(flows) }) : null), [flow.spec, artifacts, flows]);

  // клик по узлу: конструктор на этом этапе. Индексы у сохранённого flow и конструктора могут разойтись — этап ищем по имени
  const openBuilderAt = useCallback((n: GraphHit) => {
    if (!flowState.spec) return;
    set({ tab: 'builder' });
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

/** Вкладка YAML: редактор и «Сохранить» (у черновика — «Применить» через проверку на сервере). */
function YamlTab({ hidden }: { hidden: boolean }) {
  const st = useFlowStore();
  const flow = st.flow!;
  const qc = useQueryClient();
  const editor = useRef<YamlEditorHandle>(null);
  const save = async () => {
    const text = editor.current?.value() ?? '';
    const draft = Boolean(flowState.flow?.draft);
    const start = saveStart();
    try {
      const r = draft ? await checkFlow({ yaml: text }) : await saveFlowYaml(flowState.flow!.name, text);
      // пока сохранялось, открыли другой flow — ответ ему не нужен
      if (applySaved(r, text, draft, start)) set({ yamlMsg: { text: draft ? t('Применено') : t('Сохранено'), tone: 'ok' } });
      if (!draft) await qc.invalidateQueries({ queryKey: keys.flows });
    } catch (err) {
      if (flowState.flow === start.flow) set({ yamlMsg: { text: errorText(err), tone: 'err' } });
    }
  };
  return (
    <section hidden={hidden}>
      <YamlEditor ref={editor} className={styles.yamlEditor} value={st.yamlFrom?.text ?? flow.yaml} seq={st.yamlSeq} />
      <div className="row">
        <button className="btn primary" onClick={() => void save()}>{flow.draft ? t('Применить') : t('Сохранить')}</button>
        {/* в редакторе — версия из снимка запуска: вернуть текст файла без сохранения */}
        {st.yamlFrom && <button type="button" className="btn ghost" onClick={dropYamlVersion}>{t('Вернуть текст flow')}</button>}
        <pre className={msgClass(st.yamlMsg)}>{st.yamlMsg.text}</pre>
      </div>
    </section>
  );
}

/** Строка в шапке: «5 запусков за 30 дней · последний 18.11, 20:59» — последний ссылкой на запуск. */
function FlowUsage({ name, yaml }: { name: string; yaml: string }) {
  const h = useFlowHistory(name, yaml).data;
  if (!h) return null;
  const u = usageLine(h);
  return (
    <p className={cx('muted small', styles.flowUsage)} title={u.title}>
      {u.month}
      {u.last && h.last && (
        <>
          {' · '}
          <Link to={`/run/${h.last.id}`}>{u.last}</Link>
        </>
      )}
    </p>
  );
}

/**
 * Вкладка «Версии»: разные flow.yaml, с которыми начинались его запуски, от свежей к старой. Версию можно открыть
 * (снимок в окне файла) или взять в редактор YAML — «Сохранить» там вернёт её в flows/.
 */
function VersionsTab() {
  const st = useFlowStore();
  const flow = st.flow!;
  const { askConfirm } = useConfirm();
  const q = useFlowHistory(flow.name, flow.yaml);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const h = q.data;
  const take = async (runId: string, file: string, label: string) => {
    if (flowState.dirty && !(await askConfirm(t('В конструкторе есть несохранённые изменения, во вкладке YAML их не будет. Перейти?'), { ok: t('Перейти') }))) return;
    setBusy(runId);
    setErr('');
    try {
      // задача запуска в снимке — чужая: сервер подставит задачу файла flow
      const r = await fetchFlowVersion(flow.name, runId, file);
      // пока читали, открыли другой flow — версия ему не нужна
      if (flowState.flow?.name !== flow.name) return;
      loadYamlVersion(r.yaml, label, { text: t('В редакторе — версия {label} из запуска {id}, задача — из файла flow. «Сохранить» вернёт её в flows/, «Вернуть текст flow» — отменит.', { label, id: runId }), tone: 'warn' });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy('');
    }
  };
  if (q.error) return <p className="msg err">{t('История flow не загрузилась: {error}', { error: errorText(q.error) })}</p>;
  if (!h) return null;
  const note = versionsNote(h);
  return (
    <section className={styles.versions} aria-label={t('Версии flow')}>
      <p className="muted small">{t('Свои flow не лежат в git: версии собраны из снимков flow.yaml, с которыми начинались запуски.')}</p>
      {!h.versions.length ? (
        <p className="muted small">{h.total ? t('Снимков flow.yaml у запусков нет.') : t('Flow ещё не запускался: версий нет.')}</p>
      ) : (
        <ul className={styles.versionList}>
          {h.versions.map((v) => {
            const label = `v${v.n}`;
            return (
              <li key={v.id}>
                <span className={styles.versionName}>{label}</span>
                {v.current && <span className={styles.versionNow} title={t('Совпадает с файлом flow сейчас')}>{t('текущая')}</span>}
                <span className={styles.versionMeta} title={t('Отпечаток {id}', { id: v.id })}>{versionMeta(v)}</span>
                <span className={styles.versionActs}>
                  <Link to={`/run/${v.runId}`} title={t('Последний запуск с этой версией')}>{t('запуск')}</Link>
                  <button type="button" className="btn small ghost" onClick={() => void openRunFile(v.runId, v.file, t('flow {name} — {label}', { name: flow.name, label }))}>{t('Открыть')}</button>
                  {!v.current && (
                    <button type="button" className="btn small" disabled={busy === v.runId} title={t('Положить эту версию в редактор YAML — сохранишь там')} onClick={() => void take(v.runId, v.file, label)}>
                      {t('В редактор')}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {note && <p className="muted small">{note}</p>}
      {err && <p className="msg err">{err}</p>}
    </section>
  );
}
