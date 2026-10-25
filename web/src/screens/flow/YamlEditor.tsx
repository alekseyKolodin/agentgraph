// Редактор YAML на CodeMirror 6 (вместо textarea#yaml-editor старого UI): подсветка YAML, номера строк, история, Tab — отступ.
// Документ заменяется текстом flow, только когда меняется seq (открыли другой flow, сохранили); правки пользователя не трогаются.
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export type YamlEditorHandle = { value: () => string };

/** Цвета «Пульта»: ключи — основной текст, значения — второй уровень, служебное — тихое; цвет статусов не занимаем. */
const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--ink)' },
  { tag: [t.string, t.special(t.string), t.content], color: 'var(--ink-2)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--cat-3)' },
  { tag: [t.comment, t.lineComment], color: 'var(--ink-3)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.meta, t.labelName, t.typeName], color: 'var(--ink-3)' },
  { tag: t.invalid, color: 'var(--st-fail)' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '60vh', backgroundColor: 'var(--panel)', color: 'var(--ink)', fontSize: 'var(--fs-small)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.45', fontVariantNumeric: 'tabular-nums' },
    '.cm-content': { padding: '8px 0', caretColor: 'var(--ink)' },
    '.cm-line': { padding: '0 10px' },
    '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--ink-off)', border: 'none', borderRight: '1px solid var(--line)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-3)' },
    '.cm-activeLine': { backgroundColor: 'var(--hover)' },
    '.cm-cursor': { borderLeftColor: 'var(--ink)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(122, 167, 255, .25)' },
  },
  { dark: true },
);

const extensions = [
  lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(),
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  yaml(), syntaxHighlighting(highlight), EditorState.tabSize.of(2), indentUnit.of('  '),
  EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': 'YAML flow' }), theme,
];

export function YamlEditor({ value, seq, className, ref }: { value: string; seq: number; className?: string; ref: Ref<YamlEditorHandle> }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    // другой текст flow — новое состояние: история правок прежнего текста не нужна
    v.setState(EditorState.create({ doc: value, extensions }));
  }, [seq]);

  useImperativeHandle(ref, () => ({ value: () => view.current?.state.doc.toString() ?? '' }), []);
  return <div ref={host} className={className} />;
}
