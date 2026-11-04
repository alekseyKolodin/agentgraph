// «Предложить пространства»: модель (haiku без инструментов) раскладывает сессии и запуски без пространства по работе.
// Ничего не заводится: каждое предложение открывается черновиком нового пространства (DraftPanel) с его работами в
// «Из истории» — карту по ним модель пишет по отдельному клику, создаёт пространство человек.
import { useEffect, useState } from 'react';
import type { SpaceDraftModel, SpaceGroup, SpaceGroupsEstimate, SpaceWorkItem } from '@server/api-types';
import { errorText, estimateGroups } from '../../api';
import { useConfig } from '../../api';
import { feedTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import { LS } from '../../lib/storage';
import { DRAFT_MODELS, elapsed, estimateLine, GROUPS_MODEL_KEY, modelLabel, usd, type DraftSourceItem } from '../../lib/space-draft';
import { GROUPS, groups, runGroups } from './draftStore';
import { draftSetupOf, openDraft } from './DraftPanel';
import styles from './Draft.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

/** Работа предложения — источником черновика: сессии и запуски группы, все отмечены. */
const itemOf = (x: SpaceWorkItem): DraftSourceItem => ({ kind: x.kind, id: x.id, name: x.name, sub: `${x.kind === 'session' ? t('сессия') : t('запуск')} · ${feedTime(x.at)}`, at: x.at });

export function GroupsPanel({ onClose, onOpenDraft }: { onClose: () => void; onOpenDraft: () => void }) {
  const g = groups.use(GROUPS);
  const home = useConfig().data?.home;
  const [est, setEst] = useState<SpaceGroupsEstimate | null>(null);
  const [estErr, setEstErr] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!groups.get(GROUPS)) groups.set(GROUPS, { phase: 'setup', model: LS.get<SpaceDraftModel>(GROUPS_MODEL_KEY, 'haiku'), log: [] });
  }, []);
  const model = g?.model;
  const phase = g?.phase;
  useEffect(() => {
    if (!model || (phase !== 'setup' && phase !== 'error')) return;
    let live = true;
    estimateGroups(model).then((r) => live && (setEst(r), setEstErr('')), (err) => live && setEstErr(errorText(err)));
    return () => {
      live = false;
    };
  }, [model, phase]);
  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);
  if (!g) return null;
  const byId = new Map((g.reply?.items ?? []).map((x) => [x.id, x]));
  const open = (grp: SpaceGroup) => {
    const items = [...grp.sessions, ...grp.runs].flatMap((id) => (byId.get(id) ? [itemOf(byId.get(id)!)] : []));
    openDraft('new', draftSetupOf(undefined, { mode: 'history', items, sources: items.map((x) => x.id), slug: grp.slug, title: grp.title, about: grp.gist, cwd: grp.cwd ?? '', bind: grp.sessions, fromGroups: true }), true);
    onOpenDraft();
  };
  return (
    <section className={styles.panel} aria-label={t('Предложить пространства')}>
      <div className={styles.head}>
        <h3>{t('Предложить пространства')}</h3>
        {g.phase !== 'running' && <button type="button" className={cx('btn small ghost', styles.push)} onClick={onClose}>{t('Закрыть')}</button>}
      </div>
      {(g.phase === 'setup' || g.phase === 'error') && (
        <div className={cx('form', styles.setup)}>
          <p className="muted small">{t('Модель без инструментов посмотрит на сессии и запуски без пространства (имя, папку, первое сообщение или задачу) и разложит их по работе. Ничего не создаётся: каждое предложение откроется черновиком, пространство заведёшь ты.')}</p>
          <div className={styles.runRow}>
            <label className={styles.model}>
              <span>{t('Модель')}</span>
              <select
                value={g.model}
                onChange={(ev) => {
                  const m = ev.target.value as SpaceDraftModel;
                  LS.set(GROUPS_MODEL_KEY, m);
                  groups.patch(GROUPS, { model: m });
                }}
              >
                {DRAFT_MODELS.map((m) => <option key={m} value={m}>{modelLabel(m)}</option>)}
              </select>
            </label>
            <button type="button" className="btn primary" disabled={!est || est.items < 2} onClick={() => void runGroups()}>{t('Предложить')}</button>
            <span className={cx('small', estErr ? 'err' : 'muted')}>
              {estErr || (est ? (est.items < 2 ? t('Работы без пространства почти нет: группировать нечего') : t('Работ: {n}{more} · оценка {line}', { n: est.items, more: est.skipped ? t(' (свежие, ещё {n} не войдут)', { n: est.skipped }) : '', line: estimateLine(est) })) : t('Считаю оценку…'))}
            </span>
          </div>
          {g.failure && <p className="msg err">{t('Не получилось: {error}. Потрачено: {cost}', { error: g.failure.error, cost: usd(g.failure.costUsd) })}</p>}
        </div>
      )}
      {g.phase === 'running' && (
        <div className={styles.running}>
          <div className={styles.wait}>
            <span className={styles.dot} />
            {t('Модель раскладывает работу… {time}', { time: elapsed(now - (g.startedAt ?? now)) })}
            {g.modelName && <span className="muted small mono">{g.modelName}</span>}
            <button type="button" className={cx('btn small ghost', styles.push)} onClick={() => g.abort?.abort()}>{t('Отменить')}</button>
          </div>
        </div>
      )}
      {g.phase === 'done' && g.reply && (
        <div className={styles.result}>
          <div className={styles.meta}>
            <span className="small">{t('Предложено: {n}', { n: g.reply.groups.length })} · <span className="mono">{g.reply.model ?? g.model}</span> · {usd(g.reply.costUsd)}</span>
            <button type="button" className="btn small ghost" onClick={() => groups.patch(GROUPS, { phase: 'setup', reply: undefined })}>{t('Предложить заново')}</button>
          </div>
          {g.reply.warnings.map((w) => <p key={w} className="warn small">{w}</p>)}
          {g.reply.groups.length ? (
            <ul className={styles.groups}>
              {g.reply.groups.map((grp, i) => (
                <li key={i} className={styles.group}>
                  <div className={styles.partHead}>
                    <strong>{grp.title || grp.slug || t('Без названия')}</strong>
                    {grp.slug && <span className="mono muted small">{grp.slug}</span>}
                    <button type="button" className={cx('btn small', styles.push)} title={t('Черновик нового пространства по этим сессиям и запускам: ты посмотришь и создашь его сам')} onClick={() => open(grp)}>{t('Открыть черновик')}</button>
                  </div>
                  {grp.gist && <p className="small">{grp.gist}</p>}
                  {grp.cwd && <p className="muted small mono">{tildePath(grp.cwd, home)}</p>}
                  <ul className={styles.groupItems}>
                    {[...grp.sessions, ...grp.runs].map((id) => byId.get(id)).filter((x): x is SpaceWorkItem => Boolean(x)).map((x) => (
                      <li key={x.id} className="small">{x.kind === 'session' ? '›_' : '▸'} {x.name} <span className="muted">· {feedTime(x.at)}</span></li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">{t('Модель не нашла общей работы: пространства лучше завести руками.')}</p>}
          {g.reply.rest.sessions.length + g.reply.rest.runs.length > 0 && (
            <p className="muted small">{t('Без группы: {n}', { n: g.reply.rest.sessions.length + g.reply.rest.runs.length })}</p>
          )}
        </div>
      )}
    </section>
  );
}
