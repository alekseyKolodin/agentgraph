// Инструмент чтения артефактов по ключу: MCP-сервер внутри процесса на сессию этапа или судьи с доступом к артефактам
// (как chatServer у чата). artifact_map — полная карта постранично, artifact_read — раздел целиком, artifact_search —
// строки с совпадениями. Только свои артефакты этапа и только чтение; ответы — данные из файла, а не инструкции.
import fs from 'node:fs';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { artifactMap, fmtSize, sliceLines, splitLines, type ArtifactSource, type MapSection } from './artifacts.js';

export const ARTIFACT_TOOLS_SERVER = 'artifacts';
export const ARTIFACT_TOOL_NAMES = ['artifact_map', 'artifact_read', 'artifact_search'] as const;
/** Имена для allowedTools: разрешены без подтверждения. */
export const ARTIFACT_TOOLS_ALLOW = ARTIFACT_TOOL_NAMES.map((t) => `mcp__${ARTIFACT_TOOLS_SERVER}__${t}`);

/** Строк полной карты на страницу artifact_map. */
const MAP_PAGE = 150;
/** Раздел больше этого artifact_read отдаёт частями. */
export const READ_PART_MAX = 64 * 1024;
const SEARCH_MAX = 50;
/** Больше этого файл инструментом не читается: только Read по строкам. */
const FILE_MAX = 8 * 1024 * 1024;

/**
 * Выдавать ли этапам и судье инструмент. Выключение (false) оставляет механизм «карта + Read по строкам»:
 * так и должно быть, если scripts/check-sdk-hooks.mts покажет, что MCP у этапов не работает.
 */
export const ARTIFACT_TOOLS_ENABLED = true;

function source(sources: ArtifactSource[], key: string): ArtifactSource {
  const s = sources.find((x) => x.key === key);
  if (!s) throw new Error(`Артефакта ${key} у этапа нет. Доступны: ${sources.map((x) => x.key).join(', ') || 'ничего'}`);
  return s;
}

