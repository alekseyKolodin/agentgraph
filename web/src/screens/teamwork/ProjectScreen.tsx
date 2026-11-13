// Экран проекта (/teamwork/:team/:project/:tab?; spec §11; макеты Overview.dc.html, Main.dc.html): крошки, шапка с названием, сутью,
// строкой синхронизации команды, участниками и меню ⋯ (переименовать, в архив); восемь вкладок: «Обзор» здесь, остальные —
// заглушки волны 3 (docs/, tasks/). ?task=ID открывает панель задачи поверх любой вкладки; Esc и × закрывают её.
// Упавшая фоновая перечитка при данных на экране — строка над вкладками (StaleLine), а не экран ошибки: панель задачи,
// диалоги и ввод на вкладках не размонтируются.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDetail, TeamProject } from '@server/api-types';
import { ApiError, errorText, useFeature } from '../../api';
import { teamKeys, updateProject, useProject, useTasks, useTeam, useTeamConflicts } from '../../api/teamwork';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { backlogTasks } from '../../lib/teamwork/backlog';
import { workSignals } from '../../lib/teamwork/board';
import { changedFields, failView, missingOf, rebaseForm } from '../../lib/teamwork/form';
import { Loading } from '../sessions/Loading';
import { ConflictsDialog } from './ConflictsDialog';
import { DocTab } from './docs/DocTab';
import { DocsListTab } from './docs/DocsListTab';
import { UnsavedLine } from './docs/UnsavedLine';
import { OverviewTab } from './OverviewTab';
import { trapTab, useReturnFocus } from './focus';
import { Crumbs, cx, ErrorLine, People, readonlyReason, StaleLine, Tabs } from './parts';
import { PROJECT_TABS, projectPath, projectTabLabel, projectTabOf, TASK_PARAM, TEAMS_PATH, teamPath } from './shell';
import { SyncLine } from './SyncLine';
import { BacklogTab } from './tasks/BacklogTab';
import { BoardTab } from './tasks/BoardTab';
import { SprintsTab } from './tasks/SprintsTab';
import { TaskPanel } from './tasks/TaskPanel';
import styles from './Teamwork.module.css';

