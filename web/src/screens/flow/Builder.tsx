// Вкладка «Конструктор» (ui/app.js renderBuilder, renderGraph, graphPick, graphAdd, saveBuilder, aiEdit, renderAiResult, aiUndo,
// крупный редактор справа): липкая панель «ИИ» и «Сохранить», граф — главный холст, инспектор справа — только когда что-то
// выбрано, ниже — «Все поля списком».
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, type FormEvent, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { checkFlow, editFlow, errorText, keys, saveFlowSpec, useConfig, useFeature } from '../../api';
import { useConfirm } from '../../components/ConfirmDialog';
import { FlowGraph, type GraphHit } from '../../components/graph/FlowGraph';
import { usd } from '../../lib/format';
import {
  addPhaseAfter, blockHeading, collectSpec, isMulti, newBlock, phaseInputs, phaseNum, specChanges, SpecError, toEditable, type EditSpec,
} from '../../lib/flow/edit';
import { toolsLabel } from '../../lib/flow/tools';
import { flowGraphModel, type GraphNode } from '../../lib/graph/model';
import { LS } from '../../lib/storage';
import { plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { afterRender, bindField, clearSel, flash, openBlockPane, openPhasePane, paneShown, revealField, sameField } from './actions';
import { BlockPane, BlockSection, blockPaneTitles, KnowledgeBadge, phaseKey } from './BlockEditor';
import { PhaseCard } from './PhaseCard';
import {
  applySaved, emit, flowState, saveStart, knowledgeDraft, markDirty, msgClass, NO_MSG, revealNode, selBlockAt, selPhaseAt, set, useFlowStore, type FieldKey,
} from './store';
import styles from './Flow.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
const knowledgeChip = (t: string) => <KnowledgeBadge slug={t} />;

export function Builder({ hidden }: { hidden: boolean }) {
  const st = useFlowStore();
  const spec = st.spec;
  const config = useConfig().data!;
  const artifacts = useFeature('artifacts');
  // рабочая копия правится на месте: модель — заново на каждую правку, но с низким приоритетом (как задержка 250 мс в старом),
  // чтобы ввод в промпт не ждал раскладки графа
  const editSeq = useDeferredValue(st.editSeq);
  const graphModel = useMemo(
    () => (spec ? flowGraphModel(spec, { inputsOf: (bi, i) => phaseInputs(spec, bi, i), artifacts }) : null),
    [spec, artifacts, editSeq],
  );
  const toolsOf = useCallback((n: GraphNode) => toolsLabel(flowState.spec?.blocks[n.b!]?.phases[n.i!]?.tools, config.implicitTools), [config.implicitTools]);

  const pick = useCallback((n: GraphHit) => graphPick(n), []);
  const add = useCallback((n: GraphHit) => {
    const s = flowState.spec;
    if (!s || n.b === undefined || n.i === undefined) return;
    const at = addPhaseAfter(s, n.b, n.i, n.kind === 'group' ? n.group : undefined);
    flowState.graphSel = s.blocks[n.b]!.phases[at]!.name;
    markDirty();
    openPhasePane(n.b, at, styles.flash!);
  }, []);

  const inspector = st.sel !== null;
  // инспектор открылся или закрылся — холст сменил ширину: выбранный узел снова в кадре
  const wasOpen = useRef(inspector);
  useEffect(() => {
    if (wasOpen.current === inspector) return;
    wasOpen.current = inspector;
    const s = flowState.spec;
    const sel = flowState.sel;
    if (!s || !sel) return;
    const at = selPhaseAt(s, sel);
    const key = at ? `p:${s.blocks[at.b]!.name}:${s.blocks[at.b]!.phases[at.i]!.name}` : sel.kind === 'block' ? `b:${sel.block.name}` : '';
    if (key) afterRender(() => revealNode(key));
  }, [inspector]);

  // Esc закрывает инспектор из него самого или с графа; поля поиска и папки ловят Esc сами
  const paneRef = useRef<HTMLElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || hidden || !flowState.sel) return;
      const t = e.target as HTMLElement;
      if (document.querySelector('dialog[open]') || !(t === document.body || paneRef.current?.contains(t) || graphRef.current?.contains(t))) return;
      clearSel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hidden]);

  if (!st.flow) return null;
  const selBlock = spec ? selBlockAt(spec, st.sel) : -1;

  return (
    <section className={styles.tabBuilder} hidden={hidden}>
      <BuilderBar />
      <p className={cx(msgClass(st.aiMsg), styles.builderNote)}>{st.aiMsg.text}</p>
      <pre className={cx(msgClass(st.bMsg), styles.builderNote)}>{st.bMsg.text}</pre>
      <AiResult />
      <div className={cx(styles.builderSplit, inspector && styles.withInsp)}>
        <div className={styles.builderCol}>
          {spec && graphModel && (
            <div ref={graphRef}>
              <FlowGraph
                model={graphModel}
                mode="edit"
                place="builder"
                host="builder"
                refitKey={st.refit}
                selectedName={st.graphSel}
                selectedBlock={selBlock}
                changed={st.ai?.diff.phases}
                chip={knowledgeChip}
                toolsOf={toolsOf}
                onNode={pick}
                onAdd={add}
                reveal={st.reveal}
              />
            </div>
          )}
          {/* резерв: все поля flow лентой; основной путь — клик по узлу → инспектор справа */}
          <div className={styles.builderMain}>
            {spec ? <BuilderList spec={spec} /> : <p className="error">{t('Flow не проходит валидацию: поправь его во вкладке YAML или опиши ИИ выше, что починить.')}</p>}
          </div>
        </div>
        <Inspector paneRef={paneRef} />
      </div>
    </section>
  );
}

