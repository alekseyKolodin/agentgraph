// Строка запуска flow — в «Прошлых запусках» на вкладке «Запуск» и под версиями на вкладке «История»: дата, задача,
// где встал, статус, цена; действия — «Взять задачу» (текст в поле задачи) и «Продолжить с блока N», если продолжение
// с места остановки есть (то же правило, что у кнопки на странице запуска).
import { useNavigate, Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { FlowRunRow } from '@server/api-types';
import { continueRun, errorText, fetchRun, keys } from '../../api';
import { Badge } from '../../components/Badge';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { clock, usd } from '../../lib/format';
import { continueLabel, runTask, stopText, taskInput } from '../../lib/flow/plan';
import { t } from '../../lib/i18n';
import { artBeforeContinue } from '../run/artStore';
import { runForm, setForm } from './formStore';
import { flowState, set } from './store';
import styles from './RunTab.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

/** Действия у строки: «Взять задачу» кладёт её в поле задачи вкладки «Запуск», «Продолжить» — новый запуск с места остановки. */
export function useRunActions() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { askConfirm, notify } = useConfirm();
  const take = async (r: FlowRunRow) => {
    const name = flowState.flow?.name;
    let text = r.input;
    if (r.inputCut) {
      try {
        text = taskInput((await fetchRun(r.id)).input);
      } catch (err) {
        return void notify(errorText(err));
      }
    }
    // пока читали, открыли другой flow — его форму не трогаем
    if (flowState.flow?.name !== name) return;
    const cur = runForm.input.trim();
    if (cur && cur !== text.trim() && cur !== (flowState.flow?.summary?.input ?? '').trim()) {
      if (!(await askConfirm(t('Заменить текст в поле задачи задачей запуска от {when}?', { when: clock(r.startedAt) }), { ok: t('Заменить') }))) return;
    }
    setForm({ input: text, focusSeq: runForm.focusSeq + 1 });
    set({ tab: 'run' });
  };
  const resume = async (r: FlowRunRow) => {
    const label = continueLabel(r);
    if (!(await askConfirm(t('{action}: новый запуск продолжит запуск от {when} с места остановки, пройденные блоки не повторятся. Модель — как в flow, без лимита по деньгам.', { action: label, when: clock(r.startedAt) }), { ok: label }))) return;
    if (!(await artBeforeContinue(r.id, { notify, toast }))) return;
    let res;
    try {
      res = await continueRun(r.id);
    } catch (err) {
      return void notify(errorText(err));
    }
    await qc.invalidateQueries({ queryKey: keys.runs });
    void navigate(`/run/${res.id}`);
  };
  return { take, resume };
}

export function RunRow({ r, actions, className }: { r: FlowRunRow; actions: ReturnType<typeof useRunActions>; className?: string }) {
  const stop = stopText(r.status, r.stop);
  const cont = continueLabel(r);
  return (
    <li className={cx(styles.runRow, className)}>
      <Link to={`/run/${r.id}`} className={styles.runMain} title={t('Открыть запуск')}>
        <span className={styles.runWhen}>{clock(r.startedAt)}</span>
        <span className={styles.runTask} title={r.input}>{runTask(r)}</span>
        {stop && <span className={styles.runStop}>{stop}</span>}
      </Link>
      <span className={styles.runSide}>
        <Badge status={r.status} />
        <span className={styles.money}>{usd(r.costUsd)}</span>
        {cont && <button type="button" className="btn small" onClick={() => void actions.resume(r)}>{cont}</button>}
        <button type="button" className="btn small ghost" title={t('Подставить задачу этого запуска в поле задачи')} onClick={() => void actions.take(r)}>{t('Взять задачу')}</button>
      </span>
    </li>
  );
}

/** «Прошлые запуски» под формой: три последних и «Вся история». */
export function PastRuns({ runs }: { runs: FlowRunRow[] }) {
  const actions = useRunActions();
  if (!runs.length) return null;
  return (
    <section className={styles.past} aria-label={t('Прошлые запуски')}>
      <div className={styles.pastHead}>
        <h2 className={styles.pastTitle}>{t('Прошлые запуски')}</h2>
        <button type="button" className="btn small ghost" onClick={() => set({ tab: 'history' })}>{t('Вся история')}</button>
      </div>
      <ul className={styles.runList}>
        {runs.slice(0, 3).map((r) => <RunRow key={r.id} r={r} actions={actions} />)}
      </ul>
    </section>
  );
}
