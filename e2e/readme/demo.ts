// Общая подготовка роликов README: окружение e2e с английским flow и сценарием фейкового claude.
import fs from 'node:fs';
import path from 'node:path';
import { E2E, type ClaudeRule } from '../support/env.js';

export const BUG_TITLE = 'Checkout returns 500 for EU cards since yesterday’s release';

const FLOW = `name: bug-to-fix
description: "Triage a bug report into a ticket, then fix it"
input: Triage the bug from the event, file a ticket with acceptance criteria, then fix it.
blocks:
  - name: triage
    title: Triage
    phases:
      - name: triage
        title: Triage
        tools: []
        max_turns: 1
        prompt: |
          [[triage]] {{input}}
  - name: fix
    title: Fix
    phases:
      - name: fix
        title: Fix
        tools: []
        max_turns: 1
        prompt: |
          [[fix]] {{prev}}
`;

const REVIEW_FLOW = `name: mr-review
description: "Read-only review of a merge request"
input: Review the merge request from the event.
blocks:
  - name: review
    title: Review
    phases:
      - name: review
        title: Review
        tools: []
        max_turns: 1
        prompt: |
          [[review]] {{input}}
`;

const TRIAGE = `**ACME-447 · Checkout returns 500 for EU cards**

- Cause: \`formatMoney\` throws on the new \`EUR\` minor-unit table added in release 1.5.2
- Affected: every EU card payment since yesterday 18:40

Acceptance criteria:
1. EU card payments complete
2. A regression test covers \`EUR\`, \`PLN\`, \`SEK\`
3. No change to US formatting`;

export const RULES: ClaudeRule[] = [
  { when: 'Is the staging database', structured: { match: false, duplicate: false, reason: 'A question about staging, not a bug report' } },
  { when: 'You check whether an incoming event', structured: { match: true, duplicate: false, reason: 'A bug report: describes broken behavior' } },
  { when: 'Ты называешь запуск', structured: { title: 'Checkout 500 for EU cards' } },
  { when: 'Ты пишешь короткие итоги', structured: { iteration: 'Fixed the EUR minor-unit table and added a regression test.', run: 'Fixed in branch fix/acme-447: EU card payments complete again, regression test added for EUR, PLN and SEK. Ticket ACME-447.' } },
  { when: '[[triage]]', text: TRIAGE, delayMs: 1800 },
  { when: '[[fix]]', text: 'Fixed in `fix/acme-447`: the EUR minor-unit table, plus a regression test for EUR, PLN and SEK. All 214 tests pass.', delayMs: 3500 },
  { when: '[[review]]', text: 'No blocking findings.', delayMs: 1500 },
];

export async function demoEnv(name: string): Promise<E2E> {
  const e = new E2E(name);
  const flows = path.join(e.agentgraphHome, 'flows');
  for (const f of fs.readdirSync(flows)) fs.rmSync(path.join(flows, f));
  fs.writeFileSync(path.join(flows, 'bug-to-fix.yaml'), FLOW);
  fs.writeFileSync(path.join(flows, 'mr-review.yaml'), REVIEW_FLOW);
  e.scenario(RULES);
  await e.start();
  return e;
}
