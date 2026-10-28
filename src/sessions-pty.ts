// Процессы claude в pty и зеркало экрана. node-pty — необязательная нативная зависимость: не загрузился (Linux без
// сборки, сломанный бинарник) — фича sessions выключена, остальной сервер работает. Зеркало — @xterm/headless с
// addon-serialize: новый клиент (перезагрузка страницы, второе окно) получает снимок экрана, потом живой поток.
// Типы node-pty сюда не импортируются: на CI без пакета typecheck должен проходить.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { SessionWsServer } from './api-types.js';

export type PtyExit = { exitCode: number; signal?: number };

/** То, что сессии нужно от процесса node-pty. */
export type PtyProcess = {
  pid: number;
  onData: (cb: (data: string) => void) => unknown;
  onExit: (cb: (e: PtyExit) => void) => unknown;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
};

export type SpawnPty = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyProcess;

/** Зеркало экрана: пишет вывод, отдаёт снимок (ANSI) и видимый текст. */
export type Mirror = {
  write: (data: string, cb?: () => void) => void;
  resize: (cols: number, rows: number) => void;
  serialize: () => string;
  text: () => string;
};

export type PtyKit = { spawn: SpawnPty; mirror: (cols: number, rows: number) => Mirror };

/** Строк истории в зеркале: снимок с ними уходит каждому новому клиенту. */
const SCROLLBACK = 2000;

let kit: Promise<PtyKit | null> | undefined;
let kitError = '';

/** Почему фича выключена: текст ошибки загрузки node-pty или зеркала. */
export const ptyKitError = () => kitError;

/**
 * node-pty 1.1.0 кладёт spawn-helper в пакет без права на исполнение, и spawn падает с «posix_spawnp failed». Права
 * ставим сами; в упакованном приложении помощник лежит в app.asar.unpacked (electron-builder.yml).
 */
export function fixSpawnHelper(pkgDir: string): void {
  const helper = path.join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const st = fs.statSync(helper, { throwIfNoEntry: false });
  if (st && (st.mode & 0o111) === 0) fs.chmodSync(helper, st.mode | 0o755);
}

/** Загрузка один раз за процесс; null — фичи нет (причина — ptyKitError). */
export function loadPtyKit(): Promise<PtyKit | null> {
  kit ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      const name = 'node-pty';
      const pty = require(name) as { spawn: SpawnPty };
      try {
        fixSpawnHelper(path.dirname(require.resolve(`${name}/package.json`)));
      } catch {
        /* нет прав — spawn скажет сам */
      }
      createMirror(20, 5);
      return { spawn: pty.spawn, mirror: createMirror };
    } catch (err) {
      kitError = err instanceof Error ? err.message : String(err);
      return null;
    }
  })();
  return kit;
}

