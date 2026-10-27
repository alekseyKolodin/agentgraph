// Виджеты под ответом чата запуска (сервер ui в src/chat.ts): таблица, ссылки, кнопки действий, варианты ответа — и трасса
// шагов над ответом. Модель шлёт только данные (их проверила схема на сервере), рисует их React: текст ячеек — через MdText
// (md.ts экранирует всё сам), ссылки — теми же открывашками, что у страницы запуска. HTML от модели здесь нет.
import { useState } from 'react';
import { Link } from 'react-router';
import type { ChatAction, ChatLink, ChatStep, ChatWidget } from '@server/api-types';
import { openRunFile } from '../../components/file/FileDialog';
import { MdText } from '../../components/MdText';
import { PathLink } from '../../components/PathLink';
import { t } from '../../lib/i18n';
import { actionMeta, actionState, linkLabel, stepKind, stepLabel, stepsSummary, type StepKind } from '../../lib/run/chat';
import { gotoTarget, runBlocks } from '../../lib/run/view';
import { art, openWin } from './artStore';
import { runState, setRunTab } from './store';
import styles from './ChatWidgets.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

/** Значок шага: моноширинный, как в логе. Цвет — только у управления запуском и у ошибки. */
const GLYPH: Record<StepKind, string> = { read: '›', search: '/', cmd: '$', edit: '±', run: '•', other: '·' };
/** Идущий ход показывает последние шаги, а не все: видно, что агент делает сейчас. */
const LIVE_STEPS = 6;
/** Риски трассы в свёрнутой строке: дальше — «…». */
const TICKS_MAX = 40;

function StepRow({ s, runId, current }: { s: ChatStep; runId: string; current?: boolean }) {
  const kind = stepKind(s);
  const text = kind === 'cmd' ? s.target ?? '' : stepLabel(s);
  const body = s.runFile
    ? <button type="button" className={styles.stepLink} title={t('Открыть файл запуска')} onClick={() => void openRunFile(runId, s.runFile!, s.runFile!)}>{text}</button>
    : s.path ? <PathLink path={s.path}>{text}</PathLink> : text;
  return (
    <li className={cx(styles.step, styles[kind], s.error && styles.err, current && styles.cur)}>
      <span className={styles.glyph} aria-hidden="true">{GLYPH[kind]}</span>
      <span className={styles.stepText}>
        {body}
        {s.sub && <span className={styles.sub}>{t('сабагент')}</span>}
        {s.error && <span className={styles.stepErr}>{s.error}</span>}
      </span>
    </li>
  );
}

/** Трасса хода: у готового ответа — свёрнутая строка «N действий» с рисками; у идущего — последние шаги, текущий подсвечен. */
export function StepTrace({ steps: all, runId, live }: { steps: (ChatStep | undefined)[]; runId: string; live?: boolean }) {
  const steps = all.filter((s): s is ChatStep => Boolean(s));
  if (!steps.length) return null;
  if (live) {
    const shown = steps.slice(-LIVE_STEPS);
    return (
      <ol className={cx(styles.trace, styles.liveTrace)} aria-live="polite">
        {steps.length > shown.length && <li className={styles.more}>{t('…ещё {n} раньше', { n: steps.length - shown.length })}</li>}
        {shown.map((s, i) => <StepRow key={steps.length - shown.length + i} s={s} runId={runId} current={i === shown.length - 1} />)}
      </ol>
    );
  }
  return (
    <details className={styles.traceBox}>
      <summary title={t('Что агент делал, пока отвечал')}>
        <span className={styles.traceCaret} aria-hidden="true">›</span>
        <span>{stepsSummary(steps)}</span>
        <span className={styles.ticks} aria-hidden="true">
          {steps.slice(0, TICKS_MAX).map((s, i) => <span key={i} className={cx(styles.tick, styles[stepKind(s)], s.error && styles.err)} />)}
          {steps.length > TICKS_MAX && <span className={styles.tickMore}>…</span>}
        </span>
      </summary>
      <ol className={styles.trace}>{steps.map((s, i) => <StepRow key={i} s={s} runId={runId} />)}</ol>
    </details>
  );
}

// ---------- ссылки

/** «Показать в «Обзоре»» из чата: раскрыть блок и итерацию этапа и подвести к его карточке — как у инспектора графа. */
function gotoPhase(l: ChatLink, msg: (text: string) => void) {
  const st = runState.st;
  if (!st) return;
  const blocks = runBlocks(st.run);
  const sole = (runState.flow?.spec.blocks.length ?? blocks.length) === 1;
  const block = l.block ?? st.run.phases.findLast((p) => p.phase === l.ref)?.block ?? blocks[0]?.name ?? '';
  const go = gotoTarget(st, { kind: 'phase', key: '', block, name: l.ref }, sole);
  if (!go) return msg(t('Этапа «{name}» в этом запуске нет', { name: l.ref }));
  if ('msg' in go) return msg(go.msg);
  if ('start' in go) return;
  for (const k of go.open) runState.fold.over.set(k, true);
  runState.scrollTo = go.target ? { step: go.target, block: 'center' } : { fold: [`b:${go.bi}`], block: 'center' };
  setRunTab('overview', false);
}

const LINK_KIND: Record<ChatLink['kind'], string> = { run_file: t('файл запуска'), artifact: t('артефакт'), phase: t('этап'), path: t('путь') };

