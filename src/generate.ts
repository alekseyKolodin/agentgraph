// Генератор: описание задачи -> FlowSpec (через сессию без инструментов и structured output).
import fs from 'node:fs';
import { compactSpec, flowBlocks, flowJsonSchema, FlowSchema, GeneratedFlowSchema, isWriter, phaseSteps, type Block, type FlowSpec } from './schema.js';
import { runSession, type SessionResult } from './agent.js';
import { referencedPhases } from './template.js';
import { artifactProblems } from './artifacts.js';

/** Как оркестратор исполняет флоу: общее для генератора и редактора. */
export const ORCHESTRATOR_RULES = `How the orchestrator works:
- Each phase runs as a FRESH Claude Code session with no memory of other phases, with exactly the tools you list, inside the user's working directory.
- Phase sessions have no background tasks: Bash commands and subagents run in the foreground; a command runs up to 30 minutes by default and up to an hour with an explicit timeout, then it is killed. Never ask a phase to run something "in the background"; a process that must outlive the phase (an emulator, a dev server) is started detached with nohup ... &.
- Phases are grouped into blocks. Blocks run one after another. Inside a block, phases run in order, except adjacent phases with the same "group": they run at the same time, all see the same {{prev}} (the output before the group), and the phase after the group gets in {{prev}} their outputs joined in declaration order ("### name" + output each). If the block has a "loop", the whole sequence repeats until the block's stop condition holds or its max_iterations is reached. A block without "loop" runs once.
- When a looped block exhausts max_iterations without meeting its condition, the run stops (on_fail: "stop", the default) or moves on to the next block (on_fail: "continue").
- Phases pass information in two ways. Text goes through template variables in prompts ({{prev}}, {{phases.NAME}}, ...). Run artifacts are named text files of the run declared in the top-level "artifacts": created before the first phase, they survive iterations, blocks and a continuation of the run. Between steps the user can open an artifact in the UI, edit it and answer a pause into it; the next phase that reads it gets the edited file and is told that the last edit was the user's.`;

