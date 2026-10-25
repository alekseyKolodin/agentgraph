// UI agentgraph: React + Vite. Сборка — в dist/web, сервер раздаёт её на / (src/web-static.ts).
// Dev: `npm run dev:web` — Vite с HMR, /api (и SSE) проксируется на запущенный `npm run ui`.
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Адрес UI-сервера для dev-прокси. По умолчанию — `npm run ui` на стандартном порту. */
const API = process.env.AGENTGRAPH_API ?? 'http://127.0.0.1:4747';

/** Код сервера: из web/ в него можно только `import type`. */
const SERVER_SRC = path.resolve(import.meta.dirname, '..', 'src');

/**
 * Типы сервера берутся через `import type` из @server/* и стираются до сборки. Если Vite всё же резолвит @server/*
 * или относительный путь в src/, это рантайм-импорт из сервера: он потянул бы Node-модули в браузер (и не заработал
 * бы в Electron).
 */
const noServerRuntime = (): Plugin => ({
  name: 'agentgraph:no-server-runtime',
  enforce: 'pre',
  resolveId(id, importer) {
    const fromServer = id.startsWith('@server/') || (id.startsWith('.') && importer !== undefined && path.resolve(path.dirname(importer), id).startsWith(SERVER_SRC + path.sep));
    if (fromServer) this.error(`Рантайм-импорт ${id} из ${importer ?? '?'}: из src/ в web/ можно только import type`);
  },
});

export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  plugins: [noServerRuntime(), react()],
  css: { modules: { localsConvention: 'camelCaseOnly' } },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // Библиотеки — своими файлами: они меняются реже кода экранов и кэшируются отдельно (assets/ — immutable).
        // Граф и редактор YAML нужны только экранам flow и запуска (они грузятся лениво), а не главной. Группа забирает
        // и зависимости своих модулей, поэтому react — первой (priority выше): иначе xyflow унёс бы его к себе.
        codeSplitting: {
          groups: [
            { name: 'codemirror', test: /node_modules[\\/](@codemirror|@lezer|@marijn|style-mod|w3c-keyname|crelt)[\\/]/, priority: 2 },
            { name: 'xyflow', test: /node_modules[\\/](@xyflow|d3-[a-z-]+|classcat|zustand)[\\/]/, priority: 1 },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router|cookie|set-cookie-parser|@tanstack|use-sync-external-store)[\\/]/, priority: 3 },
          ],
        },
      },
    },
  },
  server: {
    // только этот компьютер: прокси открывает весь API сервера, а сервер сам слушает только 127.0.0.1
    host: '127.0.0.1',
    proxy: {
      // server-guard.ts пускает только Host 127.0.0.1/localhost и Origin, совпадающий с Host. Браузер шлёт их от адреса Vite,
      // поэтому прокси переписывает оба на адрес сервера, а сервер ничего чужого не разрешает.
      '/api': {
        target: API,
        changeOrigin: true,
        configure(proxy) {
          // только свой Origin (страница самого Vite): чужой уходит как есть, и guard сервера отвечает 403 — иначе любая
          // открытая страница могла бы через прокси дёрнуть POST без тела (abort, pause), а сервер принял бы его за свой
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.origin !== undefined && req.headers.origin === `http://${req.headers.host}`) proxyReq.setHeader('origin', new URL(API).origin);
          });
        },
      },
    },
  },
});
