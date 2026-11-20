// Страница источника (/routines/sources/:slug, docs/routines/design → Source): название, подключение (ключи — только
// «сохранён · заменить», значение не показывается никогда), частота опроса (общая для всех рутин источника), поля записи,
// как отвечать; справа — последние записи и рутины, которые им пользуются. Правки копятся патчем поверх сохранённого
// spec (lib/routines/source-edit.ts) и уходят одной кнопкой «Сохранить источник» с предупреждением, на сколько рутин
// подействует. Ключ и ответ сохраняются сразу и отдельно — с тем spec, что сейчас на сервере, а не с черновиком. Ключ
// и «Сохранить источник» делят один busy: PUT ключа несёт весь spec, и параллельно с сохранением правок он вернул бы
// старый spec поверх нового.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ConnectorScript, FieldMap, RoutinesOverview, SourceKindView, SourceSpec, SourceTestResult, SourceView } from '@server/routines/types';
import { ApiError, errorText } from '../../api';
import { checkSourceNow, deleteSource, routineKeys, saveSource, testSource, useRoutines, useSourceSample } from '../../api/routines';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { Field, Input, Seg, TextArea } from '../../components/form';
import { clock } from '../../lib/format';
import { plural, t } from '../../lib/i18n';
import { pollsByModel } from '../../lib/routines/sample';
import { checkNowText, foundRow, foundText, MAP_KEYS, mapLabel } from '../../lib/routines/source';
import { applySourcePatch, DEFAULT_EVERY, everyShort, pollSegChoices, saveImpactText, sourceChanges, sourceMinEvery, sourceProblems, type SourcePatch } from '../../lib/routines/source-edit';
import { isDraft, pillLabel, pollCostText, sourceState } from '../../lib/routines/view';
import { SampleState } from './EventSample';
import { SourceReplyPanel } from './ReplySetup';
import { NotAvailable } from './RoutinesList';
import { cx, Dot, EngineOwnerNote } from './parts';
import rs from './Routines.module.css';
import styles from './SourcePage.module.css';

export function SourcePage() {
  const { slug = '' } = useParams();
  const q = useRoutines();
  const s = q.data?.sources.find((x) => x.slug === slug);
  return (
    <>
      <Link to="/routines#sources" className={rs.back}>‹ {t('Рутины')} · {t('Источники')}</Link>
      {q.isPending && <p className="muted">{t('Загрузка…')}</p>}
      {q.isError && <NotAvailable error={q.error} />}
      {q.data && !s && <p className="muted">{t('Источник «{slug}» не найден: его удалили или переименовали.', { slug })}</p>}
      {q.data && s && <SourceBody key={s.slug} data={q.data} s={s} />}
    </>
  );
}

