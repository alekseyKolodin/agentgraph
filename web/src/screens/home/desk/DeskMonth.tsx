// Месяц на доске (docs/desk/SPEC.md, этап 6), над доской в DeskTop.tsx: «Висит дольше N дней» с обзором недели (6.1,
// GET /api/desk/week) и «Записать знание» после закрытого дела, по которому шла работа (6.6, POST /api/tags/:slug/notes —
// строка уходит в заметки тега по виду работы только по клику). Логика — lib/desk-month.ts.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DeskColumn, DeskItem, DeskWeekReply } from '@server/desk/types';
import { errorText, keys, useFeature, useTags } from '../../../api';
import { useDesk, useDeskWeek } from '../../../api/desk';
import { useRoutines } from '../../../api/routines';
import { appendTagNote } from '../../../api/tags';
import { useToast } from '../../../components/Toast';
import { learnCandidates, noteContext, staleText, tagForKind, weekLine } from '../../../lib/desk-month';
import { t } from '../../../lib/i18n';
import { LS } from '../../../lib/storage';
import styles from './DeskMonth.module.css';

const STALE_KEY = 'agentgraph.desk.staleDays';
const LEARNED_KEY = 'agentgraph.desk.learned';
const STALE_CHOICES = [3, 7, 14, 30];
const LEARNED_KEEP = 200;
const COLUMN: Partial<Record<DeskColumn, string>> = { plan: 'В плане', waiting: 'Ждёт других', work: 'В работе' };

const ALL = {};

