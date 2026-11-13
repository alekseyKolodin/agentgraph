// Диалог конфликтов синхронизации (spec §7.4; макет Team.dc.html): конфликты сгруппированы по задаче или документу, у каждого
// выбор «Взять мою версию» / «Оставить версию команды» — по умолчанию команды, она уже лежит в репо. «Сохранить решение» применяет
// выбранное: мою — POST …/conflicts/:id/mine, команды — DELETE …/conflicts/:id, по коммиту на конфликт. Для двух активных
// спринтов моя версия недоступна: задачи второго переносятся руками.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamConflict, TeamMember } from '@server/api-types';
import { errorText } from '../../api';
import { keepMine, keepTheirs, teamKeys } from '../../api/teamwork';
import { clock } from '../../lib/format';
import { t } from '../../lib/i18n';
import { memberByEmail, memberLabel } from '../../lib/teamwork/board';
import { fieldLabel } from '../../lib/teamwork/sync';
import { useReturnFocus } from './focus';
import { cx } from './parts';
import { conflictKindText, conflictValue } from './shell';
import styles from './Teamwork.module.css';

type Choice = 'mine' | 'theirs';

/** Ключ группы: задача, документ или файл. */
const groupKey = (c: TeamConflict): string => c.task ?? c.doc ?? c.file;

export function ConflictsDialog({ team, conflicts, members, onClose }: { team: string; conflicts: readonly TeamConflict[]; members: readonly TeamMember[]; onClose: () => void }) {
  const qc = useQueryClient();
  const dlg = useRef<HTMLDialogElement>(null);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useReturnFocus(dlg);
  useEffect(() => {
    dlg.current?.showModal();
  }, []);

  const groups = new Map<string, TeamConflict[]>();
  for (const c of conflicts) groups.set(groupKey(c), [...(groups.get(groupKey(c)) ?? []), c]);
  const who = (email: string | undefined) => {
    if (!email) return t('участник команды');
    const m = memberByEmail(members, email);
    return m ? memberLabel(m) : email;
  };
  const pick = (c: TeamConflict): Choice => (c.kind === 'sprint' ? 'theirs' : choice[c.id] ?? 'theirs');

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      for (const c of conflicts) {
        if (pick(c) === 'mine') await keepMine(team, c.id);
        else await keepTheirs(team, c.id);
      }
      await qc.invalidateQueries({ queryKey: teamKeys.all });
      onClose();
    } catch (e) {
      setErr(errorText(e));
      void qc.invalidateQueries({ queryKey: teamKeys.all });
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dlg}
      className={styles.dlg}
      aria-labelledby="tw-conflicts-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="tw-conflicts-title">{t('Конфликты синхронизации')}</h2>
      {conflicts.length === 0 ? (
        <p>{t('Конфликтов больше нет.')}</p>
      ) : (
        <p>{t('Ваши изменения разошлись с изменениями команды. Разные поля слились сами, здесь нужно выбрать. Пока выбора нет, в репо лежит версия команды.')}</p>
      )}
      {[...groups.entries()].map(([key, list]) => (
        <section key={key} className={styles.cf} aria-label={key}>
          <div className={styles.cfH}>
            <b><span className={styles.id}>{key}</span>{list[0]?.project && list[0].project !== key ? list[0].project : ''}</b>
            <span className={styles.meta}>{t('{who} · {when}', { who: who(list[0]?.theirsBy), when: list[0] ? clock(list[0].at) : '' })}</span>
          </div>
          {list.map((c) => {
            const cur = pick(c);
            return (
              <div key={c.id} role="radiogroup" aria-label={conflictKindText(c.kind, c.field, Boolean(c.task))} className={styles.cf}>
                <div className={styles.cfH}>
                  <b>{c.field ? fieldLabel(c.field, Boolean(c.task)) : c.kind === 'text' ? t('Текст') : c.kind === 'deleted' ? t('Файл') : t('Спринт')}</b>
                  <span className={styles.meta}>{c.kind === 'field' || c.kind === 'text' || (c.kind === 'sprint' && c.field && c.field !== 'status') ? t('изменили оба') : conflictKindText(c.kind)}</span>
                </div>
                <div className={styles.opts}>
                  <label className={cx(styles.opt, cur === 'mine' && styles.on)} aria-disabled={c.kind === 'sprint' || undefined}>
                    <input type="radio" name={`cf-${c.id}`} checked={cur === 'mine'} disabled={c.kind === 'sprint' || busy} onChange={() => setChoice((m) => ({ ...m, [c.id]: 'mine' }))} />
                    <span className={styles.v}>
                      <b>{c.kind === 'deleted' ? t('Вернуть мою версию') : t('Взять мою версию')}</b>
                      <small>{t('ваша правка')}</small>
                      <pre className={styles.val}>{conflictValue(c.ours)}</pre>
                    </span>
                  </label>
                  <label className={cx(styles.opt, cur === 'theirs' && styles.on)}>
                    <input type="radio" name={`cf-${c.id}`} checked={cur === 'theirs'} disabled={busy} onChange={() => setChoice((m) => ({ ...m, [c.id]: 'theirs' }))} />
                    <span className={styles.v}>
                      <b>{c.kind === 'deleted' ? t('Оставить удалённым') : t('Оставить версию команды')}</b>
                      <small>{t('в репо · {who}', { who: who(c.theirsBy) })}</small>
                      {c.kind !== 'deleted' && <pre className={styles.val}>{conflictValue(c.theirs)}</pre>}
                    </span>
                  </label>
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {err && <p className="msg err">{err}</p>}
      <div className={styles.foot}>
        <span className={styles.hint}>{conflicts.length ? t('Каждое решение уйдёт отдельным коммитом') : ''}</span>
        <span className={styles.grow} />
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{conflicts.length ? t('Позже') : t('Закрыть')}</button>
        {conflicts.length > 0 && <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? t('Сохраняю…') : t('Сохранить решение')}</button>}
      </div>
    </dialog>
  );
}
