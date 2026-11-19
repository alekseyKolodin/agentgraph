// Плитки шаблонов рутин (lib/routines/templates.ts): пустой список рутин и пустая доска дел на Главной ведут к ним.
// Свой модуль стилей, без parts.tsx: Главная грузится сразу и не тянет за собой стили экрана рутин.
import { Link } from 'react-router';
import { t } from '../../lib/i18n';
import { ROUTINE_TEMPLATES } from '../../lib/routines/templates';
import styles from './RoutineTemplates.module.css';

/** deskOnly — только шаблоны «Моих дел» (заводят дела). */
export function RoutineTemplates({ deskOnly = false }: { deskOnly?: boolean }) {
  const list = deskOnly ? ROUTINE_TEMPLATES.filter((x) => x.desk) : ROUTINE_TEMPLATES;
  return (
    <div className={styles.tpls}>
      {list.map((x) => (
        <Link key={x.tpl} className={x.desk && !deskOnly ? `${styles.tpl} ${styles.tplDesk}` : styles.tpl} to={`/routines/new?tpl=${x.tpl}`}>
          <b>{t(x.title)}</b>
          <span>{t(x.sub)}</span>
        </Link>
      ))}
    </div>
  );
}
