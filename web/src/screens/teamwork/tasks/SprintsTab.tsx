// Спринты (spec §8.6): «Запустить спринт» — название (по умолчанию «Спринт N»), цель, задачи; запланированный спринт
// становится активным, задачи получают «К работе». Предупреждение, если у задачи спринта предшественник не готов и не входит
// в спринт. «Завершить спринт» — итог «готово N из M» и выбор для незавершённых: «В следующий спринт» или «В бэклог».
// Ниже — история закрытых спринтов с целью и итогом.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDetail, TeamProject, TeamSprint, TeamTask } from '@server/api-types';
import { errorText } from '../../../api';
import { closeSprint, createSprint, startSprint, teamKeys } from '../../../api/teamwork';
import { useToast } from '../../../components/Toast';
import { locale, t } from '../../../lib/i18n';
import { backlogTasks, nextSprintTasks, plannedSprint, tasksAndPoints } from '../../../lib/teamwork/backlog';
import { activeSprint, sprintStrip, sprintTasks, statusText } from '../../../lib/teamwork/board';
import {
  closedSprints, closeResult, closeSummary, nextSprintNumber, openCountText, sprintDefaultTitle, sprintResultText, startPatches, startWarnings, startWarningText, type CarryChoice,
} from '../../../lib/teamwork/sprint';
import { Loading } from '../../sessions/Loading';
import { useReturnFocus } from '../focus';
import { cx, SprintStrip } from '../parts';
import { projectPath } from '../shell';
import { useProjectData } from './ops';
import { useTaskHref } from './parts';
import styles from './Tasks.module.css';

export type SprintsTabProps = { team: string; project: string };

