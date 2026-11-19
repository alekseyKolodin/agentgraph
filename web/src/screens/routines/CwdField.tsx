// «Папка проекта» рутины: поле, «Выбрать…» (системный диалог, фича pick-dir) и чипы недавних папок под ним —
// как в форме запуска flow. Пусто — папка пространства или папка по умолчанию. Под полем — что сервер увидел в папке:
// нет такой, не репозиторий git, репозиторий и ветка. С worktree/onWorktree — ещё и «Где работать»: прямо в папке или
// в отдельной ветке (git worktree), и ошибка словами, если выбрана ветка, а папка не репозиторий.
import { useEffect, useState } from 'react';
import { useFeature, useRecentDirs } from '../../api';
import { useDirCheck } from '../../api/routines';
import { PickDirButton } from '../../components/PickDirButton';
import { t } from '../../lib/i18n';
import { dirNote, type DirNote } from '../../lib/routines/dir';
import { recentChips } from '../../lib/run-form';
import { cx, Seg } from './parts';
import notes from './ComposeBox.module.css';
import styles from './Routines.module.css';

/** Проверка папки с паузой на набор: запрос уходит, когда человек перестал печатать. */
export function useDirNote(value: string, worktree: 'new' | 'none' | undefined): DirNote | undefined {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(value), 400);
    return () => clearTimeout(h);
  }, [value]);
  const settled = value.trim() === debounced.trim();
  const check = useDirCheck(settled ? debounced : '');
  return settled && value.trim() ? dirNote(check.data, worktree) : undefined;
}

type Props = {
  value: string;
  onChange: (cwd: string) => void;
  /** Где работать: есть — показываем выбор «прямо в папке / в отдельной ветке» (у редактора он свой, рядом). */
  worktree?: 'new' | 'none';
  onWorktree?: (w: 'new' | 'none') => void;
};

export function CwdField({ value, onChange, worktree, onWorktree }: Props) {
  const recent = recentChips(useRecentDirs(useFeature('recent-dirs')).data ?? []);
  const cur = value.trim();
  const note = useDirNote(value, worktree);
  return (
    <>
      <div className={styles.inline}>
        <input className={cx(styles.inp, styles.mono)} aria-label={t('Папка проекта')} aria-invalid={note?.tone === 'err' || undefined} placeholder={t('папка пространства или папка по умолчанию')} value={value} onChange={(e) => onChange(e.target.value)} />
        <PickDirButton className="btn small" prompt={t('Папка проекта для рутины')} start={() => value} onPick={onChange} />
      </div>
      {note && (
        <span className={cx(notes.dirNote, note.tone === 'err' ? notes.dirErr : note.tone === 'ok' ? notes.dirOk : notes.dirHint)} role={note.tone === 'err' ? 'alert' : 'status'}>
          {note.text}
        </span>
      )}
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
      {onWorktree && (
        <>
          <Seg<'new' | 'none'>
            label={t('Где работать')}
            value={worktree ?? 'none'}
            onChange={onWorktree}
            options={[
              { value: 'none', label: t('Прямо в папке'), title: t('flow работает в этой папке, как если бы ты открыл её сам') },
              { value: 'new', label: t('В отдельной ветке'), title: t('На каждое событие — своя рабочая копия (git worktree): твои файлы и текущая ветка не трогаются') },
            ]}
          />
          <span className={notes.wtHelp}>
            {worktree === 'new'
              ? t('На каждое событие agentgraph делает отдельную копию репозитория на новой ветке — твои файлы и текущая ветка не трогаются. Нужен репозиторий git: выбери его корневую папку (где лежит .git).')
              : t('flow правит файлы прямо в папке. Если он пишет код — «В отдельной ветке» безопаснее: параллельные запуски не мешают друг другу и тебе.')}
          </span>
        </>
      )}
    </>
  );
}
