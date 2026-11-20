// Ролик README «новая рутина по разделам»: настоящий интерфейс на окружении e2e (английский интерфейс). Разделы «When ·
// What to do · How I find out» слева, проверка на истории справа.
//   npx tsx e2e/readme/routine-new.ts docs/assets/routine-new.gif
import { SLACK_APP_TOKEN, SLACK_TOKEN } from '../support/fakes.js';
import { demoEnv } from './demo.js';
import { Stage } from './stage.js';

const out = process.argv[2] ?? 'docs/assets/routine-new.gif';
const e = await demoEnv('routine-new');
try {
  await e.saveSource('slack-bugs', { title: 'Slack · #bugs', kind: 'slack', config: { channels: 'bugs' }, secrets: ['SLACK_TOKEN', 'SLACK_APP_TOKEN'] }, { SLACK_TOKEN, SLACK_APP_TOKEN });
  // история для проверки правила: три сообщения в канале до создания рутины
  for (const t of ['Invoice PDF is blank for annual plans', 'Is the staging database being reset tonight?', 'Checkout returns 500 for EU cards']) e.slack.say('bugs', t);

  const s = await Stage.open(e.url, '/routines/new', { hidePanel: true });
  const app = s.app;
  s.start();
  await s.pause(600);
  await s.caption('A routine is a rule: <b>when</b> something happens, <b>run</b> a flow');
  await s.pause(1400);

  const when = app.getByRole('region', { name: 'When' });
  await s.click(when.getByRole('group', { name: 'What triggers it' }).getByRole('button', { name: /^Slack · #bugs/ }), { after: 900 });
  await s.caption('Field conditions cost nothing. A check <b>in your own words</b> is optional');
  await s.type(when.getByLabel('Condition for AI'), 'A bug report: something in the product is broken. Questions are not bugs.', 22);
  await s.pause(700);

  const what = app.getByRole('region', { name: 'What to do' });
  await s.caption('Pick the flow and where it <b>waits for you</b>');
  await s.click(what.getByRole('button', { name: /^Flow\b/ }), { after: 500 });
  await s.click(app.getByRole('option', { name: /^bug-to-fix/ }), { after: 800 });
  await s.click(what.getByRole('group', { name: 'Run' }).getByRole('button', { name: 'now, but stop before a block', exact: true }), { after: 1100 });

  await s.caption('The result goes back to the thread <b>after your review</b> or right away');
  await s.click(app.getByRole('region', { name: 'How I find out' }).getByRole('group', { name: 'How the reply goes out' }).getByRole('button', { name: 'after review', exact: true }), { after: 1300 });

  await s.type(app.getByLabel('Name', { exact: true }), 'Bug in #bugs → ticket and fix', 30, { clear: true });
  await s.caption('Before turning it on: what it <b>would have done</b> on recent events');
  await s.click(app.getByRole('complementary', { name: 'History check' }).getByRole('button', { name: 'Check on history' }), { after: 4200 });
  await s.click(app.getByRole('button', { name: 'Turn on', exact: true }), { after: 1500 });
  await s.save(out, { fps: 12 });
} finally {
  await e.dispose();
}
