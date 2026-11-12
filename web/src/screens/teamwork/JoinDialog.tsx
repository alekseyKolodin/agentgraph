// «Подключиться по ссылке» (spec §8.2; макет Join.dc.html): ссылка на репо команды проверяется по мере ввода, найденная команда
// показывается с участниками и проектами, галочка «Добавить меня в участники» (отдельный коммит) включена по умолчанию.
// Репо кода проектов — найдено ли у меня по origin среди проектов дашборда (localRepos проверки) или подсказка git clone;
// папку ненайденного указывают после подключения — на обзоре проекта.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDetail } from '@server/api-types';
import { errorText, useConfig } from '../../api';
import { joinTeam, teamKeys } from '../../api/teamwork';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import { memberLabel } from '../../lib/teamwork/board';
import { cx, Who } from './parts';
import { CloneHint } from './RepoPicker';
import { checkLine, projectsWord, slugFromUrl } from './shell';
import { useRemoteCheck } from './useRemoteCheck';
import styles from './Teamwork.module.css';

export function JoinDialog({ initialUrl = '', onClose, onJoined }: { initialUrl?: string; onClose: () => void; onJoined: (team: TeamDetail) => void }) {
  const qc = useQueryClient();
  const dlg = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [addMe, setAddMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const { check, busy: checking } = useRemoteCheck(url);
  const line = checkLine(check, checking);
  const found = check?.kind === 'team' ? check : undefined;
  const home = useConfig().data?.home;
  useEffect(() => {
    dlg.current?.showModal();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const team = await joinTeam({ url: url.trim(), addMe });
      await qc.invalidateQueries({ queryKey: teamKeys.all });
      onJoined(team);
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };

  const canJoin = url.trim() !== '' && !busy && (!check || check.kind === 'team');
  return (
    <dialog
      ref={dlg}
      className={styles.dlg}
      aria-labelledby="tw-join-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form method="dialog" className={styles.dlgBody} onSubmit={(e) => void submit(e)}>
        <h2 id="tw-join-title">{t('Подключиться к команде')}</h2>
        <p>{t('Вставьте ссылку на репо команды. agentgraph склонирует его к себе и покажет проекты.')}</p>
        <div className={styles.f}>
          <label htmlFor="tw-join-url">{t('Ссылка на репо команды')}</label>
          <input id="tw-join-url" className={styles.mono} value={url} autoFocus spellCheck={false} autoComplete="off" placeholder="git@github.com:acme/payments-team.git" onChange={(e) => setUrl(e.target.value)} />
          <span className={cx(styles.note, line.tone && styles[line.tone])} aria-live="polite">{found ? '' : line.text}</span>
        </div>
        {found && (
          <div className={styles.found} aria-live="polite">
            <div className={styles.foundH}>
              <span className={styles.okmark} aria-hidden="true">✓</span>
              <b>{found.title}</b>
              <span className={styles.meta}>{found.prefix} · {t('формат {n}', { n: found.format })} · {projectsWord(found.projects.length)}</span>
            </div>
            {found.members.length > 0 && (
              <div className={styles.mem}>
                {found.members.map((m) => <span key={m.email}><Who member={m} />{memberLabel(m)}</span>)}
              </div>
            )}
          </div>
        )}
        <label className={styles.chk}>
          <input type="checkbox" checked={addMe} onChange={(e) => setAddMe(e.target.checked)} />
          <span>
            <b>{t('Добавить меня в участники')}</b>
            <small>{t('Имя и email — из git config, отдельным коммитом. Если вы уже в списке, ничего не меняется.')}</small>
          </span>
        </label>
        {found && found.projects.some((p) => p.repos.length) && (
          <div>
            <h3 className={styles.cap}>{t('Репо кода проектов')}</h3>
            <div className={styles.rows}>
              {found.projects.filter((p) => p.repos.length).map((p) => (
                <div key={p.slug} className={styles.jrepo}>
                  <b>{p.slug}</b>
                  <span className={styles.jrepoList}>
                    {p.repos.map((url) => {
                      // ссылка — из чужого project.yaml: только своё поле объекта, не из прототипа
                      const local = found.localRepos && Object.hasOwn(found.localRepos, url) ? found.localRepos[url] : undefined;
                      return (
                        <span key={url} className={styles.jrepoItem}>
                          <span className={styles.jrepoH}>
                            <span className={cx(styles.dot, styles.s6, local ? styles.ok : styles.wait)} aria-hidden="true" />
                            <span className={styles.p}>{url}</span>
                          </span>
                          {local ? <span className={styles.p}>{tildePath(local, home)}</span> : <span className={styles.miss}>{t('не найден на этом компьютере')}</span>}
                          {!local && <CloneHint url={url} />}
                        </span>
                      );
                    })}
                  </span>
                </div>
              ))}
            </div>
            <p className={styles.note} style={{ marginTop: 6 }}>{t('Ничего не скачивается: свою папку репо agentgraph находит по origin среди ваших проектов. Ненайденное — склонируйте и укажите папку на обзоре проекта; без папки задачи этого репо нельзя отправить агенту.')}</p>
          </div>
        )}
        {err && <p className="msg err">{err}</p>}
        <div className={styles.foot}>
          <span className={styles.meta}>{url.trim() ? t('клон: teams/{slug}', { slug: slugFromUrl(url.trim()) }) : ''}</span>
          <span className={styles.grow} />
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
          <button type="submit" className="btn primary" disabled={!canJoin}>{busy ? t('Подключаюсь…') : t('Подключиться')}</button>
        </div>
      </form>
    </dialog>
  );
}
