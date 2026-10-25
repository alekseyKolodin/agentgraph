// Оболочка: сайдбар и область экрана. Без /api/config интерфейс не стартует, как и старый (ui/app.js init).
// Здесь же — общий поток событий, заголовок вкладки (число вопросов, имя открытого запуска), окно файла и диалог
// несохранённой правки артефакта перед «Возобновить»: они нужны на любом экране.
import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { errorText, useConfig, useHome } from '../../api';
import { docTitle, inboxCount } from '../../lib/home';
import { FileDialog } from '../file/FileDialog';
import { DraftsDialog } from '../../screens/run/DraftsDialog';
import { useDocRunTitle } from './docTitle';
import { Sidebar } from './Sidebar';
import { useHomeEvents } from './useHomeEvents';
import styles from './Shell.module.css';

export function Shell() {
  const config = useConfig();
  if (config.error) return <pre className="error" style={{ padding: 20 }}>{errorText(config.error)}</pre>;
  if (!config.data) return null;
  return <Ready />;
}

function Ready() {
  useHomeEvents();
  const questions = inboxCount(useHome().data?.runs ?? []);
  const run = useDocRunTitle();
  useEffect(() => {
    document.title = docTitle(questions, run);
  }, [questions, run]);
  return (
    <div className={styles.app}>
      <Sidebar />
      <main className={styles.main}>
        <Outlet />
      </main>
      <FileDialog />
      <DraftsDialog />
    </div>
  );
}
