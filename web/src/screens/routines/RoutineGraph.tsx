// Путь одного срабатывания в «Срабатываниях» (docs/ASSISTANTS.md §4): шаги рутины цепочкой — что прошло, где событие
// остановилось и почему. Шаги и подписи — lib/routines/graph.ts. Редактор правило так не рисует: там разделы.
import type { PathNode } from '../../lib/routines/graph';
import { modelChip } from '../../lib/flow/ai-progress';
import { t } from '../../lib/i18n';
import { cx } from './parts';
import styles from './RoutineGraph.module.css';

const MARK: Record<PathNode['state'], string> = { pass: '✓', stop: '✕', ask: '?', off: '' };
const MARK_LABEL: Record<PathNode['state'], string> = { pass: t('пройдено'), stop: t('остановилось здесь'), ask: t('ждёт тебя'), off: t('не дошло') };

/** Путь срабатывания по узлам рутины. */
export function EventPath({ path }: { path: PathNode[] }) {
  return (
    <ol className={styles.graph} aria-label={t('Путь события')}>
      {path.map((p, i) => (
        <li key={p.id}>
          {i > 0 && <span className={cx(styles.link, p.state !== 'off' && styles.pass)} aria-hidden="true" />}
          <div className={cx(styles.node, styles.step, p.state === 'off' && styles.off, p.state === 'pass' && styles.pass, p.state === 'stop' && styles.stop, p.state === 'ask' && styles.ask)}>
            <span className={cx(styles.mark, p.state === 'pass' && styles.pass, p.state === 'stop' && styles.stop, p.state === 'ask' && styles.ask)} aria-label={MARK_LABEL[p.state]}>{MARK[p.state]}</span>
            <b>{p.title}</b>
            <span className={styles.meta}>
              {p.model && <span className={cx(styles.who, styles.model)} title={t('Модель, которая решала: {model}', { model: p.model })}>{modelChip(p.model)}</span>}
            </span>
            {p.note && <span className={styles.sub}>{p.note}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
