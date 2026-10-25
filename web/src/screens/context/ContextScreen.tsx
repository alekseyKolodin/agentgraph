// Страница «Контекст» (/context; порт ui/context.js): что получит сессия этапа — CLAUDE.md и правила, скиллы, сабагенты, MCP,
// системный промпт, токены. Листинг считает Claude Code (GET /api/context), сервер кэширует его на минуту; «Обновить» спрашивает
// заново. CLAUDE.md и правила открываются и сохраняются (GET|PUT /api/context/file), остальное только для чтения.
// Состояние — модуль (как ctx старого UI): выбор, листинг и открытый файл живут, пока страница не видна, и ответ, пришедший
// после ухода с экрана, не теряется.
import { Fragment, useEffect, useRef, useSyncExternalStore, type FormEvent } from 'react';
import type { ContextView } from '@server/api-types';
import { ApiError, errorText, fetchContext, fetchContextFile, fetchFlow, saveContextFile, useConfig, useFeature, useFlows, useRecentDirs } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { SafeMarkdown } from '../../components/MdText';
import { PickDirButton } from '../../components/PickDirButton';
import { useToast } from '../../components/Toast';
import {
  CTX_HINT, CTX_LS, CTX_TEXT, ctxAddDirs, ctxDirty, ctxEditState, ctxFlowOptions, ctxHome, ctxKnowledge, ctxListSum, ctxMcpServers, ctxMeta,
  ctxOpenTitle, ctxPhaseGroups, ctxProjectMd, ctxProjects, ctxQuery, ctxRows, ctxSum, ctxTokens, ctxTotals, type CtxEdit, type CtxRow,
  type CtxSelection, type PhaseGroup, ctxChars, ctxPromptRows, ctxPromptTokens, ctxPromptVars,
} from '../../lib/context';
import { modelOptions } from '../../lib/flow/tools';
import { LS } from '../../lib/storage';
import styles from './Context.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

type Msg = { cls: string; text: string };

const ctx = {
  inited: false,
  sel: { cwd: '', flow: '', phase: '', model: '' } as CtxSelection,
  /** Последнее «принятое» значение директории: смена по blur, как change у старого поля. */
  cwdCommitted: '',
  phases: [] as PhaseGroup[],
  phasesSeq: 0,
  /** Листинг хоть раз показан: до этого в шапке — подзаголовок страницы, а тело пустое (renderContext старого UI). */
  rendered: false,
  data: null as ContextView | null,
  error: '',
  loading: false,
  seq: 0,
  msg: { cls: 'msg', text: '' } as Msg,
  /** Этапы flow из прошлого выбора подгружаются асинхронно: первый листинг ждёт их, иначе этап потеряется. */
  ready: null as Promise<void> | null,
  /** Открытый файл. */
  edit: null as CtxEdit | null,
  saving: false,
  /** Растёт, когда редактор надо подвести в видимую область. */
  scrollSeq: 0,
  version: 0,
};

const subs = new Set<() => void>();
const changed = () => {
  ctx.version++;
  subs.forEach((f) => f());
};
const useCtx = () =>
  useSyncExternalStore((f) => {
    subs.add(f);
    return () => subs.delete(f);
  }, () => ctx.version);

// несохранённая правка файла живёт в памяти страницы, даже когда «Контекст» не на виду
window.addEventListener('beforeunload', (e) => {
  if (!ctxDirty(ctx.edit)) return;
  e.preventDefault();
  e.returnValue = '';
});

/** Этап, который реально выбран: значение не из списка этапов браузер показал бы «без этапа» — так и считаем. */
const phaseValue = () => (ctx.phases.some((g) => g.options.some((o) => o.value === ctx.sel.phase)) ? ctx.sel.phase : '');

