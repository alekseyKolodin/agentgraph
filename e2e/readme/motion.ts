// Анимированная схема для README: страница e2e/readme/<имя>.html снимается кадрами в реальном времени, из них — GIF.
//   npx tsx e2e/readme/motion.ts routines-motion docs/assets/routines.gif
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const [name = 'routines-motion', out = 'docs/assets/routines.gif'] = process.argv.slice(2);
const html = path.join(path.dirname(fileURLToPath(import.meta.url)), `${name}.html`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-motion-'));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 1 })).newPage();
await page.goto(pathToFileURL(html).href);
await page.waitForTimeout(400);

const frames: Array<{ file: string; at: number }> = [];
let recording = true;
const loop = (async () => {
  for (let i = 0; recording; i++) {
    const file = path.join(dir, `f${String(i).padStart(5, '0')}.png`);
    const at = Date.now();
    await page.screenshot({ path: file, type: 'png' });
    frames.push({ file, at });
  }
})();
await page.evaluate(() => void (window as unknown as { play: () => Promise<void> }).play());
await page.waitForFunction(() => (window as unknown as { __done?: boolean }).__done === true, undefined, { timeout: 120_000 });
recording = false;
await loop;
const end = Date.now();
await browser.close();

const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.at ?? end) - f.at) / 1000).toFixed(3)}`).join('\n');
fs.writeFileSync(path.join(dir, 'frames.txt'), `${list}\nfile '${frames.at(-1)!.file}'\n`);
const filter = 'fps=20,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'frames.txt'), '-filter_complex', filter, '-loop', '0', out]);
console.log(`${path.basename(out)}: ${frames.length} кадров, ${((end - frames[0]!.at) / 1000).toFixed(1)} с, ${(fs.statSync(out).size / 1e6).toFixed(2)} МБ`);
fs.rmSync(dir, { recursive: true, force: true });
