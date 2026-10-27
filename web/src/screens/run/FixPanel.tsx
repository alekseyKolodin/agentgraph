// «Починить и продолжить» (src/run-fix.ts): поле указания следующему шагу (на карточке идущего этапа и на паузе), ждущие
// указания, указания на карточках шагов и действия на паузе — повторить итерацию, править flow запуска, взять flow из flows/.
// Правка и повтор идут в тот же запуск: «остановить → продолжить» для этого не нужно.
import { lazy, Suspense, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { RunNote } from '@server/api-types';
import { errorText } from '../../api';
import { addRunNote, reloadRunFlow, restartIteration } from '../../api/run';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import type { RunView } from '../../lib/run/events';
import { fixActions, waitingNotes } from '../../lib/run/view';
import { runEvent } from './store';
import styles from './FixPanel.module.css';

// CodeMirror грузится, только когда диалог правки открыли
const RunFlowDialog = lazy(() => import('./RunFlowDialog'));

// Недописанное указание — одно на запуск и живёт в памяти вкладки: поле на карточке этапа и на паузе показывают один
// текст, а «Повторить итерацию» берёт его указанием. Карточка этапа пересоздаётся на каждом шаге — текст не теряется.
const drafts = new Map<string, string>();
const draftSubs = new Set<() => void>();

function setDraft(runId: string, text: string): void {
  drafts.set(runId, text);
  draftSubs.forEach((f) => f());
}

const useDraft = (runId: string): string =>
  useSyncExternalStore((f) => {
    draftSubs.add(f);
    return () => draftSubs.delete(f);
  }, () => drafts.get(runId) ?? '');

/** Поле указания: next — следующему шагу, с галочкой — каждому до конца запуска. Ниже — указания, которые ещё дойдут. */
export function NoteBox({ r, placeholder }: { r: RunView; placeholder: string }) {
  const text = useDraft(r.id);
  const setText = (v: string) => setDraft(r.id, v);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const waiting = waitingNotes(r);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const { note } = await addRunNote(r.id, text.trim(), all ? 'run' : 'next');
      // событие note придёт потоком; показываем сразу
      runEvent({ type: 'note', note });
      setText('');
      setAll(false);
    } catch (err) {
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };
  return (
    <div className={styles.noteBox}>
      <textarea rows={2} aria-label={t('Указание')} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      <div className={styles.noteRow}>
        <label className={styles.scope} title={t('Без галочки — только следующему шагу')}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          {t('до конца запуска')}
        </label>
        <button type="button" className="btn small" disabled={!text.trim() || busy} title="⌘↵" onClick={() => void send()}>{t('Дать указание')}</button>
        {msg && <span className="msg err">{msg}</span>}
      </div>
      {waiting.length > 0 && (
        <ul className={styles.waiting} aria-label={t('Ждущие указания')}>
          {waiting.map((n) => (
            <li key={n.id}>
              <span className={styles.wScope}>{n.scope === 'run' ? t('до конца запуска') : t('ждёт следующего шага')}</span>
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Указания, которые получил шаг (хвостом промпта). */
export function StepNotes({ notes }: { notes: RunNote[] }) {
  if (!notes.length) return null;
  return (
    <div className={styles.stepNotes}>
      {notes.map((n) => (
        <div key={n.id} className={styles.stepNote}>
          <span className={styles.noteLabel}>{n.scope === 'run' ? t('Указание до конца запуска') : t('Указание')}</span>
          {n.text}
        </div>
      ))}
    </div>
  );
}

/**
 * На паузе: указание, повтор итерации, правка flow запуска (снимок в YamlEditor) и flow из flows/ (поправили в Claude Code).
 * onResume — «Возобновить» страницы (с черновиками артефактов): повтор итерации сразу пускает запуск дальше.
 */
export function FixPanel({ r, onResume }: { r: RunView; onResume: () => Promise<unknown> | void }) {
  const { askConfirm, notify } = useConfirm();
  const toast = useToast();
  const draft = useDraft(r.id);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const acts = fixActions(r);
  if (!acts) return null;

  const restart = async () => {
    const rs = acts.restart;
    if (!rs) return;
    const note = draft.trim();
    const text = t('Повторить итерацию? Оставшиеся шаги итерации {it} не пойдут: дальше — итерация {next}, лимит блока {from} → {to}.', {
      it: rs.block.iterations, next: rs.next, from: rs.block.maxIterations, to: rs.max,
    });
    if (!(await askConfirm(note ? `${text}\n\n${t('Указание: {text}', { text: note })}` : text, { ok: t('Повторить итерацию') }))) return;
    setBusy(true);
    try {
      const res = await restartIteration(r.id, note || undefined);
      setDraft(r.id, '');
      await onResume();
      toast(t('Итерация {it} · лимит {max}', { it: res.iteration, max: rs.max }));
    } catch (err) {
      await notify(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    setBusy(true);
    try {
      const { edit } = await reloadRunFlow(r.id);
      toast(edit.changed.length ? t('Flow запуска взят из flows/: {list}', { list: edit.changed.join('; ') }) : t('В flows/ та же версия flow: менять нечего'));
    } catch (err) {
      await notify(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.fix}>
      <span className={styles.fixLabel}>{t('Починить и продолжить этот запуск')}</span>
      <NoteBox r={r} placeholder={t('Указание следующему шагу: что поправить или учесть. Потом — «Возобновить»')} />
      <div className={styles.fixActs}>
        {acts.restart && (
          <button
            type="button"
            className="btn small"
            disabled={busy}
            title={t('Оставшиеся шаги итерации не пойдут: начнётся итерация {next}, указание из поля — в её {{feedback}}, лимит блока +1', { next: acts.restart.next })}
            onClick={() => void restart()}
          >
            {t('Повторить итерацию')}
          </button>
        )}
        <button type="button" className="btn small" disabled={busy} title={t('Поправить снимок flow этого запуска: следующие шаги пойдут по нему')} onClick={() => setEditing(true)}>
          {t('Править flow запуска')}
        </button>
        {acts.reload && (
          <button type="button" className="btn small" disabled={busy} title={t('Поправил flow в Claude Code: следующие шаги пойдут по текущей версии из flows/')} onClick={() => void reload()}>
            {t('Взять flow из flows/')}
          </button>
        )}
      </div>
      {editing && (
        <Suspense fallback={null}>
          <RunFlowDialog r={r} onClose={() => setEditing(false)} />
        </Suspense>
      )}
    </div>
  );
}
