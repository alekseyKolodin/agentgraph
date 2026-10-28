// Терминал сессии: xterm.js в окне, процесс claude — на сервере (sessions-pty.ts), между ними WebSocket. При подключении
// сервер шлёт снимок экрана, дальше — живой вывод; обрыв — переподключение с новым снимком, процесс при этом живёт.
// Клавиатура: Shift+Enter — перевод строки в поле claude, Option — Meta; перетащенный файл — путь в командную строку.
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { SessionView, SessionWsClient, SessionWsServer } from '@server/api-types';
import { errorText } from '../../api';
import { uploadSessionFile } from '../../api/sessions';
import { readBase64 } from '../../components/readBase64';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { fileUris, NEWLINE_SEQ, sessionWsUrl, shellPath } from '../../lib/sessions';
import styles from './Session.module.css';

const RECONNECT_MS = 1000;

/** Цвета терминала — из токенов «Пульта»: фон колодца, текст, выделение в цвет фокуса. */
function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { background: v('--well'), foreground: v('--ink'), cursor: v('--ink'), cursorAccent: v('--well'), selectionBackground: 'rgba(122, 167, 255, .35)' };
}

type Props = {
  id: string;
  /** Состояние сессии из потока: шапка и строка тегов обновляются без опроса. */
  onState: (s: SessionView) => void;
  /** Процесс живой: иначе ввод не шлём и оверлей переподключения не показываем. */
  live: boolean;
  /** Поверх экрана: карточка завершённой сессии. */
  overlay?: ReactNode;
};

export function SessionTerminal({ id, onState, live, overlay }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const [conn, setConn] = useState<'connecting' | 'open' | 'lost'>('connecting');
  const [drop, setDrop] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const el = box.current!;
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontFamily: css.getPropertyValue('--font-mono').trim(),
      fontSize: 13,
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: theme(),
      // ссылки OSC 8 из вывода модели и инструментов: только http(s) и в новой вкладке — javascript: и прочие схемы не открываем
      linkHandler: {
        activate: (_e, uri) => {
          if (/^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener');
        },
      },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const send = (msg: SessionWsClient) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const connect = () => {
      const sock = new WebSocket(sessionWsUrl(location, id));
      ws = sock;
      setConn('connecting');
      // первым делом — размер окна: под него сервер подгонит pty и снимок
      sock.onopen = () => {
        setConn('open');
        send({ t: 'r', cols: term.cols, rows: term.rows });
      };
      sock.onmessage = (ev: MessageEvent<string>) => {
        let m: SessionWsServer;
        try {
          m = JSON.parse(ev.data) as SessionWsServer;
        } catch {
          return;
        }
        if (m.t === 'o') term.write(m.d);
        else if (m.t === 'snap') {
          term.reset();
          term.write(m.d);
        } else if (m.t === 's') onStateRef.current(m.session);
      };
      sock.onclose = () => {
        if (stopped || ws !== sock) return;
        setConn('lost');
        retry = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    term.onData((d) => send({ t: 'i', d }));
    term.onResize(({ cols, rows }) => send({ t: 'r', cols, rows }));
    // Shift+Enter: перевод строки в поле claude, как Option+Enter; keypress и keyup того же нажатия тоже глушим,
    // иначе xterm отправит обычный Enter
    term.attachCustomKeyEventHandler((e) => {
      if (e.key !== 'Enter' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return true;
      if (e.type === 'keydown') {
        e.preventDefault();
        send({ t: 'i', d: NEWLINE_SEQ });
      }
      return false;
    });
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(el);
    term.focus();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [id]);

  /** Файлы, перетащенные на терминал: пути — в командную строку claude (с пробелом после), как в обычном терминале. */
  const dropFiles = async (e: DragEvent) => {
    e.preventDefault();
    setDrop(false);
    if (!live) return;
    let paths = fileUris(e.dataTransfer.getData('text/uri-list'));
    // браузер пути к файлу не отдаёт: копия ложится в папку сессии (она в --add-dir), в строку — её путь
    if (!paths.length) {
      try {
        paths = await Promise.all([...e.dataTransfer.files].map(async (f) => (await uploadSessionFile(id, f.name, await readBase64(f))).path));
      } catch (err) {
        toast(errorText(err));
        return;
      }
    }
    if (!paths.length) return;
    termRef.current?.paste(paths.map(shellPath).join(' ') + ' ');
    termRef.current?.focus();
  };

  return (
    <div
      className={[styles.termBox, drop ? styles.dropping : ''].filter(Boolean).join(' ')}
      onDragOver={(e) => {
        if (!live || ![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setDrop(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(false);
      }}
      onDrop={(e) => void dropFiles(e)}
    >
      <div ref={box} className={styles.term} />
      {live && conn === 'lost' && <div className={styles.reconnect} role="status">{t('Переподключение…')}</div>}
      {overlay}
    </div>
  );
}
