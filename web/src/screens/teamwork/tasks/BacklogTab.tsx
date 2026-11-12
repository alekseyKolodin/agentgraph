// Бэклог (spec §8.5, макет Backlog.dc.html): «Следующий спринт» сверху, если он запланирован, ниже — задачи без спринта по
// rank. Быстрое создание строкой «Новая задача» (Enter), перетаскивание внутри списка и между бэклогом и следующим спринтом,
// то же с клавиатуры — ⌥↑ ⌥↓ на строке и меню «Переместить…» у ручки. Выбор нескольких: «В следующий спринт», «Назначить»,
// «Удалить». Предупреждение, если задача стоит выше той, от которой зависит. Над списком — разбивка ТЗ агентом (SplitArea).
import { useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamMember, TeamProject, TeamTask } from '@server/api-types';
import { errorText } from '../../../api';
import { createSprint, teamKeys } from '../../../api/teamwork';
import { useConfirm } from '../../../components/ConfirmDialog';
import { useToast } from '../../../components/Toast';
import { t } from '../../../lib/i18n';
import { backlogHint, backlogTasks, nextSprintNote, nextSprintTasks, orderWarnings, orderWarningText, plannedSprint, selectedText, tasksAndPoints } from '../../../lib/teamwork/backlog';
import { activeSprint, dropMove, statusText, without, type Drop } from '../../../lib/teamwork/board';
import { dropIndex, dropRank, listMoves, samePlace } from '../../../lib/teamwork/task';
import { Loading } from '../../sessions/Loading';
import { cx } from '../parts';
import { MenuButton, useTaskHref, Assignee, type MenuEntry } from './parts';
import { useDnd, useKeepFocus, useProjectData, useTaskOps, type Dnd } from './ops';
import { SplitArea } from './SplitReview';
import { StartSprintButton } from './SprintsTab';
import styles from './Tasks.module.css';

export type BacklogTabProps = { team: string; project: string };

type ListKey = 'next' | 'backlog';

