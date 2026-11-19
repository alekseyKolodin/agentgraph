// Пример события источника в узлах «Условия по полям» и «ИИ рутины»: что приходит с сервиса — заголовок, автор, текст и
// поля с настоящими значениями. В «Условиях по полям» поле добавляется в условие кликом; в «ИИ рутины» это то, что
// прочитает модель. События берутся из журнала источника (без опроса и без модели); журнал пуст — пробный опрос кнопкой.
import { useState } from 'react';
import type { EventDetail, EventField, SourceKindView, SourceView } from '@server/routines/types';
import { errorText } from '../../api';
import { fetchEventDetail, type SourceSample } from '../../api/routines';
import { t } from '../../lib/i18n';
import { baseSample, pollsByModel } from '../../lib/routines/sample';
import { foundRow } from '../../lib/routines/source';
import { cx } from './parts';
import styles from './Routines.module.css';

/** Сколько знаков текста события видно сразу; остальное — по «Показать целиком». */
const TEXT_SHOWN = 400;

type Props = {
  source: SourceView;
  kind: SourceKindView | undefined;
  sample: SourceSample;
  /** «Условия по полям»: клик по полю добавляет условие на него. Нет — пример только для чтения («ИИ рутины»). */
  onPick?: (f: EventField) => void;
};

