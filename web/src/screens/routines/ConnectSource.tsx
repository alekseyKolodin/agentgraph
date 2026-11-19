// «Подключить сервис» (/routines/connect, docs/routines/design/Source.dc.html): три способа — «Описать словами» (агент
// находит API, просит ключ, собирает проверку и показывает, что нашёл: черновик /api/routines/sources/draft), «Готовые»
// (виды и рецепты: форма из setup вида) и «Своя команда» (команда, поля записи, ключи окружения, проверка). Сохранённый
// источник возвращает на «Новую рутину» (?from=new) уже выбранным, иначе — к списку источников.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ConnectorScript, FieldMap, KindField, McpServiceView, McpToolView, RoutinesOverview, SourceKindView, SourceSpec, SourceTestResult } from '@server/routines/types';
import { errorText } from '../../api';
import { cancelDraft, draftSecret, fetchMcpTools, importRecipe, refineDraft, routineKeys, saveSource, startConnectorBuild, startDraft, testSource, useConnectorBuild, useDraft, useMcpTools, useRecipes, useRoutines, type RecipeView } from '../../api/routines';
import { t } from '../../lib/i18n';
import { commandSpec, DEFAULT_MAP, everyLabel, everyOptions, foundRow, foundText, kindSpec, MAP_KEYS, mapLabel, missingFields } from '../../lib/routines/source';
import { DEFAULT_REPLY_ARGS, parseReply } from '../../lib/routines/reply';
import { slugify } from '../../lib/routines/spec';
import { NotAvailable } from './RoutinesList';
import { ReplyStep } from './ReplySetup';
import { cx, Dot, Seg } from './parts';
import styles from './Routines.module.css';

type Mode = 'words' | 'ready' | 'cmd';

export function ConnectSource() {
  const q = useRoutines();
  const [params] = useSearchParams();
  const fromNew = params.get('from') === 'new';
  const [mode, setMode] = useState<Mode>((params.get('mode') as Mode | null) ?? 'words');
  return (
    <>
      <Link to={fromNew ? `/routines/new${tplQuery(params).replace(/^&/, '?')}` : '/routines'} className={styles.back}>‹ {fromNew ? t('Новая рутина') : t('Рутины')}</Link>
      <header className="view-head">
        <h1>{t('Подключить сервис')}</h1>
      </header>
      <Seg<Mode>
        label={t('Как подключить')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'words', label: t('Описать словами') },
          { value: 'ready', label: t('Готовые') },
          { value: 'cmd', label: t('Своя команда') },
        ]}
      />
      <div className={styles.connectGrid}>
        <div className={styles.connectMain}>
          {q.isError && <NotAvailable error={q.error} />}
          {q.data && mode === 'words' && <Words data={q.data} fromNew={fromNew} />}
          {q.data && mode === 'ready' && <Ready data={q.data} fromNew={fromNew} />}
          {q.data && mode === 'cmd' && <Command data={q.data} fromNew={fromNew} />}
        </div>
        <aside className={styles.aside} aria-label={t('Как это работает')}>
          <span className={styles.lbl}>{t('Как это работает')}</span>
          <p>{t('Источник — это проверка, которая возвращает список записей: встречи, письма, заявки, алерты.')}</p>
          <p>{t('agentgraph запускает её раз в несколько минут и помнит, что уже видел.')}</p>
          <p>{t('Каждая новая запись запускает рутину.')}</p>
        </aside>
      </div>
    </>
  );
}

/** «&tpl=…» шаблона «Новой рутины», с которого пришли подключать источник; нет — ''. */
const tplQuery = (params: URLSearchParams): string => {
  const tpl = params.get('tpl');
  return tpl && /^[a-z-]{1,32}$/.test(tpl) ? `&tpl=${tpl}` : '';
};

/** Сохранить источник и вернуться туда, откуда пришли. */
function useSaveSource(data: RoutinesOverview, fromNew: boolean) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const tplBack = tplQuery(useSearchParams()[0]);
  return async (spec: SourceSpec, secrets?: Record<string, string>, slugHint?: string) => {
    const taken = data.sources.map((s) => s.slug);
    const slug = slugHint && !taken.includes(slugHint) ? slugHint : slugify(spec.title, taken);
    await saveSource(slug, spec, secrets);
    await qc.invalidateQueries({ queryKey: routineKeys.all });
    // шаблон «Новой рутины» (?tpl=) переживает подключение источника: форма откроется с ним и с новым источником
    void navigate(fromNew ? `/routines/new?source=${encodeURIComponent(slug)}${tplBack}` : '/routines#sources');
  };
}

