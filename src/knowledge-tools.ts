// Инструмент чтения тегов знаний по запросу: MCP-сервер внутри процесса на сессию этапа (как artifact-tools.ts у артефактов).
// В промпт этапа идёт по строке на тег знаний (knowledgeBlock в tags.ts), а полный текст — заметки, пути и вложения — этап
// получает knowledge_read со слагом, когда он ему понадобился. Только теги знаний своего блока и только чтение.
// Тег читается с диска при каждом вызове: правки на странице «Теги» во время запуска видны сразу.
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { attachDir, defuseMarkers, existingTagPaths, KNOWLEDGE_READ_TOOL, readTag, type KnowledgeTag, titleSuffix } from './tags.js';

export const KNOWLEDGE_TOOLS_SERVER = 'knowledge';
/** Имена для allowedTools: разрешены без подтверждения. */
export const KNOWLEDGE_TOOLS_ALLOW = [`mcp__${KNOWLEDGE_TOOLS_SERVER}__${KNOWLEDGE_READ_TOOL}`];

/**
 * Текст ответа knowledge_read: шапка со слагом и заголовком, описание, заметки (инструкции пользователя — без обёртки
 * source-data, как в промпте), существующие пути и вложения абсолютными путями. Слаг не из списка блока — ошибка с
 * перечнем доступных; тег, удалённый во время запуска, — тоже ошибка. where — кто спрашивает: этап запуска или
 * интерактивная сессия (sessions-mcp.ts), у неё тексты ошибок без «этапа» и «запуска».
 */
export function knowledgeReadText(slugs: string[], slug: string, where: 'phase' | 'session' = 'phase'): string {
  const available = slugs.join(', ') || 'ничего';
  if (!slugs.includes(slug)) {
    throw new Error(where === 'session' ? `Области знаний ${slug} среди тегов сессии нет. Доступны: ${available}` : `Области знаний ${slug} у этапа нет. Доступны: ${available}`);
  }
  const tag = readTag(slug);
  if (!tag || tag.kind !== 'knowledge') {
    throw new Error(where === 'session' ? `Тега знаний ${slug} больше нет: его удалили. Доступны: ${available}` : `Тега знаний ${slug} больше нет: его удалили, пока шёл запуск. Доступны: ${available}`);
  }
  const body = [`Область знаний ${slug}${titleSuffix(tag)}`];
  if (tag.description) body.push(`Когда нужна: ${defuseMarkers(tag.description)}`);
  const notes = tag.notes.trim();
  if (notes) body.push(defuseMarkers(notes));
  const paths = existingTagPaths(tag).listed;
  if (paths.length) body.push(`Пути (только чтение): ${paths.join(', ')}`);
  if (tag.attachments.length) body.push('Вложения (открой инструментом Read):', ...tag.attachments.map((f) => `- ${path.join(attachDir(slug), f)}`));
  if (body.length === 1) body.push('Тег пуст: заполни заметки, пути или вложения на странице «Теги».');
  return body.join('\n');
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const run = (fn: () => string): ToolText => {
  try {
    return { content: [{ type: 'text', text: fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
};

/** MCP-сервер knowledge_read для одной сессии: допустимые слаги — теги знаний блока, зафиксированные на старте этапа. */
export function knowledgeToolsServer(tags: Pick<KnowledgeTag, 'slug'>[]) {
  const slugs = [...new Set(tags.map((t) => t.slug))];
  return createSdkMcpServer({
    name: KNOWLEDGE_TOOLS_SERVER,
    tools: [
      tool(
        KNOWLEDGE_READ_TOOL,
        'Полный текст области знаний из списка в промпте: заметки пользователя, пути только для чтения и вложения. Открывай, когда эта область нужна для текущего шага.',
        { slug: z.string().describe(`Слаг области знаний: ${slugs.join(', ') || 'нет доступных'}`) },
        async ({ slug }) => run(() => knowledgeReadText(slugs, slug)),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
