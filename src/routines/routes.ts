// Маршруты /api/routines (SPEC §3) в стиле integrationsRoute: (method, url, readBody) → Reply или undefined.
// Проверки Host/Origin/типа тела уже сделал server-guard в handle(). Ключи наружу не уходят: только имена недостающих.
import type { DraftRoutes, Recipe } from './kind.js';
import { RoutineError, type RoutineEngine } from './engine.js';
import { assertSlug, freeSlug, parseSourceYaml, SLUG_RE } from './schema.js';
import { getMcpServers, type McpServer } from '../connectors.js';
import { createConnectorBuilds, mcpServices, type ConnectorBuilds } from './sources/connector.js';
import { draftRoutes, loadRecipes } from './sources/index.js';
import { ensureTemplateFlow, flowTemplates, NoFlowTemplate } from './flow-templates.js';
import type { LogOutcome, McpServicesView, WaitAction } from './types.js';

export type Reply = { status: number; body: unknown };

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const bad = (error: string, status = 400, extra?: Record<string, unknown>): Reply => ({ status, body: { error, ...extra } });

/** Слаги, занятые разделами API: рутина с таким именем не открылась бы. */
export const RESERVED = new Set(['sources', 'recipes', 'waits', 'catchup', 'mcp-tools', 'flow-templates']);

const OUTCOMES: LogOutcome[] = ['started', 'waiting', 'filtered', 'check_no', 'duplicate', 'limit', 'rejected', 'missed', 'task', 'error'];

export type RoutinesRouteDeps = {
  engine: RoutineEngine;
  /** Подключение словами; по умолчанию draftRoutes() видов. null (или draftRoutes вернул undefined) — 501. */
  drafts?: DraftRoutes | null;
  /** MCP-серверы для источника «Сервис через Claude»; по умолчанию getMcpServers (процесс Claude Code без модели). */
  mcpServers?: (force: boolean) => Promise<{ servers: McpServer[]; at: string }>;
  /** Сборка скрипта «Сервиса через Claude»; по умолчанию — сессия модели и проверка источника движком. */
  builds?: ConnectorBuilds;
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
      if (m[3] === 'recheck' && method === 'POST') return ok(await engine.recheck(m[1], m[2], obj(await readBody())));
      if (m[3] === 'ask' && method === 'POST') return ok(engine.ask(m[1], m[2], obj(await readBody())));
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
