// «История» — последние 10 коммитов по файлу документа с автором и временем, любой открывается построчным диффом (версия
// до коммита и после него, GET …/history/:hash); «Исходник» — markdown документа целиком, только для чтения (spec §8.4).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TeamDoc, TeamDocName, TeamMember } from '@server/api-types';
import { errorText } from '../../../api';
import { useHistory } from '../../../api/teamwork';
import { clock } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { memberByEmail, memberLabel } from '../../../lib/teamwork/board';
import { docFile } from '../../../lib/teamwork/docs';
import { Loading } from '../../sessions/Loading';
import { cx } from '../parts';
import { useRevision } from './api';
import { Diff } from './DraftReview';
import styles from './Docs.module.css';

/** Модальное окно с заголовком и «Закрыть»; Esc закрывает. */
function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dlg.current?.showModal();
  }, []);
  return (
    <dialog ref={dlg} className={styles.dlg} aria-label={title} onCancel={(e) => { e.preventDefault(); onClose(); }} onClose={onClose}>
      <div className={styles.dlgBody}>
        <h2>{title}</h2>
        {children}
        <div className={styles.foot}>
          <button type="button" className="btn" autoFocus onClick={onClose}>{t('Закрыть')}</button>
        </div>
      </div>
    </dialog>
  );
}

export function HistoryDialog({ team, project, name, members, onClose }: { team: string; project: string; name: TeamDocName; members: readonly TeamMember[]; onClose: () => void }) {
  const q = useHistory(team, project, { doc: name, limit: 10 });
  const [hash, setHash] = useState<string | undefined>();
  const items = q.data ?? [];
  const sel = hash ?? items[0]?.hash;
  const rev = useRevision(team, project, name, sel);
  return (
    <Dialog title={t('История {file}', { file: docFile(name) })} onClose={onClose}>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <p className="msg err">{errorText(q.error)}</p>
      ) : !items.length ? (
        <p className={styles.hint}>{t('Коммитов по файлу пока нет.')}</p>
      ) : (
        <div className={styles.histGrid}>
          <ul className={styles.hist} aria-label={t('Коммиты')}>
            {items.map((h) => {
              const m = memberByEmail(members, h.email);
              return (
                <li key={h.hash}>
                  <button type="button" className={cx(h.hash === sel && styles.on)} aria-pressed={h.hash === sel} onClick={() => setHash(h.hash)}>
                    <span className={styles.m}>{h.message}</span>
                    <span className={styles.meta}>{m ? memberLabel(m) : h.author} · {clock(h.at)} · {h.hash.slice(0, 7)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div style={{ minWidth: 0 }}>
            {rev.isPending ? <Loading /> : rev.isError ? <p className="msg err">{errorText(rev.error)}</p> : rev.data ? <Diff a={rev.data.before} b={rev.data.after} /> : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function SourceDialog({ doc, onClose }: { doc: TeamDoc; onClose: () => void }) {
  return (
    <Dialog title={t('Исходник {file}', { file: docFile(doc.name) })} onClose={onClose}>
      <pre className={styles.src} tabIndex={0} aria-label={t('Markdown документа')}>{doc.text}</pre>
    </Dialog>
  );
}
