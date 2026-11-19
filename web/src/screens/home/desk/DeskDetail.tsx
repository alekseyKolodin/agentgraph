// Подробности дела: панель справа от доски (на узком экране — лист поверх). Откуда взялось, о какой вещи, связи и вся
// история (сигналы и переносы из журнала); те же действия, что у карточки. Сборка полей — lib/desk-detail.ts.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { SessionView } from '@server/api-types';
import type { DeskItem } from '@server/desk/types';
import type { RoutineWait } from '@server/routines/types';
import { errorText } from '../../../api';
import { useDeskItem } from '../../../api/desk';
import { columnTitle, DESK_COLUMNS, itemUrl, kindTone, thingLabel } from '../../../lib/desk-board';
import { fieldRows, originOf, relatedOf, signalWho, thingRows, timeline, whenText, type DetailCtx, type DetailLink, type DetailRow } from '../../../lib/desk-detail';
import { t } from '../../../lib/i18n';
import { waitButtons } from '../../../lib/routines/view';
import { LinkForm, type CardActions } from './DeskCard';
import styles from './Desk.module.css';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');
/** Клик с клавиатуры (Enter, пробел) — detail 0: фокус пойдёт за делом в новую колонку. */
const byKey = (e: { detail: number }) => e.detail === 0;