function LinkRow({ l, runId, msg }: { l: ChatLink; runId: string; msg: (text: string) => void }) {
  const label = linkLabel(l);
  let el;
  if (l.kind === 'run_file') {
    el = <button type="button" className={styles.linkBtn} title={l.ref} onClick={() => void openRunFile(runId, l.ref, label)}>{label}</button>;
  } else if (l.kind === 'artifact') {
    const known = art.on && Boolean(runState.st?.run.artifacts?.items.some((a) => a.key === l.ref));
    el = (
      <button type="button" className={styles.linkBtn} disabled={!known} title={known ? t('Открыть артефакт') : t('У запуска нет артефакта {key}', { key: l.ref })} onClick={(e) => void openWin(l.ref, e.currentTarget)}>
        {label}
      </button>
    );
  } else if (l.kind === 'phase') {
    el = <button type="button" className={styles.linkBtn} title={t('Показать карточку этапа в «Обзоре»')} onClick={() => gotoPhase(l, msg)}>{label}</button>;
  } else {
    el = <PathLink className={styles.pathLink} path={l.ref}>{label}</PathLink>;
  }
  return (
    <li className={styles.link}>
      {el}
      <span className={styles.linkKind}>{LINK_KIND[l.kind] ?? l.kind}</span>
    </li>
  );
}

// ---------- кнопки действий

function ActionRow({ a, disabled, onAct }: { a: ChatAction; disabled: boolean; onAct: (a: ChatAction, o: { saveToFlows?: boolean }) => Promise<void> }) {
  const [saveToFlows, setSaveToFlows] = useState(false);
  const [busy, setBusy] = useState(false);
  const st = actionState(a);
  const meta = actionMeta(a);
  const danger = a.kind === 'abort' || a.kind === 'restart_iteration';
  const preview = a.kind === 'write_artifact' || a.kind === 'save_flow' || a.kind === 'apply_flow' ? a.text : undefined;
  const click = async () => {
    setBusy(true);
    try {
      await onAct(a, a.kind === 'apply_flow' ? { saveToFlows } : {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={cx(styles.action, st && styles.used)}>
      <div className={styles.actionHead}>
        {st ? (
          <>
            <span className={cx(styles.state, styles[st.tone])}>{st.text}</span>
            <span className={styles.usedLabel}>{a.label}</span>
          </>
        ) : (
          <button
            type="button"
            className={cx('btn small', danger && 'danger')}
            disabled={disabled || busy}
            title={disabled ? t('Агент ещё отвечает: кнопки заработают после ответа') : t('Выполнить — после подтверждения')}
            onClick={() => void click()}
          >
            {a.label}
          </button>
        )}
        {meta && <span className={styles.actionMeta}>{meta}</span>}
      </div>
      {(a.kind === 'answer_pause' || a.kind === 'restart_iteration') && a.text && <blockquote className={styles.quote}>{a.text}</blockquote>}
      {preview !== undefined && (
        <details className={styles.preview}>
          <summary>{a.kind === 'write_artifact' ? t('Текст для записи') : t('YAML flow')}</summary>
          <pre>{preview}</pre>
        </details>
      )}
      {!st && a.kind === 'save_flow' && (
        <p className={styles.warn}>
          {a.keepsSnapshot
            ? t('Общий файл: правка подействует на следующие запуски этого flow. Продолжение этого запуска останется на его снимке.')
            : t('Общий файл: правка подействует на все следующие запуски и продолжения этого flow.')}
        </p>
      )}
      {/* у разового запуска файла в flows/ нет: галочка только потратила бы кнопку */}
      {!st && a.kind === 'apply_flow' && !runState.st?.run.adhoc && (
        <label className={styles.check} title={t('Записать ту же правку и в flows/: её возьмут следующие запуски')}>
          <input type="checkbox" checked={saveToFlows} onChange={(e) => setSaveToFlows(e.target.checked)} /> {t('сохранить и в flow')}
        </label>
      )}
      {st && a.result && <p className={cx(styles.result, styles[st.tone])}>{a.result}</p>}
      {a.openRun && <Link className={styles.runLink} to={`/run/${a.openRun}`}>{t('Открыть запуск {id}', { id: a.openRun })}</Link>}
    </li>
  );
}

// ---------- виджет

export type WidgetProps = {
  w: ChatWidget;
  runId: string;
  /** Идёт ход чата: кнопки и варианты ответа ждут его конца. */
  disabled: boolean;
  /** Варианты ответа видны только у последнего ответа. */
  replies: boolean;
  onAct: (a: ChatAction, o: { saveToFlows?: boolean }) => Promise<void>;
  onReply: (text: string) => void;
  msg: (text: string) => void;
};

export function ChatWidgetView({ w, runId, disabled, replies, onAct, onReply, msg }: WidgetProps) {
  switch (w.type) {
    case 'table':
      return (
        <figure className={styles.widget}>
          {w.title && <figcaption className={styles.wTitle}>{w.title}</figcaption>}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr>{w.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
              <tbody>{w.rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}><MdText text={c} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        </figure>
      );
    case 'links':
      return (
        <figure className={styles.widget}>
          {w.title && <figcaption className={styles.wTitle}>{w.title}</figcaption>}
          <ul className={styles.links}>{w.items.map((l, i) => <LinkRow key={i} l={l} runId={runId} msg={msg} />)}</ul>
        </figure>
      );
    case 'actions':
      return (
        <figure className={styles.widget}>
          {w.title && <figcaption className={styles.wTitle}>{w.title}</figcaption>}
          <ul className={styles.actions}>{w.items.map((a) => <ActionRow key={a.id} a={a} disabled={disabled} onAct={onAct} />)}</ul>
        </figure>
      );
    case 'replies':
      if (!replies) return null;
      return (
        <div className={styles.replies} role="group" aria-label={t('Варианты ответа')}>
          {w.items.map((x, i) => <button key={i} type="button" className={styles.chip} disabled={disabled} onClick={() => onReply(x)}>{x}</button>)}
        </div>
      );
    default:
      return null;
  }
}
