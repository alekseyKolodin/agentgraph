// Главная: «Задачи и код» (ui/dash.js) — задачи Jira и MR или ветки проектов; «Запустить…» заполнит форму запуска
// выбранного flow, запустишь сам. Разделы обновляются своими запросами; данные старше 5 минут подтягиваются при возврате.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegrationsInfo, ProjectInfo, RunSummary } from '@server/api-types';
import { errorText, fetchBranches, fetchIntegrations, fetchJiraIssues, fetchMrs, keys, useRuns, type IntakeTarget } from '../../api';
import { Badge } from '../../components/Badge';
import { useMemoryState } from '../../components/useMemoryState';
import { DASH_STALE_MS, dashCap, dashMore, PRESET_LABEL, runsForBranch, runsForJira, type JiraPreset } from '../../lib/dash';
import { when } from '../../lib/format';
import { LS } from '../../lib/storage';
import homeStyles from './Home.module.css';
import styles from './Dash.module.css';

/** Открыть выбор flow у кнопки «Запустить…». */
export type OnLaunch = (target: IntakeTarget, btn: HTMLElement) => void;

/** GET /api/integrations: Jira, проекты, glab и gh, папка worktree. */
export const useIntegrations = (enabled = true) =>
  useQuery({ queryKey: keys.integrations, queryFn: fetchIntegrations, staleTime: DASH_STALE_MS, enabled });

export function Dash({ onLaunch, onSettings }: { onLaunch: OnLaunch; onSettings: () => void }) {
  const info = useIntegrations();
  return (
    <section className={`${homeStyles.homeSec} ${homeStyles.homeDash}`}>
      <div className={styles.dashHead}>
        <h2 title="«Запустить…» заполнит форму запуска, запустишь сам">Задачи и код</h2>
        <button className="btn small" onClick={onSettings}>Подключения</button>
      </div>
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
              <p className="muted small">Проектов пока нет. Они появятся из директорий проектов запусков или их можно добавить в «Подключениях».</p>
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
      Запустить…
    </button>
  );
}

/** Чипы запусков, связанных со строкой: flow, теги, статус; клик — открыть запуск. */
export function RelatedRuns({ runs }: { runs: RunSummary[] }) {
  const navigate = useNavigate();
  if (!runs.length) return null;
  return (
    <div className={styles.dashRuns}>
      {runs.map((r) => (
        <button key={r.id} className="chip" title={when(r.startedAt)} onClick={() => void navigate(`/run/${r.id}`)}>
          {r.flow}
          {(r.tags || []).map((t) => (
            <span key={t}>
              {' '}
              <span className="muted">#{t}</span>
            </span>
          ))}
          <Badge status={r.status} />
        </button>
      ))}
    </div>
  );
}

/** «Ещё N» под списком. */
function More({ n, onClick }: { n: number; onClick: () => void }) {
  if (!n) return null;
  return <button type="button" className={`btn small ghost ${styles.dashMore}`} onClick={onClick}>Ещё {n}</button>;
}

function Jira({ info, onLaunch }: { info: IntegrationsInfo; onLaunch: OnLaunch }) {
  const qc = useQueryClient();
  const runs = useRuns().data ?? [];
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
        <button className={`btn small ghost ${styles.push}`} title="Обновить" onClick={() => reload(key)}>↻</button>
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
          <button className="btn small">Найти</button>
        </form>
      )}
      {issues.error ? (
        <p className="msg err">{errorText(issues.error)}</p>
      ) : !enabled ? null : !list ? (
        <p className="muted small">Загружаю…</p>
      ) : !list.length ? (
        <p className="muted small">Задач нет.</p>
      ) : (
        <>
          <ul className={styles.dashList}>
            {dashCap(list, more).map((i) => (
              <li key={i.key}>
                <div className={styles.dashRow}>
                  <a href={i.url} target="_blank" rel="noopener" className={styles.dashKey}>{i.key}</a>
                  <span className={styles.dashName} title={i.title}>{i.title}</span>
                  <span className={styles.dashMeta}>{`${i.type} · ${i.status}${i.parent ? ` · ↑ ${i.parent.key}` : ''}`}</span>
                  <LaunchButton target={{ type: 'jira', key: i.key }} onLaunch={onLaunch} />
                </div>
                <RelatedRuns runs={runsForJira(runs, i.key)} />
              </li>
            ))}
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
      <p className="muted small">У репозитория нет origin на GitLab или GitHub.</p>
    ) : !items ? (
      <p className="muted small">Загружаю…</p>
    ) : !items.length ? (
      <p className="muted small">{`Открытых ${mrWord} нет.`}</p>
    ) : (
      <>
        <ul className={styles.dashList}>
          {dashCap(items, more).map((m) => (
            <li key={m.ref}>
              <div className={styles.dashRow}>
                <a href={m.url} target="_blank" rel="noopener" className={styles.dashKey}>{gh ? '#' : '!'}{m.iid}</a>
                <span className={styles.dashName} title={m.title}>
                  {m.draft && <span className="muted">draft · </span>}
                  {m.title}
                </span>
                <span className={styles.dashMeta} title={`${m.sourceBranch} → ${m.targetBranch}`}>
                  {`${m.sourceBranch} → ${m.targetBranch} · ${m.author}`}
                  {m.hasConflicts && <> · <span className="err">конфликты</span></>}
                </span>
                <LaunchButton target={{ type: 'mr', key: m.ref, project: path }} onLaunch={onLaunch} />
              </div>
              <RelatedRuns runs={runsForBranch(runs, path, m.sourceBranch, m.ref)} />
            </li>
          ))}
        </ul>
        <More n={dashMore(items, more)} onClick={() => setMore(true)} />
      </>
    );
  } else {
    const items = branches.data?.branches;
    list = !items ? (
      <p className="muted small">Загружаю…</p>
    ) : (
      <>
        <ul className={styles.dashList}>
          {dashCap(items, more).map((b) => (
            <li key={b.name}>
              <div className={styles.dashRow}>
                <span className={`${styles.dashKey} mono`}>{b.name}</span>
                <span className={`${styles.dashName} muted`} title={b.subject}>{b.subject}</span>
                <span className={styles.dashMeta}>
                  {b.current ? 'текущая · ' : ''}
                  {b.worktree && <span title={b.worktree}>в worktree · </span>}
                  {when(b.updated)}
                </span>
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
  return (
    <div className={styles.dashBox}>
      <div className={styles.dashTitle}>
        <b title={path}>{p.webUrl ? <a href={p.webUrl} target="_blank" rel="noopener">{p.name}</a> : p.name}</b>
        <span className="chips">
          <button className={`chip ${tab === 'mr' ? 'on' : ''}`} onClick={() => { setTab('mr'); setMore(false); }}>{mrWord}</button>
          <button className={`chip ${tab === 'branches' ? 'on' : ''}`} onClick={() => { setTab('branches'); setMore(false); }}>Ветки</button>
          {tab === 'mr' && (
            <button
              className={`chip ${mine ? 'on' : ''}`}
              title={`Только ${mrWord}, где автор — ты (по ${gh ? 'gh' : 'glab'})`}
              onClick={() => {
                setMine(!mine);
                LS.setRaw(MR_MINE_KEY, !mine ? '1' : '0');
                reload(keys.mrs(path, !mine));
              }}
            >
              Мои
            </button>
          )}
        </span>
        <span className="muted small">{count ?? ''}</span>
        <button className={`btn small ghost ${styles.push}`} title="Обновить" onClick={() => reload(tab === 'mr' ? keys.mrs(path, mine) : keys.branches(path))}>↻</button>
      </div>
      {list}
    </div>
  );
}
