// Запись роликов для README: настоящий сервер и интерфейс agentgraph (окружение e2e, e2e/support/env.ts) в «окне» на
// сцене. Сцена — страница с фоном, рамкой окна, подписью и курсором; интерфейс — iframe внутри рамки. Кадры — снимки
// сцены подряд, из них ffmpeg собирает GIF. Всё внутри окна — настоящий UI; подпись, курсор и панель Slack рисует сцена.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Frame, type FrameLocator, type Locator, type Page } from '@playwright/test';

export const STAGE_W = 1200;
export const STAGE_H = 760;
/** Окно: отступы сцены и высота заголовка. */
const WIN = { x: 30, y: 22, w: 1140, h: 664, bar: 30 };
/** Узкое окно и Slack отдельной карточкой справа (ролик с перепиской). */
const WIN_SIDE = { ...WIN, x: 24, w: 834 };
type Win = typeof WIN;

const stageHtml = (WIN: Win, side: boolean) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${STAGE_W}px;height:${STAGE_H}px;overflow:hidden;font-family:-apple-system,"SF Pro Text","Inter",system-ui,sans-serif}
  body{background:radial-gradient(1200px 520px at 50% -8%,#1d2242 0%,#12142a 46%,#0b0c18 100%)}
  .win{position:absolute;left:${WIN.x}px;top:${WIN.y}px;width:${WIN.w}px;height:${WIN.h}px;border-radius:12px;overflow:hidden;
    background:#0e0f13;box-shadow:0 0 0 1px rgba(255,255,255,.09),0 30px 70px rgba(0,0,0,.55)}
  .bar{height:${WIN.bar}px;background:#1b1c22;display:flex;align-items:center;justify-content:center;position:relative;
    color:#8b8f9c;font-size:12.5px;letter-spacing:.01em;border-bottom:1px solid rgba(255,255,255,.06)}
  .dots{position:absolute;left:13px;top:9px;display:flex;gap:8px}
  .dots i{width:12px;height:12px;border-radius:50%;display:block}
  .dots i:nth-child(1){background:#ff5f57}.dots i:nth-child(2){background:#febc2e}.dots i:nth-child(3){background:#28c840}
  iframe{display:block;border:0;width:${WIN.w}px;height:${WIN.h - WIN.bar}px;background:#0e0f13}
  .cap{position:absolute;left:0;right:0;bottom:17px;text-align:center;color:#e9eaf0;font-size:19px;font-weight:600;
    letter-spacing:-.01em;opacity:0;transform:translateY(6px);transition:opacity .35s ease,transform .35s ease}
  .cap.on{opacity:1;transform:none}
  .cap b{color:#8fb0ff;font-weight:600}
  .cur{position:absolute;left:0;top:0;width:22px;height:22px;z-index:20;pointer-events:none;transform:translate(600px,420px);
    transition:transform .6s cubic-bezier(.3,.7,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))}
  .rip{position:absolute;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;z-index:19;pointer-events:none;
    border:2px solid #8fb0ff;opacity:0}
  .rip.go{animation:rip .5s ease-out}
  @keyframes rip{0%{opacity:.9;scale:.3}100%{opacity:0;scale:1.25}}
  .slack{position:absolute;${side ? `left:${WIN.x + WIN.w + 18}px;top:${WIN.y + 96}px;width:${STAGE_W - WIN.x - WIN.w - 18 - 24}px` : `right:${STAGE_W - WIN.x - WIN.w + 18}px;bottom:${STAGE_H - WIN.y - WIN.h + 18}px;width:372px`};z-index:10;
    background:#1a1d21;border:1px solid rgba(255,255,255,.13);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.6);
    color:#d1d2d3;font-size:13.5px;line-height:1.42;opacity:0;transform:translateY(14px) scale(.98);
    transition:opacity .4s ease,transform .4s cubic-bezier(.2,.8,.2,1);pointer-events:none}
  .slack.on{opacity:1;transform:none}
  .slack header{display:flex;align-items:center;gap:8px;padding:9px 13px;border-bottom:1px solid rgba(255,255,255,.09);
    font-weight:700;color:#fff;font-size:13px}
  .slack header span{margin-left:auto;font-weight:500;color:#8b8f9c;font-size:11px}
  .slack .hash{color:#8b8f9c;font-weight:500}
  .msgs{padding:10px 13px 12px;display:flex;flex-direction:column;gap:9px}
  .m{display:flex;gap:9px;animation:in .45s cubic-bezier(.2,.8,.2,1)}
  .m.reply{margin-left:22px;padding-left:10px;border-left:2px solid rgba(255,255,255,.14)}
  @keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .av{flex:none;width:30px;height:30px;border-radius:7px;display:grid;place-items:center;font-weight:700;font-size:13px;color:#fff}
  .m b{color:#fff;font-size:13px}.m time{color:#8b8f9c;font-size:11px;margin-left:6px}
  .m .app{font-size:10px;background:rgba(255,255,255,.12);color:#c9cbd1;border-radius:3px;padding:0 4px;margin-left:5px;font-weight:600}
  .m p{margin:1px 0 0}
</style></head><body>
  <div class="win"><div class="bar"><div class="dots"><i></i><i></i><i></i></div>AgentGraph</div><iframe id="app"></iframe></div>
  <div class="slack" id="slack"><header><span class="hash" style="margin:0">#</span>bugs<span>Slack</span></header><div class="msgs" id="msgs"></div></div>
  <div class="cap" id="cap"></div>
  <div class="rip" id="rip"></div>
  <svg class="cur" id="cur" viewBox="0 0 22 22"><path d="M3 2l15 8.2-6.6 1.5L8.6 18z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>
</body></html>`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Stage {
  private frames: Array<{ file: string; at: number }> = [];
  private recording = false;
  private loop?: Promise<void>;
  private dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-readme-'));
  private pos = { x: 600, y: 420 };

  private constructor(
    private browser: Browser,
    readonly page: Page,
    private origin: string,
  ) {}

  /** Сцена с интерфейсом по адресу сервера; язык интерфейса — английский. */
  static async open(origin: string, startPath = '/', o: { slackSide?: boolean; hidePanel?: boolean } = {}): Promise<Stage> {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: STAGE_W, height: STAGE_H }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'dark' });
    // страница приложения запрещает встраивание (frame-ancestors 'none'): для записи заголовок снимается
    await context.route(
      (u) => u.origin === origin,
      async (route) => {
        if (route.request().resourceType() !== 'document') return route.continue();
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers['content-security-policy'];
        await route.fulfill({ response: res, headers });
      },
    );
    await context.addInitScript((hide) => {
      try {
        localStorage.setItem('agentgraph.lang', 'en');
        if (hide) localStorage.setItem('agentgraph.sidePanelHidden', 'true');
      } catch {
        /* сцена: about:blank без localStorage */
      }
    }, Boolean(o.hidePanel ?? o.slackSide));
    const page = await context.newPage();
    await page.setContent(stageHtml(o.slackSide ? WIN_SIDE : WIN, Boolean(o.slackSide)));
    const stage = new Stage(browser, page, origin);
    await stage.goto(startPath);
    return stage;
  }

  /** Интерфейс внутри окна. */
  get app(): FrameLocator {
    return this.page.frameLocator('#app');
  }

  get frame(): Frame {
    return this.page.frames().find((f) => f.url().startsWith(this.origin))!;
  }

  async goto(p: string): Promise<void> {
    await this.page.evaluate((src) => ((document.getElementById('app') as HTMLIFrameElement).src = src), this.origin + p);
    await this.page.waitForFunction((o) => Array.from(window.frames).length > 0 && (document.getElementById('app') as HTMLIFrameElement).src.startsWith(o), this.origin);
    await this.app.locator('body').waitFor();
    await sleep(600);
  }

  // ------------------------------------------------------------ запись

  start(): void {
    this.recording = true;
    this.loop = (async () => {
      let i = 0;
      while (this.recording) {
        const file = path.join(this.dir, `f${String(i++).padStart(5, '0')}.png`);
        const at = Date.now();
        await this.page.screenshot({ path: file, type: 'png' });
        this.frames.push({ file, at });
      }
    })();
  }

  /** Остановить запись и собрать GIF. */
  async save(out: string, o: { fps?: number; colors?: number } = {}): Promise<void> {
    this.recording = false;
    await this.loop;
    const end = Date.now();
    const list = this.frames.map((f, i) => `file '${f.file}'\nduration ${(((this.frames[i + 1]?.at ?? end) - f.at) / 1000).toFixed(3)}`).join('\n');
    const concat = path.join(this.dir, 'frames.txt');
    fs.writeFileSync(concat, `${list}\nfile '${this.frames.at(-1)!.file}'\n`);
    const fps = o.fps ?? 12;
    const filter = `fps=${fps},split[a][b];[a]palettegen=max_colors=${o.colors ?? 160}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-filter_complex', filter, '-loop', '0', out]);
    console.log(`${path.basename(out)}: ${this.frames.length} кадров, ${((end - this.frames[0]!.at) / 1000).toFixed(1)} с, ${(fs.statSync(out).size / 1e6).toFixed(2)} МБ`);
    await this.browser.close();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Один кадр сцены в PNG (для статичных картинок). */
  async shot(out: string): Promise<void> {
    await this.page.screenshot({ path: out, type: 'png' });
  }

  async close(): Promise<void> {
    this.recording = false;
    await this.loop;
    await this.browser.close();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  // ------------------------------------------------------------ подпись, курсор, действия

  async caption(html: string): Promise<void> {
    await this.page.evaluate(async (t) => {
      const c = document.getElementById('cap')!;
      if (c.classList.contains('on')) {
        c.classList.remove('on');
        await new Promise((r) => setTimeout(r, 300));
      }
      c.innerHTML = t;
      if (t) c.classList.add('on');
    }, html);
  }

  pause(ms: number): Promise<void> {
    return sleep(ms);
  }

  /** Курсор — к центру элемента (или к его точке dx, dy от левого верхнего угла). */
  async moveTo(target: Locator, o: { dx?: number; dy?: number } = {}): Promise<{ x: number; y: number }> {
    await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(650);
    const b = await target.boundingBox();
    if (!b) throw new Error('элемент не виден');
    const x = b.x + (o.dx ?? b.width / 2);
    const y = b.y + (o.dy ?? b.height / 2);
    const dist = Math.hypot(x - this.pos.x, y - this.pos.y);
    const ms = Math.round(Math.min(800, Math.max(350, dist * 1.3)));
    await this.page.evaluate(
      ([cx, cy, d]) => {
        const c = document.getElementById('cur')!;
        c.style.transitionDuration = `${d}ms`;
        c.style.transform = `translate(${cx! - 3}px,${cy! - 2}px)`;
      },
      [x, y, ms],
    );
    await this.page.mouse.move(x, y, { steps: 8 });
    await sleep(ms + 80);
    this.pos = { x, y };
    return this.pos;
  }

  async click(target: Locator, o: { dx?: number; dy?: number; after?: number } = {}): Promise<void> {
    const { x, y } = await this.moveTo(target, o);
    await this.page.evaluate(
      ([cx, cy]) => {
        const r = document.getElementById('rip')!;
        r.style.left = `${cx}px`;
        r.style.top = `${cy}px`;
        r.classList.remove('go');
        void r.offsetWidth;
        r.classList.add('go');
      },
      [x, y],
    );
    await sleep(140);
    await this.page.mouse.click(x, y);
    await sleep(o.after ?? 500);
  }

  async type(target: Locator, text: string, delay = 28, o: { clear?: boolean } = {}): Promise<void> {
    await this.click(target, { after: 150 });
    if (o.clear) {
      await target.press('ControlOrMeta+a');
      await sleep(250);
    }
    await target.pressSequentially(text, { delay });
    await sleep(350);
  }

  // ------------------------------------------------------------ панель Slack (рисует сцена по данным фейкового Slack)

  async slack(on: boolean): Promise<void> {
    await this.page.evaluate((v) => document.getElementById('slack')!.classList.toggle('on', v), on);
    await sleep(450);
  }

  async slackMsg(m: { who: string; text: string; time: string; bot?: boolean; reply?: boolean; color?: string }): Promise<void> {
    await this.page.evaluate((x) => {
      const el = document.createElement('div');
      el.className = `m${x.reply ? ' reply' : ''}`;
      const av = document.createElement('div');
      av.className = 'av';
      av.style.background = x.color ?? '#4a6cf7';
      av.textContent = x.bot ? '↯' : x.who[0]!;
      const body = document.createElement('div');
      const head = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = x.who;
      head.append(b);
      if (x.bot) {
        const app = document.createElement('span');
        app.className = 'app';
        app.textContent = 'APP';
        head.append(app);
      }
      const t = document.createElement('time');
      t.textContent = x.time;
      head.append(t);
      const p = document.createElement('p');
      p.textContent = x.text;
      body.append(head, p);
      el.append(av, body);
      document.getElementById('msgs')!.append(el);
    }, m);
    await sleep(500);
  }
}