/** Строка шага: ✓ сделано, точка — ждёт тебя, мигающая — идёт. */
function Stp({ state, children }: { state: 'ok' | 'wait' | 'work' | 'fail'; children: ReactNode }) {
  return (
    <div className={styles.stp}>
      {state === 'ok' ? <span className={styles.stpOk} aria-hidden="true">✓</span> : state === 'work' ? <span className={cx(styles.spinner, styles.stpWait)} aria-hidden="true" /> : <span className={styles.stpWait}><Dot tone={state === 'wait' ? 'wait' : 'fail'} /></span>}
      <div>{children}</div>
    </div>
  );
}

function Found({ test }: { test: SourceTestResult }) {
  if (!test.sample.length) return null;
  return (
    <div className={styles.foundList}>
      {test.sample.map((e) => {
        const r = foundRow(e);
        return (
          <div key={e.id} className={styles.found}>
            <span title={e.text}>{r.title}</span>
            <span className={styles.mono}>{r.meta}</span>
          </div>
        );
      })}
    </div>
  );
}

/** «▸ Что будет выполняться»: запрос с замаскированными ключами. */
function Exec({ request }: { request: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={cx('btn small ghost', styles.selfStart)} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {t('Что будет выполняться')}
      </button>
      {open && <pre className={styles.exec}>{request}</pre>}
    </>
  );
}

function EverySelect({ value, min, onChange }: { value: string; min: string | undefined; onChange: (v: string) => void }) {
  const opts = everyOptions(min);
  return (
    <span>
      {t('проверять')}{' '}
      <select className={styles.slot} aria-label={t('Как часто проверять')} value={value} onChange={(e) => onChange(e.target.value)}>
        {[...new Set([value, ...opts])].map((o) => (
          <option key={o} value={o}>{everyLabel(o)}</option>
        ))}
      </select>
    </span>
  );
}

const minEveryOf = (data: RoutinesOverview, kind: string) => data.kinds.find((k) => k.kind === kind)?.minEvery;

// ---------------------------------------------------------------- словами

