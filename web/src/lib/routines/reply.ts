// Ответ в источник «Сервис через Claude» (config.reply): один пишущий инструмент и шаблон его аргументов. Проверка та же,
// что на сервере (replyOf в src/routines/sources/connector.ts), чтобы ошибка была видна до сохранения.
import type { ConnectorReply } from '@server/routines/types';
import { t } from '../i18n';

/** Подсказка-образец для инструмента отправки сообщения в тред (имена аргументов у сервисов разные — правятся руками). */
export const DEFAULT_REPLY_ARGS = '{\n  "channel_id": "{{channel}}",\n  "thread_ts": "{{thread}}",\n  "message": "{{text}}"\n}';

/** {{text}} должен стоять в значении аргумента: в ключе он не подставляется. */
function hasTextValue(v: unknown): boolean {
  if (typeof v === 'string') return v.includes('{{text}}');
  if (Array.isArray(v)) return v.some(hasTextValue);
  if (v && typeof v === 'object') return Object.values(v).some(hasTextValue);
  return false;
}

export type ReplyParse = { ok: true; reply: ConnectorReply } | { ok: false; error: string };

/** Инструмент и текст шаблона аргументов → config.reply или понятная ошибка. */
export function parseReply(tool: string, argsText: string): ReplyParse {
  if (!/^mcp__[\w-]+__[\w-]+$/.test(tool)) return { ok: false, error: t('Выбери инструмент, которым отправляется ответ') };
  let args: unknown;
  try {
    args = JSON.parse(argsText);
  } catch {
    return { ok: false, error: t('Аргументы — не JSON: проверь скобки и кавычки') };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: t('Аргументы — объект JSON: { "имя": "значение" }') };
  if (JSON.stringify(args).length > 4000) return { ok: false, error: t('Аргументы слишком длинные') };
  if (!hasTextValue(args)) return { ok: false, error: t('В аргументах нет {{text}}: сообщение ушло бы без текста') };
  return { ok: true, reply: { tool, args: args as Record<string, unknown> } };
}
