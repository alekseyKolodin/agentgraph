// Teamwork: доверие к flow команды (spec §14). YAML flow лежит в общем репо команды, и пишет его любой с push, а запускается
// он на моём компьютере с моими правами. Поэтому flow команды запускается, только если это содержимое здесь одобрено: оно
// совпадает с шаблоном, который поставляет сам agentgraph (templates/teamwork/flows/), его сохранил я на вкладке «Процесс»
// или я одобрил его кнопкой «Доверять этой версии», посмотрев дифф. Одобрение — sha256 текста в trust.json рядом с
// local.json (teams/<slug>/trust.json): только мои данные, в репо не попадают, запись туда агентам закрыта guard'ом папки
// команд. Сверх доверия flow команде нельзя то, что открывает этот компьютер мимо границ agentgraph или ссылается на его
// локальные вещи: плагины, add_dirs, теги знаний, вызовы локальных flow, режимы разрешений без вопросов и инструменты вне
// списка KNOWN_TOOLS (MCP и коннекторы claude.ai) — такой flow не запускается и не сохраняется вовсе.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './safe-fs.js';
import { flowBlocks, IMPLICIT_TOOLS, isCallBlock, KNOWN_TOOLS, type FlowSpec, type Until } from './schema.js';
import { teamsDir } from './teamwork.js';
import type { TeamFlowTrust } from './api-types.js';

/** Файл одобренных версий flow команды в её папке (рядом с local.json и клоном repo/). */
export const TRUST_FILE = 'trust.json';
/** Папка flow в шаблоне команды (templates/teamwork/flows). */
export const TEMPLATE_FLOWS_DIR = 'flows';

/**
 * Одобренная версия flow: хэш, текст (база диффа для следующей версии), когда и как одобрена: trust — кнопкой, save —
 * сохранением на «Процессе», template — совпадала с шаблоном agentgraph (запоминается, чтобы новая версия шаблона после
 * обновления agentgraph не сделала нетронутый flow команды «чужим»).
 */
export type TrustedFlow = { sha256: string; yaml: string; at: string; via: 'trust' | 'save' | 'template' };
type TrustData = { flows: Record<string, TrustedFlow> };

/** Режимы разрешений, которые flow команды может задать: остальные снимают вопросы с чужого flow. */
const SAFE_MODES: readonly string[] = ['default', 'plan'];
/** Инструменты этапа, которые выносят агента за чтение: shell, запись файлов, сеть. Их список видит человек в диалоге. */
const RISKY_TOOLS: readonly string[] = ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'];
const ALLOWED_TOOLS: readonly string[] = [...KNOWN_TOOLS, ...IMPLICIT_TOOLS];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** sha256 текста flow. Переводы строк приводятся к \n: git с autocrlf не делает одобренную версию другой. */
export function flowHash(yaml: string): string {
  return createHash('sha256').update(yaml.replace(/\r\n/g, '\n')).digest('hex');
}

/** Шаблоны flow, которые поставляет agentgraph: имя → текст. Нет папки — пусто. */
export function templateFlows(templateDir: string): Map<string, string> {
  const dir = path.join(templateDir, TEMPLATE_FLOWS_DIR);
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names.sort()) {
    const m = n.match(/^([a-z0-9-]+)\.ya?ml$/);
    if (!m) continue;
    try {
      out.set(m[1], fs.readFileSync(path.join(dir, n), 'utf8'));
    } catch {
      // нечитаемый шаблон не одобряет ничего
    }
  }
  return out;
}

function readTrust(teamDir: string): TrustData {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(teamDir, TRUST_FILE), 'utf8'));
  } catch {
    return { flows: {} };
  }
  const flows: Record<string, TrustedFlow> = Object.create(null) as Record<string, TrustedFlow>;
  const src = isRecord(raw) && isRecord(raw.flows) ? raw.flows : {};
  for (const [name, v] of Object.entries(src)) {
    if (!isRecord(v) || typeof v.sha256 !== 'string' || typeof v.yaml !== 'string') continue;
    flows[name] = { sha256: v.sha256, yaml: v.yaml, at: typeof v.at === 'string' ? v.at : '', via: v.via === 'save' || v.via === 'template' ? v.via : 'trust' };
  }
  return { flows };
}

/** Последняя одобренная здесь версия flow; нет — undefined. */
export function trustedFlow(teamDir: string, name: string): TrustedFlow | undefined {
  return readTrust(teamDir).flows[name];
}

