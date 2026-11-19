// «Что произойдёт» справа на вкладке «Запуск» (docs/flow-redesign/design/Main.dc.html, RunBig.dc.html): где спросит тебя,
// когда закончит, что оставит, сколько стоил прошлый раз; ниже — этапы (один блок) или блоки по строке. Логика — lib/flow/plan.ts.
import { useState } from 'react';
import { lastTime, PLAN_HEAD, type RunPlan as Plan } from '../../lib/flow/plan';
import { t } from '../../lib/i18n';
import type { FlowRunRow } from '@server/api-types';
import styles from './RunTab.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

export function RunPlan({ plan, runs, onScheme, onPhase }: { plan: Plan; runs: FlowRunRow[] | undefined; onScheme: () => void; onPhase: (n: number) => void }) {
  const [all, setAll] = useState(false);
  const last = lastTime(runs);
  const folded = new Set(all ? [] : plan.folded);
  const facts: { k: string; v: string; note?: string; money?: boolean }[] = [
    { k: t('Спросит тебя'), v: plan.asks || t('не спросит — работает сам') },
    { k: t('Закончит'), v: plan.ends },
    ...(plan.leaves ? [{ k: t('Оставит'), v: plan.leaves }] : []),
    ...(last ? [{ k: t('В прошлый раз'), v: last.cost, note: last.note, money: true }] : []),
  ];
  return (
    <aside className={styles.plan} aria-label={t('Что произойдёт')}>
      <div className={styles.planHead}>
        <h2 className={styles.planTitle}>{t('Что произойдёт')}</h2>
        <span className={styles.planSum}>{plan.head}</span>
      </div>
      <dl className={styles.facts}>
        {facts.map(({ k, v, note, money }) => (
          <div key={k} className={styles.fact}>
            <dt>{k}</dt>
            <dd>
              {money ? <span className={styles.money}>{v}</span> : v}
              {note && <span className={styles.factNote}>{` ${note}`}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {!plan.multi ? (
        <ol className={styles.steps}>
          {plan.steps.map((s) => (
            <li key={s.n}>
              <button type="button" className={styles.step} title={t('Открыть этап на схеме')} onClick={() => onPhase(s.n)}>
                <span className={cx(styles.num, s.asks && styles.numAsk)}>{s.n}</span>
                <span className={styles.stepText}>
                  <span>{s.title}</span>
                  {s.note && <span className={cx(styles.stepNote, s.asks && styles.ask)}>{s.note}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <>
          <ol className={styles.steps}>
            {plan.blocks.filter((b) => !folded.has(b.n)).map((b) => (
              <li key={b.n} className={styles.blk}>
                <span className={cx(styles.num, b.asks && styles.numAsk)}>{b.n}</span>
                <span className={styles.stepText}>
                  <span>{b.title}</span>
                  {b.asks && <span className={cx(styles.stepNote, styles.ask)}>{t('может спросить тебя')}</span>}
                </span>
                <span className={styles.blkMeta}>{b.meta}</span>
              </li>
            ))}
          </ol>
          {plan.folded.length > 0 && (
            <button type="button" className={cx('btn small ghost', styles.more)} onClick={() => setAll(!all)}>
              {all ? t('Свернуть — первые {n} и где спросит', { n: PLAN_HEAD }) : t('Показать все: ещё {n}', { n: plan.folded.length })}
            </button>
          )}
        </>
      )}
      <div>
        <button type="button" className="btn small" title={t('Схема flow на вкладке «Правка»')} onClick={onScheme}>{t('Открыть схему')}</button>
      </div>
    </aside>
  );
}