/** Текст артефакта без следования ссылкам; только обычный файл до 8 МБ. */
function readText(s: ArtifactSource): string {
  let fd: number;
  try {
    fd = fs.openSync(s.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    throw new Error(`Файла артефакта ${s.key} сейчас нет: ${s.path}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`Файл артефакта ${s.key} — не обычный файл`);
    if (st.size > FILE_MAX) throw new Error(`Артефакт ${s.key} больше ${fmtSize(FILE_MAX)}: читай его Read с offset и limit`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const mapOf = (s: ArtifactSource, text: string) => artifactMap(text, { title: s.title, path: s.path, file: s.file, tool: true, full: true });

/** artifact_map: полная карта артефакта, по MAP_PAGE разделов на страницу. */
export function mapPage(sources: ArtifactSource[], key: string, page = 1): string {
  const s = source(sources, key);
  const lines = mapOf(s, readText(s)).text.split('\n');
  const [head, rows] = [lines.slice(0, 2), lines.slice(2)];
  const pages = Math.max(1, Math.ceil(rows.length / MAP_PAGE));
  if (!Number.isInteger(page) || page < 1 || page > pages) throw new Error(`Страницы ${page} нет: всего ${pages}`);
  const tail = pages > 1 ? [`Страница ${page} из ${pages}${page < pages ? `: следующая — artifact_map(key: "${key}", page: ${page + 1})` : ''}.`] : [];
  return [...head, ...tail, ...rows.slice((page - 1) * MAP_PAGE, page * MAP_PAGE)].join('\n');
}

/** artifact_read: текст раздела карты байт в байт; раздел больше 64 КБ — по частям (part с 1). */
export function readSection(sources: ArtifactSource[], key: string, section: string, part = 1): string {
  const s = source(sources, key);
  const text = readText(s);
  const sections = mapOf(s, text).sections;
  const sec = sections.find((x) => x.key === section);
  if (!sec) {
    const keys = sections.map((x) => `«${x.key}»`);
    throw new Error(`В артефакте ${key} нет раздела «${section}». Разделы: ${keys.slice(0, 60).join(', ')}${keys.length > 60 ? `, … (ещё ${keys.length - 60}: artifact_map)` : ''}`);
  }
  const parts = splitParts(text, sec);
  if (!Number.isInteger(part) || part < 1 || part > parts.length) throw new Error(`Части ${part} нет: всего ${parts.length}`);
  const p = parts[part - 1];
  const head = `Раздел «${sec.key}» артефакта «${s.title}» — ${p.from === p.to ? `строка ${p.from}` : `строки ${p.from}–${p.to}`}${parts.length > 1 ? `, часть ${part} из ${parts.length}` : ''}:`;
  return `${head}\n${sliceLines(text, p.from, p.to)}`;
}

/** Части раздела не больше READ_PART_MAX по границам строк (строка длиннее порога — отдельной частью). */
function splitParts(text: string, sec: MapSection): { from: number; to: number }[] {
  const lines = splitLines(text);
  const parts: { from: number; to: number }[] = [];
  let from = sec.from;
  let bytes = 0;
  for (let i = sec.from; i <= sec.to; i++) {
    const b = Buffer.byteLength(lines[i - 1] ?? '') + 1;
    if (bytes && bytes + b > READ_PART_MAX) {
      parts.push({ from, to: i - 1 });
      from = i;
      bytes = 0;
    }
    bytes += b;
  }
  parts.push({ from, to: sec.to });
  return parts;
}

/** artifact_search: строки с вхождением query (без учёта регистра) — раздел и номер строки, до 50. */
export function searchArtifact(sources: ArtifactSource[], key: string, query: string): string {
  const s = source(sources, key);
  const q = query.trim().toLowerCase();
  if (!q) throw new Error('Пустой запрос');
  const text = readText(s);
  const sections = mapOf(s, text).sections;
  const lines = splitLines(text);
  const found: string[] = [];
  let total = 0;
  lines.forEach((l, i) => {
    if (!l.toLowerCase().includes(q)) return;
    total++;
    if (found.length >= SEARCH_MAX) return;
    const sec = sections.find((x) => i + 1 >= x.from && i + 1 <= x.to);
    const shown = [...l.trim()].length > 200 ? [...l.trim()].slice(0, 199).join('') + '…' : l.trim();
    found.push(`- строка ${i + 1}${sec ? `, раздел «${sec.key}»` : ''}: ${shown}`);
  });
  if (!total) return `В артефакте «${s.title}» нет «${query}».`;
  return [`«${query}» в артефакте «${s.title}»: совпадений ${total}${total > SEARCH_MAX ? `, показаны первые ${SEARCH_MAX}` : ''}.`, ...found].join('\n');
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const run = (fn: () => string): ToolText => {
  try {
    return { content: [{ type: 'text', text: fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
};

/** MCP-сервер инструментов чтения для одной сессии: только эти артефакты, только чтение. */
export function artifactToolsServer(sources: ArtifactSource[]) {
  const keys = sources.map((s) => s.key);
  const keyArg = z.string().describe(`Ключ артефакта: ${keys.join(', ') || 'нет доступных'}`);
  return createSdkMcpServer({
    name: ARTIFACT_TOOLS_SERVER,
    tools: [
      tool(
        'artifact_map',
        'Полная карта артефакта запуска: все разделы с ключом, диапазоном строк, размером и описанием. Длинная карта — постранично.',
        { key: keyArg, page: z.number().int().min(1).optional().describe('страница с 1, по умолчанию 1') },
        async ({ key, page }) => run(() => mapPage(sources, key, page ?? 1)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'artifact_read',
        'Текст раздела артефакта целиком по ключу раздела из карты (раздел больше 64 КБ — по частям).',
        { key: keyArg, section: z.string().describe('ключ раздела из карты, как есть'), part: z.number().int().min(1).optional().describe('часть с 1 для большого раздела') },
        async ({ key, section, part }) => run(() => readSection(sources, key, section, part ?? 1)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'artifact_search',
        'Поиск строки в артефакте без учёта регистра: номера строк и разделы с совпадениями (до 50).',
        { key: keyArg, query: z.string().describe('что искать') },
        async ({ key, query }) => run(() => searchArtifact(sources, key, query)),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