/** Правила проектирования этапов и условий: общее для генератора и редактора. */
export const DESIGN_RULES = `0. Blocks. Most tasks need exactly ONE block. Use several blocks only when the task has distinct stages that each must be finished before the next starts, each with its own done-criterion: e.g. "write a spec until the judge approves it" -> "split it into tasks once" -> "implement until tests pass". Do not split one retry loop into several blocks. Phase names must be unique across the whole flow.

1. Phases: as FEW as possible, by default ONE. Every phase is a fresh session that sees nothing of the previous one except the text it handed over, so each extra phase is a lossy hand-off: the next phase works from a retelling instead of what the previous one actually read and saw. A single phase with all the tools the task needs (reading, editing, running tests) plus the block's stop condition is the canonical shape; the model plans and sequences the work inside the session itself ("analyze, then implement, then verify" is ONE phase, not three). Add a phase only at a context boundary, i.e. when the next step must NOT share the previous one's context or cannot run in it:
   - independent verification or review: a read-only phase (no Edit/Write) after the implementing phase, so the reviewer judges the result without the implementer's reasoning and cannot be talked into its claims;
   - parallel independent work (a group, see rule 8): research of separate questions, reviews from different angles;
   - a step whose context would be too large to share: e.g. a long research or data-gathering step that must be condensed before implementation, or two tool sets that must not meet (web research vs. editing the repository);
   - a step that talks to the user (AskUserQuestion) and must finish before the rest starts.
   Never split by work type alone (analysis, planning, coding, testing) when the steps chain on each other's output and touch the same files: fold them into one phase. 1-3 phases per block is typical; more than 3 needs a context-boundary reason for every extra one.

2. Prompts are self-contained. A phase sees nothing except its prompt, so embed what it needs via variables:
   - {{input}} — the original task. Include it in EVERY phase prompt.
   - {{prev}} — the previous phase's full output. For the first phase on iteration 2+, it is the last phase's output of the previous iteration; for the first phase of a later block on iteration 1, it is the last output of the previous block.
   - {{phases.NAME}} — the latest output of phase NAME, from this or an earlier block.
   - {{feedback}} — what the block's stop condition reported after the previous iteration (test output, judge remarks). Empty on iteration 1 of every block. Include it in the first phase and in the implementation phase, with wording like "Если ниже есть замечания с прошлой итерации, начни с них: {{feedback}}".
   - {{iteration}} / {{max_iterations}} of the current block. {{history}} — every previous output of the run; large, use only when needed.
   - {{artifacts.KEY}} — the content of artifact KEY at the start of the step (a file over 32 KB comes as a map of its sections with a way to read any of them); {{artifacts.KEY.path}} — its absolute path. Either one gives the phase read access to the artifact (see rule 9).
   Put the hand-off contract into the phase's "handoff" field (not into the prompt): one or two sentences describing how the answer must end so the next phase can consume it, e.g. «раздел "## Результат": что найдено, файлы и строки, план правок». The orchestrator appends it to the prompt automatically.

3. Least-privilege tools. Every listed tool is auto-approved without prompts, so grant only what the phase needs:
   - the working phase (the default single phase: understands, implements and checks): ["Read", "Edit", "Write", "Grep", "Glob", "Bash"]; drop "Bash" only when the phase has nothing to build or run itself (e.g. the block's command condition runs the tests and the phase only edits text)
   - a separate review / verification phase (read-only, see rule 1): ["Read", "Grep", "Glob"], plus "Bash" when it must run builds or tests; when it must record results (a checklist, statuses of items), give it writes: [KEY] of that artifact instead of "Edit": writes lets it change only its artifacts, never the code it verifies
   - pure reasoning, writing, summarizing: []
   - web research: ["WebSearch", "WebFetch"]
   - the "Agent" (subagents) and "Skill" (skills) tools are added to every session automatically; do not list them. Subagents get only the phase's own tools.
   - Jira, Confluence or Slack from the user's claude.ai connectors: list the exact tools the phase calls, e.g. "mcp__claude_ai_Atlassian_Rovo__getJiraIssue"; "mcp__claude_ai_Atlassian_Rovo" grants the whole connector, including tools that change data, so use it only when the phase must also write there. A phase that lists none gets no connectors at all.
   - add "AskUserQuestion" to a phase only when the task is genuinely ambiguous and a human answer is worth a pause (the run blocks until the user answers).

4. Stop condition of a block (loop.until):
   - "command" when a deterministic check exists (test suite, build, linter, script). Exit code 0 ends the loop; the output becomes {{feedback}}. Prefer this whenever possible.
   - "judge" when success is qualitative: an LLM with read-only tools (Read/Grep/Glob) and subagents reads {{input}} and {{outputs}} (all outputs of the block's current iteration) and applies your rubric. Write the rubric so it answers done=true only when the whole task is complete and lists concrete gaps otherwise. The judge reads all artifacts, but completion is checked against the project's files and the results of commands, not against what an artifact or a phase output claims: a checklist ticked by a phase is that phase's claim, not proof. Say so in the rubric, and prefer "command" when a check can be run.
   - "marker" when the block's last phase is instructed to print a literal token such as <DONE> or <CONTINUE> as the very last line of its answer. Only the last non-empty line counts: say so in the prompt ("последней строкой ответа выведи ровно <DONE>").
   - "none" for fixed-count loops.
   max_iterations: 3-5 for coding tasks with a retry loop. Omit "loop" for a block that is a linear sequence of steps.

5. Write prompts in the same language as the user's task. Be specific: name commands, files or acceptance criteria the task implies. Do not invent facts about the repository; instruct the analysis phase to discover them.

6. Leave model and effort unset unless the user asked. Set max_turns (1-3) only for phases with no tools and no writes or reads of artifacts. A phase with access to artifacts gets tools to read them even with tools: [], and models do open the file instead of trusting the copy in the prompt; a phase that writes spends turns reading and editing. Leave max_turns of such phases unset or give them at least 5.

7. Set add_dirs only to directories the user explicitly named; never invent paths (a missing directory fails the run). Likewise, set a block's "knowledge" (list of knowledge-tag slugs the user keeps on the "Tags" page, e.g. [frontend, qa]) only to slugs the user named explicitly; never invent tags (a missing tag fails the run before the first phase). A knowledge tag reaches the phases as ONE line (what it is and when to consult it) plus the knowledge_read tool that returns its full notes, paths and attachments on demand, so do not retell a tag's content in prompts and do not add phases "to read the rules": the working phase consults the tag itself when relevant.

8. Parallel groups. Give adjacent phases of one block the same "group" only when they are independent of each other: e.g. reviews from different angles, research of separate questions, mostly read-only work. Rules: at least two phases per group; at most one phase with "Edit" or "Write" (parallel "Bash" builds or tests in one directory can also collide — avoid them; a phase that writes only artifacts via writes does not count); no "AskUserQuestion" in a group; a member must not reference another member via {{phases.NAME}}; at most one member writes a given artifact, and no member reads an artifact a sibling writes; the phase after the group consumes their joined outputs via {{prev}} or each one via {{phases.NAME}}. If a block with a "marker" condition ends with a group, set until.phase explicitly. A group of N phases spends N times faster; most flows need no groups.

9. Artifacts. By default a flow has none: a linear flow, or a loop where each phase needs only the previous output, works with {{prev}}. Declare an artifact when state must outlive one hand-off and the user may want to correct it mid-run: a plan that implementation follows over several iterations, a checklist of done and open items, decisions taken along the way. In {{prev}} such state lives only until the next phase and gets retold each time; an artifact keeps one current copy that phases read and update.
   - Declaration: top-level "artifacts": key -> {title?, file?, initial?, decisions?}. file is a bare name with extension md, txt, json, yaml or yml (default <key>.md, never CLAUDE.md); initial is the starting text, e.g. a heading or an empty checklist.
   - Access per phase: reads: [KEY] — the phase reads the artifact; writes: [KEY] — the phase edits it, which includes reading. Neither needs Read, Edit or Write in tools, and writes grants no access to the project's files. {{artifacts.KEY}} or {{artifacts.KEY.path}} in a prompt or handoff also gives read access.
   - Refer to the artifact, not to a phase's retelling of it: a phase that follows the plan gets {{artifacts.plan}}, not {{phases.analyze}}. A user's edit reaches the artifact but never a past phase output.
   - An artifact holds the current state, not a log: a phase that writes it updates or rewrites it so the file says how things are now — an open item stays one line (e.g. "- [ ] … (open since iteration N)"), a confirmed fix becomes "- [x]" in one line. Never tell phases to append per-iteration notes ("iteration N: still not fixed") — the runner keeps every version, and a log grows every later prompt that includes the artifact. The decisions artifact is the exception: answers are appended.
   - Content or path: give {{artifacts.KEY}} to a phase that must always see the artifact; give only {{artifacts.KEY.path}} for what a phase reads occasionally or what grows large (patches, logs, long lists) — it reads the file when needed. Keep bulky material such as a ready patch in its own artifact so phases that only need the summary do not carry it.
   - decisions: true marks at most one artifact where the user's answer to a pause (loop.pause_marker) is appended; phases that must follow the user's decisions read it.
   - The judge reads all artifacts and may use {{artifacts.KEY}} in its rubric (see rule 4 on what counts as proof).`;

