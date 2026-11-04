// Секция «Запуски» сайдбара (ui/app.js renderRunList, runFilterHtml, foldAll, wireSideSearch, setRunHidden, deleteRun): поиск,
// фильтр по статусу одной строкой, группы по проектам с «ещё N» и живыми счётчиками, скрытые, скрыть и удалить запуск. Строка
// запуска — ссылка (Cmd+клик — в новом окне, Tab и Enter), «Скрыть» и «Удалить» — кнопки поверх неё. Логика — lib/runs.ts;
// свёрнутость проектов — fold.ts (proj:<cwd>), группировка, скрытые и фильтр — те же ключи localStorage, что у старого UI.
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useMatch, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { RunSummary } from '@server/api-types';
import { deleteRun, errorText, keys, setRunHidden, useFeature, useRuns } from '../../api';
import { useConfirm } from '../ConfirmDialog';
import { statusLabel } from '../../lib/format';
import { t } from '../../lib/i18n';
import { deleteRunText, projKey, runDepths, runListView, runManageable, runRowMeta, runRowTitle } from '../../lib/runs';
import { LS } from '../../lib/storage';
import { isOpen, reveal, setOpen, useFold } from './fold';
import { ICON } from './FlowList';
import styles from './Sidebar.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

// ---------- состояние списка: общее для шапки секции и списка. Поиск и «ещё N» — только в памяти вкладки
const side = {
  grouped: LS.get('agentgraph.groupRuns', true),
  showHidden: LS.get('agentgraph.showHidden', false),
  statuses: new Set(LS.get<string[]>('agentgraph.runStatuses', [])),
  query: '',
  showAll: new Set<string>(),
};
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const changed = () => {
  version++;
  for (const fn of listeners) fn();
};
const useSide = () => {
  useSyncExternalStore(subscribe, () => version);
  return side;
};

/** Открытый запуск: подсвечен, виден, даже если скрыт, его проект раскрыт. */
const useActiveRun = () => useMatch('/run/:id')?.params.id ?? null;

function useView() {
  const s = useSide();
  const runs = useRuns();
  const activeId = useActiveRun();
  const all = runs.data ?? [];
  return { s, all, activeId, loaded: runs.isSuccess, view: runListView(all, { activeId, showHidden: s.showHidden, statuses: s.statuses, query: s.query }, s.grouped, s.showAll) };
}

/** Кнопки в шапке секции: «по проектам», свернуть/развернуть все проекты, ↻. */
export function RunSectionActions() {
  useFold();
  const qc = useQueryClient();
  const { s, all, activeId, view } = useView();
  const keysOf = view.groups.map((g) => g.key);
  const anyOpen = keysOf.some((k) => view.searching || isOpen(k));
  return (
    <div className={styles.sideActions}>
      <button
        className={cx('chip', s.grouped && 'on')}
        title={t('Группировать запуски по директории проекта')}
        onClick={() => {
          side.grouped = !side.grouped;
          LS.set('agentgraph.groupRuns', side.grouped);
          const open = activeId ? all.find((r) => r.id === activeId) : undefined;
          if (side.grouped && open) setOpen(projKey(open.cwd), true);
          changed();
        }}
      >
        {t('по проектам')}
      </button>
      {keysOf.length > 0 && (
        <button
          className={cx('btn small ghost icon-btn', styles.fold)}
          title={anyOpen ? t('Свернуть все проекты') : t('Развернуть все проекты')}
          aria-label={anyOpen ? t('Свернуть все проекты') : t('Развернуть все проекты')}
          onClick={() => {
            for (const k of keysOf) setOpen(k, !anyOpen);
          }}
        >
          {anyOpen ? ICON.foldAll : ICON.unfoldAll}
        </button>
      )}
      <button className="btn small ghost" title={t('Обновить')} aria-label={t('Обновить список запусков')} onClick={() => void qc.invalidateQueries({ queryKey: keys.runs })}>↻</button>
    </div>
  );
}