/** Одобрить это содержимое flow на этом компьютере (кнопка «Доверять» или сохранение на вкладке «Процесс»). */
export function trustFlow(teamDir: string, name: string, yaml: string, via: TrustedFlow['via'], now = new Date()): TrustedFlow {
  const data = readTrust(teamDir);
  const rec: TrustedFlow = { sha256: flowHash(yaml), yaml, at: now.toISOString(), via };
  data.flows[name] = rec;
  fs.mkdirSync(teamDir, { recursive: true });
  writeAtomic(path.join(teamDir, TRUST_FILE), JSON.stringify(data, null, 2) + '\n');
  return rec;
}

/**
 * Что flow команде нельзя (spec §14), по строке на нарушение; пусто — можно. Всё это или ссылается на вещи этого
 * компьютера, которых автор flow не знает (плагины, add_dirs, теги знаний, локальные flow), или снимает с чужого flow
 * границы agentgraph (режимы без вопросов; инструменты вне KNOWN_TOOLS — MCP и коннекторы claude.ai, они разрешились бы
 * без вопроса). Одобрение этого не снимает: такой flow не запускается и не сохраняется как flow команды.
 */
export function teamFlowProblems(spec: FlowSpec): string[] {
  const out: string[] = [];
  const mode = (at: string, m: string | undefined) => {
    if (m && !SAFE_MODES.includes(m)) out.push(`${at}: permission_mode ${m} — flow команды работает только в ${SAFE_MODES.join(' или ')}`);
  };
  mode('defaults', spec.defaults?.permission_mode);
  for (const b of flowBlocks(spec)) {
    const at = spec.blocks ? `блок ${b.name}` : 'flow';
    if (isCallBlock(b)) {
      out.push(`${at}: вызов flow ${b.flow} — flow команды не зовёт flow этого компьютера`);
      continue;
    }
    if (b.plugins?.length) out.push(`${at}: plugins — плагины этого компьютера flow команде не даются`);
    if (b.knowledge?.length) out.push(`${at}: knowledge — теги знаний этого компьютера flow команде не даются`);
    for (const p of b.phases) {
      const ph = `этап ${p.name}`;
      if (p.add_dirs?.length) out.push(`${ph}: add_dirs — папки этого компьютера flow команде не даются, папки проекта и репо кода agentgraph добавит сам`);
      if (p.plugins?.length) out.push(`${ph}: plugins — плагины этого компьютера flow команде не даются`);
      mode(ph, p.permission_mode);
      const unknown = p.tools.filter((t) => !ALLOWED_TOOLS.includes(t));
      if (unknown.length) out.push(`${ph}: инструменты ${unknown.join(', ')} — flow команды получает только ${KNOWN_TOOLS.join(', ')}`);
    }
  }
  return out;
}

/** Невидимый или управляющий символ: им одна строка в диалоге доверия выглядит иначе, чем выполнится (bidi, zero-width, одинокий \r). */
const INVISIBLE_RE = /[\p{Cf}\p{Cc}]/u;

/**
 * Невидимые и управляющие символы в тексте flow команды (кроме табуляции, перевода строки, CRLF и BOM в начале файла):
 * bidi-переключатели и zero-width показали бы в диалоге доверия одно, а выполнили другое; одинокий \r YAML считает
 * переводом строки, а дифф — нет. Такой flow команде нельзя, как и teamFlowProblems.
 */
export function teamFlowTextProblems(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = (i === 0 ? raw.replace(/^\uFEFF/, '') : raw).replace(/\r$/, '');
    const bad = [...new Set([...line].filter((c) => c !== '\t' && INVISIBLE_RE.test(c)))];
    if (!bad.length) continue;
    const codes = bad.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(', ');
    out.push(`строка ${i + 1}: невидимые символы ${codes} — в диалоге доверия текст выглядел бы не так, как выполнится`);
    if (out.length >= 5) break;
  }
  return out;
}

/** Что flow сможет на этом компьютере (для диалога доверия): shell-команды условий и инструменты этапов с shell, записью и сетью. */
export function flowCapabilities(spec: FlowSpec): { commands: string[]; tools: string[] } {
  const commands = new Set<string>();
  const tools = new Set<string>();
  const cond = (c: Until | undefined) => {
    if (c?.type === 'command' && c.run.trim()) commands.add(c.run.trim());
  };
  for (const b of flowBlocks(spec)) {
    cond(b.loop?.until);
    if (Array.isArray(b.next)) for (const r of b.next) cond(r.if);
    for (const p of b.phases) for (const t of p.tools) if (RISKY_TOOLS.includes(t)) tools.add(t);
  }
  return { commands: [...commands], tools: RISKY_TOOLS.filter((t) => tools.has(t)) };
}

/**
 * Доверие к содержимому flow команды: одобрено (шаблон agentgraph с любым именем, последняя одобренная здесь версия) —
 * undefined; иначе — что показать человеку: YAML, база диффа (одобренная версия, иначе шаблон с тем же именем) и
 * возможности flow.
 */
