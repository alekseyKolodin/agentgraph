// Экран проекта (/teamwork/:team/:project/:tab?; spec §11; макеты Overview.dc.html, Main.dc.html): крошки, шапка с названием, сутью,
// строкой синхронизации команды, участниками и меню ⋯ (переименовать, в архив); восемь вкладок: «Обзор» здесь, остальные —
// заглушки волны 3 (docs/, tasks/). ?task=ID открывает панель задачи поверх любой вкладки; Esc и × закрывают её.
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
import { Loading } from '../sessions/Loading';
import { ConflictsDialog } from './ConflictsDialog';
import { DocTab } from './docs/DocTab';
import { DocsListTab } from './docs/DocsListTab';
import { OverviewTab } from './OverviewTab';
import { Crumbs, cx, ErrorLine, People, Tabs } from './parts';
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

  if (!on) return <div className="empty"><h1>Teamwork</h1><p className="muted">{t('Сервер не умеет Teamwork: обновите agentgraph.')}</p></div>;
  const err = teamQ.error ?? projQ.error;
  if (err) {
    const gone = err instanceof ApiError && err.status === 404;
    return (
      <div className="empty">
        <h1>{gone ? t('Проекта {slug} нет', { slug: project }) : t('Проект не открылся')}</h1>
        <p className="muted">{gone ? t('Его нет в репо команды или ссылка устарела.') : errorText(err)}</p>
        <Link to={teamQ.data ? teamPath(team) : TEAMS_PATH}>{teamQ.data ? t('← Команда') : t('← Все команды')}</Link>
      </div>
    );
  }
  const td = teamQ.data;
  const p = projQ.data;
  if (!td || !p || !tab) return <Loading className={styles.loading} />;
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
          <People members={td.memberList} />
          <ProjectMenu team={td} project={p} />
        </div>
      </div>
      <Tabs items={tabs} active={tab} label={t('Проект')} />
      {tasksQ.isError && <ErrorLine text={errorText(tasksQ.error)} />}
      {tab === 'overview' && <OverviewTab team={td} project={p} tasks={tasks} />}
      {(tab === 'prd' || tab === 'architecture' || tab === 'design') && <DocTab team={team} project={project} doc={tab} />}
      {tab === 'docs' && <DocsListTab team={team} project={project} />}
      {tab === 'backlog' && <BacklogTab team={team} project={project} />}
      {tab === 'board' && <BoardTab team={team} project={project} />}
      {tab === 'sprints' && <SprintsTab team={team} project={project} />}
      {taskId && (
        <TaskDrawer onClose={closeTask}>
          <TaskPanel team={team} project={project} id={taskId} onClose={closeTask} />
        </TaskDrawer>
      )}
      {conflictsOpen && <ConflictsDialog team={team} conflicts={conflictsQ.data ?? []} members={td.memberList} onClose={() => setConflictsOpen(false)} />}
    </div>
  );
}

/** Панель поверх вкладки: затемнение, Esc и клик мимо закрывают; содержимое — TaskPanel волны 3. */
function TaskDrawer({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
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
      <aside ref={panel} className={styles.drawer} role="dialog" aria-modal="true" aria-label={t('Задача')} tabIndex={-1}>
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
      <button type="button" className="btn ghost icon-more" aria-label={t('Ещё действия проекта')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>⋯</button>
      <div className="menu" role="menu" hidden={!open}>
        <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); setRename(true); }}>{t('Переименовать…')}</button>
        <button type="button" role="menuitem" className="menu-item" onClick={() => void archive()}>{project.status === 'archived' ? t('Вернуть из архива') : t('В архив…')}</button>
      </div>
      {rename && <RenameDialog team={team} project={project} onClose={() => setRename(false)} />}
    </div>
  );
}

function RenameDialog({ team, project, onClose }: { team: TeamDetail; project: TeamProject; onClose: () => void }) {
  const qc = useQueryClient();
  const dlg = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(project.title);
  const [summary, setSummary] = useState(project.summary);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    dlg.current?.showModal();
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const patch: { title?: string; summary?: string } = {};
      if (title.trim() !== project.title) patch.title = title.trim();
      if (summary.trim() !== project.summary) patch.summary = summary.trim();
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
          <input id="tw-rn-title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className={styles.f}>
          <label htmlFor="tw-rn-summary">{t('Суть одной строкой')}</label>
          <input id="tw-rn-summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
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