export function SprintsTab({ team, project }: SprintsTabProps) {
  const { td, p, tasks, loaded, error, readonly, members } = useProjectData(team, project);
  const href = useTaskHref();
  // список задач не загрузился — ошибка уже над вкладками (ProjectScreen), здесь не ждём вечно
  if (!td || !p || !loaded) return error ? null : <Loading className={styles.hint} />;
  const active = activeSprint(p.sprints);
  const planned = plannedSprint(p.sprints);
  const closed = closedSprints(p.sprints);
  const activeTasks = active ? sprintTasks(tasks, active.number) : [];
  const strip = sprintStrip(activeTasks);
  const next = nextSprintTasks(tasks, planned);
  return (
    <div className={styles.sprints}>
      {active && (
        <section className={styles.scard} aria-label={t('Активный спринт')}>
          <div className={styles.scardH}>
            <b>{active.title}</b>
            <span className={styles.quiet}>{t('активен')}</span>
            <span className={styles.grow} />
            <Link className="btn ghost small" to={projectPath(team, project, 'board')}>{t('Доска')}</Link>
            {!readonly && <CloseSprintButton team={td} project={p} tasks={tasks} sprint={active} />}
          </div>
          {active.goal && <p>{active.goal}</p>}
          <div className={styles.line}>
            <SprintStrip counts={strip.counts} label={strip.label} />
            <span className={styles.meta}>{strip.progress}</span>
            {active.startedAt && <span className={styles.hint}>{t('запущен {when}', { when: dateText(active.startedAt) })}{active.startedBy ? ` · ${nameOf(active.startedBy, members)}` : ''}</span>}
          </div>
        </section>
      )}
      {planned && (
        <section className={styles.scard} aria-label={t('Следующий спринт')}>
          <div className={styles.scardH}>
            <b>{planned.title}</b>
            <span className={styles.quiet}>{t('запланирован')}</span>
            <span className={styles.meta}>{tasksAndPoints(next)}</span>
            <span className={styles.grow} />
            <Link className="btn ghost small" to={projectPath(team, project, 'backlog')}>{t('Бэклог')}</Link>
            {!readonly && <StartSprintButton team={td} project={p} tasks={tasks} small />}
          </div>
          {planned.goal && <p>{planned.goal}</p>}
        </section>
      )}
      {!active && !planned && (
        <div className={styles.emptyBox}>
          <h2>{t('Спринт не запущен')}</h2>
          <p>{t('Спринт — именованный набор задач, взятых в работу, без дат. Соберите задачи в бэклоге и запустите спринт.')}</p>
          {!readonly && <div className={styles.line}><StartSprintButton team={td} project={p} tasks={tasks} /></div>}
        </div>
      )}
      {active && !planned && !readonly && (
        <p className={styles.line}>{t('Следующий спринт можно собрать заранее: запланируйте его и перетащите задачи в бэклоге.')} <PlanButton team={team} project={project} /></p>
      )}

      <section aria-label={t('История спринтов')}>
        <h2 className={styles.cap}>{t('Закрытые спринты')}</h2>
        {closed.length ? (
          <ul className={styles.hist}>
            {closed.map((s) => (
              <li key={s.number}>
                <b>{s.title}</b>
                <span className={styles.meta}>{sprintResultText(s)}</span>
                {s.goal && <span className={styles.g2}>{s.goal}</span>}
                {s.result && (
                  <span className={styles.ids}>
                    {s.result.done.map((id) => <Link key={id} to={href(id)} className={styles.tOk}>{id}</Link>)}
                    {s.result.carried.map((id) => <Link key={id} to={href(id)} title={t('перенесена в следующий спринт')}>→{id}</Link>)}
                    {s.result.returned.map((id) => <Link key={id} to={href(id)} title={t('вернулась в бэклог')}>↩{id}</Link>)}
                  </span>
                )}
                {s.closedAt && <span className={styles.hint} style={{ gridColumn: '1 / -1' }}>{t('закрыт {when}', { when: dateText(s.closedAt) })}{s.closedBy ? ` · ${nameOf(s.closedBy, members)}` : ''}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.hint}>{t('Закрытых спринтов пока нет.')}</p>
        )}
      </section>
    </div>
  );
}

const dateText = (iso: string): string => {
  const d = new Date(iso);
  // локаль интерфейса, а не браузера: в английском интерфейсе на русской системе — «12 Nov 2026»
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
};
const nameOf = (email: string, members: TeamDetail['memberList']): string => members.find((m) => m.email === email)?.name || email;

const invalidateProject = (qc: ReturnType<typeof useQueryClient>, team: string, project: string) => {
  void qc.invalidateQueries({ queryKey: teamKeys.project(team, project) });
  void qc.invalidateQueries({ queryKey: teamKeys.team(team) });
  void qc.invalidateQueries({ queryKey: teamKeys.projects(team) });
};

function PlanButton({ team, project }: { team: string; project: string }) {
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
          await createSprint(team, project, {});
          invalidateProject(qc, team, project);
        } catch (err) {
          toast(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {t('Запланировать спринт')}
    </button>
  );
}

/** «Запустить спринт…»: при активном спринте недоступна, с подсказкой почему. */
export function StartSprintButton({ team, project, tasks, small }: { team: TeamDetail; project: TeamProject; tasks: TeamTask[]; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const active = activeSprint(project.sprints);
  const planned = plannedSprint(project.sprints);
  return (
    <>
      <button
        type="button"
        className={cx('btn', small && 'small', !active && 'primary')}
        aria-disabled={active ? 'true' : undefined}
        title={active ? t('Активен «{title}»: сначала завершите его', { title: active.title }) : undefined}
        onClick={() => !active && setOpen(true)}
      >
        {planned ? t('Запустить', undefined, 'sprint') : t('Запустить спринт…')}
      </button>
      {open && <StartSprintDialog team={team} project={project} tasks={tasks} onClose={() => setOpen(false)} />}
    </>
  );
}

function StartSprintDialog({ team, project, tasks, onClose }: { team: TeamDetail; project: TeamProject; tasks: TeamTask[]; onClose: () => void }) {
  const qc = useQueryClient();
  const dlg = useRef<HTMLDialogElement>(null);
  const planned = plannedSprint(project.sprints);
  const n = planned?.number ?? nextSprintNumber(project.sprints);
  const [title, setTitle] = useState(planned?.title ?? sprintDefaultTitle(n));
  const [goal, setGoal] = useState(planned?.goal ?? '');
  const [extra, setExtra] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useReturnFocus(dlg);
  useEffect(() => {
    dlg.current?.showModal();
  }, []);
  const fixed = nextSprintTasks(tasks, planned);
  const backlog = backlogTasks(tasks).filter((x) => !x.error);
  const chosen = [...fixed, ...backlog.filter((x) => extra.includes(x.id))];
  const warns = startWarnings(chosen, tasks);
  const reset = startPatches(chosen).length;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const body = { title: title.trim() || sprintDefaultTitle(n), goal: goal.trim(), tasks: extra };
      if (planned) await startSprint(team.slug, project.slug, planned.number, body);
      else await createSprint(team.slug, project.slug, { ...body, start: true });
      invalidateProject(qc, team.slug, project.slug);
      void qc.invalidateQueries({ queryKey: teamKeys.tasks(team.slug, project.slug) });
      onClose();
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog ref={dlg} className={styles.dlg} aria-labelledby="tw-start-title" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <form className={styles.dlgBody} onSubmit={(e) => void submit(e)}>
        <h2 id="tw-start-title">{planned ? t('Запустить «{title}»', { title: planned.title }) : t('Запустить спринт')}</h2>
        <div className={styles.f}>
          <label htmlFor="tw-sp-title">{t('Название')}</label>
          <input id="tw-sp-title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className={styles.f}>
          <label htmlFor="tw-sp-goal">{t('Цель')}</label>
          <input id="tw-sp-goal" value={goal} placeholder={t('Что будет работать к концу спринта')} onChange={(e) => setGoal(e.target.value)} />
        </div>
        <div className={styles.f}>
          <span className={styles.lbl}>{t('Задачи · {sum}', { sum: tasksAndPoints(chosen) })}</span>
          <ul className={styles.pickList}>
            {fixed.map((x) => (
              <li key={x.id} title={t('Задача уже в этом спринте. Чтобы убрать её, перенесите задачу в бэклог')}>
                <input type="checkbox" checked disabled aria-label={x.id} />
                <span className={styles.id}>{x.id}</span>
                <span className={styles.t}>{x.title}</span>
                <span className={styles.ty}>{statusText(x.status)}</span>
              </li>
            ))}
            {backlog.map((x) => (
              <li key={x.id}>
                <input type="checkbox" id={`tw-sp-${x.id}`} checked={extra.includes(x.id)} onChange={() => setExtra((s) => (s.includes(x.id) ? s.filter((y) => y !== x.id) : [...s, x.id]))} />
                <span className={styles.id}>{x.id}</span>
                <label className={styles.t} htmlFor={`tw-sp-${x.id}`}>{x.title}</label>
                <span className={styles.ty}>{t('бэклог')}</span>
              </li>
            ))}
            {!fixed.length && !backlog.length && <li className={styles.rowsEmpty} style={{ display: 'block' }}>{t('Задач нет: спринт запустится пустым, задачи можно добавить потом')}</li>}
          </ul>
        </div>
        {warns.length > 0 && (
          <ul className={styles.warns} aria-label={t('Ждут задач вне спринта')}>
            {warns.map((w) => <li key={w.id} className={styles.tWait}>⚠ {startWarningText(w)}</li>)}
          </ul>
        )}
        {reset > 0 && <p className={styles.hint}>{t('Статус сбросится на «К работе» у задач: {n}', { n: reset })}</p>}
        {err && <p className="msg err">{err}</p>}
        <div className={styles.dfoot}>
          <span className={styles.grow} />
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? t('Запускаю…') : t('Запустить', undefined, 'sprint')}</button>
        </div>
      </form>
    </dialog>
  );
}

/** «Завершить спринт…» с итогом и выбором для незавершённых задач. */
export function CloseSprintButton({ team, project, tasks, sprint }: { team: TeamDetail; project: TeamProject; tasks: TeamTask[]; sprint: TeamSprint }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn small" onClick={() => setOpen(true)}>{t('Завершить спринт')}</button>
      {open && <CloseSprintDialog team={team} project={project} tasks={tasks} sprint={sprint} onClose={() => setOpen(false)} />}
    </>
  );
}

function CloseSprintDialog({ team, project, tasks, sprint, onClose }: { team: TeamDetail; project: TeamProject; tasks: TeamTask[]; sprint: TeamSprint; onClose: () => void }) {
  const qc = useQueryClient();
  const dlg = useRef<HTMLDialogElement>(null);
  const [choices, setChoices] = useState<Record<string, CarryChoice>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useReturnFocus(dlg);
  useEffect(() => {
    dlg.current?.showModal();
  }, []);
  const list = sprintTasks(tasks, sprint.number).filter((x) => !x.error);
  const sum = closeSummary(list);
  const planned = plannedSprint(project.sprints);
  const result = closeResult(list, choices);
  const setAll = (c: CarryChoice) => setChoices(Object.fromEntries(sum.open.map((x) => [x.id, c])));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await closeSprint(team.slug, project.slug, sprint.number, { next: result.carried });
      invalidateProject(qc, team.slug, project.slug);
      void qc.invalidateQueries({ queryKey: teamKeys.tasks(team.slug, project.slug) });
      onClose();
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog ref={dlg} className={styles.dlg} aria-labelledby="tw-close-title" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <form className={styles.dlgBody} onSubmit={(e) => void submit(e)}>
        <h2 id="tw-close-title">{t('Завершить «{title}»', { title: sprint.title })}</h2>
        <p>{t('Итог: {text}', { text: sum.text })}{sprint.goal ? ` · ${sprint.goal}` : ''}</p>
        {sum.open.length > 0 ? (
          <div className={styles.f}>
            <div className={styles.line}>
              <span className={styles.lbl}>{openCountText(sum.open.length)}</span>
              <span className={styles.grow} />
              <button type="button" className="btn ghost small" onClick={() => setAll('next')}>{t('Все в следующий')}</button>
              <button type="button" className="btn ghost small" onClick={() => setAll('backlog')}>{t('Все в бэклог')}</button>
            </div>
            <ul className={styles.pickList}>
              {sum.open.map((x) => {
                const c = choices[x.id] ?? 'next';
                return (
                  <li key={x.id} className={styles.carry}>
                    <span className={styles.id}>{x.id}</span>
                    <span className={styles.t} title={x.title}>{x.title} <span className={styles.ty}>· {statusText(x.status)}</span></span>
                    <span className={styles.seg} role="group" aria-label={t('Куда {id}', { id: x.id })}>
                      <button type="button" className={cx(c === 'next' && styles.on)} aria-pressed={c === 'next'} onClick={() => setChoices((s) => ({ ...s, [x.id]: 'next' }))}>{t('В следующий спринт')}</button>
                      <button type="button" className={cx(c === 'backlog' && styles.on)} aria-pressed={c === 'backlog'} onClick={() => setChoices((s) => ({ ...s, [x.id]: 'backlog' }))}>{t('В бэклог')}</button>
                    </span>
                  </li>
                );
              })}
            </ul>
            {result.carried.length > 0 && <span className={styles.hint}>{planned ? t('Перенесутся в «{title}»', { title: planned.title }) : t('Следующий спринт запланируется сам')}</span>}
          </div>
        ) : (
          <p className={styles.tOk}>{t('Все задачи спринта готовы.')}</p>
        )}
        {err && <p className="msg err">{err}</p>}
        <div className={styles.dfoot}>
          <span className={styles.grow} />
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? t('Завершаю…') : t('Завершить спринт')}</button>
        </div>
      </form>
    </dialog>
  );
}
