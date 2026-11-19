// Маршруты /api/routines (SPEC §3) в стиле integrationsRoute: (method, url, readBody) → Reply или undefined.
// Проверки Host/Origin/типа тела уже сделал server-guard в handle(). Ключи наружу не уходят: только имена недостающих.
import type { DraftRoutes, Recipe } from './kind.js';
import { RoutineError, type RoutineEngine } from './engine.js';
import { assertSlug, freeSlug, parseSourceYaml, SLUG_RE } from './schema.js';
import { getMcpServers, type McpServer } from '../connectors.js';
import { createConnectorBuilds, mcpServices, type ConnectorBuilds } from './sources/connector.js';
import { draftRoutes, loadRecipes } from './sources/index.js';
import { ensureTemplateFlow, flowTemplates, NoFlowTemplate } from './flow-templates.js';
import { createComposeRoutes, type ComposeContext, type ComposeRoutes } from './compose.js';
import { createRoutineAssistant, type RoutineAssistant } from './assistant.js';
import { AssistantBusy } from '../assistant.js';
import { checkDir } from './dir-check.js';
import { listFlows } from '../flows.js';
import { listSpaces } from '../spaces.js';
import type { LogOutcome, McpServicesView, WaitAction } from './types.js';

export type Reply = { status: number; body: unknown };

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const bad = (error: string, status = 400, extra?: Record<string, unknown>): Reply => ({ status, body: { error, ...extra } });

/** Слаги, занятые разделами API: рутина с таким именем не открылась бы. */
export const RESERVED = new Set(['sources', 'recipes', 'waits', 'catchup', 'mcp-tools', 'flow-templates', 'compose', 'check-dir', 'form-draft', 'assistant', 'assistant-draft']);

const OUTCOMES: LogOutcome[] = ['started', 'waiting', 'filtered', 'check_no', 'duplicate', 'limit', 'rejected', 'missed', 'task', 'error'];

export type RoutinesRouteDeps = {
  engine: RoutineEngine;
  /** Подключение словами; по умолчанию draftRoutes() видов. null (или draftRoutes вернул undefined) — 501. */
  drafts?: DraftRoutes | null;
  /** Рутина по описанию словами; по умолчанию — сессия модели над источниками, flow и пространствами человека. null — 501. */
  compose?: ComposeRoutes | null;
  /** Проверка папки («Папка проекта» в форме); по умолчанию — настоящая, через git. */
  checkDir?: typeof checkDir;
  /** MCP-серверы для источника «Сервис через Claude»; по умолчанию getMcpServers (процесс Claude Code без модели). */
  mcpServers?: (force: boolean) => Promise<{ servers: McpServer[]; at: string }>;
  /** Сборка скрипта «Сервиса через Claude»; по умолчанию — сессия модели и проверка источника движком. */
  builds?: ConnectorBuilds;
  /** Помощник раздела (docs/ASSISTANTS.md); по умолчанию — сессия модели с инструментами раздела. null — 501. */
  assistant?: RoutineAssistant | null;
  /** Папка сервера по умолчанию: в ней помощник собирает flow, если человек не назвал свою. */
  defaultCwd?: string;
};

