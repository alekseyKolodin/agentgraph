// Готовые flow шаблонов рутин (docs/desk/SPEC.md, этап 4.6): templates/flows/*.yaml поставляются с приложением. Шаблон
// рутины называет flow по имени; при сохранении рутины flow берётся из flows/ пользователя, а если такого нет —
// копируется туда из шаблона (папка «Мои дела»), файлом как есть, с комментариями. Свой flow с тем же именем не
// перезаписывается никогда: пользователь мог его поправить.
import fs from 'node:fs';
import path from 'node:path';
import { assertFlowName, flowExists, parseFlow, plannedFlowFile } from '../flows.js';
import { APP_DIR } from '../paths.js';
import { flowBlocks } from '../schema.js';
import type { FlowTemplate } from './types.js';

export const flowTemplatesDir = (): string => path.join(APP_DIR, 'templates', 'flows');
/** Папка flows/, куда ложатся скопированные шаблоны. */
export const TEMPLATE_FLOW_FOLDER = 'Мои дела';

export type FlowTemplateDeps = {
  /** Папка шаблонов; по умолчанию templates/flows рядом с кодом. */
  templates?: string;
  /** Папка flow пользователя; по умолчанию flows/ (AGENTGRAPH_HOME). */
  flows?: string;
  /** Есть ли у пользователя flow с этим именем (в любой папке); по умолчанию flowExists. */
  exists?: (name: string) => boolean;
};

/** Шаблона с таким именем нет — маршрут отвечает 404; остальные ошибки (права, диск, битый шаблон) — 500. */
export class NoFlowTemplate extends Error {}

/** Шаблон по имени: текст файла и проверенная схема. Нет файла или битый — ошибка с понятной причиной. */
function readTemplate(name: string, dir: string): { text: string; description: string; blocks: string[] } {
  assertFlowName(name);
  const file = path.join(dir, `${name}.yaml`);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new NoFlowTemplate(`Готового flow ${name} нет среди шаблонов`);
  }
  const spec = parseFlow(text);
  if (spec.name !== name) throw new Error(`Шаблон ${name}: в файле flow называется ${spec.name}`);
  const blocks = flowBlocks(spec).flatMap((b) => (b.name ? [b.name] : []));
  return { text, description: spec.description ?? '', blocks };
}

/** Готовый flow шаблона с названиями блоков — помощнику рутин для until_pause / pause_before. */
export type FlowTemplateWithBlocks = FlowTemplate & { blocks: string[] };

/** Готовые flow шаблонов: имя, описание и блоки. Битый файл пропускается — он не должен ломать «Новую рутину». */
export function flowTemplatesWithBlocks(o: FlowTemplateDeps = {}): FlowTemplateWithBlocks[] {
  const dir = o.templates ?? flowTemplatesDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  } catch {
    return [];
  }
  const out: FlowTemplateWithBlocks[] = [];
  for (const f of files.sort()) {
    const name = f.replace(/\.yaml$/, '');
    try {
      const { description, blocks } = readTemplate(name, dir);
      out.push({ name, description, blocks });
    } catch {
      /* битый шаблон — не показываем */
    }
  }
  return out;
}

/** Готовые flow шаблонов: имя и описание (ответ GET /api/routines/flow-templates). */
export function flowTemplates(o: FlowTemplateDeps = {}): FlowTemplate[] {
  return flowTemplatesWithBlocks(o).map(({ name, description }) => ({ name, description }));
}

/**
 * Flow шаблона у пользователя: есть — как есть (copied: false); нет — копия шаблона в flows/Мои дела/<имя>.yaml.
 * Файл пишется только новым (wx): гонка двух сохранений не затрёт уже скопированный и поправленный flow.
 */
export function ensureTemplateFlow(name: string, o: FlowTemplateDeps = {}): { flow: string; copied: boolean; file?: string } {
  assertFlowName(name);
  if ((o.exists ?? flowExists)(name)) return { flow: name, copied: false };
  const { text } = readTemplate(name, o.templates ?? flowTemplatesDir());
  // путь — как у сохранения flow (проверка имени папки, уже существующее написание на регистронезависимой ФС);
  // в тестах — своя папка flows
  const file = o.flows ? path.join(o.flows, TEMPLATE_FLOW_FOLDER, `${name}.yaml`) : plannedFlowFile(name, TEMPLATE_FLOW_FOLDER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, text, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { flow: name, copied: false };
    throw err;
  }
  return { flow: name, copied: true, file };
}
