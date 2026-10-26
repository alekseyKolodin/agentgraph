// Редактор: флоу + описание правки -> новый FlowSpec. Агент правит flow.yaml во временной папке
// инструментом Edit, поэтому то, о чём не просили, остаётся байт в байт, а не пересказывается при перегенерации.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify as toYaml } from 'yaml';
import { compactSpec, KNOWN_TOOLS, type FlowSpec } from './schema.js';
import { CLAUDEAI_TOOL_PREFIX, runSession, type SessionResult } from './agent.js';
import { describeDir, DESIGN_RULES, ORCHESTRATOR_RULES } from './generate.js';
import { flowToYaml, parseFlow, validateSpec } from './flows.js';

export const EDITOR_SYSTEM = `You edit multi-phase agent workflows ("flows") that an orchestrator executes. The flow is a YAML file; you change it in place with the Edit tool, the way you would make a careful code change.

${ORCHESTRATOR_RULES}

File format. The server validates the file after you and normalizes it, so both forms below are fine:
- Top level: name, description?, input?, defaults? {model?, effort?, max_turns?, permission_mode?, max_budget_usd?}, artifacts?, then EITHER the short form "loop?" + "phases" (a single block) OR "blocks". Never both. To add a second block to a short-form flow, convert it: the existing loop and phases become blocks[0] (name: main), unchanged except for indentation, and the new block goes after it.
- Block: name (slug [a-z0-9_-]), title?, loop? {max_iterations: 1-50, until}, on_fail? (stop | continue), plugins? (local Claude Code plugin folders for every phase of the block, like --plugin-dir; keep them as the user wrote them, never invent — a missing folder fails the run), knowledge? (list of knowledge tag slugs from the user's "Tags" page: every phase of the block gets one line per tag and the knowledge_read tool to fetch its notes, paths and attachments on demand; keep them as the user wrote them, never invent — a missing tag fails the run), phases (at least one).
- until: {type: command, run, timeout_sec?} | {type: judge, prompt, model?} | {type: marker, marker, phase?} | {type: none}.
- Phase: name (slug [a-z0-9_-], unique across the whole flow), title?, prompt, handoff?, tools (required list; [] = no tools; any of ${KNOWN_TOOLS.join(', ')}, plus tools of the user's claude.ai connectors named ${CLAUDEAI_TOOL_PREFIX}<Connector>__<tool>, or ${CLAUDEAI_TOOL_PREFIX}<Connector> for the whole connector including tools that change data — keep the ones a phase already has, add them only when the request asks for Jira, Confluence or Slack; also keep plugin MCP tool names (mcp__plugin_<plugin>_<server>__<tool>) a phase already has; Agent and Skill are added automatically, never list them), add_dirs? (extra directories the phase may access besides the working dir, like --add-dir: absolute, ~ or relative to the working dir; their CLAUDE.md and skills are loaded — keep them as the user wrote them), plugins? (local Claude Code plugin folders only this phase gets, like --plugin-dir: absolute, ~ or relative to the working dir; the plugin brings its skills, agents, hooks and MCP servers; keep them as the user wrote them, never invent — a missing folder fails the run), system?, model?, effort? (low | medium | high | xhigh | max), max_turns?, permission_mode? (default | acceptEdits | bypassPermissions | dontAsk | plan | auto), max_budget_usd?, output_schema? (JSON Schema object), group? (slug [a-z0-9_-]; adjacent phases of one block with the same group run in parallel, see design rule 8 below), reads? (list of artifact keys the phase reads), writes? (list of artifact keys the phase edits; includes reading).
- artifacts: a map key -> {title?, file?, initial?, decisions?}. Key: [a-zA-Z0-9_-]. file: a bare file name (no directories) with extension md, txt, json, yaml or yml, unique ignoring case, never CLAUDE.md or CLAUDE.local.md; default <key>.md. initial: starting text as is. decisions: true marks the one artifact where the user's answers to pauses are appended. Artifacts are files of the run that survive iterations and blocks; the user can edit them between steps. A phase gets read access to an artifact via reads, writes or {{artifacts.KEY}} / {{artifacts.KEY.path}} in its prompt or handoff, and write access only via writes (no Edit or Write in tools is needed for that). In a parallel group two members never write the same artifact, and a member never reads an artifact a sibling writes. The judge reads all artifacts and may use {{artifacts.KEY}} in its rubric. Keep artifacts, reads and writes exactly as they are unless the request is about them; when you rename or remove an artifact key, update every reads, writes and {{artifacts.KEY}} that refers to it.

How to edit:
1. Read the file, then change only what the request asks for. Every prompt, rubric and field the request does not touch stays byte-for-byte as it is: do not rephrase, reformat, reorder, translate or "improve" it. Prefer several small Edit calls over rewriting large parts; use Write only if most of the file has to change.
2. Do not rename phases or blocks unless asked: names are referenced by {{phases.NAME}}, until.phase and past runs. If a rename is asked for, update every reference to it.
3. Keep "name". Change "input" or "description" only when the request asks for it or changes what the flow is for.
4. When you add, remove or move a phase, fix what depends on it: {{prev}} and {{phases.NAME}} in neighbouring prompts, handoff contracts, judge rubrics, until.phase. Keep the phases of a group adjacent within one block (a phase moved out of its group or to another block loses "group"), and never introduce {{phases.NAME}} between members of one group.
5. Keep the YAML valid: block scalars (|, |-, >) and their indentation, quoting of strings that contain ": " or start with special characters.
6. New prompts are written in the language of the existing flow.
7. If the request is unclear or cannot be expressed in this format, change nothing and say why.
8. Your final message is shown to the user as the summary of the edit: a short bulleted list in the language of the request, naming the phases and blocks you changed and how. When the summary is in Russian, call phases «этапы» and flows «flow» (never «фазы» or «флоу»); the stop condition is «условие». No preamble.

Design rules for the parts you add or rewrite. Existing parts the request does not touch stay as they are, even if they break these rules:

${DESIGN_RULES}`;

