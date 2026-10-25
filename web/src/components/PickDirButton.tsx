// Кнопка «Выбрать…» у поля пути (ui/app.js initPickDir): сервер открывает системный диалог, выбранный путь — в onPick
// (поле решает само: подставить, дописать строкой в textarea, сбросить зависимое). Есть, только если сервер умеет
// (фича pick-dir). Ошибка — всплывашкой.
import { useState } from 'react';
import { api, errorText, useConfig, useFeature } from '../api';
import { LS } from '../lib/storage';
import { useToast } from './Toast';

type Props = {
  /** С какой папки открыть диалог: текущее значение поля; пусто — последняя директория проекта или defaultCwd. */
  start: () => string;
  /** Пользователь выбрал папку; отмена диалога сюда не приходит. */
  onPick: (path: string) => void;
  /** Заголовок системного диалога. */
  prompt: string;
  /** После диалога, чем бы он ни кончился (выбор, отмена, ошибка): например, вернуть фокус в поле, как initPickDir. */
  onSettled?: () => void;
  className?: string;
  title?: string;
  children?: string;
};

export function PickDirButton({ start, onPick, prompt, onSettled, className = 'btn pick-dir', title = 'Выбрать папку в Finder', children = 'Выбрать…' }: Props) {
  const can = useFeature('pick-dir');
  const defaultCwd = useConfig().data?.defaultCwd ?? '';
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!can) return null;
  const pick = async () => {
    setBusy(true);
    try {
      const from = start().trim() || LS.raw('agentgraph.cwd') || defaultCwd;
      const r = await api<{ path: string | null }>('POST', '/api/pick-dir', { start: from, prompt });
      if (r.path) onPick(r.path);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
      onSettled?.();
    }
  };
  return (
    <button type="button" className={className} title={title} disabled={busy} onClick={() => void pick()}>
      {children}
    </button>
  );
}
