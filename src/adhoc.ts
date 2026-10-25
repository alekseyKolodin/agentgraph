// Разовый запуск: flow, который не лежит в flows/. До старта он черновик во вкладке браузера (или YAML у скилла),
// после старта — только снимок runs/<id>/flow.yaml, а в run.json стоит adhoc: true. Логика без HTTP: server.ts
// разбирает тело и отвечает, решения — здесь.
import fs from 'node:fs';
import path from 'node:path';
import { assertFlowName, flowExists, flowFileName, flowFolder, flowToYaml, loadFlow, parseFlow, saveFlowYaml, validateSpec } from './flows.js';
import { compactSpec, flowBlocks, type Block, type FlowSpec } from './schema.js';
import type { ApiReply } from './artifact-api.js';
import type { RunReport } from './runner.js';

/** Id запуска — имя папки в runs/: без точек и слэшей. */
export const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Черновик из конструктора (spec — объект) или из скилла (yaml — строка): валидный spec в короткой форме. */
export function draftSpec(body: { spec?: unknown; yaml?: unknown }): FlowSpec {
  let spec: FlowSpec;
  if (body.yaml !== undefined) {
    if (typeof body.yaml !== 'string') throw new Error('yaml — строка');
    spec = compactSpec(parseFlow(body.yaml));
  } else {
    if (!body.spec || typeof body.spec !== 'object' || Array.isArray(body.spec)) throw new Error('spec — объект');
    spec = compactSpec(validateSpec(body.spec));
  }
  // имя уходит в путь папки запуска: проверяем и здесь, а не только регэкспом схемы
  assertFlowName(spec.name);
  return spec;
}

/**
 * По чему запускать: ровно одно из flow (имя сохранённого), spec или yaml (черновик). Черновик — разовый запуск.
 * load — шов для тестов.
 */
export function specFromRunBody(
  body: { flow?: unknown; spec?: unknown; yaml?: unknown },
  load: (name: string) => FlowSpec = loadFlow,
): { spec: FlowSpec; adhoc: boolean } {
  const given = (['flow', 'spec', 'yaml'] as const).filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== '');
  if (!given.length) throw new Error('Не выбран flow: передай flow, spec или yaml');
  if (given.length > 1) throw new Error(`Передай что-то одно из flow, spec и yaml, а не ${given.join(' и ')}`);
  if (given[0] === 'flow') {
    if (typeof body.flow !== 'string') throw new Error('flow — имя flow');
    assertFlowName(body.flow);
    return { spec: load(body.flow), adhoc: false };
  }
  return { spec: draftSpec(body), adhoc: true };
}

/**
 * Снимок flow, по которому шёл запуск. Не resolveFlowFile: правило «пути flow через него» — про flows/,
 * а он открыл бы любой файл на диске. Здесь путь строится только из проверенного id.
 */
export function readRunFlow(runsDir: string, id: string): FlowSpec {
  if (!RUN_ID_RE.test(id)) throw new Error(`Неверный id запуска: ${id}`);
  const file = path.join(runsDir, id, 'flow.yaml');
  if (!fs.existsSync(file)) throw new Error(`У запуска ${id} нет снимка flow.yaml`);
  return parseFlow(fs.readFileSync(file, 'utf8'));
}

/** Схема запуска для UI: блоки снимка в полной форме (как flowBlocks) и объявленные артефакты. Ошибки — как у readRunFlow. */
export function runFlowView(runsDir: string, id: string): { name: string; blocks: Block[]; artifacts?: FlowSpec['artifacts'] } {
  const spec = readRunFlow(runsDir, id);
  return { name: spec.name, blocks: flowBlocks(spec), ...(spec.artifacts ? { artifacts: spec.artifacts } : {}) };
}

/**
 * По какому spec идёт запуск: у разового — его снимок (в flows/ может лежать чужой flow с тем же именем),
 * у обычного — текущая версия сохранённого flow по имени.
 */
export function runSpec(
  report: Pick<RunReport, 'id' | 'flow' | 'adhoc'>,
  load: { flow: (name: string) => FlowSpec; snapshot: (id: string) => FlowSpec },
): FlowSpec {
  return report.adhoc ? load.snapshot(report.id) : load.flow(report.flow);
}

export type SaveFlowDeps = {
  exists: (name: string) => boolean;
  /** Свободное имя: name, name-2, … */
  freeName: (name: string, folder: string) => string;
  save: (name: string, yaml: string, folder: string) => void;
  folderOf: (name: string) => string;
};

const fsDeps: SaveFlowDeps = {
  exists: flowExists,
  freeName: (name, folder) => flowFileName(name, folder).name,
  save: (name, yaml, folder) => { saveFlowYaml(name, yaml, folder); },
  folderOf: flowFolder,
};

/**
 * «Сохранить как flow»: снимок запуска ложится в flows/. Без name — свободное имя от имени снимка, занятое name — 409:
 * существующий flow не перезаписывается. Поле name внутри YAML меняется на выбранное, иначе запуски сохранённого
 * flow записали бы в run.json чужое имя. run.json не трогаем: у идущего запуска его пишет раннер.
 */
export function saveRunFlow(runsDir: string, id: string, body: { name?: unknown; folder?: unknown }, deps: SaveFlowDeps = fsDeps): ApiReply {
  if (body.name !== undefined && typeof body.name !== 'string') return { status: 400, body: { error: 'name — строка' } };
  if (body.folder !== undefined && typeof body.folder !== 'string') return { status: 400, body: { error: 'folder — строка (пустая — корень)' } };
  let snap: FlowSpec;
  try {
    snap = readRunFlow(runsDir, id);
  } catch (err) {
    return { status: 404, body: { error: errMsg(err) } };
  }
  const folder = (body.folder ?? '').trim();
  let name = (body.name ?? '').trim();
  try {
    if (name) {
      assertFlowName(name);
      if (deps.exists(name)) return { status: 409, body: { error: `Flow ${name} уже существует: выбери другое имя` } };
    } else {
      name = deps.freeName(snap.name, folder);
    }
    deps.save(name, flowToYaml(compactSpec({ ...snap, name })), folder);
  } catch (err) {
    return { status: 400, body: { error: errMsg(err) } };
  }
  return { status: 201, body: { name, folder: deps.folderOf(name) } };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
