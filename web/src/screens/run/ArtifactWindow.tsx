// Окно артефакта (ui/artifacts.js artOpenWin, artRenderWin и #dlg-artifact): просмотр как в окне файла, версии, правка
// черновиком с превью markdown, конфликт и блокировка, «Сохранить и возобновить», копирование. Состояние окна выводится
// из данных и черновика (winState): блокировка и изменение файла приходят событиями в любой момент. Закрытие и Esc
// оставляют несохранённый текст черновиком.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { fileRaw, setFileRaw } from '../../components/file/FileDialog';
import { useConfirm } from '../../components/ConfirmDialog';
import { PathLink, PathText } from '../../components/PathLink';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { markdownFits, renderMarkdown } from '../../lib/md';
import {
  artAuthor, artClock, artIsMd, tasksBadge, versionOptions, winEditable, winNote, winState, winStatus, type WinState,
} from '../../lib/run/artifacts';
import { fileSize } from '../../lib/run-form';
import {
  art, artBump, closeWin, draftOf, multiOf, useArtStore, winDiscard, winEdit, winFromVersion, winInput, winLoad, winMsg, winReload, winSave, winSizeCheck,
  winVersion,
} from './artStore';
import { runState } from './store';
import styles from './Artifacts.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
const PREVIEW_MS = 300;

/** markdown — только через renderMarkdown: он экранирует весь текст сам; сбой рендерера — null (тогда исходник). */
function mdHtml(text: string): string | null {
  try {
    return renderMarkdown(text);
  } catch {
    return null;
  }
}

