// Маршруты UI. Адреса — пути /flow/<имя>, /run/<id>, /tags/<slug>, /context; сервер отдаёт на них index.html. Старые
// хеши /#run/<id> и т. п. переводятся на пути ниже (lib/legacy-url.ts), старые /next/… — сервер (308).
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from './components/ConfirmDialog';
import { ToastProvider } from './components/Toast';
import { Shell } from './components/shell/Shell';
import { HomeScreen } from './screens/home/HomeScreen';
import { legacyLocation } from './lib/legacy-url';

// Как в старом UI: без повторов и без перезапроса при возврате на вкладку — экраны сами решают, когда обновляться.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
// для сверки на подменённых данных в dev: __agentgraphQuery.setQueryData(['home'], …)
if (import.meta.env.DEV) Object.assign(window, { __agentgraphQuery: queryClient });

// экран flow тянет граф (@xyflow/react) и CodeMirror: грузится отдельным файлом, когда его открывают
const FlowScreen = lazy(() => import('./screens/flow/FlowScreen').then((m) => ({ default: m.FlowScreen })));
// страница запуска тоже тянет граф: отдельный файл
const RunScreen = lazy(() => import('./screens/run/RunScreen').then((m) => ({ default: m.RunScreen })));
// «Теги» и «Контекст» открывают реже главной: тоже своими файлами
const TagsScreen = lazy(() => import('./screens/tags/TagsScreen').then((m) => ({ default: m.TagsScreen })));
const ContextScreen = lazy(() => import('./screens/context/ContextScreen').then((m) => ({ default: m.ContextScreen })));

// старые ссылки /#run/<id>, /#flow/<имя>, /#tags/<slug>, /#context — до создания роутера: он читает адрес сразу
const legacy = legacyLocation(location);
if (legacy) history.replaceState(history.state, '', legacy);

// data-режим роутера: экрану flow нужен useBlocker — уход с несохранённого конструктора и черновика спрашивает, как в старом UI
const router = createBrowserRouter(
  [
    {
      element: <Shell />,
      children: [
        { index: true, element: <HomeScreen /> },
        { path: 'tags/:slug?', element: <Suspense><TagsScreen /></Suspense> },
        { path: 'context', element: <Suspense><ContextScreen /></Suspense> },
        { path: 'flow/:name', element: <Suspense><FlowScreen /></Suspense> },
        // черновик разового запуска: живёт только в памяти вкладки, после перезагрузки — на главную
        { path: 'draft', element: <Suspense><FlowScreen draft /></Suspense> },
        { path: 'run/:id', element: <Suspense><RunScreen /></Suspense> },
        // неизвестный адрес — на главную, как route() в ui/app.js
        { path: '*', element: <Navigate to="/" replace /> },
      ],
    },
  ],
);

// старая ссылка /#run/<id>, вставленная во вкладку, где уже открыта главная: страница не перезагружается, хеш меняется
// на месте — переходим роутером (уход с несохранённого спросит, как любой переход)
window.addEventListener('hashchange', () => {
  const to = legacyLocation(location);
  if (to) void router.navigate(to, { replace: true });
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </ConfirmProvider>
    </QueryClientProvider>
  );
}
