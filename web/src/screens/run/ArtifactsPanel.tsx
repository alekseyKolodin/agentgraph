// Панель «Артефакты» страницы запуска и значки шагов (ui/artifacts.js artRenderPanel, artPhaseLine, artCondLine, artIterMark,
// artFinalLine, artGraphPatch): строки по ключам, сводка в шапке свёртки, подсказка, предупреждения. Состояние — artStore.ts.
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ConditionReport, PhaseReport } from '@server/api-types';
import { useRuns } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { ICON } from '../../components/shell/FlowList';
import { useToast } from '../../components/Toast';
import { locale, t } from '../../lib/i18n';
import {
  artAsking, artAttention, artAuthor, artClock, artStepKey, draftDirty, hintLines, iterWarnCount, iterWarnText, lockText, rowMarks, stepLine, stepOf,
  summaryParts, tasksBadge, type ArtMark,
} from '../../lib/run/artifacts';
import { fileSize } from '../../lib/run-form';
import type { RunView } from '../../lib/run/events';
import { foldOpen } from '../../lib/run/view';
import { art, artItems, artReload, artWarnings, dirtyDrafts, draftOf, multiOf, openWin } from './artStore';
import { bump, runState, setRunTab } from './store';
import graphStyles from '../../components/graph/FlowGraph.module.css';
import styles from './Artifacts.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
const markCls = (m: ArtMark) => cx(styles.artMark, ...(m.cls?.split(' ').map((c) => styles[c]) ?? []));
const Mark = ({ m }: { m: ArtMark }) => <span className={markCls(m)} title={m.title}>{m.text}</span>;

/** «Открыть артефакты» с карточки паузы и «Итога»: раскрыть панель, перейти на её вкладку и к ней. */
export function artReveal(): void {
  if (!runState.st) return;
  runState.fold.over.set('art', true);
  setRunTab('artifacts');
  requestAnimationFrame(() => {
    document.getElementById('run-artifacts')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    document.getElementById('art-toggle')?.focus({ preventScroll: true });
  });
}

