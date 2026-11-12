// Markdown документа для чтения: renderMarkdown из lib/md.ts (экранирует всё сам), а номера задач, требований и пути
// документов проекта в тексте становятся ссылками (spec §8.4) — их ставит обход текстовых узлов после отрисовки, только
// через DOM-API, без HTML-строк. Клик ведёт по адресу внутри приложения: задача — панель ?task=, требование — якорь в ТЗ,
// документ — его вкладка. Пути документов, которые md.ts пометил «показать в Finder», тоже становятся ссылками документа.
import { createContext, useContext, useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { TeamDocName } from '@server/api-types';
import { markdownFits, renderMarkdown } from '../../../lib/md';
import { refTarget, reqAnchor, type RefTarget } from '../../../lib/teamwork/doc-view';
import { findRefs } from '../../../lib/teamwork/docs';
import { projectPath, TASK_PARAM } from '../shell';
import styles from './Docs.module.css';

/** Что нужно ссылкам: где мы, префикс номеров задач команды, известные номера требований (неизвестный — не ссылка). */
export type RefContext = { team: string; project: string; doc: TeamDocName; prefix: string; reqs?: ReadonlySet<string> };

export const RefCtx = createContext<RefContext | null>(null);

/** Адрес ссылки внутри приложения. */
export function refHref(target: RefTarget, ctx: RefContext, loc: { pathname: string; search: string }): string {
  if (target.kind === 'task') {
    const q = new URLSearchParams(loc.search);
    q.set(TASK_PARAM, target.id);
    return `${loc.pathname}?${q.toString()}`;
  }
  if (target.kind === 'req') return target.tab ? `${projectPath(ctx.team, ctx.project, 'prd')}#${reqAnchor(target.id)}` : `${loc.pathname}${loc.search}#${reqAnchor(target.id)}`;
  if (target.tab === 'docs') return `${projectPath(ctx.team, ctx.project, 'docs')}?doc=${encodeURIComponent(target.name ?? '')}`;
  return projectPath(ctx.team, ctx.project, target.tab);
}

const SKIP = new Set(['A', 'CODE', 'PRE']);

/** Ссылки в текстовых узлах контейнера; код и уже готовые ссылки не трогаем, пути документов из md.ts переделываем. */
function linkify(root: HTMLElement, ctx: RefContext, loc: { pathname: string; search: string }) {
  const make = (text: string, target: RefTarget) => {
    const a = document.createElement('a');
    a.textContent = text;
    a.href = refHref(target, ctx, loc);
    a.dataset.twRef = target.kind;
    a.className = styles.ref ?? '';
    return a;
  };
  // пути «показать в Finder» из md.ts, которые на деле документы проекта
  for (const el of root.querySelectorAll<HTMLElement>('a.path-link[data-path]')) {
    const text = el.textContent ?? '';
    const ref = findRefs(text, '').find((r) => r.kind === 'doc' && r.start === 0 && r.end === text.length);
    if (ref) el.replaceWith(make(text, refTarget(ref, ctx.doc)));
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      for (let p = n.parentElement; p && p !== root; p = p.parentElement) if (SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.data;
    const refs = findRefs(text, ctx.prefix).filter((r) => r.kind !== 'requirement' || !ctx.reqs || ctx.reqs.has(r.text.toUpperCase()));
    if (!refs.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const r of refs) {
      if (r.start > at) frag.append(text.slice(at, r.start));
      frag.append(make(r.text, refTarget(r, ctx.doc)));
      at = r.end;
    }
    if (at < text.length) frag.append(text.slice(at));
    node.replaceWith(frag);
  }
}

/** Переход по ссылке документа: якорь в этом же документе — прокрутка, остальное — адрес приложения. */
export function useRefClick() {
  const navigate = useNavigate();
  return (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.<HTMLAnchorElement>('a[data-tw-ref]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const url = new URL(a.href);
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) {
      scrollToAnchor(decodeURIComponent(url.hash.slice(1)));
      void navigate({ pathname: url.pathname, search: url.search, hash: url.hash }, { replace: true });
      return;
    }
    void navigate({ pathname: url.pathname, search: url.search, hash: url.hash });
  };
}

/** Прокрутить к элементу с id и коротко подсветить его. */
export function scrollToAnchor(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  el.classList.remove(styles.flash ?? '');
  void el.offsetWidth;
  el.classList.add(styles.flash ?? '');
}

/** Markdown куска документа со ссылками. inline — без отступа последнего абзаца (строка требования). */
export function DocText({ text, className }: { text: string; className?: string }) {
  const ctx = useContext(RefCtx);
  const loc = useLocation();
  const host = useRef<HTMLDivElement>(null);
  const onClick = useRefClick();
  const html = useMemo(() => {
    if (!markdownFits(text)) return null;
    try {
      return renderMarkdown(text);
    } catch {
      return null;
    }
  }, [text]);
  useLayoutEffect(() => {
    if (host.current && ctx && html !== null) linkify(host.current, ctx, loc);
  }, [html, ctx, loc.pathname, loc.search]);
  if (html === null) return <pre className={styles.plain}>{text}</pre>;
  // dangerouslySetInnerHTML — только результат renderMarkdown: он экранирует весь текст сам
  return <div ref={host} className={`md ${styles.rd} ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
