// Экран команды (/teamwork/:team?tab=; spec §11; макет Team.dc.html): шапка с названием, репо и префиксом, строкой синхронизации
// и участниками; вкладки «Проекты» (строки с полосой спринта и форма нового проекта, репо кода — из моих папок), «Участники», «Процесс» (flow команды
// в редакторе YAML с проверкой схемы, сохранение коммитит), «Настройки» (название, колонки, flow по умолчанию, отключение).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDetail, TeamProjectBrief, TeamTaskStatus } from '@server/api-types';
import { ApiError, errorText, useConfig, useFeature } from '../../api';
import { createProject, removeTeam, saveTeamFlow, teamKeys, updateTeam, useTeam, useTeamConflicts, useTeamFlow, type TeamPatch } from '../../api/teamwork';
import { useConfirm } from '../../components/ConfirmDialog';
import { PathLink } from '../../components/PathLink';
import { useToast } from '../../components/Toast';
import { useMemoryState } from '../../components/useMemoryState';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import { STATUSES, tasksWord } from '../../lib/teamwork/board';
import { YamlEditor, type YamlEditorHandle } from '../flow/YamlEditor';
import { Loading } from '../sessions/Loading';
import { reposBody, type RepoDraft } from '../../lib/teamwork/repos';
import { ConflictsDialog } from './ConflictsDialog';
import { Crumbs, cx, ErrorLine, People, SprintStrip, Tabs, Who } from './parts';
import { RepoChooser, RepoDraftRow, type RepoTaken } from './RepoPicker';
import { projectPath, remoteLabel, SLUG_RE, TEAM_TABS, TEAMS_PATH, teamTabLabel, teamTabOf, teamTabPath, type TeamTab } from './shell';
import { SyncLine } from './SyncLine';
import styles from './Teamwork.module.css';

type Msg = { text: string; tone: '' | 'ok' | 'err' | 'warn' };
const NO_MSG: Msg = { text: '', tone: '' };
const msgClass = (m: Msg) => `msg${m.tone ? ` ${m.tone}` : ''}`;

export function TeamScreen() {
  const { team: slug = '' } = useParams();
  const [search] = useSearchParams();
  const tab = teamTabOf(search.get('tab'));
  const on = useFeature('teamwork');
  const q = useTeam(on ? slug : undefined);
  const team = q.data;
  const conflictsQ = useTeamConflicts(slug, (team?.sync.conflicts ?? 0) > 0);
  const [conflictsOpen, setConflictsOpen] = useState(false);

  if (!on) return <div className="empty"><h1>Teamwork</h1><p className="muted">{t('Сервер не умеет Teamwork: обновите agentgraph.')}</p></div>;
  if (q.isError) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="empty">
        <h1>{gone ? t('Команды {slug} нет', { slug }) : t('Команда не открылась')}</h1>
        <p className="muted">{gone ? t('Её отключили или ссылка устарела.') : errorText(q.error)}</p>
        <Link to={TEAMS_PATH}>{t('← Все команды')}</Link>
      </div>
    );
  }
  if (!team) return <Loading className={styles.loading} />;

  const tabs = TEAM_TABS.map((k) => ({
    key: k,
    to: teamTabPath(slug, k),
    label: teamTabLabel(k),
    count: k === 'projects' ? team.projects.length : k === 'members' ? team.memberList.length : k === 'process' ? team.flows.length : undefined,
  }));
  return (
    <div className={styles.view}>
      <Crumbs items={[]} />
      <div className={styles.head}>
        <div>
          <h1>{team.title}</h1>
          <p className={cx(styles.sub, styles.mono)}>{remoteLabel(team.remote)} · {team.prefix}</p>
        </div>
        <div className={styles.headR}>
          <SyncLine team={slug} sync={team.sync} format={team.format} conflicts={conflictsQ.data} onResolve={() => setConflictsOpen(true)} />
          <People members={team.memberList} />
        </div>
      </div>
      <Tabs items={tabs} active={tab} label={t('Команда', undefined, 'team')} />
      {tab === 'projects' && <ProjectsTab team={team} />}
      {tab === 'members' && <MembersTab team={team} />}
      {tab === 'process' && <ProcessTab team={team} />}
      {tab === 'settings' && <SettingsTab team={team} />}
      {conflictsOpen && <ConflictsDialog team={slug} conflicts={conflictsQ.data ?? []} members={team.memberList} onClose={() => setConflictsOpen(false)} />}
    </div>
  );
}

