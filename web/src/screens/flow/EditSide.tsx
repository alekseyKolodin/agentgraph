// Правая панель «Правки»: сегмент «Помощник | Этап N». Без выбора — помощник (Assistant.tsx), клик по этапу или блоку
// на схеме — его поля (бывший инспектор), «Настройки flow» — поля самого flow. Esc и × возвращают к помощнику; помощник
// при этом не размонтируется — лента и набранный запрос остаются.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { AiModelSelect } from '../../components/AiProgress';
import { blockHeading, isCall, isMulti, phaseNum } from '../../lib/flow/edit';
import { t } from '../../lib/i18n';
import { clearSel, showAssistant } from './actions';
import { Assistant } from './Assistant';
import { BlockPane, blockPaneTitles, phaseKey } from './BlockEditor';
import { FlowSettings } from './FlowSettings';
import { PhaseCard } from './PhaseCard';
import { flowState, selPhaseAt, useFlowStore } from './store';
import styles from './Flow.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

export function EditSide() {
  const st = useFlowStore();
  const spec = st.spec;
  const sel = st.sel;
  const box = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLElement>(null);
  const phaseAt = spec ? selPhaseAt(spec, sel) : null;
  const blockAt = spec && sel?.kind === 'block' ? spec.blocks.indexOf(sel.block) : -1;
  const settings = Boolean(spec && sel?.kind === 'field' && sel.field.scope === 'flow');
  const open = Boolean(phaseAt || blockAt >= 0 || settings);

  // панель липнет к верху, но начинается под шапкой flow: высота — от её верха до низа окна, чтобы поле «Что поменять»
  // было видно без прокрутки страницы; на узком окне (панель под схемой) высота своя, из CSS
  useLayoutEffect(() => {
    const el = side.current;
    if (!el) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (getComputedStyle(el).position !== 'sticky') return void el.style.removeProperty('--side-h');
        const top = Math.max(el.getBoundingClientRect().top, 8);
        el.style.setProperty('--side-h', `${Math.max(420, window.innerHeight - top - 12)}px`);
      });
    };
    fit();
    // плашка «не сохранено» появилась или ушла — панель сдвинулась без прокрутки
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement?.parentElement ?? el);
    window.addEventListener('resize', fit);
    document.addEventListener('scroll', fit, true);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', fit);
      document.removeEventListener('scroll', fit, true);
    };
  }, []);

  // Esc из панели или со схемы — к помощнику; поля поиска и папки ловят Esc сами
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !flowState.sel || flowState.tab !== 'edit') return;
      const el = e.target as HTMLElement;
      if (document.querySelector('dialog[open]')) return;
      if (!(el === document.body || side.current?.contains(el) || el.closest?.('[data-edit-graph]'))) return;
      clearSel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // явное открытие (схема, «+», строка «Что изменилось»): панель наверх, фокус в название этапа
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

  // этап или блок пропал (удалён, правка ИИ, отмена) — назад к помощнику
  useEffect(() => {
    if (sel && !open) showAssistant();
  });

  let tab = '';
  let ctx = '';
  if (spec && phaseAt) {
    tab = t('Этап {num}', { num: phaseNum(spec, phaseAt.b, phaseAt.i) });
    if (isMulti(spec)) ctx = blockHeading(spec.blocks[phaseAt.b]!, phaseAt.b);
  } else if (spec && blockAt >= 0) {
    const b = spec.blocks[blockAt]!;
    tab = isCall(b) ? t('Вызов flow') : isMulti(spec) ? t('Блок {n}', { n: blockAt + 1 }) : b.loop ? t('Повторы') : t('Блок');
    ctx = blockPaneTitles(spec, blockAt).label;
  } else if (settings) tab = t('Настройки flow');

  return (
    <aside ref={side} id="edit-side" className={styles.editSide} aria-label={open ? tab : t('Помощник')}>
      <div className={styles.sideHead}>
        <div className={styles.sideSeg} role="tablist" aria-label={t('Правая панель')}>
          <button type="button" role="tab" aria-selected={!open} className={!open ? styles.on : undefined} onClick={showAssistant}>{t('Помощник')}</button>
          {open && <button type="button" role="tab" aria-selected className={styles.on}>{tab}</button>}
        </div>
        <span className={styles.grow} />
        {open
          ? <button type="button" className="btn ghost small insp-close" title={t('К помощнику (Esc)')} aria-label={t('Закрыть')} onClick={clearSel}>×</button>
          : <AiModelSelect quiet disabled={Boolean(st.aiAbort)} />}
      </div>
      {/* ход правки — в помощнике, а он скрыт, пока открыт этап: предупреждение о ручных правках — здесь */}
      {open && st.aiAbort && st.editSeq !== st.aiStartSeq && (
        <p className={styles.sideWarn} role="status">{t('ИИ ещё правит flow: эти правки в его результат не войдут — «Отменить правку» вернёт их.')}</p>
      )}
      <Assistant hidden={open} />
      {open && spec && (
        <div ref={box} className={cx(styles.sideBody, styles.builder)} data-pane={phaseAt ? 'phase' : blockAt >= 0 ? 'block' : 'flow'}>
          {ctx && <div className={styles.sideCtx}>{ctx}</div>}
          {phaseAt && (
            <div className={styles.phasePane}>
              <PhaseCard key={phaseKey(spec.blocks[phaseAt.b]!.phases[phaseAt.i]!)} bi={phaseAt.b} i={phaseAt.i} pane />
            </div>
          )}
          {blockAt >= 0 && <div className={styles.blockPane}><BlockPane bi={blockAt} /></div>}
          {settings && <FlowSettings spec={spec} />}
        </div>
      )}
    </aside>
  );
}
