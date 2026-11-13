// «не сохранено: раздел «Требования»» в шапке проекта рядом со строкой синхронизации (spec §8.4, unsavedLine из
// lib/teamwork/sync.ts): несохранённая правка раздела живёт в edits.ts и видна с любой вкладки проекта; клик ведёт к ней.
import { Link } from 'react-router';
import { t } from '../../../lib/i18n';
import { sectionName } from '../../../lib/teamwork/doc-view';
import { docLabel, serializeRequirementRows } from '../../../lib/teamwork/docs';
import { unsavedLine } from '../../../lib/teamwork/sync';
import { cx } from '../parts';
import { projectPath } from '../shell';
import tw from '../Teamwork.module.css';
import { isDirty, useProjectEdits } from './edits';
import { DOC_PARAM } from './DocsListTab';

export function UnsavedLine({ team, project }: { team: string; project: string }) {
  const dirty = useProjectEdits(team, project).filter((x) => isDirty(x.edit, serializeRequirementRows));
  const several = new Set(dirty.map((x) => x.doc)).size > 1;
  const line = unsavedLine(dirty.map((x) => (several ? `${docLabel(x.doc)}: ${sectionName(x.edit.heading)}` : sectionName(x.edit.heading))));
  if (!line || !dirty[0]) return null;
  const first = dirty[0].doc;
  const to = first.startsWith('docs/') ? `${projectPath(team, project, 'docs')}?${DOC_PARAM}=${encodeURIComponent(first)}` : projectPath(team, project, first as 'prd');
  return (
    <span className={cx(tw.sync, tw.wait)} role="status">
      <Link to={to} className={tw.syncText} title={t('Открыть несохранённый раздел')}>
        <span className={cx(tw.dot, tw.s6, tw.wait)} aria-hidden="true" />
        {line.text}
      </Link>
    </span>
  );
}
