// Строка синхронизации в шапке команды и проекта (spec §7, §11; макет SyncStates.dc.html): точка и текст по TeamSync через
// syncLine() из lib/teamwork/sync.ts. Клик по тексту — синхронизировать сейчас (POST /sync); у «не отправлено» — «Повторить»,
// у конфликта — «Разобрать» (диалог конфликтов), у чужого формата — ссылка на обновление в сайдбаре.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamConflict, TeamSync } from '@server/api-types';
import { errorText } from '../../api';
import { syncTeam, teamKeys } from '../../api/teamwork';
import { useToast } from '../../components/Toast';
import { useNow } from '../../components/useNow';
import { t } from '../../lib/i18n';
import { syncLine } from '../../lib/teamwork/sync';
import { cx } from './parts';
import styles from './Teamwork.module.css';

type Props = {
  team: string;
  sync: TeamSync;
  /** Формат репо команды: подпись «только чтение: формат N новее». */
  format?: number;
  conflicts?: readonly TeamConflict[];
  /** «Разобрать»: открыть диалог конфликтов. */
  onResolve?: () => void;
};

export function SyncLine({ team, sync, format, conflicts, onResolve }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // «12 с назад» живёт: перерисовка раз в 10 секунд
  const now = useNow(10_000);
  const line = syncLine(sync, { conflicts, format, now });
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await syncTeam(team);
      if (r.error) toast(t('Синхронизация не удалась: {error}', { error: r.error }));
      // ответ — свежий TeamSync, но детали команды и проектов тоже могли обновиться после pull
      await qc.invalidateQueries({ queryKey: teamKeys.all });
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const tone = line.tone === 'ok' ? 'ok' : line.tone === 'wait' ? 'wait' : line.tone === 'off' ? 'off' : '';
  return (
    <span className={cx(styles.sync, line.tone === 'wait' && styles.wait, line.tone === 'off' && styles.off)}>
      <button type="button" className={styles.syncText} disabled={busy || sync.state === 'readonly'} title={t('Синхронизировать сейчас: получить изменения команды и отправить свои')} onClick={() => void run()}>
        <span className={cx(styles.dot, styles.s6, tone && styles[tone])} aria-hidden="true" />
        {busy ? t('синхронизирую…') : line.text}
      </button>
      {line.action?.kind === 'retry' && <button type="button" className="btn small" disabled={busy} onClick={() => void run()}>{line.action.label}</button>}
      {line.action?.kind === 'resolve' && onResolve && <button type="button" className="btn small" onClick={onResolve}>{line.action.label}</button>}
      {line.action?.kind === 'update' && <span className={styles.syncLink} title={t('Плашка новой версии — в сайдбаре у названия AgentGraph')}>{line.action.label}</span>}
    </span>
  );
}
