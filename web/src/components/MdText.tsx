// Текст агента — markdown (ui/app.js mdText, safeMarkdown): вопрос, описание варианта, вступление перед вопросом.
// Огромный — как есть, с экранированием. Сбой рендерера не роняет экран: тогда исходник моноширинно.
import { markdownFits, renderMarkdown } from '../lib/md';

export function MdText({ text }: { text: string | null | undefined }) {
  const s = String(text ?? '');
  if (!markdownFits(s)) return <div className="plain">{s}</div>;
  let html: string;
  try {
    html = renderMarkdown(s);
  } catch {
    return <pre>{s}</pre>;
  }
  // dangerouslySetInnerHTML — только с результатом renderMarkdown: он экранирует весь текст сам
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Markdown без проверки размера (ui/app.js safeMarkdown): вывод этапа, замечания судьи, саммари. Сбой рендерера — исходник моноширинно. */
export function SafeMarkdown({ text }: { text: string }) {
  let html: string;
  try {
    html = renderMarkdown(text);
  } catch {
    return <pre>{text}</pre>;
  }
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
