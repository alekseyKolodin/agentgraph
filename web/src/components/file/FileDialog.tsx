// Окно файла (ui/app.js viewFile, viewTagSummary, #dlg-file): промпт, транскрипт и вывод этапа, лог условия, саммари тега.
// Markdown — кроме транскрипта, лога, JSON-вывода и огромного файла; транскрипт — как в Claude Code (components/transcript).
// «как текст» показывает исходник, выбор общий для markdown-файлов, транскриптов и живого лога и переживает перезагрузку
// (agentgraph.fileRaw). Окно одно на страницу, открывается откуда угодно.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { errorText, fetchRunFile, fetchTag } from '../../api';
import { renderMarkdown } from '../../lib/md';
import { fileIsMarkdown, fileIsTranscript } from '../../lib/run/view';
import { LS } from '../../lib/storage';
import { t } from '../../lib/i18n';
import { PathText } from '../PathLink';
import { Transcript } from '../transcript/Transcript';
import styles from './FileDialog.module.css';

/**
 * n — номер открытия: окно, закрытое Esc мимо состояния, открывается снова и при том же open. run — база путей в тексте.
 * tx — транскрипт этапа: строки сессии, а не markdown.
 */
type FileView = { open: boolean; n: number; title: string; session: string; text: string; md: boolean; tx: boolean; run: string };

let view: FileView = { open: false, n: 0, title: '', session: '', text: '', md: false, tx: false, run: '' };
let raw = LS.get('agentgraph.fileRaw', false);
// поздний ответ прошлого открытия не перетирает текущее
let seq = 0;
const subs = new Set<() => void>();
const set = (patch: Partial<FileView>) => {
  view = { ...view, ...patch };
  subs.forEach((f) => f());
};
/** «как текст / форматировать» — общий выбор для окна файла и окна артефакта. */
export const fileRaw = (): boolean => raw;
export function setFileRaw(v: boolean): void {
  raw = v;
  LS.set('agentgraph.fileRaw', raw);
  set({});
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
const useView = () => useSyncExternalStore(subscribe, () => view);
/** «как текст» для компонента вне окна (вкладка «Лог»): перерисовка при смене выбора. */
export const useFileRaw = (): boolean => useSyncExternalStore(subscribe, () => raw);

/** Файл папки запуска. session — у транскрипта готового этапа: строка «claude --resume <session>». */
export async function openRunFile(runId: string, file: string, title: string, session = ''): Promise<void> {
  const my = ++seq;
  set({ open: true, n: view.n + 1, title: title || file, session, text: t('Загружаю…'), md: false, tx: false, run: runId });
  try {
    // no-store: у идущего этапа транскрипт растёт, при каждом открытии читаем заново
    const res = await fetchRunFile(runId, file, true);
    if (my === seq) set({ text: res.text, md: res.ok && fileIsMarkdown(file, res.text), tx: res.ok && fileIsTranscript(file) });
  } catch (err) {
    if (my === seq) set({ text: errorText(err), md: false, tx: false });
  }
}

/** Саммари тега из карточки «Итог». */
export async function openTagSummary(slug: string): Promise<void> {
  const my = ++seq;
  set({ open: true, n: view.n + 1, title: t('Саммари тега · {slug}', { slug }), session: '', text: t('Загружаю…'), md: false, tx: false, run: '' });
  try {
    const r = await fetchTag(slug);
    if (my === seq) set({ text: r.summary || t('Саммари пока нет'), md: true });
  } catch (err) {
    if (my === seq) set({ text: errorText(err), md: false });
  }
}

/** Сбой рендерера не роняет окно: тогда исходник моноширинно. */
function Body({ text, md, tx, run }: { text: string; md: boolean; tx: boolean; run: string }) {
  if (tx) return <Transcript text={text} run={run || undefined} />;
  if (md) {
    try {
      // dangerouslySetInnerHTML — только с результатом renderMarkdown: он экранирует весь текст сам
      return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
    } catch {
      /* исходник ниже */
    }
  }
  return <pre><PathText text={text} /></pre>;
}

export function FileDialog() {
  const v = useView();
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dlg.current!;
    if (v.open && !d.open) d.showModal();
    if (!v.open && d.open) d.close();
  }, [v.open, v.n]);
  const formatted = (v.md || v.tx) && !raw;
  return (
    // событие close приходит задачей позже: окно, открытое заново за это время, оно закрывать не должно
    <dialog ref={dlg} className={styles.dlgFile} data-run={v.run || undefined} onClose={(e) => !e.currentTarget.open && set({ open: false })}>
      <header className="dlg-head">
        <span>{v.title}</span>
        <span className={styles.fileActions}>
          {(v.md || v.tx) && (
            <button
              className="btn ghost small"
              title={t('Исходный текст файла — удобно копировать')}
              onClick={() => setFileRaw(!raw)}
            >
              {raw ? t('форматировать') : t('как текст')}
            </button>
          )}
          <button className="btn ghost" onClick={() => set({ open: false })}>{t('Закрыть')}</button>
        </span>
      </header>
      {v.session && <p className={`${styles.fileSession} mono small`} title={t('Продолжить эту сессию в терминале из директории проекта запуска')}>{`claude --resume ${v.session}`}</p>}
      <div className={styles.fileBody}>
        <Body text={v.text} md={formatted && v.md} tx={formatted && v.tx} run={v.run} />
      </div>
    </dialog>
  );
}
