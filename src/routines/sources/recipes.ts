// Рецепты — готовые источники файлом: templates/sources/*.yaml (поставляются с приложением) и ~/.agentgraph/recipes/*.yaml.
// Формат файла: id (необязательно, иначе имя файла), summary и spec — SourceSpec без секретов. Плоский формат
// (title/kind/config на верхнем уровне) тоже принимается. Битый файл пропускается: рецепты не должны ломать список.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { APP_DIR } from '../../paths.js';
import { configDir } from '../../settings.js';
import type { Recipe } from '../kind.js';
import type { SourceSpec } from '../types.js';

export const templatesDir = (): string => path.join(APP_DIR, 'templates', 'sources');
export const recipesDir = (): string => path.join(configDir(), 'recipes');

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Рецепт из текста YAML; не рецепт — ошибка с причиной (её показывает импорт). */
export function parseRecipe(text: string, file: string): Recipe {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new Error(`YAML не разобран: ${(err as Error).message.split('\n')[0]}`);
  }
  if (!isObj(doc)) throw new Error('Рецепт — это YAML-словарь с полем spec');
  const raw = isObj(doc.spec) ? doc.spec : doc;
  if (typeof raw.title !== 'string' || !raw.title.trim()) throw new Error('В рецепте нет title');
  if (typeof raw.kind !== 'string' || !raw.kind.trim()) throw new Error('В рецепте нет kind');
  if (!isObj(raw.config)) throw new Error('В рецепте нет config');
  const spec: SourceSpec = { title: raw.title.trim(), kind: raw.kind.trim(), config: raw.config };
  if (typeof raw.every === 'string') spec.every = raw.every;
  if (isObj(raw.map) && typeof raw.map.id === 'string') spec.map = raw.map as SourceSpec['map'];
  if (typeof raw.description === 'string') spec.description = raw.description;
  if (Array.isArray(raw.secrets)) spec.secrets = raw.secrets.map(String);
  const base = path.basename(file).replace(/\.ya?ml$/i, '');
  const id = typeof doc.id === 'string' && /^[a-z0-9-]+$/.test(doc.id) ? doc.id : base.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const summary = typeof doc.summary === 'string' ? doc.summary.trim() : spec.description ?? spec.title;
  return { id, spec, summary, file };
}

function readDir(dir: string): Recipe[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch {
    return [];
  }
  const out: Recipe[] = [];
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      out.push(parseRecipe(fs.readFileSync(file, 'utf8'), file));
    } catch {
      // битый рецепт не попадает в список
    }
  }
  return out;
}

/** Рецепты приложения, затем личные: личный с тем же id заменяет встроенный. */
export function loadRecipes(dirs: { templates?: string; user?: string } = {}): Recipe[] {
  const byId = new Map<string, Recipe>();
  for (const r of [...readDir(dirs.templates ?? templatesDir()), ...readDir(dirs.user ?? recipesDir())]) byId.set(r.id, r);
  return [...byId.values()];
}
