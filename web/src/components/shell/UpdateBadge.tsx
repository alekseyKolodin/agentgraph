// Автообновление в сайдбаре: плашка у названия, когда на upstream есть новая версия, и диалог с новыми коммитами,
// предупреждением о том, что перезапуск остановит, и ходом обновления. После перезапуска сервера страница
// перезагружается сама — новая сборка UI приходит вместе с новым сервером.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UpdateStatus } from '@server/api-types';
import { errorText, useFeature } from '../../api';
import { fetchUpdate, startUpdate, updateKey, useUpdate } from '../../api/update';
import { t } from '../../lib/i18n';
import { backAfterRestart, busyWarning, isRestarting, stepLabel, updateBadge } from '../../lib/update';
import styles from './Sidebar.module.css';

/** Сколько ждать новый сервер после перезапуска, прежде чем сказать, что он не вернулся. */
const RESTART_WAIT_MS = 3 * 60_000;

export function UpdateBadge() {
  const on = useFeature('update');
  const q = useUpdate(on);
  const s = q.data;
  const [open, setOpen] = useState(false);
  /** Когда эта вкладка увидела перезапуск; null — не видела. */
  const [restartAt, setRestartAt] = useState<number | null>(null);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (isRestarting(s) && restartAt === null) setRestartAt(Date.now());
  }, [s, restartAt]);
  // новый процесс ответил — перезагрузка за новой сборкой UI
  const back = backAfterRestart(restartAt !== null, s, q.isError);
  useEffect(() => {
    if (back) location.reload();
  }, [back]);
  useEffect(() => {
    if (restartAt === null || !isRestarting(s)) return;
    const id = setTimeout(() => setLost(true), Math.max(0, restartAt + RESTART_WAIT_MS - Date.now()));
    return () => clearTimeout(id);
  }, [s, restartAt]);

  const badge = updateBadge(s);
  if (!badge || !s) return null;
  const tone = badge.tone === 'fail' ? styles.updateFail : badge.tone === 'busy' ? styles.updateBusy : '';
  return (
    <>
      <button
        type="button"
        className={`${styles.updateBadge} ${tone}`}
        title={s.latest && s.latest !== s.version ? t('Новая версия agentgraph: {from} → {to}', { from: s.version, to: s.latest }) : t('Новая версия agentgraph')}
        onClick={() => setOpen(true)}
      >
        {badge.text}
      </button>
      {open && <UpdateDialog status={s} lost={lost} onClose={() => setOpen(false)} />}
    </>
  );
}

function UpdateDialog({ status: s, lost, onClose }: { status: UpdateStatus; lost: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const dlg = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    dlg.current?.showModal();
  }, []);

  const set = (next: UpdateStatus) => qc.setQueryData(updateKey, next);
  const apply = () => {
    setError(null);
    startUpdate().then(set, (err: unknown) => setError(errorText(err)));
  };
  const recheck = () => {
    setError(null);
    setChecking(true);
    fetchUpdate(true)
      .then(set, (err: unknown) => setError(errorText(err)))
      .finally(() => setChecking(false));
  };

  // пока идёт обновление, окно не закрыть; сервер не вернулся после перезапуска — можно
  const moving = s.state === 'updating' || (s.state === 'restarting' && !lost);
  const canApply = (s.state === 'available' || s.state === 'failed') && !s.blocked;
  const warn = busyWarning(s.busy);
  const headline = s.latest && s.latest !== s.version ? t('agentgraph {from} → {to}', { from: s.version, to: s.latest }) : t('Новая версия agentgraph');
  return (
    <dialog
      ref={dlg}
      className={styles.updateDialog}
      aria-labelledby="update-title"
      onCancel={(e) => {
        // во время обновления окно не закрывается: перезагрузка страницы придёт сама
        e.preventDefault();
        if (!moving) onClose();
      }}
    >
      <h2 id="update-title">{headline}</h2>
      {s.behind !== undefined && s.upstream && (
        <p className="muted">{t('Новых коммитов на {upstream}: {n}', { upstream: s.upstream, n: s.behind })}</p>
      )}
      {!!s.commits?.length && (
        <ul className={styles.updateCommits}>
          {s.commits.map((c) => (
            <li key={c.sha}>
              <code>{c.sha}</code> {c.subject}
            </li>
          ))}
        </ul>
      )}
      {s.state === 'updating' && <p className={styles.updateStep}>{stepLabel(s.step)}</p>}
      {s.state === 'restarting' && <p className={styles.updateStep}>{lost ? t('Сервер не вернулся после перезапуска. Запустите agentgraph вручную.') : t('Перезапускаю agentgraph — страница обновится сама…')}</p>}
      {s.state === 'updated' && <p className="warn">{t('Обновлено. Перезапустите agentgraph, чтобы включить новую версию.')}</p>}
      {s.state === 'updated' && s.error && <p className="error">{s.error}</p>}
      {s.state === 'failed' && s.error && <p className="error">{t('Обновление не удалось, код возвращён к прежней версии: {error}', { error: s.error })}</p>}
      {s.blocked && <p className="warn">{t('Обновить автоматически нельзя: {why}', { why: s.blocked })}</p>}
      {canApply && warn && <p className="warn">{warn}</p>}
      {canApply && !s.canRestart && <p className="muted">{t('После обновления перезапустите agentgraph вручную.')}</p>}
      {s.checkError && !moving && <p className="muted">{t('Последняя проверка не удалась: {error}', { error: s.checkError })}</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        {canApply && (
          <button type="button" className="btn primary" onClick={apply} autoFocus>
            {s.canRestart ? t('Обновить и перезапустить') : t('Обновить')}
          </button>
        )}
        {!moving && s.state !== 'updated' && s.state !== 'restarting' && (
          <button type="button" className="btn" disabled={checking} onClick={recheck} title={t('git fetch сейчас, не дожидаясь проверки по таймеру')}>
            {checking ? t('Проверяю…') : t('Проверить снова')}
          </button>
        )}
        {!moving && (
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('Закрыть')}
          </button>
        )}
      </div>
    </dialog>
  );
}
