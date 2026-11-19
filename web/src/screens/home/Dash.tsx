// «Задачи и код» (ui/dash.js; раньше на главной, теперь свой раздел /code — screens/code) — задачи Jira и MR или ветки
// проектов; «Запустить…» заполнит форму запуска выбранного flow, запустишь сам. Разделы обновляются своими запросами;
// данные старше 5 минут подтягиваются при возврате. Файл остался здесь: useIntegrations и LaunchButton берут главная и формы.
// «Код» — каталог, а не список дел: у строки MR и задачи, по которой есть открытое дело, — ссылка на его карточку на Главной.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegrationsInfo, ProjectInfo, RunSummary, SessionView, Thing } from '@server/api-types';
import type { DeskItem } from '@server/desk/types';
import { errorText, fetchBranches, fetchIntegrations, fetchJiraIssues, fetchMrs, keys, useConfig, useFeature, useRuns, type IntakeTarget } from '../../api';
import { useDesk } from '../../api/desk';
import { createSession, defaultSessionCwd, SESSION_CWD_KEY, sessionKeys, thingIntake, useSessions } from '../../api/sessions';
import { Badge } from '../../components/Badge';
import { useToast } from '../../components/Toast';
import { useMemoryState } from '../../components/useMemoryState';
import {
  branchThingKey, DASH_STALE_MS, dashCap, dashMore, jiraSessionCwd, jiraThing, mrThing, PRESET_LABEL, runsForBranch, runsForJira, sessionsForThing, thingSessionName, thingSessionPrompt,
  type JiraPreset,
} from '../../lib/dash';
import { deskByKey, deskHref, deskLinkText } from '../../lib/desk';
import { when } from '../../lib/format';
import { t } from '../../lib/i18n';
import { projectHint, projectLabel } from '../../lib/spaces';
import { LS } from '../../lib/storage';
import homeStyles from './Home.module.css';
import styles from './Dash.module.css';

/** Открыть выбор flow у кнопки «Запустить…». */
export type OnLaunch = (target: IntakeTarget, btn: HTMLElement) => void;

/** GET /api/integrations: Jira, проекты, glab и gh, папка worktree. */
export const useIntegrations = (enabled = true) =>
  useQuery({ queryKey: keys.integrations, queryFn: fetchIntegrations, staleTime: DASH_STALE_MS, enabled });

