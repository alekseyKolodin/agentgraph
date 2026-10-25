// Мини-шаблонизатор: {{input}}, {{prev}}, {{feedback}}, {{iteration}}, {{max_iterations}},
// {{outputs}}, {{history}}, {{phases.NAME}}, {{artifacts.KEY}}, {{artifacts.KEY.path}}. Один проход, значения не рендерятся повторно.
export type TemplateContext = {
  input: string;
  prev: string;
  feedback: string;
  iteration: number;
  max_iterations: number;
  outputs: string;
  history: string;
  phases: Record<string, string>;
  /** Артефакты запуска на старте шага: text — подстановка содержимого, path — абсолютный путь. Без них {{artifacts.*}} не трогаются. */
  artifacts?: Record<string, { text: string; path: string }>;
};

export function emptyContext(input: string, maxIterations: number): TemplateContext {
  return { input, prev: '', feedback: '', iteration: 0, max_iterations: maxIterations, outputs: '', history: '', phases: {} };
}

export function render(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => {
    if (key.startsWith('phases.')) return ctx.phases[key.slice('phases.'.length)] ?? '';
    if (key.startsWith('artifacts.')) return renderArtifact(match, key.slice('artifacts.'.length), ctx);
    switch (key) {
      case 'input': return ctx.input;
      case 'prev': return ctx.prev;
      case 'feedback': return ctx.feedback;
      case 'iteration': return String(ctx.iteration);
      case 'max_iterations': return String(ctx.max_iterations);
      case 'outputs': return ctx.outputs;
      case 'history': return ctx.history;
      default: return match;
    }
  });
}

/** {{artifacts.KEY}} и {{artifacts.KEY.path}}; без артефактов в контексте или с неизвестным ключом плейсхолдер остаётся как есть. */
function renderArtifact(match: string, ref: string, ctx: TemplateContext): string {
  const m = ref.match(ARTIFACT_REF_RE);
  const a = m && ctx.artifacts && Object.hasOwn(ctx.artifacts, m[1]) ? ctx.artifacts[m[1]] : undefined;
  if (!m || !a) return match;
  return m[2] ? a.path : a.text;
}

const ARTIFACT_REF_RE = /^([a-zA-Z0-9_-]+)(\.path)?$/;

/** Переменные, которые встречаются в шаблоне (для валидации ссылок на фазы). */
export function referencedPhases(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*phases\.([a-zA-Z0-9_-]+)\s*\}\}/g)) out.add(m[1]);
  return [...out];
}

/** Артефакты, на которые ссылается шаблон: content — ключи {{artifacts.KEY}}, path — ключи {{artifacts.KEY.path}}. */
export function referencedArtifacts(template: string): { content: string[]; path: string[] } {
  const content = new Set<string>();
  const paths = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*artifacts\.([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
    const r = m[1].match(ARTIFACT_REF_RE);
    // {{artifacts.a.b}} — не артефакт и не путь: валидация называет его неизвестным ключом целиком
    if (!r) content.add(m[1]);
    else (r[2] ? paths : content).add(r[1]);
  }
  return { content: [...content], path: [...paths] };
}
