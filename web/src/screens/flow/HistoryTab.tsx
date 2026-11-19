// Вкладка «История» экрана flow (docs/flow-redesign/SPEC.md → «Главная и история», design/History.dc.html): версии flow.yaml
// по снимкам запусков сверху вниз, под каждой — её запуски. У версии — «Что изменилось» (разница с версией до неё по
// этапам и блокам; не вышло — снимок в окне файла) и «Вернуть» (версия — в YAML «Правки», «Сохранить» там вернёт её в flows/).
import { useState } from 'react';
import type { FlowVersion } from '@server/api-types';
import { checkFlow, errorText, fetchFlowVersion, useFlowHistory } from '../../api';
import { openRunFile } from '../../components/file/FileDialog';
import { useConfirm } from '../../components/ConfirmDialog';
import { specChanges, toEditable } from '../../lib/flow/edit';
import { versionGroups, versionMeta, versionsNote } from '../../lib/flow/history';
import { t } from '../../lib/i18n';
import { RunRow, useRunActions } from './PastRuns';
import { flowState, loadYamlVersion, useFlowStore } from './store';
import styles from './HistoryTab.module.css';

/** Запусков под версией видно сразу; остальные — по «Ещё N». */
const RUNS_SHOWN = 5;

type Diff = { loading: boolean; lines: string[]; error: string };

