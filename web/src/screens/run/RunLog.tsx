// Живой лог запуска (ui/app.js appendLog, flushLog, resetLog): окно лога на вкладке «Лог», хвост на «Обзоре» и хвост этапа
// в инспекторе. Строки дописываются в DOM пачками-кусками раз в кадр, мимо React: старый текст не трогается, раскладка идёт
// только по последней пачке, а перерисовка страницы на каждое событие не перекладывает тысячи строк лога.
// Строка — как в Claude Code (components/transcript/render.ts): текст агента markdown, вызов «● Имя(аргумент)», результат
// под ним; «как текст» (общий выбор с окном файла) — исходные строки. Пути к файлам — ссылки «показать в Finder».
// Живого лога у запуска, который на момент открытия уже не шёл, нет (поток закрыт): его «Лог» собран из транскриптов
// этапов (PhaseLogs) — тот же разбор и та же отрисовка, что у окна транскрипта.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PhaseReport } from '@server/api-types';
import { errorText, fetchRunFile, useConfig } from '../../api';
import { openRunFile, setFileRaw, useFileRaw } from '../../components/file/FileDialog';
import { appendPaths, PathText } from '../../components/PathLink';
import { appendLog, tailLine, type TxCtx } from '../../components/transcript/render';
import { Transcript } from '../../components/transcript/Transcript';
import { t } from '../../lib/i18n';
import { LOG_MAX_LINES, LOG_TALL_LINES, planLogChunks } from '../../lib/run/log';
import { logPhases } from '../../lib/run/view';
import type { LogState } from '../../lib/run/transcript';
import type { RunView } from '../../lib/run/events';
import { onLog, runLog, runState } from './store';
import styles from './Run.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

