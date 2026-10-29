// Транскрипт этапа в окне файла: разбор — lib/run/transcript.ts, узлы — render.ts (та же отрисовка, что у живого лога).
// Сбой разбора или отрисовки не роняет окно: тогда исходник моноширинно, как «как текст».
import { useLayoutEffect, useRef, useState } from 'react';
import { useConfig } from '../../api';
import { parseTranscript } from '../../lib/run/transcript';
import { PathText } from '../PathLink';
import { renderTranscript } from './render';
import styles from './Transcript.module.css';

/** run — запуск, чей это транскрипт: его файлы подписываются от папки запуска. */
export function Transcript({ text, run }: { text: string; run?: string }) {
  const home = useConfig().data?.home;
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!box.current) return;
    try {
      renderTranscript(box.current, parseTranscript(text), { home, run });
    } catch {
      setFailed(text);
    }
  }, [text, home, run]);
  if (failed === text) return <pre><PathText text={text} /></pre>;
  return <div ref={box} className={styles.tx} />;
}
