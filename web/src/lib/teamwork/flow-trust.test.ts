import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TeamFlowTrust } from '@server/api-types';
import { trustDiff, untrustedFlow } from './flow-trust';

const FLOW: TeamFlowTrust = { team: 'pay', name: 'teamwork-prd', hash: 'h', yaml: 'a\nb2\nc\n', base: { kind: 'template', yaml: 'a\nb\nc\n' }, commands: ['npm test'], tools: ['Bash'] };
const err = (status: number, code: string | undefined, data: unknown) => ({ status, code, data });

test('409 flow_untrusted с flow в теле — что показать в диалоге; другие ошибки и битое тело — нет', () => {
  assert.deepEqual(untrustedFlow(err(409, 'flow_untrusted', { error: 'x', code: 'flow_untrusted', flow: FLOW })), FLOW);
  assert.equal(untrustedFlow(err(409, 'conflict', { flow: FLOW })), undefined);
  assert.equal(untrustedFlow(err(400, 'flow_untrusted', { flow: FLOW })), undefined);
  assert.equal(untrustedFlow(err(409, 'flow_untrusted', { flow: { ...FLOW, commands: 'npm test' } })), undefined);
  assert.equal(untrustedFlow(err(409, 'flow_untrusted', { flow: { ...FLOW, base: { kind: 'trusted' } } })), undefined);
  assert.equal(untrustedFlow(err(409, 'flow_untrusted', null)), undefined);
  assert.equal(untrustedFlow(new Error('сеть')), undefined);
  assert.equal(untrustedFlow(undefined), undefined);
});

test('дифф диалога: от базы к новой версии со счётом строк; без базы — весь flow добавленными строками', () => {
  const d = trustDiff(FLOW);
  assert.deepEqual([d.added, d.removed], [1, 1]);
  assert.deepEqual(d.rows, [{ op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'b2' }, { op: ' ', text: 'c' }]);
  const fresh = trustDiff({ yaml: 'x\ny\n' });
  assert.deepEqual([fresh.added, fresh.removed], [2, 0]);
  assert.ok(fresh.rows.every((r) => 'op' in r && r.op === '+'));
  // длинный неизменённый кусок свёрнут
  const long = trustDiff({ yaml: `${Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')}\nnew\n`, base: { kind: 'trusted', yaml: `${Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')}\n` } }, 2);
  assert.ok(long.rows.some((r) => 'skip' in r && r.skip === 28));
});
