// «Опиши, что рутина должна делать»: первый способ создать рутину на «Новой рутине». Слова → одна сессия модели собирает
// черновик из источников, flow и пространств человека → форма ниже заполняется, человек правит и сам жмёт «Дальше».
// Ничего не включается. Как «Описать словами» у подключения сервиса: запуск, опрос, отмена. По docs/ASSISTANTS.md
// видно, кто работает: модель выбирает человек (запоминается для раздела), рядом — что помощник знает и сколько потратил.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ComposeView } from '@server/routines/types';
import { errorText } from '../../api';
import { cancelCompose, routineKeys, startCompose, useCompose } from '../../api/routines';
import { useQueryClient } from '@tanstack/react-query';
import { ModelPick } from '../../components/ModelPick';
import { usd } from '../../lib/format';
import { modelChip } from '../../lib/flow/ai-progress';
import { t } from '../../lib/i18n';
import { LS } from '../../lib/storage';
import { connectNeedHref } from '../../lib/routines/compose';
import styles from './ComposeBox.module.css';
import rs from './Routines.module.css';

type Ready = Extract<ComposeView, { state: 'ready' }>;

/** Модель помощника раздела «Рутины»: выбор человека запоминается в браузере ('' — по умолчанию). */
const MODEL_KEY = 'agentgraph.assistantModel.routines';

type Props = {
  /** Черновик готов: форма берёт его целиком (один раз на ответ). */
  onReady: (v: Ready) => void;
  /** Уходим подключать недостающий источник: форма запоминает черновик. */
  onConnect: () => void;
};

export function ComposeBox({ onReady, onConnect }: Props) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [model, setModel] = useState(() => LS.get<string>(MODEL_KEY, ''));
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const q = useCompose(id);
  const v = q.data;
  // ушли со страницы, не дождавшись: сессия модели не должна работать без хозяина
  const idRef = useRef(id);
  idRef.current = id;
  useEffect(
    () => () => {
      if (idRef.current) void cancelCompose(idRef.current).catch(() => undefined);
    },
    [],
  );
  // готовый ответ форма принимает один раз
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (v?.state === 'ready' && applied.current !== v.id) {
      applied.current = v.id;
      onReady(v);
    }
  }, [v, onReady]);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      if (id) await cancelCompose(id).catch(() => undefined);
      const r = await startCompose(text.trim(), model.trim());
      qc.setQueryData(routineKeys.compose(r.id), r);
      applied.current = null;
      setId(r.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (id) await cancelCompose(id).catch(() => undefined);
    setId(null);
  };
  const working = v?.state === 'working';

  return (
    <section className={styles.box} aria-label={t('Опиши, что рутина должна делать')}>
      <div className={styles.head}>
        <h2>{t('Опиши, что рутина должна делать')}</h2>
        <span className={styles.who}>
          <span className={styles.lbl}>{t('Помощник')}</span>
          <ModelPick
            value={model}
            onChange={(m) => {
              setModel(m);
              LS.set(MODEL_KEY, m);
            }}
            defaultLabel={t('sonnet, по умолчанию')}
            label={t('Модель помощника')}
            title={t('Модель, которая собирает черновик. Выбор запоминается для раздела «Рутины».')}
            disabled={working}
            selectClassName={styles.model}
            inputClassName={styles.modelId}
          />
        </span>
      </div>
      <span className={rs.hint}>{t('Видит: твои подключённые источники и поля их событий, flow с блоками, пространства. Инструментов у него нет: он заполняет форму, а проверить источник и собрать flow пока не может — это делаешь ты ниже.')}</span>
      <form
        className={rs.field}
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && !working) void start();
        }}
      >
        <textarea
          className={rs.inp}
          rows={2}
          aria-label={t('Опиши, что рутина должна делать')}
          placeholder={t('Например: когда мне приходит запрос на ревью MR в GitLab — заведи дело «Ревью», а flow запусти, только если я разрешу')}
          value={text}
          disabled={working}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !working) void start();
          }}
        />
        <div className={styles.row}>
          <button type="submit" className="btn primary" disabled={busy || working || !text.trim()} title={t('Одна сессия модели соберёт черновик из твоих источников и flow. Ничего не сохранится и не включится')}>
            {v?.state === 'ready' ? t('Собрать заново') : t('Собрать черновик')}
          </button>
          {working && <button type="button" className="btn ghost" onClick={() => void stop()}>{t('Отменить')}</button>}
          {!v && <span className={rs.hint}>{t('Ничего не сохранится и не включится: ты увидишь заполненную форму и поправишь её.')}</span>}
        </div>
      </form>
      {working && (
        <div className={styles.progress} role="status">
          <span className={styles.dot} aria-hidden="true" />
          {v.step}
          {v.model && <span className={styles.chip} title={t('Модель сессии: {model}', { model: v.model })}>{modelChip(v.model)}</span>}
        </div>
      )}
      {v?.state === 'error' && <span className={rs.err}>{v.error}</span>}
      {q.isError && <span className={rs.err}>{errorText(q.error)}</span>}
      {error && <span className={rs.err}>{error}</span>}
      {v?.state === 'ready' && <ReadyNote v={v} onConnect={onConnect} />}
    </section>
  );
}

function ReadyNote({ v, onConnect }: { v: Ready; onConnect: () => void }) {
  return (
    <>
      <span className="ok small">
        {t('Черновик собран и заполнен ниже. Он не включён — проверь шаги и поправь.')}
        <span className="muted">{[v.model ? ` · ${modelChip(v.model)}` : '', v.costUsd >= 0.005 ? ` · ${usd(v.costUsd)}` : ''].join('')}</span>
      </span>
      {v.notes.length > 0 && (
        <ul className={styles.notes} aria-label={t('Что решено и что угадано')}>
          {v.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {v.needs.source && (
        <div className={styles.need}>
          <span>
            <b>{t('Нужного источника пока нет.')}</b> {t('Подключи: {what}', { what: v.needs.source.description })}
          </span>
          <div>
            <Link className="btn small" to={connectNeedHref(v.needs.source)} onClick={onConnect}>
              {t('Подключить сервис')}
            </Link>{' '}
            <span className={styles.saved}>{t('Черновик сохранён на сервере и вернётся после подключения.')}</span>
          </div>
        </div>
      )}
      {v.needs.flow && (
        <div className={styles.need}>
          <span>
            <b>{t('Подходящего flow нет.')}</b> {t('Выбери готовый ниже или собери новый: {what}', { what: v.needs.flow })}
          </span>
        </div>
      )}
      {v.problems.length > 0 && (
        <ul className={styles.problems} aria-label={t('Что проверить')}>
          {v.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </>
  );
}
