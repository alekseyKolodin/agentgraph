// Доска спринта (spec §8.7, макет Main.dc.html): четыре колонки по статусам у задач активного спринта. Перетаскивание между
// колонками меняет статус, внутри колонки — порядок; с клавиатуры то же — ⌥↑ ⌥↓ ⌥← ⌥→ на карточке и меню «Переместить…»;
// фокус после переноса остаётся на карточке. Карточка: номер, заголовок, тип, исполнитель, оценка, критерии «2/5», значки
// запуска или сессии, PR и его состояние, «ждёт PAY-11», конфликт. Фильтры «Мои», исполнитель, тип — запоминаются в браузере.
// Нет активного спринта — «Спринт не запущен» и ссылка в бэклог.
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { TeamColumns, TeamConflict, TeamDetail, TeamMember, TeamProject, TeamTask, TeamTaskStatus, TeamTaskType } from '@server/api-types';
import { useTeamConflicts } from '../../../api/teamwork';
import { t } from '../../../lib/i18n';
import { LS } from '../../../lib/storage';
import { backlogTasks, plannedSprint } from '../../../lib/teamwork/backlog';
import {
  acceptanceText, activeSprint, assigneeChips, blockedLabel, boardColumns, columnName, DEFAULT_FILTER, dropMove, filterColumns, keyboardMove, noSprintText, openBlockers, parseFilter, prLabel,
  sameWho, sprintStrip, STATUSES, taskIndex, TASK_TYPES, toggleType, without, workBadge, workSignals, type BoardColumns, type BoardFilter, type Drop,
} from '../../../lib/teamwork/board';
import { columnMoves, dropIndex, samePlace, sideMove } from '../../../lib/teamwork/task';
import { Loading } from '../../sessions/Loading';
import { cx, SprintStrip } from '../parts';
import { projectPath } from '../shell';
import tw from '../Teamwork.module.css';
import { useDnd, useKeepFocus, useProjectData, useTaskOps, type Dnd } from './ops';
import { Assignee, MenuButton, useTaskHref, type MenuEntry } from './parts';
import { CloseSprintButton } from './SprintsTab';
import { ToWorkButton } from './ToWork';
import styles from './Tasks.module.css';

export type BoardTabProps = { team: string; project: string };

const filterKey = (team: string, project: string) => `agentgraph.teamwork.board.${team}.${project}`;

