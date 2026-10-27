// Живой лог запуска (ui/app.js appendLog, flushLog, resetLog): окно лога на вкладке «Лог», хвост на «Обзоре» и хвост этапа
// в инспекторе. Строки дописываются в DOM пачками-кусками раз в кадр, мимо React: старый текст не трогается, раскладка идёт
// только по последней пачке, а перерисовка страницы на каждое событие не перекладывает тысячи строк лога.
// Пути к файлам в строках — ссылки «показать в Finder» (appendPaths).
import { useEffect, useLayoutEffect, useRef } from 'react';
import { appendPaths } from '../../components/PathLink';
import { LOG_TALL_LINES, planLogChunks } from '../../lib/run/log';
import { onLog, runLog } from './store';
import styles from './Run.module.css';

/** Окно лога: всегда в DOM (вкладка скрыта, а строки копятся), при показе вкладки — вниз. */
export function LogBody({ shown }: { shown: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const lines = useRef(0);

  useLayoutEffect(() => {
    const el = box.current!;
    const clear = () => {
      el.replaceChildren();
      lines.current = 0;
      el.classList.remove(styles.tall!);
    };
    clear();
    return onLog((reset) => {
      if (reset) return clear();
      const { lines: add, reset: rebuild } = runLog.take();
      if (!add.length) return;
      const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      if (rebuild) clear();
      const chunks = [...el.children].map((c) => Number((c as HTMLElement).dataset.n));
      const plan = planLogChunks(chunks, add.length);
      let i = 0;
      if (plan.fill) {
        const last = el.lastElementChild as HTMLElement;
        appendPaths(last, add.slice(0, plan.fill).join('\n') + '\n');
        last.dataset.n = String(Number(last.dataset.n) + plan.fill);
        i = plan.fill;
      }
      for (const n of plan.chunks) {
        const chunk = document.createElement('div');
        chunk.dataset.n = String(n);
        appendPaths(chunk, add.slice(i, i + n).join('\n') + '\n');
        el.append(chunk);
        i += n;
      }
      for (let k = 0; k < plan.drop; k++) el.firstElementChild?.remove();
      lines.current = [...el.children].reduce((sum, c) => sum + Number((c as HTMLElement).dataset.n), 0);
      el.classList.toggle(styles.tall!, lines.current >= LOG_TALL_LINES);
      if (stick) el.scrollTop = el.scrollHeight;
    });
  }, []);

  useEffect(() => {
    if (shown) box.current!.scrollTop = box.current!.scrollHeight;
  }, [shown]);

  return <div ref={box} className={`${styles.logBody} mono`} />;
}

/**
 * Перезаполнить хвост, только если текст сменился: лог приходит раз в кадр, и пересборка на каждый кадр уводила бы
 * из-под мыши ссылку между нажатием и отпусканием, а фокус с клавиатуры — на каждой строке.
 */
function fillPaths(el: HTMLElement): (text: string) => void {
  let shown: string | undefined;
  return (text) => {
    if (text === shown) return;
    shown = text;
    el.replaceChildren();
    appendPaths(el, text);
  };
}

/** Последние строки всех этапов — «Живой лог · последние строки» на «Обзоре». */
export function RunTail() {
  const pre = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = pre.current!;
    const fill = fillPaths(el);
    fill(runLog.tail.join('\n'));
    return onLog(() => fill(runLog.tail.join('\n')));
  }, []);
  return <pre ref={pre} className={styles.runTail} />;
}

/** Последние строки одного этапа — «Сейчас» в инспекторе. */
export function PhaseTail({ phase }: { phase: string }) {
  const pre = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = pre.current!;
    const fill = fillPaths(el);
    const text = () => (runLog.byPhase.get(phase) || []).join('\n');
    fill(text());
    return onLog(() => fill(text()));
  }, [phase]);
  return <pre ref={pre} className={styles.runTail} />;
}
