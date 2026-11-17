// Окружение одного e2e-теста: временная папка (настройки, flows, runs, HOME, проект), фейковые Slack, Telegram и HTTP,
// фейковый claude со сценарием и настоящий сервер agentgraph на свободном порту. ~/.agentgraph пользователя не трогается:
// AGENTGRAPH_CONFIG_DIR, AGENTGRAPH_HOME и HOME смотрят во временную папку.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import type { LogEntry, RoutineSpec, RoutineView, RoutinesOverview, SourceSpec } from '../../src/routines/types.js';
import { FAKE_API_KEY, FakeItems, FakeSlack, FakeTelegram, SLACK_APP_TOKEN, SLACK_TOKEN, TELEGRAM_TOKEN } from './fakes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE_CLAUDE = path.join(ROOT, 'e2e/support/fake-claude.mjs');

/** Правило фейкового claude: подстрока промпта или системного промпта → ответ. */
export type ClaudeRule = { when: string; text?: string; structured?: unknown; delayMs?: number; error?: string; costUsd?: number };
export type ClaudeCall = { at: string; model: string; system: string; prompt: string; schema: boolean; answer: unknown };

/** Тестовый flow: triage → fix. Маркеры [[triage]]/[[fix]] — по ним отвечает фейковый claude. */
const BUGFIX_FLOW = `name: bugfix
description: "e2e: разбор бага и фикс"
input: Разобрать баг из события и починить.
blocks:
  - name: triage
    title: Разбор
    phases:
      - name: triage
        title: Разбор
        tools: []
        max_turns: 1
        prompt: |
          [[triage]] {{input}}
  - name: fix
    title: Фикс
    phases:
      - name: fix
        title: Фикс
        tools: []
        max_turns: 1
        prompt: |
          [[fix]] {{prev}}
`;

