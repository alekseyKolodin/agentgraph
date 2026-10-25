// Выбор в конструкторе (ui/app.js openPhasePane, showPhasePane, openBlockPane, bindFocus, clearFocus, focusPhaseCard, revealField):
// на широком экране — инспектор справа, на узком (≤1100px, инспектора нет) — карточка или панель в ленте.
// Карточки в ленте — с id pcard-<блок>-<этап>, блоки — bblock-<блок>, поля — data-field: по ним ищут прокрутка и фокус.
import type { FieldRef } from '../../lib/flow/edit';
import { emit, flowState, selPhaseAt, type FieldKey } from './store';

export const paneShown = (): boolean => matchMedia('(min-width: 1101px)').matches;

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

/** Единая точка входа «открыть этап»: на широком экране — целиком в редакторе справа, на узком — карточка слева. */
export function openPhasePane(bi: number, i: number, flashCls: string): void {
  const p = flowState.spec?.blocks[bi]?.phases[i];
  if (!p) return;
  flowState.graphSel = p.name;
  if (!paneShown()) {
    emit();
    afterRender(() => focusPhaseCard(bi, i, flashCls));
    return;
  }
  flowState.sel = { kind: 'phase', phase: p, b: bi, idx: i };
  flowState.openSeq++;
  emit();
}

/** Карточка этапа слева (узкое окно, где редактора справа нет): прокрутить, подсветить, фокус в промпт. */
export function focusPhaseCard(bi: number, i: number, flashCls: string): void {
  const card = document.getElementById(`pcard-${bi}-${i}`);
  if (!card) return;
  card.querySelector<HTMLElement>('[data-field="p-prompt"]')?.focus({ preventScroll: true });
  const at = flowState.spec ? selPhaseAt(flowState.spec, flowState.sel) : null;
  if (!at || at.b !== bi || at.i !== i) showPhasePane(bi, i);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  flash(card, flashCls);
}

/** Блок в инспекторе: цикл, условие и теги знаний. */
export function openBlockPane(bi: number): void {
  const block = flowState.spec?.blocks[bi];
  if (!block) return;
  flowState.graphSel = null;
  flowState.sel = { kind: 'block', block, b: bi };
  flowState.openSeq++;
  emit();
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

/** Поле с ошибкой сохранения: на широком экране — в редакторе этапа справа, на узком — в карточке слева. */
export function revealField(ref: FieldRef, flashCls: string): void {
  if (paneShown()) {
    openPhasePane(ref.b, ref.i, flashCls);
    afterRender(() => {
      const box = document.querySelector<HTMLElement>('[data-pane="phase"]');
      const field = box?.querySelector<HTMLElement>(`[data-field="${ref.field}"]`);
      if (!box || !field) return;
      field.focus({ preventScroll: true });
      box.scrollTop += field.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3;
    });
    return;
  }
  const el = document.querySelector<HTMLElement>(`#pcard-${ref.b}-${ref.i} [data-field="${ref.field}"]`);
  if (!el) return;
  const adv = el.closest('details');
  if (adv) adv.open = true;
  el.focus();
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
