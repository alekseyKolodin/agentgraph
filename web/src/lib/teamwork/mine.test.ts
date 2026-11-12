import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TeamMine, TeamMineProject, TeamMineTeam } from '@server/api-types';
import { task } from './fixtures';
import { canSendToWork, myTaskRows, unknownMe, workHref } from './mine';

const team = (slug: string, over: Partial<TeamMineTeam> = {}): TeamMineTeam => ({ slug, title: slug, prefix: 'PAY', flows: [], me: 'alex@x.io', ...over });
const project = (t: string, slug: string): TeamMineProject => ({ team: t, slug, title: slug, sprint: { number: 1, title: 'Спринт 1' }, repos: [] });

test('мои задачи: готовые — только числом; ждущие ответа и упавшие — первыми, дальше «В работе», «Ревью», «К работе»', () => {
  const mine: TeamMine = {
    teams: [team('pay'), team('ops', { prefix: 'OPS' })],
    projects: [project('pay', 'export'), project('ops', 'infra')],
    tasks: [
      { team: 'pay', project: 'export', task: task({ id: 'PAY-1' }), waiting: ['PAY-9'] },
      { team: 'pay', project: 'export', task: task({ id: 'PAY-2', status: 'done' }), waiting: [] },
      { team: 'pay', project: 'export', task: task({ id: 'PAY-3', status: 'review' }), waiting: [] },
      { team: 'ops', project: 'infra', task: task({ id: 'OPS-1', status: 'in_progress' }), waiting: [] },
      { team: 'ops', project: 'infra', task: task({ id: 'OPS-2', work: [{ kind: 'run', id: 'r1', at: '2026-11-12T10:00:00Z', status: 'waiting' }] }), waiting: [] },
      { team: 'pay', project: 'export', task: task({ id: 'PAY-4', status: 'in_progress', work: [{ kind: 'run', id: 'r2', at: '2026-11-12T10:00:00Z', status: 'failed' }] }), waiting: [] },
      { team: 'pay', project: 'export', task: task({ id: 'PAY-5', status: 'in_progress', work: [{ kind: 'session', id: 's1', at: '2026-11-12T10:00:00Z', status: 'working' }] }), waiting: [] },
    ],
  };
  const { rows, done } = myTaskRows(mine);
  assert.equal(done, 1);
  assert.deepEqual(rows.map((r) => r.key), ['ops/OPS-2', 'pay/PAY-4', 'ops/OPS-1', 'pay/PAY-5', 'pay/PAY-3', 'pay/PAY-1']);
  assert.deepEqual(rows.map((r) => r.badge?.state ?? ''), ['waiting', 'failed', '', 'working', '', '']);
  assert.deepEqual(rows.at(-1)!.waiting, ['PAY-9']);
  assert.equal(rows[0]!.team.prefix, 'OPS');
  assert.equal(rows[0]!.project.slug, 'infra');
});

test('мои задачи: задача без команды или проекта в ответе пропускается; пустой ответ — пусто', () => {
  assert.deepEqual(myTaskRows({ teams: [], projects: [], tasks: [] }), { rows: [], done: 0 });
  const r = myTaskRows({ teams: [team('pay')], projects: [], tasks: [{ team: 'pay', project: 'export', task: task({ id: 'PAY-1' }), waiting: [] }] });
  assert.deepEqual(r.rows, []);
});

test('мои задачи: «В работу ▸» — как на карточке доски; адрес запуска и сессии; команды без моего email', () => {
  assert.equal(canSendToWork({ task: task({ id: 'A' }) }), true);
  assert.equal(canSendToWork({ task: task({ id: 'A', status: 'review' }) }), false);
  assert.equal(canSendToWork({ task: task({ id: 'A', error: 'битый' }) }), false);
  assert.equal(canSendToWork({ task: task({ id: 'A' }), team: { readonly: true } }), false);
  const w = { kind: 'run' as const, id: 'r', at: '' };
  assert.equal(canSendToWork({ task: task({ id: 'A', status: 'in_progress' }), badge: { state: 'working', text: '', work: w } }), false);
  assert.equal(canSendToWork({ task: task({ id: 'A', status: 'in_progress' }), badge: { state: 'failed', text: '', work: w } }), true);
  assert.equal(workHref({ kind: 'run', id: '2026-11-12 a' }), '/run/2026-11-12%20a');
  assert.equal(workHref({ kind: 'session', id: 's1' }), '/sessions/s1');
  assert.deepEqual(unknownMe({ teams: [team('a'), team('b', { me: undefined }), team('c', { me: undefined, error: 'не читается' })], projects: [], tasks: [] }).map((x) => x.slug), ['b']);
});
