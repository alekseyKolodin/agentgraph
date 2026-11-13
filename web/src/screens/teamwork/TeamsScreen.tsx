// «Teamwork» (/teamwork; spec §8.1–8.2, §11; макет Teams.dc.html): мои команды строками со строкой синхронизации и проектами,
// справа форма «Создать команду» — ссылка проверяется по мере ввода (POST /api/teams/check), название и префикс номеров задач;
// «Подключиться по ссылке» открывает диалог JoinDialog. Пустой список объясняет, что нужен пустой репо.
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamSummary } from '@server/api-types';
import { ApiError, errorText, useFeature } from '../../api';
import { createTeam, teamKeys, useTeams } from '../../api/teamwork';
import { useMemoryState } from '../../components/useMemoryState';
import { useNow } from '../../components/useNow';
import { t } from '../../lib/i18n';
import { syncLine } from '../../lib/teamwork/sync';
import { JoinDialog } from './JoinDialog';
import { cx, ErrorLine } from './parts';
import { checkLine, membersWord, PREFIX_RE, projectBriefLine, remoteLabel, slugFromUrl, teamPath } from './shell';
import { useRemoteCheck } from './useRemoteCheck';
import styles from './Teamwork.module.css';

/** Что положим в репо команды (templates/teamwork/): для формы создания. */
const TREE: [string, string][] = [
  ['teamwork.yaml', 'участники, префикс, колонки'],
  ['README.md', 'как подключиться'],
  ['project-template/', 'заготовки ТЗ, архитектуры и дизайна'],
  ['flows/', ''],
  ['  teamwork-prd.yaml', 'черновик ТЗ'],
  ['  teamwork-architecture.yaml', 'архитектура и дизайн'],
  ['  teamwork-split.yaml', 'разбивка на задачи'],
  ['  teamwork-task.yaml', 'задача в работу'],
];

export function TeamsScreen() {
  const on = useFeature('teamwork');
  const teams = useTeams(on);
  const navigate = useNavigate();
  const [join, setJoin] = useState<{ url: string } | null>(null);
  const now = useNow(10_000);
  const list = teams.data ?? [];

  if (!on) {
    return (
      <div className="empty">
        <h1>Teamwork</h1>
        <p className="muted">{t('Этот сервер не поддерживает Teamwork: обновите agentgraph.')}</p>
      </div>
    );
  }
  return (
    <div className={styles.view}>
      <div className="view-head">
        <div>
          <h1>Teamwork</h1>
          <p className={styles.sub}>{t('Команда ведёт проекты в общем git-репо: ТЗ, архитектура, задачи и спринты. Код остаётся в своих репо, агенты работают у каждого на его компьютере.')}</p>
        </div>
      </div>
      <div className={styles.layout}>
        <section className={styles.teams} aria-label={t('Мои команды')}>
          <h2 className={styles.cap}>{t('Мои команды')}{list.length ? ` · ${list.length}` : ''}</h2>
          {teams.isError && <ErrorLine text={errorText(teams.error)} />}
          {teams.data && list.length === 0 && (
            <div className={styles.emptyBox}>
              <p>{t('Команд пока нет. Создайте пустой репо на GitHub, GitLab или где угодно и заведите команду на нём — или подключитесь по ссылке к команде, которая уже есть.')}</p>
              <p>{t('Репо команды хранит только документы, задачи и спринты. Код живёт в своих репо.')}</p>
            </div>
          )}
          {list.length > 0 && (
            <div className={styles.rows}>
              {list.map((team) => <TeamRow key={team.slug} team={team} now={now} />)}
            </div>
          )}
        </section>
        <CreateForm onJoin={(url) => setJoin({ url })} />
      </div>
      {join && (
        <JoinDialog
          initialUrl={join.url}
          onClose={() => setJoin(null)}
          onJoined={(team) => {
            setJoin(null);
            void navigate(teamPath(team.slug));
          }}
        />
      )}
    </div>
  );
}

/** Строка команды: название — ссылка на всю строку; справа строка синхронизации без действий, ниже репо, участники и проекты. */
function TeamRow({ team, now }: { team: TeamSummary; now: number }) {
  const line = syncLine(team.sync, { now });
  const tone = line.tone === 'ok' ? styles.ok : line.tone === 'wait' ? styles.wait : line.tone === 'off' ? styles.off : '';
  return (
    <div className={styles.trow}>
      <div className={styles.trowH}>
        <Link to={teamPath(team.slug)} title={t('Открыть команду')}>{team.title}</Link>
        <span className={styles.meta}>{team.prefix}</span>
        <span className={styles.grow} />
        <span className={cx(styles.sync, line.tone === 'wait' && styles.wait, line.tone === 'off' && styles.off)} title={line.text}>
          <span className={cx(styles.dot, styles.s6, tone)} aria-hidden="true" />
          {line.text}
        </span>
      </div>
      <span className={styles.meta}>{remoteLabel(team.remote)} · {membersWord(team.members)}</span>
      {team.projects.length > 0 ? (
        <span className={styles.pr}>
          {team.projects.map((p, i) => (
            <span key={p.slug}>
              {i > 0 && ' · '}
              <b>{p.title}</b> — {projectBriefLine(p)}
            </span>
          ))}
        </span>
      ) : (
        <span className={styles.pr}>{t('проектов пока нет')}</span>
      )}
    </div>
  );
}