export function RunList() {
  useFold();
  const { s, all, activeId, loaded, view } = useView();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { askConfirm, notify } = useConfirm();
  const manage = useFeature('run-manage');
  const feed = useFeature('feed');

  // открыли запуск (по ссылке, из «Сейчас», после «Запустить»): раздел и его проект раскрыты, как в openRun
  const activeCwd = activeId ? all.find((r) => r.id === activeId)?.cwd : undefined;
  const activeKnown = activeId ? all.some((r) => r.id === activeId) : false;
  useEffect(() => {
    if (activeId && activeKnown) reveal('sec:runs', side.grouped ? projKey(activeCwd) : null);
  }, [activeId, activeKnown]);

  const refresh = async () => {
    if (feed) void qc.invalidateQueries({ queryKey: keys.feed });
    await qc.invalidateQueries({ queryKey: keys.runs });
  };
  const hide = async (id: string, hidden: boolean) => {
    try {
      await setRunHidden(id, hidden);
    } catch (err) {
      await notify(errorText(err));
      return;
    }
    await refresh();
  };
  const remove = async (id: string) => {
    if (!(await askConfirm(deleteRunText(id, all.find((x) => x.id === id)), { ok: t('Удалить'), danger: true }))) return;
    try {
      await deleteRun(id);
    } catch (err) {
      await notify(errorText(err));
      return;
    }
    if (activeId === id) void navigate('/');
    await refresh();
  };

  // имя запуска (без имени — flow) — одной строкой с многоточием, под ним одна строка меты: статус словом, когда,
  // пространство ссылкой, хвост. Имя — ссылка, растянутая на всю строку; кнопки и ссылка пространства — поверх неё
  const item = (r: RunSummary, withProject: boolean, depth = 0) => {
    const meta = runRowMeta(r, withProject);
    const name = r.title || r.flow;
    return (
      <li
        key={r.id}
        className={cx(activeId === r.id && styles.active, r.hidden && styles.hiddenRun, depth > 0 && styles.childRun)}
        style={depth > 0 ? { ['--depth' as string]: depth } : undefined}
        title={runRowTitle(r)}
      >
        <Link className={cx(styles.name, styles.rowLink)} to={`/run/${r.id}`} aria-current={activeId === r.id ? 'page' : undefined}>{name}</Link>
        <span className={styles.sub}>
          <span className={cx(styles.stWord, meta.tone && styles[meta.tone])}>{meta.status}</span>
          {` · ${meta.when}`}
          {meta.space && (
            <>
              {' · '}
              <Link className={styles.metaSpace} to={`/spaces/${encodeURIComponent(meta.space)}`} title={`${meta.space}\n${t('Пространство: карта, документы, состояние «где мы сейчас»')}`}>{`◇ ${meta.space}`}</Link>
            </>
          )}
          {` · ${meta.tail}`}
        </span>
        {runManageable(r, manage) && (
          <span className={styles.liActs}>
            <button
              type="button"
              className="icon-btn"
              title={r.hidden ? t('Вернуть в список') : t('Скрыть из списка (файлы останутся)')}
              aria-label={r.hidden ? t('Вернуть запуск «{name}» в список', { name }) : t('Скрыть запуск «{name}» из списка', { name })}
              onClick={(e) => {
                e.stopPropagation();
                void hide(r.id, !r.hidden);
              }}
            >
              {r.hidden ? ICON.show : ICON.hide}
            </button>
            <button
              type="button"
              className="icon-btn danger"
              title={t('Удалить запуск')}
              aria-label={t('Удалить запуск «{name}»', { name })}
              onClick={(e) => {
                e.stopPropagation();
                void remove(r.id);
              }}
            >
              {ICON.trash}
            </button>
          </span>
        )}
      </li>
    );
  };

  // дочерние запуски блоков-вызовов — с отступом под родителем (порядок — nestRuns в lib/runs.ts)
  const depths = runDepths(view.runs);

  const setStatus = (st: string) => {
    if (!st) side.statuses.clear();
    else if (side.statuses.has(st)) side.statuses.delete(st);
    else side.statuses.add(st);
    LS.set('agentgraph.runStatuses', [...side.statuses]);
    changed();
  };

  return (
    <>
      {/* поле поиска стоит вне перерисовываемого списка; Esc очищает */}
      <input
        className={styles.sideSearch}
        type="search"
        aria-label={t('Найти запуск')}
        placeholder={t('Найти запуск…')}
        autoComplete="off"
        spellCheck={false}
        title={t('Все слова должны найтись в имени, flow, задаче, тегах, папке проекта или id запуска. Esc — очистить')}
        value={s.query}
        onChange={(e) => {
          side.query = e.target.value;
          changed();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !s.query) return;
          e.preventDefault();
          side.query = '';
          changed();
        }}
      />
      <div className={styles.sideBody}>
        {/* фильтр по статусу: несколько выбранных — объединение; «все» сбрасывает */}
        {view.chips.length > 0 && (
          <StatusFilter>
            <button className={cx('chip', !s.statuses.size && 'on')} title={t('Все статусы')} onClick={() => setStatus('')}>{t('все')}</button>
            {view.chips.map((c) => (
              <button
                key={c.status}
                className={cx('chip', styles.st, c.status, c.on && 'on')}
                title={c.on ? t('Убрать из фильтра') : t('Показать запуски с этим статусом')}
                onClick={() => setStatus(c.status)}
              >
                {`${statusLabel(c.status)} `}<span className={styles.n}>{c.count}</span>
              </button>
            ))}
          </StatusFilter>
        )}
        {loaded && view.empty && <p className={`${styles.sideEmpty} muted`}>{view.empty}</p>}
        {!view.empty && !s.grouped && <ul className={styles.list}>{view.runs.map((r) => item(r, true, depths.get(r.id)))}</ul>}
        {!view.empty && s.grouped && view.groups.map((g) => {
          // при поиске группы раскрыты, не трогая запомненную свёртку
          const open = view.searching || isOpen(g.key);
          return (
            <div key={g.key} className={cx(styles.grp, !open && styles.collapsed)}>
              <button className={styles.grpHead} aria-expanded={open} title={g.title} onClick={() => setOpen(g.key, !open)}>
                <span className={styles.caret}>{ICON.caret}</span>
                <span className={styles.grpName}>{g.label}</span>
                {/* идущие и ждущие ответа видны и у свёрнутого проекта */}
                {g.live.waiting > 0 && <span className={cx(styles.grpLive, styles.waiting)} title={t('ждут ответа: {n}', { n: g.live.waiting })}>{`● ${g.live.waiting}`}</span>}
                {g.live.paused > 0 && <span className={cx(styles.grpLive, styles.paused)} title={t('на паузе: {n}', { n: g.live.paused })}>{`❚❚ ${g.live.paused}`}</span>}
                {g.live.running > 0 && <span className={cx(styles.grpLive, styles.running)} title={t('выполняются: {n}', { n: g.live.running })}>{`● ${g.live.running}`}</span>}
                <span className={styles.grpCount}>{g.count}</span>
              </button>
              <ul className={styles.list}>
                {g.runs.map((r) => item(r, false, depths.get(r.id)))}
                {g.more > 0 && (
                  <li className={styles.more}>
                    <button
                      type="button"
                      className={styles.moreBtn}
                      onClick={() => {
                        side.showAll.add(g.key);
                        changed();
                      }}
                    >
                      {t('ещё {n}', { n: g.more })}
                    </button>
                  </li>
                )}
              </ul>
            </div>
          );
        })}
        {/* переключатель скрытых — под списком, как «ещё N»: в шапке раздела ему не хватает места */}
        {view.hiddenCount > 0 && (
          <button
            className={styles.sideMore}
            onClick={() => {
              side.showHidden = !side.showHidden;
              LS.set('agentgraph.showHidden', side.showHidden);
              changed();
            }}
          >
            {`${s.showHidden ? t('не показывать скрытые') : t('показать скрытые')}: ${view.hiddenCount}`}
          </button>
        )}
      </div>
    </>
  );
}

