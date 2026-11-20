// Общие куски экранов рутин: точка состояния, переключатель паузы, полоска срабатываний, сегменты, блоки flow, шапка
// рутины с вкладками «Правило · Срабатывания».
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import type { RoutineView } from '@server/routines/types';
import { useFlows } from '../../api';
import { useRoutines } from '../../api/routines';
import { t } from '../../lib/i18n';
import { pillLabel, isDraft, stripTitle, type Tick, type Tone } from '../../lib/routines/view';
import styles from './Routines.module.css';

export const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

export function Dot({ tone, title }: { tone: Tone; title?: string }) {
  return <span className={cx(styles.dot, styles[tone])} title={title} aria-hidden={title ? undefined : true} />;
}

/** Переключатель паузы рутины: role=switch, подпись — что сделает клик. */
export function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return <button type="button" role="switch" className={styles.sw} aria-checked={on} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function Strip({ ticks }: { ticks: Tick[] }) {
  return (
    <span className={styles.strip} title={stripTitle(ticks)} aria-label={stripTitle(ticks)} role="img">
      {ticks.map((k, i) => (
        <span key={i} className={cx(styles.tk, styles[k])} />
      ))}
    </span>
  );
}

/** Сегменты: один выбран (aria-pressed). */
export function Seg<V extends string>({ options, value, onChange, label }: { options: Array<{ value: V; label: string; disabled?: boolean; title?: string }>; value: V; onChange: (v: V) => void; label: string }) {
  return (
    <div className={styles.seg} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Блоки flow по сводке списка flow: перед ними запуск может ждать человека. */
export function useFlowBlocks(flow: string): string[] {
  const flows = useFlows();
  const f = flows.data?.find((x) => x.name === flow);
  return (f?.blocks ?? []).map((b) => b.name);
}

/** Шапка рутины: «‹ Рутины», название, пилюля состояния, вкладки «Правило · Срабатывания», справа — действия. */
/** Фон рутин ведёт другой процесс agentgraph на той же папке настроек: здесь события не ловятся, ручные кнопки работают. */
export function EngineOwnerNote() {
  const owner = useRoutines().data?.engineOwner;
  if (!owner) return null;
  return (
    <p className={styles.warn} title={t('Процесс {who}, pid {pid}. «Запустить сейчас» и «Проверить на истории» работают и здесь.', { who: owner.who === 'desktop' ? t('приложения') : owner.who === 'ui' ? 'agentgraph ui' : owner.who || '?', pid: owner.pid })}>
      {t('Рутины сейчас ведёт другой процесс agentgraph (приложение или agentgraph ui)')}
    </p>
  );
}

export function RoutineHead({ r, slug, title, actions }: { r?: RoutineView; slug: string; title: string; actions?: ReactNode }) {
  const pill = r ? pillLabel(r) : t('черновик');
  const tone = r && !isDraft(r) ? (r.spec.enabled === false ? styles.paused : styles.on) : '';
  return (
    <>
      <Link to="/routines" className={styles.back}>‹ {t('Рутины')}</Link>
      <header className="view-head">
        <div className={styles.titleRow}>
          <h1>{title}</h1>
          <span className={cx(styles.pill, tone)}>{pill}</span>
        </div>
        {actions && <div className="row">{actions}</div>}
      </header>
      <EngineOwnerNote />
      <nav className="tabs page-tabs" aria-label={t('Рутина')}>
        <NavLink to={`/routines/${encodeURIComponent(slug)}`} end className={({ isActive }) => cx('tab', styles.tabLink, isActive && 'active')}>
          {t('Правило')}
        </NavLink>
        <NavLink to={`/routines/${encodeURIComponent(slug)}/log`} className={({ isActive }) => cx('tab', styles.tabLink, isActive && 'active')}>
          {t('Срабатывания')}
        </NavLink>
      </nav>
    </>
  );
}