function Words({ data, fromNew }: { data: RoutinesOverview; fromNew: boolean }) {
  const qc = useQueryClient();
  const [want, setWant] = useState('');
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [note, setNote] = useState('');
  const [every, setEvery] = useState<string | null>(null);
  const draft = useDraft(id);
  const d = draft.data;
  const save = useSaveSource(data, fromNew);
  // ушли со страницы, не сохранив: черновик отменяем — сессия модели не должна работать без хозяина, вернуться к ней
  // из UI нельзя (сохранённый источник от отмены черновика не пропадает)
  const idRef = useRef(id);
  idRef.current = id;
  useEffect(
    () => () => {
      if (idRef.current) void cancelDraft(idRef.current).catch(() => undefined);
    },
    [],
  );

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const put = (v: Awaited<ReturnType<typeof startDraft>>) => {
    qc.setQueryData(routineKeys.draft(v.id), v);
    setId(v.id);
  };
  const find = () => run(async () => put(await startDraft(want.trim())));
  const restart = () =>
    run(async () => {
      if (id) await cancelDraft(id).catch(() => undefined);
      setId(null);
      setKey('');
      setNote('');
      setEvery(null);
    });

  const spec = d && 'spec' in d ? d.spec : undefined;
  return (
    <>
      <div className={styles.field}>
        <label className={styles.lbl} htmlFor="want">{t('Что должно запускать рутину')}</label>
        <form
          className={styles.inline}
          onSubmit={(e) => {
            e.preventDefault();
            if (want.trim()) void find();
          }}
        >
          <input id="want" className={styles.inp} value={want} placeholder={t('Новая запись встречи в Fireflies.ai')} onChange={(e) => setWant(e.target.value)} disabled={Boolean(id)} />
          <button type="submit" className="btn" disabled={busy || !want.trim() || Boolean(id)} title={t('Агент найдёт API сервиса и соберёт проверку. Это одна сессия модели; сами проверки потом идут без неё')}>
            {t('Подобрать')}
          </button>
        </form>
      </div>
      {draft.isError && <span className={styles.err}>{errorText(draft.error)}</span>}
      {d && (
        <div>
          {d.state === 'working' && <Stp state="work">{d.step || t('Ищу, как получать записи…')}</Stp>}
          {d.state === 'needs_secret' && (
            <>
              <Stp state="ok">{t('У {service} есть API. Список записей можно получать запросом.', { service: d.spec.title.split(' · ')[0]! })}</Stp>
              <Stp state="wait">
                <form
                  className={styles.field}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (key.trim()) void run(async () => put(await draftSecret(d.id, d.secret, key.trim())));
                  }}
                >
                  <label htmlFor="key">{t('Нужен ключ API')} <span className={styles.mono}>{d.secret}</span></label>
                  <div className={styles.inline}>
                    <input id="key" className={cx(styles.inp, styles.mono)} type="password" autoComplete="off" placeholder={t('Вставь ключ')} value={key} onChange={(e) => setKey(e.target.value)} />
                    <button type="submit" className="btn" disabled={busy || !key.trim()}>{t('Сохранить и проверить')}</button>
                  </div>
                  <span className={styles.hint}>
                    {d.howTo} {t('Хранится в ~/.agentgraph, в запуски и логи не попадает.')}
                  </span>
                </form>
              </Stp>
            </>
          )}
          {d.state === 'ready' && (
            <>
              {Boolean(d.spec.secrets?.length) && <Stp state="ok">{t('Ключ сохранён.')}</Stp>}
              <Stp state="ok">{foundText(d.test.total)}</Stp>
            </>
          )}
          {d.state === 'error' && <Stp state="fail"><span className={styles.err}>{d.error}</span></Stp>}
        </div>
      )}
      {d?.state === 'ready' && (
        <section className={styles.ready} aria-label={t('Источник готов')}>
          <div className={styles.readyHead}>
            <h2>{d.spec.title}</h2>
            <EverySelect value={every ?? d.spec.every ?? '5m'} min={minEveryOf(data, d.spec.kind)} onChange={setEvery} />
          </div>
          <Found test={d.test} />
          <Exec request={d.test.request} />
          <div className="row">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => save({ ...d.spec, every: every ?? d.spec.every ?? '5m', description: d.description }, undefined, d.slug))}>
              {t('Сохранить источник')}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void restart()}>{t('Начать заново')}</button>
          </div>
        </section>
      )}
      {d && (d.state === 'ready' || d.state === 'error') && (
        <form
          className={styles.inline}
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) void run(async () => {
              put(await refineDraft(d.id, note.trim()));
              setNote('');
            });
          }}
        >
          <input className={styles.inp} value={note} placeholder={t('Не те записи? Поправь словами: «только мои встречи»')} aria-label={t('Поправка словами')} onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="btn" disabled={busy || !note.trim()}>{t('Поправить')}</button>
          {d.state === 'error' && <button type="button" className="btn ghost" onClick={() => void restart()}>{t('Начать заново')}</button>}
        </form>
      )}
      {d?.state === 'working' && (
        <div>
          <button type="button" className="btn small ghost" onClick={() => void restart()}>{t('Отменить')}</button>
        </div>
      )}
      {spec && d?.state === 'error' && <Exec request={JSON.stringify(spec.config, null, 2)} />}
      {error && <span className={styles.err}>{error}</span>}
    </>
  );
}

// ---------------------------------------------------------------- готовые

type Picked = { kind: SourceKindView } | { recipe: RecipeView };