/** Пометить, с какой стороны у ряда есть ещё чипы (data-more): тот край гаснет. */
function markMore(el: HTMLElement): void {
  const left = el.scrollLeft > 1;
  const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  const more = left && right ? 'both' : left ? 'left' : right ? 'right' : '';
  if (more) el.dataset.more = more;
  else delete el.dataset.more;
}

/** Ряд чипов фильтра одной строкой: лишнее прокручивается вбок, колесо мыши над рядом тоже листает вбок (пока есть куда). */
function StatusFilter({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // чипы меняются с данными (числа, набор статусов): пометка краёв — после каждой перерисовки
  useEffect(() => {
    if (ref.current) markMore(ref.current);
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mark = () => markMore(el);
    // вертикальное колесо — вбок, пока ряд может сдвинуться; на краю колесо листает список как обычно
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0 || (e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      // колесо мыши в Firefox считает строками (deltaMode 1), страницами — 2
      el.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1);
    };
    const ro = new ResizeObserver(mark);
    ro.observe(el);
    el.addEventListener('scroll', mark, { passive: true });
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', mark);
      el.removeEventListener('wheel', wheel);
    };
  }, []);
  return (
    <div ref={ref} className={styles.runFilter} role="group" aria-label={t('Фильтр по статусу')}>
      {children}
    </div>
  );
}
