// Панель задачи поверх вкладки проекта (?task=ID; spec §11, макет Task.dc.html): заголовок и поля в шапке — правятся на
// месте (статус, спринт, исполнитель, оценка, тип, репо), «Ждёт» и «Блокирует» со статусом и исполнителем, блок «Работа»
// (мои запуски и сессии по задаче из local.json, ветка, PR) с «В работу ▸», описание и критерии приёмки с галочками,
// обсуждение. Оболочка (TaskDrawer в ProjectScreen) даёт затемнение, Esc и клик мимо; поля и редакторы гасят Esc у себя.
import { useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamComment, TeamDetail, TeamMember, TeamProject, TeamTask, TeamTaskStatus, TeamTaskType } from '@server/api-types';
import { errorText } from '../../../api';
import { addComment, teamKeys, useComments } from '../../../api/teamwork';
import { MdText } from '../../../components/MdText';
import { useConfirm } from '../../../components/ConfirmDialog';
import { useToast } from '../../../components/Toast';
import { useNow } from '../../../components/useNow';
import { feedTime, statusLabel } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { activeSprint, blocking, prLabel, STATUSES, TASK_TYPES, workState } from '../../../lib/teamwork/board';
import { plannedSprint } from '../../../lib/teamwork/backlog';
import { addCriterion, criteriaOf, criteriaTitle, descriptionOf, ESTIMATES, removeCriterion, toggleCriterion, withDescription } from '../../../lib/teamwork/task';
import { Loading } from '../../sessions/Loading';
import { cx } from '../parts';
import tw from '../Teamwork.module.css';
import { useProjectData, useTaskOps, type TaskOps } from './ops';
import { Assignee, columnText, MenuButton, memberName, useTaskHref } from './parts';
import { ToWorkButton } from './ToWork';
import styles from './Tasks.module.css';

export type TaskPanelProps = { team: string; project: string; id: string; onClose: () => void };

/** Esc внутри поля или редактора: только отмена правки, панель не закрывается. */
const keepEsc = (e: KeyboardEvent, cancel?: () => void) => {
  if (e.key !== 'Escape') return false;
  e.preventDefault();
  cancel?.();
  return true;
};

export function TaskPanel({ team, project, id, onClose }: TaskPanelProps) {
  const { td, p, tasks, loaded, members, readonly } = useProjectData(team, project);
  const ops = useTaskOps(team, project);
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const task = tasks.find((x) => x.id === id);
  const close = (
    <button type="button" className="btn ghost small" aria-label={t('Закрыть')} title={t('Закрыть (Esc)')} onClick={onClose}>×</button>
  );
  if (!loaded || !td || !p) return <Loading className={styles.hint} />;
  if (!task) {
    return (
      <>
        <div className={styles.dTop}><span className={styles.id}>{id}</span><span className={styles.grow} />{close}</div>
        <p className="msg">{t('Задачи {id} нет в проекте: её удалили или номер устарел.', { id })}</p>
      </>
    );
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast(t('Ссылка скопирована'));
    } catch {
      toast(window.location.href);
    }
  };
  const remove = async () => {
    if (!(await askConfirm(t('Удалить {id} «{title}» из репо команды? Файл уйдёт коммитом, в истории git он останется.', { id: task.id, title: task.title }), { ok: t('Удалить') }))) return;
    if (await ops.remove([task.id])) onClose();
  };
  return (
    <div className={styles.panel}>
      <div className={styles.dTop}>
        <span className={styles.id}>{task.id}</span>
        <span>{task.type}</span>
        <span className={styles.grow} />
        <button type="button" className="btn ghost small" onClick={() => void copy()}>{t('Скопировать ссылку')}</button>
        {!readonly && (
          <MenuButton
            label={t('Ещё действия задачи')}
            text="⋯"
            className="btn ghost small"
            right
            items={[{ key: 'del', label: t('Удалить…'), danger: true, onSelect: () => void remove() }]}
          />
        )}
        {close}
      </div>
      {task.error ? (
        <div className={styles.brokenBox}>
          <p className={styles.tFail}>{t('Не читается: {why}', { why: task.error })}</p>
          <p className={styles.mono}>{task.file}</p>
          <p className={styles.hint}>{t('Поправьте файл в репо команды руками: остальные задачи это не трогает.')}</p>
        </div>
      ) : (
        <>
          <Title task={task} ops={ops} readonly={readonly} />
          <Fields task={task} tasks={tasks} td={td} p={p} ops={ops} members={members} readonly={readonly} />
          <Work task={task} td={td} p={p} readonly={readonly} />
          <Description task={task} ops={ops} readonly={readonly} />
          <Criteria task={task} ops={ops} readonly={readonly} />
          <Comments team={team} project={project} task={task} members={members} readonly={readonly} />
          <Foot task={task} members={members} />
        </>
      )}
    </div>
  );
}