export function ArtifactsPanel({ r, onContinue }: { r: RunView; onContinue: () => void }) {
  const runs = useRuns().data;
  const toast = useToast();
  const { notify } = useConfirm();
  const items = artItems();
  const warns = artWarnings();
  const open = foldOpen(runState.fold, 'art', false);
  const multi = multiOf(r);
  const asking = artAsking(r);
  const paused = r.pause === 'paused';
  const cli = !r.live && r.status === 'running';
  const summary = summaryParts({ items, warns: warns.length, drafts: dirtyDrafts(r.id).length, asking, live: Boolean(r.live), paused, multi });
  const from = art.info?.from || r.artifacts?.from;
  const hints = open
    ? hintLines({
        from, fromKnown: Boolean(from && runs?.some((x) => x.id === from)), live: Boolean(r.live), paused, items,
        foreignDrafts: art.foreignResume ? dirtyDrafts(r.id).map((d) => d.title) : [], lostAnswer: Boolean(art.lostAnswer),
      })
    : [];
  const copyAnswer = () => {
    const text = art.lostAnswer;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error())).then(() => toast(t('Ответ скопирован')), () => void notify(text));
  };
  return (
    <section id="run-artifacts" className={cx(styles.runArtifacts, artAttention(r) && styles.attn)}>
      <div className={styles.artHead}>
        <button
          type="button"
          id="art-toggle"
          className="fold-head"
          aria-expanded={open}
          aria-controls="art-body"
          title={open ? t('Свернуть') : t('Развернуть')}
          onClick={() => {
            runState.fold.over.set('art', !open);
            bump();
          }}
        >
          <span className="caret">{ICON.caret}</span>{t('Артефакты')}
        </button>
        <span className={styles.artSummary}>
          {summary.map((p, i) => (
            <Fragment key={i}>
              {i > 0 && <span className={styles.sep} aria-hidden="true">·</span>}
              {typeof p === 'string' ? p : <Mark m={p} />}
            </Fragment>
          ))}
        </span>
        <span className={cx('row', styles.push)}>
          {cli && art.loadedAt && <span className="muted small">{t('данные на {time}', { time: art.loadedAt.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) })}</span>}
          {cli && <button type="button" className="btn small ghost" title={t('Запуск идёт из CLI: этот сервер не получает его события')} onClick={artReload}>{t('Обновить')}</button>}
        </span>
      </div>
      {open && (
        <div id="art-body" className={styles.artBody}>
          {hints.length > 0 && (
            <div className={styles.artHint}>
              {hints.map((h, i) => {
                switch (h.kind) {
                  case 'from':
                    return (
                      <div key={i}>
                        {t('Артефакты взяты из запуска')} {h.known ? <Link to={`/run/${h.id}`}>{h.id}</Link> : <span className="mono">{h.id}</span>}
                        {t(': с правками после его остановки.')}
                      </div>
                    );
                  case 'continue':
                    return <div key={i}>{h.text} <button type="button" className="btn small" onClick={onContinue}>{t('Продолжить с места остановки')}</button></div>;
                  case 'lost':
                    return (
                      <div key={i} className="warn">
                        {t('Запуск возобновлён не отсюда: ответ на паузу не записан.')}{' '}
                        <button type="button" className="btn small" onClick={copyAnswer}>{t('Скопировать ответ')}</button>
                      </div>
                    );
                  default:
                    return <div key={i} className={h.warn ? 'warn' : undefined}>{h.text}</div>;
                }
              })}
            </div>
          )}
          {art.error && (
            <div className={styles.artError} role="alert">
              <span>{art.error}</span> <button type="button" className="btn small" onClick={artReload}>{t('Повторить')}</button>
            </div>
          )}
          <ul className={styles.artList}>
            {items.map((a) => {
              const lock = a.lockedBy || [];
              const marks = rowMarks(a, { warns, dirty: draftDirty(draftOf(r.id, a.key)), asking });
              return (
                <li key={a.key} className={styles.artRow} data-key={a.key}>
                  <button
                    type="button"
                    className={styles.artOpen}
                    data-art-key={a.key}
                    title={lock.length ? t('Открыть: просмотр, версии') : t('Открыть: просмотр, версии, правка')}
                    onClick={(e) => void openWin(a.key, e.currentTarget)}
                  >
                    {a.title}
                  </button>
                  <span className={cx('mono small', styles.artFile)}>{a.file}</span>
                  <span className={cx('muted small', styles.artSize)}>{fileSize(a.size || 0)}</span>
                  <span className={cx('small', styles.artAuthor)}>{`${artAuthor(a.author, multi)}${a.at && a.author?.kind !== 'empty' ? ` · ${artClock(a.at)}` : ''}`}</span>
                  {marks.length > 0 && <span className={styles.artMarks}>{marks.map((m, i) => <Mark key={i} m={m} />)}</span>}
                </li>
              );
            })}
          </ul>
          {warns.length > 0 && (
            <div className={styles.artWarnings}>
              <div className={cx(styles.artWarnHead, 'warn')}>{t('⚠ Предупреждения: {n}', { n: warns.length })}</div>
              <ul>{warns.map((w, i) => <li key={i}><b>{`${w.where}:`}</b>{` ${w.text}`}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- значки шагов

/** Строка карточки этапа (phase) или условия (phase = null): что изменил шаг, отказы записи, предупреждения. */
export function ArtStepLine({ rep, phase }: { rep: PhaseReport | ConditionReport; phase: string | null }) {
  const r = runState.st?.run;
  if (!r?.artifacts) return null;
  const own = art.runId === r.id ? art.steps : new Map();
  const line = stepLine(stepOf(own, rep.block, rep.iteration, phase, rep as PhaseReport));
  if (!line) return null;
  const bits: ReactNode[] = [];
  if (line.changed.length) {
    bits.push(<span key="c">{t('изменил:')} {line.changed.map((k, i) => <Fragment key={k}>{i > 0 && ', '}<code>{k}</code></Fragment>)}</span>);
  }
  if (line.denied) {
    bits.push(
      <span key="d" className={styles.artDenials} title={t('Проверка перед вызовом отклонила: {why}. Файлы не изменены', { why: line.why })}>
        {t('отказов записи: {n}', { n: line.denied })}<span className={styles.artSr}>{` (${line.why})`}</span>
      </span>,
    );
  }
  return (
    <div className={styles.artStep} data-art-step={artStepKey(rep.block, rep.iteration, phase ?? '#cond')}>
      {bits.length > 0 && <div>{bits.map((b, i) => <Fragment key={i}>{i > 0 && ' · '}{b}</Fragment>)}</div>}
      {line.warnings.map((w, i) => <div key={i} className={styles.artWarn}>{`⚠ ${w}`}</div>)}
    </div>
  );
}

/** Значок предупреждений в заголовке итерации: виден и у свёрнутой. */
export function ArtIterMark({ block, it }: { block?: string; it: number }) {
  if (!runState.st?.run.artifacts) return null;
  const n = iterWarnCount(artWarnings(), block, it);
  if (!n) return null;
  return (
    <span className={cx(styles.artIter, 'warn')} data-art-iter={`${block ?? ''}|${it}`} title={t('Предупреждения артефактов — в карточках этапов итерации')}>
      {`⚠ ${n}`}<span className={styles.artSr}>{` ${iterWarnText(n)}`}</span>
    </span>
  );
}

/** Строка в карточке «Итог». */
export function ArtFinalLine() {
  const n = artWarnings().length;
  if (!n) return null;
  return (
    <div className={styles.artFinal}>
      <span className="warn">{t('⚠ Предупреждения артефактов: {n}', { n })}</span> <button type="button" className="btn small" onClick={artReveal}>{t('Открыть артефакты')}</button>
    </div>
  );
}

/** Строки под узлом артефакта на графе: последний автор, чек-лист, кто сейчас пишет. */
export function ArtGraphInfo({ artKey: key, r }: { artKey: string; r: RunView }) {
  const a = artItems().find((x) => x.key === key);
  if (!a) return null;
  const lock = a.lockedBy || [];
  const tb = a.tasks ? tasksBadge(a.tasks) : null;
  return (
    <>
      <div className={graphStyles.fgArtBy}>{artAuthor(a.author, multiOf(r))}</div>
      {tb && <span className={cx(styles.artMark, styles.tasks, tb.done && styles.done)} title={tb.title}>{tb.text}</span>}
      {lock.length > 0 && <span className={cx(styles.artMark, styles.lock)}>{`✎ ${lockText(artAsking(r), lock)}`}</span>}
    </>
  );
}

/** Артефакт сейчас пишет этап: рамка узла на графе. */
export const artLocked = (key: string): boolean => Boolean(artItems().find((x) => x.key === key)?.lockedBy?.length);