/** Клик по узлу конструктора: этап — целиком в инспекторе справа, блок или условие — цикл блока там же, «Задача» — крупный редактор задачи по умолчанию. */
export function graphPick(n: GraphHit) {
  const spec = flowState.spec;
  if (!spec) return;
  if (n.kind === 'phase') openPhasePane(n.b!, n.i!, styles.flash!);
  else if (n.kind === 'block' || n.kind === 'cond') {
    if (paneShown()) return openBlockPane(n.b!);
    const panel = document.querySelector(`#bblock-${n.b} [data-bpanel]`);
    panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flash(panel, styles.flash!);
  } else if (n.kind === 'start') {
    const input = document.getElementById('b-input');
    if (paneShown() && input) {
      bindField({ scope: 'flow', key: 'input' });
      afterRender(() => document.querySelector<HTMLElement>('[data-pane="field"]')?.focus());
      return;
    }
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (n.kind === 'artifact') {
    const decl = document.getElementById('b-art-decl');
    decl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flash(decl, styles.flash!);
  }
}

/** Панель конструктора: правка с ИИ одной строкой и сохранение; липнет к верху. */
function BuilderBar() {
  const st = useFlowStore();
  const qc = useQueryClient();
  const defaultCwd = useConfig().data!.defaultCwd;
  const draft = Boolean(st.flow?.draft);
  const busy = Boolean(st.aiAbort);

  const aiEdit = async (e?: FormEvent) => {
    e?.preventDefault();
    const flow = flowState.flow;
    const instruction = flowState.aiText.trim();
    if (!flow || flowState.aiAbort) return;
    if (!instruction) return set({ aiMsg: { text: t('Опиши, что поменять'), tone: '' } });
    // база — то, что сейчас в конструкторе, вместе с несохранёнными правками; сломанный flow — текст YAML
    let base: { spec: Record<string, unknown> } | { yaml: string };
    try {
      base = flowState.spec ? { spec: collectSpec(flowState.spec) } : { yaml: flow.yaml };
    } catch (err) {
      return set({ aiMsg: { text: t('Сначала поправь конструктор: {error}', { error: errorText(err) }), tone: 'err' } });
    }
    const seq = flowState.editSeq;
    const ctl = new AbortController();
    // правка, которая идёт сейчас: чтение через функцию — после await она может быть уже другой
    const current = () => flowState.aiAbort;
    set({ aiAbort: ctl, aiMsg: { text: t('ИИ правит flow… обычно 20–90 секунд'), tone: '' } });
    try {
      const cwd = LS.raw('agentgraph.cwd') || defaultCwd;
      const r = await editFlow(flow.name, { instruction, ...base, cwd }, ctl.signal);
      if (current() !== ctl) return;
      if (!r.changed) {
        set({ aiMsg: { text: `${t('ИИ ничего не поменял')}${r.summary ? `:\n${r.summary}` : ''}`, tone: '' } });
        return;
      }
      const after = toEditable(r.spec);
      const ai = {
        undo: { spec: flowState.spec, dirty: flowState.dirty },
        summary: r.summary,
        diff: specChanges('spec' in base ? toEditable(base.spec as never) : null, after),
        stale: flowState.editSeq !== seq,
        cost: r.costUsd,
        seq: 0,
      };
      Object.assign(flowState, { ai, spec: after, aiText: '', aiMsg: NO_MSG, sel: null, graphSel: null });
      markDirty();
      ai.seq = flowState.editSeq;
    } catch (err) {
      if (current() !== ctl) return;
      set({ aiMsg: ctl.signal.aborted ? { text: t('Правка прервана'), tone: '' } : { text: errorText(err), tone: 'err' } });
    } finally {
      if (current() === ctl) set({ aiAbort: null });
    }
  };

  const save = async () => {
    const flow = flowState.flow;
    if (!flow || !flowState.spec) return;
    set({ bMsg: NO_MSG });
    const start = saveStart();
    try {
      const spec = collectSpec(flowState.spec);
      // черновик разового запуска: сервер только проверяет, в flows/ ничего не пишет
      const r = flow.draft ? await checkFlow({ spec }) : await saveFlowSpec(flow.name, spec);
      if (!applySaved(r, r.yaml, false, start)) {
        // пока сохранялось, открыли другой flow: сообщение ему не нужно, список flow — обновить
        if (!flow.draft) await qc.invalidateQueries({ queryKey: keys.flows });
        return;
      }
      const done = flow.draft ? t('Применено') : t('Сохранено');
      set({ bMsg: { text: done, tone: 'ok' } });
      setTimeout(() => {
        if (!flowState.dirty && flowState.bMsg.text === done) set({ bMsg: NO_MSG });
      }, 2500);
      if (!flow.draft) await qc.invalidateQueries({ queryKey: keys.flows });
    } catch (err) {
      if (flowState.flow !== start.flow) return;
      set({ bMsg: { text: errorText(err), tone: 'err' } });
      if (err instanceof SpecError && err.field) revealField(err.field, styles.flash!);
    }
  };

  return (
    <div className={styles.builderBar}>
      <form className={styles.aiEdit} onSubmit={(e) => void aiEdit(e)}>
        <span className={styles.aiEditLabel} aria-hidden="true">{t('ИИ')}</span>
        <textarea
          name="instruction"
          rows={1}
          aria-label={t('Правка с ИИ')}
          placeholder={t('Правка с ИИ: что поменять? Например, добавь этап ревью после реализации')}
          readOnly={busy}
          value={st.aiText}
          onChange={(e) => set({ aiText: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void aiEdit(e);
          }}
        />
        <button type="submit" className="btn" disabled={busy} title={t('Правки лягут в конструктор несохранёнными. ⌘/Ctrl+Enter')}>{t('Изменить')}</button>
        {busy && <button type="button" className="btn ghost" onClick={() => flowState.aiAbort?.abort()}>{t('Прервать')}</button>}
      </form>
      <div className={styles.builderSave} hidden={!st.spec}>
        <span className={styles.dirty}>{st.dirty ? (draft ? t('есть неприменённые изменения') : t('есть несохранённые изменения')) : ''}</span>
        <button
          type="button"
          className="btn primary"
          disabled={!st.dirty}
          title={draft ? t('Проверить и применить к черновику; в flows/ ничего не пишется') : t('Записать flow в flows/')}
          onClick={() => void save()}
        >
          {draft ? t('Применить') : t('Сохранить')}
        </button>
      </div>
    </div>
  );
}

/** Результат правки ИИ: что поменялось, цена, «Отменить правку». */
function AiResult() {
  const st = useFlowStore();
  const { askConfirm } = useConfirm();
  const ai = st.ai;
  if (!ai) return null;
  const undo = async () => {
    if (flowState.editSeq !== ai.seq && !(await askConfirm(t('После правки ИИ ты менял конструктор. Отменить правку ИИ вместе с этими изменениями?'), { ok: t('Отменить', undefined, 'undo') }))) return;
    Object.assign(flowState, { spec: ai.undo.spec, dirty: ai.undo.dirty, ai: null, sel: null, graphSel: null });
    emit();
  };
  const toPhase = (name: string) => {
    const s = flowState.spec!;
    const bi = s.blocks.findIndex((b) => b.phases.some((p) => p.name === name));
    if (bi < 0) return;
    const i = s.blocks[bi]!.phases.findIndex((p) => p.name === name);
    if (paneShown()) return openPhasePane(bi, i, styles.flash!);
    const card = document.getElementById(`pcard-${bi}-${i}`);
    if (!card) return;
    if (ai.diff.adv.has(name)) card.querySelector('details')?.setAttribute('open', '');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flash(card, styles.flash!);
  };
  return (
    <div className={styles.aiResult}>
      <div>
        <b>{t('ИИ поменял flow')}</b>{' '}
        <span className="muted small">
          · ≈{usd(ai.cost)} · {st.flow?.draft
            ? t('не применено: проверь изменения (подсвечены зелёным на графе) и нажми «Применить» или сразу «Запустить»')
            : t('не сохранено: проверь изменения (подсвечены зелёным на графе) и нажми «Сохранить»')}
        </span>
      </div>
      {ai.summary && <div className={styles.aiSummary}>{ai.summary}</div>}
      {ai.diff.lines.length > 0 && (
        <div className={styles.aiDiff}>
          <div className={styles.pLabel}>{t('Что изменилось в полях')}</div>
          <ul>
            {ai.diff.lines.map((l, k) => (
              <li key={k} data-phase={l.phase} onClick={l.phase ? () => toPhase(l.phase!) : undefined}>{l.text}</li>
            ))}
          </ul>
        </div>
      )}
      {ai.stale && <p className="msg err">{t('Правки в конструкторе, сделанные пока ИИ работал, в результат не вошли: «Отменить правку» вернёт их.')}</p>}
      <div className="row"><button type="button" className="btn" onClick={() => void undo()}>{t('Отменить правку')}</button></div>
    </div>
  );
}

/** «Все поля списком»: поля flow, артефакты, блоки с этапами, «Добавить блок». */
function BuilderList({ spec }: { spec: EditSpec }) {
  const st = useFlowStore();
  const flowField = (key: 'description' | 'input') => {
    const on = st.sel?.kind === 'field' && sameField(st.sel.field, { scope: 'flow', key });
    return { className: on ? styles.focusedSrc : undefined, onFocus: () => bindField({ scope: 'flow', key }) };
  };
  return (
    <div className={styles.builder}>
      <div className={styles.builderListHead}><span className={styles.runLabel}>{t('Все поля списком')}</span><span className="muted small">{t('клик по узлу на графе открывает его справа')}</span></div>
      <div className="panel">
        <label>
          <span>{t('Описание flow')}</span>
          <input id="b-description" {...flowField('description')} value={spec.description || ''} placeholder={t('Что делает этот flow')} onChange={(e) => { spec.description = e.target.value; markDirty(); }} />
        </label>
        <label>
          <span title={t('Подставится в {{input}}; при запуске можно переписать')}>{t('Задача по умолчанию')}</span>
          <textarea id="b-input" {...flowField('input')} rows={3} value={spec.input || ''} onChange={(e) => { spec.input = e.target.value; markDirty(); }} />
        </label>
      </div>
      <ArtifactsDecl spec={spec} />
      {spec.blocks.map((b, bi) => <BlockSection key={bi} bi={bi} />)}
      <div className={cx('row', styles.addBlock)}>
        <button
          className="btn"
          onClick={() => {
            newBlock(spec);
            markDirty();
            afterRender(() => document.getElementById(`bblock-${spec.blocks.length - 1}`)?.scrollIntoView({ behavior: 'smooth' }));
          }}
        >
          {t('Добавить блок')}
        </button>
        <span className="muted small" title={t('Например, ещё один цикл со своим условием')}>{t('начнётся, когда закончится предыдущий блок')}</span>
      </div>
    </div>
  );
}

/** Артефакты flow: только просмотр, правка — во вкладке YAML. */
function ArtifactsDecl({ spec }: { spec: EditSpec }) {
  const on = useFeature('artifacts');
  const entries = Object.entries(spec.artifacts || {});
  if (!on || !entries.length) return null;
  return (
    <div className={cx('panel', styles.artDecl)} id="b-art-decl">
      <div className={styles.artDeclHead}><h3>{t('Артефакты')}</h3><span className="muted small">{t('только просмотр: правка — во вкладке YAML')}</span></div>
      <ul>
        {entries.map(([key, a]) => {
          const lines = a.initial ? String(a.initial).split('\n').filter((x, i, all) => i < all.length - 1 || x).length : 0;
          const notes = [a.file || `${key}.md`, a.initial !== undefined ? t('заготовка: {n} {word}', { n: lines, word: plural(lines, 'строка', 'строки', 'строк') }) : t('создаётся пустым'), a.decisions ? t('сюда пишутся ответы на паузы') : ''].filter(Boolean);
          return <li key={key}><b>{a.title || key}</b> <code>{key}</code> <span className="muted small">{notes.join(' · ')}</span></li>;
        })}
      </ul>
    </div>
  );
}

type FieldInfo = { get: () => string; set: (v: string) => void; label: string; ctx: string; mono: boolean; input: boolean; placeholder: string };

/** Поле flow или блока для крупного редактора: чтение, запись, подпись, контекст. */
function fieldInfo(spec: EditSpec, f: FieldKey): FieldInfo | null {
  if (f.scope === 'flow') {
    return f.key === 'description'
      ? { get: () => spec.description || '', set: (v) => { spec.description = v; markDirty(); }, label: t('Описание flow'), ctx: 'Flow', mono: false, input: true, placeholder: t('Что делает этот flow') }
      : { get: () => spec.input || '', set: (v) => { spec.input = v; markDirty(); }, label: t('Задача по умолчанию'), ctx: 'Flow', mono: false, input: false, placeholder: '' };
  }
  const bi = spec.blocks.indexOf(f.block);
  if (bi < 0) return null;
  const b = f.block;
  const u = b.loop?.until;
  const ctx = isMulti(spec) ? blockHeading(b, bi) : t('Цикл');
  switch (f.key) {
    case 'title':
      return { get: () => b.title || '', set: (v) => { b.title = v; markDirty(); }, label: t('Название блока'), ctx, mono: false, input: true, placeholder: t('Название блока') };
    case 'until-run':
      return u ? { get: () => u.run || '', set: (v) => { u.run = v; markDirty(); }, label: t('Команда (её вывод уйдёт в {{feedback}})'), ctx, mono: false, input: true, placeholder: 'npm test' } : null;
    case 'until-prompt':
      return u ? { get: () => u.prompt || '', set: (v) => { u.prompt = v; markDirty(); }, label: t('Рубрика судьи'), ctx, mono: true, input: false, placeholder: '' } : null;
    case 'until-marker':
      return u ? { get: () => u.marker || '', set: (v) => { u.marker = v; markDirty(); }, label: t('Маркер'), ctx, mono: false, input: true, placeholder: '<DONE>' } : null;
    case 'knowledge':
      return { get: () => knowledgeDraft.get(b) || '', set: (v) => { knowledgeDraft.set(b, v); emit(); }, label: t('Теги знаний'), ctx, mono: false, input: true, placeholder: t('выбери из списка или впиши слаг и нажми Enter: qa') };
  }
}

/** Инспектор справа: этап целиком, блок (цикл и условие) или крупный редактор поля. Есть, только когда что-то выбрано. */
function Inspector({ paneRef }: { paneRef: RefObject<HTMLElement | null> }) {
  const st = useFlowStore();
  const spec = st.spec;
  const box = useRef<HTMLDivElement>(null);
  const sel = st.sel;
  const phaseAt = spec ? selPhaseAt(spec, sel) : null;
  const blockAt = spec && sel?.kind === 'block' ? spec.blocks.indexOf(sel.block) : -1;
  const field = spec && sel?.kind === 'field' ? fieldInfo(spec, sel.field) : null;

  // явное открытие (граф, «+», чип этапа): панель наверх, фокус в название этапа
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTop = 0;
    if (sel?.kind === 'phase') el.querySelector<HTMLElement>('[data-field="p-title"]')?.focus({ preventScroll: true });
  }, [st.openSeq]);

  // другой этап — панель наверх, как в старом showPhasePane
  const shownPhase = sel?.kind === 'phase' ? sel.phase : null;
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0;
  }, [shownPhase]);

  // этап или блок пропал (удалён, правка ИИ) — инспектор закрывается
  useEffect(() => {
    if (sel && !phaseAt && blockAt < 0 && !field) clearSel();
  });

  if (!spec || !sel || (!phaseAt && blockAt < 0 && !field)) return null;
  let ctx = '';
  let label = '';
  if (phaseAt) {
    const p = spec.blocks[phaseAt.b]!.phases[phaseAt.i]!;
    ctx = isMulti(spec) ? blockHeading(spec.blocks[phaseAt.b]!, phaseAt.b) : 'Flow';
    label = t('Этап {num} · {title}', { num: phaseNum(spec, phaseAt.b, phaseAt.i), title: p.title || p.name });
  } else if (blockAt >= 0) ({ ctx, label } = blockPaneTitles(spec, blockAt));
  else if (field) ({ ctx, label } = field);
  const v = field?.get() ?? '';

  return (
    <aside ref={paneRef} className={cx('big-editor', styles.focusPane)} aria-label={t('Выбранное в конструкторе')}>
      <div className="focus-head">
        <div className="focus-titles">
          <div className="focus-ctx">{ctx}</div>
          <div className="focus-label">{label}</div>
        </div>
        {field && <span className="muted small">{t('строк: {lines} · знаков: {chars}', { lines: v ? v.split('\n').length : 0, chars: v.length })}</span>}
        <button type="button" className="btn ghost small insp-close" title={t('Закрыть (Esc)')} aria-label={t('Закрыть')} onClick={clearSel}>×</button>
      </div>
      {field && (
        <textarea
          className={cx('big-editor-text', field.mono && 'mono')}
          data-pane="field"
          spellCheck={false}
          placeholder={field.placeholder}
          value={v}
          onChange={(e) => field.set(field.input ? e.target.value.replace(/\n/g, ' ') : e.target.value)}
          // однострочные поля (название, команда) не должны получать переносы строк
          onKeyDown={(e) => {
            if (e.key === 'Enter' && field.input) e.preventDefault();
          }}
        />
      )}
      {phaseAt && (
        <div ref={box} className={cx(styles.phasePane, styles.builder)} data-pane="phase">
          <PhaseCard key={phaseKey(spec.blocks[phaseAt.b]!.phases[phaseAt.i]!)} bi={phaseAt.b} i={phaseAt.i} pane />
        </div>
      )}
      {blockAt >= 0 && (
        <div ref={box} className={cx(styles.blockPane, styles.builder)} data-pane="block">
          <BlockPane bi={blockAt} />
        </div>
      )}
    </aside>
  );
}
