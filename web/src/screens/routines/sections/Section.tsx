// Общее для разделов редактора рутины (Editor.dc.html): раздел с номером и линией, меню «⋯»/«+ Канал», источник
// черновика (вид, поля условий, пример события), уход с экрана из раздела и тип пропсов раздела. Разделы правят только
// черновик через set — сохранение, проверку на истории и переходы ведёт экран, поэтому «Новая рутина» соберётся из тех же
// разделов.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { MatchField, RoutinesOverview, SourceKindView, SourceView } from '@server/routines/types';
import { useSourceSample, type SourceSample } from '../../../api/routines';
import { t } from '../../../lib/i18n';
import { matchFields } from '../../../lib/routines/match';
import { withSampleFields } from '../../../lib/routines/sample';
import { isSchedule, type RoutineDraft } from '../../../lib/routines/spec';
import { cx } from '../parts';
import s from './Sections.module.css';

/** Пропсы раздела: черновик и правка его части. */
export type DraftProps = { d: RoutineDraft; set: (patch: Partial<RoutineDraft>) => void };
/** Раздел заполнил помощник, а человек его ещё не правил («Новая рутина»). */
export type FilledProp = { filled?: boolean };

/** Источник черновика и что от него зависит: вид, поля условий (с полями из примера), пример события. */
export type RoutineSource = {
  /** Источник; нет — расписание, ещё не выбран или удалён. */
  source: SourceView | undefined;
  kind: SourceKindView | undefined;
  /** Поля вида и общие: по их типам buildSpec пишет значения условий. */
  fields: MatchField[];
  /** fields и поля из примера события — список «Поле» у условия. */
  condFields: MatchField[];
  sample: SourceSample;
};

/** Источник черновика: один запрос примера на экран (React Query делит его между разделами). */
export function useRoutineSource(d: Pick<RoutineDraft, 'source'>, data: Pick<RoutinesOverview, 'sources' | 'kinds'>): RoutineSource {
  const source = data.sources.find((x) => x.slug === d.source);
  const kind = source ? data.kinds.find((k) => k.kind === source.spec.kind) : undefined;
  const fields = useMemo(() => matchFields(kind), [kind]);
  const sample = useSourceSample(!isSchedule(d) && source ? source.slug : undefined);
  const condFields = useMemo(() => withSampleFields(fields, sample.data), [fields, sample.data]);
  return { source, kind, fields, condFields, sample };
}

/** Уйти с экрана по ссылке из раздела («Источник ›», «Подключить Slack или Telegram…»). */
export type Leave = (to: string) => void;
const LeaveCtx = createContext<Leave | null>(null);
/**
 * Охрана ухода из разделов: экран решает, что сделать с несохранённым (сохранить черновик, спросить). Без неё — обычный
 * переход. «Новая рутина» может положить сюда flush черновика формы.
 */
export const LeaveProvider = LeaveCtx.Provider;

/** Переход из раздела: через охрану экрана, если она есть. */
export function useLeave(): Leave {
  const navigate = useNavigate();
  const own = useContext(LeaveCtx);
  return own ?? ((to) => void navigate(to));
}

/** Охрана для LeaveProvider: ready() — можно ли уходить (сохранили, человек согласился); да — переход. */
export function useLeaveGuard(ready: () => Promise<boolean>): Leave {
  const navigate = useNavigate();
  return (to) => void ready().then((ok) => ok && navigate(to));
}

/** Клик по ссылке раздела — через охрану; Cmd/Ctrl/Shift и средняя кнопка открывают как обычно (новая вкладка). */
export function leaveClick(leave: Leave, to: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    leave(to);
  };
}

/**
 * Раздел: номер в кружке, линия до следующего раздела, заголовок с подписью и справа — ссылка или счётчик. filled —
 * раздел заполнил помощник, и человек его ещё не правил: метка у заголовка.
 */
export function Section({ n, title, sub, aside, last, filled, children }: { n: number; title: string; sub?: string; aside?: ReactNode; last?: boolean; filled?: boolean; children: ReactNode }) {
  const id = `routine-sec-${n}`;
  return (
    <section className={cx(s.sec, last && s.secLast)} aria-labelledby={id}>
      <div className={s.secRail} aria-hidden="true">
        <span className={s.secNum}>{n}</span>
        {!last && <span className={s.secLine} />}
      </div>
      <div className={s.secBody}>
        <div className={s.secHead}>
          <h2 id={id}>{title}</h2>
          {sub && <span className={s.secSub}>{sub}</span>}
          {filled && <span className={s.by} title={t('Раздел заполнил помощник. Метка уйдёт, когда поправишь раздел сам')}>{t('заполнил помощник')}</span>}
          {aside && (
            <>
              <span className={s.gap} />
              {aside}
            </>
          )}
        </div>
        {children}
      </div>
    </section>
  );
}

export type MenuItem = {
  label: string;
  title?: string;
  danger?: boolean;
  /** Ключ пункта, если названия могут совпасть (два источника с одним названием). По умолчанию — название и номер повтора. */
  key?: string;
  onClick: () => void;
};

/**
 * Кнопка с меню (глобальные .menu и .menu-item, как «⋯» в шапке flow): клик снаружи, Esc и уход фокуса Tab'ом закрывают,
 * ↑ ↓ ходят по пунктам. left — меню от левого края кнопки (под «+ Канал»), иначе от правого (под «⋯» в шапке). label —
 * имя для чтения с экрана, только когда на кнопке значок («⋯»); кнопку с текстом читают её текстом, title — подсказка.
 */
export function MenuButton({ text, label, title, items, className, left }: { text: ReactNode; label?: string; title?: string; items: MenuItem[]; className?: string; left?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: globalThis.MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const keys = items.map((it, i) => it.key ?? `${it.label}\u0000${items.slice(0, i).filter((x) => !x.key && x.label === it.label).length}`);
  return (
    <div
      ref={wrap}
      className="menu-wrap"
      // фокус ушёл за пределы меню (Tab, Shift+Tab) — закрыть; клик по пункту закрывает сам
      onBlur={(e) => {
        if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (!open) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          btn.current?.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const all = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
          const i = all.indexOf(document.activeElement as HTMLButtonElement);
          all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
        }
      }}
    >
      <button ref={btn} type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={title ?? label} onClick={() => setOpen(!open)}>
        {text}
      </button>
      {/* mousedown по пункту не уводит фокус (WebKit не фокусирует кнопки по клику): иначе onBlur выше закрыл бы меню до click */}
      <div className="menu" role="menu" hidden={!open} style={left ? { left: 0, right: 'auto' } : undefined} onMouseDown={(e) => e.preventDefault()}>
        {items.map((it, i) => (
          <button
            key={keys[i]}
            type="button"
            role="menuitem"
            className={cx('menu-item', it.danger && 'danger')}
            title={it.title}
            onClick={() => {
              setOpen(false);
              it.onClick();
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}