export function ArtifactWindow({ onContinue }: { onContinue: (runId: string) => void }) {
  useArtStore();
  const { askConfirm, notify } = useConfirm();
  const toast = useToast();
  const dlg = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const editBtn = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const focusText = useRef(false);
  const focusedFor = useRef<object | null>(null);
  const bodyIdent = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [preview, setPreview] = useState<{ id: number; text: string } | null>(null);

  const w = art.win;
  const d = w ? draftOf(w.runId, w.key) : undefined;
  const st: WinState = w ? winState(w, d) : 'view';
  const editing = st === 'edit' || st === 'conflict' || st === 'locked';
  const cur = w?.cur ?? null;
  const run = w && runState.id === w.runId ? runState.st?.run ?? null : null;
  const multi = multiOf(run);
  const view = st === 'version' ? w?.ver ?? null : cur;
  const isMd = artIsMd(cur?.file || w?.ver?.file);

  // открыть и закрыть; после закрытия — фокус туда, откуда открыли
  useEffect(() => {
    const el = dlg.current!;
    if (w && !el.open) el.showModal();
    if (!w && el.open) el.close();
    if (!w && art.focusBack) {
      const back = art.focusBack;
      art.focusBack = null;
      const target = back.opener?.isConnected
        ? back.opener
        : document.querySelector<HTMLElement>(`[data-art-key="${CSS.escape(back.key)}"]`) || document.getElementById('art-toggle');
      target?.focus({ preventScroll: true });
    }
  });

  // черновик сменился (правка, «на основе версии», «Перечитать») — превью сразу, дальше — с паузой ввода
  const draftId = editing ? d?.id : undefined;
  useEffect(() => {
    clearTimeout(timer.current);
    if (d && draftId !== undefined) setPreview({ id: d.id, text: d.text });
  }, [draftId]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // фокус: при открытии — в редактор, на «Править» или «Закрыть»; не пропадает вместе со скрытой кнопкой
  useLayoutEffect(() => {
    const el = dlg.current!;
    if (!w || !el.open) return;
    const fallback = () => (editing ? ta.current : editBtn.current ?? closeBtn.current);
    if (focusText.current && ta.current) {
      focusText.current = false;
      ta.current.focus();
      return;
    }
    if (focusedFor.current !== w && !w.loading) {
      focusedFor.current = w;
      fallback()?.focus();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    if (!active || !el.contains(active) || active === el) fallback()?.focus({ preventScroll: true });
  });

  // живое обновление того же артефакта сохраняет прокрутку; другая версия открывается сверху
  const ident = st === 'version' ? `v${w?.ver?.version?.n}` : 'cur';
  useLayoutEffect(() => {
    if (bodyIdent.current !== ident && body.current) body.current.scrollTop = 0;
    bodyIdent.current = ident;
  }, [ident]);

  const ui = { notify, toast, askConfirm };
  const editable = w ? winEditable(w) : false;
  const paused = Boolean(run?.live && run.pause === 'paused');
  const note = w ? winNote(w, st, art.foreignResume && Boolean(d && d.text !== d.orig), multi) : null;
  const status = w ? winStatus(w, st, run) : { text: '', kind: '' };
  const versions = cur?.versions || [];
  const fmt = !editing && isMd && typeof view?.text === 'string' && Boolean(view.text) && markdownFits(view.text);
  const showPreview = editing && Boolean(d) && isMd && markdownFits(d!.text);
  const copy = st === 'conflict' || st === 'locked' || (st === 'edit' && Boolean(w?.saveFailed)) || (st === 'version' && typeof w?.ver?.text === 'string');
  const disabled = (off: boolean) => (off ? { 'aria-disabled': true, 'aria-describedby': 'art-win-status' } : {});

  const doCopy = async () => {
    if (!w) return;
    const text = st === 'version' ? w.ver?.text ?? '' : ta.current?.value ?? '';
    try {
      await navigator.clipboard.writeText(text);
      winMsg(t('Скопировано.'), 'ok');
    } catch {
      if (st === 'version') {
        const box = body.current?.querySelector('pre, .md');
        if (box) {
          const range = document.createRange();
          range.selectNodeContents(box);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
        }
      } else {
        ta.current?.focus();
        ta.current?.select();
      }
      winMsg(t('Скопировать автоматически не вышло: текст выделен, нажми ⌘C или Ctrl+C.'), 'warn');
    }
  };

  // тело просмотра
  let bodyNode = null;
  if (w && !editing) {
    if (!view) {
      bodyNode = w.loading
        ? <p className="muted small">{t('Загружаю…')}</p>
        : w.error ? <p className={styles.artLoadErr}>{w.error} <button type="button" className="btn small" onClick={() => void winLoad()}>{t('Повторить')}</button></p> : null;
    } else if (typeof view.text !== 'string') bodyNode = <p className="muted">{view.textMessage || t('Текст недоступен')}</p>;
    else if (!view.text) bodyNode = <p className="muted">{st === 'version' ? t('Пока пусто: в этой версии файл был пустым.') : t('Пока пусто: файл ещё не заполнялся.')}</p>;
    else {
      const html = isMd && !fileRaw() && markdownFits(view.text) ? mdHtml(view.text) : null;
      bodyNode = html !== null ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : <pre><PathText text={view.text} /></pre>;
    }
  }
  const pv = showPreview && preview?.id === d?.id ? preview : null;
  const pvHtml = pv ? mdHtml(pv.text) : null;

  return (
    <dialog
      ref={dlg}
      className={styles.dlgArtifact}
      aria-labelledby="art-win-title"
      onCancel={(e) => {
        // Esc — как «Закрыть»: несохранённый текст остаётся черновиком
        e.preventDefault();
        closeWin();
      }}
    >
      <header className="dlg-head">
        <h2 id="art-win-title" className={styles.artWinTitle}>{w?.title}</h2>
        <span className={styles.fileActions}>
          {versions.length >= 2 && (
            <label className={styles.artVer}>
              <span className={styles.artSr}>{t('Версия')}</span>
              <select value={w?.ver?.version ? String(w.ver.version.n) : ''} onChange={(e) => void winVersion(Number(e.target.value) || 0)}>
                {versionOptions(cur, multi).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          {fmt && (
            <button
              type="button"
              className="btn ghost small"
              title={t('Исходный текст файла — удобно копировать')}
              onClick={() => {
                setFileRaw(!fileRaw());
                artBump();
              }}
            >
              {fileRaw() ? t('форматировать') : t('как текст')}
            </button>
          )}
          <button type="button" ref={closeBtn} className="btn ghost" onClick={() => closeWin()}>{t('Закрыть')}</button>
        </span>
      </header>
      <p className={cx('muted small', styles.artWinMeta)}>
        {cur && [
          <span key="f" className="mono">{cur.file}</span>,
          cur.tasks ? <span key="t" className={cx(styles.artMark, styles.tasks, tasksBadge(cur.tasks).done && styles.done)} title={tasksBadge(cur.tasks).title}>{tasksBadge(cur.tasks).text}</span> : null,
          fileSize(cur.size ?? 0),
          t('последний автор: {author}', { author: `${artAuthor(cur.author, multi)}${cur.at ? `, ${artClock(cur.at)}` : ''}` }),
          cur.path ? <PathLink key="p" className={cx('mono', styles.artPath)} path={cur.path} /> : null,
        ].filter(Boolean).reduce<ReactNode[]>((out, x, i) => {
          const last = out[out.length - 1];
          const sep = i ? ' · ' : '';
          if (typeof x === 'string') {
            if (typeof last === 'string') out[out.length - 1] = last + sep + x;
            else out.push(sep + x);
          } else {
            if (sep) {
              if (typeof last === 'string') out[out.length - 1] = last + sep;
              else out.push(sep);
            }
            out.push(x);
          }
          return out;
        }, [])}
      </p>
      <div className={cx(styles.artNote, note?.kind && styles[note.kind], note?.kind)} role="status" aria-live="polite" hidden={!note}>{note?.text}</div>
      <div ref={body} className={styles.artWinBody} hidden={editing}>{bodyNode}</div>
      <div className={cx(styles.artWinEdit, showPreview && styles.split)} hidden={!editing}>
        {editing && d && (
          <>
            <label htmlFor="art-win-text" className={styles.artSr}>{t('Текст артефакта')}</label>
            <textarea
              key={d.id}
              ref={ta}
              id="art-win-text"
              className={styles.artWinText}
              spellCheck={false}
              // пока идёт сохранение, текст не правится: после ответа черновик удаляется, набранное пропало бы
              readOnly={w?.saving}
              defaultValue={d.text}
              onInput={(e) => {
                const text = e.currentTarget.value;
                winInput(text);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => {
                  if (art.win !== w) return;
                  setPreview({ id: d.id, text });
                  winSizeCheck();
                }, PREVIEW_MS);
              }}
              onKeyDown={(e) => {
                // ⌘/Ctrl+S — «Сохранить»
                if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void winSave({}, ui);
                }
              }}
            />
            {showPreview && (
              <div className={styles.artWinPreview} aria-label={t('Превью')}>
                {pv && (pvHtml !== null ? <div className="md" dangerouslySetInnerHTML={{ __html: pvHtml }} /> : <pre>{pv.text}</pre>)}
              </div>
            )}
          </>
        )}
      </div>
      <p id="art-win-status" className={cx('msg', styles.artWinStatus, status.kind)} role="status" aria-live="polite">{status.text}</p>
      <div className={cx('row', styles.artWinActions)}>
        {st === 'view' && cur && (
          <button
            type="button"
            ref={editBtn}
            className="btn primary"
            {...disabled(!editable)}
            onClick={() => {
              if (!editable) return;
              focusText.current = true;
              winEdit();
            }}
          >
            {t('Править')}
          </button>
        )}
        {(st === 'edit' || st === 'locked') && <button type="button" className="btn primary" {...disabled(st === 'locked')} onClick={() => void winSave({}, ui)}>{t('Сохранить')}</button>}
        {st === 'edit' && paused && <button type="button" className="btn" onClick={() => void winSave({ resume: true }, ui)}>{t('Сохранить и возобновить')}</button>}
        {st === 'conflict' && <button type="button" className="btn" onClick={() => void winReload(askConfirm).then(() => { focusText.current = true; artBump(); })}>{t('Перечитать')}</button>}
        {st === 'conflict' && <button type="button" className="btn danger" onClick={() => void winSave({ force: true }, ui)}>{t('Сохранить поверх')}</button>}
        {st === 'version' && typeof w?.ver?.text === 'string' && (
          <button
            type="button"
            className="btn"
            {...disabled(!editable)}
            onClick={() =>
              void winFromVersion(askConfirm).then(() => {
                focusText.current = true;
                artBump();
              })}
          >
            {t('Править на основе этой версии')}
          </button>
        )}
        {copy && <button type="button" className="btn" onClick={() => void doCopy()}>{st === 'conflict' ? t('Скопировать мой текст') : st === 'version' ? t('Скопировать') : t('Скопировать текст')}</button>}
        {st === 'view' && !run?.live && cur?.reason === 'continuable' && (
          <button
            type="button"
            className="btn"
            title={t('Новый запуск текущей версией flow с этими артефактами')}
            onClick={() => {
              const id = art.win?.runId;
              closeWin();
              if (id) onContinue(id);
            }}
          >
            {t('Продолжить с места остановки')}
          </button>
        )}
        {editing && <button type="button" className="btn ghost danger" onClick={() => void winDiscard(askConfirm)}>{t('Отбросить')}</button>}
      </div>
    </dialog>
  );
}