export function BacklogTab({ team, project }: BacklogTabProps) {
  const { td, p, tasks, loaded, members, readonly } = useProjectData(team, project);
  const ops = useTaskOps(team, project);
  const qc = useQueryClient();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const keep = useKeepFocus();
  const href = useTaskHref();
  const [sel, setSel] = useState<string[]>([]);
  const [quick, setQuick] = useState('');
  const [creating, setCreating] = useState(false);
  const planned = p ? plannedSprint(p.sprints) : undefined;
  const active = p ? activeSprint(p.sprints) : undefined;
  // нечитаемые задачи (битый файл, rank пустой) — в конце списка и не соседи при переносе: сервер их соседями не принимает
  const readable = (list: TeamTask[]) => list.filter((x) => !x.error);
  const broken = (list: TeamTask[]) => list.filter((x) => x.error);
  const backlogAll = backlogTasks(tasks);
  const nextAll = nextSprintTasks(tasks, planned);
  const backlog = readable(backlogAll);
  const next = readable(nextAll);
  const lists: Record<ListKey, TeamTask[]> = { next, backlog };
  const sprintOf = (l: ListKey): number | null => (l === 'next' ? planned?.number ?? null : null);

  const moveTo = (id: string, to: ListKey, index: number, from: ListKey) => {
    const list = lists[to];
    const change = to !== from ? { sprint: sprintOf(to) } : {};
    ops.move(id, dropMove(without(list, id), index, change));
    keep.focus(id);
  };
  const dnd = useDnd((id, from, at) => {
    const to = at.list as ListKey;
    const list = lists[to];
    if (to === 'next' && !planned) return;
    const index = dropIndex(list, id, at.index, at.after);
    if (to === from && samePlace(list, id, index)) return;
    moveTo(id, to, index, from as ListKey);
  });

  if (!td || !p || !loaded) return <Loading className={styles.hint} />;

  /** «Переместить…» строки: выше, ниже, в начало, в конец и в другой список. */
  const moveItems = (task: TeamTask, l: ListKey): MenuEntry[] => {
    const items: MenuEntry[] = listMoves(lists[l], task.id).map((m) => ({ key: m.key, label: m.label, hint: m.hint, onSelect: () => apply(task.id, m.drop) }));
    if (l === 'backlog' && planned) items.push({ key: 'to-next', label: t('В следующий спринт'), small: planned.title, onSelect: () => moveTo(task.id, 'next', next.length, 'backlog') });
    if (l === 'next') items.push({ key: 'to-backlog', label: t('В бэклог'), small: t('в начало бэклога'), onSelect: () => moveTo(task.id, 'backlog', 0, 'next') });
    if (!items.length) items.push({ note: t('Двигать некуда') });
    return [{ cap: t('Переместить {id}', { id: task.id }) }, ...items];
  };
  const apply = (id: string, drop: Drop) => {
    ops.move(id, drop);
    keep.focus(id);
  };
  const onRowKey = (e: KeyboardEvent, task: TeamTask, l: ListKey) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const m = listMoves(lists[l], task.id).find((x) => x.key === (e.key === 'ArrowUp' ? 'up' : 'down'));
    if (m) apply(task.id, m.drop);
  };

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const chosen = [...nextAll, ...backlogAll].filter((x) => sel.includes(x.id));
  const chosenNext = chosen.filter((x) => x.sprint !== undefined);

  const create = async () => {
    const title = quick.trim();
    if (!title || creating) return;
    setCreating(true);
    const r = await ops.create({ title });
    setCreating(false);
    if (r) setQuick('');
  };

  /** Выбранные — в конец следующего спринта по порядку; спринта нет — сначала он планируется. */
  const toNext = async () => {
    let n = planned?.number;
    if (n === undefined) {
      try {
        const s = await createSprint(team, project, {});
        n = s.number;
        void qc.invalidateQueries({ queryKey: teamKeys.project(team, project) });
      } catch (err) {
        toast(errorText(err));
        return;
      }
    }
    // запросы по одному: сосед каждой следующей задачи — предыдущая, на сервере у неё уже новый ранг
    let tail = next.filter((x) => !sel.includes(x.id));
    let last: Promise<unknown> | undefined;
    for (const x of chosen.filter((y) => y.sprint === undefined && !y.error)) {
      const d = dropMove(tail, tail.length, { sprint: n });
      last = ops.move(x.id, d, last);
      tail = [...tail, { ...x, rank: dropRank(d, x.rank) }];
    }
    setSel([]);
  };
  /** Выбранные из следующего спринта — в начало бэклога по порядку. */
  const toBacklog = () => {
    let head = backlog.filter((x) => !sel.includes(x.id));
    let last: Promise<unknown> | undefined;
    chosenNext.filter((x) => !x.error).forEach((x, i) => {
      const d = dropMove(head, i, { sprint: null });
      last = ops.move(x.id, d, last);
      head = [...head.slice(0, i), { ...x, rank: dropRank(d, x.rank) }, ...head.slice(i)];
    });
    setSel([]);
  };
  const assign = (email: string | null) => {
    for (const x of chosen) void ops.patch(x.id, { assignee: email }, (y) => ({ ...y, assignee: email ?? undefined }));
    setSel([]);
  };
  const remove = async () => {
    const ids = chosen.map((x) => x.id);
    if (!(await askConfirm(t('Удалить из репо команды: {ids}? Файлы задач уйдут коммитом, в истории git они останутся.', { ids: ids.join(', ') }), { ok: t('Удалить') }))) return;
    await ops.remove(ids);
    setSel([]);
  };

  const warnNext = orderWarnings(next);
  const warnBacklog = orderWarnings(backlog);
  return (
    <div ref={(el) => void (keep.box.current = el)}>
      <SplitArea team={td} project={p} tasks={tasks} readonly={readonly} />

      {planned ? (
        <section className={styles.sec} aria-label={t('Следующий спринт')}>
          <div className={styles.secH}>
            <h2>{t('Следующий спринт · {title}', { title: planned.title })}</h2>
            <span className={styles.quiet}>{t('запланирован')}</span>
            <span className={styles.meta}>{tasksAndPoints(next)}</span>
            <span className={styles.grow} />
            {active && <span className={styles.hint}>{nextSprintNote(active)}</span>}
            {!readonly && <StartSprintButton team={td} project={p} tasks={tasks} small />}
          </div>
          <TaskRows
            list="next" tasks={next} broken={broken(nextAll)} dnd={dnd} sel={sel} onToggle={toggle} members={members} href={href} readonly={readonly}
            warns={warnNext} moveItems={moveItems} onKey={onRowKey} empty={t('Перетащите сюда задачи из бэклога или выберите их и нажмите «В следующий спринт»')}
          />
          <Warns list={warnNext} />
        </section>
      ) : (
        <p className={styles.line}>
          {t('Следующего спринта нет.')}
          {!readonly && <PlanSprint team={td.slug} project={p} />}
        </p>
      )}

      <section className={styles.sec} aria-label={t('Бэклог')}>
        <div className={styles.secH}>
          <h2>{t('Бэклог')}</h2>
          <span className={styles.meta}>{backlogAll.length}</span>
          <span className={styles.grow} />
          <span className={styles.hint}>{backlogHint()}</span>
        </div>
        {!readonly && (
          <div className={styles.quick}>
            <label className={styles.sr} htmlFor="tw-quick">{t('Новая задача')}</label>
            <input
              id="tw-quick"
              value={quick}
              disabled={creating}
              placeholder={t('Новая задача — Enter создаст её внизу бэклога')}
              onChange={(e) => setQuick(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void create();
                }
              }}
            />
          </div>
        )}
        <TaskRows
          list="backlog" tasks={backlog} broken={broken(backlogAll)} dnd={dnd} sel={sel} onToggle={toggle} members={members} href={href} readonly={readonly}
          warns={warnBacklog} moveItems={moveItems} onKey={onRowKey} empty={t('В бэклоге пусто')} noTopBorder={!readonly}
        />
        <Warns list={warnBacklog} />
        {chosen.length > 0 && !readonly && (
          <div className={styles.bulk} role="region" aria-label={t('Действия с выбранными')}>
            <b>{selectedText(chosen.length)}</b>
            {chosen.length > chosenNext.length && <button type="button" className="btn small" onClick={() => void toNext()}>{t('В следующий спринт')}</button>}
            {chosenNext.length > 0 && <button type="button" className="btn small" onClick={toBacklog}>{t('В бэклог')}</button>}
            <MenuButton label={t('Назначить')} text={t('Назначить ▾')} className="btn small" up items={assignItems(members, assign)} />
            <button type="button" className="btn ghost small danger" onClick={() => void remove()}>{t('Удалить…')}</button>
            <button type="button" className="btn ghost small" onClick={() => setSel([])}>{t('Снять выбор')}</button>
          </div>
        )}
      </section>
    </div>
  );
}

