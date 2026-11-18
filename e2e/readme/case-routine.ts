// Ролик README «баг из Slack → тикет и фикс»: настоящий сервер и интерфейс, фейковые Slack и claude (окружение e2e).
//   npx tsx e2e/readme/case-routine.ts docs/assets/case-routine.gif
import { SLACK_APP_TOKEN, SLACK_TOKEN } from '../support/fakes.js';
import { BUG_TITLE, demoEnv } from './demo.js';
import { Stage } from './stage.js';

const out = process.argv[2] ?? 'docs/assets/case-routine.gif';
const e = await demoEnv('case-routine');
try {
  await e.saveSource('slack-bugs', { title: 'Slack · #bugs', kind: 'slack', config: { channels: 'bugs' }, secrets: ['SLACK_TOKEN', 'SLACK_APP_TOKEN'] }, { SLACK_TOKEN, SLACK_APP_TOKEN });
  await e.saveRoutine('bug', {
    title: 'Bug in #bugs → ticket and fix',
    enabled: true,
    when: { source: 'slack-bugs', match: { bot: false }, check: 'A bug report: something in the product is broken. Questions are not bugs.' },
    run: { flow: 'bug-to-fix', pause_before: ['fix'] },
    mode: 'until_pause',
    reply: { to: 'source', on: ['pause', 'end'], draft: true },
  });
  await e.slackReady();

  const s = await Stage.open(e.url, '/', { slackSide: true });
  const app = s.app;
  s.start();
  await s.pause(700);

  await s.caption('A bug report lands in <b>#bugs</b>');
  await s.slack(true);
  const msg = e.slack.say('bugs', BUG_TITLE);
  await s.slackMsg({ who: 'Anna', text: BUG_TITLE, time: '10:42', color: '#c2410c' });
  await s.pause(900);

  await s.caption('The routine checks it, files a ticket and <b>stops before the fix</b>');
  const fix = app.getByRole('button', { name: 'Fix', exact: true });
  await fix.waitFor({ timeout: 30_000 });
  await s.pause(3200);

  await s.caption('You decide — the reply goes out <b>with your answer</b>');
  await s.moveTo(fix);
  await s.pause(1500);
  await s.click(fix, { after: 900 });

  const replies = await e.until(() => (e.slack.repliesTo(msg).length ? e.slack.repliesTo(msg) : undefined), { message: 'no reply in thread' });
  await s.caption('agentgraph answers <b>in the thread</b> and the run goes on');
  await s.slackMsg({ who: 'agentgraph', text: replies[0]!.text, time: '10:43', bot: true, reply: true, color: '#3b5bdb' });
  await s.pause(1200);

  const send = app.getByRole('button', { name: 'Send', exact: true });
  await send.waitFor({ timeout: 40_000 });
  await s.caption('Fixed. The summary waits for your <b>Send</b>');
  await s.pause(1600);
  await s.click(send, { after: 700 });
  await e.until(() => e.slack.repliesTo(msg).length >= 2, { message: 'no summary in thread' });
  await s.slackMsg({ who: 'agentgraph', text: e.slack.repliesTo(msg)[1]!.text, time: '10:51', bot: true, reply: true, color: '#3b5bdb' });
  await s.caption('From a Slack message to a fix — <b>two clicks</b>');
  await s.pause(3600);
  await s.save(out, { fps: 12 });
} finally {
  await e.dispose();
}
