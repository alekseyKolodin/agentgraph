// Секция «Flow» сайдбара (ui/app.js renderFlowList, wireFlowDrag, foldAll, wireSideSearch): папки, поиск, сворачивание,
// перетаскивание flow на папку, «Новый flow». Поиск живёт в памяти вкладки; свёрнутость папок — fold.ts.
import { useState, type DragEvent } from 'react';
import { useMatch } from 'react-router';
import type { FlowListItem } from '@server/api-types';
import { useFlows } from '../../api';
import { useMemoryState } from '../useMemoryState';
import { flowMatches, searchWords } from '../../lib/search';
import { t } from '../../lib/i18n';
import { NewFlowDialog } from '../../screens/flow/NewFlowDialog';
import { useMoveFlow, useOpenFlow } from '../../screens/flow/nav';
import { useFlowStore } from '../../screens/flow/store';
import { isOpen, setOpen, useFold } from './fold';
import styles from './Sidebar.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

const svg = (d: string) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const ICON = {
  folder: svg('M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z'),
  foldAll: svg('M3 8h10M5.5 1.5L8 4l2.5-2.5M5.5 14.5L8 12l2.5 2.5'),
  unfoldAll: svg('M3 8h10M5.5 4L8 1.5 10.5 4M5.5 12L8 14.5l2.5-2.5'),
  caret: svg('M4.5 6l3.5 3.5L11.5 6'),
  hide: svg('M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM2.5 13.5l11-11'),
  show: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" />
      <circle cx="8" cy="8" r="1.8" />
    </svg>
  ),
  trash: svg('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5'),
};

const byRu = (a: string, b: string) => a.localeCompare(b, 'ru');

/** Папки и flow после поиска: папки по алфавиту, корень — после них. */
function grouped(flows: FlowListItem[], query: string) {
  const words = searchWords(query);
  const found = words.length ? flows.filter((f) => flowMatches(f, words)) : flows;
  const byFolder = new Map<string, FlowListItem[]>();
  for (const f of found) {
    const k = f.folder || '';
    if (!byFolder.has(k)) byFolder.set(k, []);
    byFolder.get(k)!.push(f);
  }
  const folders = [...byFolder.keys()].filter(Boolean).sort(byRu);
  return { searching: words.length > 0, found, byFolder, folders };
}

/** Папка открытого flow (не черновика): раскрыта и без записи в expanded. */
function useActiveFolder(flows: FlowListItem[]): string | null {
  const st = useFlowStore();
  if (!st.flow || st.flow.draft) return null;
  const folder = st.flow.folder ?? flows.find((f) => f.name === st.flow!.name)?.folder;
  return folder ? `folder:${folder}` : null;
}