/** Форма «Создать команду»: поля переживают уход с экрана (useMemoryState). */
function CreateForm({ onJoin }: { onJoin: (url: string) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [url, setUrl] = useMemoryState('teamwork.new.url', '');
  const [title, setTitle] = useMemoryState('teamwork.new.title', '');
  const [prefix, setPrefix] = useMemoryState('teamwork.new.prefix', '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const { check, busy: checking } = useRemoteCheck(url);
  const line = checkLine(check, checking);
  const isTeam = check?.kind === 'team';
  const prefixOk = prefix === '' || PREFIX_RE.test(prefix);
  const canCreate = !busy && url.trim() !== '' && title.trim() !== '' && PREFIX_RE.test(prefix) && (!check || check.kind === 'empty');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setErr('');
    try {
      const team = await createTeam({ url: url.trim(), title: title.trim(), prefix });
      await qc.invalidateQueries({ queryKey: teamKeys.all });
      setUrl('');
      setTitle('');
      setPrefix('');
      void navigate(teamPath(team.slug));
    } catch (e2) {
      // в репо уже команда: предложить подключиться вместо создания (spec §8.1 п. 3)
      if (e2 instanceof ApiError && e2.code === 'is_team') setErr(t('В репо уже есть команда — подключитесь к ней.'));
      else setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panelForm} aria-label={t('Новая команда')}>
      <div className={styles.seg} role="tablist" aria-label={t('Как добавить команду')}>
        <button type="button" role="tab" aria-selected="true" className={styles.on}>{t('Создать команду')}</button>
        <button type="button" role="tab" aria-selected="false" title={t('Команда уже есть: склонировать её репо к себе')} onClick={() => onJoin(isTeam ? url.trim() : '')}>{t('Подключиться по ссылке')}</button>
      </div>
      <form className={styles.f} style={{ gap: 14 }} onSubmit={(e) => void submit(e)}>
        <div className={styles.f}>
          <label htmlFor="tw-new-url">{t('Ссылка на пустой репо')}</label>
          <input id="tw-new-url" className={styles.mono} value={url} spellCheck={false} autoComplete="off" placeholder="git@github.com:acme/platform-team.git" onChange={(e) => setUrl(e.target.value)} />
          <span className={cx(styles.note, line.tone && styles[line.tone])} aria-live="polite">
            {line.text}
            {isTeam && <> <button type="button" className="link-btn" style={{ display: 'inline' }} onClick={() => onJoin(url.trim())}>{t('Подключиться')}</button></>}
          </span>
        </div>
        <div className={styles.two}>
          <div className={styles.f}>
            <label htmlFor="tw-new-title">{t('Название')}</label>
            <input id="tw-new-title" value={title} placeholder={t('Платформа')} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className={styles.f}>
            <label htmlFor="tw-new-prefix">{t('Префикс задач')}</label>
            <input id="tw-new-prefix" className={styles.mono} value={prefix} placeholder="PLT" maxLength={6} spellCheck={false} autoComplete="off" aria-invalid={!prefixOk || undefined} onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
          </div>
        </div>
        <span className={cx(styles.note, !prefixOk && styles.err)}>
          {prefixOk
            ? prefix ? t('Номера задач будут {p}-1, {p}-2… Префикс потом не меняется.', { p: prefix }) : t('Латиница, 2–6 букв: номера задач будут PLT-1, PLT-2… Префикс потом не меняется.')
            : t('Префикс — латиница, 2–6 заглавных букв')}
        </span>
        <span className={styles.note}>{t('Первым участником станете вы: имя и email — из git config.')}</span>
        <div className={styles.f}>
          <span className={styles.cap} style={{ margin: 0 }}>{t('Что положим в репо')}</span>
          <pre className={styles.tree}>{TREE.map(([file, desc]) => `${file.padEnd(30)}${desc ? t(desc) : ''}`.trimEnd()).join('\n')}</pre>
        </div>
        {err && <p className="msg err">{err}</p>}
        <div className={styles.go}>
          <button type="submit" className="btn primary" disabled={!canCreate}>{busy ? t('Создаю…') : t('Создать команду')}</button>
          {url.trim() && <span className={styles.meta}>{t('клон: teams/{slug}', { slug: slugFromUrl(url.trim()) })}</span>}
        </div>
      </form>
    </section>
  );
}