function SourceBody({ data, s }: { data: RoutinesOverview; s: SourceView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { askConfirm } = useConfirm();
  const kind = data.kinds.find((k) => k.kind === s.spec.kind);
  const [patch, setPatch] = useState<SourcePatch>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState<SourceTestResult | null>(null);
  const next = applySourcePatch(s.spec, patch);
  const changes = sourceChanges(s.spec, patch);
  const dirty = changes.length > 0;
  // пустая команда или обязательное поле: сервер такое примет, а опрос сломается — сохранить и проверить нельзя
  const problems = sourceProblems(next, kind);
  const connChanged = JSON.stringify(next.config) !== JSON.stringify(s.spec.config) || JSON.stringify(next.map ?? null) !== JSON.stringify(s.spec.map ?? null);
  const done = () => qc.invalidateQueries({ queryKey: routineKeys.all });
  const edit = (p: SourcePatch) => {
    setPatch((cur) => ({ ...cur, ...p, ...(p.config ? { config: { ...cur.config, ...p.config } } : {}) }));
    if (p.config || p.map) setTest(null);
  };

  // несохранённые правки: уход с экрана и перезагрузка спрашивают, а не теряют их молча
  const leaving = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => !leaving.current && dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void askConfirm(t('Бросить правки источника «{name}»? Они не сохранены.', { name: s.spec.title }), { ok: t('Бросить'), danger: true }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await saveSource(s.slug, next);
      setPatch({});
      setTest(null);
      await done();
      toast(t('Источник «{name}» сохранён', { name: next.title }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const tryDraft = async () => {
    setBusy(true);
    setError('');
    try {
      setTest(await testSource(next));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    try {
      const r = await checkSourceNow(s.slug);
      toast(`${s.spec.title}: ${checkNowText(r)}`);
      await done();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await askConfirm(t('Удалить источник «{name}»? Файл источника удалится, ключи останутся.', { name: s.spec.title }), { ok: t('Удалить'), danger: true }))) return;
    try {
      await deleteSource(s.slug);
      leaving.current = true;
      await done();
      void navigate('/routines#sources');
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? t('Источник используют рутины: {list}', { list: s.usedBy.join(', ') }) : errorText(e));
    }
  };

  const ss = sourceState(s);
  const cost = pollCostText(s);
  const meta = [
    kind?.title ?? s.spec.kind,
    s.check?.ok ? t('проверен {at}, {n} {w}', { at: clock(s.check.at), n: s.check.total, w: plural(s.check.total, 'запись', 'записи', 'записей') }) : s.lastCheckAt && !s.check ? t('проверен {at}', { at: clock(s.lastCheckAt) }) : '',
    cost,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <header className={styles.head}>
        <Dot tone={ss.tone} title={ss.label} />
        <h1>{s.spec.title}</h1>
        <span className={styles.meta}>
          {meta}
          {ss.note && <span className={ss.tone === 'fail' ? styles.bad : ss.tone === 'wait' ? styles.ask : undefined}> · {ss.note}</span>}
        </span>
        <span className={styles.grow} />
        <button
          type="button"
          className="btn"
          disabled={busy || dirty}
          title={dirty ? t('Проверяется сохранённый источник: сначала сохрани или отмени правки') : t('Опросить источник прямо сейчас, как по таймеру: новые события пройдут правила рутин, запустят что должны и попадут в журнал')}
          onClick={() => void check()}
        >
          {t('Проверить сейчас')}
        </button>
        <button
          type="button"
          className="btn ghost danger"
          disabled={s.usedBy.length > 0}
          title={s.usedBy.length ? t('Источник используют рутины: {list}', { list: s.usedBy.join(', ') }) : t('Удалить источник')}
          onClick={() => void remove()}
        >
          {t('Удалить')}
        </button>
      </header>
      <EngineOwnerNote />

      <div className={styles.layout}>
        <div className={styles.main}>
          <div className={styles.card}>
            <Row k={t('Название')}>
              <Input aria-label={t('Название')} value={patch.title ?? s.spec.title} onChange={(e) => edit({ title: e.target.value })} />
            </Row>
            <Row k={t('Подключение')}>
              <Connection s={s} kind={kind} next={next} patch={patch} edit={edit} onKeySaved={done} busy={busy} setBusy={setBusy} sources={data.sources} />
              {connChanged && (
                <div className={styles.actions}>
                  <button type="button" className="btn small" disabled={busy || problems.length > 0} title={problems[0] ?? t('Проверить без сохранения: записи только показываются, ничего не запускается')} onClick={() => void tryDraft()}>
                    {t('Проверить правку')}
                  </button>
                  {test?.ok && <span className={styles.ok}>{foundText(test.total, s.spec.kind === 'command')}</span>}
                  {test && !test.ok && <span className={styles.err}>{test.error ?? t('Источник не ответил')}</span>}
                </div>
              )}
            </Row>
            <Row k={t('Опрос')}>
              <Poll s={s} kind={kind} next={next} edit={edit} />
            </Row>
            <Row k={t('Поля записи')}>
              <Fields s={s} kind={kind} next={next} edit={edit} />
            </Row>
            <Row k={t('Как отвечать')}>
              <Reply s={s} kind={kind} dirty={dirty} busy={busy} setBusy={setBusy} />
            </Row>
          </div>
          <div className={styles.saveBar}>
            {dirty && <span className={styles.warn}>{saveImpactText(changes, s.usedBy.length)}</span>}
            {error && <span className={styles.err}>{error}</span>}
            <span className={styles.grow} />
            <button type="button" className="btn ghost" disabled={busy || !dirty} onClick={() => { setPatch({}); setTest(null); setError(''); }}>{t('Отменить')}</button>
            <button type="button" className="btn primary" disabled={busy || !dirty || problems.length > 0} title={!dirty ? t('Изменений нет') : problems[0]} onClick={() => void save()}>{t('Сохранить источник')}</button>
          </div>
        </div>

        <aside className={styles.aside} aria-label={t('Записи и рутины источника')}>
          <Recent s={s} kind={kind} />
          <Users s={s} data={data} />
        </aside>
      </div>
    </>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <section className={styles.row} aria-label={k}>
      <span className={styles.k}>{k}</span>
      <div className={styles.body}>{children}</div>
    </section>
  );
}

type EditProps = { s: SourceView; kind: SourceKindView | undefined; next: SourceSpec; edit: (p: SourcePatch) => void };

// ---------------------------------------------------------------- подключение

type KeyLock = { busy: boolean; setBusy: (busy: boolean) => void };

function Connection({ s, kind, next, patch, edit, onKeySaved, busy, setBusy, sources }: EditProps & KeyLock & { patch: SourcePatch; onKeySaved: () => Promise<unknown>; sources: SourceView[] }) {
  const secrets = s.spec.secrets ?? [];
  return (
    <>
      {secrets.map((name) => (
        <KeyRow key={name} s={s} name={name} onSaved={onKeySaved} busy={busy} setBusy={setBusy} shared={sources.filter((x) => x.slug !== s.slug && x.spec.secrets?.includes(name)).map((x) => x.spec.title)} />
      ))}
      {s.spec.kind === 'command' ? (
        <CommandConn s={s} next={next} patch={patch} edit={edit} />
      ) : s.spec.kind === 'connector' ? (
        <ConnectorConn s={s} />
      ) : (
        <KindConn s={s} kind={kind} next={next} edit={edit} />
      )}
    </>
  );
}

/**
 * Ключ: имя и «сохранён» / «нет ключа». Новое значение уходит сразу, с сохранённым spec — правки формы не задевает.
 * busy — общий со страницей: пока идёт сохранение источника (или проверка), ключ ждёт, и наоборот; после сохранения
 * страница перечитывает источник до снятия busy, так что ключ уходит уже с новым spec. Ключи хранятся по имени
 * (~/.agentgraph/secrets.json): тот же ключ берут все источники с этим именем — shared.
 */
function KeyRow({ s, name, onSaved, busy, setBusy, shared }: KeyLock & { s: SourceView; name: string; onSaved: () => Promise<unknown>; shared: string[] }) {
  const toast = useToast();
  const saved = !s.missingSecrets.includes(name);
  const [open, setOpen] = useState(!saved);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await saveSource(s.slug, s.spec, { [name]: value.trim() });
      setValue('');
      setOpen(false);
      await onSaved();
      toast(t('Ключ {name} сохранён. Источник проверится заново при следующем опросе.', { name }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className={styles.keyRow}>
        <span className={cx(styles.keyBox, styles.mono)}>
          {name}
          <span className={cx(styles.keyState, saved ? 'ok' : 'warn')}>{saved ? t('сохранён') : t('нет ключа')}</span>
        </span>
        {!open && <button type="button" className="btn" onClick={() => setOpen(true)}>{saved ? t('Заменить ключ') : t('Ввести ключ')}</button>}
      </div>
      {open && (
        <form
          className={styles.keyForm}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input type="password" autoComplete="new-password" mono aria-label={t('Новое значение {name}', { name })} placeholder={saved ? t('Вставь новый ключ') : t('Вставь ключ')} value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="btn primary" disabled={busy || !value.trim()}>{t('Сохранить ключ')}</button>
          {saved && <button type="button" className="btn ghost" disabled={busy} onClick={() => { setOpen(false); setValue(''); setError(''); }}>{t('Отмена')}</button>}
          <span className={styles.hint}>
            {t('Хранится в ~/.agentgraph, в запуски и логи не попадает.')}{' '}
            {shared.length
              ? t('Ключ общий по имени {name}: замена подействует и на {list}.', { name, list: shared.map((x) => `«${x}»`).join(', ') })
              : t('Ключ общий по имени {name}: его возьмёт любой источник с ключом {name}.', { name })}
          </span>
          {error && <span className={styles.err}>{error}</span>}
        </form>
      )}
    </>
  );
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Своя команда: команда и вторая команда подробностей; правка — по кнопке, иначе текстом. */
function CommandConn({ s, next, patch, edit }: Pick<EditProps, 's' | 'next' | 'edit'> & { patch: SourcePatch }) {
  const [open, setOpen] = useState(false);
  const editing = open || patch.config?.command !== undefined || patch.config?.detail !== undefined;
  if (!editing) {
    return (
      <Field label={t('Команда, которая отдаёт записи')}>
        <pre className={styles.code}>{str(s.spec.config.command)}</pre>
        {str(s.spec.config.detail) && <pre className={styles.code} title={t('Подробности события')}>{str(s.spec.config.detail)}</pre>}
        <div className={styles.actions}>
          <button type="button" className="btn small" onClick={() => setOpen(true)}>{t('Править команду')}</button>
        </div>
      </Field>
    );
  }
  return (
    <>
      <Field label={t('Команда, которая отдаёт записи')} hint={t('Вывод — JSON-список. Ключи команда получает переменными окружения: $ИМЯ.')} issue={!str(next.config.command) ? { tone: 'err', text: t('Без команды источник не сохранится') } : undefined}>
        <TextArea mono rows={3} spellCheck={false} value={str(next.config.command)} onChange={(e) => edit({ config: { command: e.target.value } })} />
      </Field>
      <Field label={`${t('Подробности события')} · ${t('необязательно')}`} hint={t('Для одного события, которое дошло до запуска flow. Событие — в $EVENT_ID, $EVENT_LINK и $EVENT_TITLE.')}>
        <TextArea mono rows={2} spellCheck={false} value={str(next.config.detail)} onChange={(e) => edit({ config: { detail: e.target.value } })} />
      </Field>
    </>
  );
}

/** «Сервис через Claude»: сервисы и шаги скрипта — только чтение; собрать заново — на экране подключения. */
function ConnectorConn({ s }: { s: SourceView }) {
  const tools = Array.isArray(s.spec.config.tools) ? (s.spec.config.tools as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const script = s.spec.config.script as ConnectorScript | undefined;
  const request = str(s.spec.config.request) || s.spec.description || '';
  const short = (name: string) => name.split('__').slice(1).join(' · ');
  return (
    <>
      {request && (
        <Field label={t('Что нужно')}>
          <span>{request}</span>
        </Field>
      )}
      {tools.length > 0 && (
        <Field label={t('Инструменты')}>
          <span className={styles.mono}>{tools.map(short).join(', ')}</span>
        </Field>
      )}
      {script?.steps?.length ? (
        <Field label={t('Что будет выполняться')} hint={t('Скрипт без модели: модель собрала его один раз при подключении.')}>
          <ol className={styles.steps}>
            {script.steps.map((st, i) => (
              <li key={i}>
                <span>{st.say}</span>
                <span className={styles.mono}>{st.tool.split('__').slice(2).join('__')} {JSON.stringify(st.args)}</span>
              </li>
            ))}
          </ol>
        </Field>
      ) : (
        <span className={styles.warn}>{t('Скрипта нет: каждую проверку делает модель и тратит лимит.')}</span>
      )}
      <div className={styles.actions}>
        <Link className="btn small" to="/routines/connect?mode=ready&kind=connector" title={t('Новая сборка — новым источником; этот останется, пока его не удалишь')}>{t('Собрать заново…')}</Link>
      </div>
    </>
  );
}

/** Готовый вид: строковые поля настройки вида правятся; ключи — выше, выбор инструментов MCP — только на подключении. */
function KindConn({ s, kind, next, edit }: EditProps) {
  const fields = (kind?.setup ?? []).filter((f) => !f.secret && !f.pick && (s.spec.config[f.key] === undefined || typeof s.spec.config[f.key] === 'string'));
  if (!fields.length) return <span className={styles.hint}>{kind ? t('Настраивать нечего: источник берёт всё сам.') : t('Вид «{kind}» этот сервер не знает.', { kind: s.spec.kind })}</span>;
  return (
    <>
      {fields.map((f) => {
        const v = str(next.config[f.key]);
        return (
          <Field key={f.key} label={f.optional ? `${f.label} · ${t('необязательно')}` : f.label} hint={f.hint} issue={!f.optional && !v.trim() ? { tone: 'err', text: t('Без поля «{field}» источник не сохранится', { field: f.label }) } : undefined}>
            <Input value={v} placeholder={f.placeholder} spellCheck={false} onChange={(e) => edit({ config: { [f.key]: e.target.value } })} />
          </Field>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- опрос

function Poll({ s, kind, next, edit }: EditProps) {
  if (kind?.delivery === 'live' && !s.spec.every) {
    return <span className={styles.hint}>{t('Сразу: источник держит соединение, опрашивать не нужно.')}</span>;
  }
  const min = sourceMinEvery(s.spec, kind);
  const cur = next.every ?? DEFAULT_EVERY;
  const paid = kind?.delivery === 'model' || pollsByModel(s.spec);
  return (
    <>
      <Seg<string> label={t('Как часто опрашивать')} value={cur} onChange={(every) => edit({ every })} options={pollSegChoices(min, cur).map((v) => ({ value: v, label: everyShort(v) }))} />
      <span className={styles.hint}>{t('Рутина срабатывает на каждую новую запись, а не раз в интервал. Частота общая для всех рутин источника.')}</span>
      {paid && <span className={styles.warn}>{t('Каждую проверку делает модель и тратит лимит: чем реже, тем дешевле.')}{pollCostText(s) ? ` ${pollCostText(s)}.` : ''}</span>}
    </>
  );
}

// ---------------------------------------------------------------- поля записи

function Fields({ s, kind, next, edit }: EditProps) {
  const extra = (kind?.match ?? []).map((m) => m.label);
  const more = extra.length ? <span className={styles.hint}>{t('Для условий в рутинах доступны поля: {list}.', { list: extra.join(', ') })}</span> : null;
  if (s.spec.kind === 'command') {
    const map: FieldMap = next.map ?? { id: 'id' };
    return (
      <>
        <div className={styles.map} role="group" aria-label={t('Поля записи')}>
          {MAP_KEYS.map((k) => (
            <MapRow key={k} label={mapLabel(k)}>
              <Input mono aria-label={mapLabel(k)} value={map[k] ?? ''} placeholder={k === 'items' ? t('ответ — сам список') : ''} onChange={(e) => edit({ map: { ...map, [k]: e.target.value } })} />
            </MapRow>
          ))}
        </div>
        <span className={styles.hint}>{t('Пути через точку: data.items, meta.id.')}</span>
        {more}
      </>
    );
  }
  const script = s.spec.config.script as ConnectorScript | undefined;
  const maps = (script?.steps ?? []).flatMap((st) => (st.json ? [st.json] : []));
  const map = s.spec.map ?? maps[0];
  if (!map) return more ?? <span className={styles.hint}>{t('Поля записи задаёт вид источника.')}</span>;
  return (
    <>
      <div className={styles.map}>
        {MAP_KEYS.filter((k) => map[k]).map((k) => (
          <MapRow key={k} label={mapLabel(k)}>
            <span className={styles.mono}>{map[k]}</span>
          </MapRow>
        ))}
      </div>
      {more}
    </>
  );
}

function MapRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className={styles.from}>{label}</span>
      <span className={styles.arrow} aria-hidden="true">←</span>
      {children}
    </>
  );
}

// ---------------------------------------------------------------- как отвечать

function Reply({ s, kind, dirty, busy, setBusy }: KeyLock & { s: SourceView; kind: SourceKindView | undefined; dirty: boolean }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  if (s.spec.kind !== 'connector') {
    return s.canReply ? (
      <>
        <span>{t('Отвечает в источник: тред, чат или комментарий.')}</span>
        <span className={styles.hint}>{t('Отвечать ли и когда — решает каждая рутина в своём «Ответить».')}</span>
      </>
    ) : (
      <>
        <span>{t('Не отвечает')}</span>
        <span className={styles.hint}>{kind ? t('{kind} ответить в источник не умеет: результат рутины остаётся в agentgraph.', { kind: kind.title }) : ''}</span>
      </>
    );
  }
  const reply = s.spec.config.reply as { tool?: string } | undefined;
  const tool = reply?.tool ? reply.tool.split('__').slice(2).join('__') : '';
  const drop = async () => {
    if (!(await askConfirm(t('Убрать ответ из источника «{name}»? Рутины перестанут отвечать в сервис.', { name: s.spec.title }), { ok: t('Убрать'), danger: true }))) return;
    // тот же PUT целого spec, что у ключа и «Сохранить источник»: под общим busy
    setBusy(true);
    try {
      const { reply: _reply, ...config } = s.spec.config;
      await saveSource(s.slug, { ...s.spec, config });
      await qc.invalidateQueries({ queryKey: routineKeys.all });
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (open) return <SourceReplyPanel source={s} onClose={() => setOpen(false)} />;
  return (
    <>
      <div className={styles.actions}>
        {tool ? <span>{t('Отвечает через')} <span className={styles.mono}>{tool}</span></span> : <span>{t('Не отвечает')}</span>}
        <button type="button" className="btn small" disabled={dirty || busy} title={dirty ? t('Сначала сохрани или отмени правки источника') : undefined} onClick={() => setOpen(true)}>
          {tool ? t('Поменять ответ') : t('Настроить ответ')}
        </button>
        {tool && <button type="button" className="btn small ghost danger" disabled={dirty || busy} onClick={() => void drop()}>{t('Убрать ответ')}</button>}
      </div>
      <span className={styles.hint}>{t('Ответ уходит без модели. Когда — после твоей проверки или сразу — решает режим ответа в самой рутине.')}</span>
    </>
  );
}

// ---------------------------------------------------------------- справа

/** Последние записи из журнала источника (без опроса); клик по строке раскрывает запись так, как её получит flow. */
function Recent({ s, kind }: { s: SourceView; kind: SourceKindView | undefined }) {
  const sample = useSourceSample(s.slug);
  const [open, setOpen] = useState<string | null>(null);
  const list = sample.data?.events ?? [];
  return (
    <section className={cx(styles.card, styles.side)} aria-label={t('Последнее, что пришло')}>
      <div className={styles.sideHead}>
        <span className={styles.lbl}>{t('Последнее, что пришло')}</span>
        <span className={styles.grow} />
        {list.length > 0 && <span className={styles.mono}>{list.length} {plural(list.length, 'запись', 'записи', 'записей')}</span>}
      </div>
      <SampleState source={s} kind={kind} sample={sample} />
      {list.length > 0 && (
        <div>
          {list.map(({ event, block }) => {
            const r = foundRow(event);
            const on = open === event.id;
            return (
              <div key={event.id}>
                <button type="button" className={styles.rec} aria-expanded={on} title={on ? t('Свернуть') : t('Открыть запись целиком')} onClick={() => setOpen(on ? null : event.id)}>
                  <span>{r.title}</span>
                  <span className={styles.mono}>{r.meta}</span>
                </button>
                {on && <pre className={styles.recBlock}>{block}</pre>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Users({ s, data }: { s: SourceView; data: RoutinesOverview }) {
  return (
    <section className={cx(styles.card, styles.side)} aria-label={t('Пользуются')}>
      <span className={styles.lbl}>{t('Пользуются')}</span>
      {!s.usedBy.length && <span className={styles.hint}>{t('Ни одна рутина этот источник пока не берёт.')}</span>}
      {s.usedBy.map((slug) => {
        const r = data.routines.find((x) => x.slug === slug);
        const tone = !r ? 'off' : isDraft(r) ? 'muted' : r.spec.enabled === false ? 'off' : 'ok';
        return (
          <Link key={slug} className={styles.user} to={`/routines/${encodeURIComponent(slug)}`}>
            <Dot tone={tone} />
            <span>{r?.spec.title || slug}</span>
            {r && <span className={styles.hint}>{pillLabel(r)}</span>}
          </Link>
        );
      })}
      <Link className={cx('btn small', styles.self)} to={`/routines/new?source=${encodeURIComponent(s.slug)}`}>+ {t('Новая рутина с этим источником')}</Link>
    </section>
  );
}