export function BoardTab({ team, project }: BoardTabProps) {
  const { td, p, tasks, loaded, error, me, members, readonly } = useProjectData(team, project);
  const ops = useTaskOps(team, project);
  const keep = useKeepFocus();
  const href = useTaskHref();
  const conflicts = useTeamConflicts(team, (td?.sync.conflicts ?? 0) > 0).data ?? [];
  const [filter, setFilterState] = useState<BoardFilter>(() => parseFilter(LS.get<unknown>(filterKey(team, project), DEFAULT_FILTER)));
  const [adding, setAdding] = useState(false);
  const setFilter = (f: BoardFilter) => {
    setFilterState(f);
    LS.set(filterKey(team, project), f);
  };
  const active = p ? activeSprint(p.sprints) : undefined;
  const allCols = active ? boardColumns(tasks, active.number) : undefined;
  // переносы считаются только по читаемым задачам: у битого файла rank пустой, сервер его соседом не принимает
  const cols = allCols ? mapCols(allCols, (l) => l.filter((x) => !x.error)) : undefined;
  const dnd = useDnd((id, from, at) => {
    if (!cols) return;
    const to = at.list as TeamTaskStatus;
    const list = cols[to];
    const index = dropIndex(list, id, at.index, at.after);
    if (to === from && samePlace(list, id, index)) return;
    apply(id, dropMove(without(list, id), index, to !== from ? { status: to } : {}));
  });
  function apply(id: string, drop: Drop) {
    void ops.move(id, drop);
    keep.focus(id);
  }

  // список задач не загрузился — ошибка уже над вкладками (ProjectScreen), здесь не ждём вечно
  if (!td || !p || !loaded) return error ? null : <Loading className={styles.hint} />;
  if (!active || !cols) {
    const note = noSprintText(plannedSprint(p.sprints));
    return (
      <div className={styles.emptyBox}>
        <h2>{note.title}</h2>
        <p>{note.hint}</p>
        <div className={styles.line}><Link className="btn small" to={projectPath(team, project, 'backlog')}>{t('В бэклог')}</Link></div>
      </div>
    );
  }

  const sprintList = STATUSES.flatMap((s) => allCols![s]);
  const strip = sprintStrip(sprintList);
  const chips = assigneeChips(sprintList, members, me);
  // нечитаемые карточки — в конце колонки, индексы перетаскивания читаемых совпадают с cols
  const shown = filterColumns(mapCols(cols, (l, s) => [...l, ...allCols![s].filter((x) => x.error)]), filter, me);
  const filtered = filter.who !== 'all' || filter.types.length > 0;
  const sig = workSignals(sprintList);
  const byId = taskIndex(tasks);

  const moveItems = (task: TeamTask): MenuEntry[] => {
    const col = cols[task.status];
    const i = col.findIndex((x) => x.id === task.id);
    const items: MenuEntry[] = [{ cap: t('Переместить {id}', { id: task.id }) }];
    const up = keyboardMove(col, task.id, -1);
    const down = keyboardMove(col, task.id, 1);
    if (up) items.push({ key: 'up', label: t('Выше'), hint: '⌥↑', onSelect: () => apply(task.id, up) });
    if (down) items.push({ key: 'down', label: t('Ниже'), hint: '⌥↓', onSelect: () => apply(task.id, down) });
    if (i > 0) items.push({ key: 'top', label: t('В начало колонки'), onSelect: () => apply(task.id, dropMove(without(col, task.id), 0)) });
    items.push({ sep: 'c' });
    for (const m of columnMoves(cols, task.status, td.columns)) items.push({ key: m.key, label: m.label, onSelect: () => apply(task.id, m.drop) });
    items.push({ sep: 'b' });
    items.push({ key: 'backlog', label: t('Убрать из спринта в бэклог'), small: t('в начало бэклога'), onSelect: () => toBacklog(task) });
    return items;
  };
  /** Из спринта — в начало бэклога, как «В бэклог» в бэклоге; карточка уходит с доски, фокус — на соседнюю в колонке. */
  const toBacklog = (task: TeamTask) => {
    const col = cols[task.status];
    const i = col.findIndex((x) => x.id === task.id);
    const near = col[i + 1] ?? col[i - 1];
    void ops.move(task.id, dropMove(backlogTasks(tasks).filter((x) => !x.error), 0, { sprint: null }));
    if (near) keep.focus(near.id);
    else keep.focus(`tw-col-${task.status}`, true);
  };
  const onCardKey = (e: KeyboardEvent, task: TeamTask) => {
    if (!e.altKey || readonly || task.error) return;
    let drop: Drop | undefined;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') drop = keyboardMove(cols[task.status], task.id, e.key === 'ArrowUp' ? -1 : 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') drop = sideMove(cols, STATUSES, task.id, e.key === 'ArrowLeft' ? -1 : 1)?.drop;
    else return;
    e.preventDefault();
    if (drop) apply(task.id, drop);
  };

  return (
    <div ref={(el) => void (keep.box.current = el)}>
      <div className={styles.sprint}>
        <div className={styles.sprintL}>
          <b>{active.title}</b>
          {active.goal && <span className={styles.goal} title={active.goal}>{active.goal}</span>}
        </div>
        <SprintStrip counts={strip.counts} label={strip.label} />
        <span className={styles.meta}>{strip.progress}</span>
        {!readonly && <CloseSprintButton team={td} project={p} tasks={tasks} sprint={active} />}
      </div>

      <div className={styles.filters}>
        <div className={styles.chips} role="group" aria-label={t('Исполнитель')}>
          {chips.map((c) => (
            <button key={typeof c.who === 'string' ? c.who : c.who.email} type="button" className={cx(styles.chip, sameWho(filter.who, c.who) && styles.on)} aria-pressed={sameWho(filter.who, c.who)} onClick={() => setFilter({ ...filter, who: c.who })}>
              {c.label}<span className={styles.n}>{c.count}</span>
            </button>
          ))}
        </div>
        <span className={styles.vsep} aria-hidden="true" />
        <div className={styles.chips} role="group" aria-label={t('Тип')}>
          {TASK_TYPES.map((x: TeamTaskType) => (
            <button key={x} type="button" className={cx(styles.chip, filter.types.includes(x) && styles.on)} aria-pressed={filter.types.includes(x)} onClick={() => setFilter(toggleType(filter, x))}>{x}</button>
          ))}
        </div>
        {filtered && <button type="button" className="btn ghost small" onClick={() => setFilter(DEFAULT_FILTER)}>{t('Сбросить')}</button>}
        {(sig.working > 0 || sig.waiting > 0) && (
          <div className={styles.signals}>
            {sig.working > 0 && <span><span className={tw.dot} aria-hidden="true" />{t('агент работает · {n}', { n: sig.working })}</span>}
            {sig.waiting > 0 && <span className={styles.tWait}><span className={cx(tw.dot, tw.wait)} aria-hidden="true" />{t('ждёт тебя · {n}', { n: sig.waiting })}</span>}
          </div>
        )}
      </div>

      <div className={styles.boardBox}>
        <div className={styles.board}>
          {STATUSES.map((s) => (
            <Column
              key={s} status={s} columns={td.columns} list={shown[s]} full={cols[s]} dnd={dnd} readonly={readonly || filtered}
              render={(x, i) => (
                <Card
                  key={x.id} task={x} index={i} status={s} td={td} p={p} members={members} href={href} byId={byId} conflicts={conflicts} dnd={dnd}
                  readonly={readonly} dragOff={filtered} moveItems={moveItems} onKey={onCardKey}
                />
              )}
              footer={s === 'todo' && !readonly ? (
                adding ? <AddCard onDone={() => setAdding(false)} onCreate={(title) => ops.create({ title, sprint: active.number })} /> : <button type="button" className={styles.add} onClick={() => setAdding(true)}>{t('+ Задача')}</button>
              ) : undefined}
            />
          ))}
        </div>
      </div>
      {filtered && <p className={styles.hint}>{t('С фильтром перетаскивание выключено: порядок считается по всем задачам колонки. Меню «Переместить…» и ⌥-стрелки работают.')}</p>}
    </div>
  );
}

