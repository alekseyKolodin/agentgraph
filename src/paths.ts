import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень проекта agentgraph (не рабочая директория агентов). */
export const ROOT = process.env.AGENTGRAPH_HOME ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FLOWS_DIR = path.join(ROOT, 'flows');
export const RUNS_DIR = path.join(ROOT, 'runs');
/**
 * Сборка UI (web/, `npm run build:web`), раздаётся на /. Это код, а не данные: лежит рядом с исходниками, а не в
 * AGENTGRAPH_HOME, — туда же её кладёт scripts/ensure-web.mts. Из src/ и из собранного dist/ путь один: <корень>/dist/web.
 */
export const WEB_DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'web');