/** Кнопки в шапке секции: свернуть/развернуть все папки и «Новый flow». */
export function FlowSectionActions() {
  useFold();
  const flows = useFlows().data ?? [];
  const [query] = useMemoryState('side.flowQuery', '');
  const active = useActiveFolder(flows);
  const [newOpen, setNewOpen] = useState(false);
  const { searching, folders } = grouped(flows, query);
  const keysOf = folders.map((f) => `folder:${f}`);
  const anyOpen = keysOf.some((k) => searching || isOpen(k, active));
  const foldAll = () => {
    for (const k of keysOf) setOpen(k, !anyOpen);
  };
  return (
    <div className={styles.sideActions}>
      {keysOf.length > 0 && (
        <button className={cx('btn small ghost icon-btn', styles.fold)} title={anyOpen ? t('Свернуть все папки') : t('Развернуть все папки')} onClick={foldAll}>
          {anyOpen ? ICON.foldAll : ICON.unfoldAll}
        </button>
      )}
      <button className="btn small" title={t('Создать flow')} onClick={() => setNewOpen(true)}>{t('Новый flow')}</button>
      <NewFlowDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

export function FlowList() {
  useFold();
  const flowsQ = useFlows();
  const flows = flowsQ.data ?? [];
  const [query, setQuery] = useMemoryState('side.flowQuery', '');
  const st = useFlowStore();
  const routeName = useMatch('/flow/:name')?.params.name;
  const activeName = st.flow && !st.flow.draft ? routeName : undefined;
  const active = useActiveFolder(flows);
  const openFlow = useOpenFlow();
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const { searching, found, byFolder, folders } = grouped(flows, query);
  // подсказки поля «папка» — по всем flow, а не по найденным
  const allFolders = [...new Set(flows.map((f) => f.folder).filter(Boolean))].sort(byRu);

  const move = useMoveFlow();
  const moveTo = (name: string, folder: string) => move(name, folder, flows.find((f) => f.name === name)?.folder || '');

  const stop = () => {
    setDragged(null);
    setDropOn(null);
  };
  const over = (target: string) => (e: DragEvent) => {
    if (!dragged) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropOn !== target) setDropOn(target);
  };
  const drop = (folder: string) => (e: DragEvent) => {
    if (!dragged) return;
    e.preventDefault();
    e.stopPropagation();
    const name = dragged;
    stop();
    void moveTo(name, folder);
  };

  const item = (f: FlowListItem) => (
    <li
      key={f.name}
      draggable
      className={cx(!f.valid && styles.invalid, activeName === f.name && styles.active)}
      title={f.valid ? f.description || t('{n} этапов · {condition}', { n: f.phases?.length ?? 0, condition: String(f.condition) }) : f.error}
      onClick={() => void openFlow(f.name)}
      onDragStart={(e) => {
        setDragged(f.name);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', f.name);
      }}
      onDragEnd={stop}
    >
      <span className={styles.name}>{f.name}</span>
      {!f.valid && <span className={styles.sub}>{t('ошибка')}</span>}
    </li>
  );

  return (
    <>
      {/* поле поиска стоит вне перерисовываемого списка; Esc очищает */}
      <input
        className={styles.sideSearch}
        type="search"
        placeholder={t('Найти flow…')}
        autoComplete="off"
        spellCheck={false}
        title={t('Все слова должны найтись в имени, папке или описании flow. Esc — очистить')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !query) return;
          e.preventDefault();
          setQuery('');
        }}
      />
      <div
        className={cx(styles.sideBody, styles.flowList, dragged && styles.dragging)}
        onDragOver={over('')}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null);
        }}
        onDrop={drop('')}
      >
        {folders.map((folder) => {
          const key = `folder:${folder}`;
          const open = searching || isOpen(key, active);
          const list = byFolder.get(folder)!;
          return (
            <div key={key} className={cx(styles.grp, !open && styles.collapsed, dropOn === key && styles.dropTarget)} onDragOver={over(key)} onDrop={drop(folder)}>
              <button className={styles.grpHead} aria-expanded={open} title={`flows/${folder}/`} onClick={() => setOpen(key, !open)}>
                <span className={styles.caret}>{ICON.caret}</span>
                <span className={styles.grpIcon}>{ICON.folder}</span>
                <span className={styles.grpName}>{folder}</span>
                <span className={styles.grpCount}>{list.length}</span>
              </button>
              <ul className={styles.list}>{list.map(item)}</ul>
            </div>
          );
        })}
        <ul className={cx(styles.list, styles.root, dropOn === '' && dragged && styles.dropTarget)}>{(byFolder.get('') || []).map(item)}</ul>
        {flowsQ.isSuccess && !flows.length && <p className={`${styles.sideEmpty} muted`}>{t('flow пока нет')}</p>}
        {flows.length > 0 && !found.length && <p className={`${styles.sideEmpty} muted`}>{t('Ничего не нашлось')}</p>}
      </div>
      <datalist id="folder-options">
        {allFolders.map((f) => <option key={f} value={f} />)}
      </datalist>
    </>
  );
}