const buildCache = new WeakMap<RoutineEngine, ConnectorBuilds>();
function builds(deps: RoutinesRouteDeps): ConnectorBuilds {
  if (deps.builds) return deps.builds;
  let b = buildCache.get(deps.engine);
  if (!b) {
    b = createConnectorBuilds({ testSource: (spec) => deps.engine.testSource(spec) });
    buildCache.set(deps.engine, b);
  }
  return b;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function secretsOf(v: unknown): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  const o = obj(v);
  return Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** Подключение словами создаётся один раз на движок: черновики живут между запросами. */
const draftCache = new WeakMap<RoutineEngine, DraftRoutes | null>();
function drafts(deps: RoutinesRouteDeps): DraftRoutes | undefined {
  if (deps.drafts !== undefined) return deps.drafts ?? undefined;
  let d = draftCache.get(deps.engine);
  if (d === undefined) {
    d = draftRoutes(deps.engine.draftDeps()) ?? null;
    draftCache.set(deps.engine, d);
  }
  return d ?? undefined;
}

/** Что модель видит о человеке при сборке рутины словами: имена и описания, без ключей и настроек источников. */
export function composeContext(engine: RoutineEngine): ComposeContext {
  const kinds = engine.kindViews();
  const flows = listFlows().flatMap((f) => (f.valid ? [{ name: f.name, ...(f.description ? { description: f.description } : {}), blocks: (f.blocks ?? []).map((b) => b.name) }] : []));
  let spaces: ComposeContext['spaces'] = [];
  try {
    spaces = listSpaces().map((x) => ({ slug: x.slug, ...(x.title ? { title: x.title } : {}), ...(x.cwd ? { cwd: x.cwd } : {}) }));
  } catch {
    /* пространства недоступны — рутина обойдётся без них */
  }
  return {
    sources: engine.sourceViews().map((s) => ({ slug: s.slug, title: s.spec.title, kind: s.spec.kind, ...(s.spec.description ? { description: s.spec.description } : {}), canReply: s.canReply })),
    kinds: kinds.filter((k) => k.kind !== 'command').map((k) => ({ kind: k.kind, title: k.title, summary: k.summary, match: k.match, canReply: k.canReply })),
    flows,
    spaces,
  };
}

const composeCache = new WeakMap<RoutineEngine, ComposeRoutes>();
function compose(deps: RoutinesRouteDeps): ComposeRoutes | undefined {
  if (deps.compose !== undefined) return deps.compose ?? undefined;
  let c = composeCache.get(deps.engine);
  if (!c) {
    c = createComposeRoutes({ context: () => composeContext(deps.engine), ...(deps.checkDir ? { dir: (p: string) => deps.checkDir!(p) } : {}) });
    composeCache.set(deps.engine, c);
  }
  return c;
}

const assistantCache = new WeakMap<RoutineEngine, RoutineAssistant>();
function assistant(deps: RoutinesRouteDeps): RoutineAssistant | undefined {
  if (deps.assistant !== undefined) return deps.assistant ?? undefined;
  let a = assistantCache.get(deps.engine);
  if (!a) {
    a = createRoutineAssistant({
      engine: deps.engine,
      context: () => composeContext(deps.engine),
      mcpServers: deps.mcpServers ?? getMcpServers,
      builds: builds(deps),
      checkDir: (p) => (deps.checkDir ?? checkDir)(p),
      defaultCwd: deps.defaultCwd ?? process.cwd(),
    });
    assistantCache.set(deps.engine, a);
  }
  return a;
}

/** Рецепты: готовые (виды) и импортированные в ~/.agentgraph/recipes; поле file наружу не уходит. */
function recipes(engine: RoutineEngine): Omit<Recipe, 'file'>[] {
  const out = new Map<string, Omit<Recipe, 'file'>>();
  let builtin: Recipe[] = [];
  try {
    builtin = loadRecipes();
  } catch {
    /* битые рецепты видов не мешают своим */
  }
  for (const r of builtin) out.set(r.id, { id: r.id, spec: r.spec, summary: r.summary });
  for (const f of engine.store.recipes()) {
    if (!f.spec || out.has(f.slug)) continue;
    out.set(f.slug, { id: f.slug, spec: f.spec, summary: f.spec.description ?? f.spec.title });
  }
  return [...out.values()];
}

export async function routinesRoute(method: string, url: URL, readBody: () => Promise<unknown>, deps: RoutinesRouteDeps): Promise<Reply | undefined> {
  const p = url.pathname;
  if (p !== '/api/routines' && !p.startsWith('/api/routines/')) return undefined;
  const { engine } = deps;
  let m: RegExpMatchArray | null;
  try {
    if (method === 'GET' && p === '/api/routines') return ok(engine.overview());

    // --- источники
    if (p === '/api/routines/sources' && method === 'GET') return ok(engine.sourceViews());
    if (p === '/api/routines/sources/test' && method === 'POST') {
      const b = obj(await readBody());
      return ok(await engine.testSource(b.spec, secretsOf(b.secrets)));
    }

    // --- «Сервис через Claude»: модель один раз собирает скрипт, agentgraph прогоняет его без модели
    if (p === '/api/routines/sources/connector-build' && method === 'POST') {
      const b = obj(await readBody());
      const tools = Array.isArray(b.tools) ? b.tools.filter((x): x is string => typeof x === 'string') : [];
      const request = typeof b.request === 'string' ? b.request.trim().slice(0, 4000) : '';
      if (!tools.length) return bad('Выбери хотя бы один сервис');
      if (!request) return bad('Напиши словами, что нужно');
      const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 4000) : undefined);
      try {
        return ok(builds(deps).start({ tools, request, title: str(b.title), note: str(b.note), from: str(b.from) }), 201);
      } catch (e) {
        return bad((e as Error).message);
      }
    }
    if ((m = p.match(/^\/api\/routines\/sources\/connector-build\/([A-Za-z0-9_-]+)$/)) && method === 'GET') return found(builds(deps).get(m[1]), 'Сборка не найдена');

    // --- готовые flow шаблонов рутин (templates/flows): список и копия к flow пользователя, если такого ещё нет
    if (p === '/api/routines/flow-templates' && method === 'GET') return ok(flowTemplates());
    if ((m = p.match(/^\/api\/routines\/flow-templates\/([a-z0-9-]+)$/)) && method === 'POST') {
      try {
        const r = ensureTemplateFlow(m[1]);
        return ok({ flow: r.flow, copied: r.copied });
      } catch (e) {
        return bad((e as Error).message, e instanceof NoFlowTemplate ? 404 : 500);
      }
    }

    // --- черновик формы «Новая рутина»: лежит на сервере, уход с экрана его не стирает
    if (p === '/api/routines/form-draft') {
      if (method === 'GET') return ok({ draft: engine.formDraft() });
      if (method === 'PUT') return ok(engine.saveFormDraft(obj(await readBody()).data));
      if (method === 'DELETE') {
        engine.dropFormDraft();
        return ok({ ok: true });
      }
      return undefined;
    }

    // --- папка проекта: есть ли, git ли (форма «Новой рутины» говорит словами до первого запуска)
    if (p === '/api/routines/check-dir' && method === 'GET') {
      const dir = url.searchParams.get('path')?.trim() ?? '';
      if (!dir) return bad('Нужен путь к папке');
      return ok(await (deps.checkDir ?? checkDir)(dir.slice(0, 1000)));
    }

    // --- рутина по описанию словами: модель собирает черновик, ничего не сохраняется
    if (p === '/api/routines/compose' || p.startsWith('/api/routines/compose/')) {
      const c = compose(deps);
      if (!c) return bad('Сборка рутины словами пока недоступна', 501);
      if (p === '/api/routines/compose' && method === 'POST') {
        const b = obj(await readBody());
        const description = typeof b.description === 'string' ? b.description.trim() : '';
        if (!description) return bad('Опиши словами, что рутина должна делать');
        const model = typeof b.model === 'string' ? b.model.trim().slice(0, 100) : '';
        return ok(c.start(description.slice(0, 4000), model || undefined), 201);
      }
      if ((m = p.match(/^\/api\/routines\/compose\/([A-Za-z0-9_-]+)$/))) {
        if (method === 'GET') return found(c.get(m[1]), 'Черновик не найден');
        if (method === 'DELETE') {
          c.cancel(m[1]);
          return ok({ ok: true });
        }
      }
      return undefined;
    }

    // --- помощник раздела: разговор с инструментами; что он знает и умеет — GET без id
    if (p === '/api/routines/assistant' || p.startsWith('/api/routines/assistant/')) {
      const a = assistant(deps);
      if (!a) return bad('Помощник пока недоступен', 501);
      const say = (b: Record<string, unknown>): { text: string; model: string | undefined; client: unknown } => ({
        text: typeof b.text === 'string' ? b.text.trim().slice(0, 4000) : '',
        // модель — выбор человека; пустая строка — модель раздела по умолчанию, поля нет — прежняя модель разговора
        model: typeof b.model === 'string' ? b.model.trim().slice(0, 100) : undefined,
        // форма, как её видит человек сейчас: помощник правит её, а не свой прошлый черновик
        client: b.form && typeof b.form === 'object' && !Array.isArray(b.form) ? { spec: b.form } : undefined,
      });
      try {
        if (p === '/api/routines/assistant') {
          if (method === 'GET') return ok(a.about());
          if (method === 'POST') {
            const { text, model, client } = say(obj(await readBody()));
            if (!text) return bad('Напиши, что нужно');
            return ok(a.start(text, model, client), 201);
          }
          return undefined;
        }
        if ((m = p.match(/^\/api\/routines\/assistant\/([A-Za-z0-9_-]+)(\/stop)?$/))) {
          const id = m[1];
          if (m[2]) return method === 'POST' ? found(a.stop(id), 'Разговор не найден') : undefined;
          if (method === 'GET') return found(a.get(id), 'Разговор не найден');
          if (method === 'POST') {
            const { text, model, client } = say(obj(await readBody()));
            if (!text) return bad('Напиши, что нужно');
            return found(a.send(id, text, model, client), 'Разговор не найден');
          }
          if (method === 'DELETE') {
            a.close(id);
            return ok({ ok: true });
          }
        }
      } catch (e) {
        if (e instanceof AssistantBusy) return bad(e.message, 409);
        throw e;
      }
      return undefined;
    }

    // --- подключение словами
    if (p === '/api/routines/sources/draft' || p.startsWith('/api/routines/sources/draft/')) {
      const d = drafts(deps);
      if (!d) return bad('Подключение словами пока недоступно', 501);
      if (p === '/api/routines/sources/draft' && method === 'POST') {
        const b = obj(await readBody());
        const description = typeof b.description === 'string' ? b.description.trim() : '';
        if (!description) return bad('Опиши словами, что подключить');
        return ok(d.start(description.slice(0, 4000)), 201);
      }
      if ((m = p.match(/^\/api\/routines\/sources\/draft\/([A-Za-z0-9_-]+)(\/secret|\/refine)?$/))) {
        const id = m[1];
        if (!m[2] && method === 'GET') return found(d.get(id), 'Черновик не найден');
        if (!m[2] && method === 'DELETE') {
          d.cancel(id);
          return ok({ ok: true });
        }
        if (m[2] === '/secret' && method === 'POST') {
          const b = obj(await readBody());
          const name = typeof b.name === 'string' ? b.name : '';
          const value = typeof b.value === 'string' ? b.value.trim() : '';
          if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return bad('Имя ключа — ЗАГЛАВНЫЕ_БУКВЫ_И_ЦИФРЫ');
          if (!value) return bad('Пустой ключ');
          return found(d.secret(id, name, value), 'Черновик не найден');
        }
        if (m[2] === '/refine' && method === 'POST') {
          const b = obj(await readBody());
          const note = typeof b.note === 'string' ? b.note.trim() : '';
          if (!note) return bad('Напиши, что поправить');
          return found(d.refine(id, note.slice(0, 4000)), 'Черновик не найден');
        }
      }
      return undefined;
    }

    // «Проверить сейчас»: принудительный опрос источника, как по таймеру
    if ((m = p.match(/^\/api\/routines\/sources\/([^/]+)\/check$/)) && method === 'POST') {
      if (!SLUG_RE.test(m[1])) return bad('Недопустимый слаг источника');
      return ok(await engine.checkNow(m[1]));
    }

    // подробности одного события — как их получит flow перед запуском («Получит» в узле «Запустить flow»)
    if ((m = p.match(/^\/api\/routines\/sources\/([^/]+)\/detail$/)) && method === 'POST') {
      if (!SLUG_RE.test(m[1])) return bad('Недопустимый слаг источника');
      return ok(await engine.detailPreview(m[1], obj(await readBody())));
    }

    // пример событий источника для редактора рутины: GET — из журнала источника, POST — пробный опрос сейчас
    if ((m = p.match(/^\/api\/routines\/sources\/([^/]+)\/events$/)) && (method === 'GET' || method === 'POST')) {
      if (!SLUG_RE.test(m[1])) return bad('Недопустимый слаг источника');
      return ok(await engine.sourceEvents(m[1], { fresh: method === 'POST', limit: Number(url.searchParams.get('limit')) || undefined }));
    }

    if ((m = p.match(/^\/api\/routines\/sources\/([^/]+)$/))) {
      const slug = m[1];
      if (!SLUG_RE.test(slug)) return bad('Недопустимый слаг источника');
      if (method === 'PUT') {
        const b = obj(await readBody());
        return ok(engine.saveSource(slug, b.spec, secretsOf(b.secrets)));
      }
      if (method === 'DELETE') {
        engine.deleteSource(slug);
        return ok({ ok: true });
      }
      return undefined;
    }

    // --- сервисы MCP для источника «Сервис через Claude»: к модели не обращается, список держится 5 минут
    if (p === '/api/routines/mcp-tools' && method === 'GET') {
      const v = await (deps.mcpServers ?? getMcpServers)(url.searchParams.get('force') === '1');
      return ok({ services: mcpServices(v.servers), at: v.at } satisfies McpServicesView);
    }

    // --- рецепты
    if (p === '/api/routines/recipes' && method === 'GET') return ok(recipes(engine));
    if (p === '/api/routines/recipes/import' && method === 'POST') {
      const b = obj(await readBody());
      const yaml = typeof b.yaml === 'string' ? b.yaml : '';
      const parsed = parseSourceYaml(yaml);
      if (!parsed.spec) return bad('Рецепт не прошёл проверку', 400, { problems: parsed.problems });
      if (!engine.kind(parsed.spec.kind)) return bad(`Неизвестный вид источника: ${parsed.spec.kind}`);
      const slug = freeSlug(parsed.spec.title, (s) => Boolean(engine.store.recipes().find((r) => r.slug === s)), 'recipe');
      engine.store.writeRecipe(slug, yaml);
      return ok({ id: slug, spec: parsed.spec, summary: parsed.spec.description ?? parsed.spec.title }, 201);
    }

    // --- ожидания и «догнать»
    if ((m = p.match(/^\/api\/routines\/waits\/([A-Za-z0-9_-]+)$/)) && method === 'POST') {
      const b = obj(await readBody());
      const action = b.action;
      if (action !== 'run' && action !== 'later' && action !== 'reject') return bad('action: run | later | reject');
      const r = obj(b.reply);
      const reply: WaitAction['reply'] = b.reply === undefined ? undefined : { send: r.send === true, ...(typeof r.text === 'string' ? { text: r.text.slice(0, 8000) } : {}) };
      return ok(await engine.waitAction(m[1], { action, ...(reply ? { reply } : {}) }));
    }
    if ((m = p.match(/^\/api\/routines\/catchup\/([A-Za-z0-9_-]+)$/)) && method === 'POST') {
      const b = obj(await readBody());
      if (b.action !== 'run' && b.action !== 'skip') return bad('action: run | skip');
      return ok(await engine.catchUpAction(m[1], b.action));
    }

    // --- рутины
    if ((m = p.match(/^\/api\/routines\/([^/]+)\/log\/([A-Za-z0-9_-]+)\/(explain|recheck|ask)$/))) {
      if (RESERVED.has(m[1])) return undefined;
      try {
        assertSlug(m[1]);
      } catch (err) {
        return bad((err as Error).message);
      }
      if (m[3] === 'explain' && method === 'GET') return ok(engine.explain(m[1], m[2]));
      // body: { check?, model?, ask? } — несохранённая правка узла «ИИ рутины» проверяется на этом же событии
      if (m[3] === 'recheck' && method === 'POST') return ok(await engine.recheck(m[1], m[2], obj(await readBody())));
      if (m[3] === 'ask' && method === 'POST') return ok(engine.ask(m[1], m[2], obj(await readBody())));
      return undefined;
    }
    // проверка на истории с ходом: начать (или получить ту же, если она уже идёт), спросить, остановить
    if ((m = p.match(/^\/api\/routines\/([^/]+)\/history\/runs(?:\/([a-f0-9]{1,32}))?$/))) {
      const slug = m[1];
      if (RESERVED.has(slug)) return undefined;
      try {
        assertSlug(slug);
      } catch (err) {
        return bad((err as Error).message);
      }
      if (!m[2]) {
        if (method !== 'POST') return undefined;
        const b = obj(await readBody());
        return ok(engine.startHistory(slug, { spec: b.spec, limit: typeof b.limit === 'number' ? b.limit : undefined }), 201);
      }
      if (method === 'GET') return found(engine.historyRun(slug, m[2]), 'Проверка не найдена: приложение перезапускалось. Запусти её снова');
      if (method === 'DELETE') return engine.stopHistory(slug, m[2]) ? ok({ ok: true }) : bad('Проверка не найдена', 404);
      return undefined;
    }
    if ((m = p.match(/^\/api\/routines\/([^/]+)(\/enabled|\/history|\/run|\/log|\/feedback)?$/))) {
      const slug = m[1];
      // имена разделов API — не слаги рутин
      if (RESERVED.has(slug)) return undefined;
      try {
        assertSlug(slug);
      } catch (err) {
        return bad((err as Error).message);
      }
      const tail = m[2];
      if (!tail) {
        if (method === 'GET') return found(engine.routineView(slug), 'Рутина не найдена');
        if (method === 'PUT') return ok(engine.saveRoutine(slug, obj(await readBody())));
        if (method === 'DELETE') {
          engine.deleteRoutine(slug);
          return ok({ ok: true });
        }
        return undefined;
      }
      if (tail === '/enabled' && method === 'POST') {
        const b = obj(await readBody());
        if (typeof b.enabled !== 'boolean') return bad('enabled — true или false');
        return ok(engine.setEnabled(slug, b.enabled));
      }
      if (tail === '/history' && method === 'POST') {
        const b = obj(await readBody());
        return ok(await engine.history(slug, { spec: b.spec, limit: typeof b.limit === 'number' ? b.limit : undefined }));
      }
      if (tail === '/run' && method === 'POST') {
        const b = obj(await readBody());
        return ok(await engine.runNow(slug, typeof b.eventId === 'string' ? b.eventId : undefined));
      }
      if (tail === '/feedback' && method === 'POST') {
        const b = obj(await readBody());
        return ok(engine.setFeedback(slug, { eventId: b.eventId, verdict: b.verdict }));
      }
      if (tail === '/log' && method === 'GET') {
        const outcomes = (url.searchParams.get('outcome') ?? '').split(',').map((s) => s.trim()).filter((s): s is LogOutcome => (OUTCOMES as string[]).includes(s));
        const limit = Number(url.searchParams.get('limit'));
        return ok(engine.logOf(slug, { outcomes, limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200 }));
      }
    }
  } catch (err) {
    if (err instanceof RoutineError) return bad(err.message, err.status, err.body);
    return bad(err instanceof Error ? err.message : String(err), 500);
  }
  return undefined;
}

function found(v: unknown, notFound: string): Reply {
  return v === undefined ? bad(notFound, 404) : ok(v);
}