export function ProjectScreen() {
  const { team = '', project = '', tab: rawTab } = useParams();
  const tab = projectTabOf(rawTab);
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const taskId = search.get(TASK_PARAM);
  const on = useFeature('teamwork');
  const teamQ = useTeam(on ? team : undefined);
  const projQ = useProject(on ? team : undefined, project);
  const tasksQ = useTasks(on ? team : undefined, project);
  const conflictsQ = useTeamConflicts(team, (teamQ.data?.sync.conflicts ?? 0) > 0);
  const [conflictsOpen, setConflictsOpen] = useState(false);

  // незнакомая вкладка в адресе — на обзор
  useEffect(() => {
    if (!tab) void navigate(projectPath(team, project), { replace: true });
  }, [tab, team, project]);

  const closeTask = () => {
    const next = new URLSearchParams(search);
    next.delete(TASK_PARAM);
    setSearch(next, { replace: true });
  };

  if (!on) return <div className="empty"><h1>Teamwork</h1><p className="muted">{t('Этот сервер не поддерживает Teamwork: обновите agentgraph.')}</p></div>;
  const td = teamQ.data;
  const p = projQ.data;
  const err = teamQ.error ?? projQ.error;
  if (failView(err, Boolean(td && p)) === 'screen') {
    const status = (e: unknown) => (e instanceof ApiError ? e.status : undefined);
    const missing = missingOf(status(teamQ.error), status(projQ.error));
    return (
      <div className="empty">
        <h1>{missing === 'team' ? t('Команды {slug} нет', { slug: team }) : missing === 'project' ? t('Проекта {slug} нет', { slug: project }) : t('Проект не открылся')}</h1>
        <p className="muted">{missing === 'team' ? t('Её отключили или ссылка устарела.') : missing === 'project' ? t('Его нет в репо команды или ссылка устарела.') : errorText(err)}</p>
        <Link to={td && missing !== 'team' ? teamPath(team) : TEAMS_PATH}>{td && missing !== 'team' ? t('← Команда') : t('← Все команды')}</Link>
      </div>
    );
  }
  if (!td || !p || !tab) return <Loading className={styles.loading} />;
  // строка над вкладками: «проекта больше нет» (404) важнее сбоя команды, иначе её не видно; без них — сбой задач
  const gone404 = (e: unknown) => e instanceof ApiError && e.status === 404;
  const lineErr = (gone404(teamQ.error) ? teamQ.error : gone404(projQ.error) ? projQ.error : err) ?? (failView(tasksQ.error, Boolean(tasksQ.data)) === 'line' ? tasksQ.error : null);
  const tasks = tasksQ.data ?? [];
  const signals = workSignals(tasks);
  const tabs = PROJECT_TABS.map((k) => ({
    key: k,
    to: projectPath(team, project, k),
    label: projectTabLabel(k),
    count: k === 'docs' ? p.docs.filter((d) => d.name.startsWith('docs/')).length || undefined : k === 'backlog' ? backlogTasks(tasks).length || undefined : undefined,
    mark: k === 'board' && signals.working > 0,
    title: k === 'board' && signals.working ? t('агент работает · {n}', { n: signals.working }) : undefined,
  }));
  return (
    <div className={styles.view}>
      <Crumbs items={[{ to: teamPath(team), label: td.title }]} />
      <div className={styles.head}>
        <div>
          <h1>{p.title}{p.status === 'archived' && <span className={styles.meta}> · {t('в архиве')}</span>}</h1>
          {p.summary && <p className={styles.sub}>{p.summary}</p>}
        </div>
        <div className={styles.headR}>
          <SyncLine team={team} sync={td.sync} format={td.format} conflicts={conflictsQ.data} onResolve={() => setConflictsOpen(true)} />
          <UnsavedLine team={team} project={project} />
          <People members={td.memberList} />
          <ProjectMenu team={td} project={p} />
        </div>
      </div>
      <Tabs items={tabs} active={tab} label={t('Проект')} />
      {/* одна строка на упавшую перечитку: команда, проект и задачи падают вместе, когда сервер недоступен */}
      <StaleLine
        error={lineErr}
        gone={lineErr === teamQ.error ? t('Команды {slug} больше нет: её отключили. Показано последнее загруженное, изменения не запишутся.', { slug: team }) : t('Проекта {slug} больше нет в репо команды. Показано последнее загруженное, изменения не запишутся.', { slug: project })}
      />
      {tasksQ.isError && !tasksQ.data && <ErrorLine text={t('Задачи не загрузились: {error}', { error: errorText(tasksQ.error) })} />}
      {tab === 'overview' && <OverviewTab team={td} project={p} tasks={tasks} />}
      {(tab === 'prd' || tab === 'architecture' || tab === 'design') && <DocTab team={team} project={project} doc={tab} />}
      {tab === 'docs' && <DocsListTab team={team} project={project} />}
      {tab === 'backlog' && <BacklogTab team={team} project={project} />}
      {tab === 'board' && <BoardTab team={team} project={project} />}
      {tab === 'sprints' && <SprintsTab team={team} project={project} />}
      {taskId && (
        <TaskDrawer onClose={closeTask}>
          {/* key — задача: правка описания, комментарий и выбор зависимости одной задачи не переезжают в другую */}
          <TaskPanel key={taskId} team={team} project={project} id={taskId} onClose={closeTask} />
        </TaskDrawer>
      )}
      {conflictsOpen && <ConflictsDialog team={team} conflicts={conflictsQ.data ?? []} members={td.memberList} onClose={() => setConflictsOpen(false)} />}
    </div>
  );
}

/**
 * Панель поверх вкладки: затемнение, Esc и клик мимо закрывают; содержимое — TaskPanel волны 3. Tab ходит по кругу внутри
 * панели, закрытие возвращает фокус туда, откуда её открыли (карточка, строка, ссылка). Несохранённый ввод панели живёт в
 * unsaved.ts по задаче, поэтому закрытие его не теряет.
 */
function TaskDrawer({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useReturnFocus(panel);
  // обработчик Esc ставится один раз, а закрытие читает свежий onClose (в нём — текущие параметры адреса)
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) close.current();
    };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <div className={styles.drawerScrim} aria-hidden="true" onClick={onClose} />
      <aside ref={panel} className={styles.drawer} role="dialog" aria-modal="true" aria-label={t('Задача')} tabIndex={-1} onKeyDown={trapTab}>
        {children}
      </aside>
    </>
  );
}

