// Значки экранов «Сессии»: штриховые SVG в цвет текста, 14px (как .caret и .icon-btn в base.css).
import type { ReactNode } from 'react';

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

export const ICON = {
  back: icon(<path d="M15 18l-6-6 6-6" />),
  pencil: icon(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>),
  folder: icon(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  stop: icon(<rect x="6" y="6" width="12" height="12" rx="2" />),
  clock: icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  book: icon(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>),
  x: icon(<path d="M18 6L6 18M6 6l12 12" />),
  refresh: icon(<><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>),
};

/** Путь от домашней папки: «/Users/me/proj/shop» → «~/proj/shop». */
export const tildePath = (p: string, home: string | undefined): string => (home && (p === home || p.startsWith(home + '/')) ? `~${p.slice(home.length)}` : p);