function Column({ status, columns, list, full, dnd, readonly, render, footer }: {
  status: TeamTaskStatus; columns: TeamColumns; list: TeamTask[]; full: TeamTask[]; dnd: Dnd; readonly: boolean; render: (x: TeamTask, i: number) => ReactNode; footer?: ReactNode;
}) {
  const name = columnName(status, columns);
  const over = dnd.over?.list === status && Boolean(dnd.dragging);
  return (
    <section className={styles.col} aria-labelledby={`tw-col-${status}`}>
      <div className={styles.colH}>
        <h3 id={`tw-col-${status}`} tabIndex={-1}>{name}</h3>
        <span className={styles.n}>{list.length !== full.length ? `${list.length}/${full.length}` : full.length}</span>
      </div>
      <ul className={cx(styles.cards, over && styles.over)} aria-labelledby={`tw-col-${status}`} {...(readonly ? {} : dnd.zone(status, full.length))}>
        {list.map((x, i) => render(x, i))}
      </ul>
      {footer}
    </section>
  );
}

function Card({ task: x, index, status, td, p, members, href, byId, conflicts, dnd, readonly, dragOff, moveItems, onKey }: {
  task: TeamTask; index: number; status: TeamTaskStatus; td: TeamDetail; p: TeamProject; members: readonly TeamMember[]; href: (id: string) => string;
  byId: Map<string, TeamTask>; conflicts: TeamConflict[]; dnd: Dnd; readonly: boolean; dragOff: boolean; moveItems: (task: TeamTask) => MenuEntry[]; onKey: (e: KeyboardEvent, task: TeamTask) => void;
}) {
  const [open, setOpen] = useState(false);
  const badge = workBadge(x);
  const blockers = openBlockers(x, byId);
  const acc = acceptanceText(x);
  const conflict = conflicts.some((c) => c.task === x.id);
  const mark = dnd.mark(status, index);
  const tone = badge?.state === 'waiting' ? styles.wait : badge?.state === 'working' ? styles.live : undefined;
  const workHref = badge ? (badge.work.kind === 'run' ? `/run/${encodeURIComponent(badge.work.id)}` : `/sessions/${encodeURIComponent(badge.work.id)}`) : '';
  const canWork = !readonly && !x.error && (x.status === 'todo' || x.status === 'in_progress') && !(badge && badge.state !== 'failed');
  return (
    <li
      data-task={x.id}
      tabIndex={0}
      aria-label={`${x.id} ${x.title}`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
      className={cx(styles.card, tone, x.status === 'done' && styles.done, x.error && styles.broken, open && styles.open, dnd.dragging === x.id && styles.dragging, mark === 'before' && styles.before, mark === 'after' && styles.after)}
      onKeyDown={(e) => onKey(e, x)}
      {...(readonly || dragOff || x.error ? {} : dnd.item(x.id, status, index))}
    >
      <div className={styles.cardTop}>
        <span className={styles.id}>{x.id}</span>
        <span>{x.type}</span>
        <span className={styles.grow} />
        {x.estimate !== undefined && <span className={styles.est} aria-label={t('Оценка {n}', { n: x.estimate })}>{x.estimate}</span>}
        <Assignee email={x.assignee} members={members} />
      </div>
      <Link className={styles.cardT} to={href(x.id)} draggable={false}>{x.error ? t('Не читается: {why}', { why: x.error }) : x.title}</Link>
      {(acc || x.pr || blockers.length > 0 || conflict || x.branch) && (
        <div className={styles.cardM}>
          {acc && <span title={t('Критерии приёмки')}>{x.acceptance.done === x.acceptance.total ? '☑' : '☐'} {acc}</span>}
          {x.pr ? (
            <>
              <a href={x.pr.url} target="_blank" rel="noreferrer" draggable={false}>{prParts(prLabel(x.pr)).name}</a>
              <span className={x.pr.state === 'merged' ? styles.tOk : x.pr.state === 'closed' ? styles.tFail : styles.q}>{prParts(prLabel(x.pr)).state}</span>
            </>
          ) : x.branch && x.status !== 'done' ? <span className={styles.q} title={x.branch}>{x.branch.length > 28 ? `${x.branch.slice(0, 28)}…` : x.branch}</span> : null}
          {blockers.length > 0 && <span className={styles.q}>{blockedLabel(blockers)}</span>}
          {conflict && <span className={styles.tWait} title={t('Конфликт синхронизации: разберите его в строке синхронизации')}>{t('конфликт')}</span>}
        </div>
      )}
      {badge && (
        <div className={styles.agent}>
          <span className={cx(tw.dot, badge.state === 'waiting' && tw.wait, badge.state === 'failed' && tw.fail)} aria-hidden="true" />
          <Link to={workHref} className={badge.state === 'waiting' ? styles.tWait : badge.state === 'failed' ? styles.tFail : undefined} title={badge.text} draggable={false}>{badge.text}</Link>
        </div>
      )}
      {!readonly && (
        <div className={cx(styles.cardAct, !(badge?.state === 'waiting' || badge?.state === 'failed') && styles.hoverOnly)}>
          {canWork && <ToWorkButton td={td} p={p} task={x} onOpen={setOpen} />}
          {badge?.state === 'waiting' && <Link className="btn small" to={workHref} draggable={false}>{t('Ответить')}</Link>}
          {badge?.state === 'failed' && <Link className="btn ghost small" to={workHref} draggable={false}>{t('Открыть запуск')}</Link>}
          <span className={styles.grow} />
          {!x.error && <MenuButton label={t('Переместить {id}', { id: x.id })} title={t('Переместить… (или перетащите карточку, ⌥-стрелки)')} text="⋯" className="btn ghost small" right items={() => moveItems(x)} onOpen={setOpen} />}
        </div>
      )}
    </li>
  );
}

const mapCols = (c: BoardColumns, fn: (list: TeamTask[], s: TeamTaskStatus) => TeamTask[]): BoardColumns =>
  ({ todo: fn(c.todo, 'todo'), in_progress: fn(c.in_progress, 'in_progress'), review: fn(c.review, 'review'), done: fn(c.done, 'done') });

/** «PR #41 открыт» → ссылка «PR #41» и состояние отдельно. */
const prParts = (label: string): { name: string; state: string } => {
  const i = label.lastIndexOf(' ');
  return i < 0 ? { name: label, state: '' } : { name: label.slice(0, i), state: label.slice(i + 1) };
};

/** Строка «+ Задача» в колонке: Enter создаёт, поле очищается только после ответа сервера — при ошибке заголовок остаётся. */
function AddCard({ onCreate, onDone }: { onCreate: (title: string) => Promise<unknown>; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <input
      className={styles.addInput}
      aria-label={t('Новая задача в спринт')}
      placeholder={t('Новая задача — Enter, Esc — отмена')}
      value={title}
      autoFocus
      // не disabled: отключённое поле теряет фокус, и после ответа (или ошибки) печатать дальше было бы некуда
      readOnly={busy}
      aria-busy={busy || undefined}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => !title.trim() && onDone()}
      onKeyDown={async (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onDone();
        }
        if (e.key === 'Enter' && title.trim() && !busy) {
          e.preventDefault();
          setBusy(true);
          const created = await onCreate(title.trim());
          setBusy(false);
          if (created) setTitle('');
        }
      }}
    />
  );
}