/** Зеркало на @xterm/headless: разбирает вывод claude так же, как xterm в окне, и сериализует экран с историей. */
export function createMirror(cols: number, rows: number): Mirror {
  const require = createRequire(import.meta.url);
  const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
  const { SerializeAddon: Serialize } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');
  const term: HeadlessTerminal = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const ser: SerializeAddon = new Serialize();
  term.loadAddon(ser as unknown as Parameters<HeadlessTerminal['loadAddon']>[0]);
  return {
    write: (data, cb) => term.write(data, cb),
    resize: (cols, rows) => term.resize(cols, rows),
    serialize: () => ser.serialize(),
    text: () => {
      const b = term.buffer.active;
      const out: string[] = [];
      for (let i = 0; i < term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
      return out.join('\n');
    },
  };
}

/** Клиент экрана: сокет WebSocket. */
export type ScreenClient = { send: (msg: string) => void };

const clampSize = (cols: number, rows: number) => ({ cols: Math.max(20, Math.min(500, Math.floor(cols) || 80)), rows: Math.max(5, Math.min(200, Math.floor(rows) || 24)) });

/**
 * Процесс claude с зеркалом и подключёнными клиентами. Вывод уходит клиентам пачкой за тик; новый клиент получает
 * снимок зеркала ровно на момент подключения и всё, что пришло после, без потерь и повторов.
 */
export class PtySession {
  readonly clients = new Set<ScreenClient>();
  /** Клиенты, ждущие снимка: вывод, пришедший после метки снимка, копится для них. */
  private readonly waiting = new Map<ScreenClient, string[]>();
  private out = '';
  private flushing = false;
  cols: number;
  rows: number;
  exit: PtyExit | null = null;
  readonly done: Promise<PtyExit>;

  constructor(readonly proc: PtyProcess, readonly mirror: Mirror, size: { cols: number; rows: number }) {
    ({ cols: this.cols, rows: this.rows } = clampSize(size.cols, size.rows));
    proc.onData((d) => {
      this.mirror.write(d);
      this.out += d;
      if (!this.flushing) {
        this.flushing = true;
        setImmediate(() => this.flush());
      }
    });
    // выход — когда зеркало разобрало весь вывод: последний экран (и диалог доверия на нём) уже в нём
    this.done = new Promise((resolve) =>
      proc.onExit((e) => {
        this.flush();
        this.mirror.write('', () => {
          this.exit = e;
          resolve(e);
        });
      }),
    );
  }

  get alive(): boolean {
    return !this.exit;
  }

  private flush(): void {
    this.flushing = false;
    if (!this.out) return;
    const msg = JSON.stringify({ t: 'o', d: this.out } satisfies SessionWsServer);
    this.out = '';
    for (const c of this.clients) c.send(msg);
    for (const buf of this.waiting.values()) buf.push(msg);
  }

  /** Всем подключённым (и ждущим снимка — после него): состояние, выход. */
  broadcast(msg: SessionWsServer): void {
    const s = JSON.stringify(msg);
    for (const c of this.clients) c.send(s);
    for (const buf of this.waiting.values()) buf.push(s);
  }

  /** Подключить клиента: его размер становится размером терминала, затем снимок и живой поток. */
  attach(c: ScreenClient, size?: { cols: number; rows: number }): void {
    if (size) this.resize(size.cols, size.rows);
    // всё, что уже в зеркале, войдёт в снимок: старым клиентам — сейчас, новому — не отправлять
    this.flush();
    const buf: string[] = [];
    this.waiting.set(c, buf);
    // колбэк write срабатывает, когда зеркало разобрало всё записанное до этой метки, и раньше следующих кусков
    this.mirror.write('', () => {
      if (this.waiting.get(c) !== buf) return;
      this.waiting.delete(c);
      c.send(JSON.stringify({ t: 'snap', d: this.mirror.serialize(), cols: this.cols, rows: this.rows } satisfies SessionWsServer));
      for (const m of buf) c.send(m);
      this.clients.add(c);
    });
  }

  detach(c: ScreenClient): void {
    this.clients.delete(c);
    this.waiting.delete(c);
  }

  write(data: string): void {
    if (this.alive) this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    const s = clampSize(cols, rows);
    if (s.cols === this.cols && s.rows === this.rows) return;
    this.cols = s.cols;
    this.rows = s.rows;
    this.mirror.resize(s.cols, s.rows);
    if (this.alive) this.proc.resize(s.cols, s.rows);
  }

  /**
   * Завершить: SIGHUP (claude успевает отправить SessionEnd), не вышел за timeoutMs — SIGKILL. Ждёт выхода, но не
   * дольше: зависший процесс не держит остановку сервера.
   */
  async stop(timeoutMs = 5000): Promise<void> {
    if (!this.alive) return;
    const wait = (ms: number) => Promise.race([this.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    try {
      this.proc.kill('SIGHUP');
    } catch {
      /* уже вышел */
    }
    if (await wait(timeoutMs)) return;
    try {
      this.proc.kill('SIGKILL');
    } catch {
      /* уже вышел */
    }
    await wait(1000);
  }
}