export function untrustedFlow(o: { teamDir: string; templateDir: string; team: string; name: string; yaml: string; spec: FlowSpec }): TeamFlowTrust | undefined {
  const hash = flowHash(o.yaml);
  const templates = templateFlows(o.templateDir);
  const trusted = trustedFlow(o.teamDir, o.name);
  if ([...templates.values()].some((t) => flowHash(t) === hash)) {
    // запомнить: после обновления agentgraph с новым шаблоном этот, нетронутый, flow останется одобренным
    if (trusted?.sha256 !== hash) {
      try {
        trustFlow(o.teamDir, o.name, o.yaml, 'template');
      } catch {
        // не записалось — одобрен и так, пока шаблон тот же
      }
    }
    return undefined;
  }
  if (trusted?.sha256 === hash) return undefined;
  const template = templates.get(o.name);
  // запомненная версия шаблона — для человека это «шаблон», а не версия, которую он одобрял
  const base: TeamFlowTrust['base'] = trusted
    ? trusted.via === 'template'
      ? { kind: 'template', yaml: trusted.yaml }
      : { kind: 'trusted', yaml: trusted.yaml, ...(trusted.at ? { at: trusted.at } : {}) }
    : template !== undefined
      ? { kind: 'template', yaml: template }
      : undefined;
  return { team: o.team, name: o.name, hash, yaml: o.yaml, ...(base ? { base } : {}), ...flowCapabilities(o.spec) };
}

/**
 * Папка внутри папки команд (клоны репо команд, spec §14): сессия Claude Code с такой рабочей папкой загрузила бы её
 * .claude/settings.json (хуки, разрешения, MCP из .mcp.json), а их пишут участники команды. Сравнение — по пути как есть и
 * по realpath, без учёта регистра (папка данных agentgraph на томе, который регистр может не различать).
 */
export function insideTeamsDir(dir: string, root = teamsDir()): boolean {
  const fold = (p: string) => p.normalize('NFC').toLowerCase();
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const d = path.resolve(dir);
  const r = path.resolve(root);
  const within = (x: string, y: string) => x === y || x.startsWith(y.endsWith(path.sep) ? y : y + path.sep);
  return [d, real(d)].some((x) => [r, real(r)].some((y) => within(fold(x), fold(y))));
}

/** Текст отказа для рабочей папки внутри папки команд; снаружи — undefined. */
export function teamsCwdProblem(dir: string): string | undefined {
  if (!insideTeamsDir(dir)) return undefined;
  return `${dir} — внутри папки команд Teamwork: агент в клоне репо команды не запускается, его .claude/ и .mcp.json пишут участники команды. Выбери папку репо кода`;
}

/**
 * Папка из клона команды как дополнительная папка агента (папка проекта): Claude Code подхватывает из доп. папки
 * CLAUDE.md, а из её .claude/ — скиллы (.claude/skills, в том числе с командами shell), сабагентов (.claude/agents),
 * правила и включённые плагины (enabledPlugins в .claude/settings*.json). Их пишут участники команды мимо доверия к
 * flow, поэтому папку с .claude/ агенту не даём; CLAUDE.md проекта — описанный в шаблоне способ задать правила, он
 * остаётся. Папка вне папки команд — undefined.
 */
export function teamsAddDirProblem(dir: string): string | undefined {
  if (!insideTeamsDir(dir)) return undefined;
  const found = findClaudeDir(dir);
  if (!found) return undefined;
  if (found === TOO_MANY) return `В ${dir} (репо команды) слишком много файлов, чтобы проверить, нет ли в ней папки .claude/: агенту её не даём`;
  return `В ${found} (репо команды) есть папка .claude/: агент подхватил бы из неё скиллы, сабагентов и плагины, а пишут их участники команды. Уберите .claude/ из репо команды — правила проекта задают в CLAUDE.md`;
}

const TOO_MANY = '\0too-many';
/** Лимит обхода папки проекта: папка проекта — документы, задачи, спринты, комментарии; больше — не проверяем, а отказываем. */
const WALK_MAX = 20_000;

/**
 * Папка .claude (в любом регистре: том может его не различать) на любой глубине: Claude Code находит вложенные
 * .claude/skills, когда агент читает файлы в подпапках. Ссылки не обходятся (клон — с core.symlinks=false).
 */
function findClaudeDir(root: string): string | undefined {
  const queue = [root];
  let seen = 0;
  while (queue.length) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_MAX) return TOO_MANY;
      const p = path.join(dir, e.name);
      if (e.name.toLowerCase() === '.claude') return dir;
      if (e.isDirectory() && e.name !== '.git') queue.push(p);
    }
  }
  return undefined;
}
