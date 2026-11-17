// Общие куски экранов рутин: точка состояния, переключатель паузы, полоска срабатываний, сегменты, редактор условий
// на поля события, «ждать меня» с блоками flow, шапка рутины с вкладками «Правило · Срабатывания».
import { useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import type { MatchField, RoutineMode, RoutineView } from '@server/routines/types';
import { useFlows } from '../../api';
import { t } from '../../lib/i18n';
import { conditionReady, conditionText, opLabel, opsFor, type Condition } from '../../lib/routines/match';
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

/**
 * Условия на поля события: каждое — слот во фразе («Канал = bugs»), клик раскрывает строку правки под фразой
 * (поле · оператор · значение · ×). «+ условие» добавляет строку и сразу её раскрывает.
 */
export function Conditions({ conds, fields, onChange, lead }: { conds: Condition[]; fields: MatchField[]; onChange: (c: Condition[]) => void; lead?: ReactNode }) {
  const [open, setOpen] = useState<number | null>(null);
  const set = (i: number, patch: Partial<Condition>) => onChange(conds.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const remove = (i: number) => {
    onChange(conds.filter((_, j) => j !== i));
    setOpen(null);
  };
  const add = () => {
    const f = fields[0];
    onChange([...conds, { field: f?.key ?? 'title', op: 'eq', value: f?.type === 'bool' ? 'false' : '' }]);
    setOpen(conds.length);
  };
  const cur = open !== null ? conds[open] : undefined;
  const curField = cur && fields.find((f) => f.key === cur.field);
  return (
    <div>
      <div className={styles.sentence}>
        {lead}
        {conds.map((c, i) => (
          <span key={i}>
            {i > 0 || lead ? ' ' : ''}
            <button type="button" className={styles.slot} aria-expanded={open === i} title={t('Поправить условие')} onClick={() => setOpen(open === i ? null : i)}>
              {conditionReady(c) ? conditionText(c, fields) : t('новое условие')}
            </button>
          </span>
        ))}{' '}
        <button type="button" className={cx(styles.slot, styles.add)} title={t('Условие на поле события — без модели: канал, автор, поле равно или содержит')} onClick={add}>
          {t('+ условие')}
        </button>
      </div>
      {cur && open !== null && (
        <div className={styles.condEdit}>
          <select className={styles.inp} aria-label={t('Поле')} value={cur.field} onChange={(e) => {
            const f = fields.find((x) => x.key === e.target.value);
            const ops = opsFor(f?.type);
            set(open, { field: e.target.value, op: ops.includes(cur.op) ? cur.op : ops[0]!, value: f?.type === 'bool' ? 'false' : cur.value });
          }}>
            {fields.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
            {!fields.some((f) => f.key === cur.field) && <option value={cur.field}>{cur.field}</option>}
          </select>
          <select className={styles.inp} aria-label={t('Оператор')} value={cur.op} onChange={(e) => set(open, { op: e.target.value as Condition['op'] })}>
            {opsFor(curField?.type).map((op) => (
              <option key={op} value={op}>{opLabel(op)}</option>
            ))}
          </select>
          {curField?.type === 'bool' ? (
            <select className={styles.inp} aria-label={t('Значение')} value={cur.value} onChange={(e) => set(open, { value: e.target.value })}>
              <option value="true">{t('да')}</option>
              <option value="false">{t('нет')}</option>
            </select>
          ) : curField?.type === 'enum' && curField.options?.length ? (
            <select className={styles.inp} aria-label={t('Значение')} value={cur.value} onChange={(e) => set(open, { value: e.target.value })}>
              <option value="" />
              {curField.options.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input
              className={styles.inp}
              aria-label={t('Значение')}
              autoFocus
              value={cur.value}
              inputMode={curField?.type === 'number' ? 'decimal' : undefined}
              placeholder={cur.op === 'eq' ? t('значение; несколько — через запятую') : t('значение')}
              onChange={(e) => set(open, { value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') setOpen(null);
              }}
            />
          )}
          <button type="button" className="btn small ghost" aria-label={t('Убрать условие')} title={t('Убрать условие')} onClick={() => remove(open)}>×</button>
        </div>
      )}
    </div>
  );
}

/** Блоки flow по сводке списка flow: перед ними запуск может ждать человека. */
export function useFlowBlocks(flow: string): string[] {
  const flows = useFlows();
  const f = flows.data?.find((x) => x.name === flow);
  return (f?.blocks ?? []).map((b) => b.name);
}

/**
 * «Ждать меня»: перед запуском (suggest), перед блоком (until_pause, блоки слотами и «+ блок»), не ждать (auto).
 * У flow из одного блока «перед блоком» — то же, что «перед запуском»: сегмент выключен.
 */
export function WaitClause({ mode, blocks, pauseBefore, onChange }: { mode: RoutineMode; blocks: string[]; pauseBefore: string[]; onChange: (mode: RoutineMode, pauseBefore: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const free = blocks.filter((b) => !pauseBefore.includes(b));
  const canGate = blocks.length > 1 || pauseBefore.length > 0;
  return (
    <>
      <Seg<RoutineMode>
        label={t('Когда ждать меня')}
        value={mode}
        onChange={(m) => onChange(m, m === 'until_pause' && !pauseBefore.length && blocks[1] ? [blocks[1]] : pauseBefore)}
        options={[
          { value: 'suggest', label: t('перед запуском') },
          { value: 'until_pause', label: t('перед блоком'), disabled: !canGate, title: canGate ? undefined : t('У этого flow один блок: остановка перед ним — то же, что перед запуском') },
          { value: 'auto', label: t('не ждать') },
        ]}
      />
      {mode === 'until_pause' && (
        <div className={styles.sentence}>
          {t('Запустится сам и остановится перед')}{' '}
          {pauseBefore.map((b) => (
            <span key={b}>
              <button type="button" className={cx(styles.slot, styles.gate)} title={t('Убрать остановку перед «{block}»', { block: b })} onClick={() => onChange(mode, pauseBefore.filter((x) => x !== b))}>
                {b} ×
              </button>{' '}
            </span>
          ))}
          {free.length > 0 &&
            (adding ? (
              <select
                className={cx(styles.inp, styles.inlineSel)}
                aria-label={t('Блок flow')}
                autoFocus
                value=""
                onBlur={() => setAdding(false)}
                onChange={(e) => {
                  if (e.target.value) onChange(mode, [...pauseBefore, e.target.value]);
                  setAdding(false);
                }}
              >
                <option value="">{t('блок…')}</option>
                {free.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            ) : (
              <button type="button" className={cx(styles.slot, styles.add)} onClick={() => setAdding(true)}>{t('+ блок')}</button>
            ))}
        </div>
      )}
      {mode === 'suggest' && <span className={styles.hint}>{t('Событие появится на главной. Запуск начнётся после твоего «Запустить».')}</span>}
      {mode === 'auto' && <span className={styles.hint}>{t('Запустится сам и пройдёт до конца без остановок.')}</span>}
    </>
  );
}

/** Шапка рутины: «‹ Рутины», название, пилюля состояния, вкладки «Правило · Срабатывания», справа — действия. */
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