export function EventSample({ source, kind, sample, onPick }: Props) {
  const [at, setAt] = useState(0);
  const [whole, setWhole] = useState(false);
  const list = sample.data?.events ?? [];
  const cur = list[Math.min(at, list.length - 1)];
  const title = source.spec.title;
  const base: Record<string, string> = { title: t('Заголовок'), author: t('Автор'), text: t('Текст') };
  const row = (f: EventField, label?: string) => {
    const long = f.key === 'text' && f.value.length > TEXT_SHOWN;
    return (
      <div key={f.key} className={styles.sampleRow}>
        <span className={cx(styles.sampleKey, !label && styles.path)} title={label ? undefined : f.key}>{label ?? f.key}</span>
        <span className={styles.sampleVal}>
          {long && !whole ? `${f.value.slice(0, TEXT_SHOWN)}…` : f.value}
          {f.list && <span className={styles.sampleNote}> · {t('список')}</span>}
          {long && (
            <>
              {' '}
              <button type="button" className="btn small ghost" aria-expanded={whole} onClick={() => setWhole(!whole)}>{whole ? t('Свернуть') : t('Показать целиком')}</button>
            </>
          )}
        </span>
        {onPick && (
          <button type="button" className="btn small ghost" title={t('Добавить условие на поле «{field}»', { field: label ?? f.key })} onClick={() => onPick(f)}>
            {t('+ условие')}
          </button>
        )}
      </div>
    );
  };
  return (
    <div className={styles.clause}>
      <span className={styles.k}>{t('Пример')}</span>
      <div className={styles.clauseBody}>
        <SampleState source={source} kind={kind} sample={sample} />
        {cur && (
          <>
            <div className={styles.sampleHead}>
              <span>
                {onPick
                  ? t('Настоящее событие из «{title}» — на такие поля пишутся условия.', { title })
                  : t('Настоящее событие из «{title}» — модель прочитает его таким.', { title })}
              </span>
              <span className={styles.barGap} />
              <span className={styles.mono}>{foundRow(cur.event).meta}</span>
              {list.length > 1 && (
                <span className={styles.inline}>
                  <button type="button" className="btn small ghost" disabled={at <= 0} aria-label={t('Событие новее')} title={t('Событие новее')} onClick={() => (setAt(at - 1), setWhole(false))}>‹</button>
                  <span className={styles.mono}>{t('{i} из {n}', { i: Math.min(at, list.length - 1) + 1, n: list.length })}</span>
                  <button type="button" className="btn small ghost" disabled={at >= list.length - 1} aria-label={t('Событие старее')} title={t('Событие старее')} onClick={() => (setAt(at + 1), setWhole(false))}>›</button>
                </span>
              )}
            </div>
            <div className={styles.sampleRows}>
              {baseSample(cur.event).map((f) => row(f, base[f.key]))}
              {cur.fields.length > 0 && <div className={styles.samplePart}>{t('Поля из ответа сервиса')}</div>}
              {cur.fields.map((f) => row(f))}
            </div>
            <span className={styles.hint}>
              {onPick
                ? t('«+ условие» берёт поле и его значение из примера — поправь под себя. У поля-списка условие совпадает, если совпал хоть один элемент. Чего здесь нет, по полю не отобрать — это работа узла «ИИ рутины».')
                : cur.fields.length
                  ? t('Модель видит заголовок, автора, время, текст и поля — пиши условие про то, что в них есть. Если нужного здесь нет, модель об этом не узнает.')
                  : t('Модель видит заголовок, автора, время и текст — пиши условие про то, что в них есть. Если нужного здесь нет, модель об этом не узнает.')}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** Примера ещё нет: читается журнал, журнал пуст (пробный опрос кнопкой) или сервис не ответил. */
function SampleState({ source, kind, sample }: Pick<Props, 'source' | 'kind' | 'sample'>) {
  const title = source.spec.title;
  const has = Boolean(sample.data?.events.length);
  const live = kind?.delivery === 'live';
  const paid = kind?.delivery === 'model' || pollsByModel(source.spec);
  return (
    <>
        {sample.loading && <span className={styles.hint}>{t('Читаю последние события «{title}»…', { title })}</span>}
        {!sample.loading && !has && (
          <>
            <span className={styles.hint}>
              {live
                ? t('Событий из «{title}» ещё не было. Пример появится здесь, когда придёт первое.', { title })
                : t('В журнале «{title}» событий ещё нет: он наполняется, когда источником пользуется включённая рутина. Можно спросить сервис сейчас — это ничего не запустит.', { title })}
            </span>
            {!live && (
              <div className={styles.inline}>
                <button type="button" className="btn small" disabled={sample.polling} title={t('Пробный опрос: записи только показываются, ничего не запускается и не запоминается')} onClick={sample.poll}>
                  {sample.polling ? t('Спрашиваю «{title}»…', { title }) : t('Спросить сервис сейчас')}
                </button>
                {paid && <span className={styles.warn}>{t('Этот источник читает модель: пробный опрос потратит немного лимита.')}</span>}
              </div>
            )}
            {sample.data?.from === 'poll' && !sample.data.error && <span className={styles.hint}>{t('Сервис ответил, но записей нет.')}</span>}
          </>
        )}
        {sample.data?.error && <span className={styles.err}>{sample.data.error}</span>}
        {sample.error && <span className={styles.err}>{errorText(sample.error)}</span>}
    </>
  );
}

/**
 * «Получит» в узле «Запустить flow»: вход flow целиком на настоящем событии — задача и событие ровно тем текстом, каким
 * они уйдут в запуск. Чего здесь нет, у flow не будет: источник отдаёт только то, что запрошено в его настройке.
 */
export function FlowInput({ source, kind, sample, task }: Pick<Props, 'source' | 'kind' | 'sample'> & { /** run.input; пусто — задача из самого flow. */ task: string }) {
  const [at, setAt] = useState(0);
  // подробности по id события: запрос к сервису — только по кнопке
  const [details, setDetails] = useState<Record<string, EventDetail>>({});
  const [asking, setAsking] = useState(false);
  const list = sample.data?.events ?? [];
  const cur = list[Math.min(at, list.length - 1)];
  const title = source.spec.title;
  const detail = cur ? details[cur.event.id] : undefined;
  const ask = async () => {
    if (!cur) return;
    const { id, link, title: name } = cur.event;
    setAsking(true);
    try {
      const got = await fetchEventDetail(source.slug, { id, ...(link ? { link } : {}), title: name });
      setDetails((x) => ({ ...x, [id]: got }));
    } catch (e) {
      setDetails((x) => ({ ...x, [id]: { max: 0, error: errorText(e) } }));
    } finally {
      setAsking(false);
    }
  };
  return (
    <div className={styles.clause}>
      <span className={styles.k}>{t('Получит')}</span>
      <div className={styles.clauseBody}>
        <SampleState source={source} kind={kind} sample={sample} />
        {cur && (
          <>
            <div className={styles.sampleHead}>
              <span>{t('Вход flow целиком — на настоящем событии из «{title}»: задача и само событие.', { title })}</span>
              <span className={styles.barGap} />
              <span className={styles.mono}>{foundRow(cur.event).meta}</span>
              {list.length > 1 && (
                <span className={styles.inline}>
                  <button type="button" className="btn small ghost" disabled={at <= 0} aria-label={t('Событие новее')} title={t('Событие новее')} onClick={() => setAt(at - 1)}>‹</button>
                  <span className={styles.mono}>{t('{i} из {n}', { i: Math.min(at, list.length - 1) + 1, n: list.length })}</span>
                  <button type="button" className="btn small ghost" disabled={at >= list.length - 1} aria-label={t('Событие старее')} title={t('Событие старее')} onClick={() => setAt(at + 1)}>›</button>
                </span>
              )}
            </div>
            <pre className={styles.previewText}>{[task.trim() || t('(задача из input flow)'), cur.block, ...(detail?.block ? [detail.block] : [])].join('\n\n')}</pre>
            {source.detail && (
              <div className={styles.inline}>
                <span className={styles.hint}>
                  {detail?.block
                    ? t('Подробности события показаны: {n} знаков.', { n: detail.chars ?? 0 })
                    : t('Перед запуском источник дозапросит подробности события — полную запись. Flow получит их целиком, после события.')}
                </span>
                {!detail?.block && (
                  <button type="button" className="btn small" disabled={asking} title={t('Тот же запрос к сервису, что перед запуском flow. Ничего не запускает')} onClick={() => void ask()}>
                    {asking ? t('Запрашиваю…') : t('Показать с подробностями')}
                  </button>
                )}
              </div>
            )}
            {detail?.error && <span className={styles.err}>{detail.error}</span>}
            {detail?.block && (detail.chars ?? 0) > detail.max && (
              <span className={styles.warn}>{t('Подробности длиннее предела: flow получит первые {max} знаков из {n}.', { max: detail.max, n: detail.chars ?? 0 })}</span>
            )}
            {cur.cut?.text !== undefined && (
              <span className={styles.warn}>{t('Текст события длиннее предела: flow получит первые {max} знаков из {n}.', { max: cur.cut.textMax, n: cur.cut.text })}</span>
            )}
            {cur.cut?.fields !== undefined && (
              <span className={styles.warn}>{t('Поля события длиннее предела: flow получит первые {max} знаков из {n}.', { max: cur.cut.fieldsMax, n: cur.cut.fields })}</span>
            )}
            <span className={styles.hint}>
              {source.detail
                ? t('Больше flow ничего не получает: задача, событие и подробности события. Узел «ИИ рутины» подробностей не видит — он решает по событию.')
                : t('Больше flow ничего не получает. Событие — это то, что источник запросил у сервиса: чего нет здесь (например, полного текста записи), того нет и у flow. Нужно больше — это меняется в настройке источника, а не в задаче.')}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
