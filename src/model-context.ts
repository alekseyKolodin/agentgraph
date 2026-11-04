// «Модель получит» (web/src/components/ModelPreview.tsx): что пространство и теги знаний дают модели. Тексты собирает
// тот же код, что их отправляет: sessionContext — хук SessionStart сессии терминала, phaseContextTail — хвост промпта
// каждого этапа запуска. Рядом — разбор для читаемого превью: карта, состояние (как уйдёт — обрезанное), документы, папки
// и строка каждого тега знаний.
import path from 'node:path';
import type { ModelContextView } from './api-types.js';
import type { ApiReply } from './artifact-api.js';
import { phaseContextTail } from './runner.js';
import { sessionContext } from './sessions.js';
import { clampState, existingSpacePaths, MAP_FILE, readSpace, spaceContext, spaceSlug } from './spaces.js';
import { knowledgeLine, knowledgeSection, knowledgeTags, runTagSlugs } from './tags.js';

/** Что получит модель от пространства (слаг; пусто — без него) и тегов знаний (только существующие: иначе ошибка). */
export function modelContext(q: { space?: string | null; tags?: string[] }): ModelContextView | undefined {
  const slug = spaceSlug(q.space ?? undefined);
  const space = slug ? readSpace(slug) : undefined;
  if (slug && !space) return undefined;
  const knowledge = knowledgeTags(runTagSlugs(q.tags ?? []));
  return {
    // сессия запущена с этим пространством: его карта уже память, остальное — хуком
    session: sessionContext({ space, knowledge }, space?.slug),
    phase: phaseContextTail(space ? spaceContext(space, { where: 'phase', mapLoaded: true }) : undefined, knowledge),
    ...(space
      ? {
          space: {
            slug: space.slug,
            title: space.title ?? '',
            ...(space.autoTitle ? { autoTitle: true as const } : {}),
            dir: space.dir,
            map: { path: path.join(space.dir, MAP_FILE), chars: space.map.trim().length },
            state: clampState(space.state),
            docs: space.docs,
            dirs: existingSpacePaths(space).listed,
          },
        }
      : {}),
    knowledge: knowledge.map((t) => ({ slug: t.slug, title: t.title ?? '', inline: Boolean(t.inline), text: t.inline ? knowledgeSection(t) : knowledgeLine(t) })),
  };
}

/** GET /api/model-context?space=<slug>&tags=a,b: 404 — нет пространства, 400 — неверный слаг или нет тега знаний. */
export function modelContextReply(params: URLSearchParams): ApiReply {
  try {
    const tags = (params.get('tags') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const view = modelContext({ space: params.get('space'), tags });
    return view ? { status: 200, body: view } : { status: 404, body: { error: `Пространства ${params.get('space')} нет` } };
  } catch (err) {
    return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}
