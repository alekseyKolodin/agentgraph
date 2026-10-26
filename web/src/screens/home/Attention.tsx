// Главная: «MR · нужно внимание» (ui/attention.js) — свои открытые MR из проектов «Подключений», где упал CI, ждут ответа
// обсуждения или есть конфликты. Подсказка flow приходит отдельным запросом (/api/attention/suggest, haiku в фоне)
// и дорисовывается в готовые строки.
import { useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttentionItem } from '@server/api-types';
import { errorText, fetchAttention, fetchSuggestions, keys, useRuns } from '../../api';
import { useMemoryState } from '../../components/useMemoryState';
import { DASH_STALE_MS, dashCap, dashMore, mrSign, runsForBranch } from '../../lib/dash';
import { plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { LaunchButton, RelatedRuns, type OnLaunch } from './Dash';
import { useToFlow } from './FlowPicker';
import homeStyles from './Home.module.css';
import styles from './Dash.module.css';

export function Attention({ onLaunch }: { onLaunch: OnLaunch }) {
  const qc = useQueryClient();
  const runs = useRuns().data ?? [];
  const toFlow = useToFlow();
  // ↻ просит свежие данные: следующий запрос идёт с force=1
  const force = useRef(false);
  const [more, setMore] = useMemoryState('dash.att.more', false);
  const att = useQuery({
    queryKey: keys.attention,
    queryFn: () => {
      const f = force.current;
      force.current = false;
      return fetchAttention(f);
    },
    staleTime: DASH_STALE_MS,
  });
  const items = att.data?.items;
  const refs = (items ?? []).map((i) => i.ref);
  // подбор flow идёт в фоне после каждой новой выдачи (как loadSuggestions после loadAttention): список уже на экране,
  // подсказки появляются в своих строках; сбой — без подсказок. Сервер кэширует подбор по причинам MR
  const suggest = useQuery({
    queryKey: [...keys.suggest(refs), att.dataUpdatedAt],
    queryFn: () => fetchSuggestions(refs),
    enabled: refs.length > 0,
    staleTime: Infinity,
  });
  const suggestions = suggest.data?.suggestions ?? {};

  const reload = () => {
    force.current = true;
    setMore(false);
    // подсказки прошлой выдачи не нужны: новые запросятся по новой выдаче, а не параллельно с ней (сервер подбирает по последней)
    qc.removeQueries({ queryKey: keys.suggest([]) });
    void qc.resetQueries({ queryKey: keys.attention, exact: true });
  };

  const errs = (att.data?.errors ?? []).map((e) => (
    <p key={e.project} className="msg err small" title={e.project}>{`${e.name}: ${e.error}`}</p>
  ));
  let list;
  if (att.error) list = <p className="msg err">{errorText(att.error)}</p>;
  else if (!items) list = <p className="muted small">{t('Загружаю…')}</p>;
  else if (!items.length) list = errs.length ? null : <p className="muted small">{t('Твоим MR сейчас ничего не нужно: CI не падал, ответов никто не ждёт, конфликтов нет.')}</p>;
  else {
    list = (
      <>
        <ul className={styles.dashList}>
          {dashCap(items, more).map((m) => {
            const s = suggestions[m.ref];
            return (
              <li key={m.ref}>
                <div className={styles.dashRow}>
                  <a href={m.url} target="_blank" rel="noopener" className={styles.dashKey}>{mrSign(m.ref)}{m.iid}</a>
                  <span className={styles.dashName} title={m.title}>
                    {m.draft && <span className="muted">draft · </span>}
                    {m.title}
                  </span>
                  <span className={styles.dashMeta} title={`${m.project} · ${m.sourceBranch} → ${m.targetBranch}`}>{m.projectName}</span>
                  <Reasons m={m} />
                  {/* подходящего flow нет — ничего не подсказываем */}
                  <span className={styles.attSuggest}>
                    {s?.flow && (
                      <button
                        type="button"
                        className={`chip on ${styles.attFlow}`}
                        title={t('{why}: откроет «Запуск» с причинами во входе', { why: s.why || t('Подсказка haiku') })}
                        onClick={(e) => {
                          e.stopPropagation();
                          void toFlow(s.flow!, { type: 'mr', key: m.ref, project: m.project, attention: true });
                        }}
                      >
                        → {s.flow}
                      </button>
                    )}
                  </span>
                  <LaunchButton target={{ type: 'mr', key: m.ref, project: m.project, attention: true }} onLaunch={onLaunch} />
                </div>
                <RelatedRuns runs={runsForBranch(runs, m.project, m.sourceBranch, m.ref)} />
              </li>
            );
          })}
        </ul>
        {dashMore(items, more) > 0 && (
          <button type="button" className={`btn small ghost ${styles.dashMore}`} onClick={() => setMore(true)}>{t('Ещё {n}', { n: dashMore(items, more) })}</button>
        )}
      </>
    );
  }

  return (
    <section className={homeStyles.homeSec}>
      <div className={styles.dashHead}>
        <h2 title={t('Твои открытые MR из проектов «Подключений», где упал CI, ждут ответа обсуждения или есть конфликты. «Запустить…» и подсказка flow заполнят форму запуска, запустишь сам')}>
          {t('MR · нужно внимание')} <span className="muted small">{items?.length ? String(items.length) : ''}</span>
        </h2>
        <button className="btn small ghost" title={t('Обновить')} onClick={reload}>↻</button>
      </div>
      <div className={styles.dashBox}>
        {list}
        {errs}
      </div>
    </section>
  );
}

function Reasons({ m }: { m: AttentionItem }) {
  const r = m.reasons;
  return (
    <span className={styles.attReasons}>
      {r.ci && <a className="badge failed" href={r.ci.url || m.url} target="_blank" rel="noopener" title={t('Последний пайплайн ветки упал')}>{t('CI упал')}</a>}
      {r.replies > 0 && (
        <a className="badge waiting" href={m.url} target="_blank" rel="noopener" title={t('Неразрешённые обсуждения, где последнее слово не твоё')}>
          {t('{n} {verb} ответа', { n: r.replies, verb: plural(r.replies, 'ждёт', 'ждут', 'ждут') })}
        </a>
      )}
      {r.conflicts && <a className="badge failed" href={m.url} target="_blank" rel="noopener" title={t('Конфликты с {branch}', { branch: m.targetBranch })}>{t('конфликты')}</a>}
    </span>
  );
}
