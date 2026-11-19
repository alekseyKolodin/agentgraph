// Экран flow (ui/app.js openFlow, renderFlow, setTab, saveYaml, removeFlow, renderFlowTabGraph): шапка с описанием, папкой и
// меню, строка «запусков за 30 дней · последний», вкладки «Запуск / Правка / История» (каждая — свой файл: RunTab, EditTab, HistoryTab; история — из снимков
// flow.yaml его запусков, lib/flow/history.ts). /flow/<имя> — файл из flows/, /draft — черновик разового запуска (только в памяти
// вкладки). Уход с несохранённого конструктора и с черновика спрашивает, как openHome/openRun/leaveDraft в старом UI.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, useBlocker, useLocation, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { deleteFlow, errorText, fetchFlow, keys, useFeature, useFlowHistory, useTags } from '../../api';
import { AdhocBadge } from '../../components/Badge';
import { useConfirm } from '../../components/ConfirmDialog';
import { ICON } from '../../components/shell/FlowList';
import { usageLine } from '../../lib/flow/history';
import { t } from '../../lib/i18n';
import type { RunTabState } from '../home/FlowPicker';
import { EditTab } from './EditTab';
import { HistoryTab } from './HistoryTab';
import { DIRTY_TEXT, leaveDraft, revealFlow, useMoveFlow } from './nav';
import { closeFlow, flowState, openLoaded, set, useFlowStore, type Tab } from './store';
import { RunTab } from './RunTab';
import styles from './Flow.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

// несохранённый конструктор, черновик разового запуска живут только в памяти страницы
window.addEventListener('beforeunload', (e) => {
  if (flowState.dirty || flowState.flow?.draft) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/** Вкладки экрана; у черновика разового запуска «Истории» нет — запусков у него не было. YAML — вид внутри «Правки». */
const FLOW_TABS: readonly (readonly [Tab, string])[] = [['run', 'Запуск'], ['edit', 'Правка'], ['history', 'История']];

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

  const setTab = (tab: Tab) => set({ tab });

  return (
    <div className={styles.viewFlow}>
      <FlowHead />
      <nav className="tabs page-tabs" role="tablist" aria-label={t('Разделы flow')}>
        {(flow.draft ? FLOW_TABS.slice(0, 2) : FLOW_TABS).map(([id, label]) => (
          <button key={id} type="button" className={cx('tab', st.tab === id && 'active')} role="tab" aria-selected={st.tab === id} onClick={() => setTab(id)}>{t(label)}</button>
        ))}
      </nav>
      <RunTab hidden={st.tab !== 'run'} intake={nav?.intake} intakeKey={location.key} />
      <EditTab hidden={st.tab !== 'edit'} />
      {!flow.draft && st.tab === 'history' && <HistoryTab />}
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
