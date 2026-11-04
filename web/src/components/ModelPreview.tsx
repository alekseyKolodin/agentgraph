// «Модель получит» — один компонент для формы сессии, формы запуска и экрана сессии (.interface-design/system.md →
// Model gets): что пространство и теги знаний дадут модели. Свёрнуто — строка-сводка; раскрыто — читаемо (карта, состояние
// markdown, документы, папки, строка каждого тега знаний) или «как есть» — точный текст из GET /api/model-context, тем же
// кодом, что сервер отправит. where: session — хук SessionStart, phase — хвост промпта каждого этапа.
import { useState } from 'react';
import { Link } from 'react-router';
import type { SpaceListItem } from '@server/api-types';
import { errorText, useModelContext } from '../api';
import { plural } from '../lib/format';
import { t } from '../lib/i18n';
import { docLine, modelSummary } from '../lib/spaces';
import { MdText } from './MdText';
import styles from './ModelPreview.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

type Props = {
  /** Слаг пространства или ''. Новый слаг (его нет в options) — строка «заведётся пустым». */
  space: string;
  /** Теги знаний — только существующие (формы других не пускают). */
  tags: string[];
  where: 'session' | 'phase';
  options: SpaceListItem[];
  /** Список пространств загружен: до этого существующее нельзя отличить от нового. */
  loaded: boolean;
  className?: string;
};

const chars = (n: number) => `${n} ${plural(n, 'знак', 'знака', 'знаков')}`;

export function ModelPreview({ space, tags, where, options, loaded, className }: Props) {
  const slug = space.trim();
  const known = options.some((o) => o.slug === slug);
  const fresh = loaded && Boolean(slug) && !known;
  const query = useModelContext(known ? slug : '', tags, loaded && Boolean((slug && known) || tags.length));
  const [raw, setRaw] = useState(false);
  if (!slug && !tags.length) return null;
  const v = query.data;
  const freshLine = fresh ? t('◇ {slug} — новое пространство: заведётся пустым, карты и состояния у него нет', { slug }) : '';
  const busy = !loaded || query.isFetching;
  const summary = [freshLine, v ? modelSummary(v) : query.isError ? errorText(query.error) : busy ? t('загружаю…') : ''].filter(Boolean).join(' · ');
  const text = v ? (where === 'session' ? v.session : v.phase) : '';
  return (
    <details className={cx(styles.preview, className)}>
      <summary title={t('Что пространство и теги знаний дадут модели — тот же текст, что сервер отправит')}>
        <span className={styles.caret} aria-hidden="true">▸</span>
        <span className={styles.title}>{t('Модель получит')}</span>
        <span className={cx(styles.sum, query.isError && styles.err)}>{summary}</span>
      </summary>
      {v && (
        <div className={styles.body}>
          <div className={styles.modes} role="group" aria-label={t('Вид превью')}>
            <button type="button" className={cx('chip', !raw && 'on')} aria-pressed={!raw} onClick={() => setRaw(false)}>{t('читаемо')}</button>
            <button type="button" className={cx('chip', raw && 'on')} aria-pressed={raw} onClick={() => setRaw(true)} title={t('Точный текст, как его получит модель')}>{t('как есть')}</button>
          </div>
          {raw ? (
            <pre className={styles.raw}>{text || t('(пусто)')}</pre>
          ) : (
            <div className={styles.readable}>
              {v.space && (
                <>
                  <section>
                    <h4>{t('Карта')} <span className="mono">CLAUDE.md</span></h4>
                    <p>
                      {v.space.map.chars ? t('Памятью, как CLAUDE.md репозитория · {n}', { n: chars(v.space.map.chars) }) : t('Карты нет: заполни её на странице пространства')}
                      {' '}<Link to={`/spaces/${encodeURIComponent(v.space.slug)}`}>{t('открыть пространство')}</Link>
                    </p>
                  </section>
                  <section>
                    <h4>{t('Состояние «где мы сейчас»')}</h4>
                    {v.space.state ? <div className={styles.state}><MdText text={v.space.state} /></div> : <p className="muted">{t('Ещё нет: его запишет короткая сессия после первой работы в пространстве')}</p>}
                  </section>
                  {v.space.docs.length > 0 && (
                    <section>
                      <h4>{t('Документы — по запросу')}</h4>
                      <ul>{v.space.docs.map((d) => <li key={d.name}><span className="mono">{d.name}</span> <span className="muted">{docLine(d)}</span></li>)}</ul>
                    </section>
                  )}
                  {v.space.dirs.length > 0 && (
                    <section>
                      <h4>{t('Папки — только чтение')}</h4>
                      <ul>{v.space.dirs.map((d) => <li key={d} className="mono">{d}</li>)}</ul>
                    </section>
                  )}
                </>
              )}
              {v.knowledge.length > 0 && (
                <section>
                  <h4>{t('Знания')}</h4>
                  <ul>{v.knowledge.map((k) => <li key={k.slug}><span className="mono">#{k.slug}</span> <span className="muted">{k.inline ? t('целиком: {n}', { n: chars(k.text.length) }) : k.text.replace(/^-\s*/, '')}</span></li>)}</ul>
                </section>
              )}
            </div>
          )}
          <p className="muted small">
            {where === 'session'
              ? t('Карта — памятью при старте claude; остальное — хуком SessionStart, изменения — со следующим шагом.')
              : t('Раздел — в конце промпта каждого этапа, карта — памятью этапа. У блоков flow бывают и свои теги знаний.')}
          </p>
        </div>
      )}
    </details>
  );
}
