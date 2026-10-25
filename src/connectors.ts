// Коннекторы claude.ai аккаунта и их инструменты — для конструктора flow: этап получает коннектор, только если
// перечислил его инструменты в tools (см. wantsClaudeAiConnectors), и автору нужны точные имена.
// Список отдаёт сам Agent SDK (mcpServerStatus на сессии без промпта, к модели не обращается).
import os from 'node:os';
import { query, type McpServerStatus, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { claudeExecutable } from './agent.js';

/** read — только читает; write — меняет что-то снаружи (отправить сообщение, создать задачу) без подтверждения. */
export type ConnectorTool = { name: string; tool: string; description?: string; readOnly: boolean };
/** name — запись для tools этапа, которая разрешает весь коннектор: mcp__claude_ai_<Коннектор>. */
export type Connector = { server: string; name: string; status: McpServerStatus['status']; tools: ConnectorTool[] };
export type ConnectorsView = { connectors: Connector[]; at: string };

export type ConnectorsDeps = {
  query: (args: { prompt: AsyncIterable<never>; options: Options }) => Pick<Query, 'mcpServerStatus' | 'close'>;
  /** Сколько всего ждать подключения; по умолчанию WAIT_MS. */
  waitMs?: number;
  /** Пауза между опросами; по умолчанию POLL_MS. */
  pollMs?: number;
};

/** Коннекторы появляются в списке не сразу (около секунды), подключаются ещё 2–3 секунды. */
const WAIT_MS = 15_000;
const POLL_MS = 500;
/** Пустой список раньше этого не считаем ответом: коннекторы аккаунта ещё могут не прийти. */
const MIN_EMPTY_MS = 5_000;
/** Каждый листинг — запуск процесса Claude Code: список держим несколько минут. */
const TTL_MS = 5 * 60_000;

let cache: ConnectorsView | undefined;
let inflight: Promise<ConnectorsView> | undefined;

/** Имя инструмента коннектора в сессии: «claude.ai Atlassian Rovo» + getJiraIssue → mcp__claude_ai_Atlassian_Rovo__getJiraIssue. */
export function connectorToolName(server: string, tool: string): string {
  return `${connectorName(server)}__${tool}`;
}

/** Весь коннектор одной записью в tools (правило разрешения на уровне сервера): «claude.ai Slack» → mcp__claude_ai_Slack. */
export function connectorName(server: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function getConnectors(force = false, deps: ConnectorsDeps = { query }): Promise<ConnectorsView> {
  if (!force && cache && Date.now() - new Date(cache.at).getTime() < TTL_MS) return Promise.resolve(cache);
  inflight ??= fetchConnectors(deps)
    .then((v) => (cache = v))
    .finally(() => (inflight = undefined));
  return inflight;
}

/** Сброс кэша — для тестов. */
export function resetConnectorsState(): void {
  cache = undefined;
  inflight = undefined;
}

async function* noPrompt(): AsyncGenerator<never> {
  // потоковый ввод, который ничего не присылает: сессия живёт, пока опрашиваем серверы
  await new Promise(() => {});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isConnector = (s: McpServerStatus) => s.scope === 'claudeai';

/**
 * Опрашивает MCP-серверы сессии, пока коннекторы claude.ai подключаются (pending), но не дольше waitMs. Пустой
 * список ответом считается только через minEmptyMs: коннекторы аккаунта приходят в сессию не сразу.
 * Возвращает последний снимок всех серверов.
 */
export async function waitForConnectors(
  status: () => Promise<McpServerStatus[]>,
  o: { waitMs: number; pollMs?: number; minEmptyMs?: number },
): Promise<McpServerStatus[]> {
  const started = Date.now();
  for (;;) {
    const all = await status();
    const ai = all.filter(isConnector);
    const elapsed = Date.now() - started;
    const settled = !ai.some((s) => s.status === 'pending') && (ai.length > 0 || elapsed >= Math.min(o.minEmptyMs ?? MIN_EMPTY_MS, o.waitMs));
    if (settled || elapsed >= o.waitMs) return all;
    await sleep(o.pollMs ?? POLL_MS);
  }
}

async function fetchConnectors(deps: ConnectorsDeps): Promise<ConnectorsView> {
  // cwd — домашняя директория: серверы проекта сюда не нужны, коннекторы приходят из аккаунта
  const q = deps.query({ prompt: noPrompt(), options: { ...claudeExecutable(), cwd: os.homedir(), persistSession: false, tools: [] } });
  try {
    const ai = (await waitForConnectors(() => q.mcpServerStatus(), { waitMs: deps.waitMs ?? WAIT_MS, pollMs: deps.pollMs })).filter(isConnector);
    const connectors = ai
      .map((s) => ({
        server: s.name,
        name: connectorName(s.name),
        status: s.status,
        tools: (s.tools ?? []).map((t) => ({
          name: connectorToolName(s.name, t.name),
          tool: t.name,
          ...(t.description ? { description: t.description.split('\n')[0].slice(0, 200) } : {}),
          readOnly: t.annotations?.readOnly === true,
        })),
      }))
      .sort((a, b) => Number(b.status === 'connected') - Number(a.status === 'connected') || a.server.localeCompare(b.server));
    return { connectors, at: new Date().toISOString() };
  } finally {
    q.close();
  }
}