async function fillPhases(flow: string, current: string): Promise<void> {
  const my = ++ctx.phasesSeq;
  ctx.phases = [];
  ctx.sel.phase = current;
  changed();
  if (!flow) return;
  let spec;
  try {
    spec = (await fetchFlow(flow)).spec;
  } catch {
    return;
  }
  if (my !== ctx.phasesSeq || !spec) return;
  ctx.phases = ctxPhaseGroups(spec);
  ctx.sel.phase = phaseValue();
  changed();
}

async function loadContext(force = false): Promise<void> {
  const sel: CtxSelection = { cwd: ctx.sel.cwd.trim(), flow: ctx.sel.flow, phase: phaseValue(), model: ctx.sel.model };
  LS.set(CTX_LS, sel);
  const my = ++ctx.seq;
  ctx.loading = true;
  ctx.msg = { cls: 'msg', text: CTX_TEXT.loading };
  changed();
  try {
    const data = await fetchContext(ctxQuery(sel, force));
    if (my !== ctx.seq) return;
    ctx.data = data;
    ctx.error = '';
  } catch (err) {
    if (my !== ctx.seq) return;
    // данные прошлого выбора под ошибкой нового только путали бы
    ctx.data = null;
    ctx.error = errorText(err);
  } finally {
    if (my === ctx.seq) ctx.loading = false;
  }
  ctx.msg = ctx.error ? { cls: 'msg err', text: ctx.error } : { cls: 'msg', text: '' };
  ctx.rendered = true;
  changed();
}