export const GENERATOR_SYSTEM = `You design multi-phase agent workflows ("flows") that an orchestrator executes.

${ORCHESTRATOR_RULES}

Given the user's task, output a flow spec as JSON matching the schema. Rules:

${DESIGN_RULES}

10. "input" must contain the user's task verbatim. "name" is a short kebab-case slug.

In Russian "description" and "title" fields call the flow «flow» (Latin letters, never «флоу») and the steps «этапы» (never «фазы»).

Return only the JSON object.`;

export type GenerateOptions = {
  cwd: string;
  model?: string;
  abort?: AbortController;
};

export async function generateFlow(task: string, opts: GenerateOptions): Promise<{ spec: FlowSpec; result: SessionResult }> {
  const listing = describeDir(opts.cwd);
  const prompt = `Задача пользователя:\n<task>\n${task}\n</task>\n\nДиректория проекта: ${opts.cwd}\nВерхний уровень директории:\n${listing}\n\nСгенерируй flow spec.`;

  const result = await runSession(
    {
      prompt,
      cwd: opts.cwd,
      system: GENERATOR_SYSTEM,
      tools: [],
      model: opts.model,
      maxTurns: 3,
      outputSchema: flowJsonSchema(),
      persist: false,
      abort: opts.abort,
    },
    () => {},
  );

  const raw = result.structured ?? tryJson(result.text);
  if (!raw) {
    throw new Error(`Генератор не вернул спецификацию (${result.subtype}${result.errors.length ? ': ' + result.errors.join('; ') : ''})`);
  }
  const spec = compactSpec(FlowSchema.parse(GeneratedFlowSchema.parse(raw)));
  if (!spec.input) spec.input = task;
  validateReferences(spec);
  return { spec, result };
}