function Ready({ data, fromNew }: { data: RoutinesOverview; fromNew: boolean }) {
  const recipes = useRecipes();
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Picked | null>(null);
  const [yaml, setYaml] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState('');
  const kinds = data.kinds.filter((k) => k.kind !== 'command' && !k.recipe);
  const key = (p: Picked | null) => (!p ? '' : 'kind' in p ? `k:${p.kind.kind}` : `r:${p.recipe.id}`);
  const add = async () => {
    setError('');
    try {
      const r = await importRecipe(yaml);
      await qc.invalidateQueries({ queryKey: routineKeys.recipes });
      setYaml('');
      setImportOpen(false);
      setPicked({ recipe: r });
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      <div className={styles.picks}>
        {kinds.map((k) => (
          <button key={k.kind} type="button" className={styles.pick} aria-pressed={key(picked) === `k:${k.kind}`} onClick={() => setPicked({ kind: k })}>
            <b>{k.title}</b>
            <span>{k.summary}</span>
          </button>
        ))}
        {(recipes.data ?? []).map((r) => (
          <button key={r.id} type="button" className={styles.pick} aria-pressed={key(picked) === `r:${r.id}`} onClick={() => setPicked({ recipe: r })}>
            <b>{r.spec.title}</b>
            <span>{r.summary}</span>
          </button>
        ))}
        {!kinds.length && !recipes.data?.length && <span className={styles.hint}>{recipes.isPending ? t('Загрузка…') : t('Готовых источников пока нет: подключи словами или своей командой.')}</span>}
      </div>
      <span className={styles.hint}>{t('Каждый источник — небольшой файл. Свой можно сохранить и отдать коллеге, он появится здесь.')}</span>
      {picked && ('kind' in picked && picked.kind.kind === 'connector' ? <ConnectorForm key={key(picked)} data={data} fromNew={fromNew} /> : <KindForm key={key(picked)} data={data} picked={picked} fromNew={fromNew} />)}
      <div>
        <button type="button" className="btn small ghost" aria-expanded={importOpen} onClick={() => setImportOpen(!importOpen)}>
          {importOpen ? '▾' : '▸'} {t('Добавить файл источника')}
        </button>
      </div>
      {importOpen && (
        <div className={styles.field}>
          <textarea className={cx(styles.inp, styles.yaml)} rows={8} value={yaml} placeholder={t('YAML источника от коллеги: title, kind, config…')} aria-label={t('YAML источника')} onChange={(e) => setYaml(e.target.value)} />
          <div className="row">
            <button type="button" className="btn" disabled={!yaml.trim()} onClick={() => void add()}>{t('Добавить в готовые')}</button>
          </div>
          {error && <span className={styles.err}>{error}</span>}
        </div>
      )}
    </>
  );
}

/** Форма вида или рецепта: поля setup (ключи — паролем), название, интервал, проверка и сохранение. */
function KindForm({ data, picked, fromNew }: { data: RoutinesOverview; picked: Picked; fromNew: boolean }) {
  const kind = 'kind' in picked ? picked.kind : data.kinds.find((k) => k.kind === picked.recipe.spec.kind);
  const recipe = 'recipe' in picked ? picked.recipe : undefined;
  // у рецепта настройки уже в файле: спрашиваем только ключи
  const setup: KindField[] = recipe ? (recipe.spec.secrets ?? []).map((name) => ({ key: name, label: name, secret: true })) : (kind?.setup ?? []);
  const [values, setValues] = useState<Record<string, string>>({});
  const [title, setTitle] = useState(recipe?.spec.title ?? kind?.title ?? '');
  const [every, setEvery] = useState(recipe?.spec.every ?? kind?.minEvery ?? '5m');
  const [test, setTest] = useState<SourceTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = useSaveSource(data, fromNew);
  const poll = (kind?.delivery ?? 'poll') !== 'live';
  // форма под длинным списком: выбрали — она на виду
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const build = (): { spec: SourceSpec; secrets: Record<string, string> } => {
    if (recipe) {
      const secrets = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
      // ответ (config.reply) в рецепте от коллеги не берём: получателя сообщений человек выбирает сам, на шаге «Как отвечать»
      const { reply: _reply, ...config } = recipe.spec.config ?? {};
      return { spec: { ...recipe.spec, config, title: title.trim() || recipe.spec.title, ...(poll ? { every } : {}) }, secrets };
    }
    return kindSpec(kind!, values, title, poll ? every : undefined);
  };
  // уже сохранённые ключи (второй Slack при сохранённом SLACK_TOKEN) вводить заново не нужно
  const missing = missingFields(setup, values, data.secretNames ?? []);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!kind && !recipe) return null;
  return (
    <section ref={box} className={styles.ready} aria-label={title}>
      <div className={styles.readyHead}>
        <h2>{title || kind?.title}</h2>
        {poll && <EverySelect value={every} min={kind?.minEvery} onChange={setEvery} />}
      </div>
      {kind?.delivery === 'model' && <span className={styles.warn}>{t('Проверка идёт через сессию модели и тратит лимит. Самый частый интервал — {every}.', { every: everyLabel(kind.minEvery) })}</span>}
      <label className={styles.field}>
        <span className={styles.lbl}>{t('Название')}</span>
        <input className={styles.inp} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      {setup.map((f) => (
          <label key={f.key} className={styles.field}>
            <span className={styles.lbl}>
              {f.label}
              {f.optional ? ` · ${t('необязательно')}` : ''}
            </span>
            <input
              className={cx(styles.inp, f.secret && styles.mono)}
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={f.placeholder ?? (f.secret ? t('Вставь ключ') : '')}
              value={values[f.key] ?? ''}
              onChange={(e) => {
                setValues({ ...values, [f.key]: e.target.value });
                setTest(null);
              }}
            />
            {(f.hint || f.secret) && <span className={styles.hint}>{[f.hint, f.secret ? t('Хранится в ~/.agentgraph, в запуски и логи не попадает.') : ''].filter(Boolean).join(' ')}</span>}
          </label>
      ))}
      <div className="row">
        <button type="button" className="btn" disabled={busy || missing.length > 0} title={missing.length ? t('Заполни: {list}', { list: missing.map((f) => f.label).join(', ') }) : t('Проверить без модели и показать, что нашлось')} onClick={() => void act(async () => setTest(await testSource(build().spec, build().secrets)))}>
          {t('Проверить')}
        </button>
        {test?.ok && <span className="ok small">{foundText(test.total)}</span>}
        {test && !test.ok && <span className={styles.err}>{test.error ?? t('Источник не ответил')}</span>}
      </div>
      {test?.ok && <Found test={test} />}
      {test && <Exec request={test.request} />}
      {test?.ok && (
        <div className="row">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void act(() => save(build().spec, build().secrets))}>{t('Сохранить источник')}</button>
        </div>
      )}
      {error && <span className={styles.err}>{error}</span>}
    </section>
  );
}