const assignItems = (members: readonly TeamMember[], assign: (email: string | null) => void): MenuEntry[] => [
  ...members.map((m) => ({ key: m.email, label: m.name || m.email, small: m.name ? m.email : undefined, onSelect: () => assign(m.email) })),
  { sep: 's' },
  { key: 'none', label: t('Снять исполнителя'), onSelect: () => assign(null) },
];

function Warns({ list }: { list: ReturnType<typeof orderWarnings> }) {
  if (!list.length) return null;
  return (
    <ul className={styles.warns} aria-label={t('Порядок и зависимости')}>
      {list.map((w) => <li key={w.id} className={styles.tWait}>⚠ {orderWarningText(w)}</li>)}
    </ul>
  );
}

/** «Запланировать» следующий спринт: без него некуда переносить задачи из бэклога. */
function PlanSprint({ team, project }: { team: string; project: TeamProject }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={styles.linkBtn}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await createSprint(team, project.slug, {});
          void qc.invalidateQueries({ queryKey: teamKeys.project(team, project.slug) });
          void qc.invalidateQueries({ queryKey: teamKeys.team(team) });
        } catch (err) {
          toast(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {t('Запланировать')}
    </button>
  );
}

type RowsProps = {
  list: ListKey;
  /** Читаемые задачи по рангу: их можно двигать, индексы перетаскивания — по ним. */
  tasks: TeamTask[];
  /** Нечитаемые — в конце, без перетаскивания и меню. */
  broken: TeamTask[];
  dnd: Dnd;
  sel: string[];
  onToggle: (id: string) => void;
  members: readonly TeamMember[];
  href: (id: string) => string;
  readonly: boolean;
  warns: ReturnType<typeof orderWarnings>;
  moveItems: (task: TeamTask, l: ListKey) => MenuEntry[];
  onKey: (e: KeyboardEvent, task: TeamTask, l: ListKey) => void;
  empty: string;
  noTopBorder?: boolean;
};

function TaskRows({ list, tasks, broken, dnd, sel, onToggle, members, href, readonly, warns, moveItems, onKey, empty, noTopBorder }: RowsProps) {
  const zone = readonly ? {} : dnd.zone(list, tasks.length);
  return (
    <ul className={cx(styles.rows, styles.dropZone)} style={noTopBorder ? { borderTop: 0 } : undefined} {...zone}>
      {[...tasks, ...broken].map((x, i) => {
        const fixed = readonly || Boolean(x.error);
        const warn = warns.find((w) => w.id === x.id);
        const mark = x.error ? undefined : dnd.mark(list, i);
        return (
          <li
            key={x.id}
            data-task={x.id}
            tabIndex={0}
            aria-label={`${x.id} ${x.title}`}
            className={cx(styles.brow, sel.includes(x.id) && styles.sel, dnd.dragging === x.id && styles.dragging, mark === 'before' && styles.before, mark === 'after' && styles.after)}
            onKeyDown={fixed ? undefined : (e) => onKey(e, x, list)}
            {...(fixed ? {} : dnd.item(x.id, list, i))}
          >
            {fixed ? <span /> : <MenuButton label={t('Переместить {id}', { id: x.id })} title={t('Переместить… (или перетащите строку, ⌥↑ ⌥↓)')} text="⋮⋮" className={styles.grip} items={() => moveItems(x, list)} />}
            <input type="checkbox" aria-label={t('Выбрать {id}', { id: x.id })} checked={sel.includes(x.id)} disabled={readonly} onChange={() => onToggle(x.id)} />
            <span className={styles.id}>{x.id}</span>
            <Link className={styles.t} to={href(x.id)} title={x.error ? t('Не читается: {why}', { why: x.error }) : x.title} draggable={false}>
              {warn && <span className={styles.tWait} title={orderWarningText(warn)} aria-label={orderWarningText(warn)}>⚠ </span>}
              {x.error ? t('Не читается: {why}', { why: x.error }) : x.title}
            </Link>
            <span className={styles.ty}>{x.type}</span>
            <span className={styles.est} aria-label={x.estimate !== undefined ? t('Оценка {n}', { n: x.estimate }) : undefined}>{x.estimate ?? ''}</span>
            <Assignee email={x.assignee} members={members} />
            <span className={styles.stt}>{statusText(x.status)}</span>
          </li>
        );
      })}
      {!tasks.length && !broken.length && <li className={styles.rowsEmpty}>{empty}</li>}
    </ul>
  );
}