/**
 * Имена блоков и этапов уникальны; {{phases.X}} указывает на этап этого или более раннего блока
 * (этапы следующих блоков ещё не выполнялись, ссылка на них всегда пуста); контракт артефактов — artifactProblems.
 */
export function validateReferences(spec: FlowSpec): void {
  const blocks = flowBlocks(spec);
  const problems: string[] = [];
  const blockOf = new Map<string, number>();
  const blockNames = new Set<string>();
  blocks.forEach((b, bi) => {
    if (blockNames.has(b.name)) problems.push(`блок ${b.name} встречается дважды`);
    blockNames.add(b.name);
    for (const p of b.phases) {
      if (blockOf.has(p.name)) problems.push(`этап ${p.name} встречается дважды: имена этапов уникальны во всём flow`);
      else blockOf.set(p.name, bi);
    }
  });
  blocks.forEach((b, bi) => {
    const check = (where: string, tpl: string | undefined) => {
      for (const ref of referencedPhases(tpl ?? '')) {
        const at = blockOf.get(ref);
        if (at === undefined) problems.push(`${where}: неизвестный этап {{phases.${ref}}}`);
        else if (at > bi) problems.push(`${where}: {{phases.${ref}}} — этап из следующего блока ${blocks[at].name}, к этому моменту он ещё не выполнялся`);
      }
    };
    for (const p of b.phases) {
      check(`этап ${p.name}`, p.prompt);
      check(`этап ${p.name} (handoff)`, p.handoff);
    }
    const until = b.loop?.until;
    const where = blocks.length > 1 ? `блок ${b.name}, ` : '';
    if (until?.type === 'judge') check(`${where}судья`, until.prompt);
    if (until?.type === 'marker' && until.phase && !b.phases.some((p) => p.name === until.phase)) {
      problems.push(`${where}marker: этап ${until.phase} не из этого блока`);
    }
    // «последний этап блока» у группы — случайный участник: какой именно проверять, должен сказать автор
    if (until?.type === 'marker' && !until.phase && b.phases.at(-1)?.group) {
      problems.push(`${where}marker: блок кончается параллельной группой ${b.phases.at(-1)!.group}, укажи until.phase — вывод какого этапа проверять`);
    }
  });
  problems.push(...groupProblems(blocks));
  problems.push(...artifactProblems(spec));
  if (problems.length) throw new Error(problems.join('\n'));
}

/**
 * Параллельные группы: этапы группы идут подряд в одном блоке, их от двух, пишущий (Edit/Write) не больше одного,
 * без AskUserQuestion (два вопроса сразу UI и CLI не покажут) и без {{phases.<сосед>}}: участники идут одновременно,
 * и на итерации 2+ туда молча подставился бы вывод соседа с прошлой итерации.
 */
function groupProblems(blocks: Block[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    for (const step of phaseSteps(b)) {
      const g = step.group;
      if (!g) continue;
      if (seen.has(g)) {
        problems.push(`группа ${g}: её этапы должны идти подряд в одном блоке, а группа встречается в flow ещё раз`);
        continue;
      }
      seen.add(g);
      const phases = step.phases.map((x) => x.phase);
      const names = phases.map((p) => p.name);
      if (phases.length < 2) problems.push(`группа ${g}: в ней один этап ${names[0]} — добавь соседний этап с тем же group или убери group`);
      const writers = phases.filter(isWriter).map((p) => p.name);
      if (writers.length > 1) problems.push(`группа ${g}: пишущих этапов (Edit или Write) больше одного: ${writers.join(', ')}`);
      const asking = phases.filter((p) => p.tools.includes('AskUserQuestion')).map((p) => p.name);
      if (asking.length) problems.push(`группа ${g}: AskUserQuestion в параллельной группе не поддерживается: ${asking.join(', ')}`);
      for (const p of phases) {
        for (const [where, tpl] of [['', p.prompt], [' (handoff)', p.handoff]] as const) {
          for (const ref of referencedPhases(tpl ?? '')) {
            if (ref !== p.name && names.includes(ref)) {
              problems.push(`этап ${p.name}${where}: {{phases.${ref}}} — этап из той же группы ${g}, они идут одновременно`);
            }
          }
        }
      }
    }
  }
  return problems;
}

export function describeDir(dir: string): string {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, 60)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return entries.length ? entries.join('\n') : '(пусто)';
  } catch {
    return '(недоступно)';
  }
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
}