const DIGEST_FLOW = `name: digest
description: "e2e: утренняя сводка"
input: Сводка за утро.
blocks:
  - name: digest
    phases:
      - name: digest
        tools: []
        max_turns: 1
        prompt: |
          [[digest]] {{input}}
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export class E2E {
  url = '';
  readonly dir: string;
  readonly configDir: string;
  readonly home: string;
  readonly project: string;
  readonly scenarioFile: string;
  readonly claudeLog: string;
  readonly slack = new FakeSlack();
  readonly tg = new FakeTelegram();
  readonly items = new FakeItems();
  /** stdout и stderr сервера — во вложение упавшего теста. */
  serverLog = '';
  private proc?: ChildProcess;
  private port = 0;

  constructor(readonly name: string) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-e2e-'));
    this.configDir = path.join(this.dir, 'config');
    this.home = path.join(this.dir, 'home');
    this.project = path.join(this.dir, 'project');
    this.scenarioFile = path.join(this.dir, 'claude-scenario.json');
    this.claudeLog = path.join(this.dir, 'claude-calls.jsonl');
    for (const d of [this.configDir, this.home, this.project, path.join(this.dir, 'agentgraph-home', 'flows'), path.join(this.dir, 'agentgraph-home', 'runs')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'agentgraph-home', 'flows', 'bugfix.yaml'), BUGFIX_FLOW);
    fs.writeFileSync(path.join(this.dir, 'agentgraph-home', 'flows', 'digest.yaml'), DIGEST_FLOW);
    fs.writeFileSync(path.join(this.project, 'README.md'), '# e2e project\n');
    this.scenario([]);
  }

  get agentgraphHome(): string {
    return path.join(this.dir, 'agentgraph-home');
  }

  get stateDir(): string {
    return path.join(this.configDir, 'routines-state');
  }

  async start(): Promise<void> {
    await Promise.all([this.slack.start(), this.tg.start(), this.items.start()]);
    this.port = await freePort();
    await this.startServer();
  }

  async startServer(): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.home,
      TMPDIR: process.env.TMPDIR,
      LANG: 'ru_RU.UTF-8',
      TZ: process.env.TZ,
      AGENTGRAPH_CONFIG_DIR: this.configDir,
      AGENTGRAPH_HOME: this.agentgraphHome,
      AGENTGRAPH_NO_UPDATE_CHECK: '1',
      AGENTGRAPH_CLAUDE_EXECUTABLE: FAKE_CLAUDE,
      AGENTGRAPH_SLACK_API: this.slack.base,
      AGENTGRAPH_TELEGRAM_API: this.tg.base,
      FAKE_CLAUDE_SCENARIO: this.scenarioFile,
      FAKE_CLAUDE_LOG: this.claudeLog,
      FAKE_HTTP_BASE: this.items.base,
      E2E_PORT: String(this.port),
      E2E_PROJECT: this.project,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const proc = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'e2e/support/serve.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.url = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`сервер не поднялся за 30 с:\n${this.serverLog}`)), 30_000);
      const onData = (chunk: Buffer) => {
        const s = chunk.toString();
        this.serverLog += s;
        const m = s.match(/READY (\S+)/);
        if (m) {
          clearTimeout(t);
          resolve(m[1]!);
        }
      };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', (c: Buffer) => (this.serverLog += c.toString()));
      proc.on('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`сервер вышел с кодом ${code}:\n${this.serverLog}`));
      });
    });
  }

  async stopServer(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        p.kill('SIGKILL');
        resolve();
      }, 10_000);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      p.kill('SIGTERM');
    });
    this.proc = undefined;
  }

  /** Перезапуск на тех же папках и порту: «приложение закрыли и открыли». between — что поменять, пока сервер лежит. */
  async restart(between?: () => void | Promise<void>): Promise<void> {
    await this.stopServer();
    await between?.();
    await this.startServer();
  }

  async dispose(): Promise<void> {
    await this.stopServer();
    await Promise.all([this.slack.stop(), this.tg.stop(), this.items.stop()]);
    // фейковый claude, запущенный сервером, может ещё дописывать лог: удаление с повторами, сбой уборки тест не роняет
    if (!process.env.E2E_KEEP) {
      try {
        fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* временная папка останется в TMPDIR */
      }
    }
  }

  // ------------------------------------------------------------ фейковый claude

  scenario(rules: ClaudeRule[]): void {
    fs.writeFileSync(this.scenarioFile, JSON.stringify({ rules }));
  }

  claudeCalls(): ClaudeCall[] {
    if (!fs.existsSync(this.claudeLog)) return [];
    return fs.readFileSync(this.claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ClaudeCall);
  }

  /** Вызовы проверки словами (haiku, src/routines/check.ts). */
  checkCalls(): ClaudeCall[] {
    return this.claudeCalls().filter((c) => c.system.startsWith('You check whether an incoming event'));
  }

  // ------------------------------------------------------------ API

  async api<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url + p, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw Object.assign(new Error(`${method} ${p} → ${res.status}: ${text}`), { status: res.status, json });
    return json as T;
  }

  overview(): Promise<RoutinesOverview> {
    return this.api<RoutinesOverview>('GET', '/api/routines');
  }

  routine(slug: string): Promise<RoutineView> {
    return this.api<RoutineView>('GET', `/api/routines/${slug}`);
  }

  log(slug: string): Promise<LogEntry[]> {
    return this.api<LogEntry[]>('GET', `/api/routines/${slug}/log`);
  }

  saveSource(slug: string, spec: SourceSpec, secrets?: Record<string, string>): Promise<unknown> {
    return this.api('PUT', `/api/routines/sources/${slug}`, { spec, ...(secrets ? { secrets } : {}) });
  }

  saveRoutine(slug: string, spec: RoutineSpec): Promise<RoutineView> {
    return this.api<RoutineView>('PUT', `/api/routines/${slug}`, { spec });
  }

  /** Slack-источник через API: Socket Mode (app-токен), канал #bugs. */
  async slackSource(slug = 'slack-bugs', channels = 'bugs'): Promise<void> {
    await this.saveSource(slug, { title: 'Slack · #bugs', kind: 'slack', config: { channels }, secrets: ['SLACK_TOKEN', 'SLACK_APP_TOKEN'] }, { SLACK_TOKEN, SLACK_APP_TOKEN });
  }

  async telegramSource(slug = 'tg-bot'): Promise<void> {
    await this.saveSource(slug, { title: 'Telegram · бот', kind: 'telegram', config: {}, secrets: ['TELEGRAM_BOT_TOKEN'] }, { TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN });
  }

  /** Источник «своя команда» на фейковый HTTP: curl без ключа, опрос раз в 30 с (минимум вида). */
  async commandSource(slug = 'cmd-items', o: { noTime?: boolean } = {}): Promise<void> {
    const map = { id: 'id', title: 'title', text: 'text', ...(o.noTime ? {} : { at: 'at' }) };
    await this.saveSource(slug, { title: 'Заявки', kind: 'command', config: { command: `curl -s ${this.items.base}/plain` }, every: '30s', map });
  }

  /** Рутина «баг в Slack»: проверка словами, запуск bugfix до паузы перед fix, ответ в тред после проверки. */
  bugRoutine(o: Partial<RoutineSpec> & { source?: string } = {}): RoutineSpec {
    const { source = 'slack-bugs', ...rest } = o;
    return {
      title: 'Баг в #bugs → фикс',
      enabled: true,
      when: { source, match: { bot: false }, check: 'Это баг-репорт: описано, что сломалось.' },
      run: { flow: 'bugfix', pause_before: ['fix'] },
      mode: 'until_pause',
      reply: { to: 'source', on: ['pause', 'end'], draft: true },
      ...rest,
    };
  }

  // ------------------------------------------------------------ ожидания

  /** Ждать, пока fn вернёт truthy (опрос раз в 150 мс). Возвращает это значение. */
  async until<T>(fn: () => T | Promise<T>, o: { timeout?: number; message?: string } = {}): Promise<NonNullable<T>> {
    const until = Date.now() + (o.timeout ?? 20_000);
    let last: unknown;
    for (;;) {
      try {
        const v = await fn();
        if (v) return v as NonNullable<T>;
        last = v;
      } catch (err) {
        last = err;
      }
      if (Date.now() > until) throw new Error(`${o.message ?? 'не дождался'} (последнее: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Ждать строку журнала рутины с исходом (и, по желанию, заголовком события). */
  logEntry(slug: string, outcome: LogEntry['outcome'], title?: string, timeout?: number): Promise<LogEntry> {
    return this.until(async () => (await this.log(slug)).find((e) => e.outcome === outcome && (!title || e.event.title.includes(title))), { timeout, message: `журнал ${slug}: нет ${outcome}${title ? ` «${title}»` : ''}` });
  }

  /** Статус запуска из /api/runs. */
  async runStatus(runId: string): Promise<string | undefined> {
    const runs = await this.api<Array<{ id: string; status: string }>>('GET', '/api/runs');
    return runs.find((r) => r.id === runId)?.status;
  }

  /** Источник поднял слушателя (Slack Socket Mode). */
  async slackReady(): Promise<void> {
    await this.slack.waitConnected();
  }

  /** Слушатель Telegram прошёл baseline и ждёт новых сообщений long polling'ом. */
  async telegramReady(): Promise<void> {
    await this.tg.waitListening();
  }

  /** Файл состояния рутин (для подготовки простоя и пропущенного расписания). */
  writeState(file: string, data: unknown): void {
    const p = path.join(this.stateDir, file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  }

  /** Ключи источников (~/.agentgraph/secrets.json временной папки). */
  secrets(): Record<string, string> {
    const p = path.join(this.configDir, 'secrets.json');
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>) : {};
  }

  readState<T = unknown>(file: string): T | undefined {
    const p = path.join(this.stateDir, file);
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as T) : undefined;
  }
}

export { FAKE_API_KEY, SLACK_APP_TOKEN, SLACK_TOKEN, TELEGRAM_TOKEN };

export const test = base.extend<{ e2e: E2E }>({
  e2e: async ({}, use, info) => {
    const e = new E2E(info.title);
    try {
      await e.start();
      await use(e);
    } finally {
      if (info.status !== info.expectedStatus) {
        await info.attach('server.log', { body: e.serverLog, contentType: 'text/plain' });
        await info.attach('claude-calls.jsonl', { body: fs.existsSync(e.claudeLog) ? fs.readFileSync(e.claudeLog) : '', contentType: 'text/plain' });
      }
      await e.dispose();
    }
  },
  baseURL: async ({ e2e }, use) => {
    await use(e2e.url);
  },
});

export { expect };

/** Главная с карточками рутин. */
export async function openHome(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();
}
