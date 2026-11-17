// Настоящий сервер agentgraph для e2e: тот же startServer, что у `agentgraph ui`, но с коротким тиком движка рутин
// (расписание и очередь не ждут по 30 с). Порт, папки и фейки — из окружения, которое готовит e2e/support/env.ts.
// Печатает «READY <url>», на SIGTERM останавливается как CLI (stopServer пишет last-check live-источников).
import { startServer, stopServer } from '../../src/server.js';

const port = Number(process.env.E2E_PORT);
const cwd = process.env.E2E_PROJECT;
if (!port || !cwd) throw new Error('E2E_PORT и E2E_PROJECT обязательны');

const url = await startServer({
  port,
  host: '127.0.0.1',
  defaultCwd: cwd,
  notify: false,
  update: false,
  routines: { tickMs: Number(process.env.E2E_TICK_MS) || 300, reconnectMs: 500 },
});
console.log(`READY ${url}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await stopServer(5_000).catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