// ---------- проекты

function ProjectsTab({ team }: { team: TeamDetail }) {
  const [open, setOpen] = useMemoryState(`teamwork.newProject.${team.slug}`, team.projects.length === 0);
  const active = team.projects.filter((p) => p.status !== 'archived');
  const archived = team.projects.filter((p) => p.status === 'archived');
  return (
    <section aria-label={t('Проекты')}>
      <div className={styles.tabBar}>
        <span className={styles.note}>{team.projects.length ? t('Проект — фича, которую строит команда: ТЗ, архитектура, задачи и спринты') : ''}</span>
        {!open && <button type="button" className="btn small" onClick={() => setOpen(true)}>{t('+ Проект')}</button>}
      </div>
      {open && <NewProjectForm team={team} onClose={() => setOpen(false)} />}
      {team.projects.length === 0 && !open && (
        <div className={styles.emptyBox}>
          <p>{t('Создайте первый проект: название, slug и одна строка сути. Репо кода можно добавить сразу или позже.')}</p>
        </div>
      )}
      {active.length > 0 && <div className={styles.rows}>{active.map((p) => <ProjectRow key={p.slug} team={team.slug} p={p} />)}</div>}
      {archived.length > 0 && (
        <>
          <h2 className={styles.cap} style={{ marginTop: 20 }}>{t('Архив')} · {archived.length}</h2>
          <div className={styles.rows}>{archived.map((p) => <ProjectRow key={p.slug} team={team.slug} p={p} />)}</div>
        </>
      )}
    </section>
  );
}

function ProjectRow({ team, p }: { team: string; p: TeamProjectBrief }) {
  const s = p.sprint;
  const label = s ? t('{tasks}: {done} готово, {review} на ревью, {work} в работе, {todo} к работе', { tasks: tasksWord(s.total), done: s.counts.done, review: s.counts.review, work: s.counts.in_progress, todo: s.counts.todo }) : '';
  return (
    <div className={cx(styles.prow, p.status === 'archived' && styles.archived)}>
      <span>
        <Link className={styles.t} to={projectPath(team, p.slug)}>{p.title}</Link>
        <span className={styles.d}>{p.summary}</span>
      </span>
      {s ? <SprintStrip counts={s.counts} label={label} /> : <span className={styles.meta}>{p.status === 'archived' ? t('в архиве') : t('спринт не запущен')}</span>}
      <span className={styles.meta}>{s ? t('спринт {n} · {done} из {total}', { n: s.number, done: s.done, total: s.total }) : t('бэклог {n}', { n: p.backlog })}</span>
    </div>
  );
}

/**
 * Новый проект: slug, название, суть, репо кода (spec §8.3). Репо — из моих папок (RepoChooser): ссылка и ветка из git уходят
 * в project.yaml, папка — только в мой local.json; ссылку руками — «Ввести ссылку».
 */
