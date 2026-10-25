// Лимиты подписки claude.ai для главной: 5-часовое и недельное окна, как в /usage Claude Code.
// Берём через Agent SDK: сессия без промпта, только запрос usage (к модели не обращается), потом закрываем.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LimitWindow, Limits } from './api-types.js';
import { claudeExecutable } from './agent.js';

export type { LimitWindow, Limits } from './api-types.js';

/** Чаще раза в минуту не спрашиваем: каждый запрос — запуск процесса Claude Code. */
const TTL_MS = 60_000;
let cached: Limits | null = null;
let inflight: Promise<Limits> | null = null;

export function getLimits(force = false): Promise<Limits> {
  if (!force && cached && Date.now() - new Date(cached.at).getTime() < TTL_MS) return Promise.resolve(cached);
  inflight ??= fetchLimits()
    .then((l) => (cached = l))
    .finally(() => { inflight = null; });
  return inflight;
}

async function* noPrompt(): AsyncGenerator<never> {
  // потоковый ввод, который ничего не присылает: сессия ждёт, пока мы спрашиваем usage
  await new Promise(() => {});
}

async function fetchLimits(): Promise<Limits> {
  const q = query({
    prompt: noPrompt(),
    options: { ...claudeExecutable(), persistSession: false, env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'agentgraph/0.1.0' } },
  });
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const rl = u.rate_limits_available ? u.rate_limits : null;
    return {
      available: Boolean(rl),
      subscription: u.subscription_type,
      fiveHour: limitWindow(rl?.five_hour),
      weekly: limitWindow(rl?.seven_day),
      at: new Date().toISOString(),
    };
  } finally {
    q.close();
  }
}

function limitWindow(w: { utilization: number | null; resets_at: string | null } | null | undefined): LimitWindow | null {
  return w ? { percent: w.utilization, resetsAt: w.resets_at } : null;
}
