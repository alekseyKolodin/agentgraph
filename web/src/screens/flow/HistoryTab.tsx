// Вкладка «История» экрана flow: версии flow.yaml по снимкам запусков. Вынесена из FlowScreen.tsx.
import { useState } from 'react';
import { Link } from 'react-router';
import { errorText, fetchFlowVersion, useFlowHistory } from '../../api';
import { openRunFile } from '../../components/file/FileDialog';
import { useConfirm } from '../../components/ConfirmDialog';
import { versionMeta, versionsNote } from '../../lib/flow/history';
import { t } from '../../lib/i18n';
import { flowState, loadYamlVersion, useFlowStore } from './store';
import styles from './Flow.module.css';

/**
 * Вкладка «Версии»: разные flow.yaml, с которыми начинались его запуски, от свежей к старой. Версию можно открыть
 * (снимок в окне файла) или взять в редактор YAML — «Сохранить» там вернёт её в flows/.
 */
export function HistoryTab() {
  const st = useFlowStore();
  const flow = st.flow!;
  const { askConfirm } = useConfirm();
  const q = useFlowHistory(flow.name, flow.yaml);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const h = q.data;
  const take = async (runId: string, file: string, label: string) => {
    if (flowState.dirty && !(await askConfirm(t('В конструкторе есть несохранённые изменения, во вкладке YAML их не будет. Перейти?'), { ok: t('Перейти') }))) return;
    setBusy(runId);
    setErr('');
    try {
      // задача запуска в снимке — чужая: сервер подставит задачу файла flow
      const r = await fetchFlowVersion(flow.name, runId, file);
      // пока читали, открыли другой flow — версия ему не нужна
      if (flowState.flow?.name !== flow.name) return;
      loadYamlVersion(r.yaml, label, { text: t('В редакторе — версия {label} из запуска {id}, задача — из файла flow. «Сохранить» вернёт её в flows/, «Вернуть текст flow» — отменит.', { label, id: runId }), tone: 'warn' });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy('');
    }
  };
  if (q.error) return <p className="msg err">{t('История flow не загрузилась: {error}', { error: errorText(q.error) })}</p>;
  if (!h) return null;
  const note = versionsNote(h);
  return (
    <section className={styles.versions} aria-label={t('Версии flow')}>
      <p className="muted small">{t('Свои flow не лежат в git: версии собраны из снимков flow.yaml, с которыми начинались запуски.')}</p>
      {!h.versions.length ? (
        <p className="muted small">{h.total ? t('Снимков flow.yaml у запусков нет.') : t('Flow ещё не запускался: версий нет.')}</p>
      ) : (
        <ul className={styles.versionList}>
          {h.versions.map((v) => {
            const label = `v${v.n}`;
            return (
              <li key={v.id}>
                <span className={styles.versionName}>{label}</span>
                {v.current && <span className={styles.versionNow} title={t('Совпадает с файлом flow сейчас')}>{t('текущая')}</span>}
                <span className={styles.versionMeta} title={t('Отпечаток {id}', { id: v.id })}>{versionMeta(v)}</span>
                <span className={styles.versionActs}>
                  <Link to={`/run/${v.runId}`} title={t('Последний запуск с этой версией')}>{t('запуск')}</Link>
                  <button type="button" className="btn small ghost" onClick={() => void openRunFile(v.runId, v.file, t('flow {name} — {label}', { name: flow.name, label }))}>{t('Открыть')}</button>
                  {!v.current && (
                    <button type="button" className="btn small" disabled={busy === v.runId} title={t('Положить эту версию в редактор YAML — сохранишь там')} onClick={() => void take(v.runId, v.file, label)}>
                      {t('В редактор')}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {note && <p className="muted small">{note}</p>}
      {err && <p className="msg err">{err}</p>}
    </section>
  );
}