function NewProjectForm({ team, onClose }: { team: TeamDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [repos, setRepos] = useState<RepoDraft[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const slugOk = slug === '' || SLUG_RE.test(slug);
  const body = reposBody(repos);
  const can = !busy && SLUG_RE.test(slug) && title.trim() !== '' && body !== undefined;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!can) return;
    setBusy(true);
    setErr('');
    try {
      const p = await createProject(team.slug, { slug, title: title.trim(), summary: summary.trim(), ...(body.length ? { repos: body } : {}) });
      await qc.invalidateQueries({ queryKey: teamKeys.all });
      onClose();
      void navigate(projectPath(team.slug, p.slug));
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };
  const setRepo = (id: number, patch: Partial<RepoDraft>) => setRepos((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const taken: RepoTaken = {
    paths: new Set(repos.flatMap((r) => (r.local ? [r.local] : []))),
    urls: new Set(repos.flatMap((r) => (r.url.trim() ? [r.url.trim()] : []))),
    keys: repos.map((r) => r.key.trim()).filter(Boolean),
  };
  return (
    <form className={styles.newProject} aria-label={t('Новый проект')} onSubmit={(e) => void submit(e)}>
      <div className={styles.two} style={{ gridTemplateColumns: 'minmax(0, 1fr) 200px' }}>
        <div className={styles.f}>
          <label htmlFor="tw-np-title">{t('Название')}</label>
          <input id="tw-np-title" value={title} autoFocus placeholder={t('Экспорт счетов')} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className={styles.f}>
          <label htmlFor="tw-np-slug">{t('Slug')}</label>
          <input id="tw-np-slug" className={styles.mono} value={slug} placeholder="invoice-export" spellCheck={false} autoComplete="off" aria-invalid={!slugOk || undefined} onChange={(e) => setSlug(e.target.value.trim().toLowerCase())} />
        </div>
      </div>
      <span className={cx(styles.note, !slugOk && styles.err)}>{slugOk ? t('Slug — папка проекта в репо команды: латиница в нижнем регистре, цифры и дефис. Потом не меняется.') : t('Slug — латиница в нижнем регистре, цифры и дефис')}</span>
      <div className={styles.f}>
        <label htmlFor="tw-np-summary">{t('Суть одной строкой')}</label>
        <input id="tw-np-summary" value={summary} placeholder={t('Бухгалтерия выгружает счета за период в CSV и 1С')} onChange={(e) => setSummary(e.target.value)} />
      </div>
      <div className={styles.f}>
        <label>{t('Репо кода')}</label>
        <div className={styles.repoRows}>
          {repos.map((r) => (
            <RepoDraftRow key={r.id} draft={r} all={repos} onChange={(patch) => setRepo(r.id, patch)} onRemove={() => setRepos((list) => list.filter((x) => x.id !== r.id))} />
          ))}
          {choosing ? (
            <RepoChooser
              team={team.slug}
              taken={taken}
              onAdd={(d) => {
                setRepos((list) => [...list, d]);
                setChoosing(false);
              }}
              onClose={() => setChoosing(false)}
            />
          ) : (
            <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} title={t('Выбрать папку репо среди своих проектов')} onClick={() => setChoosing(true)}>{t('+ Репо')}</button>
          )}
        </div>
        <span className={styles.note}>{t('Ничего не скачивается: в проект попадают ссылка (origin) и ветка, а ваша папка остаётся только у вас. У коллег agentgraph найдёт их папку этого репо по origin среди их проектов. Ключ — короткое имя репо в задачах и у агента.')}</span>
      </div>
      {err && <p className="msg err">{err}</p>}
      <div className="row">
        <button type="submit" className="btn primary" disabled={!can}>{busy ? t('Создаю…') : t('Создать проект')}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
      </div>
    </form>
  );
}

// ---------- участники

function MembersTab({ team }: { team: TeamDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const me = team.me;
  const addMe = async () => {
    if (!me.email) return;
    setBusy(true);
    try {
      await updateTeam(team.slug, { members: [...team.memberList, { name: me.name || me.email, email: me.email }] });
      await qc.invalidateQueries({ queryKey: teamKeys.all });
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t('Участники')}>
      <div className={styles.tabBar}>
        <span className={styles.note}>{t('Участники из teamwork.yaml; «себя» agentgraph узнаёт по email из git config клона')}</span>
        {!me.inTeam && me.email && <button type="button" className="btn small" disabled={busy} onClick={() => void addMe()}>{t('Добавить меня')}</button>}
      </div>
      {!me.email && <p className="msg warn">{t('git не знает вас: задайте git config --global user.name и user.email, иначе записи в команду не пройдут.')}</p>}
      {team.memberList.length === 0 && <p className={styles.note}>{t('Участников пока нет')}</p>}
      {team.memberList.length > 0 && (
        <div className={styles.rows}>
          {team.memberList.map((m) => (
            <div key={m.email} className={styles.mrow}>
              <Who member={m} />
              <span>
                <b>{m.name || m.email}</b>{m.email === me.email && <span className={styles.meta}> · {t('это вы')}</span>}
                <br />
                <span className={styles.e}>{m.email}</span>
              </span>
              <span className={styles.logins}>{[m.github && `github: ${m.github}`, m.gitlab && `gitlab: ${m.gitlab}`].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- процесс: flow команды

function ProcessTab({ team }: { team: TeamDetail }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useMemoryState<string>(`teamwork.flow.${team.slug}`, team.flows[0] ?? '');
  const name = team.flows.includes(picked) ? picked : team.flows[0];
  const q = useTeamFlow(team.slug, name);
  const flow = q.data;
  const editor = useRef<YamlEditorHandle>(null);
  const [seq, setSeq] = useState(0);
  const [msg, setMsg] = useState<Msg>(NO_MSG);
  const [busy, setBusy] = useState(false);
  // текст flow сменился (другой flow, сохранение, чужая правка после pull): чистый редактор подхватывает его,
  // редактор с правками — предупреждение, чтобы правка не пропала молча
  const lastYaml = useRef<string | undefined>(undefined);
  const lastName = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!flow) return;
    const prevYaml = lastYaml.current;
    const sameFlow = lastName.current === flow.name;
    lastYaml.current = flow.yaml;
    lastName.current = flow.name;
    if (sameFlow && prevYaml === flow.yaml) return;
    if (!sameFlow || prevYaml === undefined) {
      setSeq((s) => s + 1);
      return;
    }
    const current = editor.current?.value();
    // редактор уже с этим текстом — это своё сохранение; чистый редактор — подхватить чужую правку; с правками — предупредить
    if (current === undefined || current === flow.yaml) return;
    if (current === prevYaml) setSeq((s) => s + 1);
    else setMsg({ text: t('Flow изменили в репо команды: сохранение перезапишет чужую правку'), tone: 'warn' });
  }, [flow]);

  const save = async () => {
    if (!name) return;
    const text = editor.current?.value() ?? '';
    setBusy(true);
    setMsg(NO_MSG);
    try {
      const r = await saveTeamFlow(team.slug, name, text);
      qc.setQueryData(teamKeys.flow(team.slug, name), r);
      setMsg({ text: t('Сохранено'), tone: 'ok' });
    } catch (err) {
      setMsg({ text: errorText(err), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  if (!team.flows.length) {
    return (
      <section aria-label={t('Процесс')}>
        <div className={styles.emptyBox}><p>{t('В репо команды нет flows/: положите туда YAML flow агентов — они появятся здесь.')}</p></div>
      </section>
    );
  }
  return (
    <section aria-label={t('Процесс')} className={styles.process}>
      <ul className={styles.flowList} aria-label={t('Flow команды')}>
        {team.flows.map((f) => (
          <li key={f}>
            <button type="button" className={cx(f === name && styles.on)} aria-current={f === name || undefined} onClick={() => setPicked(f)}>
              {f}{f === team.defaultFlow && <span className={styles.meta}> · {t('по умолчанию')}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div>
        <div className={styles.flowHead}>
          <h3>{name}</h3>
          <span className={styles.meta}>{flow?.file ?? ''}{flow?.spec?.description ? ` · ${flow.spec.description}` : ''}</span>
        </div>
        {q.isError && <ErrorLine text={errorText(q.error)} />}
        {flow?.error && <p className="msg warn">{t('Flow не проходит схему: {error}', { error: flow.error })}</p>}
        {flow && <YamlEditor key={flow.name} ref={editor} className={styles.yaml} value={flow.yaml} seq={seq} />}
        {!flow && !q.isError && <Loading className={styles.loading} />}
        <div className="row">
          <button type="button" className="btn primary" disabled={busy || !flow} onClick={() => void save()}>{busy ? t('Сохраняю…') : t('Сохранить')}</button>
          <span className={styles.note}>{t('Сохранение коммитит flow в репо команды; невалидный YAML сервер не примет')}</span>
          <span className={msgClass(msg)}>{msg.text}</span>
        </div>
      </div>
    </section>
  );
}

// ---------- настройки

function SettingsTab({ team }: { team: TeamDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const home = useConfig().data?.home;
  const [title, setTitle] = useState(team.title);
  const [columns, setColumns] = useState(team.columns);
  const [defaultFlow, setDefaultFlow] = useState(team.defaultFlow ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(NO_MSG);
  // команда перечиталась (чужая правка, событие team): поля — заново, если их не трогали
  const [base, setBase] = useState(team);
  if (base !== team) {
    const untouched = title === base.title && defaultFlow === (base.defaultFlow ?? '') && STATUSES.every((s) => columns[s] === base.columns[s]);
    setBase(team);
    if (untouched) {
      setTitle(team.title);
      setColumns(team.columns);
      setDefaultFlow(team.defaultFlow ?? '');
    }
  }
  const dirty = title.trim() !== team.title || defaultFlow !== (team.defaultFlow ?? '') || STATUSES.some((s) => columns[s].trim() !== team.columns[s]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const patch: TeamPatch = {};
    if (title.trim() !== team.title) patch.title = title.trim();
    if (STATUSES.some((s) => columns[s].trim() !== team.columns[s])) patch.columns = Object.fromEntries(STATUSES.map((s) => [s, columns[s].trim()])) as TeamDetail['columns'];
    if (defaultFlow !== (team.defaultFlow ?? '')) patch.defaultFlow = defaultFlow || null;
    setBusy(true);
    setMsg(NO_MSG);
    try {
      const r = await updateTeam(team.slug, patch);
      qc.setQueryData(teamKeys.team(team.slug), r);
      void qc.invalidateQueries({ queryKey: teamKeys.list });
      setMsg({ text: t('Сохранено'), tone: 'ok' });
    } catch (err) {
      setMsg({ text: errorText(err), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!(await askConfirm(t('Отключить команду «{title}»? Локальный клон удалится; репо команды и всё, что в нём, останутся. Подключиться снова можно по ссылке.', { title: team.title }), { ok: t('Отключить'), danger: true }))) return;
    try {
      try {
        await removeTeam(team.slug);
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'unpushed')) throw err;
        const d = err.data as { unpushed?: number; commits?: string[] };
        const list = (d.commits ?? []).map((c) => `· ${c}`).join('\n');
        const text = t('Не отправлено изменений: {n}. Они пропадут вместе с клоном.\n{list}\nВсё равно отключить?', { n: d.unpushed ?? d.commits?.length ?? 0, list });
        if (!(await askConfirm(text, { ok: t('Отключить и потерять изменения'), danger: true }))) return;
        await removeTeam(team.slug, true);
      }
      qc.removeQueries({ queryKey: teamKeys.team(team.slug) });
      await qc.invalidateQueries({ queryKey: teamKeys.all });
      void navigate(TEAMS_PATH);
    } catch (err) {
      toast(errorText(err));
    }
  };
  const colLabel: Record<TeamTaskStatus, string> = { todo: t('К работе'), in_progress: t('В работе'), review: t('Ревью'), done: t('Готово') };
  return (
    <section aria-label={t('Настройки')} className={styles.settings}>
      <form className={styles.settings} onSubmit={(e) => void save(e)}>
        <div className={styles.two} style={{ gridTemplateColumns: 'minmax(0, 1fr) 160px' }}>
          <div className={styles.f}>
            <label htmlFor="tw-set-title">{t('Название')}</label>
            <input id="tw-set-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className={styles.f}>
            <label htmlFor="tw-set-prefix">{t('Префикс задач')}</label>
            <input id="tw-set-prefix" className={styles.mono} value={team.prefix} readOnly title={t('Префикс после создания не меняется: на него ссылаются номера задач')} />
          </div>
        </div>
        <div className={styles.f}>
          <label>{t('Названия колонок доски')}</label>
          <div className={styles.cols}>
            {STATUSES.map((s) => (
              <div key={s} className={styles.f}>
                <label htmlFor={`tw-col-${s}`} className={styles.meta}>{s} · {colLabel[s]}</label>
                <input id={`tw-col-${s}`} value={columns[s]} onChange={(e) => setColumns((c) => ({ ...c, [s]: e.target.value }))} />
              </div>
            ))}
          </div>
          <span className={styles.note}>{t('Набор колонок фиксирован, меняются только названия')}</span>
        </div>
        <div className={styles.f}>
          <label htmlFor="tw-set-flow">{t('Flow для «В работу»')}</label>
          <select id="tw-set-flow" value={defaultFlow} onChange={(e) => setDefaultFlow(e.target.value)}>
            <option value="">{t('— не выбран —')}</option>
            {team.flows.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy || !dirty || !title.trim() || STATUSES.some((s) => !columns[s].trim())}>{busy ? t('Сохраняю…') : t('Сохранить')}</button>
          <span className={msgClass(msg)}>{msg.text}</span>
        </div>
      </form>
      <div className={styles.f}>
        <label>{t('Клон на этом компьютере')}</label>
        <span className={styles.meta}><PathLink path={team.dir}>{tildePath(team.dir, home)}</PathLink> · {t('формат {n}', { n: team.format })}</span>
      </div>
      <div className={styles.dangerZone}>
        <p>{t('Отключить команду — удалить локальный клон. Репо команды остаётся, подключиться снова можно по ссылке. С неотправленными изменениями сервер переспросит.')}</p>
        <button type="button" className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => void disconnect()}>{t('Отключить команду…')}</button>
      </div>
    </section>
  );
}

export type { TeamTab };
