// Экран команды (/teamwork/:team?tab=; spec §11; макет Team.dc.html): шапка с названием, репо и префиксом, строкой синхронизации
// и участниками; вкладки «Проекты» (строки с полосой спринта и форма нового проекта, репо кода — из моих папок), «Участники», «Процесс» (flow команды
// в редакторе YAML с проверкой схемы, сохранение коммитит), «Настройки» (название, колонки, flow по умолчанию, отключение).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDetail, TeamProjectBrief, TeamTaskStatus } from '@server/api-types';
import { ApiError, errorText, useConfig, useFeature } from '../../api';
import { addTeamMe, createProject, removeTeam, saveTeamFlow, teamKeys, updateTeam, useTeam, useTeamConflicts, useTeamFlow, type TeamPatch } from '../../api/teamwork';
import { useConfirm } from '../../components/ConfirmDialog';
import { PathLink } from '../../components/PathLink';
import { useToast } from '../../components/Toast';
import { useMemoryState } from '../../components/useMemoryState';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import { STATUSES, tasksWord } from '../../lib/teamwork/board';
import { changedFields, failView, rebaseForm } from '../../lib/teamwork/form';
import { disconnectQuestion } from '../../lib/teamwork/sync';
import { YamlEditor, type YamlEditorHandle } from '../flow/YamlEditor';
import { Loading } from '../sessions/Loading';
import { reposBody, type RepoDraft } from '../../lib/teamwork/repos';
import { ConflictsDialog } from './ConflictsDialog';
import { guardUnsaved, unsavedKey, useUnsaved } from './unsaved';
import { useFlowTrust } from './FlowTrust';
import trustStyles from './FlowTrust.module.css';
import { Crumbs, cx, ErrorLine, People, readonlyReason, SprintStrip, StaleLine, Tabs, Who } from './parts';
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

  if (!on) return <div className="empty"><h1>Teamwork</h1><p className="muted">{t('Этот сервер не поддерживает Teamwork: обновите agentgraph.')}</p></div>;
  // упавшая перечитка при данных на экране — строка под вкладками: форма нового проекта, YAML «Процесса» и настройки остаются
  if (failView(q.error, Boolean(team)) === 'screen') {
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
      <StaleLine error={q.error} gone={t('Команды {slug} больше нет: её отключили. Показано последнее загруженное, изменения не запишутся.', { slug })} />
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
  // открытость формы — в unsaved.ts рядом с её полями: создание проекта, законченное после ухода с вкладки, закрывает форму
  const [openSaved, setOpen] = useUnsaved<boolean>(unsavedKey('newProjectOpen', team.slug));
  const open = openSaved ?? team.projects.length === 0;
  const ro = team.sync.state === 'readonly' ? readonlyReason() : undefined;
  const active = team.projects.filter((p) => p.status !== 'archived');
  const archived = team.projects.filter((p) => p.status === 'archived');
  return (
    <section aria-label={t('Проекты')}>
      <div className={styles.tabBar}>
        <span className={styles.note}>{team.projects.length ? t('Проект — фича, которую строит команда: ТЗ, архитектура, задачи и спринты') : ''}</span>
        {!open && <button type="button" className="btn small" disabled={Boolean(ro)} title={ro} onClick={() => setOpen(true)}>{t('+ Проект')}</button>}
      </div>
      {open && <NewProjectForm team={team} onClose={() => setOpen(false)} />}
      {team.projects.length === 0 && !open && (
        <div className={styles.emptyBox}>
          <p>{t('Создайте первый проект: название, slug и суть одной строкой. Репо кода можно добавить сразу или позже.')}</p>
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
type NewProjectFields = { slug: string; title: string; summary: string; repos: RepoDraft[] };
const NO_FIELDS: NewProjectFields = { slug: '', title: '', summary: '', repos: [] };

// перезагрузка с заполненной формой нового проекта — вопрос браузера
guardUnsaved((k, v) => {
  if (!k.startsWith(unsavedKey('newProject', '')) || typeof v !== 'object' || v === null || !('slug' in v)) return false;
  const f = v as NewProjectFields;
  return Boolean(f.slug || f.title.trim() || f.summary.trim() || f.repos.length);
});

function NewProjectForm({ team, onClose }: { team: TeamDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  // поля и «Создаю…» — в unsaved.ts по команде: уход на другую вкладку и обратно их не теряет и второй раз не создаст
  const [fields, setFields] = useUnsaved<NewProjectFields>(unsavedKey('newProject', team.slug));
  const { slug, title, summary, repos } = fields ?? NO_FIELDS;
  const setField = <K extends keyof NewProjectFields>(k: K, v: NewProjectFields[K] | ((prev: NewProjectFields[K]) => NewProjectFields[K])) =>
    setFields((d) => {
      const cur = d ?? NO_FIELDS;
      return { ...cur, [k]: typeof v === 'function' ? (v as (p: NewProjectFields[K]) => NewProjectFields[K])(cur[k]) : v };
    });
  const setRepos = (v: RepoDraft[] | ((prev: RepoDraft[]) => RepoDraft[])) => setField('repos', v);
  const [choosing, setChoosing] = useState(false);
  const [busyFlag, setBusy] = useUnsaved<boolean>(unsavedKey('newProject', team.slug, 'busy'));
  const busy = Boolean(busyFlag);
  const [err, setErr] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const ro = team.sync.state === 'readonly' ? readonlyReason() : undefined;
  const slugOk = slug === '' || SLUG_RE.test(slug);
  const body = reposBody(repos);
  const can = !busy && !ro && SLUG_RE.test(slug) && title.trim() !== '' && body !== undefined;
  const close = () => {
    setFields(undefined);
    onClose();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!can) return;
    setBusy(true);
    setErr('');
    try {
      const p = await createProject(team.slug, { slug, title: title.trim(), summary: summary.trim(), ...(body.length ? { repos: body } : {}) });
      // проект создан: поля снимаются сразу, даже если форму уже закрыли сменой вкладки
      setFields(undefined);
      await qc.invalidateQueries({ queryKey: teamKeys.all });
      onClose();
      // форму уже закрыли сменой вкладки — человек занят другим, не уводим его; проект появится в списке
      if (alive.current) void navigate(projectPath(team.slug, p.slug));
    } catch (e2) {
      // форму уже закрыли сменой вкладки — ошибка всплывашкой, поля остаются до возврата
      if (alive.current) setErr(errorText(e2));
      else toast(t('Проект не создан: {error}', { error: errorText(e2) }));
    } finally {
      setBusy(undefined);
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
      <div className={cx(styles.two, styles.twoSlug)}>
        <div className={styles.f}>
          <label htmlFor="tw-np-title">{t('Название')}</label>
          <input id="tw-np-title" value={title} autoFocus placeholder={t('Экспорт счетов')} onChange={(e) => setField('title', e.target.value)} />
        </div>
        <div className={styles.f}>
          <label htmlFor="tw-np-slug">{t('Slug')}</label>
          <input id="tw-np-slug" className={styles.mono} value={slug} placeholder="invoice-export" spellCheck={false} autoComplete="off" aria-invalid={!slugOk || undefined} onChange={(e) => setField('slug', e.target.value.trim().toLowerCase())} />
        </div>
      </div>
      <span className={cx(styles.note, !slugOk && styles.err)}>{slugOk ? t('Slug — папка проекта в репо команды: латиница в нижнем регистре, цифры и дефис. Потом не меняется.') : t('Slug — латиница в нижнем регистре, цифры и дефис')}</span>
      <div className={styles.f}>
        <label htmlFor="tw-np-summary">{t('Суть одной строкой')}</label>
        <input id="tw-np-summary" value={summary} placeholder={t('Бухгалтерия выгружает счета за период в CSV и 1С')} onChange={(e) => setField('summary', e.target.value)} />
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
        <button type="submit" className="btn primary" disabled={!can} title={ro}>{busy ? t('Создаю…') : t('Создать проект')}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={close}>{t('Отмена')}</button>
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
  // отдельный путь сервера, а не PUT всего списка из кэша: участник, пришедший после загрузки экрана, не пропадёт
  const addMe = async () => {
    if (!me.email) return;
    setBusy(true);
    try {
      qc.setQueryData(teamKeys.team(team.slug), await addTeamMe(team.slug));
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
        <span className={styles.note}>{t('Участники — из teamwork.yaml. Вас agentgraph узнаёт по email из git config клона')}</span>
        {!me.inTeam && me.email && <button type="button" className="btn small" disabled={busy || team.sync.state === 'readonly'} title={team.sync.state === 'readonly' ? readonlyReason() : undefined} onClick={() => void addMe()}>{t('Добавить меня')}</button>}
      </div>
      {!me.email && <p className="msg warn">{t('git не знает, кто вы: задайте git config --global user.name и user.email, иначе изменения в команду не запишутся.')}</p>}
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
  const { askConfirm } = useConfirm();
  const [picked, setPicked] = useMemoryState<string>(`teamwork.flow.${team.slug}`, team.flows[0] ?? '');
  const name = team.flows.includes(picked) ? picked : team.flows[0];
  const q = useTeamFlow(team.slug, name);
  const flow = q.data;
  const editor = useRef<YamlEditorHandle>(null);
  const [seq, setSeq] = useState(0);
  const [msg, setMsg] = useState<Msg>(NO_MSG);
  const [busy, setBusy] = useState(false);
  const trust = useFlowTrust();
  // версию из репо команды здесь не одобряли (spec §14): посмотреть дифф и одобрить заранее, а не на запуске
  const reviewTrust = async () => {
    if (!flow?.trust || !name) return;
    if (!(await trust.review(flow.trust))) return;
    await qc.invalidateQueries({ queryKey: teamKeys.flow(team.slug, name) });
    setMsg({ text: t('Эта версия одобрена на этом компьютере'), tone: 'ok' });
  };
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

  // несохранённый YAML: смена flow, уход на другую вкладку или экран и перезагрузка спрашивают, а не теряют его молча
  const dirty = () => Boolean(flow && editor.current && editor.current.value() !== flow.yaml);
  const askDiscard = () => askConfirm(t('Бросить правку flow «{name}»? Изменения пропадут.', { name: name ?? '' }), { ok: t('Бросить'), danger: true });
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search) && dirty());
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void askDiscard().then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker.state]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);
  const pick = async (f: string) => {
    if (f === name) return;
    if (dirty() && !(await askDiscard())) return;
    setMsg(NO_MSG);
    setPicked(f);
  };
  const ro = team.sync.state === 'readonly' ? readonlyReason() : undefined;

  const save = async () => {
    if (!name) return;
    const text = editor.current?.value() ?? '';
    // сохранённое здесь одобряется целиком: если в редактор пришла неодобренная версия коллеги, сначала её изменения
    if (flow?.trust && !(await trust.review(flow.trust))) return;
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
            <button type="button" className={cx(f === name && styles.on)} aria-current={f === name || undefined} onClick={() => void pick(f)}>
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
        {flow?.problems && <p className={cx('msg err', trustStyles.process)}>{t('Этот flow нельзя запускать как flow команды:')}{'\n'}{flow.problems.map((p) => `· ${p}`).join('\n')}</p>}
        {flow?.trust && !flow.problems && (
          <p className={cx('msg warn', trustStyles.process)}>
            {t('Эту версию на этом компьютере не одобряли: запуск попросит её подтвердить.')}{' '}
            <button type="button" className="btn small" onClick={() => void reviewTrust()}>{t('Посмотреть изменения…')}</button>
          </p>
        )}
        {flow && <YamlEditor key={flow.name} ref={editor} className={styles.yaml} value={flow.yaml} seq={seq} />}
        {!flow && !q.isError && <Loading className={styles.loading} />}
        <div className="row">
          <button type="button" className="btn primary" disabled={busy || !flow || Boolean(ro)} title={ro} onClick={() => void save()}>{busy ? t('Сохраняю…') : t('Сохранить')}</button>
          <span className={styles.note}>{t('Сохранение — коммит flow в репо команды; YAML с ошибками не сохранится')}</span>
          <span className={msgClass(msg)}>{msg.text}</span>
        </div>
      </div>
      {trust.dialog}
    </section>
  );
}

// ---------- настройки

/** Поля настроек плоско: название, flow по умолчанию и по полю на колонку — перечитка и запись идут по каждому отдельно. */
type SettingsForm = { title: string; defaultFlow: string } & Record<TeamTaskStatus, string>;
const settingsForm = (team: TeamDetail): SettingsForm => ({ title: team.title, defaultFlow: team.defaultFlow ?? '', ...team.columns });

function SettingsTab({ team }: { team: TeamDetail }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const home = useConfig().data?.home;
  // команда перечиталась (чужая правка, событие team): каждое нетронутое поле — заново, тронутые остаются; запись уносит
  // только поля, изменённые относительно базы формы, — переименование команды коллегой не откатится правкой колонки
  const [base, setBase] = useState(() => settingsForm(team));
  const [form, setForm] = useState(base);
  const [seen, setSeen] = useState(team);
  if (seen !== team) {
    const next = settingsForm(team);
    setSeen(team);
    setForm((f) => rebaseForm(f, base, next));
    setBase(next);
  }
  const { title, defaultFlow } = form;
  const set = (k: keyof SettingsForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(NO_MSG);
  const ro = team.sync.state === 'readonly' ? readonlyReason() : undefined;
  const diff = changedFields(form, base);
  const dirty = Object.keys(diff).length > 0;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const patch: TeamPatch = {};
    if (diff.title !== undefined) patch.title = diff.title;
    const cols = STATUSES.filter((s) => diff[s] !== undefined);
    if (cols.length) patch.columns = Object.fromEntries(cols.map((s) => [s, diff[s]!]));
    if (diff.defaultFlow !== undefined) patch.defaultFlow = diff.defaultFlow || null;
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
        const text = disconnectQuestion(err.data as { unpushed?: number; commits?: string[]; conflicts?: number });
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
        <div className={cx(styles.two, styles.twoPrefix)}>
          <div className={styles.f}>
            <label htmlFor="tw-set-title">{t('Название')}</label>
            <input id="tw-set-title" value={title} onChange={(e) => set('title', e.target.value)} />
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
                <input id={`tw-col-${s}`} value={form[s]} onChange={(e) => set(s, e.target.value)} />
              </div>
            ))}
          </div>
          <span className={styles.note}>{t('Набор колонок фиксирован, меняются только названия')}</span>
        </div>
        <div className={styles.f}>
          <label htmlFor="tw-set-flow">{t('Flow для «В работу»')}</label>
          <select id="tw-set-flow" value={defaultFlow} onChange={(e) => set('defaultFlow', e.target.value)}>
            <option value="">{t('— не выбран —')}</option>
            {team.flows.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="row">
          <button type="submit" className="btn primary" disabled={busy || !dirty || Boolean(ro) || !title.trim() || STATUSES.some((s) => !form[s].trim())} title={ro}>{busy ? t('Сохраняю…') : t('Сохранить')}</button>
          <span className={msgClass(msg)}>{msg.text}</span>
        </div>
      </form>
      <div className={styles.f}>
        <label>{t('Клон на этом компьютере')}</label>
        <span className={styles.meta}><PathLink path={team.dir}>{tildePath(team.dir, home)}</PathLink> · {t('формат {n}', { n: team.format })}</span>
      </div>
      <div className={styles.dangerZone}>
        <p>{t('Отключить команду — удалить её локальный клон. Репо команды останется, подключиться снова можно по ссылке. Если есть неотправленные изменения или нерешённые конфликты, agentgraph спросит ещё раз.')}</p>
        <button type="button" className="btn danger" style={{ alignSelf: 'flex-start' }} onClick={() => void disconnect()}>{t('Отключить команду…')}</button>
      </div>
    </section>
  );
}

export type { TeamTab };
