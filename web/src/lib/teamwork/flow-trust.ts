// Доверие к flow команды (spec §14): запуск flow, который этот компьютер ещё не одобрял, сервер отклоняет 409 flow_untrusted
// с YAML, базой диффа и возможностями flow. Здесь — разбор такого ответа и дифф для диалога «Доверять этой версии».
// Чистые функции без React и DOM.
import type { TeamFlowTrust } from '@server/api-types';
import { diffRows, diffStat, lineDiff, type DiffRow } from '../space-draft';

const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function isTrust(v: unknown): v is TeamFlowTrust {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Partial<TeamFlowTrust>;
  const base = f.base as unknown;
  const baseOk = base === undefined || (typeof base === 'object' && base !== null && typeof (base as { yaml?: unknown }).yaml === 'string');
  return typeof f.team === 'string' && typeof f.name === 'string' && typeof f.hash === 'string' && typeof f.yaml === 'string' && strs(f.commands) && strs(f.tools) && baseOk;
}

/** Flow команды из ошибки запроса (ApiError: status, code, data): 409 flow_untrusted — что показать человеку; иначе undefined. */
export function untrustedFlow(err: unknown): TeamFlowTrust | undefined {
  const e = err as { status?: unknown; code?: unknown; data?: unknown } | null | undefined;
  if (!e || e.status !== 409 || e.code !== 'flow_untrusted') return undefined;
  const flow = (e.data as { flow?: unknown } | null | undefined)?.flow;
  return isTrust(flow) ? flow : undefined;
}

/** Строки диффа от базы (одобренная версия или шаблон) к новой версии; без базы — весь flow добавленными строками. */
export function trustDiff(flow: Pick<TeamFlowTrust, 'yaml' | 'base'>, context = 3): { rows: DiffRow[]; added: number; removed: number } {
  const lines = lineDiff(flow.base?.yaml ?? '', flow.yaml);
  const stat = diffStat(lines);
  return { rows: diffRows(lines, context), added: stat.add, removed: stat.del };
}
