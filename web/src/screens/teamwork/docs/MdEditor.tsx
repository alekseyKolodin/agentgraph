// Редактор текста раздела на CodeMirror 6 (как YamlEditor редактора flow) с живой разметкой markdown: в виде «Текст»
// заголовки, жирный, курсив, код и ссылки выглядят как при чтении, а метки разметки притушены; в виде «Markdown» — исходник
// моноширинно. Язык — markdownLanguage из @codemirror/lang-markdown без markdown(): та обёртка тянет за собой lang-html.
// ⌘S — сохранить раздел, Esc — отменить, ⌘B/⌘I — жирный и курсив; Enter продолжает список.
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { insertNewlineContinueMarkup, deleteMarkupBackward, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState, RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, drawSelection, EditorView, keymap, placeholder, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { tags as tg } from '@lezer/highlight';
import { wrapMark } from '../../../lib/teamwork/doc-view';

/** Что панель раздела делает с редактором, в котором стоит курсор (этот или строка требования). */
export type EditTarget = { wrap: (mark: string) => void; insert: (text: string) => void; focus: () => void };

/** Живая разметка: цвета «Пульта», статусные цвета не заняты; ссылки — --live, как в тексте для чтения. */
const live = HighlightStyle.define([
  { tag: tg.heading1, fontSize: 'var(--fs-h1)', fontWeight: '600' },
  { tag: tg.heading2, fontSize: 'var(--fs-h2)', fontWeight: '600' },
  { tag: [tg.heading3, tg.heading4, tg.heading5, tg.heading6], fontSize: 'var(--fs-h3)', fontWeight: '600' },
  { tag: tg.strong, fontWeight: '600' },
  { tag: tg.emphasis, fontStyle: 'italic' },
  { tag: tg.strikethrough, textDecoration: 'line-through' },
  { tag: tg.monospace, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small)', color: 'var(--ink)' },
  { tag: [tg.link, tg.url], color: 'var(--live)' },
  { tag: tg.quote, color: 'var(--ink-2)' },
  { tag: [tg.processingInstruction, tg.contentSeparator, tg.labelName], color: 'var(--ink-off)' },
  { tag: tg.comment, color: 'var(--ink-3)', fontStyle: 'italic' },
]);

/** Исходник: шрифт моно, разметка различима, но без размеров. */
const source = HighlightStyle.define([
  { tag: [tg.heading1, tg.heading2, tg.heading3, tg.heading4, tg.heading5, tg.heading6, tg.strong], color: 'var(--ink)', fontWeight: '600' },
  { tag: tg.emphasis, fontStyle: 'italic' },
  { tag: [tg.link, tg.url], color: 'var(--live)' },
  { tag: [tg.processingInstruction, tg.contentSeparator, tg.labelName, tg.monospace], color: 'var(--ink-3)' },
  { tag: tg.comment, color: 'var(--ink-3)', fontStyle: 'italic' },
]);

const base = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--well)', color: 'var(--ink)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-sm)' },
    '&.cm-focused': { outline: 'none', borderColor: 'var(--live)' },
    '.cm-content': { padding: '8px 0', caretColor: 'var(--ink)', minHeight: '72px' },
    '.cm-line': { padding: '0 12px' },
    '.cm-cursor': { borderLeftColor: 'var(--ink)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(122, 167, 255, .25)' },
    '.cm-placeholder': { color: 'var(--ink-3)' },
    '.tw-req-id': { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-meta)', color: 'var(--ink-2)' },
  },
  { dark: true },
);
const liveTheme = EditorView.theme({ '.cm-scroller': { fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-read)', lineHeight: '1.65' } }, { dark: true });
const sourceTheme = EditorView.theme({ '.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small)', lineHeight: '1.55' } }, { dark: true });

const REQ_ID = /^- (?:N?FR)-\d+\./;
const reqMark = Decoration.mark({ class: 'tw-req-id' });
/** Номер требования в начале строки «- FR-3.» — моно, как на полях при чтении. */
const reqIds = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          const m = line.text.match(REQ_ID);
          if (m) b.add(line.from + 2, line.from + m[0].length, reqMark);
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

const modeExt = (liveMode: boolean): Extension => (liveMode ? [syntaxHighlighting(live), liveTheme, reqIds] : [syntaxHighlighting(source), sourceTheme]);

/** Обернуть выделение меткой разметки (wrapMark — снимает, если уже обёрнуто). */
function wrapIn(view: EditorView, mark: string) {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc.toString();
  const lo = Math.max(0, from - mark.length - 1);
  const hi = Math.min(doc.length, to + mark.length + 1);
  const r = wrapMark(doc.slice(lo, hi), from - lo, to - lo, mark);
  view.dispatch({ changes: { from: lo, to: hi, insert: r.text }, selection: EditorSelection.range(lo + r.from, lo + r.to) });
  view.focus();
}

type Props = {
  value: string;
  live: boolean;
  label: string;
  placeholderText?: string;
  autoFocus?: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  /** Курсор пришёл в редактор: панель раздела работает с ним. */
  onTarget?: (t: EditTarget) => void;
  ref?: Ref<EditTarget>;
};

export function MdEditor({ value, live: liveMode, label, placeholderText, autoFocus, onChange, onSave, onCancel, onTarget, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const mode = useRef(new Compartment());
  // обработчики читаются из ref: состояние CodeMirror создаётся один раз
  const cb = useRef({ onChange, onSave, onCancel, onTarget });
  cb.current = { onChange, onSave, onCancel, onTarget };
  const target = useRef<EditTarget>({
    wrap: (m) => view.current && wrapIn(view.current, m),
    insert: (text) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length) });
      v.focus();
    },
    focus: () => view.current?.focus(),
  });

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          new LanguageSupport(markdownLanguage),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (cb.current.onSave(), true) },
            { key: 'Escape', run: () => (cb.current.onCancel(), true) },
            { key: 'Mod-b', preventDefault: true, run: (vw) => (wrapIn(vw, '**'), true) },
            { key: 'Mod-i', preventDefault: true, run: (vw) => (wrapIn(vw, '*'), true) },
            { key: 'Enter', run: insertNewlineContinueMarkup },
            { key: 'Backspace', run: deleteMarkupBackward },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
            if (u.focusChanged && u.view.hasFocus) cb.current.onTarget?.(target.current);
          }),
          EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true' }),
          placeholder(placeholderText ?? ''),
          base,
          mode.current.of(modeExt(liveMode)),
        ],
      }),
    });
    view.current = v;
    if (autoFocus) {
      v.focus();
      v.dispatch({ selection: EditorSelection.cursor(v.state.doc.length), scrollIntoView: false });
    }
    return () => v.destroy();
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: mode.current.reconfigure(modeExt(liveMode)) });
  }, [liveMode]);

  useImperativeHandle(ref, () => target.current, []);
  return <div ref={host} />;
}
