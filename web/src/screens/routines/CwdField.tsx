// «Папка проекта» рутины на общих полях (components/form): путь моноширинным, «Выбрать…» (системный диалог, фича
// pick-dir) и чипы недавних папок под полем — как в форме запуска flow. Пусто — папка пространства или папка по умолчанию.
// Под полем одна строка — что сервер увидел в папке: нет такой, не репозиторий git, репозиторий и ветка. Внутри Field
// поле берёт его подпись. С worktree/onWorktree — ещё и «Где работать»: прямо в папке или в отдельной ветке (git
// worktree), и ошибка словами, если выбрана ветка, а папка не репозиторий. С одним worktree (без onWorktree) выбор не
// показывается, но проверка папки его учитывает.
import { useEffect, useState } from 'react';
import { useFeature, useRecentDirs } from '../../api';
import { useDirCheck } from '../../api/routines';
import { Input, Seg } from '../../components/form';
import { PickDirButton } from '../../components/PickDirButton';
import { t } from '../../lib/i18n';
import { dirNote, type DirNote } from '../../lib/routines/dir';
import { recentChips } from '../../lib/run-form';
import s from './CwdField.module.css';

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
  /** Где работать: учитывается в проверке папки; с onWorktree — ещё и выбор «прямо в папке / в отдельной ветке». */
  worktree?: 'new' | 'none';
  onWorktree?: (w: 'new' | 'none') => void;
};

export function CwdField({ value, onChange, worktree, onWorktree }: Props) {
  const recent = recentChips(useRecentDirs(useFeature('recent-dirs')).data ?? []);
  const cur = value.trim();
  const note = useDirNote(value, worktree);
  return (
    <>
      <div className={s.dirRow}>
        <Input mono aria-label={t('Папка проекта')} tone={note?.tone === 'err' ? 'err' : undefined} placeholder={t('папка пространства или папка по умолчанию')} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
        <PickDirButton className="btn" prompt={t('Папка проекта для рутины')} start={() => value} onPick={onChange} />
      </div>
      {note && (
        <span className={note.tone === 'err' ? s.err : note.tone === 'ok' ? s.ok : s.meta} role={note.tone === 'err' ? 'alert' : 'status'}>
          {note.text}
        </span>
      )}
      {recent.length > 0 && (
        <div className={s.recent} role="group" aria-label={t('Недавние:')}>
          <span className={s.meta}>{t('Недавние:')}</span>
          {recent.map((d) => (
            <button key={d.path} type="button" className={s.recentChip} aria-pressed={d.path === cur} title={d.path} onClick={() => onChange(d.path)}>
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
          <span className={s.meta}>
            {worktree === 'new'
              ? t('На каждое событие agentgraph делает отдельную копию репозитория на новой ветке — твои файлы и текущая ветка не трогаются. Нужен репозиторий git: выбери его корневую папку (где лежит .git).')
              : t('flow правит файлы прямо в папке. Если он пишет код — «В отдельной ветке» безопаснее: параллельные запуски не мешают друг другу и тебе.')}
          </span>
        </>
      )}
    </>
  );
}
