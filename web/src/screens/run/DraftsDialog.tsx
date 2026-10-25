// «Возобновить» или «Продолжить» при несохранённой правке артефакта (ui/index.html #dlg-resume-draft, artAskDrafts):
// сохранить и идти дальше, идти без правки или отменить. Окно одно на страницу: «Возобновить» есть и на главной.
import { useEffect, useRef } from 'react';
import { answerDrafts, art, useArtStore } from './artStore';

export function DraftsDialog() {
  useArtStore();
  const dlg = useRef<HTMLDialogElement>(null);
  const save = useRef<HTMLButtonElement>(null);
  const ask = art.ask;
  useEffect(() => {
    const d = dlg.current!;
    if (ask && !d.open) {
      d.showModal();
      save.current?.focus();
    }
    if (!ask && d.open) d.close();
  }, [ask]);
  return (
    <dialog
      ref={dlg}
      className="dlg-confirm"
      aria-labelledby="resume-draft-text"
      onCancel={(e) => {
        e.preventDefault();
        answerDrafts('cancel');
      }}
    >
      <p id="resume-draft-text">{ask?.text}</p>
      <div className="row">
        <button type="button" ref={save} className="btn primary" onClick={() => answerDrafts('save')}>{ask?.save}</button>
        <button type="button" className="btn" onClick={() => answerDrafts('skip')}>{ask?.skip}</button>
        <button type="button" className="btn ghost" onClick={() => answerDrafts('cancel')}>Отмена</button>
      </div>
    </dialog>
  );
}
