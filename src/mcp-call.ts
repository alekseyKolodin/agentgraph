// Вызов инструмента MCP без модели: процесс Claude Code поднимает свои MCP-серверы (коннекторы claude.ai и серверы
// уровня пользователя) и выполняет control-запрос mcp_call — ход модели не нужен, лимит не тратится.
// Публичного метода у Query для mcp_call пока нет, поэтому зовём внутренний request: если версия SDK его не умеет,
// ошибка понятная, и источник «Сервис через Claude» остаётся на проверке через модель.
import os from 'node:os';
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { blockingMcpEnv, claudeExecutable } from './agent.js';

/** Что вернул инструмент: structuredContent, если сервер его дал, иначе текст (JSON — разобранный). */
export type McpCallResult = { data: unknown; text: string; isError: boolean };
export type McpCaller = { call: (tool: string, args: Record<string, unknown>) => Promise<McpCallResult>; close: () => void };

type RawQuery = Pick<Query, 'close'> & { request?: (req: Record<string, unknown>) => Promise<{ response?: unknown }> };
export type McpCallDeps = { query: (args: { prompt: AsyncIterable<never>; options: Options }) => RawQuery };

async function* noPrompt(): AsyncGenerator<never> {
  await new Promise(() => {});
}

/** Сессия для нескольких вызовов подряд: серверы поднимаются один раз (около двух секунд). */
export function openMcp(deps: McpCallDeps = { query: query as unknown as McpCallDeps['query'] }, signal?: AbortSignal): McpCaller {
  // нейтральная папка: те же серверы, что видит выбор сервиса (getMcpServers), без серверов проекта
  const q = deps.query({ prompt: noPrompt(), options: { ...claudeExecutable(), cwd: os.tmpdir(), persistSession: false, tools: [], env: blockingMcpEnv() } });
  const close = () => q.close();
  signal?.addEventListener('abort', close, { once: true });
  return {
    async call(tool, args) {
      if (typeof q.request !== 'function') throw new Error('Эта версия Claude Code не умеет вызывать инструменты без модели');
      const r = (await q.request({ subtype: 'mcp_call', tool, arguments: args })) as { response?: unknown };
      return toResult(r.response);
    },
    close() {
      signal?.removeEventListener('abort', close);
      close();
    },
  };
}

/** Ответ MCP (content[], structuredContent, isError) → данные для разбора записей. */
export function toResult(raw: unknown): McpCallResult {
  const r = (raw ?? {}) as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
  const text = (r.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
  let data: unknown = r.structuredContent;
  if (data === undefined) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { data, text, isError: r.isError === true };
}