function Title({ task, ops, readonly }: { task: TeamTask; ops: TaskOps; readonly: boolean }) {
  const [edit, setEdit] = useState<string>();
  const save = () => {
    const v = edit?.trim();
    setEdit(undefined);
    if (v && v !== task.title) void ops.patch(task.id, { title: v }, (x) => ({ ...x, title: v }));
  };
  if (edit !== undefined) {
    return (
      <input
        className={styles.dTitleInput}
        aria-label={t('Заголовок')}
        value={edit}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setEdit(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (keepEsc(e, () => setEdit(undefined))) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }}
      />
    );
  }
  return (
    <h2
      className={styles.dTitle}
      tabIndex={readonly ? undefined : 0}
      title={readonly ? undefined : t('Нажмите, чтобы переименовать')}
      onClick={() => !readonly && setEdit(task.title)}
      onKeyDown={(e) => {
        if (!readonly && (e.key === 'Enter' || e.key === 'F2')) {
          e.preventDefault();
          setEdit(task.title);
        }
      }}
    >
      {task.title}
    </h2>
  );
}

function Fields({ task, tasks, td, p, ops, members, readonly }: { task: TeamTask; tasks: TeamTask[]; td: TeamDetail; p: TeamProject; ops: TaskOps; members: readonly TeamMember[]; readonly: boolean }) {
  const href = useTaskHref();
  const [dep, setDep] = useState('');
  const active = activeSprint(p.sprints);
  const planned = plannedSprint(p.sprints);
  const sprintOpts = [active, planned].filter((s): s is NonNullable<typeof s> => Boolean(s));
  const cur = task.sprint !== undefined ? p.sprints.find((s) => s.number === task.sprint) : undefined;
  const set = (patch: Parameters<TaskOps['patch']>[1], local: (x: TeamTask) => TeamTask) => void ops.patch(task.id, patch, local);
  const byId = new Map(tasks.map((x) => [x.id, x]));
  const blocks = blocking(task, tasks);
  const cands = tasks.filter((x) => x.id !== task.id && !task.blockedBy.includes(x.id) && !x.error);
  const depRow = (x: TeamTask | undefined, idText: string, onRemove?: () => void) => (
    <div key={idText} className={styles.depRow}>
      <Link to={href(idText)}>{idText}</Link>
      <span className={styles.tx}>{x?.title ?? t('нет в проекте')}</span>
      {x && <span className={cx(styles.depS, x.status === 'done' && styles.tOk)}>{columnText(x.status, td.columns)}{x.assignee ? ` · ${memberName(x.assignee, members).split(' ')[0]}` : ''}</span>}
      {onRemove && <button type="button" className={styles.x} aria-label={t('Убрать зависимость от {id}', { id: idText })} onClick={onRemove}>×</button>}
    </div>
  );
  return (
    <div className={styles.fields}>
      <label className={styles.lbl} htmlFor="tw-tp-status">{t('Статус')}</label>
      <span>
        <select id="tw-tp-status" className={styles.pick} value={task.status} disabled={readonly} onChange={(e) => { const v = e.target.value as TeamTaskStatus; set({ status: v }, (x) => ({ ...x, status: v })); }}>
          {STATUSES.map((s) => <option key={s} value={s}>{columnText(s, td.columns)}</option>)}
        </select>
      </span>
      <label className={styles.lbl} htmlFor="tw-tp-sprint">{t('Спринт')}</label>
      <span>
        <select
          id="tw-tp-sprint"
          className={styles.pick}
          value={task.sprint ?? ''}
          disabled={readonly}
         
          onChange={(e) => {
            const v = e.target.value ? Number(e.target.value) : null;
            set({ sprint: v }, (x) => {
              const n = { ...x };
              if (v === null) delete n.sprint;
              else n.sprint = v;
              return n;
            });
          }}
        >
          <option value="">{t('Бэклог')}</option>
          {sprintOpts.map((s) => <option key={s.number} value={s.number}>{s.title}{s.status === 'planned' ? ` · ${t('следующий')}` : ''}</option>)}
          {cur && !sprintOpts.includes(cur) && <option value={cur.number} disabled>{cur.title} · {t('закрыт')}</option>}
          {task.sprint !== undefined && !cur && <option value={task.sprint} disabled>{t('Спринт {n}', { n: task.sprint })}</option>}
        </select>
      </span>
      <label className={styles.lbl} htmlFor="tw-tp-who">{t('Исполнитель')}</label>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Assignee email={task.assignee} members={members} />
        <select id="tw-tp-who" className={styles.pick} value={task.assignee ?? ''} disabled={readonly} onChange={(e) => { const v = e.target.value || null; set({ assignee: v }, (x) => ({ ...x, assignee: v ?? undefined })); }}>
          <option value="">{t('Без исполнителя')}</option>
          {members.map((m) => <option key={m.email} value={m.email}>{m.name || m.email}</option>)}
          {task.assignee && !members.some((m) => m.email === task.assignee) && <option value={task.assignee}>{task.assignee}</option>}
        </select>
      </span>
      <label className={styles.lbl} htmlFor="tw-tp-est">{t('Оценка')}</label>
      <span>
        <select id="tw-tp-est" className={cx(styles.pick, styles.mono)} value={task.estimate ?? ''} disabled={readonly} onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; set({ estimate: v }, (x) => ({ ...x, estimate: v ?? undefined })); }}>
          <option value="">—</option>
          {[...new Set([...ESTIMATES, ...(task.estimate !== undefined ? [task.estimate] : [])])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </span>
      <label className={styles.lbl} htmlFor="tw-tp-type">{t('Тип')}</label>
      <span>
        <select id="tw-tp-type" className={styles.pick} value={task.type} disabled={readonly} onChange={(e) => { const v = e.target.value as TeamTaskType; set({ type: v }, (x) => ({ ...x, type: v })); }}>
          {TASK_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </span>
      <span className={styles.lbl}>{t('Репо и ветка')}</span>
      <span className={cx(styles.val, styles.mono)} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
        {p.repos.length > 1 && !readonly ? (
          <select className={cx(styles.pick, styles.mono)} aria-label={t('Репо кода')} value={task.repo ?? ''} onChange={(e) => { const v = e.target.value || null; set({ repo: v }, (x) => ({ ...x, repo: v ?? undefined })); }}>
            <option value="">—</option>
            {p.repos.map((r) => <option key={r.key} value={r.key}>{r.key}</option>)}
          </select>
        ) : (
          <span>{task.repo ?? p.repos[0]?.key ?? '—'}</span>
        )}
        <span title={task.branch}>{task.branch ? `· ${task.branch}` : <span className={styles.hint}>{t('· ветка появится при «В работу»')}</span>}</span>
      </span>
      <span className={styles.lbl}>PR</span>
      {task.pr ? (
        <span className={styles.val}>
          <a href={task.pr.url} target="_blank" rel="noreferrer">{prLabel(task.pr)}</a>
        </span>
      ) : (
        <span className={cx(styles.val, styles.muted)}>{t('появится сам, когда по ветке откроют PR')}</span>
      )}
      {task.covers.length > 0 && (
        <>
          <span className={styles.lbl}>{t('Требования')}</span>
          <span className={styles.val} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{task.covers.map((c) => <span key={c} className={styles.frc}>{c}</span>)}</span>
        </>
      )}
      <span className={styles.lbl}>{t('Ждёт')}</span>
      <span className={cx(styles.val, styles.wrap)}>
        {task.blockedBy.map((b) => depRow(byId.get(b), b, readonly ? undefined : () => set({ blockedBy: task.blockedBy.filter((x) => x !== b) }, (x) => ({ ...x, blockedBy: x.blockedBy.filter((y) => y !== b) }))))}
        {!task.blockedBy.length && <span className={styles.hint}>{t('ничего не ждёт')}</span>}
        {!readonly && cands.length > 0 && (
          <span className={styles.addDep}>
            <select className={styles.pick} aria-label={t('Новая зависимость')} value={dep} onChange={(e) => setDep(e.target.value)}>
              <option value="">{t('+ Зависимость')}</option>
              {cands.map((x) => <option key={x.id} value={x.id}>{x.id} · {x.title}</option>)}
            </select>
            {dep && <button type="button" className="btn ghost small" onClick={() => { const d = dep; setDep(''); set({ blockedBy: [...task.blockedBy, d] }, (x) => ({ ...x, blockedBy: [...x.blockedBy, d] })); }}>{t('Добавить')}</button>}
          </span>
        )}
      </span>
      <span className={styles.lbl}>{t('Блокирует')}</span>
      <span className={cx(styles.val, styles.wrap)}>
        {blocks.map((x) => depRow(x, x.id))}
        {!blocks.length && <span className={styles.hint}>{t('никого')}</span>}
      </span>
    </div>
  );
}

function Work({ task, td, p, readonly }: { task: TeamTask; td: TeamDetail; p: TeamProject; readonly: boolean }) {
  const now = useNow(30_000);
  const work = [...(task.work ?? [])].sort((a, b) => (a.at < b.at ? 1 : -1));
  return (
    <section aria-label={t('Работа')}>
      <h3 className={styles.cap}>{t('Работа агентов на этом компьютере')}</h3>
      {work.map((w) => {
        const st = workState(w);
        const to = w.kind === 'run' ? `/run/${encodeURIComponent(w.id)}` : `/sessions/${encodeURIComponent(w.id)}`;
        return (
          <div key={`${w.kind}:${w.id}`} className={styles.run}>
            <span className={cx(tw.dot, st === 'waiting' && tw.wait, st === 'failed' && tw.fail, st === 'done' && tw.ok)} aria-hidden="true" />
            <div className={styles.runMain}>
              <Link className={styles.runTitle} to={to}>{w.kind === 'session' ? '›_ ' : ''}{w.title ?? (w.kind === 'run' ? t('запуск') : t('сессия Claude Code'))}</Link>
              <span className={cx(styles.runMeta, st === 'waiting' && styles.tWait, st === 'failed' && styles.tFail)}>
                {w.kind === 'run' ? t('запуск') : t('сессия')} · {statusLabel(w.status ?? 'running')} · {feedTime(w.at, new Date(now))}
              </span>
            </div>
            <Link className="btn small" to={to}>{st === 'waiting' ? t('Ответить') : t('Открыть')}</Link>
          </div>
        );
      })}
      {!work.length && <p className={styles.hint}>{t('Запусков и сессий по задаче на этом компьютере нет.')}</p>}
      {!readonly && (
        <div className={styles.workLine}>
          <ToWorkButton td={td} p={p} task={task} small={false} />
          {task.branch && <span className={styles.mono}>{task.branch}</span>}
        </div>
      )}
    </section>
  );
}

function Description({ task, ops, readonly }: { task: TeamTask; ops: TaskOps; readonly: boolean }) {
  const desc = descriptionOf(task.body);
  const [edit, setEdit] = useState<string>();
  const save = () => {
    const v = edit ?? '';
    setEdit(undefined);
    if (v.trim() === desc.trim()) return;
    void ops.patch(task.id, (cur) => ({ body: withDescription(cur.body, v) }), (x) => ({ ...x, body: withDescription(x.body, v) }));
  };
  return (
    <section aria-label={t('Описание')}>
      <div className={styles.secHead}>
        <h3 className={styles.cap} style={{ margin: 0 }}>{t('Описание')}</h3>
        {!readonly && edit === undefined && <button type="button" className="btn ghost small" onClick={() => setEdit(desc)}>{t('Править')}</button>}
      </div>
      {edit !== undefined ? (
        <div className={styles.f}>
          <textarea
            className={styles.inp}
            aria-label={t('Описание')}
            style={{ minHeight: 140 }}
            value={edit}
            autoFocus
            onChange={(e) => setEdit(e.target.value)}
            onKeyDown={(e) => {
              if (keepEsc(e, () => setEdit(undefined))) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
          <div className={styles.dfoot}>
            <span className={styles.hint}>{t('markdown · ⌘Enter — сохранить, Esc — отмена')}</span>
            <span className={styles.grow} />
            <button type="button" className="btn ghost small" onClick={() => setEdit(undefined)}>{t('Отмена')}</button>
            <button type="button" className="btn small primary" onClick={save}>{t('Сохранить')}</button>
          </div>
        </div>
      ) : desc ? (
        <div className={styles.md}><MdText text={desc} /></div>
      ) : (
        <p className={styles.hint}>{t('Описания нет.')}</p>
      )}
    </section>
  );
}

function Criteria({ task, ops, readonly }: { task: TeamTask; ops: TaskOps; readonly: boolean }) {
  const list = criteriaOf(task.body);
  const [add, setAdd] = useState('');
  const toggle = (i: number, done: boolean) =>
    void ops.patch(task.id, (cur) => ({ body: toggleCriterion(cur.body, i, done) }), (x) => {
      const body = toggleCriterion(x.body, i, done);
      const c = criteriaOf(body);
      return { ...x, body, acceptance: { done: c.filter((y) => y.done).length, total: c.length } };
    });
  const remove = (i: number) => void ops.patch(task.id, (cur) => ({ body: removeCriterion(cur.body, i) }), (x) => ({ ...x, body: removeCriterion(x.body, i) }));
  const append = () => {
    const v = add.trim();
    if (!v) return;
    setAdd('');
    void ops.patch(task.id, (cur) => ({ body: addCriterion(cur.body, v) }), (x) => ({ ...x, body: addCriterion(x.body, v) }));
  };
  return (
    <section aria-label={t('Критерии приёмки')}>
      <h3 className={styles.cap}>{criteriaTitle(list)}</h3>
      {list.length > 0 && (
        <ul className={styles.checks}>
          {list.map((c, i) => (
            <li key={`${i}:${c.text}`}>
              <label>
                <input type="checkbox" checked={c.done} disabled={readonly} onChange={(e) => toggle(i, e.target.checked)} />
                <span className={cx(c.done && styles.done)}>{c.text}</span>
              </label>
              {!readonly && <button type="button" className={styles.x} aria-label={t('Убрать критерий «{text}»', { text: c.text })} onClick={() => remove(i)}>×</button>}
            </li>
          ))}
        </ul>
      )}
      {!list.length && readonly && <p className={styles.hint}>{t('Критериев нет.')}</p>}
      {!readonly && (
        <div className={styles.addCrit}>
          <input
            className={styles.inp}
            aria-label={t('Новый критерий')}
            placeholder={t('+ Критерий — Enter')}
            value={add}
            onChange={(e) => setAdd(e.target.value)}
            onKeyDown={(e) => {
              if (keepEsc(e, () => setAdd(''))) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                append();
              }
            }}
          />
        </div>
      )}
    </section>
  );
}

function Comments({ team, project, task, members, readonly }: { team: string; project: string; task: TeamTask; members: readonly TeamMember[]; readonly: boolean }) {
  const qc = useQueryClient();
  const q = useComments(team, project, task.id);
  const now = useNow(30_000);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const list: TeamComment[] = q.data ?? [];
  const send = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr('');
    try {
      const c = await addComment(team, project, task.id, v);
      qc.setQueryData<TeamComment[]>(teamKeys.comments(team, project, task.id), (all) => [...(all ?? []), c]);
      void qc.invalidateQueries({ queryKey: teamKeys.tasks(team, project) });
      void qc.invalidateQueries({ queryKey: teamKeys.team(team) });
      setText('');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t('Обсуждение')}>
      <h3 className={styles.cap}>{list.length ? t('Обсуждение · {n}', { n: list.length }) : t('Обсуждение')}</h3>
      {q.isError && <p className="msg err">{errorText(q.error)}</p>}
      {list.map((c) => {
        const m = members.find((x) => x.email === c.author);
        return (
          <div key={c.id} className={styles.cmt}>
            <Assignee email={c.author} members={members} />
            <div>
              <div className={styles.cmtH}><b>{m?.name || c.author}</b><span className={styles.meta}>{c.at ? feedTime(c.at, new Date(now)) : ''}</span></div>
              <p>{c.text}</p>
            </div>
          </div>
        );
      })}
      {!readonly && (
        <div className={styles.composer}>
          <label className={styles.lbl} htmlFor="tw-tp-comment">{t('Комментарий')}</label>
          <textarea
            id="tw-tp-comment"
            placeholder={t('Напишите команде…')}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (keepEsc(e, () => setText(''))) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {err && <p className="msg err">{err}</p>}
          <div className={styles.row}>
            <span className={styles.meta}>{t('уйдёт коммитом в репо команды · ⌘Enter')}</span>
            <button type="button" className="btn small" disabled={!text.trim() || busy} onClick={() => void send()}>{busy ? t('Отправляю…') : t('Отправить')}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function Foot({ task, members }: { task: TeamTask; members: readonly TeamMember[] }) {
  const now = useNow(30_000);
  const parts: string[] = [];
  if (task.updatedAt) parts.push(t('изменено: {who}{when}', { who: memberName(task.updatedBy, members) || '—', when: ` · ${feedTime(task.updatedAt, new Date(now))}` }));
  if (task.createdAt) parts.push(t('создано: {who}{when}', { who: memberName(task.createdBy, members) || '—', when: ` · ${feedTime(task.createdAt, new Date(now))}` }));
  return <p className={styles.foot} title={task.file}>{parts.join(' · ') || task.file}</p>;
}
