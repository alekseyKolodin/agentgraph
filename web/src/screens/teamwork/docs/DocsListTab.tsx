// Прочие документы проекта из docs/ (spec §5.1, §8.4): список файлов слева, выбранный — справа тем же видом для чтения и
// правки по разделам, что ТЗ, без блоков требований (?doc=docs/<файл>; ссылки на docs/… из текста ведут сюда). «+ Документ»
// заводит новый markdown-файл одним коммитом.
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDocName } from '@server/api-types';
import { errorText } from '../../../api';
import { saveDoc, teamKeys, useProject, useTasks, useTeam } from '../../../api/teamwork';
import { t } from '../../../lib/i18n';
import { Loading } from '../../sessions/Loading';
import { cx } from '../parts';
import tw from '../Teamwork.module.css';
import { DocBody } from './DocTab';
import styles from './Docs.module.css';

export type DocsListTabProps = { team: string; project: string };

/** Параметр адреса: открытый документ из docs/. */
export const DOC_PARAM = 'doc';
/** Имя нового файла: латиница, цифры, точка, дефис и подчёркивание; .md допишется сам. */
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

export function DocsListTab({ team, project }: DocsListTabProps) {
  const qc = useQueryClient();
  const teamQ = useTeam(team);
  const projQ = useProject(team, project);
  const tasksQ = useTasks(team, project);
  const [search, setSearch] = useSearchParams();
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!teamQ.data || !projQ.data) return <Loading className={tw.loading} />;
  const docs = projQ.data.docs.filter((d) => d.name.startsWith('docs/'));
  const asked = search.get(DOC_PARAM);
  const open = (asked && asked.startsWith('docs/') ? asked : docs[0]?.name) as TeamDocName | undefined;
  const link = (name: string) => {
    const q = new URLSearchParams(search);
    q.set(DOC_PARAM, name);
    q.delete('draft');
    return `?${q.toString()}`;
  };
  const readonly = teamQ.data.sync.state === 'readonly';

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const base = file.trim().replace(/\.md$/i, '');
    if (!FILE_RE.test(base)) {
      setErr(t('Имя файла — латиница, цифры, точка, дефис или подчёркивание'));
      return;
    }
    const name = `docs/${base}.md` as TeamDocName;
    if (docs.some((d) => d.name === name)) {
      setSearch(new URLSearchParams(link(name)));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await saveDoc(team, project, name, { text: `# ${base}\n` });
      qc.setQueryData(teamKeys.doc(team, project, name), r);
      await qc.invalidateQueries({ queryKey: teamKeys.project(team, project), exact: true });
      setFile('');
      setSearch(new URLSearchParams(link(name)));
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <nav className={styles.files} aria-label={t('Документы в docs/')}>
        <span className={styles.cap}>docs/</span>
        {docs.map((d) => (
          <Link key={d.name} to={link(d.name)} className={cx(d.name === open && styles.on)} aria-current={d.name === open ? 'page' : undefined} title={d.title}>
            <span>{d.name.replace(/^docs\//, '')}</span>
          </Link>
        ))}
        {!docs.length && <span className={styles.hint} style={{ padding: '0 8px' }}>{t('в docs/ пока пусто')}</span>}
        {!readonly && (
          <form className={styles.newDoc} onSubmit={(e) => void create(e)}>
            <input value={file} placeholder={t('новый-файл.md')} aria-label={t('Имя нового документа')} onChange={(e) => setFile(e.target.value)} />
            <button type="submit" className="btn small" disabled={busy || !file.trim()}>{t('+ Документ')}</button>
          </form>
        )}
        {err && <p className="msg err">{err}</p>}
      </nav>
      <div className={styles.docsMain}>
        {open ? (
          <DocBody key={open} team={teamQ.data} project={projQ.data} name={open} tasks={tasksQ.data ?? []} />
        ) : (
          <div className={styles.empty}>
            <h2>{t('Документов в docs/ пока нет')}</h2>
            <p>{t('Здесь живут прочие документы проекта: заметки встреч, шаблоны, разборы. Заведите первый слева — он уйдёт коммитом в репо команды.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
