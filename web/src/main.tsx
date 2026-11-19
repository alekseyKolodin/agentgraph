// Глобальные стили — до компонентов: в бандле CSS идёт в порядке импортов, и правила модулей (.qsend поверх .row)
// должны стоять после base.css, как в ui/style.css.
import './styles/tokens.css';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getLang } from './lib/i18n';
import { markStale, shouldAutoReload } from './lib/stale-build';

document.documentElement.lang = getLang();

/** sessionStorage: время (мс) прошлой авто-перезагрузки из-за устаревшей сборки. */
const STALE_RELOAD_KEY = 'agentgraph.staleReload';

// Файл сборки не загрузился (пересборка dist/web под открытой страницей стёрла файлы со старыми хешами): перезагрузить
// страницу, но не чаще раза в 10 секунд — файла может не быть и в свежей сборке. Хранилище недоступно — сами не
// перезагружаем, экран ошибки маршрута предложит кнопку. preventDefault() не зовём: с ним импорт вернёт undefined и
// ленивый экран упадёт посторонним TypeError, а ошибка должна дойти до экрана ошибки (components/shell/RouteError).
// Несохранённое на странице спросит beforeunload — так и надо.
window.addEventListener('vite:preloadError', () => {
  markStale();
  let last: number;
  try {
    last = Number(sessionStorage.getItem(STALE_RELOAD_KEY)) || 0;
  } catch {
    return;
  }
  const now = Date.now();
  if (!shouldAutoReload(last, now)) return;
  try {
    sessionStorage.setItem(STALE_RELOAD_KEY, String(now));
  } catch {
    return;
  }
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
