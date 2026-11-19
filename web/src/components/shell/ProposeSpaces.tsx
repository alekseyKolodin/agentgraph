// Последняя строка группы «Без проекта» у запусков и сессий: работу без пространства предлагают отнести в проект —
// существующим «Предложить пространства» на экране пространств (GroupsPanel; /spaces?propose открывает его панель).
import { Link } from 'react-router';
import { useFeature } from '../../api';
import { t } from '../../lib/i18n';
import styles from './Sidebar.module.css';

export function ProposeSpaces() {
  const on = useFeature('space-drafts');
  if (!on) return null;
  return (
    <li className={styles.more}>
      <Link className={styles.moreBtn} to="/spaces?propose" title={t('Модель разложит сессии и запуски без пространства по работе и предложит пространства; создашь их ты')}>
        {t('Предложить пространства…')}
      </Link>
    </li>
  );
}