function Anchor({ link, title }: { link: DetailLink; title?: string }) {
  if (link.to) return <Link to={link.to} title={title}>{link.text}</Link>;
  if (link.href) return <a href={link.href} target="_blank" rel="noreferrer" title={title ?? link.href}>{link.text}</a>;
  return <span title={title}>{link.text}</span>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.dSec}>
      <h4 className={styles.dH}>{title}</h4>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className={styles.dRows}>
      {rows.map((r) => (
        <div key={r.label} className={styles.dRow}>
          <dt>{r.label}</dt>
          <dd title={r.title}>{r.link ? <Anchor link={{ ...r.link, text: r.text }} /> : r.text}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DeskDetail({ item, now, ctx, session, wait, decided, act, onClose }: {
  item: DeskItem;
  now: number;
  /** Названия рутин, запусков, сессий и пространств по слагу/id — для ссылок «откуда» и «связи». */
  ctx: DetailCtx;
  /** Сессия по делу (первая): «Открыть» или «Продолжить». */
  session?: SessionView;
  wait?: RoutineWait;
  decided?: boolean;
  act: CardActions;
  /** Закрыть панель; фокус вернётся на карточку (доска). */
  onClose: () => void;
}) {
  const head = useRef<HTMLHeadingElement>(null);
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const detail = useDeskItem(item.key);
  // фокус — на заголовок панели: Escape работает сразу, а с клавиатуры понятно, где ты
  useEffect(() => {
    head.current?.focus();
    setLinking(false);
  }, [item.key]);

  const done = item.column === 'done';
  const tone = kindTone(item);
  const label = thingLabel(item);
  const url = itemUrl(item);
  const moves = detail.data?.moves ?? [];
  const origin = originOf(item, moves, ctx);
  const related = relatedOf(item, ctx);
  const canLink = !done && !item.thing && item.key.startsWith('own:') && act.link;
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn().catch(() => undefined).finally(() => setBusy(false));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  return (
    <aside className={styles.panel} aria-label={t('Подробности дела: {title}', { title: item.title })} onKeyDown={onKey} data-desk-detail={item.key}>
      <div className={styles.dTop}>
        <span className={cx(styles.kind, styles[tone])} title={item.kind}>{item.kind}</span>
        {label && <span className={styles.id} title={label}>{label}</span>}
        <span className={styles.grow} />
        <button type="button" className="btn small ghost" onClick={onClose} aria-label={t('Закрыть подробности')} title={t('Закрыть подробности (Esc)')}>×</button>
      </div>
      <h3 className={styles.dTitle} ref={head} tabIndex={-1}>{item.title}</h3>
      {item.why && <p className={styles.dWhy}>{item.why}</p>}
      {url && <a className={styles.dOpen} href={url} target="_blank" rel="noreferrer">{t('Открыть вещь')}</a>}

      <div className={cx(styles.acts, styles.dActs)}>
        {wait && act.decide && !done && !decided && (
          <>
            <button type="button" className="btn small primary" title={`${wait.routineTitle}: ${wait.question}`} onClick={(e) => act.decide!(wait, 'run', byKey(e))}>{waitButtons(wait).run}</button>
            <button type="button" className="btn small" onClick={(e) => act.decide!(wait, 'later', byKey(e))}>{waitButtons(wait).later}</button>
            <button type="button" className="btn small ghost" onClick={(e) => act.decide!(wait, 'reject', byKey(e))}>{waitButtons(wait).reject}</button>
          </>
        )}
        {!done && session && act.continueSession && (
          <button type="button" className="btn small" disabled={busy} title={session.name} onClick={() => run(() => act.continueSession!(session))}>
            {busy ? t('Открываю…') : session.live ? t('Открыть сессию') : t('Продолжить сессию')}
          </button>
        )}
        {!done && !session && act.startSession && (
          <button type="button" className="btn small" disabled={busy} title={t('Сессия Claude по этому делу: оно перейдёт в «В работе»')} onClick={() => run(act.startSession!)}>
            {busy ? t('Открываю…') : t('Начать сессию')}
          </button>
        )}
        {!done && act.runFlow && <button type="button" className="btn small" onClick={(e) => act.runFlow!(e.currentTarget)}>{t('Запустить flow…')}</button>}
        {canLink && !linking && <button type="button" className="btn small" onClick={() => setLinking(true)}>{t('Привязать вещь…')}</button>}
        {!done && <button type="button" className="btn small ghost" onClick={(e) => act.close('закрыто вручную', byKey(e))}>{t('Закрыть')}</button>}
      </div>
      {linking && act.link && <LinkForm onCancel={() => setLinking(false)} onLink={act.link} />}

      <Section title={t('Перенести в')}>
        <div className={styles.dCols} role="group" aria-label={t('Перенести в')}>
          {DESK_COLUMNS.map((c) => (
            <button key={c} type="button" className={cx('btn small', c !== item.column && 'ghost', c === item.column && styles.dCur)} aria-pressed={c === item.column} disabled={c === item.column} onClick={(e) => act.move(c, byKey(e))}>
              {columnTitle(c)}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t('Откуда взялось')}>
        <p className={styles.dFrom}>
          <b>{origin.headline}</b>
          <span className={styles.by}>{whenText(origin.at, now)}</span>
        </p>
        {origin.links.length > 0 && (
          <ul className={styles.dList}>
            {origin.links.map((l) => <li key={l.text}><Anchor link={l} /></li>)}
          </ul>
        )}
        {origin.signal ? (
          <blockquote className={styles.dSignal}>
            <div className={styles.dSignalHead}>
              <span>{signalWho(origin.signal)}</span>
              <span className={styles.by}>{whenText(origin.signal.at, now)}</span>
            </div>
            {origin.signal.text && <p>{origin.signal.text}</p>}
            {origin.signal.link && /^https?:\/\//i.test(origin.signal.link) && <a href={origin.signal.link} target="_blank" rel="noreferrer">{origin.signal.link.replace(/^https?:\/\//i, '')}</a>}
          </blockquote>
        ) : (
          <p className={styles.dMute}>{t('Исходного сигнала нет: дело заведено без него.')}</p>
        )}
      </Section>

      <Section title={t('Вещь')}>
        <Rows rows={thingRows(item)} />
      </Section>

      <Section title={t('О деле')}>
        <Rows rows={fieldRows(item, now, ctx)} />
      </Section>

      {related.length > 0 && (
        <Section title={t('Связи')}>
          <ul className={styles.dList}>
            {related.map((r) => (
              <li key={`${r.kind}:${r.text}`}>
                <span className={styles.dKind}>{RELATED_KIND[r.kind]()}</span> <Anchor link={r} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t('История')}>
        {detail.isPending ? (
          <p className={styles.dMute}>{t('Загружаю историю…')}</p>
        ) : (
          <>
            {detail.isError && <p className={cx(styles.dMute, styles.err)}>{t('Журнал не загрузился: {error}', { error: errorText(detail.error) })}</p>}
            <ol className={styles.dTl}>
              {timeline(item, moves).map((e) => (
                <li key={e.id} className={cx(styles.dEv, e.kind === 'signal' && styles.dEvSignal)}>
                  <div className={styles.dEvHead}>
                    <b>{e.title}</b>
                    <span className={styles.by} title={new Date(e.at).toLocaleString()}>{whenText(e.at, now)}</span>
                  </div>
                  {(e.who || e.text) && (
                    <div className={styles.dEvBody}>
                      {e.who && <span className={styles.dWho}>{e.who}</span>}
                      {e.text && <span>{e.text}</span>}
                    </div>
                  )}
                  {e.link && <Anchor link={e.link} />}
                </li>
              ))}
            </ol>
          </>
        )}
      </Section>
    </aside>
  );
}

const RELATED_KIND: Record<'run' | 'session' | 'mention' | 'branch' | 'mr', () => string> = {
  run: () => t('Запуск'),
  session: () => t('Сессия'),
  mention: () => t('Упомянул запуск'),
  branch: () => t('Ветка'),
  mr: () => t('MR'),
};