/** Окно лога: всегда в DOM (вкладка скрыта, а строки копятся), при показе вкладки — вниз. */
export function LogBody({ shown }: { shown: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const raw = useFileRaw();
  const home = useConfig().data?.home;
  // строки, что сейчас в окне: по ним окно пересобирается при смене вида
  const kept = useRef<string[]>([]);
  const view = useRef({ raw, home, st: {} as LogState });
  const rebuild = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const el = box.current!;
    const clear = () => {
      el.replaceChildren();
      el.classList.remove(styles.tall!);
      view.current.st = {};
    };
    const fill = (chunk: HTMLElement, lines: string[], fresh: boolean) => {
      const v = view.current;
      if (v.raw) return appendPaths(chunk, lines.join('\n') + '\n');
      const ctx: TxCtx = { home: v.home, run: runState.id ?? undefined };
      appendLog(chunk, lines, v.st, ctx, fresh);
    };
    const put = (add: string[]) => {
      const chunks = [...el.children].map((c) => Number((c as HTMLElement).dataset.n));
      const plan = planLogChunks(chunks, add.length);
      let i = 0;
      if (plan.fill) {
        const last = el.lastElementChild as HTMLElement;
        fill(last, add.slice(0, plan.fill), false);
        last.dataset.n = String(Number(last.dataset.n) + plan.fill);
        i = plan.fill;
      }
      for (const n of plan.chunks) {
        const chunk = document.createElement('div');
        chunk.dataset.n = String(n);
        fill(chunk, add.slice(i, i + n), true);
        el.append(chunk);
        i += n;
      }
      for (let k = 0; k < plan.drop; k++) el.firstElementChild?.remove();
      const lines = [...el.children].reduce((sum, c) => sum + Number((c as HTMLElement).dataset.n), 0);
      el.classList.toggle(styles.tall!, lines >= LOG_TALL_LINES);
    };
    rebuild.current = () => {
      clear();
      if (kept.current.length) put(kept.current);
      el.scrollTop = el.scrollHeight;
    };
    clear();
    kept.current = [];
    return onLog((reset) => {
      if (reset) {
        kept.current = [];
        return clear();
      }
      const { lines: add, reset: again } = runLog.take();
      if (!add.length) return;
      const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      if (again) {
        clear();
        kept.current = [];
      }
      kept.current.push(...add);
      if (kept.current.length > LOG_MAX_LINES) kept.current.splice(0, kept.current.length - LOG_MAX_LINES);
      put(add);
      if (stick) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // сменили вид или узнали домашнюю папку — окно заново из тех же строк
  useLayoutEffect(() => {
    const v = view.current;
    if (v.raw === raw && v.home === home) return;
    v.raw = raw;
    v.home = home;
    rebuild.current();
  }, [raw, home]);

  useEffect(() => {
    if (shown) box.current!.scrollTop = box.current!.scrollHeight;
  }, [shown]);

  return <div ref={box} className={`${styles.logBody} mono`} />;
}

/** «как текст / форматировать» над окном лога — тот же выбор, что в окне файла. */
export function LogRawToggle() {
  const raw = useFileRaw();
  return (
    <button className="btn ghost small" title={t('Исходные строки лога — удобно копировать')} onClick={() => setFileRaw(!raw)}>
      {raw ? t('форматировать') : t('как текст')}
    </button>
  );
}

/**
 * Перезаполнить хвост, только если строки сменились: лог приходит раз в кадр, и пересборка на каждый кадр уводила бы
 * из-под мыши ссылку между нажатием и отпусканием, а фокус с клавиатуры — на каждой строке.
 */
function fillTail(el: HTMLElement, home: string | undefined, withPhase: boolean): (lines: string[]) => void {
  const ctx: TxCtx = { home, run: runState.id ?? undefined };
  let shown: string | undefined;
  return (lines) => {
    const text = lines.join('\n');
    if (text === shown) return;
    shown = text;
    el.replaceChildren(...lines.map((line) => tailLine(line, ctx, withPhase)).filter((r) => r !== null));
  };
}

/** Последние строки всех этапов — «Живой лог · последние строки» на «Обзоре». */
export function RunTail() {
  const box = useRef<HTMLDivElement>(null);
  const home = useConfig().data?.home;
  useLayoutEffect(() => {
    const fill = fillTail(box.current!, home, true);
    fill(runLog.tail);
    return onLog(() => fill(runLog.tail));
  }, [home]);
  return <div ref={box} className={styles.runTail} />;
}

/** Последние строки одного этапа — «Сейчас» в инспекторе. */
export function PhaseTail({ phase }: { phase: string }) {
  const box = useRef<HTMLDivElement>(null);
  const home = useConfig().data?.home;
  useLayoutEffect(() => {
    const fill = fillTail(box.current!, home, false);
    const lines = () => runLog.byPhase.get(phase) || [];
    fill(lines());
    return onLog(() => fill(lines()));
  }, [phase, home]);
  return <div ref={box} className={styles.runTail} />;
}

/** Прочитанный транскрипт этапа: текст или текст ошибки чтения (err). */
type Loaded = { text: string; err?: boolean };

/**
 * «Лог» запуска, который уже не шёл, когда его открыли: транскрипты этапов по порядку, каждый — под разделителем с этапом
 * и кнопкой «транскрипт» (окно с `claude --resume`). Читаются, когда вкладку впервые показали, по одному и по порядку —
 * лог растёт сверху; пока страница открыта, повторно не читаются. «как текст» — исходные строки, как в окне файла.
 */
export function PhaseLogs({ r, shown }: { r: RunView; shown: boolean }) {
  const raw = useFileRaw();
  const phases = logPhases(r);
  const [texts, setTexts] = useState<ReadonlyMap<string, Loaded>>(new Map());
  const started = useRef(false);
  const alive = useRef(true);
  const multi = (r.blocks?.length ?? 0) > 1;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // чтение не обрывается сменой вкладки — только уходом со страницы
  useEffect(() => {
    if (!shown || started.current) return;
    started.current = true;
    void (async () => {
      for (const p of phases) {
        const file = p.files.transcript;
        const got: Loaded = await fetchRunFile(r.id, file).then(
          (res) => (res.ok ? { text: res.text } : { text: res.text, err: true }),
          (err: unknown) => ({ text: errorText(err), err: true }),
        );
        if (!alive.current) return;
        setTexts((m) => new Map(m).set(file, got));
      }
    })();
  }, [shown]);

  if (!phases.length) {
    return (
      <div className={cx(styles.logBody, styles.logFiles)}>
        <p className="muted">{r.phases.length ? t('У этапов этого запуска нет транскриптов: их писали только новые версии agentgraph.') : t('Этапы не выполнялись: лога нет.')}</p>
      </div>
    );
  }
  return (
    <div className={cx(styles.logBody, styles.logFiles)}>
      {phases.map((p) => <PhaseLog key={p.files.transcript} p={p} runId={r.id} multi={multi} raw={raw} loaded={texts.get(p.files.transcript)} />)}
    </div>
  );
}

function PhaseLog({ p, runId, multi, raw, loaded }: { p: PhaseReport; runId: string; multi: boolean; raw: boolean; loaded: Loaded | undefined }) {
  const file = p.files.transcript;
  const where = [multi ? p.block : '', t('итерация {it}', { it: p.iteration })].filter(Boolean).join(' · ');
  return (
    <section className={styles.logPhase}>
      <div className={styles.logPhaseHead}>
        {!p.ok && <span className="warn" title={p.subtype}>!</span>}
        <span className={styles.logPhaseName}>{p.title || p.phase}</span>
        <span>{where}</span>
        <button type="button" className="link-btn" title={t('Транскрипт этапа в окне: целиком, с claude --resume')} onClick={() => void openRunFile(runId, file, t('Транскрипт · {name}', { name: p.phase }), p.sessionId || '')}>
          {t('транскрипт')}
        </button>
      </div>
      {!loaded
        ? <p className="muted small">{t('Загружаю…')}</p>
        : loaded.err
          ? <p className="warn small">{loaded.text}</p>
          : !loaded.text.trim()
            ? <p className="muted small">{t('Этап ничего не написал.')}</p>
            : raw
              ? <pre className={styles.logRaw}><PathText text={loaded.text} /></pre>
              : <Transcript text={loaded.text} run={runId} />}
    </section>
  );
}
