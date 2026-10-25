// Диалоги вместо confirm/alert (ui/app.js askConfirm, notify): системные диалоги в некоторых встроенных браузерах
// молча отклоняются. Один <dialog> на приложение; экраны зовут useConfirm().
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type ConfirmOptions = {
  /** Текст кнопки подтверждения. */
  ok?: string;
  /** Опасное действие: кнопка красная. */
  danger?: boolean;
};

type Ask = { text: string; ok: string; danger: boolean; cancel: boolean; resolve: (v: boolean) => void };

type ConfirmApi = {
  /** Подтвердить действие: true — подтвердил, false — «Отмена» или Esc. */
  askConfirm: (text: string, opts?: ConfirmOptions) => Promise<boolean>;
  /** Сообщение с одной кнопкой «Ок». */
  notify: (text: string) => Promise<void>;
};

const Ctx = createContext<ConfirmApi | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  const okBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const d = dlg.current;
    if (!d || !ask) return;
    if (!d.open) d.showModal();
    okBtn.current?.focus();
  }, [ask]);

  // открытый вопрос — и в ref: done читает его без зависимости от рендера
  const current = useRef<Ask | null>(null);

  const open = useCallback((a: Ask) => {
    // новый вопрос поверх открытого: прежний считается отменённым
    current.current?.resolve(false);
    current.current = a;
    setAsk(a);
  }, []);

  const done = useCallback((v: boolean) => {
    const a = current.current;
    current.current = null;
    dlg.current?.close();
    setAsk(null);
    a?.resolve(v);
  }, []);

  const value = useMemo<ConfirmApi>(() => ({
    askConfirm: (text, { ok = 'Подтвердить', danger = false } = {}) =>
      new Promise((resolve) => open({ text, ok, danger, cancel: true, resolve })),
    notify: (text) =>
      new Promise((resolve) => open({ text, ok: 'Ок', danger: false, cancel: false, resolve: () => resolve() })),
  }), [open]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <dialog
        ref={dlg}
        className="dlg-confirm"
        onCancel={(e) => {
          e.preventDefault();
          done(false);
        }}
      >
        <p>{ask?.text}</p>
        <div className="row">
          <button ref={okBtn} className={'btn ' + (ask?.danger ? 'danger-fill' : 'primary')} onClick={() => done(true)}>
            {ask?.ok ?? 'Подтвердить'}
          </button>
          <button className="btn ghost" hidden={!ask?.cancel} onClick={() => done(false)}>Отмена</button>
        </div>
      </dialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useConfirm вне ConfirmProvider');
  return api;
}
