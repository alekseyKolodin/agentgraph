// Экран ошибки маршрута: рисуется на месте экрана (errorElement маршрута без пути в App.tsx), сайдбар остаётся — можно
// вернуться на уже загруженный экран и сохранить работу. Тот же компонент — на корневом маршруте, если упала сама
// оболочка: тогда он на всё окно. Сборка устарела (lib/stale-build: файл экрана стёрт пересборкой) — «Приложение
// обновилось», иначе — «Экран не открылся» с текстом ошибки.
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { t } from '../../lib/i18n';
import { isStale } from '../../lib/stale-build';
import styles from './RouteError.module.css';

function errorMessage(e: unknown): string {
  if (isRouteErrorResponse(e)) return `${e.status} ${e.statusText}`.trim();
  if (e instanceof Error) return e.message;
  return String(e);
}

export function RouteError({ whole = false }: { whole?: boolean }) {
  const error = useRouteError();
  const stale = isStale();
  const reload = () => window.location.reload();
  return (
    <div className={whole ? styles.whole : styles.wrap}>
      <div className={styles.card} role="alert">
        {stale ? (
          <>
            <h1>{t('Приложение обновилось')}</h1>
            <p>{t('Этот экран собран заново. Перезагрузите страницу — несохранённое на других экранах сначала сохраните.')}</p>
          </>
        ) : (
          <>
            <h1>{t('Экран не открылся')}</h1>
            <pre className={styles.error}>{errorMessage(error)}</pre>
          </>
        )}
        <button type="button" className="btn primary" onClick={reload} title={t('Загрузить страницу заново')}>
          {t('Перезагрузить')}
        </button>
      </div>
    </div>
  );
}
