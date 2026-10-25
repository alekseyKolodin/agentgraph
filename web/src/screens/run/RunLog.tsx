// Живой лог запуска (ui/app.js appendLog, flushLog, resetLog): окно лога на вкладке «Лог», хвост на «Обзоре» и хвост этапа
// в инспекторе. Строки дописываются в DOM пачками-кусками раз в кадр, мимо React: старый текст не трогается, раскладка идёт
// только по последней пачке, а перерисовка страницы на каждое событие не перекладывает тысячи строк лога.
import { useEffect, useLayoutEffect, useRef } from 'react';
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
        last.append(add.slice(0, plan.fill).join('\n') + '\n');
        last.dataset.n = String(Number(last.dataset.n) + plan.fill);
        i = plan.fill;
      }
      for (const n of plan.chunks) {
        const chunk = document.createElement('div');
        chunk.dataset.n = String(n);
        chunk.append(add.slice(i, i + n).join('\n') + '\n');
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

/** Последние строки всех этапов — «Живой лог · последние строки» на «Обзоре». */
export function RunTail() {
  const pre = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = pre.current!;
    el.textContent = runLog.tail.join('\n');
    return onLog(() => {
      el.textContent = runLog.tail.join('\n');
    });
  }, []);
  return <pre ref={pre} className={styles.runTail} />;
}

/** Последние строки одного этапа — «Сейчас» в инспекторе. */
export function PhaseTail({ phase }: { phase: string }) {
  const pre = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = pre.current!;
    const fill = () => {
      el.textContent = (runLog.byPhase.get(phase) || []).join('\n');
    };
    fill();
    return onLog(fill);
  }, [phase]);
  return <pre ref={pre} className={styles.runTail} />;
}
