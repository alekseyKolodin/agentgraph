// Выбор в «Правке» (ui/app.js openPhasePane, showPhasePane, openBlockPane, bindFocus, clearFocus, revealField): этап, блок
// или «Настройки flow» открываются в правой панели вместо помощника (EditSide.tsx); на узком окне (≤1100px) панель
// стоит под схемой — к ней прокручиваем. Поля — data-field: по ним ищут прокрутка и фокус.
import type { FieldRef } from '../../lib/flow/edit';
import { emit, flowState, selPhaseAt, type FieldKey } from './store';

/** Правая панель «Правки» стоит справа от схемы (широкое окно), а не под ней. */
export const paneShown = (): boolean => matchMedia('(min-width: 1101px)').matches;

/** Узкое окно: панель под схемой — прокрутить к ней после перерисовки. */
function revealSide(): void {
  if (!paneShown()) afterRender(() => document.getElementById('edit-side')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

/** Подсветить элемент на 1.2 с (класс flash из модуля стилей): после перерисовки, иначе React перепишет className карточки. */
export function flash(el: Element | null, cls: string): void {
  if (!el) return;
  setTimeout(() => {
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 1200);
  });
}

/** После перерисовки: правка из обработчика события коммитится синхронно, к следующей задаче DOM карточек и полей — уже новый. */
export const afterRender = (fn: () => void): void => void setTimeout(fn);

/** Этап в инспекторе справа, без прокрутки и фокуса: фокус в карточке слева, правка с ИИ, сохранение. */
export function showPhasePane(bi: number, i: number): void {
  const p = flowState.spec?.blocks[bi]?.phases[i];
  if (!p) return;
  flowState.sel = { kind: 'phase', phase: p, b: bi, idx: i };
  emit();
}

/**
 * Единая точка входа «открыть этап»: его поля — в правой панели вместо помощника, этап выделен на схеме. flashCls
 * остался от ленты карточек (подсветка карточки) — сигнатуру зовут и снаружи (вкладка «Запуск»).
 */
export function openPhasePane(bi: number, i: number, _flashCls?: string): void {
  const p = flowState.spec?.blocks[bi]?.phases[i];
  if (!p) return;
  flowState.graphSel = p.name;
  flowState.sel = { kind: 'phase', phase: p, b: bi, idx: i };
  flowState.openSeq++;
  emit();
  revealSide();
}

/** Блок в инспекторе: цикл, условие и теги знаний. */
export function openBlockPane(bi: number): void {
  const block = flowState.spec?.blocks[bi];
  if (!block) return;
  flowState.graphSel = null;
  flowState.sel = { kind: 'block', block, b: bi };
  flowState.openSeq++;
  emit();
  revealSide();
}

/** «Настройки flow» в правой панели: описание, задача по умолчанию, файлы, блоки; focus — какое поле в фокус. */
export function openFlowSettings(focus: 'description' | 'input' | 'artifacts' = 'description'): void {
  flowState.sel = { kind: 'field', field: { scope: 'flow', key: focus === 'input' ? 'input' : 'description' } };
  flowState.graphSel = null;
  flowState.openSeq++;
  emit();
  revealSide();
  afterRender(() => {
    const el = document.getElementById(focus === 'artifacts' ? 'b-art-decl' : `b-${focus}`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    if (focus !== 'artifacts') el.focus({ preventScroll: true });
  });
}

/** К помощнику: выбор снят, этап на схеме остаётся выделенным. */
export function showAssistant(): void {
  flowState.sel = null;
  emit();
}

/** «Попросить ИИ поправить этап»: начало запроса — в поле помощника, курсор в конец. */
export function askAi(prefix: string): void {
  const text = flowState.aiText.trim();
  flowState.aiText = text.startsWith(prefix.trim()) ? flowState.aiText : prefix + (text ? `\n${text}` : '');
  showAssistant();
  afterRender(() => {
    const ta = document.getElementById('ai-ask') as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(prefix.length, prefix.length);
    if (!paneShown()) ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

/** Поле flow или блока — в крупный редактор справа (режим «поле»). Выделенный на графе этап больше не то, что в инспекторе. */
export function bindField(field: FieldKey): void {
  const sel = flowState.sel;
  if (sel?.kind === 'field' && sameField(sel.field, field)) return;
  flowState.sel = { kind: 'field', field };
  flowState.graphSel = null;
  emit();
}

export const sameField = (a: FieldKey, b: FieldKey): boolean =>
  a.scope === 'flow' ? b.scope === 'flow' && a.key === b.key : b.scope === 'block' && a.block === b.block && a.key === b.key;

/** × и Esc в инспекторе, правка ИИ, откат: снять выбор, граф снова во всю ширину. */
export function clearSel(): void {
  flowState.sel = null;
  flowState.graphSel = null;
  emit();
}

/** После перестановок и удалений: выбор на этапе или блоке, которого больше нет, снимается. */
export function dropStaleSel(): void {
  const spec = flowState.spec;
  const sel = flowState.sel;
  if (!spec || !sel) return;
  const gone = sel.kind === 'phase'
    ? !selPhaseAt(spec, sel)
    : sel.kind === 'block' ? !spec.blocks.includes(sel.block) : sel.field.scope === 'block' && !spec.blocks.includes(sel.field.block);
  if (gone) clearSel();
}

/** Поле с ошибкой сохранения: этап — в правой панели, поле — в фокус и в треть панели. */
export function revealField(ref: FieldRef, flashCls?: string): void {
  openPhasePane(ref.b, ref.i, flashCls);
  afterRender(() => {
    const box = document.querySelector<HTMLElement>('[data-pane="phase"]');
    const field = box?.querySelector<HTMLElement>(`[data-field="${ref.field}"]`);
    if (!box || !field) return;
    const adv = field.closest('details');
    if (adv) adv.open = true;
    field.focus({ preventScroll: true });
    box.scrollTop += field.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3;
  });
}
