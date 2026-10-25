// Главная: идущие запуски строками со сводкой (ui/app.js homeRunHtml, renderHome): что происходит сейчас и почему,
// мини-лента итераций, стоимость и действия — пауза, возобновление, стоп, ответ на паузу агента.
import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import type { HomeRun } from '@server/api-types';
import { api, errorText, useFeature } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { projectLabels } from '../../lib/format';
import { homeRunView } from '../../lib/home';
import { artResume } from '../run/artStore';
import styles from './Home.module.css';

export function HomeRuns({ runs, now }: { runs: HomeRun[]; now: number }) {
  const navigate = useNavigate();
  const { askConfirm, notify } = useConfirm();
  const artifacts = useFeature('artifacts');
  const toast = useToast();
  const labels = projectLabels([...new Set(runs.map((r) => r.cwd || ''))]);
  const open = (id: string) => void navigate(`/run/${id}`);

  const pause = async (id: string, on: boolean) => {
    // черновики артефактов и недописанный на странице запуска ответ на паузу — вместе с «Возобновить» (artBeforeResume)
    if (!on && artifacts) return artResume(id, runs.find((x) => x.id === id), { notify, toast });
    try {
      await api('POST', `/api/runs/${id}/${on ? 'pause' : 'resume'}`);
    } catch (err) {
      await notify(errorText(err));
    }
  };
  const abort = async (id: string) => {
    if (!(await askConfirm('Остановить запуск? Текущая сессия будет прервана.', { ok: 'Остановить запуск', danger: true }))) return;
    try {
      await api('POST', `/api/runs/${id}/abort`);
    } catch (err) {
      await notify(errorText(err));
    }
  };

  return (
    <ul className={styles.homeRuns}>
      {runs.map((r) => {
        const v = homeRunView(r, labels.get(r.cwd || '') ?? '', artifacts, now);
        // кнопки внутри строки — свои действия, не «открыть»
        const act = (fn: () => void) => (e: MouseEvent) => {
          e.stopPropagation();
          fn();
        };
        return (
          <li
            key={r.id}
            className={`${styles.hrun} ${v.tone === 'wait' ? styles.wait : 'live'}`}
            tabIndex={0}
            title="Открыть запуск"
            onClick={() => open(r.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.target === e.currentTarget) open(r.id);
            }}
          >
            <span className={styles.hrunDot} aria-hidden="true" />
            <div className={styles.hrunMain}>
              <div className={styles.hrunTop}>
                <span className={styles.hrunTitle}>{v.title}</span>
                <span className={styles.hrunMeta} title={r.cwd || ''}>{v.meta}</span>
              </div>
              <div className={styles.hrunSum} title={v.sum}>{v.sum}</div>
            </div>
            {v.ticks.length > 0 && (
              <span className={styles.hrunTicks} title="Итерации: ✓ прошла, ✕ не прошла, синяя — идёт">
                {v.ticks.map((st, i) => <span key={i} className={`${styles.rbTick} ${styles[st]}`} />)}
              </span>
            )}
            <span className={styles.hrunCost} title={v.costTitle}>{v.cost}</span>
            <span className={styles.hrunActs}>
              {/* пауза по просьбе агента у flow с артефактом решений: ответ пишется на странице запуска (поле «Ответ») */}
              {v.answer && (
                <button
                  className="btn small primary"
                  title={`Этап «${r.pauseReason!.phase}» ждёт решения: ответ допишется в артефакт решений`}
                  onClick={act(() => void navigate(`/run/${r.id}`, { state: { focusAnswer: true } }))}
                >
                  Ответить
                </button>
              )}
              {r.pause ? (
                <button className={`btn small ${v.answer ? '' : 'primary'}`} onClick={act(() => void pause(r.id, false))}>Возобновить</button>
              ) : (
                <button className="btn small ghost" title="Текущий этап доработает, следующий не начнётся" onClick={act(() => void pause(r.id, true))}>Пауза</button>
              )}
              <button className="btn small ghost danger" title="Остановить запуск" onClick={act(() => void abort(r.id))}>Стоп</button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
