import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Папка кода agentgraph (package.json, web/, dist/): из src/ и из собранного dist/ — их родитель. Не зависит от AGENTGRAPH_HOME. */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Корень проекта agentgraph (не рабочая директория агентов). */
export const ROOT = process.env.AGENTGRAPH_HOME ?? APP_DIR;
export const FLOWS_DIR = path.join(ROOT, 'flows');
export const RUNS_DIR = path.join(ROOT, 'runs');
/**
 * Сборка UI (web/, `npm run build:web`), раздаётся на /. Это код, а не данные: лежит рядом с исходниками, а не в
 * AGENTGRAPH_HOME, — туда же её кладёт scripts/ensure-web.mts. Из src/ и из собранного dist/ путь один: <корень>/dist/web.
 */
export const WEB_DIST_DIR = path.join(APP_DIR, 'dist', 'web');
