// Шаблон репо команды Teamwork (spec §5.1): дерево templates/teamwork/ в checkout agentgraph копируется в новый репо
// целиком (teamwork.yaml, README.md, project-template/, flows/ от сессии flows), teamwork.yaml получает название,
// префикс и первого участника. Заготовки документов нового проекта берутся из project-template/ репо команды — команда
// правит их под себя, — а если его там нет, из шаблона agentgraph.
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './paths.js';
import { updateYaml } from './teamwork.js';
import type { TeamMember } from './api-types.js';

export const TEMPLATE_DIR = path.join(APP_DIR, 'templates', 'teamwork');
/** Папка заготовок документов проекта в репо команды и в шаблоне. */
export const PROJECT_TEMPLATE_DIR = 'project-template';
export const PROJECT_DOC_FILES = ['prd.md', 'architecture.md', 'design.md'] as const;

/** Все файлы шаблона относительно корня, по алфавиту; нет шаблона — пусто. */
export function templateFiles(from = TEMPLATE_DIR): string[] {
  if (!fs.existsSync(from)) return [];
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(from, '');
  return out;
}

/** Копирует дерево шаблона в dest (существующие файлы перезаписываются), возвращает скопированные пути. */
export function copyTemplate(dest: string, from = TEMPLATE_DIR): string[] {
  const files = templateFiles(from);
  for (const rel of files) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(from, rel), to);
  }
  return files;
}

/** teamwork.yaml новой команды: название, префикс и первый участник поверх текста шаблона (комментарии остаются). */
export function renderTeamConfig(templateText: string, o: { title: string; prefix: string; member: TeamMember }): string {
  return updateYaml(templateText, { title: o.title, prefix: o.prefix, members: [o.member] });
}

/** Подстановка {{title}} и {{summary}} в заготовку документа. */
export function renderDoc(template: string, o: { title: string; summary: string }): string {
  return template.replace(/\{\{\s*(title|summary)\s*\}\}/g, (_m, k: 'title' | 'summary') => o[k]);
}

/**
 * Документы нового проекта: заготовка берётся из первой папки, где она есть (project-template/ репо команды, потом шаблон
 * agentgraph); нет ни там, ни там — один заголовок.
 */
export function projectDocs(o: { title: string; summary: string }, dirs: string[] = [path.join(TEMPLATE_DIR, PROJECT_TEMPLATE_DIR)]): Record<(typeof PROJECT_DOC_FILES)[number], string> {
  const out = {} as Record<(typeof PROJECT_DOC_FILES)[number], string>;
  for (const file of PROJECT_DOC_FILES) {
    const dir = dirs.find((d) => fs.existsSync(path.join(d, file)));
    out[file] = renderDoc(dir ? fs.readFileSync(path.join(dir, file), 'utf8') : `# ${o.title}\n\n${o.summary}\n`, o);
  }
  return out;
}
