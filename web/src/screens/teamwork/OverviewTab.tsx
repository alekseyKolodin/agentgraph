// Вкладка «Обзор» проекта (spec §11; макет Overview.dc.html): активный спринт с полосой и счётчиками, агенты по задачам проекта
// на этом компьютере (local.json → work), документы, репо кода с локальной папкой (PUT …/local → repoPaths; «+ Репо» — выбор
// моей папки, ненайденное — «Указать папку» и подсказка git clone), моё пространство
// для проекта (PUT …/local → projectSpaces) и лента команды по git log папки проекта.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDetail, TeamDocBrief, TeamProject, TeamRepoRef, TeamTask, TeamTaskStatus } from '@server/api-types';
import { errorText, useConfig, useSpaces } from '../../api';
import { teamKeys, updateProject, updateTeamLocal, useHistory } from '../../api/teamwork';
import { SpaceBadge } from '../../components/Badge';
import { PathLink } from '../../components/PathLink';
import { PickDirButton } from '../../components/PickDirButton';
import { SpacePicker } from '../../components/SpacePicker';
import { useToast } from '../../components/Toast';
import { useNow } from '../../components/useNow';
import { feedTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import { docSize } from '../../lib/spaces';
import { plannedSprint, points, pointsWord } from '../../lib/teamwork/backlog';
import { activeSprint, columnName, memberByEmail, noSprintText, sprintStrip, sprintTasks, workBadge, type WorkState } from '../../lib/teamwork/board';
import { docFile, docLabel, updatedText } from '../../lib/teamwork/docs';
import { reposBody, type RepoDraft } from '../../lib/teamwork/repos';
import { cx, ErrorLine, Who } from './parts';
import { CloneHint, RepoChooser, RepoDraftRow, type RepoTaken } from './RepoPicker';
import { projectPath } from './shell';
import styles from './Teamwork.module.css';

const FEED_LIMIT = 10;
const MAIN_DOCS = ['prd', 'architecture', 'design'] as const;

export function OverviewTab({ team, project, tasks }: { team: TeamDetail; project: TeamProject; tasks: readonly TeamTask[] }) {
  return (
    <div className={styles.grid}>
      <div className={styles.colL}>
        <SprintBlock team={team} project={project} tasks={tasks} />
        <AgentsBlock tasks={tasks} />
        <DocsBlock team={team} project={project} />
      </div>
      <div className={styles.colR}>
        {/* key: черновик нового репо не переезжает в другой проект при переходе без перемонтирования */}
        <ReposBlock key={project.slug} team={team} project={project} />
        <SpaceBlock team={team} project={project} />
        <FeedBlock team={team} project={project} />
      </div>
    </div>
  );
}

function SprintBlock({ team, project, tasks }: { team: TeamDetail; project: TeamProject; tasks: readonly TeamTask[] }) {
  const active = activeSprint(project.sprints);
  if (!active) {
    const text = noSprintText(plannedSprint(project.sprints));
    return (
      <section className={styles.sprint} aria-label={t('Активный спринт')}>
        <div className={styles.sprintH}>
          <b>{text.title}</b>
          <span className={styles.grow} />
          <Link className="btn small" to={projectPath(team.slug, project.slug, 'backlog')}>{t('Открыть бэклог')}</Link>
        </div>
        <span className={styles.note}>{text.hint}</span>
      </section>
    );
  }
  const list = sprintTasks(tasks, active.number);
  const strip = sprintStrip(list);
  const stats: [TeamTaskStatus, number][] = [['todo', strip.counts.todo], ['in_progress', strip.counts.in_progress], ['review', strip.counts.review], ['done', strip.counts.done]];
  return (
    <section className={styles.sprint} aria-label={t('Активный спринт')}>
      <div className={styles.sprintH}>
        <b>{active.title}</b>
        {active.goal && <span className={styles.goal}>{active.goal}</span>}
        <span className={styles.grow} />
        <Link className="btn small" to={projectPath(team.slug, project.slug, 'board')}>{t('Открыть доску')}</Link>
      </div>
      {list.length > 0 && (
        <span className={cx(styles.strip, styles.big)} role="img" aria-label={strip.label} title={strip.label}>
          {strip.cells.map((s, i) => <span key={i} className={cx(styles.st, styles[s])} />)}
        </span>
      )}
      <div className={styles.stats}>
        {stats.map(([s, n]) => (
          <div key={s} className={cx(styles.stat, s === 'done' && styles.ok)}>
            <b>{n}</b>
            <span>{columnName(s, team.columns).toLowerCase()}</span>
          </div>
        ))}
        <div className={styles.stat}>
          <b>{points(list)}</b>
          <span>{t('очков в спринте')}</span>
        </div>
      </div>
    </section>
  );
}

const DOT: Record<WorkState, string> = { working: '', waiting: 'wait', failed: 'fail', done: 'ok' };

/** Запуски и сессии по задачам проекта на этом компьютере: только когда у задач есть work. */
function AgentsBlock({ tasks }: { tasks: readonly TeamTask[] }) {
  const now = useNow(30_000);
  const rows = tasks.flatMap((task) => {
    const b = workBadge(task);
    return b ? [{ task, b }] : [];
  });
  if (!rows.length) return null;
  return (
    <section aria-label={t('Агенты по проекту')}>
      <h2 className={styles.cap}>{t('Агенты по проекту на этом компьютере')}</h2>
      <div className={styles.rows}>
        {rows.map(({ task, b }) => (
          <div key={task.id} className={cx(styles.hrun, b.state === 'waiting' && styles.wait, b.state === 'failed' && styles.fail)}>
            <span className={cx(styles.dot, DOT[b.state] && styles[DOT[b.state]])} aria-hidden="true" />
            <div className={styles.hrunMain}>
              <div className={styles.hrunTop}>
                <Link className={styles.hrunTitle} to={b.work.kind === 'run' ? `/run/${encodeURIComponent(b.work.id)}` : `/sessions/${encodeURIComponent(b.work.id)}`}>{task.id} · {task.title}</Link>
                <span className={styles.hrunMeta}>{b.work.kind === 'run' ? (b.work.title ?? t('запуск')) : t('сессия')}</span>
              </div>
              <span className={styles.hrunSum}>{b.text}</span>
            </div>
            <span className={styles.meta}>{feedTime(b.work.at, new Date(now))}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DocsBlock({ team, project }: { team: TeamDetail; project: TeamProject }) {
  const byName = new Map(project.docs.map((d) => [d.name, d]));
  const extra = project.docs.filter((d) => d.name.startsWith('docs/'));
  const line = (d: TeamDocBrief | undefined): { text: string; quiet: boolean } => {
    if (!d || d.size === 0) return { text: t('пусто — заполнит черновик с моделью или вы'), quiet: true };
    const upd = updatedText(d, team.memberList);
    return { text: [upd, docSize(d.size)].filter(Boolean).join(' · '), quiet: false };
  };
  return (
    <section aria-label={t('Документы проекта')}>
      <h2 className={styles.cap}>{t('Документы')}</h2>
      <div className={styles.rows}>
        {MAIN_DOCS.map((name) => {
          const l = line(byName.get(name));
          return (
            <div key={name} className={styles.doc}>
              <Link className={styles.n} to={projectPath(team.slug, project.slug, name)}>{docLabel(name)}</Link>
              <span className={cx(styles.d, l.quiet && styles.quiet)}>{l.text}</span>
              <span className={styles.meta}>{docFile(name)}</span>
            </div>
          );
        })}
        <div className={styles.doc}>
          <Link className={styles.n} to={projectPath(team.slug, project.slug, 'docs')}>{t('Документы')}</Link>
          <span className={cx(styles.d, !extra.length && styles.quiet)}>
            {extra.length ? extraNames(extra) : t('пока нет')}
          </span>
          <span className={styles.meta}>docs/</span>
        </div>
      </div>
    </section>
  );
}

/** «1c-format.md, columns.md и ещё 2». */
function extraNames(docs: readonly TeamDocBrief[]): string {
  const names = docs.map((d) => d.name.replace(/^docs\//, ''));
  if (names.length <= 3) return names.join(', ');
  return t('{list} и ещё {n}', { list: names.slice(0, 2).join(', '), n: names.length - 2 });
}

/**
 * Репо кода проекта: строки с моей папкой; «+ Репо» — выбор моей папки (RepoChooser), ссылка и ветка из git уходят в
 * project.yaml (PUT проекта со всеми репо), папка — только в мой local.json.
 */
function ReposBlock({ team, project }: { team: TeamDetail; project: TeamProject }) {
  const qc = useQueryClient();
  const [choosing, setChoosing] = useState(false);
  const [draft, setDraft] = useState<RepoDraft | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const readonly = team.sync.state === 'readonly';
  const existing = project.repos.map((r) => ({ key: r.key, url: r.url }));
  const body = draft ? reposBody([draft], existing) : undefined;
  const taken: RepoTaken = {
    paths: new Set(project.repos.flatMap((r) => (r.local ? [r.local] : []))),
    urls: new Set(project.repos.map((r) => r.url)),
    keys: project.repos.map((r) => r.key),
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!body?.length || busy) return;
    setBusy(true);
    setErr('');
    try {
      const repos = [...project.repos.map((r) => ({ key: r.key, url: r.url, ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}) })), ...body];
      await updateProject(team.slug, project.slug, { repos });
      await qc.invalidateQueries({ queryKey: teamKeys.all });
      setDraft(undefined);
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t('Репо кода')}>
      <div className={styles.capRow}>
        <h2 className={styles.cap}>{t('Репо кода')}</h2>
        {!readonly && !choosing && !draft && <button type="button" className="btn ghost small" title={t('Выбрать папку репо среди своих проектов')} onClick={() => setChoosing(true)}>{t('+ Репо')}</button>}
      </div>
      {project.repos.length === 0 && !choosing && !draft && <p className={styles.note}>{t('У проекта нет репо кода. «+ Репо» — выбрать свою папку: ссылка и ветка возьмутся из git, ничего не скачивается.')}</p>}
      {project.repos.length > 0 && (
        <div className={styles.rows}>
          {project.repos.map((r) => <RepoRow key={r.key} team={team.slug} repo={r} />)}
        </div>
      )}
      {choosing && (
        <RepoChooser
          team={team.slug}
          taken={taken}
          onAdd={(d) => {
            setDraft(d);
            setChoosing(false);
          }}
          onClose={() => setChoosing(false)}
        />
      )}
      {draft && (
        <form className={styles.repoAdd} aria-label={t('Новое репо кода')} onSubmit={(e) => void add(e)}>
          <RepoDraftRow draft={draft} all={[draft]} existing={existing} onChange={(patch) => setDraft({ ...draft, ...patch })} onRemove={() => setDraft(undefined)} />
          {err && <p className="msg err">{err}</p>}
          <div className="row">
            <button type="submit" className="btn small primary" disabled={busy || !body?.length}>{busy ? t('Добавляю…') : t('Добавить в проект')}</button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => setDraft(undefined)}>{t('Отмена')}</button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * Репо кода и его папка у меня: найдена — путь, нет — «Указать папку» (поле и выбор в Finder) → PUT …/local и подсказка
 * «git clone <ссылка>»: agentgraph сам не клонирует.
 */
function RepoRow({ team, repo }: { team: string; repo: TeamRepoRef }) {
  const qc = useQueryClient();
  const toast = useToast();
  const home = useConfig().data?.home;
  const [edit, setEdit] = useState(false);
  const [path, setPath] = useState(repo.local ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (p: string) => {
    setBusy(true);
    try {
      await updateTeamLocal(team, { repoPaths: { [repo.url]: p.trim() || null } });
      await qc.invalidateQueries({ queryKey: teamKeys.all });
      setEdit(false);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.repo}>
      <div className={styles.repoH}>
        <b>{repo.key}</b>
        <span className={cx(styles.dot, styles.s6, repo.local ? styles.ok : styles.wait)} aria-hidden="true" />
        {repo.defaultBranch && <span className={styles.meta}>{repo.defaultBranch}</span>}
        <span className={styles.grow} />
        {!edit && <button type="button" className="btn ghost small" title={repo.local ? t('Сменить папку') : t('Указать, где лежит клон этого репо')} onClick={() => setEdit(true)}>{repo.local ? t('Сменить') : t('Указать папку')}</button>}
      </div>
      <span className={styles.url}>{repo.url}</span>
      {!edit && repo.local && <PathLink className={styles.p} path={repo.local}>{tildePath(repo.local, home)}</PathLink>}
      {!edit && !repo.local && (
        <>
          <span className={styles.miss}>{t('Не найден на этом компьютере — без папки задачи этого репо нельзя отправить агенту. Укажите свою папку или склонируйте:')}</span>
          <CloneHint url={repo.url} />
        </>
      )}
      {edit && (
        <form
          className={styles.repoPick}
          onSubmit={(e) => {
            e.preventDefault();
            void save(path);
          }}
        >
          <input value={path} autoFocus placeholder={t('/path/to/clone')} spellCheck={false} aria-label={t('Папка клона')} onChange={(e) => setPath(e.target.value)} />
          <PickDirButton className="btn small" prompt={t('Где лежит клон {key}', { key: repo.key })} start={() => path} onPick={(p) => void save(p)} />
          <button type="submit" className="btn small primary" disabled={busy}>{t('Сохранить')}</button>
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => { setEdit(false); setPath(repo.local ?? ''); }}>{t('Отмена')}</button>
        </form>
      )}
    </div>
  );
}

/** Моё пространство для проекта: только у меня, предлагается в запусках и сессиях по задачам (local.json → projectSpaces). */
function SpaceBlock({ team, project }: { team: TeamDetail; project: TeamProject }) {
  const qc = useQueryClient();
  const toast = useToast();
  const spaces = useSpaces(true);
  const [pick, setPick] = useState(!project.space);
  const [busy, setBusy] = useState(false);
  const save = async (slug: string) => {
    if (slug === (project.space ?? '')) {
      setPick(false);
      return;
    }
    setBusy(true);
    try {
      await updateTeamLocal(team.slug, { projectSpaces: { [project.slug]: slug || null } });
      await qc.invalidateQueries({ queryKey: teamKeys.all });
      setPick(!slug);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles.space} aria-label={t('Личное пространство')}>
      <h2 className={styles.cap} style={{ margin: 0 }}>{t('Моё пространство для проекта')}</h2>
      {project.space && !pick && (
        <div className={styles.spaceR}>
          <SpaceBadge slug={project.space} link />
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => setPick(true)}>{t('Сменить')}</button>
          <button type="button" className="btn ghost small" disabled={busy} title={t('Отвязать пространство от проекта')} onClick={() => void save('')}>{t('Снять')}</button>
        </div>
      )}
      {(pick || !project.space) && (
        <SpacePicker
          id={`tw-space-${project.slug}`}
          className={styles.spacePick}
          inputClassName={styles.pickInput}
          value={project.space ?? ''}
          options={spaces.data?.spaces ?? []}
          loading={spaces.isPending}
          compact
          placeholder={t('выбрать пространство')}
          onChange={(slug) => void save(slug)}
          onDone={() => { if (project.space) setPick(false); }}
        />
      )}
      <p>{t('Только у вас. Предлагается в запусках и сессиях по задачам проекта.')}</p>
    </section>
  );
}

function FeedBlock({ team, project }: { team: TeamDetail; project: TeamProject }) {
  const q = useHistory(team.slug, project.slug, { limit: FEED_LIMIT });
  const now = useNow(30_000);
  return (
    <section aria-label={t('Лента команды')}>
      <h2 className={styles.cap}>{t('Лента команды')}</h2>
      {q.isError && <ErrorLine text={errorText(q.error)} />}
      {q.data && q.data.length === 0 && <p className={styles.note}>{t('Изменений по проекту пока нет')}</p>}
      {q.data && q.data.length > 0 && (
        <ul className={styles.feed}>
          {q.data.map((h) => {
            const m = memberByEmail(team.memberList, h.email);
            return (
              <li key={h.hash} title={`${h.author} · ${h.email}\n${h.hash}`}>
                <Who member={m} email={h.email} />
                <span className={styles.x}>{h.message}</span>
                <span className={styles.meta}>{feedTime(h.at, new Date(now))}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
