// Ролик README «подключить любой сервис словами»: настоящий интерфейс на окружении e2e; сервис — фейковый HTTP.
//   npx tsx e2e/readme/routine-connect.ts docs/assets/routine-connect.gif
import { FAKE_API_KEY } from '../support/fakes.js';
import { RULES, demoEnv } from './demo.js';
import { Stage } from './stage.js';

const out = process.argv[2] ?? 'docs/assets/routine-connect.gif';
const e = await demoEnv('routine-connect');
try {
  e.items.add({ id: 'm-103', title: 'Billing planning · Q1 roadmap', text: 'Decided: ship annual invoices first. Action items: 4' });
  e.items.add({ id: 'm-102', title: 'Incident review: EU checkout', text: 'Root cause: currency table. Action items: 3' });
  e.items.add({ id: 'm-101', title: 'Weekly sync with design', text: 'New onboarding flow approved. Action items: 2' });
  e.scenario([
    {
      when: 'Ты подключаешь внешний сервис',
      delayMs: 3200,
      structured: {
        api_found: true,
        reason: 'Fireflies has a GraphQL API with a transcripts query',
        title: 'Fireflies · meetings',
        command: `curl -s ${e.items.base}/items -H "Authorization: Bearer $FIREFLIES_API_KEY"`,
        every: '5m',
        map_items: 'items',
        map_id: 'id',
        map_title: 'title',
        map_text: 'text',
        map_at: 'at',
        secrets: ['FIREFLIES_API_KEY'],
        how_to: 'Fireflies → Settings → Developer settings → API key.',
      },
    },
    ...RULES,
  ]);

  const s = await Stage.open(e.url, '/routines/connect', { hidePanel: true });
  const app = s.app;
  s.start();
  await s.pause(600);
  await s.caption('Not on the list? <b>Describe the service in words</b>');
  await s.type(app.getByLabel('What should trigger the routine'), 'A new meeting recording in Fireflies.ai', 30);
  await s.click(app.getByRole('button', { name: 'Find', exact: true }), { after: 700 });
  await s.caption('An agent finds the API and builds the check');
  const key = app.getByLabel(/API key is needed/);
  await key.waitFor({ timeout: 30_000 });
  await s.pause(900);
  await s.caption('It asks for a key — stored <b>outside</b> the source file');
  await s.type(key, FAKE_API_KEY, 35);
  await s.click(app.getByRole('button', { name: 'Save and check' }), { after: 600 });
  const ready = app.getByRole('region', { name: 'Source is ready' });
  await ready.waitFor({ timeout: 30_000 });
  await s.caption('The check itself runs <b>without a model</b>. Here is what it found');
  await s.pause(3400);
  await s.caption('Every new record is now an event <b>any routine</b> can start from');
  await s.click(ready.getByRole('button', { name: 'Save source' }), { after: 1200 });
  await s.pause(3200);
  await s.save(out, { fps: 12 });
} finally {
  await e.dispose();
}
