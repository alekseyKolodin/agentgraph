// Всплывашка внизу справа (ui/app.js toast): вопрос из другого flow, пока открыт не тот экран, и ошибки без своего места.
// Клик — действие и закрыть; сама прячется через 10 секунд.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './Toast.module.css';

const TOAST_MS = 10_000;

type ToastFn = (text: string, onClick?: () => void) => void;
type Shown = { text: string; onClick: (() => void) | undefined; seq: number };

const Ctx = createContext<ToastFn | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const seq = useRef(0);
  const toast = useCallback<ToastFn>((text, onClick) => setShown({ text, onClick, seq: ++seq.current }), []);

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [shown]);

  return (
    <Ctx.Provider value={toast}>
      {children}
      {shown && (
        <div
          className={styles.toast}
          role="status"
          onClick={() => {
            setShown(null);
            shown.onClick?.();
          }}
        >
          {shown.text}
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useToast(): ToastFn {
  const toast = useContext(Ctx);
  if (!toast) throw new Error('useToast вне ToastProvider');
  return toast;
}