/** Имя инструмента по-человечески, когда сервер не дал описания: slack_read_channel → «Read channel». */
function toolLabel(x: McpToolView, service: string): string {
  if (x.description) return x.description;
  const prefix = service.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const name = x.tool.replace(new RegExp(`^${prefix}[_-]`, 'i'), '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

const notReady = (s: McpServiceView): string =>
  s.status === 'needs-auth' ? t('нужен вход') : s.status === 'connected' ? t('нечего читать') : s.status === 'failed' ? t('не подключился') : s.status === 'pending' ? t('подключается') : t('выключен');

/**
 * «Сервис через Claude»: сервисы из подключённых к Claude (несколько), их читающие инструменты (все отмечены, можно снять),
 * словами — что нужно. Модель один раз собирает скрипт, agentgraph прогоняет его без модели и показывает, что нашлось
 * и что будет выполняться; дальше проверка идёт по скрипту без модели.
 */
function ConnectorForm({ data, fromNew }: { data: RoutinesOverview; fromNew: boolean }) {
  const qc = useQueryClient();
  const q = useMcpTools();
  const [servers, setServers] = useState<string[]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState('');
  const [request, setRequest] = useState('');
  const [buildId, setBuildId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [title, setTitle] = useState('');
  const [every, setEvery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // «Как отвечать»: пустой инструмент — источник только читает
  const [replyTool, setReplyTool] = useState('');
  const [replyArgs, setReplyArgs] = useState(DEFAULT_REPLY_ARGS);
  const build = useConnectorBuild(buildId);
  const save = useSaveSource(data, fromNew);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const services = q.data?.services ?? [];
  const ready = services.filter((s) => s.status === 'connected' && s.tools.length);
  const others = services.filter((s) => !ready.includes(s));
  const chosen = ready.filter((s) => servers.includes(s.server));
  const tools = chosen.flatMap((s) => s.tools.map((x) => x.name)).filter((n) => !off.has(n));
  const v = build.data;
  const result = v?.state === 'ready' ? v : undefined;
  const working = busy || v?.state === 'working';

  // поменяли сервисы, галочки или просьбу — собранный скрипт уже не про то
  const reset = () => {
    setBuildId(null);
    setError('');
  };
  const toggleService = (s: McpServiceView) => {
    setServers(servers.includes(s.server) ? servers.filter((x) => x !== s.server) : [...servers, s.server]);
    reset();
  };
  const toggleTool = (name: string) => {
    const next = new Set(off);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setOff(next);
    reset();
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(routineKeys.mcp, await fetchMcpTools(true));
    } catch {
      void q.refetch();
    } finally {
      setRefreshing(false);
    }
  };
  const start = async (withNote?: string) => {
    setBusy(true);
    setError('');
    try {
      const r = await startConnectorBuild({ tools, request: request.trim(), ...(withNote ? { note: withNote, from: buildId ?? undefined } : {}) });
      setBuildId(r.id);
      setNote('');
      setTitle('');
      setEvery('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const doSave = async () => {
    if (!result) return;
    if (replyTool && !replyParsed?.ok) return;
    setBusy(true);
    setError('');
    try {
      const config = replyParsed?.ok ? { ...result.spec.config, reply: replyParsed.reply } : result.spec.config;
      await save({ ...result.spec, config, title: title.trim() || result.spec.title, every: every || result.spec.every });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const loading = q.isPending || refreshing;
  const replyParsed = replyTool ? parseReply(replyTool, replyArgs) : undefined;
  const script = result?.spec.config.script as ConnectorScript | undefined;

  return (
    <section ref={box} className={styles.ready} aria-label={t('Сервис через Claude')}>
      <div className={styles.readyHead}>
        <h2>{t('Сервис через Claude')}</h2>
        <button type="button" className="btn small ghost" disabled={loading} onClick={() => void refresh()}>↻ {t('Обновить список')}</button>
      </div>

      <div className={styles.field} role="group" aria-label={t('Сервисы')}>
        <span className={styles.lbl}>{t('Сервисы')}</span>
        {loading && <span className="muted small">{t('Смотрю, что подключено к Claude… (несколько секунд)')}</span>}
        {!loading && q.isError && <span className={styles.err}>{t('Список сервисов не загрузился: {error}', { error: errorText(q.error) })}</span>}
        {!loading && q.data && !ready.length && (
          <span className={styles.hint}>{t('К Claude пока не подключено ни одного сервиса, из которого можно читать. Подключи его на claude.ai в Settings → Connectors или командой claude mcp add, затем обнови список.')}</span>
        )}
        {!loading && ready.length > 0 && (
          <div className={styles.chipsInline}>
            {ready.map((s) => (
              <button key={s.server} type="button" className={styles.chip} aria-pressed={servers.includes(s.server)} title={s.origin === 'claudeai' ? t('Коннектор claude.ai') : t('MCP-сервер Claude Code')} onClick={() => toggleService(s)}>
                {s.title}
                {s.origin === 'claude-code' && <span className={styles.mono}>MCP</span>}
              </button>
            ))}
          </div>
        )}
        {!loading && others.length > 0 && (
          <details className={styles.notReady}>
            <summary>{t('Ещё {n} не готовы', { n: others.length })}</summary>
            <span className={styles.hint}>{others.map((s) => `${s.title} — ${notReady(s)}`).join(' · ')}</span>
          </details>
        )}
        {!ready.length || <span className={styles.hint}>{t('Можно выбрать несколько. Источник только читает: инструменты, которые меняют данные, сюда не попадают.')}</span>}
      </div>

      {chosen.map((s) => {
        const on = s.tools.filter((x) => !off.has(x.name)).length;
        const expanded = open === s.server;
        return (
          <div key={s.server} className={styles.svc}>
            <div className={styles.svcHead}>
              <b>{s.title}</b>
              <span className={styles.hint}>{on === s.tools.length ? t('отмечены все: {n}', { n: s.tools.length }) : t('отмечено {on} из {n}', { on, n: s.tools.length })}</span>
              <button type="button" className="btn small ghost" aria-expanded={expanded} onClick={() => setOpen(expanded ? '' : s.server)}>
                {expanded ? t('Свернуть') : t('Что умеет')}
              </button>
            </div>
            {expanded && (
              <div className={styles.toolList} role="group" aria-label={t('Что умеет {service}', { service: s.title })}>
                {s.tools.map((x) => (
                  <label key={x.name} className={styles.toolRow}>
                    <input type="checkbox" checked={!off.has(x.name)} onChange={() => toggleTool(x.name)} />
                    <span>
                      <span>{toolLabel(x, s.title)}</span>
                      <span className={styles.mono}>{x.tool}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <label className={styles.field}>
        <span className={styles.lbl}>{t('Что нужно')}</span>
        <textarea
          className={styles.inp}
          rows={2}
          value={request}
          placeholder={t('Например: новые сообщения в #bugs, где упоминают меня')}
          onChange={(e) => {
            setRequest(e.target.value);
            reset();
          }}
        />
        <span className={styles.hint}>{t('Модель один раз посмотрит сервис и соберёт скрипт — на это уйдёт немного лимита. Дальше проверка ходит по скрипту без модели.')}</span>
      </label>

      <div className="row">
        <button type="button" className={cx('btn', !result && 'primary')} disabled={working || !tools.length || !request.trim()} title={!tools.length ? t('Выбери сервис') : !request.trim() ? t('Напиши, что нужно') : ''} onClick={() => void start()}>
          {result ? t('Собрать заново') : t('Собрать')}
        </button>
        {v?.state === 'working' && <span className="muted small">{t(v.step)}</span>}
        {v?.state === 'error' && <span className={styles.err}>{v.error}</span>}
      </div>

      {result && (
        <>
          {result.mode === 'script' && result.test && (
            <>
              <span className="ok small">{t('Скрипт работает без модели')} · {foundText(result.test.total)}</span>
              <Found test={result.test} />
            </>
          )}
          {result.mode === 'model' && (
            <span className={styles.warn}>
              {t('Разобрать ответ сервиса без модели не вышло: {problem} Проверка будет идти через модель и тратить лимит — не чаще раза в 30 минут.', { problem: result.problem ?? '' })}
            </span>
          )}
          {script && (
            <div className={styles.toolList} aria-label={t('Что будет выполняться')}>
              <span className={styles.lbl}>{t('Что будет выполняться')}</span>
              <ol className={styles.steps}>
                {script.steps.map((st, i) => (
                  <li key={i}>
                    <span>{st.say}</span>
                    <span className={styles.mono}>
                      {st.tool.split('__').slice(2).join('__')} {JSON.stringify(st.args)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className={styles.refine}>
            <input className={styles.inp} value={note} placeholder={t('Не то? Поправь словами: «только мои сообщения»')} aria-label={t('Поправка словами')} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn" disabled={working || !note.trim()} onClick={() => void start(note.trim())}>{t('Поправить')}</button>
          </div>
          <ReplyStep services={services} chosen={servers} tool={replyTool} args={replyArgs} parsed={replyParsed} onTool={setReplyTool} onArgs={setReplyArgs} />
          <div className={styles.readyHead}>
            <label className={cx(styles.field, styles.grow)}>
              <span className={styles.lbl}>{t('Название')}</span>
              <input className={styles.inp} value={title || result.spec.title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <EverySelect value={every || result.spec.every || '5m'} min={result.mode === 'script' ? '1m' : '30m'} onChange={setEvery} />
          </div>
          <div className="row">
            <button type="button" className="btn primary" disabled={working || Boolean(replyTool && !replyParsed?.ok)} title={replyTool && !replyParsed?.ok ? replyParsed?.error : undefined} onClick={() => void doSave()}>{t('Сохранить источник')}</button>
          </div>
        </>
      )}
      {error && <span className={styles.err}>{error}</span>}
    </section>
  );
}

// ---------------------------------------------------------------- своя команда

function Command({ data, fromNew }: { data: RoutinesOverview; fromNew: boolean }) {
  const [cmd, setCmd] = useState('');
  const [title, setTitle] = useState('');
  const [map, setMap] = useState<FieldMap>(DEFAULT_MAP);
  const [mapOpen, setMapOpen] = useState(false);
  const [keys, setKeys] = useState<Array<{ name: string; value: string }>>([]);
  const [every, setEvery] = useState('5m');
  const [test, setTest] = useState<SourceTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = useSaveSource(data, fromNew);
  const min = minEveryOf(data, 'command');

  const build = () => {
    const spec = commandSpec(cmd, title, map, every);
    const names = keys.map((k) => k.name.trim()).filter(Boolean);
    const secrets = Object.fromEntries(keys.filter((k) => k.name.trim() && k.value.trim()).map((k) => [k.name.trim(), k.value.trim()]));
    return { spec: names.length ? { ...spec, secrets: names } : spec, secrets };
  };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const reset = () => setTest(null);
  return (
    <>
      <label className={styles.field}>
        <span className={styles.lbl}>{t('Команда, которая печатает список записей')}</span>
        <textarea
          className={cx(styles.inp, styles.mono)}
          rows={3}
          value={cmd}
          placeholder="gh api notifications --jq '[.[] | {id, title: .subject.title, link: .subject.url}]'"
          onChange={(e) => {
            setCmd(e.target.value);
            reset();
          }}
        />
        <span className={styles.hint}>{t('Вывод — JSON-список. У каждой записи есть id, по желанию title, text и link.')}</span>
      </label>
      <div className={styles.inline}>
        <label className={styles.inline}>
          <span className={styles.lbl}>{t('Название')}</span>
          <input className={cx(styles.inp, styles.flowSearch)} value={title} placeholder={cmd ? commandSpec(cmd, '', map, every).title : t('Своя команда')} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <EverySelect value={every} min={min} onChange={setEvery} />
      </div>
      <div>
        <button type="button" className="btn small ghost" aria-expanded={mapOpen} onClick={() => setMapOpen(!mapOpen)}>
          {mapOpen ? '▾' : '▸'} {t('Поля записи и ключи')}
        </button>
      </div>
      {mapOpen && (
        <>
          <div className={styles.mapGrid}>
            {MAP_KEYS.map((k) => (
              <label key={k} className={styles.field}>
                <span className={styles.lbl}>{mapLabel(k)}</span>
                <input
                  className={cx(styles.inp, styles.mono)}
                  value={map[k] ?? ''}
                  placeholder={k === 'items' ? t('ответ — сам список') : ''}
                  onChange={(e) => {
                    setMap({ ...map, [k]: e.target.value });
                    reset();
                  }}
                />
              </label>
            ))}
          </div>
          <span className={styles.hint}>{t('Пути через точку: data.items, meta.id. Ключи команда получает переменными окружения: $ИМЯ.')}</span>
          {keys.map((k, i) => (
            <div key={i} className={styles.inline}>
              <input className={cx(styles.inp, styles.mono, styles.flowSearch)} placeholder="API_KEY" aria-label={t('Имя ключа')} value={k.name} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))} />
              <input className={cx(styles.inp, styles.mono)} type="password" autoComplete="off" placeholder={t('Вставь ключ')} aria-label={t('Значение ключа')} value={k.value} onChange={(e) => setKeys(keys.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <button type="button" className="btn small ghost" aria-label={t('Убрать ключ')} onClick={() => setKeys(keys.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <div>
            <button type="button" className={cx(styles.slot, styles.add)} onClick={() => setKeys([...keys, { name: '', value: '' }])}>{t('+ ключ')}</button>
          </div>
        </>
      )}
      <div className="row">
        <button type="button" className="btn" disabled={busy || !cmd.trim()} onClick={() => void act(async () => setTest(await testSource(build().spec, build().secrets)))}>{t('Проверить')}</button>
        {test?.ok && <span className="ok small">{foundText(test.total, true)}</span>}
        {test && !test.ok && <span className={styles.err}>{test.error ?? t('Команда не отработала')}</span>}
      </div>
      {test?.ok && (
        <>
          <Found test={test} />
          <div className="row">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void act(() => save(build().spec, build().secrets))}>{t('Сохранить источник')}</button>
          </div>
        </>
      )}
      {error && <span className={styles.err}>{error}</span>}
    </>
  );
}
