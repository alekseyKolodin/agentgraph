// Работа закрытых дел уходит с глаз (docs/desk/SPEC.md, 6.3): по всем делам доски задаёт фильтр точки расширения
// closed-work.ts — списки запусков и сессий в сайдбаре и на экране сессий перерисуются сами. Монтируется в Shell.
import { useEffect } from 'react';
import { useDesk } from '../../api/desk';
import { setClosedWork } from '../../lib/closed-work';
import { closedWorkFrom } from '../../lib/desk-month';

const ALL = {};

export function useClosedWorkFeed(): void {
  const desk = useDesk(ALL);
  const items = desk.data?.items;
  useEffect(() => {
    if (items) setClosedWork(closedWorkFrom(items));
  }, [items]);
  // ушли с экрана (выход) — фильтр снят: ничего не прячется без дел
  useEffect(() => () => setClosedWork(null), []);
}