export type EditBase = {
  yaml: string;
  /** Ошибки валидации исходного флоу: агент чинит их вместе с правкой. */
  problems?: string;
};

export type EditOptions = {
  /** Рабочая директория агентов флоу: редактор видит её верхний уровень. */
  cwd?: string;
  model?: string;
  abort?: AbortController;
};

export type EditResult = {
  spec: FlowSpec;
  /** Текст файла после правки (комментарии и форматирование сохраняются). */
  yaml: string;
  /** Что поменял агент, его словами. */
  summary: string;
  changed: boolean;
  costUsd: number;
};

const FILE = 'flow.yaml';
const MAX_REPAIRS = 2;

/**
 * База правки: spec из конструктора (с несохранёнными изменениями) или YAML-текст.
 * Валидный spec нормализуется так же, как при сохранении; невалидная база уходит как есть вместе с ошибками.
 */
export function editBase(name: string, base: { spec?: unknown; yaml?: string }): EditBase {
  if (base.spec && typeof base.spec === 'object') {
    const raw = { ...(base.spec as object), name };
    try {
      return { yaml: flowToYaml(compactSpec(validateSpec(raw))) };
    } catch (err) {
      return { yaml: toYaml(raw, { lineWidth: 0 }), problems: errMsg(err) };
    }
  }
  const yaml = base.yaml ?? '';
  try {
    parseFlow(yaml);
    return { yaml };
  } catch (err) {
    return { yaml, problems: errMsg(err) };
  }
}

export async function editFlow(name: string, instruction: string, base: EditBase, opts: EditOptions = {}): Promise<EditResult> {
  // realpath: на macOS tmpdir — симлинк /var -> /private/var, а агенту нужен настоящий путь
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-edit-')));
  const file = path.join(dir, FILE);
  fs.writeFileSync(file, base.yaml);
  let costUsd = 0;
  const session = async (prompt: string): Promise<SessionResult> => {
    const r = await runSession(
      {
        prompt,
        cwd: dir,
        system: EDITOR_SYSTEM,
        tools: ['Read', 'Edit', 'Write'],
        model: opts.model,
        maxTurns: 40,
        persist: false,
        abort: opts.abort,
      },
      () => {},
    );
    costUsd += r.costUsd;
    if (opts.abort?.signal.aborted) throw new Error('Правка прервана');
    if (!r.ok) throw new Error(`Редактор не справился (${r.subtype}${r.errors.length ? ': ' + r.errors.join('; ') : ''})`);
    return r;
  };
  const request = `<request>\n${instruction}\n</request>`;

  try {
    const broken = base.problems ? `\n\nСейчас flow не проходит валидацию, исправь заодно и это:\n<errors>\n${base.problems}\n</errors>` : '';
    const context = opts.cwd ? `\n\nДиректория проекта: ${opts.cwd}\nВерхний уровень директории:\n${describeDir(opts.cwd)}` : '';
    const first = await session(`Flow «${name}» лежит в файле ${file}. Измени его по запросу пользователя:\n${request}${broken}${context}`);

    let yaml = fs.readFileSync(file, 'utf8');
    let spec: FlowSpec;
    for (let attempt = 0; ; attempt++) {
      try {
        spec = parseFlow(yaml);
        break;
      } catch (err) {
        if (attempt >= MAX_REPAIRS) throw new Error(`После правки flow не проходит валидацию:\n${errMsg(err)}`);
        await session(
          `После правки файл ${file} не проходит валидацию:\n<errors>\n${errMsg(err)}\n</errors>\n` +
            `Исправь только эти ошибки, остальное не трогай. Исходный запрос пользователя:\n${request}`,
        );
        yaml = fs.readFileSync(file, 'utf8');
      }
    }
    // имя флоу = имя файла; переименование — отдельная операция, не правка содержимого
    if (spec.name !== name) {
      spec = { ...spec, name };
      yaml = flowToYaml(compactSpec(spec));
    }
    return { spec: compactSpec(spec), yaml, summary: first.text.trim(), changed: yaml !== base.yaml, costUsd };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
