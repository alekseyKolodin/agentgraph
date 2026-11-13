// Имя сессии терминала с переименованием на месте: «Сейчас» в сайдбаре, таблица «Сессии», шапка сессии. Ответ сервера
// сразу уходит в кэш (useRenameSession) — новое имя видно везде, не дожидаясь опроса.
import type { SessionView } from '@server/api-types';
import { SESSION_NAME_MAX, useRenameSession } from '../../api/sessions';
import { InlineRename, type InlineRenameProps } from '../../components/InlineRename';
import { t } from '../../lib/i18n';

export { RENAME_HOST } from '../../components/InlineRename';

type Props = Pick<InlineRenameProps, 'to' | 'onOpen' | 'as' | 'pencil' | 'className' | 'textClassName' | 'title'> & { s: Pick<SessionView, 'id' | 'name'> };

export function SessionName({ s, ...view }: Props) {
  const rename = useRenameSession();
  return (
    <InlineRename
      {...view}
      value={s.name}
      onSave={(name) => rename(s.id, name)}
      max={SESSION_NAME_MAX}
      label={t('Название сессии')}
      pencilLabel={t('Переименовать сессию «{name}»', { name: s.name })}
    />
  );
}