export function HistoryTab() {
  const st = useFlowStore();
  const flow = st.flow!;
  const { askConfirm } = useConfirm();
  const actions = useRunActions();
  const q = useFlowHistory(flow.name, flow.yaml);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [diffs, setDiffs] = useState<Record<string, Diff>>({});
  const [more, setMore] = useState<Record<string, boolean>>({});
  const h = q.data;

  const back = async (v: FlowVersion, label: string) => {
    if (flowState.dirty && !(await askConfirm(t('В правке есть несохранённые изменения, в YAML их не будет. Перейти?'), { ok: t('Перейти') }))) return;
    setBusy(v.id);
    setErr('');
    try {
      // задача запуска в снимке — чужая: сервер подставит задачу файла flow
      const r = await fetchFlowVersion(flow.name, v.runId, v.file);
      // пока читали, открыли другой flow — версия ему не нужна
      if (flowState.flow?.name !== flow.name) return;
      loadYamlVersion(r.yaml, label, { text: t('В редакторе — версия {label} из запуска {id}, задача — из файла flow. «Сохранить» вернёт её в flows/, «Вернуть текст flow» — отменит.', { label, id: v.runId }), tone: 'warn' });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy('');
    }
  };

  /** Разница с версией до этой: обе версии — через проверку сервера (в flows/ ничего не пишется), сравнение — как у правки ИИ. */
  const showDiff = async (v: FlowVersion, prev: FlowVersion) => {
    const cur = diffs[v.id];
    // пока сравнивает — клик ничего не делает; после ошибки — сравнить заново; иначе — свернуть
    if (cur?.loading) return;
    if (cur && !cur.error) {
      setDiffs(({ [v.id]: _, ...rest }) => rest);
      return;
    }
    setDiffs((d) => ({ ...d, [v.id]: { loading: true, lines: [], error: '' } }));
    let next: Diff;
    try {
      const [a, b] = await Promise.all([prev, v].map(async (x) => toEditable((await checkFlow({ yaml: (await fetchFlowVersion(flow.name, x.runId, x.file)).yaml })).spec)));
      next = { loading: false, lines: specChanges(a!, b!).lines.map((l) => l.text), error: '' };
    } catch (e) {
      next = { loading: false, lines: [], error: errorText(e) };
    }
    if (flowState.flow?.name !== flow.name) return;
    setDiffs((d) => ({ ...d, [v.id]: next }));
  };

  if (q.error) return <p className="msg err">{t('История flow не загрузилась: {error}', { error: errorText(q.error) })}</p>;
  if (!h) return null;
  const note = versionsNote({ ...h, currentUnrun: undefined });
  const groups = versionGroups(h);
  const snapshot = (v: FlowVersion, label: string) => void openRunFile(v.runId, v.file, t('flow {name} — {label}', { name: flow.name, label }));
  return (
    <section className={styles.history} aria-label={t('История flow')}>
      <p className="muted small">{t('Запуски идут под той версией flow, с которой начинались. Любую версию можно вернуть. Свои flow не лежат в git: версии собраны из снимков запусков.')}</p>
      {!groups.length ? (
        <p className="muted small">{h.total ? t('Снимков flow.yaml у запусков нет.') : t('Flow ещё не запускался: версий нет.')}</p>
      ) : (
        <div className={styles.versions}>
          {groups.map((g) => {
            if (g.kind === 'unrun') {
              return (
                <section key="unrun" className={styles.version}>
                  <div className={styles.vHead}>
                    <span className={styles.vName}>{t('сейчас')}</span>
                    <span className={styles.vNow}>{t('текущая')}</span>
                    <span className={styles.vMeta}>{t('файл flow поправили после последнего запуска')}</span>
                  </div>
                  <p className={styles.vEmpty}>{t('С этой версией запусков ещё не было.')}</p>
                </section>
              );
            }
            const key = g.kind === 'version' ? g.v.id : 'unknown';
            const shown = more[key] ? g.runs : g.runs.slice(0, RUNS_SHOWN);
            const rest = g.runs.length - shown.length;
            const label = g.kind === 'version' ? `v${g.v.n}` : '';
            const diff = g.kind === 'version' ? diffs[g.v.id] : undefined;
            return (
              <section key={key} className={styles.version}>
                {g.kind === 'version' ? (
                  <div className={styles.vHead}>
                    <span className={styles.vName}>{label}</span>
                    {g.v.current && <span className={styles.vNow} title={t('Совпадает с файлом flow сейчас')}>{t('текущая')}</span>}
                    <span className={styles.vMeta} title={t('Отпечаток {id}', { id: g.v.id })}>{versionMeta(g.v)}</span>
                    <span className={styles.vActs}>
                      {g.prev && (
                        <button type="button" className="btn small ghost" aria-expanded={Boolean(diff)} title={t('Чем v{n} отличается от v{prev}', { n: g.v.n, prev: g.prev.n })} onClick={() => void showDiff(g.v, g.prev!)}>
                          {t('Что изменилось')}
                        </button>
                      )}
                      <button type="button" className="btn small ghost" title={t('Снимок flow.yaml этой версии')} onClick={() => snapshot(g.v, label)}>{t('Открыть')}</button>
                      {!g.v.current && (
                        <button type="button" className="btn small" disabled={busy === g.v.id} title={t('Положить эту версию в YAML «Правки» — сохранишь там')} onClick={() => void back(g.v, label)}>
                          {t('Вернуть')}
                        </button>
                      )}
                    </span>
                  </div>
                ) : (
                  <div className={styles.vHead}>
                    <span className={styles.vName}>?</span>
                    <span className={styles.vMeta}>{t('Версия неизвестна: снимка flow.yaml нет или версия старше показанных')}</span>
                  </div>
                )}
                {diff && g.kind === 'version' && (
                  <div className={styles.diff}>
                    {diff.loading ? (
                      <p className="muted small">{t('Сравниваю с v{n}…', { n: g.prev!.n })}</p>
                    ) : diff.error ? (
                      <p className="msg err">
                        {t('Сравнить не вышло: {error}', { error: diff.error })}{' '}
                        <button type="button" className="btn small ghost" onClick={() => snapshot(g.v, label)}>{t('Открыть снимок')}</button>
                      </p>
                    ) : diff.lines.length ? (
                      <ul className={styles.diffList}>
                        {diff.lines.map((l, i) => <li key={i}>{l}</li>)}
                      </ul>
                    ) : (
                      <p className="muted small">
                        {t('В этапах и блоках отличий нет — поменялось что-то мелкое.')}{' '}
                        <button type="button" className="btn small ghost" onClick={() => snapshot(g.v, label)}>{t('Открыть снимок')}</button>
                      </p>
                    )}
                  </div>
                )}
                {g.kind === 'version' && !g.runs.length && <p className={styles.vEmpty}>{t('Запуски этой версии старше показанных.')}</p>}
                {shown.length > 0 && (
                  <ul className={styles.runs}>
                    {shown.map((r) => <RunRow key={r.id} r={r} actions={actions} className={styles.runRow} />)}
                  </ul>
                )}
                {rest > 0 && (
                  <button type="button" className={`btn small ghost ${styles.vMore}`} onClick={() => setMore((m) => ({ ...m, [key]: true }))}>
                    {t('Ещё {n}', { n: rest })}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}
      {note && <p className="muted small">{note}</p>}
      {err && <p className="msg err">{err}</p>}
    </section>
  );
}
