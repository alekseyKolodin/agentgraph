// Вкладка документа проекта — ТЗ, архитектура или дизайн (spec §8.4, §9.2–9.3, §11; макеты PrdRead, PrdEdit, Prd): чтение с
// оглавлением, требованиями и задачами на полях, правка по разделам на месте, «История», «Исходник», черновики агентов —
// строка «Черновик идёт · Открыть запуск», по готовности рецензия правок прямо в документе (?draft=<запуск>).
// Пустой документ зовёт «Черновик с агентом». DocBody — то же для любого документа проекта, в том числе из docs/.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamDetail, TeamDocName, TeamDraft, TeamDraftDetail, TeamDraftStart, TeamProject, TeamTask } from '@server/api-types';
import { ApiError, errorText } from '../../../api';
import { fetchDoc, saveDoc, teamKeys, useDoc, useProject, useTasks, useTeam } from '../../../api/teamwork';
import { useConfirm } from '../../../components/ConfirmDialog';
import { useToast } from '../../../components/Toast';
import { t } from '../../../lib/i18n';
import { draftFailed, draftLine, draftRunning, isDocEmpty, latestDraftFor } from '../../../lib/teamwork/doc-view';
import { docFile, docLabel, serializeRequirementRows } from '../../../lib/teamwork/docs';
import { Loading } from '../../sessions/Loading';
import { cx, ErrorLine } from '../parts';
import tw from '../Teamwork.module.css';
import { AgentAsk, type DraftDoc } from './AgentAsk';
import { useFlowTrust } from '../FlowTrust';
import { draftKeys, startDraft, useDrafts } from './api';
import { HistoryDialog, SourceDialog } from './DocDialogs';
import { DocView } from './DocView';
import { DraftReview, readMemory, writeMemory } from './DraftReview';
import { anyEdits, guardUnload, isDirty, useEdit } from './edits';
import styles from './Docs.module.css';

export type DocTabProps = { team: string; project: string; doc: TeamDocName };

/** Параметр адреса: рецензия черновика по номеру запуска. */
export const DRAFT_PARAM = 'draft';

export function DocTab({ team, project, doc }: DocTabProps) {
  const teamQ = useTeam(team);
  const projQ = useProject(team, project);
  const tasksQ = useTasks(team, project);
  if (!teamQ.data || !projQ.data) return <Loading className={tw.loading} />;
  // ключ — документ: правки и редактор одного документа не переезжают в другой при смене вкладки
  return <DocBody key={doc} team={teamQ.data} project={projQ.data} name={doc} tasks={tasksQ.data ?? []} />;
}

const DRAFT_DOCS: readonly TeamDocName[] = ['prd', 'architecture', 'design'];

/** Подсказка пустого документа: что агент напишет и по чему. */
const emptyText = (name: TeamDocName): { title: string; text: string } =>
  name === 'prd'
    ? { title: t('ТЗ пока пустое'), text: t('Агент напишет черновик по коду и описанию проекта и задаст вопросы, где не уверен. Вы примете его по правкам — в репо без кнопки ничего не попадёт.') }
    : { title: t('{doc}: пока пусто', { doc: docLabel(name) }), text: t('Агент напишет документ по ТЗ и коду проекта. Вы примете его по правкам — в репо без кнопки ничего не попадёт.') };