/** Задачи Jira и проекты с MR и ветками — тело раздела «Задачи и код» (screens/code); заголовок и «Подключения» — у раздела. */
export function Dash({ onLaunch }: { onLaunch: OnLaunch }) {
  const info = useIntegrations();
  return (
    <section className={homeStyles.homeSec}>
      {/* Jira без токена не показываем: подключить её можно в «Подключениях» */}
      {(info.error || info.data?.jira?.hasToken) && (
        <div className={styles.dashBox}>
          {info.error ? <p className="msg err">{errorText(info.error)}</p> : info.data && <Jira info={info.data} onLaunch={onLaunch} />}
        </div>
      )}
      {/* фоновый перезапрос упал — ошибка в блоке Jira, проекты остаются, как в старом loadDash */}
      {info.data && (
        <div>
          {info.data.projects.length ? (
            info.data.projects.map((p) => <Project key={p.path} p={p} onLaunch={onLaunch} />)
          ) : (
            <div className={styles.dashBox}>
              <p className="muted small">{t('Проектов пока нет. Они появятся из директорий проектов запусков или их можно добавить в «Подключениях».')}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Кнопка «Запустить…» строки: data-to-flow — клик по ней не закрывает выбор flow, а переоткрывает у себя. */
export function LaunchButton({ target, onLaunch }: { target: IntakeTarget; onLaunch: OnLaunch }) {
  return (
    <button
      className="btn small"
      data-to-flow=""
      onClick={(e) => {
        e.stopPropagation();
        onLaunch(target, e.currentTarget);
      }}
    >
      {t('Запустить…')}
    </button>
  );
}

/** Чипы запусков, связанных со строкой: flow, проект (если есть), статус; клик — открыть запуск. */
export function RelatedRuns({ runs }: { runs: RunSummary[] }) {
  const navigate = useNavigate();
  if (!runs.length) return null;
  return (
    <div className={styles.dashRuns}>
      {runs.map((r) => (
        <button key={r.id} className="chip" title={when(r.startedAt)} onClick={() => void navigate(`/run/${r.id}`)}>
          {r.flow}
          {r.projectRef?.space && (
            <span>
              {' '}
              <span className="muted">{projectLabel(r.projectRef)}</span>
            </span>
          )}
          <Badge status={r.status} />
        </button>
      ))}
    </div>
  );
}

/** Что нужно «Начать сессию»: вещь, откуда взять текст (/api/intake), папка и имя сессии. */
type ThingSession = { target: IntakeTarget; thing: Thing; cwd: string; name: string };

/**
 * «Начать сессию» у задачи и MR: сессия Claude в папке проекта, источник — эта вещь, первое сообщение — ключ, ссылка и
 * текст задачи (как у формы запуска). Пространство сервер берёт сам — открытое пространство проекта папки.
 */
function useStartThingSession(): (o: ThingSession) => Promise<void> {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  return async (o) => {
    try {
      const intake = await thingIntake(o.target);
      const s = await createSession({
        cwd: o.cwd,
        tags: [],
        saveState: true,
        name: o.name,
        prompt: thingSessionPrompt(intake.input),
        source: { thing: o.thing },
        cols: Math.max(80, Math.floor((window.innerWidth - 380) / 8)),
        rows: Math.max(24, Math.floor((window.innerHeight - 190) / 17)),
      });
      LS.setRaw(SESSION_CWD_KEY, s.cwd);
      qc.setQueryData(sessionKeys.one(s.id), s);
      void qc.invalidateQueries({ queryKey: sessionKeys.list, exact: true });
      void navigate(`/sessions/${encodeURIComponent(s.id)}`);
    } catch (err) {
      toast(t('Сессия не началась: {error}', { error: errorText(err) }));
      throw err;
    }
  };
}

/** Кнопка «Начать сессию» строки; null — сессии в этом сервере выключены или вещь не собралась. */
function SessionButton({ session, title }: { session: ThingSession | undefined; title: string }) {
  const on = useFeature('sessions');
  const start = useStartThingSession();
  const [busy, setBusy] = useState(false);
  if (!on || !session) return null;
  return (
    <button
      className="btn small ghost"
      title={title}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        setBusy(true);
        start(session).catch(() => setBusy(false));
      }}
    >
      {busy ? t('Открываю…') : t('Начать сессию')}
    </button>
  );
}

/** Чипы сессий, начатых из этой вещи: имя и «идёт»; клик — открыть сессию. */
function RelatedSessions({ sessions }: { sessions: SessionView[] }) {
  const navigate = useNavigate();
  if (!sessions.length) return null;
  return (
    <div className={styles.dashRuns}>
      {sessions.map((s) => (
        <button key={s.id} className="chip" title={when(s.lastActivityAt)} onClick={() => void navigate(`/sessions/${encodeURIComponent(s.id)}`)}>
          <span className="muted">{t('сессия')}</span> {s.name}
          {s.live && <span className="muted"> · {t('идёт')}</span>}
        </button>
      ))}
    </div>
  );
}

/** Открытые дела по ключу вещи — для ссылок строк на карточку. */
function useDeskByKey(): Map<string, DeskItem> {
  return deskByKey(useDesk().data?.items);
}

/** Ссылка строки на её дело на Главной: «Дело · В плане». Дела нет — ничего. */
function DeskLink({ item }: { item: DeskItem | undefined }) {
  if (!item) return null;
  return (
    <Link className={`chip ${styles.dashDesk}`} to={deskHref(item.key)} title={item.why ? `${item.title} — ${item.why}` : item.title} onClick={(e) => e.stopPropagation()}>
      {deskLinkText(item)}
    </Link>
  );
}

/** Сессии для связей строк: только когда сессии в этом сервере есть. */
function useThingSessions(): SessionView[] {
  const on = useFeature('sessions');
  return useSessions(on).data?.sessions ?? [];
}

/** «Ещё N» под списком. */
function More({ n, onClick }: { n: number; onClick: () => void }) {
  if (!n) return null;
  return <button type="button" className={`btn small ghost ${styles.dashMore}`} onClick={onClick}>{t('Ещё {n}', { n })}</button>;
}

function Jira({ info, onLaunch }: { info: IntegrationsInfo; onLaunch: OnLaunch }) {
  const qc = useQueryClient();
  const runs = useRuns().data ?? [];
  const sessions = useThingSessions();
  const desk = useDeskByKey();
  const serverCwd = useConfig().data?.defaultCwd;
  const [preset, setPreset] = useMemoryState<JiraPreset>('dash.jira.preset', 'sprint');
  // jql — что в поле (недописанный переживает перерисовку), jqlQuery — по какому искали
  const [jql, setJql] = useMemoryState('dash.jira.jql', '');
  const [jqlQuery, setJqlQuery] = useMemoryState('dash.jira.jqlQuery', '');
  const [more, setMore] = useState(false);
  const j = info.jira;

  useEffect(() => {
    if (j?.lastJql && !jql) setJql(j.lastJql);
    // только пришедший с сервера lastJql: правка поля сюда не относится
  }, [j?.lastJql]);

  const query = preset === 'jql' ? jqlQuery : '';
  const key = keys.jira(preset, query);
  // «Своя JQL» без запроса ничего не ищет
  const enabled = Boolean(j?.hasToken) && (preset !== 'jql' || Boolean(query.trim()));
  const issues = useQuery({ queryKey: key, queryFn: () => fetchJiraIssues(preset, query), enabled, staleTime: DASH_STALE_MS });

  // выбор пресета, ↻ и «Найти» всегда загружают заново, со «Загружаю…»
  const reload = (k: readonly unknown[]) => {
    setMore(false);
    void qc.resetQueries({ queryKey: k, exact: true });
  };
  const choose = (k: JiraPreset) => {
    setPreset(k);
    if (k === 'jql') setJqlQuery(jql);
    reload(keys.jira(k, k === 'jql' ? jql : ''));
  };

  const list = issues.data?.issues;
  return (
    <>
      <div className={styles.dashTitle}>
        <b>Jira</b>
        <span className="chips">
          {(Object.keys(PRESET_LABEL) as JiraPreset[]).map((k) => (
            <button key={k} className={`chip ${preset === k ? 'on' : ''}`} onClick={() => choose(k)}>{PRESET_LABEL[k]}</button>
          ))}
        </span>
        <span className="muted small">{list ? `${list.length}` : ''}</span>
        <button className={`btn small ghost ${styles.push}`} title={t('Обновить')} onClick={() => reload(key)}>↻</button>
      </div>
      {preset === 'jql' && (
        <form
          className={`row ${styles.dashJql}`}
          onSubmit={(e) => {
            e.preventDefault();
            setJqlQuery(jql.trim());
            reload(keys.jira('jql', jql.trim()));
          }}
        >
          <input name="jql" value={jql} onChange={(e) => setJql(e.target.value)} placeholder='project = ABC AND status = "In Progress"' spellCheck={false} />
          <button className="btn small">{t('Найти')}</button>
        </form>
      )}
      {issues.error ? (
        <p className="msg err">{errorText(issues.error)}</p>
      ) : !enabled ? null : !list ? (
        <p className="muted small">{t('Загружаю…')}</p>
      ) : !list.length ? (
        <p className="muted small">{t('Задач нет.')}</p>
      ) : (
        <>
          <ul className={styles.dashList}>
            {dashCap(list, more).map((i) => {
              const thing = jiraThing(i);
              const related = runsForJira(runs, i.key, thing?.key);
              const mine = sessionsForThing(sessions, thing?.key);
              const cwd = jiraSessionCwd({ sessions: mine, runs: related, projects: info.projects, fallback: defaultSessionCwd(serverCwd) });
              return (
                <li key={i.key}>
                  <div className={styles.dashRow}>
                    <a href={i.url} target="_blank" rel="noopener" className={styles.dashKey}>{i.key}</a>
                    <span className={styles.dashName} title={i.title}>{i.title}</span>
                    <span className={styles.dashMeta}>{`${i.type} · ${i.status}${i.parent ? ` · ↑ ${i.parent.key}` : ''}`}</span>
                    <DeskLink item={thing && desk.get(thing.key)} />
                    <SessionButton
                      session={thing && cwd ? { target: { type: 'jira', key: i.key }, thing, cwd, name: thingSessionName(i.key, i.title) } : undefined}
                      title={t('Сессия Claude в {cwd}: первым сообщением — эта задача', { cwd })}
                    />
                    <LaunchButton target={{ type: 'jira', key: i.key }} onLaunch={onLaunch} />
                  </div>
                  <RelatedRuns runs={related} />
                  <RelatedSessions sessions={mine} />
                </li>
              );
            })}
          </ul>
          <More n={dashMore(list, more)} onClick={() => setMore(true)} />
        </>
      )}
    </>
  );
}

const MR_MINE_KEY = 'agentgraph.mrMine';

function Project({ p, onLaunch }: { p: ProjectInfo; onLaunch: OnLaunch }) {
  const qc = useQueryClient();
  const runs = useRuns().data ?? [];
  const sessions = useThingSessions();
  const desk = useDeskByKey();
  const path = p.path;
  const [tab, setTab] = useMemoryState<'mr' | 'branches'>(`dash.proj.tab:${path}`, p.remote ? 'mr' : 'branches');
  const [mine, setMine] = useMemoryState(`dash.proj.mine:${path}`, () => LS.raw(MR_MINE_KEY) === '1');
  const [more, setMore] = useState(false);
  // у GitHub это PR с номером #N, у GitLab — MR с !N
  const gh = p.forge === 'github';
  const mrWord = gh ? 'PR' : 'MR';
  const mrs = useQuery({ queryKey: keys.mrs(path, mine), queryFn: () => fetchMrs(path, mine), enabled: tab === 'mr' && Boolean(p.remote), staleTime: DASH_STALE_MS });
  const branches = useQuery({ queryKey: keys.branches(path), queryFn: () => fetchBranches(path), enabled: tab === 'branches', staleTime: DASH_STALE_MS });
  const cur = tab === 'mr' ? mrs : branches;
  const reload = (k: readonly unknown[]) => {
    setMore(false);
    void qc.resetQueries({ queryKey: k, exact: true });
  };

  let list;
  if (cur.error) list = <p className="msg err">{errorText(cur.error)}</p>;
  else if (tab === 'mr') {
    const items = mrs.data?.mrs;
    list = !p.remote ? (
      <p className="muted small">{t('У репозитория нет origin на GitLab или GitHub.')}</p>
    ) : !items ? (
      <p className="muted small">{t('Загружаю…')}</p>
    ) : !items.length ? null : (
      <>
        <ul className={styles.dashList}>
          {dashCap(items, more).map((m) => {
            const thing = mrThing(p, m);
            return (
              <li key={m.ref}>
                <div className={styles.dashRow}>
                  <a href={m.url} target="_blank" rel="noopener" className={styles.dashKey}>{gh ? '#' : '!'}{m.iid}</a>
                  <span className={styles.dashName} title={m.title}>
                    {m.draft && <span className="muted">draft · </span>}
                    {m.title}
                  </span>
                  <span className={styles.dashMeta} title={`${m.sourceBranch} → ${m.targetBranch}`}>
                    {`${m.sourceBranch} → ${m.targetBranch} · ${m.author}`}
                    {m.hasConflicts && <> · <span className="err">{t('конфликты')}</span></>}
                  </span>
                  <DeskLink item={thing && desk.get(thing.key)} />
                  <SessionButton
                    session={thing ? { target: { type: 'mr', key: m.ref, project: path }, thing, cwd: path, name: thingSessionName(`${gh ? '#' : '!'}${m.iid}`, m.title) } : undefined}
                    title={t('Сессия Claude в папке проекта: первым сообщением — этот {mr}', { mr: mrWord })}
                  />
                  <LaunchButton target={{ type: 'mr', key: m.ref, project: path }} onLaunch={onLaunch} />
                </div>
                <RelatedRuns runs={runsForBranch(runs, path, m.sourceBranch, m.ref, thing?.key)} />
                <RelatedSessions sessions={sessionsForThing(sessions, thing?.key)} />
              </li>
            );
          })}
        </ul>
        <More n={dashMore(items, more)} onClick={() => setMore(true)} />
      </>
    );
  } else {
    const items = branches.data?.branches;
    list = !items ? (
      <p className="muted small">{t('Загружаю…')}</p>
    ) : (
      <>
        <ul className={styles.dashList}>
          {dashCap(items, more).map((b) => (
            <li key={b.name}>
              <div className={styles.dashRow}>
                <span className={`${styles.dashKey} mono`}>{b.name}</span>
                <span className={`${styles.dashName} muted`} title={b.subject}>{b.subject}</span>
                <span className={styles.dashMeta}>
                  {b.current ? `${t('текущая')} · ` : ''}
                  {b.worktree && <span title={b.worktree}>{t('в worktree')} · </span>}
                  {when(b.updated)}
                </span>
                <DeskLink item={desk.get(branchThingKey(path, b.name) ?? '')} />
                <LaunchButton target={{ type: 'branch', key: b.name, project: path }} onLaunch={onLaunch} />
              </div>
              <RelatedRuns runs={runsForBranch(runs, path, b.name)} />
            </li>
          ))}
        </ul>
        <More n={dashMore(items, more)} onClick={() => setMore(true)} />
      </>
    );
  }
  const count = tab === 'mr' ? mrs.data?.mrs.length : branches.data?.branches.length;
  // открытых MR/PR нет — карточка в одну строку: «нет» вместо счётчика «0», без пустого тела
  const none = tab === 'mr' && Boolean(p.remote) && !cur.error && mrs.data?.mrs.length === 0;
  return (
    <div className={styles.dashBox}>
      <div className={styles.dashTitle}>
        <b title={path}>{p.webUrl ? <a href={p.webUrl} target="_blank" rel="noopener">{p.name}</a> : p.name}</b>
        {/* проект репозитория — та же подпись, что у его запусков, сессий и MR на Главной */}
        <span className="muted small" title={projectHint(p.projectRef)}>{projectLabel(p.projectRef)}</span>
        <span className="chips">
          <button className={`chip ${tab === 'mr' ? 'on' : ''}`} onClick={() => { setTab('mr'); setMore(false); }}>{mrWord}</button>
          <button className={`chip ${tab === 'branches' ? 'on' : ''}`} onClick={() => { setTab('branches'); setMore(false); }}>{t('Ветки')}</button>
          {tab === 'mr' && (
            <button
              className={`chip ${mine ? 'on' : ''}`}
              title={t('Только {mr}, где автор — ты (по {cli})', { mr: mrWord, cli: gh ? 'gh' : 'glab' })}
              onClick={() => {
                setMine(!mine);
                LS.setRaw(MR_MINE_KEY, !mine ? '1' : '0');
                reload(keys.mrs(path, !mine));
              }}
            >
              {t('Мои')}
            </button>
          )}
        </span>
        <span className="muted small">{none ? t('открытых {mr} нет', { mr: mrWord }) : (count ?? '')}</span>
        <button className={`btn small ghost ${styles.push}`} title={t('Обновить')} onClick={() => reload(tab === 'mr' ? keys.mrs(path, mine) : keys.branches(path))}>↻</button>
      </div>
      {!none && list}
    </div>
  );
}
