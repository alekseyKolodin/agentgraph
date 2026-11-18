// Ролик README «новая рутина в четыре шага»: настоящий интерфейс на окружении e2e.
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

  await s.click(app.getByRole('region', { name: 'What triggers it' }).getByRole('button', { name: /^Slack · #bugs/ }), { after: 900 });
  await s.caption('Field conditions cost nothing. A check <b>in your own words</b> is optional');
  await s.click(app.getByRole('button', { name: '+ check in words' }), { after: 500 });
  await s.type(app.getByLabel('If'), 'A bug report: something in the product is broken. Questions are not bugs.', 22);
  await s.pause(700);

  const s3 = app.getByRole('region', { name: 'What to run' });
  await s.caption('Pick the flow and where it <b>waits for you</b>');
  await s.click(s3.getByRole('button', { name: /^bug-to-fix/ }), { after: 800 });
  await s.click(s3.getByRole('group', { name: 'When to wait for me' }).getByRole('button', { name: 'before a block' }), { after: 1100 });

  await s.caption('The result goes back to the thread <b>after your review</b>, right away, or not at all');
  await s.click(app.getByRole('region', { name: 'Report the result' }).getByRole('button', { name: /^After my review/ }), { after: 1300 });

  const summary = app.getByRole('complementary', { name: 'What you get' });
  await s.caption('The whole rule reads as <b>one sentence</b>');
  await s.type(summary.getByLabel('Name'), 'Bug in #bugs → ticket and fix', 30, { clear: true });
  await s.pause(1500);
  await s.click(summary.getByRole('button', { name: 'Check and turn on' }), { after: 1200 });
  await s.caption('Before turning it on: what it <b>would have done</b> on recent events');
  await s.pause(4200);
  await s.save(out, { fps: 12 });
} finally {
  await e.dispose();
}