/** Записанные и отклонённые карточки; не список (испорчен руками) — пусто, а не падение доски. */
const readLearned = (): string[] => {
  const v = LS.get<unknown>(LEARNED_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

const readStale = (): number => {
  const v = LS.get<number>(STALE_KEY, 7);
  return STALE_CHOICES.includes(v) ? v : 7;
};

/** Чип над доской: «Висит дольше N дней: K» (или «Неделя») и раскрытие с обзором недели. */
export function WeekChip({ open, onToggle, staleDays }: { open: boolean; onToggle: () => void; staleDays: number }) {
  const week = useDeskWeek(staleDays);
  if (!week.data) return null;
  const stale = staleText(week.data);
  return (
    <button
      type="button"
      className={stale ? `${styles.chip} ${styles.warn}` : styles.chip}
      aria-expanded={open}
      title={open ? t('Свернуть обзор недели') : t('Что закрыто, что зависло и от каких рутин пришли дела за 7 дней')}
      onClick={onToggle}
    >
      {stale ?? t('Неделя')}
      <span className={styles.caret} aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
  );
}

/** Держатель N («висит дольше N дней»): настройка в браузере, общая для чипа и обзора. */
export function useStaleDays(): [number, (n: number) => void] {
  const [n, setN] = useState(readStale);
  return [n, (v) => {
    LS.set(STALE_KEY, v);
    setN(v);
  }];
}

/** Обзор недели: закрыто, зависло, пришло по рутинам; N меняется здесь же. */
export function WeekPanel({ staleDays, onStaleDays }: { staleDays: number; onStaleDays: (n: number) => void }) {
  const week = useDeskWeek(staleDays);
  const routines = useRoutines(useFeature('routines'));
  const w: DeskWeekReply | undefined = week.data;
  if (!w) return null;
  const routineTitle = (slug: string) => routines.data?.routines.find((r) => r.slug === slug)?.spec.title ?? slug;
  return (
    <section className={styles.panel} aria-label={t('Обзор недели')}>
      <div className={styles.head}>
        <span className={styles.headTitle}>{t('Обзор недели')}</span>
        <span className={styles.meta}>{weekLine(w)}</span>
        <span className={styles.gap} />
        <label className={styles.setting} title={t('Сколько дней без движения в «В плане», «Ждёт других» и «В работе» считать «висит»')}>
          {t('Висит дольше')}
          <select value={staleDays} onChange={(e) => onStaleDays(Number(e.target.value))}>
            {STALE_CHOICES.map((n) => (
              <option key={n} value={n}>{t('{n} дн.', { n })}</option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.cols}>
        <div className={styles.col}>
          <span className={styles.colTitle}>{t('Закрыто')} <span className={styles.n}>{w.closedTotal}</span></span>
          {w.closed.length ? (
            <ul className={styles.list}>
              {w.closed.map((c) => (
                <li key={c.key} className={styles.row} title={`${c.title}\n${c.reason}`}>
                  <span className={styles.kind}>{c.kind}</span>
                  <span className={styles.title}>{c.title}</span>
                  <span className={styles.why}>{c.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className={styles.empty}>{t('Ничего не закрыто')}</span>
          )}
        </div>
        <div className={styles.col}>
          <span className={styles.colTitle}>{t('Зависло')} <span className={styles.n}>{w.staleTotal}</span></span>
          {w.stale.length ? (
            <ul className={styles.list}>
              {w.stale.map((s) => (
                <li key={s.key} className={styles.row} title={s.title}>
                  <span className={styles.kind}>{s.kind}</span>
                  <span className={styles.title}>{s.title}</span>
                  <span className={styles.why}>{COLUMN[s.column] ? t(COLUMN[s.column]!) : s.column} · {t('{n} дн.', { n: s.days })}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className={styles.empty}>{t('Ничего не висит')}</span>
          )}
        </div>
        <div className={styles.col}>
          <span className={styles.colTitle}>{t('Пришло')} <span className={styles.n}>{w.arrived.total}</span></span>
          {w.arrived.total ? (
            <ul className={styles.list}>
              {w.arrived.routines.map((r) => (
                <li key={r.routine} className={styles.row}>
                  <span className={styles.title}>{routineTitle(r.routine)}</span>
                  <span className={styles.n}>{r.count}</span>
                </li>
              ))}
              {w.arrived.other > 0 && (
                <li className={styles.row}>
                  <span className={`${styles.title} ${styles.muted}`}>{t('руками и из сессий')}</span>
                  <span className={styles.n}>{w.arrived.other}</span>
                </li>
              )}
            </ul>
          ) : (
            <span className={styles.empty}>{t('Новых дел не было')}</span>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * «Записать знание»: закрытые за три дня дела, по которым был запуск или сессия, — карточка с черновиком строки и тегом
 * по виду работы. Модель не участвует; строка уходит в тег только по «Записать». «Записать» и «Не надо» помнятся в
 * браузере — карточка больше не всплывает.
 */
export function LearnPrompts({ now }: { now: number }) {
  const on = useFeature('tag-notes');
  // все дела — тот же запрос, что у closedWorkFeed (один кэш)
  const desk = useDesk(ALL);
  const tagsOn = useFeature('tags');
  const tags = useTags(on && tagsOn);
  const [skip, setSkip] = useState(() => new Set(readLearned()));
  if (!on) return null;
  const list = learnCandidates(desk.data?.items ?? [], skip, new Date(now));
  if (!list.length) return null;
  const done = (id: string) => {
    const next = [...skip, id].slice(-LEARNED_KEEP);
    LS.set(LEARNED_KEY, next);
    setSkip(new Set(next));
  };
  return (
    <section className={styles.learn} aria-label={t('Записать знание')}>
      {list.map((i) => (
        // пока теги не пришли, тег по виду не найти — кнопка ждёт, а не заводит второй тег
        <LearnCard key={i.id} item={i} tag={tagForKind(i.kind, tags.data?.tags ?? [])} ready={Boolean(tags.data)} onDone={() => done(i.id)} />
      ))}
    </section>
  );
}

function LearnCard({ item, tag, ready, onDone }: { item: DeskItem; tag: ReturnType<typeof tagForKind>; ready: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  // поле пустое: заголовок и причина — чужой текст (см. noteContext), в тег — только своё
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    appendTagNote(tag.slug, text, tag.exists ? undefined : tag.title)
      .then(() => {
        toast(t('Записано в «{tag}»', { tag: tag.title }));
        void qc.invalidateQueries({ queryKey: keys.tags });
        onDone();
      })
      .catch((err: unknown) => toast(errorText(err)))
      .finally(() => setBusy(false));
  };
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.kind}>{item.kind}</span>
        <span className={styles.cardTitle}>{t('Записать знание в тег «{tag}»?', { tag: tag.title })}</span>
        {!tag.exists && <span className={styles.meta}>{t('тег заведётся')}</span>}
      </div>
      <p className={styles.context} title={noteContext(item)}>{noteContext(item)}</p>
      <p className={styles.hint}>{t('Дело закрыто, по нему шла работа: что стоит помнить в следующий раз? Строка уйдёт в заметки тега знаний этого вида работы — их получают этапы и сессии с этим тегом.')}</p>
      <textarea
        className={styles.text}
        rows={2}
        maxLength={1000}
        value={text}
        placeholder={t('Что стоит помнить в следующий раз — своими словами')}
        aria-label={t('Что запомнить')}
        onChange={(e) => setText(e.target.value)}
      />
      <div className={styles.actions}>
        <button type="button" className="btn primary small" disabled={busy || !ready || !text.trim()} title={`${t('Тег знаний')}: ${tag.slug}`} onClick={save}>{t('Записать', undefined, 'desk')}</button>
        <button type="button" className="btn small" disabled={busy} onClick={onDone}>{t('Не надо')}</button>
      </div>
    </div>
  );
}