export function DocBody({ team, project, name, tasks }: { team: TeamDetail; project: TeamProject; name: TeamDocName; tasks: readonly TeamTask[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const docQ = useDoc(team.slug, project.slug, name);
  const draftable = DRAFT_DOCS.includes(name);
  const draftsQ = useDrafts(team.slug, project.slug, draftable);
  const [search, setSearch] = useSearchParams();
  const review = draftable ? search.get(DRAFT_PARAM) : null;
  const [dialog, setDialog] = useState<'history' | 'source' | null>(null);
  const [writeSelf, setWriteSelf] = useState(false);
  const [creating, setCreating] = useState(false);
  const readonly = team.sync.state === 'readonly';
  const openEdit = useEdit(team.slug, project.slug, name);
  const trust = useFlowTrust();

  useEffect(() => guardUnload(() => anyEdits().some((e) => isDirty(e, serializeRequirementRows))), []);

  const setReview = (run: string | null) => {
    const next = new URLSearchParams(search);
    if (run) next.set(DRAFT_PARAM, run);
    else next.delete(DRAFT_PARAM);
    setSearch(next, { replace: !run });
  };
  const latest = draftable ? latestDraftFor(draftsQ.data ?? [], name) : undefined;
  const busyDraft = latest && draftRunning(latest.status) ? latest : undefined;
  const agentReason = readonly ? t('Только чтение: формат репо команды новее') : busyDraft ? t('Черновик этого документа уже идёт') : undefined;

  const retry = async (d: Pick<TeamDraft, 'kind' | 'brief' | 'section' | 'docs'>) => {
    const body: TeamDraftStart = { kind: d.kind };
    if (d.brief) body.brief = d.brief;
    if (d.section !== undefined) body.section = d.section;
    if (d.kind === 'architecture') body.what = (d.docs?.length ?? 0) > 1 ? 'both' : ((d.docs?.[0] ?? name) as 'architecture' | 'design');
    try {
      // flow команды изменили и здесь не одобряли — диалог доверия; «Отмена» — без запуска
      if (!(await trust.guard(() => startDraft(team.slug, project.slug, body)))) return;
      setReview(null);
      await qc.invalidateQueries({ queryKey: draftKeys.list(team.slug, project.slug) });
    } catch (e) {
      toast(errorText(e));
    }
  };

  if (docQ.isPending) return <Loading className={tw.loading} />;
  if (docQ.isError) {
    const gone = docQ.error instanceof ApiError && docQ.error.status === 404;
    if (!gone) return <ErrorLine text={t('Документ не читается: {error}', { error: errorText(docQ.error) })} />;
    const create = async () => {
      setCreating(true);
      try {
        // файл мог появиться у коллеги после нашего 404: тогда просто перечитываем, а не пишем поверх
        const exists = await fetchDoc(team.slug, project.slug, name).catch(() => undefined);
        if (exists) {
          qc.setQueryData(teamKeys.doc(team.slug, project.slug, name), exists);
          return;
        }
        const r = await saveDoc(team.slug, project.slug, name, { text: `# ${docLabel(name)}\n` });
        qc.setQueryData(teamKeys.doc(team.slug, project.slug, name), r);
        void qc.invalidateQueries({ queryKey: teamKeys.project(team.slug, project.slug), exact: true });
      } catch (e) {
        toast(errorText(e));
      } finally {
        setCreating(false);
      }
    };
    return (
      <div className={styles.empty}>
        <h2>{t('Файла {file} нет в репо команды', { file: docFile(name) })}</h2>
        <p>{draftable ? emptyText(name).text : t('Его удалили или переименовали. Выберите другой документ.')}</p>
        {!readonly && (
          <div className={styles.go}>
            {draftable && <AgentAsk team={team.slug} project={project.slug} doc={name as DraftDoc} buttonClass="btn primary" disabledReason={agentReason} left>{t('Черновик с агентом…')}</AgentAsk>}
            <button type="button" className="btn" disabled={creating} onClick={() => void create()}>{t('Создать пустой')}</button>
          </div>
        )}
      </div>
    );
  }
  const doc = docQ.data;

  if (review) {
    return (
      <>
        <p className={styles.hint} style={{ margin: '0 0 10px' }}><button type="button" className={styles.linkBtn} onClick={() => setReview(null)}>{t('← К документу')}</button></p>
        <DraftReview key={`${review}|${name}`} team={team} project={project} name={name} run={review} onClose={() => setReview(null)} onRetry={(d: TeamDraftDetail) => void retry(d)} />
        {trust.dialog}
      </>
    );
  }

  // кнопки шапки — одной группой: при переносе уезжают вместе, а не «Исходник» один на вторую строку
  const actions = (
    <span className={styles.dacts}>
      <button type="button" className="btn ghost small" onClick={() => setDialog('history')} title={t('Последние 10 коммитов по файлу')}>{t('История')}</button>
      <button type="button" className="btn ghost small" onClick={() => setDialog('source')} title={t('Markdown документа целиком')}>{t('Исходник')}</button>
      {draftable && !readonly && <AgentAsk team={team.slug} project={project.slug} doc={name as DraftDoc} disabledReason={agentReason}>{t('Черновик с агентом…')}</AgentAsk>}
    </span>
  );
  // открытая правка раздела важнее призыва пустого документа: после ухода с вкладки и возврата она на месте
  const empty = isDocEmpty(doc.text) && !writeSelf && !openEdit;
  return (
    <>
      {latest && <DraftLine draft={latest} name={name} onReview={() => setReview(latest.run)} onRetry={() => void retry(latest)} />}
      {empty && draftable ? (
        <div className={styles.empty}>
          <h2>{emptyText(name).title}</h2>
          <p>{emptyText(name).text}</p>
          <div className={styles.go}>
            {!readonly && <AgentAsk team={team.slug} project={project.slug} doc={name as DraftDoc} buttonClass="btn primary" disabledReason={agentReason} left>{t('Черновик с агентом…')}</AgentAsk>}
            {!readonly && <button type="button" className="btn ghost" onClick={() => setWriteSelf(true)}>{t('Писать самому')}</button>}
            <span className={styles.meta}>{docFile(name)}</span>
          </div>
        </div>
      ) : (
        <DocView team={team} project={project} name={name} doc={doc} tasks={tasks} readonly={readonly} agent={draftable} actions={actions} />
      )}
      {dialog === 'history' && <HistoryDialog team={team.slug} project={project.slug} name={name} members={team.memberList} onClose={() => setDialog(null)} />}
      {dialog === 'source' && <SourceDialog doc={doc} onClose={() => setDialog(null)} />}
      {trust.dialog}
    </>
  );
}

/** Строка черновика: идёт — «Открыть запуск» (вопросы агента там); готов — «Посмотреть»; не получился — «Повторить». */
function DraftLine({ draft, name, onReview, onRetry }: { draft: TeamDraft; name: TeamDocName; onReview: () => void; onRetry: () => void }) {
  const { askConfirm } = useConfirm();
  const [mem, setMem] = useState(() => readMemory(draft.run, name));
  useEffect(() => setMem(readMemory(draft.run, name)), [draft.run, name]);
  if (mem.x) return null;
  const line = draftLine(draft);
  const running = draftRunning(draft.status);
  const failed = draftFailed(draft.status);
  const hide = async (ask: boolean) => {
    if (ask && !(await askConfirm(t('Отклонить черновик? В документ ничего не попадёт; запуск останется в списке запусков.'), { ok: t('Отклонить черновик'), danger: true }))) return;
    const m = { ...mem, x: true };
    writeMemory(draft.run, name, m);
    setMem(m);
  };
  const tone = line.tone === 'live' ? '' : line.tone === 'wait' ? tw.wait : line.tone === 'ok' ? tw.ok : tw.fail;
  return (
    <div className={styles.dline} role="status">
      <span className={cx(tw.dot, tone)} aria-hidden="true" />
      <span className={cx(styles.t, line.tone === 'wait' && styles.tWait)}>{line.text}</span>
      {draft.brief && <span className={styles.brief} title={draft.brief}>{draft.brief}</span>}
      <span className={styles.meta}>{draft.flow}</span>
      <span className={styles.grow} />
      <Link className="btn small ghost" to={`/run/${encodeURIComponent(draft.run)}`}>{draft.status === 'waiting' ? t('Ответить в запуске') : t('Открыть запуск')}</Link>
      {!running && !failed && <button type="button" className="btn small" onClick={onReview}>{t('Посмотреть')}</button>}
      {failed && <button type="button" className="btn small ghost" onClick={onReview}>{t('Что успел агент')}</button>}
      {failed && <button type="button" className="btn small" onClick={onRetry}>{t('Повторить')}</button>}
      {!running && <button type="button" className="btn small ghost" onClick={() => void hide(!failed)} title={failed ? t('Скрыть строку') : t('Отклонить черновик')}>{failed ? t('Скрыть') : t('Отклонить')}</button>}
    </div>
  );
}
