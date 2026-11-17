// Встроенные виды источников, рецепты и подключение словами. Ядро (src/routines/*) берёт всё отсюда.
// command и расписание живут в ядре (src/routines/command.ts, schedule.ts) и здесь не повторяются.
import type { Exec } from '../../git.js';
import type { DraftDeps, DraftRoutes, Recipe, SourceKind } from '../kind.js';
import { connectorKind, type ConnectorDeps } from './connector.js';
import { createDraftRoutes, type DraftOptions } from './draft.js';
import { emailKind, type EmailDeps } from './email.js';
import { folderKind } from './folder.js';
import { githubKind, gitlabKind } from './forge.js';
import { jiraKind, type JiraDeps } from './jira.js';
import { loadRecipes as loadRecipeFiles } from './recipes.js';
import { rssKind } from './rss.js';
import { slackKind } from './slack.js';
import { telegramKind } from './telegram.js';

/** Подмены внешних эффектов — для тестов и e2e; без аргументов виды работают по-настоящему. */
export type KindDeps = { exec?: Exec; jira?: JiraDeps; email?: EmailDeps; connector?: ConnectorDeps };

export function builtinKinds(deps: KindDeps = {}): SourceKind[] {
  return [slackKind, telegramKind, gitlabKind(deps.exec), githubKind(deps.exec), jiraKind(deps.jira), rssKind, folderKind, emailKind(deps.email), connectorKind(deps.connector)];
}

export function loadRecipes(): Recipe[] {
  return loadRecipeFiles();
}

export function draftRoutes(deps: DraftDeps, opts?: DraftOptions): DraftRoutes | undefined {
  return createDraftRoutes(deps, opts);
}

export { parseRecipe, recipesDir } from './recipes.js';
