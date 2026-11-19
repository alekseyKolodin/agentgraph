// Что сказать про папку проекта рутины, пока человек её выбирает: нет папки, файл, не git, а нужна отдельная ветка.
// Ответ сервера (check-dir) → фраза словами и можно ли с этим сохранять. Без React.
import type { DirCheck } from '@server/routines/types';
import { t } from '../i18n';

/** ok — всё хорошо, hint — просто знать, err — так рутина не запустится. */
export type DirNote = { tone: 'ok' | 'hint' | 'err'; text: string };

/** worktree — выбрано ли «В отдельной ветке»; undefined (редактор без этого выбора) считается «прямо в папке». */
export function dirNote(c: DirCheck | undefined, worktree: 'new' | 'none' | undefined): DirNote | undefined {
  if (!c) return undefined;
  if (!c.exists) return { tone: 'err', text: t('Такой папки нет. Проверь путь или выбери папку кнопкой «Выбрать…».') };
  if (!c.isDir) return { tone: 'err', text: t('Это файл, а не папка. Нужна папка проекта.') };
  if (c.git) {
    const where = c.branch ? t('Репозиторий git, ветка {branch}.', { branch: c.branch }) : t('Репозиторий git.');
    const up = c.root && c.root !== c.path ? ` ${t('Корень репозитория: {root}.', { root: c.root })}` : '';
    return { tone: 'ok', text: where + up };
  }
  if (worktree === 'new') {
    return { tone: 'err', text: t('Это не репозиторий git (нет папки .git), отдельную ветку сделать не из чего. Выбери корневую папку проекта — ту, где лежит .git, — или поставь «Прямо в папке».') };
  }
  return { tone: 'hint', text: t('Это не репозиторий git: рутина будет работать прямо в этой папке. Отдельная ветка для каждого запуска здесь недоступна.') };
}

/** Так сохранять нельзя: запуск упрётся в эту папку. */
export const dirBlocks = (n: DirNote | undefined): boolean => n?.tone === 'err';
