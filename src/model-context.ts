// «Модель получит» (web/src/components/ModelPreview.tsx) и вкладка «Контекст» пространства: что пространство и теги
// знаний дают модели. Тексты собирает тот же код, что их отправляет: sessionContext — хук SessionStart сессии терминала,
// phaseContextTail с phaseSpaceSection — хвост промпта каждого этапа запуска. Рядом — разбор для читаемого превью: карта,
// состояние (как уйдёт — обрезанное), документы, папки и строка каждого тега знаний.
import path from 'node:path';
import type { ModelContextView, SpaceContextView, Tag } from './api-types.js';
import type { ApiReply } from './artifact-api.js';
import { phaseContextTail, phaseSpaceSection } from './runner.js';
import { mapLoadedAt, sessionContext } from './sessions.js';
import { clampState, existingSpacePaths, MAP_FILE, readSpace, spaceReadDirs, spaceSlug, spaceWarnings, type Space } from './spaces.js';
import { knowledgeLine, knowledgeSection, knowledgeTags, runTagSlugs } from './tags.js';

/**
 * Тексты сессии и этапа. Карта у сессии — память, если папка пространства уйдёт в --add-dir (не внутри рабочей папки и
 * не содержит её) или сессия открыта в самой папке пространства — то же правило, что у запуска claude (mapLoadedAt).
 * Рабочая папка не задана — как обычно, памятью. Этап получает папку пространства доп. директорией всегда.
 */
function contextTexts(space: Space | undefined, knowledge: Tag[], cwd?: string): { session: string; phase: string; mapLoaded: boolean } {
  const mapLoaded = Boolean(space && (!cwd || mapLoadedAt(space.dir, path.resolve(cwd))));
  return {
    session: sessionContext({ space, knowledge }, mapLoaded ? space?.slug : undefined),
    phase: phaseContextTail(space ? phaseSpaceSection(space) : undefined, knowledge),
    mapLoaded,
  };
}

/**
 * Что получит модель от пространства (слаг; пусто — без него) и тегов знаний (только существующие: иначе ошибка); cwd —
 * рабочая папка формы или сессии (от неё зависит, придёт ли карта памятью).
 */
export function modelContext(q: { space?: string | null; tags?: string[]; cwd?: string | null }): ModelContextView | undefined {
  const slug = spaceSlug(q.space ?? undefined);
  const space = slug ? readSpace(slug) : undefined;
  if (slug && !space) return undefined;
  const knowledge = knowledgeTags(runTagSlugs(q.tags ?? []));
  const cwd = q.cwd?.trim() || undefined;
  const t = contextTexts(space, knowledge, cwd);
  return {
    session: t.session,
    phase: t.phase,
    ...(space
      ? {
          space: {
            slug: space.slug,
            title: space.title ?? '',
            ...(space.autoTitle ? { autoTitle: true as const } : {}),
            dir: space.dir,
            map: { path: path.join(space.dir, MAP_FILE), chars: space.map.trim().length, loaded: t.mapLoaded },
            state: clampState(space.state),
            docs: space.docs,
            dirs: existingSpacePaths(space).listed,
          },
        }
      : {}),
    knowledge: knowledge.map((t) => ({ slug: t.slug, title: t.title ?? '', inline: Boolean(t.inline), text: t.inline ? knowledgeSection(t) : knowledgeLine(t) })),
  };
}

/** GET /api/model-context?space=<slug>&tags=a,b&cwd=<папка>: 404 — нет пространства, 400 — неверный слаг или нет тега знаний. */
export function modelContextReply(params: URLSearchParams): ApiReply {
  try {
    const tags = (params.get('tags') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const view = modelContext({ space: params.get('space'), tags, cwd: params.get('cwd') });
    return view ? { status: 200, body: view } : { status: 404, body: { error: `Пространства ${params.get('space')} нет` } };
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Вкладка «Контекст» пространства: тексты сессии и этапа — те же, что «Модель получит» без тегов знаний (сессия — с
 * шапкой и бюджетом хука), папки чтения, карта и предупреждения.
 */
export function spaceContextReply(slug: string, runsDir: string): ApiReply {
  try {
    const s = readSpace(slug);
    if (!s) return { status: 404, body: { error: `Пространства ${slug} нет` } };
    const t = contextTexts(s, []);
    const view: SpaceContextView = {
      session: t.session,
      phase: t.phase,
      readDirs: spaceReadDirs(s, runsDir),
      map: { path: path.join(s.dir, MAP_FILE), exists: Boolean(s.map.trim()), chars: s.map.trim().length },
      warnings: spaceWarnings(s),
    };
    return { status: 200, body: view };
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}
