#!/usr/bin/env node
// Хелпер скилла /session-to-flow: находит транскрипт сессии Claude Code и сжимает его в дайджест,
// по которому видно рабочий путь и подводные камни (ошибки, отказы, поправки пользователя, повторы).
//
//   node digest.mjs root                          корень проекта agentgraph (для flows/ и src/)
//   node digest.mjs list [--cwd DIR] [--limit N]  последние сессии (все проекты или только DIR)
//   node digest.mjs digest [ID|PATH] [--out FILE] [--max-kb N] [--skill NAME] [--no-cut]
//       ID по умолчанию — $CLAUDE_CODE_SESSION_ID (текущая сессия). Хвост, начиная с последнего вызова
//       скилла NAME (по умолчанию session-to-flow), отрезается: это уже работа самого скилла.
//   node digest.mjs tool [ID|PATH] N [--tail L]   вызов инструмента #N из дайджеста целиком: вход и
//       последние L строк результата (по умолчанию 80)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const HOME = process.env.AGENTGRAPH_HOME || path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), '../../..');

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) pos.push(a);
    else if (a.startsWith('--no-')) opt[a.slice(5)] = false;
    else opt[a.slice(2)] = argv[++i];
  }
  return { pos, opt };
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// ---------- маскирование ----------

const SECRET_RES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[приватный ключ скрыт]'],
  [/\b(glpat-|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|sk-ant-|sk-|AKIA|AIza)[A-Za-z0-9_\-]{8,}/g, '$1***'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._\-+/=]{12,}/gi, '$1 ***'],
  [/((?:token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|auth)[\w-]*["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, '$1***'],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1***:***@'],
  [/\b(?!127\.)(?!0\.0\.0\.0)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, '<ip>'],
];
const SENSITIVE_FILE = /(^|[/\s'"])(\.env(\.[\w-]+)?|local\.properties|[\w.-]*\.(keystore|jks|p12|pem|key)|credentials(\.json)?|\.netrc|\.npmrc|google-services\.json|GoogleService-Info\.plist)(\s|$|['"])/;

function mask(s) {
  let r = String(s ?? '');
  for (const [re, rep] of SECRET_RES) r = r.replace(re, rep);
  return r;
}

// ---------- поиск транскриптов ----------

function projectDirs() {
  if (!fs.existsSync(PROJECTS)) return [];
  return fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(PROJECTS, e.name));
}

function findTranscript(idOrPath) {
  if (idOrPath && /\.jsonl$/.test(idOrPath) && fs.existsSync(idOrPath)) return path.resolve(idOrPath);
  const id = idOrPath || process.env.CLAUDE_CODE_SESSION_ID;
  if (!id) fail('Не задан id сессии и нет $CLAUDE_CODE_SESSION_ID. Найди сессию: node digest.mjs list [--cwd DIR]');
  for (const dir of projectDirs()) {
    const f = path.join(dir, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  fail(`Транскрипт сессии ${id} не найден в ${PROJECTS}`);
}

/** Начало файла: cwd, ветка и первая реплика пользователя — для списка сессий. */
function peek(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(256 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const info = {};
  for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!info.cwd && o.cwd) info.cwd = o.cwd;
    if (!info.branch && o.gitBranch) info.branch = o.gitBranch;
    if (!info.first && o.type === 'user' && !o.isMeta && !o.isSidechain) {
      const t = userText(o.message?.content);
      if (t) info.first = t.replace(/\s+/g, ' ').slice(0, 160);
    }
    if (info.cwd && info.first) break;
  }
  return info;
}

function list(opt) {
  const limit = Number(opt.limit ?? 15);
  const wantCwd = opt.cwd ? path.resolve(opt.cwd) : undefined;
  const files = [];
  for (const dir of projectDirs()) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      files.push({ file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const rows = [];
  for (const f of files) {
    if (rows.length >= limit) break;
    const info = peek(f.file);
    if (wantCwd && info.cwd !== wantCwd) continue;
    const id = path.basename(f.file, '.jsonl');
    let title;
    try { title = JSON.parse(fs.readFileSync(path.join(path.dirname(f.file), id, 'custom-title.json'), 'utf8')).customTitle; } catch {}
    rows.push({
      id,
      updated: local(f.mtime),
      sizeKb: Math.round(fs.statSync(f.file).size / 1024),
      cwd: info.cwd,
      branch: info.branch,
      title,
      first: info.first ? mask(info.first) : undefined,
      current: id === process.env.CLAUDE_CODE_SESSION_ID || undefined,
    });
  }
  out(rows);
}

// ---------- разбор записей ----------

function stripReminders(s) {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
}

function userText(content) {
  if (typeof content === 'string') return stripReminders(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (c.type === 'text') parts.push(stripReminders(c.text ?? ''));
    else if (c.type === 'image') parts.push('[изображение]');
  }
  return parts.filter(Boolean).join('\n');
}

function resultText(c) {
  if (typeof c.content === 'string') return c.content;
  if (Array.isArray(c.content)) return c.content.map((x) => (x.type === 'text' ? x.text : x.type === 'image' ? '[изображение]' : '')).join('\n');
  return '';
}

/** Локальное время YYYY-MM-DD HH:MM. */
function local(ts) {
  return new Date(ts).toLocaleString('sv-SE').slice(0, 16);
}

/** Отчёт сабагента без служебной шапки харнесса. */
function stripHandback(s) {
  const i = s.indexOf('The report follows:');
  return i >= 0 && s.startsWith('[Subagent hand-back]') ? s.slice(i + 'The report follows:'.length) : s;
}

function cap(s, n) {
  s = String(s ?? '').trim();
  return s.length > n ? `${s.slice(0, n)} …[+${s.length - n}]` : s;
}

function oneLine(s, n) {
  return cap(String(s ?? '').replace(/\s+/g, ' '), n);
}

function tailLines(s, n) {
  return String(s ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n);
}

/** Сбой при коде выхода 0: строки с признаками сбоя в хвосте вывода Bash (или undefined). */
function suspectLines(tool, text) {
  if (tool?.name !== 'Bash') return undefined;
  const hits = tailLines(text, 25).filter((l) => FAIL_RE.test(l));
  return hits.length ? hits.slice(0, 3) : undefined;
}

const QUIET_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
// Файлы, запись в которые обычно и есть готовый урок: память, CLAUDE.md, правила, скиллы, агенты.
const LESSON_PATH = /\/memory\/|(^|\/)(CLAUDE|AGENTS)(\.local)?\.md$|\/\.claude\/(skills|agents|rules|commands)\/|\/\.agents\//;
// Признаки сбоя в выводе команды, которая вернула код 0 (пайп, `|| true`, `; echo`).
const FAIL_RE = /BUILD FAILED|^FAILURE:|\bexit(?: code)?[=: ]+[1-9]|failed to push|! \[(?:remote )?rejected\]|^error: |^fatal: |Exception in thread|npm ERR!|Traceback \(most recent call last\)|There were failing tests|^e: file:\/\/|^\s*ERROR\b|[Uu]nknown (?:shorthand )?(?:flag|option|command)|command not found|No such file or directory/;

function toolSummary(name, input = {}, cmdCap = 600) {
  switch (name) {
    case 'Bash':
      return `\`${oneLine(input.command, cmdCap)}\`${input.description ? ` — ${oneLine(input.description, 100)}` : ''}${input.run_in_background ? ' [в фоне]' : ''}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return input.file_path ?? input.notebook_path ?? '';
    case 'Grep':
      return `/${oneLine(input.pattern, 120)}/ ${input.path ?? ''}${input.glob ? ` (${input.glob})` : ''}`;
    case 'Glob':
      return `${input.pattern ?? ''} ${input.path ?? ''}`;
    case 'Agent':
    case 'Task':
      return `${input.subagent_type ?? 'general-purpose'} «${oneLine(input.description, 100)}»${input.run_in_background ? ' [в фоне]' : ''}`;
    case 'Skill':
      return `${input.skill ?? ''}${input.args ? ` ${oneLine(input.args, 200)}` : ''}`;
    case 'AskUserQuestion':
      return (input.questions ?? []).map((q) => `«${oneLine(q.question, 200)}» [${(q.options ?? []).map((o) => o.label).join(' | ')}]`).join('; ');
    case 'WebFetch':
      return input.url ?? '';
    case 'WebSearch':
      return input.query ?? '';
    default:
      return oneLine(JSON.stringify(input), 200);
  }
}

/** Команда без присваиваний и cd впереди: `S=…; cd X && git push` и `git push` — один повтор. */
function coreCommand(cmd) {
  return String(cmd ?? '')
    .replace(/^\s*(?:(?:export\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s*(?:;|&&|\n)\s*|cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:;|&&|\n)\s*)+/, '')
    .trim();
}

const REJECTED = /doesn't want to proceed|tool use was rejected|user (has )?(denied|rejected)|Permission to use .* (was )?denied/i;
const INTERRUPTED = /\[Request interrupted by user/;
const ASYNC_LAUNCH = /^\s*Async agent launched/;

function isError(c, text) {
  if (c.is_error) return true;
  return /^\s*(<tool_use_error>|Exit code [1-9])/.test(text);
}

function hideSensitive(tool, text) {
  if (!tool) return text;
  const target = tool.name === 'Bash' ? tool.input?.command : tool.input?.file_path;
  return target && SENSITIVE_FILE.test(` ${target} `) ? '[вывод скрыт: чувствительный файл]' : text;
}

async function* entries(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch {}
  }
}

/** Где обрезать: последний вызов скилла (Skill-инструмент или слэш-команда). */
async function findCut(file, skill) {
  const re = new RegExp(`<command-name>/?${skill}</command-name>`);
  let cut;
  for await (const o of entries(file)) {
    if (o.isSidechain) continue;
    const content = o.message?.content;
    if (o.type === 'assistant' && Array.isArray(content)) {
      if (content.some((c) => c.type === 'tool_use' && c.name === 'Skill' && String(c.input?.skill ?? '').replace(/^.*:/, '') === skill)) cut = o.uuid;
    } else if (o.type === 'user') {
      const raw = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text ?? '').join('\n') : '';
      if (re.test(raw)) cut = o.uuid;
    }
  }
  return cut;
}

/** Сабагенты сессии; только запущенные до обрезки (их tool_use попал в дайджест). */
async function subagentInfo(file, spawnedIds) {
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  if (!fs.existsSync(dir)) return [];
  const res = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    const f = path.join(dir, name);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
    if (meta.toolUseId && !spawnedIds.has(meta.toolUseId)) continue;
    const tools = new Map();
    const errors = [];
    let calls = 0;
    for await (const o of entries(f)) {
      const content = o.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c.type === 'tool_use') {
          calls++;
          tools.set(c.id, { name: c.name, input: c.input });
        } else if (c.type === 'tool_result') {
          const text = resultText(c);
          const t = tools.get(c.tool_use_id);
          const suspect = !isError(c, text) && suspectLines(t, text);
          if ((isError(c, text) || suspect) && errors.length < 6) {
            errors.push(`${t?.name ?? '?'} ${t ? toolSummary(t.name, t.input, 300) : ''}\n      ${suspect ? '⚠' : '✗'} ${oneLine(hideSensitive(t, suspect ? suspect.join(' | ') : text), 400)}`);
          }
        }
      }
    }
    res.push({ type: meta.agentType ?? '?', description: meta.description ?? '', calls, errors });
  }
  return res;
}

/** Вложение «queued_command»: отчёт фонового агента, уведомление фоновой задачи или реплика, набранная во время хода. */
function queuedItem(a) {
  const prompt = typeof a.prompt === 'string' ? a.prompt : userText(a.prompt);
  const kind = a.origin?.kind;
  if (kind === 'peer') return { kind: 'peer', name: a.origin.name ?? a.origin.from, text: stripHandback(a.origin.body ?? prompt) };
  if (kind === 'task-notification' || a.commandMode === 'task-notification') {
    const tag = (t) => prompt.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim();
    const result = tag('result');
    return { kind: 'notify', text: [tag('summary'), tag('status') && `(${tag('status')})`, result && !/delivered to you as a message/.test(result) ? `: ${result}` : ''].filter(Boolean).join(' ') };
  }
  const text = stripReminders(prompt);
  return text ? { kind: 'user', text, queued: true } : undefined;
}

async function scan(file, cut) {
  const items = [];
  const tools = new Map();
  const repeats = new Map();
  const spawned = new Set();
  const stats = { user: 0, assistant: 0, tools: 0, errors: 0, suspect: 0, rejected: 0, interrupted: 0, compactions: 0, notifications: 0, lessons: 0 };
  const head = {};
  let n = 0;
  let cutReached = false;

  for await (const o of entries(file)) {
    if (cutReached) break;
    // запись с вызовом скилла ещё попадает в дайджест, следующие — нет
    if (cut && o.uuid === cut) cutReached = true;
    if (o.isSidechain) continue;
    if (o.timestamp) { head.first ??= o.timestamp; head.last = o.timestamp; }
    head.cwd ??= o.cwd;
    if (o.gitBranch && o.gitBranch !== 'HEAD') head.branch = o.gitBranch;
    const content = o.message?.content;

    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      stats.compactions++;
      items.push({ kind: 'compact' });
      continue;
    }
    if (o.type === 'attachment' && o.attachment?.type === 'queued_command') {
      const it = queuedItem(o.attachment);
      if (it) {
        if (it.kind === 'user') stats.user++;
        else stats.notifications++;
        items.push({ ...it, ts: o.timestamp });
      }
      continue;
    }
    if (o.type === 'user') {
      if (o.isCompactSummary) {
        items.push({ kind: 'summary', text: userText(content) });
        continue;
      }
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          const t = tools.get(c.tool_use_id);
          const text = resultText(c);
          const err = isError(c, text);
          const suspect = !err && suspectLines(t, text);
          if (t?.repeatKey && (err || suspect)) repeats.get(t.repeatKey).errors++;
          if (REJECTED.test(text)) {
            stats.rejected++;
            items.push({ kind: 'rejected', tool: t, text });
          } else if (err) {
            stats.errors++;
            items.push({ kind: 'error', tool: t, text: hideSensitive(t, text) });
          } else if (suspect) {
            stats.suspect++;
            items.push({ kind: 'suspect', tool: t, text: hideSensitive(t, [...suspect, '…', ...tailLines(text, 2)].join('\n')) });
          } else if (t?.name === 'Bash' && !t.input.run_in_background) {
            items.push({ kind: 'tail', text: hideSensitive(t, tailLines(text, 2).join('\n')) });
          } else if (t?.name === 'AskUserQuestion') {
            items.push({ kind: 'answer', text });
          } else if ((t?.name === 'Agent' || t?.name === 'Task') && !ASYNC_LAUNCH.test(text)) {
            items.push({ kind: 'report', tool: t, text });
          }
        }
      }
      if (o.isMeta) continue;
      const text = userText(content);
      if (!text) continue;
      if (INTERRUPTED.test(text)) {
        stats.interrupted++;
        items.push({ kind: 'interrupt', text });
      } else {
        stats.user++;
        items.push({ kind: 'user', text, ts: o.timestamp, cut: o.uuid === cut });
      }
      continue;
    }
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text?.trim()) {
          stats.assistant++;
          items.push({ kind: 'assistant', text: c.text });
        } else if (c.type === 'tool_use') {
          stats.tools++;
          const t = { n: ++n, name: c.name, input: c.input ?? {} };
          if (c.name === 'Bash') t.repeatKey = `Bash \`${oneLine(coreCommand(t.input.command), 160)}\``;
          else if (['Edit', 'Write', 'NotebookEdit'].includes(c.name)) t.repeatKey = `правка ${t.input.file_path ?? t.input.notebook_path}`;
          if (t.repeatKey) {
            const r = repeats.get(t.repeatKey) ?? { count: 0, errors: 0 };
            r.count++;
            repeats.set(t.repeatKey, r);
          }
          tools.set(c.id, t);
          if (c.name === 'Agent' || c.name === 'Task') spawned.add(c.id);
          items.push({ kind: 'tool', tool: t });
          if ((c.name === 'Write' || c.name === 'Edit') && LESSON_PATH.test(t.input.file_path ?? '')) {
            stats.lessons++;
            items.push({ kind: 'lesson', text: c.name === 'Write' ? t.input.content : t.input.new_string });
          }
        }
      }
    }
  }
  return { items, repeats, spawned, stats, head };
}

async function digest(pos, opt) {
  const file = findTranscript(pos[0]);
  const skill = opt.skill ?? 'session-to-flow';
  const cut = opt.cut === false ? undefined : await findCut(file, skill);
  const maxKb = Number(opt['max-kb'] ?? 80);
  const id = path.basename(file, '.jsonl');
  const outFile = opt.out ?? path.join(os.tmpdir(), `session-digest-${id}.md`);

  // Сначала модель сессии, потом рендер: если не влезли в лимит, рендерим компактнее.
  const { items, repeats, spawned, stats, head: h } = await scan(file, cut);
  const subagents = await subagentInfo(file, spawned);
  const head = {
    id, file, cwd: h.cwd, branch: h.branch,
    period: h.first ? `${local(h.first)} — ${local(h.last)}` : '',
    cut: cut ? `обрезано на вызове /${skill}` : 'без обрезки',
  };

  const levels = [
    { user: 6000, assistant: 1500, final: 8000, err: 800, report: 1500, answer: 1500, summary: 5000, cmd: 1500, tail: 2, lesson: 2000, quiet: true },
    { user: 4000, assistant: 700, final: 6000, err: 400, report: 800, answer: 800, summary: 3000, cmd: 600, tail: 1, lesson: 1200, quiet: false },
    { user: 2500, assistant: 300, final: 4000, err: 250, report: 400, answer: 500, summary: 2000, cmd: 300, tail: 0, lesson: 600, quiet: false },
  ];
  let text;
  let level = 0;
  for (; level < levels.length; level++) {
    text = mask(render(items, repeats, subagents, stats, head, levels[level]));
    if (Buffer.byteLength(text) <= maxKb * 1024) break;
  }
  level = Math.min(level, levels.length - 1);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, text);
  out({
    out: path.resolve(outFile),
    kb: Math.round(Buffer.byteLength(text) / 1024),
    lines: text.split('\n').length,
    detail: ['полный', 'сокращённый', 'сжатый'][level],
    ...head,
    stats,
    subagents: subagents.length,
  });
}

function render(items, repeats, subagents, stats, head, L) {
  const lines = [];
  const p = (s = '') => lines.push(s);
  const indent = (s) => s.replace(/\n/g, '\n    ');
  p(`# Дайджест сессии ${head.id}`);
  p();
  p(`- директория: ${head.cwd ?? '?'}${head.branch ? `, ветка ${head.branch}` : ''}`);
  p(`- период: ${head.period}; ${head.cut}`);
  p(`- реплик пользователя ${stats.user}, вызовов инструментов ${stats.tools}, ошибок ${stats.errors}, подозрительных выводов ${stats.suspect}, отказов ${stats.rejected}, прерываний ${stats.interrupted}, записей в память и правила ${stats.lessons}, сжатий контекста ${stats.compactions}, сабагентов ${subagents.length}`);
  p();
  p('Обозначения: 👤 пользователь, 🤖 ассистент, → #N вызов инструмента (целиком: `digest.mjs tool <id> N`), ⤷ хвост вывода, ✗ ошибка, ⚠ вывод похож на сбой при коде выхода 0, ⛔ отказ пользователя от действия, ⏹ прерывание, ❓ ответ на вопрос, ↳ отчёт или сообщение агента, 🔔 фоновая задача, 📝 запись в память, CLAUDE.md, правила или скиллы.');
  p('Секреты и IP замаскированы; вывод чтения .env/local.properties и подобных файлов скрыт.');
  p();
  p('## Хронология');
  let quietRun = 0;
  const flushQuiet = () => {
    if (quietRun) p(`  (+${quietRun} чтений/поисков)`);
    quietRun = 0;
  };
  let k = 0;
  const seenErrors = new Set();
  const lastAssistant = items.findLastIndex((it) => it.kind === 'assistant');
  items.forEach((it, i) => {
    if (it.kind === 'tool' && QUIET_TOOLS.has(it.tool.name) && !L.quiet) {
      quietRun++;
      return;
    }
    flushQuiet();
    switch (it.kind) {
      case 'user':
        p();
        p(`### 👤 [${++k}]${it.ts ? ` ${local(it.ts).slice(5)}` : ''}${it.queued ? ' (отправлено, пока ассистент работал)' : ''}${it.cut ? ' (вызов скилла — дальше обрезано)' : ''}`);
        p(cap(it.text, L.user));
        p();
        break;
      case 'assistant':
        p(`🤖 ${i === lastAssistant ? `(последний ответ сессии)\n${cap(it.text, L.final)}` : cap(it.text, L.assistant)}`);
        break;
      case 'tool':
        p(`→ #${it.tool.n} ${it.tool.name}: ${toolSummary(it.tool.name, it.tool.input, L.cmd)}`);
        break;
      case 'tail':
        if (L.tail && it.text) p(`  ⤷ ${tailLines(it.text, L.tail).map((l) => oneLine(l, 160)).join(' | ')}`);
        break;
      case 'lesson':
        p(`  📝 ${indent(cap(it.text, L.lesson))}`);
        break;
      case 'error': {
        // одинаковые ошибки (с точностью до путей и чисел) печатаем один раз
        const key = it.text.replace(/\S*\/\S*/g, '').replace(/\d+/g, '').slice(0, 300);
        if (seenErrors.has(key)) p('  ✗ (та же ошибка, что выше)');
        else p(`  ✗ ${indent(cap(it.text, L.err))}`);
        seenErrors.add(key);
        break;
      }
      case 'suspect':
        p(`  ⚠ код выхода 0, но вывод похож на сбой: ${indent(cap(it.text, L.err))}`);
        break;
      case 'rejected':
        p(`  ⛔ ОТКАЗ${it.tool ? ` (${it.tool.name})` : ''}: ${indent(cap(it.text, L.err))}`);
        break;
      case 'interrupt':
        p(`⏹ ${oneLine(it.text, 200)}`);
        break;
      case 'answer':
        p(`  ❓ ${indent(cap(it.text, L.answer))}`);
        break;
      case 'report':
        p(`  ↳ отчёт сабагента: ${indent(cap(stripHandback(it.text), L.report))}`);
        break;
      case 'peer':
        p(`↳ сообщение агента ${it.name ?? ''}: ${indent(cap(it.text, L.report))}`);
        break;
      case 'notify':
        p(`🔔 ${oneLine(it.text, 300)}`);
        break;
      case 'compact':
        p();
        p('=== контекст сжат ===');
        break;
      case 'summary':
        p(`=== сводка после сжатия ===\n${cap(it.text, L.summary)}\n=== конец сводки ===`);
        p();
        break;
    }
  });
  flushQuiet();

  const rep = [...repeats.entries()].filter(([, r]) => r.count >= 3 || r.errors >= 2).sort((a, b) => b[1].count - a[1].count);
  p();
  p('## Повторы (одна команда или файл ≥3 раз, или ≥2 сбоев) — вероятные места, где застряли');
  if (!rep.length) p('нет');
  for (const [key, r] of rep.slice(0, 40)) p(`- ${key} ×${r.count}${r.errors ? `, сбоев ${r.errors}` : ''}`);

  p();
  p('## Сабагенты');
  if (!subagents.length) p('нет');
  for (const s of subagents) {
    p(`- ${s.type} «${oneLine(s.description, 120)}»: вызовов ${s.calls}, сбоев ${s.errors.length}`);
    for (const e of s.errors) p(`    - ${e}`);
  }
  return lines.join('\n') + '\n';
}

/** Вызов #N целиком: вход и хвост результата. */
async function tool(pos, opt) {
  const [a, b] = pos;
  const [src, num] = b === undefined ? [undefined, a] : [a, b];
  const n = Number(num);
  if (!Number.isInteger(n) || n < 1) fail('Укажи номер вызова: node digest.mjs tool [ID|PATH] N');
  const file = findTranscript(src);
  const tailN = Number(opt.tail ?? 80);
  let i = 0;
  let found;
  for await (const o of entries(file)) {
    if (o.isSidechain) continue;
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!found && o.type === 'assistant' && c.type === 'tool_use' && ++i === n) found = { id: c.id, name: c.name, input: c.input ?? {} };
      else if (found && c.type === 'tool_result' && c.tool_use_id === found.id) {
        const text = resultText(c);
        const all = text.split('\n');
        const shown = hideSensitive(found, all.slice(-tailN).join('\n'));
        const input = found.name === 'Bash' ? found.input.command : JSON.stringify(found.input, null, 2);
        console.log(mask(`# #${n} ${found.name}${c.is_error ? ' (ошибка)' : ''}\n\n## Вход\n${input}\n\n## Результат${all.length > tailN ? ` (последние ${tailN} из ${all.length} строк)` : ''}\n${shown}`));
        return;
      }
    }
  }
  fail(found ? `У вызова #${n} нет результата в транскрипте` : `Вызова #${n} нет (всего ${i})`);
}

const { pos, opt } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = pos;
switch (cmd) {
  case 'root':
    if (!fs.existsSync(path.join(HOME, 'package.json')) || !fs.existsSync(path.join(HOME, 'src', 'schema.ts'))) {
      fail(`Не найден проект agentgraph в ${HOME} (задай AGENTGRAPH_HOME)`);
    }
    out({ root: HOME, flows: path.join(HOME, 'flows') });
    break;
  case 'list':
    list(opt);
    break;
  case 'digest':
    await digest(rest, opt);
    break;
  case 'tool':
    await tool(rest, opt);
    break;
  default:
    fail('Команды: root | list [--cwd DIR] [--limit N] | digest [ID|PATH] [--out FILE] [--max-kb N] [--skill NAME] [--no-cut] | tool [ID|PATH] N [--tail L]');
}
