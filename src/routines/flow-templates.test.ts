// Готовые flow шаблонов рутин (этап 4.6): шаблоны в templates/flows проходят схему; flow шаблона копируется к flow
// пользователя только если его нет, файлом как есть; свой flow с тем же именем не трогается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTemplateFlow, flowTemplates, flowTemplatesDir, TEMPLATE_FLOW_FOLDER } from './flow-templates.js';
import { parseRoutineYaml } from './schema.js';

const DESK_FLOWS = ['desk-meeting-tasks', 'desk-projects-sweep', 'desk-review-mr', 'desk-task-start'];

test('готовые flow шаблонов: все четыре на месте, проходят схему и с описанием', () => {
  const list = flowTemplates();
  assert.deepEqual(list.map((x) => x.name), DESK_FLOWS);
  for (const x of list) assert.ok(x.description.length > 10, x.name);
});

test('flow шаблона копируется в «Мои дела», если его нет; есть — не трогается', () => {
  const flows = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-flow-tpl-'));
  try {
    const have = new Set<string>();
    const exists = (n: string) => have.has(n);
    const r = ensureTemplateFlow('desk-review-mr', { flows, exists });
    assert.equal(r.copied, true);
    const file = path.join(flows, TEMPLATE_FLOW_FOLDER, 'desk-review-mr.yaml');
    // файлом как есть — с комментариями шаблона
    assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(path.join(flowTemplatesDir(), 'desk-review-mr.yaml'), 'utf8'));
    // свой flow с тем же именем (поправленный) не перезаписывается
    fs.writeFileSync(file, 'мой');
    assert.equal(ensureTemplateFlow('desk-review-mr', { flows, exists }).copied, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'мой');
    have.add('desk-task-start');
    assert.deepEqual(ensureTemplateFlow('desk-task-start', { flows, exists }), { flow: 'desk-task-start', copied: false });
    assert.equal(fs.existsSync(path.join(flows, TEMPLATE_FLOW_FOLDER, 'desk-task-start.yaml')), false);
  } finally {
    fs.rmSync(flows, { recursive: true, force: true });
  }
});

test('flow шаблона: чужое имя и путь — ошибка, файл не пишется', () => {
  const flows = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-flow-tpl-'));
  try {
    assert.throws(() => ensureTemplateFlow('nope', { flows, exists: () => false }), /нет среди шаблонов/);
    assert.throws(() => ensureTemplateFlow('../evil', { flows, exists: () => false }), /Недопустимое имя flow/);
    assert.equal(fs.existsSync(path.join(flows, TEMPLATE_FLOW_FOLDER)), false);
  } finally {
    fs.rmSync(flows, { recursive: true, force: true });
  }
});

test('правила четырёх шаблонов «Моих дел» проходят схему рутины', () => {
  const rules = [
    'title: Ревью\nwhen: { source: gitlab, match: { event: review } }\nrun: { flow: desk-review-mr }\nmode: suggest\nreply: { to: source, on: [end], draft: true }\ntask: { kind: Ревью, same: thing }\n',
    'title: Ревью из Slack\nwhen: { source: slack-claude, match: { "text~": [/merge_requests/, /pull/] } }\nrun: { flow: desk-review-mr }\nmode: suggest\nreply: { to: none }\ntask: { kind: Ревью, same: thing }\n',
    'title: Jira\nwhen: { source: jira, match: { change: [assigned, new] } }\nrun: { flow: desk-task-start }\nmode: suggest\nreply: { to: none }\ntask: { kind: Jira, same: thing }\n',
    'title: Встречи\nwhen: { source: fireflies }\nrun: { flow: desk-meeting-tasks, input: Заведи дела }\nmode: auto\nlimits: { usd: 1 }\nreply: { to: none }\ntask: { kind: Встреча, from: flow, same: thing }\n',
  ];
  for (const y of rules) assert.deepEqual(parseRoutineYaml(y).problems, [], y);
});
