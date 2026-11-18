// «Папка проекта» рутины: поле, «Выбрать…» (системный диалог, фича pick-dir) и чипы недавних папок под ним —
// как в форме запуска flow. Пусто — папка пространства или папка по умолчанию.
import { useFeature, useRecentDirs } from '../../api';
import { PickDirButton } from '../../components/PickDirButton';
import { t } from '../../lib/i18n';
import { recentChips } from '../../lib/run-form';
import { cx } from './parts';
import styles from './Routines.module.css';

export function CwdField({ value, onChange }: { value: string; onChange: (cwd: string) => void }) {
  const recent = recentChips(useRecentDirs(useFeature('recent-dirs')).data ?? []);
  const cur = value.trim();
  return (
    <>
      <div className={styles.inline}>
        <input className={cx(styles.inp, styles.mono)} aria-label={t('Папка проекта')} placeholder={t('папка пространства или папка по умолчанию')} value={value} onChange={(e) => onChange(e.target.value)} />
        <PickDirButton className="btn small" prompt={t('Папка проекта для рутины')} start={() => value} onPick={onChange} />
      </div>
      {recent.length > 0 && (
        <div className={cx('chips', styles.recentDirs)}>
          <span className={styles.hint}>{t('Недавние:')}</span>
          {recent.map((d) => (
            <button key={d.path} type="button" className={cx('chip', d.path === cur && 'on')} title={d.path} onClick={() => onChange(d.path)}>
              {d.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
