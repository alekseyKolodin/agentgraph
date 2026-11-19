#!/usr/bin/env node
// Фейковый CLI Claude Code для e2e: говорит протоколом stream-json, как настоящий (`--input-format stream-json
// --output-format stream-json`), но ответы берёт из сценария, а не из модели. Agent SDK запускает его по
// AGENTGRAPH_CLAUDE_EXECUTABLE. Сценарий — JSON-файл FAKE_CLAUDE_SCENARIO (тест переписывает его между шагами):
//   { "rules": [{ "when": "подстрока промпта или системного промпта", "text"?: "...", "structured"?: {...}, "delayMs"?: n }],
//     "mcpServers"?: [McpServerStatus…],  — ответ на mcp_status (список MCP-серверов и коннекторов claude.ai)
//     "mcpCalls"?: { "mcp__…__tool": { content, structuredContent?, isError? } } }  — ответы на mcp_call (вызов без модели)
//   Правило с "edits": [{ "find", "replace" }] — «Правка с ИИ»: фейк сам читает файл flow из промпта и правит его
//   вызовами Read/Edit (tool_use + tool_result, как настоящий агент), между шагами — "stepDelayMs".
// Первое совпавшее правило отвечает; нет совпадений — ответ по умолчанию (см. defaultAnswer). Каждый вызов
// дописывается строкой в FAKE_CLAUDE_LOG — тест проверяет, какие сессии были и что в них ушло.
import fs from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = randomUUID();
const model = arg('--model') ?? 'claude-sonnet-fake';
let system = '';
let schema;
// --json-schema приходит строкой в аргументах у части версий SDK; у других — в initialize
try {
  const s = arg('--json-schema');
  if (s) schema = JSON.parse(s);
} catch {
  /* нет — так нет */
}
const sp = arg('--system-prompt');
if (sp) system = sp;

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function scenario() {
  const file = process.env.FAKE_CLAUDE_SCENARIO;
  if (!file) return { rules: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { rules: [] };
  }
}

function logCall(entry) {
  const file = process.env.FAKE_CLAUDE_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), model, ...entry }) + '\n');
  } catch {
    /* лог — не главное */
  }
}

/** Минимальный объект по JSON-схеме: обязательные поля заполнены пустыми значениями. */
function fromSchema(s) {
  if (!s || typeof s !== 'object') return {};
  if (s.type === 'object' || s.properties) {
    const o = {};
    for (const k of s.required ?? []) o[k] = fromSchema(s.properties?.[k]);
    return o;
  }
  if (s.type === 'array') return [];
  if (s.type === 'boolean') return false;
  if (s.type === 'number' || s.type === 'integer') return 0;
  if (s.enum) return s.enum[0];
  return 'ok';
}

/** Текст события из промпта проверки словами: всё внутри первого <source-data>. */
function firstData(prompt) {
  const m = prompt.match(/<source-data[^>]*>([\s\S]*?)<\/source-data>/);
  return m ? m[1] : prompt;
}

function defaultAnswer(prompt) {
  // проверка словами (src/routines/check.ts): подходит, если в тексте события нет [nomatch]; дубль — если есть [dup]
  if (system.includes('You check whether an incoming event')) {
    const ev = firstData(prompt.split('Новое событие:')[1] ?? prompt);
    const match = !ev.includes('[nomatch]');
    const duplicate = ev.includes('[dup]');
    return { structured: { match, duplicate, reason: match ? (duplicate ? 'Похоже на недавний баг' : 'Похоже на баг') : 'Это не баг' } };
  }
  // подключение словами (src/routines/sources/draft.ts): команда curl к фейковому HTTP-серверу теста
  if (system.includes('Ты подключаешь внешний сервис')) {
    const base = process.env.FAKE_HTTP_BASE ?? 'http://127.0.0.1:9';
    return {
      structured: {
        api_found: true,
        reason: 'нашёл API',
        title: 'Фейк-сервис · заявки',
        command: `curl -s ${base}/items -H "Authorization: Bearer $FAKE_API_KEY"`,
        every: '1m',
        map_items: 'items',
        map_id: 'id',
        map_title: 'title',
        map_text: 'text',
        map_at: 'at',
        secrets: ['FAKE_API_KEY'],
        how_to: 'Ключ — в настройках фейк-сервиса, раздел API.',
      },
    };
  }
  // итоги итерации и сводка запуска (src/run-digest.ts)
  if (system.startsWith('Ты пишешь короткие итоги')) {
    return { structured: { iteration: 'Разобрал и починил баг.', run: 'Сводка: баг AG-447 починен, оплата проходит.' } };
  }
  // этапы тестового flow: маркеры в промптах этапов
  if (prompt.includes('[[triage]]')) return { text: 'Таска AG-447: кнопка «Оплатить» падает. Критерий: оплата проходит.' };
  if (prompt.includes('[[fix]]')) return { text: 'Починил: AG-447 закрыта.' };
  if (prompt.includes('[[digest]]')) return { text: 'Утренняя сводка: всё спокойно.' };
  return schema ? { structured: fromSchema(schema) } : { text: 'ok' };
}

