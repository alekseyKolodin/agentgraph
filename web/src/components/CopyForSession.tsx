// Кнопка «Для сессии»: копирует в буфер текст о flow или запуске (lib/session-links: имя, id, путь, как с ним работать),
// чтобы вставить его в сессию терминала — она возьмёт flow через flow_run или запуск через flow_status.
import { t } from '../lib/i18n';
import { useToast } from './Toast';
import styles from './CopyForSession.module.css';

export function CopyForSession({ text, what }: { text: string | undefined; what: 'flow' | 'run' }) {
  const toast = useToast();
  if (!text) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('Скопировано — вставь в сессию терминала'));
    } catch {
      toast(t('Не скопировалось: браузер не дал доступа к буферу обмена'));
    }
  };
  return (
    <button
      type="button"
      className="btn ghost"
      title={what === 'flow' ? t('Скопировать для сессии терминала: имя flow, путь к файлу и как его запустить') : t('Скопировать для сессии терминала: id запуска, папку с его файлами и как узнать состояние')}
      onClick={() => void copy()}
    >
      <span aria-hidden="true" className={styles.prompt}>›_</span>
      {t('Для сессии')}
    </button>
  );
}