/** Меню ⋯ проекта: переименовать (название и суть), в архив и обратно (spec §8.3). */
function ProjectMenu({ team, project }: { team: TeamDetail; project: TeamProject }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const [open, setOpen] = useState(false);
  const [rename, setRename] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const ro = team.sync.state === 'readonly' ? readonlyReason() : undefined;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const archive = async () => {
    setOpen(false);
    const toArchive = project.status !== 'archived';
    if (toArchive && !(await askConfirm(t('Отправить проект «{title}» в архив? Задачи и документы останутся в репо, проект уйдёт из списка активных.', { title: project.title }), { ok: t('В архив') }))) return;
    try {
      const r = await updateProject(team.slug, project.slug, { status: toArchive ? 'archived' : 'active' });
      qc.setQueryData(teamKeys.project(team.slug, project.slug), r);
      void qc.invalidateQueries({ queryKey: teamKeys.all });
    } catch (err) {
      toast(errorText(err));
    }
  };
  return (
    <div className="menu-wrap" ref={wrap}>
      <button ref={btn} type="button" className="btn ghost icon-more" aria-label={t('Ещё действия проекта')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>⋯</button>
      <div className="menu" role="menu" hidden={!open}>
        {/* фокус — на ⋯ до открытия окна: пункт меню скроется, а закрытое окно вернёт фокус на ⋯ */}
        <button type="button" role="menuitem" className="menu-item" disabled={Boolean(ro)} title={ro} onClick={() => { setOpen(false); btn.current?.focus(); setRename(true); }}>{t('Переименовать…')}</button>
        <button type="button" role="menuitem" className="menu-item" disabled={Boolean(ro)} title={ro} onClick={() => { btn.current?.focus(); void archive(); }}>{project.status === 'archived' ? t('Вернуть из архива') : t('В архив…')}</button>
      </div>
      {rename && <RenameDialog team={team} project={project} onClose={() => setRename(false)} />}
    </div>
  );
}

function RenameDialog({ team, project, onClose }: { team: TeamDetail; project: TeamProject; onClose: () => void }) {
  const qc = useQueryClient();
  const dlg = useRef<HTMLDialogElement>(null);
  // база формы — проект на момент открытия; перечитанный проект (правка коллеги) обновляет только нетронутые поля, а запись
  // уносит только тронутые: иначе «Сохранить» вернуло бы старую суть, которую коллега успел поменять
  const formOf = (x: TeamProject) => ({ title: x.title, summary: x.summary });
  const [base, setBase] = useState(() => formOf(project));
  const [form, setForm] = useState(base);
  const [seen, setSeen] = useState(project);
  if (seen !== project) {
    const next = formOf(project);
    setSeen(project);
    setForm((f) => rebaseForm(f, base, next));
    setBase(next);
  }
  const { title, summary } = form;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useReturnFocus(dlg);
  useEffect(() => {
    dlg.current?.showModal();
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const patch = changedFields(form, base);
      if (Object.keys(patch).length) {
        const r = await updateProject(team.slug, project.slug, patch);
        qc.setQueryData(teamKeys.project(team.slug, project.slug), r);
        void qc.invalidateQueries({ queryKey: teamKeys.all });
      }
      onClose();
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dlg}
      className={styles.dlg}
      aria-labelledby="tw-rename-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form method="dialog" className={styles.dlgBody} onSubmit={(e) => void submit(e)}>
        <h2 id="tw-rename-title">{t('Проект')}</h2>
        <div className={styles.f}>
          <label htmlFor="tw-rn-title">{t('Название')}</label>
          <input id="tw-rn-title" value={title} autoFocus onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        </div>
        <div className={styles.f}>
          <label htmlFor="tw-rn-summary">{t('Суть одной строкой')}</label>
          <input id="tw-rn-summary" value={summary} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} />
        </div>
        <span className={styles.meta}>{project.slug} · {t('slug не меняется')}</span>
        {err && <p className="msg err">{err}</p>}
        <div className={styles.foot}>
          <span className={styles.grow} />
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim()}>{busy ? t('Сохраняю…') : t('Сохранить')}</button>
        </div>
      </form>
    </dialog>
  );
}