function answer(prompt) {
  for (const r of scenario().rules ?? []) {
    if (r.when && (prompt.includes(r.when) || system.includes(r.when))) return r;
  }
  return defaultAnswer(prompt);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('');
  return '';
}

let turns = 0;
const usage0 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Вызов инструмента агентом и его результат: сообщения assistant (tool_use) и user (tool_result), как у CLI. */
function toolCall(name, input, result) {
  const id = `toolu_${randomUUID().slice(0, 12)}`;
  out({
    type: 'assistant', session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(),
    message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', stop_sequence: null, usage: usage0 },
  });
  out({ type: 'user', session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
}

/** «Правка с ИИ»: Read файла flow, потом Edit на каждую замену (замены — подряд по тексту файла). */
async function editFile(prompt, edits, stepMs) {
  const file = prompt.match(/в файле (\/\S+?\.yaml)/)?.[1];
  if (!file) return;
  await sleep(stepMs);
  toolCall('Read', { file_path: file }, fs.readFileSync(file, 'utf8'));
  for (const e of edits) {
    await sleep(stepMs);
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(e.find)) fs.writeFileSync(file, text.replace(e.find, e.replace));
    toolCall('Edit', { file_path: file, old_string: e.find, new_string: e.replace }, `The file ${file} has been updated.`);
  }
  await sleep(stepMs);
}

async function onUser(msg) {
  const prompt = textOf(msg.message?.content);
  const a = answer(prompt);
  logCall({ system: system.slice(0, 300), prompt, schema: Boolean(schema), answer: a });
  if (a.delayMs) await sleep(a.delayMs);
  turns++;
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'default', apiKeySource: 'none', slash_commands: [], output_style: 'default', uuid: randomUUID() });
  if (Array.isArray(a.edits)) await editFile(prompt, a.edits, a.stepDelayMs ?? 0);
  const structured = a.structured ?? (schema && !a.text ? fromSchema(schema) : undefined);
  const text = a.text ?? (structured !== undefined ? JSON.stringify(structured) : 'ok');
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  out({
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage },
  });
  const cost = typeof a.costUsd === 'number' ? a.costUsd : 0.01;
  out({
    type: 'result',
    subtype: a.error ? 'error_during_execution' : 'success',
    is_error: Boolean(a.error),
    duration_ms: 5,
    duration_api_ms: 5,
    num_turns: turns,
    result: text,
    ...(a.error ? { errors: [String(a.error)] } : {}),
    ...(structured !== undefined ? { structured_output: structured } : {}),
    session_id: sessionId,
    total_cost_usd: cost,
    usage,
    modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: cost, contextWindow: 200000, maxOutputTokens: 32000 } },
    permission_denials: [],
    uuid: randomUUID(),
  });
}

const rl = readline.createInterface({ input: process.stdin });
/** Вызов инструмента без модели: ответ из сценария по имени инструмента, вызов — в лог (model: 'mcp_call'). */
function mcpCall(req) {
  logCall({ model: 'mcp_call', system: '', prompt: `${req.tool} ${JSON.stringify(req.arguments ?? {})}`, schema: false, answer: null });
  return scenario().mcpCalls?.[req.tool] ?? { content: [{ type: 'text', text: '[]' }] };
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'control_request') {
    const req = msg.request ?? {};
    if (req.subtype === 'initialize') {
      if (Array.isArray(req.systemPrompt)) system = req.systemPrompt.join('\n');
      else if (typeof req.systemPrompt === 'string') system = req.systemPrompt;
      if (req.jsonSchema) schema = req.jsonSchema;
    }
    const response = req.subtype === 'initialize'
      ? { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} }
      : req.subtype === 'mcp_status'
        ? { mcpServers: scenario().mcpServers ?? [] }
        : req.subtype === 'mcp_call'
          ? mcpCall(req)
          : {};
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
    return;
  }
  if (msg.type === 'user') void onUser(msg);
});
rl.on('close', () => process.exit(0));
