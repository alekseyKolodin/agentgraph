// Заглушка доски дел (docs/desk/plan-5.md, сессия board пишет настоящую с тем же путём и пропсами): пока её нет,
// Главная монтирует это — открытые дела по колонкам, одна строка на дело. При слиянии заменяется целиком.
import { useDesk } from '../../../api/desk';
import { t } from '../../../lib/i18n';

const COLUMNS = [['new', 'Новое'], ['plan', 'В плане'], ['work', 'В работе'], ['waiting', 'Ждёт других'], ['done', 'Готово']] as const;

/** project — срез по проекту (из адреса Главной), onProject — сменить срез (пилюли проектов над доской). */
export function DeskBoard({ project }: { project?: string; onProject?: (slug: string | undefined) => void }) {
  const items = (useDesk().data?.items ?? []).filter((i) => !project || i.project === project);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 8 }}>
      {COLUMNS.map(([col, label]) => {
        const list = items.filter((i) => i.column === col);
        return (
          <section key={col} style={{ background: 'var(--well)', borderRadius: 'var(--r-md)', padding: 10, minWidth: 0 }}>
            <h2 className="small">{t(label)} <span className="muted">{list.length}</span></h2>
            {list.map((i) => (
              <article key={i.key} data-desk-key={i.key} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 8, marginTop: 6 }}>
                <span className="muted small">{i.kind}</span> <b>{i.title}</b>
                <div className="muted small">{i.why}</div>
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