export function ContextScreen() {
  useCtx();
  const config = useConfig().data!;
  const flows = useFlows();
  const recent = useRecentDirs(useFeature('recent-dirs')).data ?? [];
  const { askConfirm } = useConfirm();
  const toast = useToast();
  const editorRef = useRef<HTMLElement>(null);
  const seenScroll = useRef(ctx.scrollSeq);

  // первый показ страницы: выбор из памяти (agentgraph.context), как initContext
  if (!ctx.inited) {
    ctx.inited = true;
    const saved = LS.get<Partial<CtxSelection>>(CTX_LS, {});
    ctx.sel = { cwd: saved.cwd || LS.raw('agentgraph.cwd') || config.defaultCwd, flow: saved.flow || '', phase: '', model: saved.model || '' };
    ctx.cwdCommitted = ctx.sel.cwd;
    ctx.ready = fillPhases(saved.flow || '', saved.phase || '');
  }

  const flowOptions = ctxFlowOptions(flows.data ?? []);
  // список flow мог поменяться, пока страница была скрыта: flow, которого больше нет среди валидных, — «без flow»
  const flowsReady = flows.data !== undefined || flows.isError;
  useEffect(() => {
    if (!flowsReady || !ctx.sel.flow || flowOptions.some((o) => o.value === ctx.sel.flow)) return;
    ctx.sel.flow = '';
    void fillPhases('', '');
  }, [flowsReady, flows.data]);

  // открытие страницы: листинг, если его нет и он не грузится; первый ждёт этапов прошлого выбора
  useEffect(() => {
    if (!flowsReady) return;
    void (async () => {
      await ctx.ready;
      if (!ctx.data && !ctx.loading) void loadContext();
    })();
  }, [flowsReady]);

  // открыт файл или повторно нажат тот же — подвести редактор; при возврате на страницу не прокручивать
  useEffect(() => {
    if (ctx.scrollSeq === seenScroll.current) return;
    seenScroll.current = ctx.scrollSeq;
    editorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [ctx.scrollSeq]);

  const set = (patch: Partial<CtxSelection>) => {
    Object.assign(ctx.sel, patch);
    changed();
  };
  const commitCwd = () => {
    if (ctx.sel.cwd === ctx.cwdCommitted) return;
    ctx.cwdCommitted = ctx.sel.cwd;
    void loadContext();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    ctx.cwdCommitted = ctx.sel.cwd;
    void loadContext();
  };

  const openFile = async (file: string, force = false) => {
    if (!force && ctxDirty(ctx.edit)) {
      // тот же файл с правкой не перечитываем: правка пропала бы молча
      if (ctx.edit!.path === file) {
        ctx.scrollSeq++;
        changed();
        return;
      }
      if (!(await askConfirm(CTX_TEXT.other, { ok: 'Открыть' }))) return;
    }
    try {
      const f = await fetchContextFile(file);
      ctx.edit = { path: f.path, text: f.text, saved: f.text, mtimeMs: f.mtimeMs, editable: f.editable, conflict: false, msg: '' };
    } catch (err) {
      toast(errorText(err));
      return;
    }
    ctx.scrollSeq++;
    changed();
  };

  const saveFile = async () => {
    const e = ctx.edit;
    if (!e || !ctxDirty(e)) return;
    ctx.saving = true;
    changed();
    // сохранённым считаем отправленный текст: набранное за время запроса остаётся несохранённым
    const text = e.text;
    try {
      const r = await saveContextFile(e.path, text, e.mtimeMs);
      e.mtimeMs = r.mtimeMs;
      e.saved = text;
      e.conflict = false;
      e.msg = 'Сохранено';
      ctx.saving = false;
      changed();
      // токены файла поменялись: сервер сбросил кэш, листинг пересчитаем
      void loadContext();
    } catch (err) {
      e.conflict = err instanceof ApiError && err.status === 409;
      e.msg = errorText(err);
      ctx.saving = false;
      changed();
    }
  };

  const cancelFile = async () => {
    if (ctxDirty(ctx.edit) && !(await askConfirm(CTX_TEXT.close, { ok: 'Закрыть' }))) return;
    ctx.edit = null;
    changed();
  };

  const reloadFile = async () => {
    if (ctxDirty(ctx.edit) && !(await askConfirm(CTX_TEXT.reload, { ok: 'Перечитать' }))) return;
    if (ctx.edit) void openFile(ctx.edit.path, true);
  };

  const d = ctx.data;
  const home = config.home;
  const projects = ctxProjects(config.defaultCwd, LS.raw('agentgraph.cwd'), recent);
  const flowValue = flowOptions.some((o) => o.value === ctx.sel.flow) ? ctx.sel.flow : '';
  const e = ctx.edit;
  const es = e && ctxEditState(e);

  return (
    <>
      <header className="view-head">
        <div>
          <h1>Контекст</h1>
          <p className="muted">{!ctx.rendered ? 'Что получит сессия этапа до первого сообщения' : d ? ctxMeta(d) : ''}</p>
        </div>
        <div className="row">
          <button className="btn" title="Спросить Claude Code заново: листинг кэшируется на минуту" onClick={() => void loadContext(true)}>Обновить</button>
        </div>
      </header>
      <form className={cx('form', styles.ctxForm)} onSubmit={submit}>
        <div className="row">
          <label className={styles.ctxCwd}>
            <span title="Её CLAUDE.md, .claude/rules и скиллы попадут в контекст вместе с пользовательскими">Директория проекта</span>
            <input
              name="cwd"
              list="ctx-projects"
              placeholder="/path/to/repo"
              autoComplete="off"
              spellCheck={false}
              value={ctx.sel.cwd}
              onChange={(ev) => {
                set({ cwd: ev.target.value });
                // выбор из подсказки — сразу, как change у старого поля; набор руками — по blur или Enter
                const type = (ev.nativeEvent as InputEvent).inputType;
                if (!type || type === 'insertReplacementText') commitCwd();
              }}
              onBlur={commitCwd}
            />
          </label>
          <PickDirButton
            className="btn"
            prompt="Выбери директорию проекта"
            start={() => ctx.sel.cwd.trim() || config.defaultCwd}
            onPick={(p) => {
              set({ cwd: p });
              ctx.cwdCommitted = p;
              void loadContext();
            }}
          />
        </div>
        <div className="row">
          <label>
            <span>Flow</span>
            <select
              name="flow"
              value={flowValue}
              onChange={(ev) => {
                set({ flow: ev.target.value });
                void fillPhases(ev.target.value, '').then(() => loadContext());
              }}
            >
              <option value="">без flow</option>
              {flowOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label>
            <span title="У этапа свои модель, инструменты, system и add_dirs">Этап</span>
            <select
              name="phase"
              disabled={!flowValue}
              value={phaseValue()}
              onChange={(ev) => {
                set({ phase: ev.target.value });
                void loadContext();
              }}
            >
              <option value="">без этапа</option>
              {ctx.phases.map((g) =>
                g.label
                  ? <optgroup key={g.label} label={g.label}>{g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>
                  : g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </label>
          <label>
            <span>Модель</span>
            <select
              name="model"
              value={ctx.sel.model}
              onChange={(ev) => {
                set({ model: ev.target.value });
                void loadContext();
              }}
            >
              {modelOptions(ctx.sel.model).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <button type="submit" className="btn primary">Показать</button>
          <span className={ctx.msg.cls}>{ctx.msg.text}</span>
        </div>
        <datalist id="ctx-projects">
          {projects.map((p) => <option key={p} value={p} />)}
        </datalist>
      </form>
      {e && es && (
        <section ref={editorRef} className={styles.ctxEditor}>
          <div className={styles.ctxEditHead}>
            <span className="mono" title={e.path}>{ctxHome(e.path, home)}</span>
            <span className={cx('row', styles.push)}>
              <span className={es.msgClass}>{es.msg}</span>
              <button type="button" className="btn small" hidden={!es.reload} onClick={() => void reloadFile()}>Перечитать</button>
              <button type="button" className="btn small primary" hidden={!es.save} disabled={es.saveDisabled || ctx.saving} onClick={() => void saveFile()}>Сохранить</button>
              <button type="button" className="btn small ghost" onClick={() => void cancelFile()}>{es.cancel}</button>
            </span>
          </div>
          <div className={styles.ctxEditSplit}>
            <textarea
              className={styles.ctxEditText}
              spellCheck={false}
              readOnly={!e.editable}
              value={e.text}
              onChange={(ev) => {
                e.text = ev.target.value;
                changed();
              }}
            />
            <div className={styles.ctxEditPreview}><SafeMarkdown text={e.text} /></div>
          </div>
        </section>
      )}
      <div>
        {!ctx.rendered ? null : d ? <ContextBody d={d} home={home} open={(p) => void openFile(p)} /> : ctx.error ? null : <p className="muted">{CTX_TEXT.empty}</p>}
      </div>
    </>
  );
}

function ContextBody({ d, home, open }: { d: ContextView; home: string; open: (path: string) => void }) {
  const { bar, legend } = ctxTotals(d);
  const dirs = ctxAddDirs(d, home);
  const knowledge = ctxKnowledge(d);
  const sec = cx(styles.homeSec, styles.ctxSec);
  return (
    <>
      {d.warnings.length > 0 && <div className={styles.ctxWarn}>{d.warnings.map((w, i) => <p key={i}>{w}</p>)}</div>}
      <section className={sec}>
        <h2 title="Оценка до первого сообщения: так сессия этапа начнёт">Токены на старте сессии</h2>
        <p className={styles.ctxTotal}><b>{ctxTokens(d.totalTokens)}</b>{` из ${ctxTokens(d.maxTokens)} `}<span className="muted">{`· ${d.percentage}% окна`}</span></p>
        <div className={styles.ctxBar}>
          {bar.map((p, i) => <span key={i} className={styles[`c${p.c}`]} style={{ width: p.width }} title={p.title} />)}
        </div>
        <ul className={styles.ctxLegend}>
          {legend.map((l, i) => (
            <li key={i} className={l.used ? '' : 'muted'}>
              {l.c !== null && <i className={styles[`c${l.c}`]} />}
              {`${l.name} `}<b>{l.tokens}</b>
              {!l.used && <>{' '}<span className="small">{`· ${l.kind}`}</span></>}
            </li>
          ))}
        </ul>
      </section>
      <section className={sec}>
        <h2>Память: CLAUDE.md и правила <span className="small muted">{`· ${ctxTokens(ctxSum(d.memoryFiles))}`}</span></h2>
        {!ctxProjectMd(d) && <p className="muted small">В директории проекта нет своего CLAUDE.md.</p>}
        {dirs.length > 0 && <p className="muted small">Доп. директории этапа (add_dirs): {notes(dirs)}</p>}
        {knowledge.length > 0 && <p className="muted small">Теги знаний блока (knowledge): {notes(knowledge)}</p>}
        <ul className={styles.ctxList}>
          {d.memoryFiles.length
            ? d.memoryFiles.map((f) => (
              <li key={f.path} className={styles.ctxRow}>
                <span className={cx(styles.ctxName, 'mono')} title={f.path}>{ctxHome(f.path, home)}</span>
                <span className="chip">{f.type}</span>
                <span className={styles.ctxTok}>{ctxTokens(f.tokens)}</span>
                <button type="button" className="btn small" title={ctxOpenTitle(f.editable)} onClick={() => open(f.path)}>{f.editable ? 'Открыть' : 'Смотреть'}</button>
              </li>
            ))
            : <li className="muted">Ни одного файла</li>}
        </ul>
      </section>
      <section className={sec}>
        <h2>Системный промпт и инструменты</h2>
        {d.systemPrompt === 'custom'
          ? <><p>Свой промпт этапа (system) вместо стандартного:</p><pre className={styles.ctxPre}>{d.systemPromptText || ''}</pre></>
          : <p>Стандартный промпт Claude Code (preset <code>claude_code</code>).</p>}
        <p><span className="muted">Инструменты:</span>{` ${d.tools ? d.tools.join(', ') : 'все инструменты Claude Code'}`}</p>
      </section>
      {d.prompt && (
        <section className={sec}>
          <h2 title="Что раннер соберёт в первое сообщение этапа, по источникам; без подстановок, артефактов и вложений — они известны только в запуске">
            {'Промпт этапа по источникам '}<span className="small muted">{`· ${ctxChars(d.prompt.chars)} знаков, ${ctxPromptTokens(d.prompt.chars)}`}</span>
          </h2>
          <ul className={styles.ctxList}>
            {ctxPromptRows(d.prompt).map((x, i) => (
              <li key={i} className={styles.ctxRow}>
                <span className={styles.ctxName}>{x.name}</span>
                {x.inline && <span className="chip" title="Заметки тега уходят в каждую итерацию целиком; режим меняется на странице «Теги»">целиком</span>}
                <span className={styles.ctxTok}>{`${x.chars} · ${x.share}`}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">{ctxPromptVars(d.prompt.vars)}</p>
        </section>
      )}
      <CtxList title="Скиллы" hint={CTX_HINT.skills} list={d.skills} />
      <CtxList title="Сабагенты" hint={CTX_HINT.agents} list={d.agents} />
      <CtxList title="MCP" hint={CTX_HINT.mcp} list={ctxMcpServers(d)} />
    </>
  );
}

/** Пути и теги через запятую, ошибочные — красным. */
const notes = (list: { text: string; err: boolean }[]) =>
  list.map((x, i) => <Fragment key={i}>{i > 0 && ', '}<span className={cx('mono', x.err && 'err')}>{x.text}</span></Fragment>);

function CtxList({ title, hint, list }: { title: string; hint: string; list: CtxRow[] }) {
  const sec = cx(styles.homeSec, styles.ctxSec);
  if (!list.length) return <section className={sec}><h2 title={hint}>{title}</h2><p className="muted small">Нет</p></section>;
  return (
    <section className={sec}>
      <h2 title={hint}>{`${title} `}<span className="small muted">{ctxListSum(list)}</span></h2>
      <ul className={styles.ctxList}>
        {ctxRows(list).map((x, i) => (
          <li key={i} className={styles.ctxRow}><span className={styles.ctxName}>{x.name}</span><span className="chip">{x.source}</span><span className={styles.ctxTok}>{ctxTokens(x.tokens)}</span></li>
        ))}
      </ul>
    </section>
  );
}
