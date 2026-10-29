// Пути к файлам по клику — в Finder (фича reveal, POST /api/reveal). Ссылки бывают четырёх видов: <PathLink> в разметке
// экранов, <PathText> в моноширинном тексте (транскрипт, лог условия), HTML из md.ts (вывод этапов, вопросы, саммари)
// и узлы живого лога (appendPaths). Клик по всем ловит один
// обработчик на документе (PathLinks в оболочке) по data-path; относительный путь сервер ищет от cwd запуска из
// ближайшего data-run. Ссылка без href: текст пути можно выделить и скопировать, перетаскиванием он не уезжает.
import { useEffect, type ReactNode } from 'react';
import { api, errorText, useFeature } from '../api';
import { splitPaths } from '../lib/paths';
import { t } from '../lib/i18n';
import { useToast } from './Toast';

const hint = (path: string) => `${path}\n${t('Показать в Finder')}`;

/** Путь в разметке экрана: при reveal — ссылка, без него — просто текст. */
export function PathLink({ path, className, children }: { path: string; className?: string; children?: ReactNode }) {
  const can = useFeature('reveal');
  if (!can) return <span className={className} title={path}>{children ?? path}</span>;
  return (
    <a className={className ? `path-link ${className}` : 'path-link'} data-path={path} role="link" tabIndex={0} title={hint(path)}>
      {children ?? path}
    </a>
  );
}

/** Больше — без ссылок: тысячи узлов на огромный транскрипт не нужны, как и разметка md.ts выше её порога. */
export const PATH_TEXT_MAX = 300_000;

/** Моноширинный текст с путями-ссылками: внутрь <pre>. */
export function PathText({ text }: { text: string }) {
  if (text.length > PATH_TEXT_MAX) return text;
  return splitPaths(text).map((p, i) =>
    typeof p === 'string' ? p : <a key={i} className="path-link" data-path={p.path} role="link" tabIndex={0}>{p.path}</a>,
  );
}

/** Ссылка на путь узлом DOM — для текста, который пишется мимо React. text — подпись, если она не сам путь (с ~). */
export function pathAnchor(path: string, text = path): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'path-link';
  a.dataset.path = path;
  a.setAttribute('role', 'link');
  a.tabIndex = 0;
  a.textContent = text;
  return a;
}

/** Текст с путями в узел: для живого лога, который пишется мимо React. */
export function appendPaths(el: Node, text: string): void {
  for (const piece of splitPaths(text)) el.appendChild(typeof piece === 'string' ? document.createTextNode(piece) : pathAnchor(piece.path));
}

export function PathLinks() {
  const can = useFeature('reveal');
  const toast = useToast();
  useEffect(() => {
    // без reveal ссылки из md.ts и лога выглядят обычным текстом (стили — под :root[data-reveal])
    document.documentElement.toggleAttribute('data-reveal', can);
    if (!can) return;
    const go = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key !== 'Enter' : e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.<HTMLElement>('.path-link[data-path]');
      if (!a?.dataset.path) return;
      // выделили часть пути, чтобы скопировать, — это не клик
      const sel = getSelection();
      if (sel && !sel.isCollapsed && a.contains(sel.anchorNode)) return;
      // до обработчиков React: клик по пути внутри строки или карточки не открывает ещё и её
      // (и не долетает до слушателей «клик снаружи» на document — всплывашка над путём от него не закроется)
      e.preventDefault();
      e.stopPropagation();
      // двойной клик выделяет слово: Finder уже открыт первым кликом, второй раз не нужен
      if (e instanceof MouseEvent && e.detail > 1) return;
      const run = a.closest<HTMLElement>('[data-run]')?.dataset.run;
      api('POST', '/api/reveal', { path: a.dataset.path, ...(run ? { run } : {}) }).catch((err) => toast(errorText(err)));
    };
    // наведение на ссылку из md.ts или лога — подсказка, как у <PathLink>
    const over = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.<HTMLElement>('a.path-link[data-path]');
      if (a && !a.title) a.title = hint(a.dataset.path!);
    };
    document.addEventListener('click', go, true);
    document.addEventListener('keydown', go, true);
    document.addEventListener('mouseover', over);
    return () => {
      document.removeEventListener('click', go, true);
      document.removeEventListener('keydown', go, true);
      document.removeEventListener('mouseover', over);
    };
  }, [can, toast]);
  return null;
}
