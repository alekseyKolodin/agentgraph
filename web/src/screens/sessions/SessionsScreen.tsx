// Страница «Сессии» /sessions (system.md → Sessions): новая сессия — пространство (первым: его рабочая папка
// подставляется в «Папку» с подписью «из пространства»), папка, теги знаний, «Дополнительно» (название, модель, режим
// разрешений, состояние при выходе) и «Открыть терминал»; ниже — все сессии таблицей, живые сверху, с поиском (название,
// папка, ветка), фильтром по проекту и группами по проекту (логика — lib/session-table.ts). ?space=x — форма
// открыта с этим пространством, его рабочую папку подставит список пространств (кнопка «Новая сессия» на странице
// пространства); &cwd= — с этой папкой, её выбор пространства не затирает («Сессия в папке»); ?tags=a,b — с тегами знаний;
// ?new=1 — форма открыта («Настроить…» быстрой сессии). Выбор пространства подставляет его теги знаний и папки чтения;
// папки чтения, изменённые здесь, сохраняются в пространстве (набор как шаблон), а без пространства — заводят новое.
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionPermissionMode, SessionView } from '@server/api-types';
import { ApiError, createSpace, errorText, fetchTag, keys, saveSpace, useConfig, useFeature, useRecentDirs, useSpaces, useTags } from '../../api';
import { createSession, defaultSessionCwd, putSession, SESSION_CWD_KEY, sessionKeys, updateSessionState, useSessions } from '../../api/sessions';
import { useToast } from '../../components/Toast';
import { SpaceBadge, TagBadge } from '../../components/Badge';
import { PickDirButton } from '../../components/PickDirButton';
import { ModelPreview } from '../../components/ModelPreview';
import { SpacePicker } from '../../components/SpacePicker';
import { TagInput } from '../../components/TagInput';
import { useMemoryState } from '../../components/useMemoryState';
import { closedWork, closedWorkStore } from '../../lib/closed-work';
import { baseName, feedTime } from '../../lib/format';
import { MODELS } from '../../lib/flow/tools';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import { recentChips, TAG_SLUG_ERROR, TAG_SLUG_RE } from '../../lib/run-form';
import { askNote, canUpdateState, sessionExitTitle, sessionStatusLabel, sessionTone, termSize } from '../../lib/sessions';
import { dirLines, folderPlan, pickWorkdir, slugFor, SPACE_SLUG_RE, spaceTags, spaceWorkdir, swapSpaceTags, workdirHint, type CwdState } from '../../lib/spaces';
import { sessionTable, type SessionProject, type SessionTableGroup } from '../../lib/session-table';
import { LS } from '../../lib/storage';
import { RENAME_HOST, SessionName } from './SessionName';
import { Loading } from './Loading';
import { useContinue } from './useContinue';
import styles from './Sessions.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
/** Папка последней сессии: форма открывается с ней. */
const PERMISSION_MODES: SessionPermissionMode[] = ['auto', 'acceptEdits', 'manual', 'plan'];
const MODE_HINT: Record<SessionPermissionMode, string> = {
  auto: t('auto — Claude сам решает, что спрашивать'),
  acceptEdits: t('acceptEdits — правки файлов без вопросов'),
  manual: t('manual — спрашивать про всё'),
  plan: t('plan — только план, без правок'),
};

export function SessionsScreen() {
  const on = useFeature('sessions');
  const list = useSessions(on);
  const [params] = useSearchParams();
  const preset: Preset = {
    tags: (params.get('tags') ?? '').split(',').map((s) => s.trim()).filter((s) => TAG_SLUG_RE.test(s)),
    space: SPACE_SLUG_RE.test(params.get('space') ?? '') ? params.get('space')! : '',
    cwd: params.get('cwd') ?? '',
  };
  const sessions = list.data?.sessions ?? [];
  const [open, setOpen] = useState<boolean | null>(null);
  const formOpen = open ?? (preset.tags.length > 0 || Boolean(preset.space) || Boolean(preset.cwd) || params.get('new') === '1' || (list.isSuccess && !sessions.length));
  if (!on) {
    return (
      <div className="empty">
        <h1>{t('Сессии недоступны')}</h1>
        <p className="muted">{t('Сервер не смог загрузить терминал (node-pty): на этой системе вкладка выключена. Запуски flow работают как обычно.')}</p>
      </div>
    );
  }
  const live = sessions.filter((s) => s.live).length;
  return (
    <div className={styles.page}>
      <div className="view-head">
        <div>
          <h1>{t('Сессии')}</h1>
          <p className="muted">{t('Обычная сессия Claude Code в терминале — без flow, но в пространстве и с тегами знаний.')}</p>
        </div>
        <button type="button" className="btn" aria-expanded={formOpen} aria-controls="new-session" onClick={() => setOpen(!formOpen)}>
          {t('Новая сессия')}
        </button>
      </div>
      {formOpen && <NewSession key={`${preset.space}|${preset.cwd}|${preset.tags.join(',')}`} preset={preset} onCancel={() => setOpen(false)} full={list.data ? live >= list.data.max : false} max={list.data?.max ?? 0} />}
      <section className={styles.all} aria-label={t('Все сессии')}>
        {/* счётчик — только по ответу: при сбое «0» соврал бы, что сессий нет */}
        <h2>{t('Все сессии')} {list.data && <span className={styles.count}>{sessions.length}</span>}</h2>
        {list.error && (
          <div className="row">
            <p className="msg err">{t('Список сессий не загрузился: {error}', { error: errorText(list.error) })}</p>
            <button type="button" className="btn small" onClick={() => void list.refetch()}>{t('Повторить')}</button>
          </div>
        )}
        {sessions.length > 0 ? (
          <AllSessions sessions={sessions} />
        ) : list.isSuccess ? (
          <p className="muted small">{t('Сессий ещё не было: открой первую формой выше.')}</p>
        ) : (
          list.isPending && <Loading className="small" />
        )}
      </section>
    </div>
  );
}

type Msg = { text: string; tone: '' | 'err' };
type Preset = { tags: string[]; space: string; cwd: string };

function NewSession({ preset, onCancel, full, max }: { preset: Preset; onCancel: () => void; full: boolean; max: number }) {
  const config = useConfig().data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const recent = recentChips(useRecentDirs(useFeature('recent-dirs')).data ?? []);
  const tagList = useTags(true).data?.tags ?? [];
  const spacesOn = useFeature('spaces');
  const spacesQuery = useSpaces(spacesOn);
  const spaceList = spacesQuery.data?.spaces ?? [];
  // папка и откуда она: ссылка с &cwd= — задана сами (выбор пространства её не затирает), иначе — запомненная
  const [folder, setFolder] = useState<CwdState>(() =>
    preset.cwd ? { cwd: preset.cwd, from: '', touched: true } : { cwd: defaultSessionCwd(config?.defaultCwd), from: '', touched: false },
  );
  const cwd = folder.cwd;
  const [space, setSpace] = useState(preset.space);
  const [tags, setTags] = useState<string[]>(preset.tags);
  // папки чтения: у выбранного пространства — его (правка сохранится в нём); без пространства — заведут новое
  const [extra, setExtra] = useState('');
  const [extraTouched, setExtraTouched] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  // пространство, которое форма уже завела, а сессия потом не открылась: второй раз его не заводим
  const created = useRef('');
  const [tagText, setTagText] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<SessionPermissionMode | ''>('');
  const [saveState, setSaveState] = useState(true);
  const [msg, setMsg] = useState<Msg>({ text: '', tone: '' });
  const [busy, setBusy] = useState(false);

  const editCwd = (path: string) => setFolder({ cwd: path, from: '', touched: true });
  /**
   * Выбор пространства подставляет его рабочую папку (или папку последней работы в нём) — правило pickWorkdir: папку,
   * вписанную руками или пришедшую ссылкой (&cwd=), не трогаем — под полем появится «подставить».
   */
  const pickSpace = (slug: string) => {
    setTags((list) => swapSpaceTags(list, spaceTags(space, spaceList), spaceTags(slug, spaceList)));
    // другое пространство — его набор папок: правка прежнего ушла бы в чужое пространство
    setExtra((spaceList.find((x) => x.slug === slug.trim())?.dirs ?? []).join('\n'));
    setExtraTouched(false);
    setSpace(slug);
    setFolder((st) => pickWorkdir(slug, spaceWorkdir(slug, spaceList), st));
  };
  const applyWorkdir = (path: string) => setFolder({ cwd: path, from: space.trim(), touched: false });
  // пространство пришло ссылкой (?space=), а список ещё грузился: когда придёт — то же правило, один раз
  const presetDone = useRef(!preset.space);
  useEffect(() => {
    if (presetDone.current || !spacesQuery.isSuccess) return;
    presetDone.current = true;
    setFolder((st) => pickWorkdir(space, spaceWorkdir(space, spaceList), st));
    setTags((list) => swapSpaceTags(list, [], spaceTags(space, spaceList)));
    // папки, вписанные, пока список грузился, не затираем
    if (!extraTouched) setExtra((spaceList.find((x) => x.slug === space.trim())?.dirs ?? []).join('\n'));
  }, [spaceList]);
  const known = spaceList.find((x) => x.slug === space.trim());
  const extraDirs = dirLines(extra);
  const extraChanged = extraDirs.join('\n') !== (known?.dirs ?? []).join('\n');
  // папки чтения без пространства: их даёт сессии только пространство — набор сохранится новым
  const needSpace = !space.trim() && extraDirs.length > 0;
  const slugValue = newSlug || slugFor(baseName(cwd.trim()), spaceList.map((x) => x.slug));
  const { note: cwdNote, offer: cwdOffer, wd: workdir } = workdirHint(space, spaceList, folder);

  /** Тег знаний — только существующий: пустой из формы бесполезен, его заводят на странице «Знания». */
  const addTag = (raw: string) => {
    const slug = raw.trim();
    if (!slug) return;
    if (!TAG_SLUG_RE.test(slug)) return setMsg({ text: TAG_SLUG_ERROR, tone: 'err' });
    setTagText('');
    setMsg({ text: '', tone: '' });
    if (tags.includes(slug)) return;
    if (tagList.some((x) => x.slug === slug)) return setTags((list) => [...list, slug]);
    fetchTag(slug).then(
      () => setTags((list) => (list.includes(slug) ? list : [...list, slug])),
      (err: unknown) => setMsg({ text: err instanceof ApiError && err.status === 404 && err.code !== 'moved_to_space' ? t('Тега знаний {slug} нет: заведи его на странице «Знания»', { slug }) : errorText(err), tone: 'err' }),
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (needSpace && !SPACE_SLUG_RE.test(slugValue)) return setMsg({ text: t('Слаг пространства: строчные латинские буквы, цифры и дефис'), tone: 'err' });
    setBusy(true);
    setMsg({ text: t('Открываю терминал…'), tone: '' });
    const target = space.trim() || (needSpace ? slugValue : '');
    try {
      // набор папок — в пространство до сессии: она получит их на чтение. Новое (вписанное или из набора) — с папками
      // и рабочей папкой; существующее — только изменённые папки
      const plan = folderPlan({ target, known, dirs: extraDirs, cwd, created: created.current });
      if (plan.kind === 'create') {
        await createSpace({ slug: plan.slug, dirs: plan.dirs, ...(plan.cwd ? { cwd: plan.cwd } : {}) });
        // дальше форма — уже про него: повтор после сбоя сессии сохранит папки, а не упрётся в «слаг занят»
        created.current = plan.slug;
        setSpace(plan.slug);
        void qc.invalidateQueries({ queryKey: keys.spaces });
      } else if (plan.kind === 'save') await saveSpace(plan.slug, { dirs: plan.dirs });
      // примерный размер терминала по окну: claude перерисуется под него при подключении
      const s = await createSession({
        cwd: cwd.trim(),
        ...(target ? { space: target } : {}),
        tags,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(model ? { model } : {}),
        ...(mode ? { permissionMode: mode } : {}),
        saveState,
        ...termSize(window.innerWidth, window.innerHeight),
      });
      LS.setRaw(SESSION_CWD_KEY, s.cwd);
      qc.setQueryData(sessionKeys.one(s.id), s);
      void qc.invalidateQueries({ queryKey: sessionKeys.list, exact: true });
      // новый слаг сервер завёл пустым пространством: подсказки и страница «Пространства» — заново
      void qc.invalidateQueries({ queryKey: keys.spaces });
      void navigate(`/sessions/${s.id}`);
    } catch (err) {
      setMsg({ text: errorText(err), tone: 'err' });
      setBusy(false);
    }
  };

  return (
    <form id="new-session" className={cx('form', styles.form)} aria-label={t('Новая сессия')} onSubmit={(e) => void submit(e)}>
      <h2>{t('Новая сессия')}</h2>
      {spacesOn && <SpacePicker id="new-session-space" className={styles.tags} value={space} onChange={pickSpace} options={spaceList} loading={spacesQuery.isPending} />}
      <label>
        <span>{t('Папка')}</span>
        <div className="path-field">
          <input name="cwd" placeholder="/path/to/repo" value={cwd} onChange={(e) => editCwd(e.target.value)} />
          <PickDirButton prompt={t('Папка сессии Claude')} start={() => cwd} onPick={editCwd} />
        </div>
      </label>
      {cwdNote && <span className={cx('muted small', styles.cwdFrom)} title={workdir?.path}>{cwdNote}</span>}
      {cwdOffer && (
        <span className={cx('muted small', styles.cwdFrom)}>
          {t('Рабочая папка пространства: {path}', { path: cwdOffer.path })}{' '}
          <button type="button" className="btn small ghost" onClick={() => applyWorkdir(cwdOffer.path)}>{t('подставить')}</button>
        </span>
      )}
      {recent.length > 0 && (
        <div className={cx('chips', styles.recent)}>
          <span className="muted small">{t('Недавние:')}</span>
          {recent.map((d) => (
            <button key={d.path} type="button" className={cx('chip', d.path === cwd.trim() && 'on')} title={d.path} onClick={() => editCwd(d.path)}>{d.label}</button>
          ))}
        </div>
      )}
      {spacesOn && (
        <div className={styles.extra}>
          <label htmlFor="new-session-dirs" className="field-label" title={t('Репозитории и папки, которые Claude получит на чтение: они хранятся в пространстве и подставятся в следующий раз')}>{t('Ещё папки (чтение)')}</label>
          <PickDirButton
            className="btn small pick-dir"
            prompt={t('Папка на чтение')}
            title={t('Выбрать папку в Finder — путь добавится новой строкой')}
            start={() => extraDirs.at(-1) ?? cwd}
            onPick={(p) => {
              setExtraTouched(true);
              if (!extraDirs.includes(p)) setExtra([...extraDirs, p].join('\n'));
            }}
          >{t('+ Добавить папку…')}</PickDirButton>
          <textarea
            id="new-session-dirs"
            rows={Math.min(5, Math.max(1, extraDirs.length))}
            spellCheck={false}
            placeholder="/Users/me/code/api"
            value={extra}
            onChange={(e) => {
              setExtraTouched(true);
              setExtra(e.target.value);
            }}
          />
          {known && extraChanged && <span className="muted small">{t('Набор сохранится в пространстве {slug}: в следующий раз папки подставятся сами', { slug: known.slug })}</span>}
          {!known && space.trim() && extraDirs.length > 0 && <span className="muted small">{t('Новое пространство {slug} заведётся с этим набором папок', { slug: space.trim() })}</span>}
          {needSpace && (
            <label className={styles.saveAs}>
              <span className="muted small">{t('Папки чтения хранит пространство — набор сохранится как новое:')}</span>
              <input aria-label={t('Слаг нового пространства')} className="mono" value={slugValue} onChange={(e) => setNewSlug(e.target.value.trim())} />
            </label>
          )}
        </div>
      )}
      <div className={styles.tags}>
        <TagInput
          label={t('Теги знаний')}
          listId="new-session-tags"
          options={tagList.filter((x) => !tags.includes(x.slug))}
          placeholder={t('правила для этой работы: выбери тег знаний и нажми Enter')}
          text={tagText}
          onText={setTagText}
          onAdd={addTag}
          tags={tags}
          kindOf={() => 'knowledge'}
          onRemove={(slug) => setTags((list) => list.filter((x) => x !== slug))}
          removeTitle={t('Убрать тег')}
        />
        <p className="muted small">{t('Строка каждого тега — в контексте, полный текст Claude возьмёт инструментом knowledge_read. Можно и без тегов.')}</p>
      </div>
      <ModelPreview space={space} tags={tags} where="session" cwd={cwd} options={spaceList} loaded={!spacesOn || !spacesQuery.isPending} />
      <details className={styles.more}>
        <summary>{t('Дополнительно')}</summary>
        <div className={styles.moreBody}>
          <label>
            <span>{t('Название')}</span>
            <input name="name" placeholder={[space.trim(), ...tags].filter(Boolean).join(' · ') || baseName(cwd) || t('по пространству или папке')} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>{t('Модель')}</span>
            <select name="model" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map(([id, label]) => <option key={id} value={id}>{id ? label : t('По умолчанию — из настроек Claude')}</option>)}
            </select>
          </label>
          <label>
            <span>{t('Режим разрешений')}</span>
            <select name="permissionMode" value={mode} title={mode ? MODE_HINT[mode] : ''} onChange={(e) => setMode(e.target.value as SessionPermissionMode | '')}>
              <option value="">{t('По умолчанию — из настроек Claude')}</option>
              {PERMISSION_MODES.map((m) => <option key={m} value={m} title={MODE_HINT[m]}>{m}</option>)}
            </select>
          </label>
        </div>
        <label className={styles.check}>
          <input type="checkbox" checked={saveState} onChange={(e) => setSaveState(e.target.checked)} />
          <span>
            <span>{t('Обновлять состояние пространства при выходе')}</span>
            <span className="muted small">{t('Короткая сессия haiku перепишет «где мы сейчас» по ходам этой сессии, как после запуска flow. Можно и вручную — кнопкой в сессии.')}</span>
          </span>
        </label>
      </details>
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy || full} title={full ? t('Живых сессий уже {n}: заверши одну из них', { n: max }) : ''}>
          <span className={styles.prompt} aria-hidden="true">›_</span>{t('Открыть терминал')}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>{t('Отмена')}</button>
        {msg.text && <span className={cx('msg', msg.tone)}>{msg.text}</span>}
      </div>
    </form>
  );
}

/**
 * Поиск, фильтр и группы над таблицей. Фильтр по проекту и «по проектам» запоминаются, запрос — пока открыта вкладка.
 * Сессии закрытых дел (closed-work.ts) уходят с глаз со строкой «убрано N · показать».
 */
function AllSessions({ sessions }: { sessions: SessionView[] }) {
  useSyncExternalStore(closedWorkStore.subscribe, closedWorkStore.version);
  const [query, setQuery] = useMemoryState('sessions.query', '');
  const [project, setProjectState] = useState<SessionProject>(() => LS.get<SessionProject>('agentgraph.sessionsProject', null));
  const [grouped, setGroupedState] = useState(() => LS.get('agentgraph.sessionsGrouped', true));
  const [showClosed, setShowClosed] = useMemoryState('sessions.showClosed', false);
  const setProject = (v: SessionProject) => {
    setProjectState(v);
    LS.set('agentgraph.sessionsProject', v);
  };
  const setGrouped = (v: boolean) => {
    setGroupedState(v);
    LS.set('agentgraph.sessionsGrouped', v);
  };
  const view = sessionTable(sessions, { query, project, grouped, closed: closedWork().session, showClosed });
  // значение select: '*' — все проекты, '-' — без проекта, иначе слаг
  const selValue = project === null ? '*' : project === '' ? '-' : project;
  const total = view.projects.reduce((n, p) => n + p.count, 0);
  return (
    <>
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          aria-label={t('Найти сессию')}
          placeholder={t('Найти сессию…')}
          autoComplete="off"
          spellCheck={false}
          title={t('Все слова должны найтись в названии, папке, ветке, проекте, тегах или id сессии. Esc — очистить')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || !query) return;
            e.preventDefault();
            setQuery('');
          }}
        />
        {/* проектов один — выбирать не из чего, но выбранный раньше фильтр должен сниматься */}
        {(view.projects.length > 1 || project !== null) && (
          <select
            className={styles.projectPick}
            aria-label={t('Проект')}
            title={t('Показать сессии одного проекта — пространства, как у запусков')}
            value={selValue}
            onChange={(e) => setProject(e.target.value === '*' ? null : e.target.value === '-' ? '' : e.target.value)}
          >
            <option value="*">{t('Все проекты')} · {total}</option>
            {view.projects.map((p) => <option key={p.space || '-'} value={p.space || '-'}>{p.label} · {p.count}</option>)}
          </select>
        )}
        {project === null && view.projects.length > 1 && (
          <button
            type="button"
            className={cx('chip', grouped && 'on')}
            aria-pressed={grouped}
            title={t('Группировать сессии по проекту — пространству, как запуски')}
            onClick={() => setGrouped(!grouped)}
          >
            {t('по проектам')}
          </button>
        )}
        {(query || project !== null) && <span className={cx('muted small', styles.found)}>{t('показано {n} из {total}', { n: view.shown, total: sessions.length })}</span>}
      </div>
      {view.groups.length > 0 ? <SessionTable groups={view.groups} /> : <p className="muted small">{view.empty}</p>}
      {view.closedCount > 0 && (
        <button type="button" className={cx('link-btn', styles.closedToggle)} onClick={() => setShowClosed(!showClosed)}>
          {showClosed ? t('убрать сессии закрытых дел') : t('показать сессии закрытых дел: {n}', { n: view.closedCount })}
        </button>
      )}
    </>
  );
}

function SessionTable({ groups }: { groups: SessionTableGroup<SessionView>[] }) {
  const home = useConfig().data?.home;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  // «Продолжить» при пределе живых сессий — диалог «кого завершить»; закрыли его — undefined, никуда не переходим
  const cont = useContinue();
  const run = async (id: string, fn: () => Promise<SessionView | undefined>, open: boolean) => {
    setBusy(id);
    try {
      const v = await fn();
      if (!v) return;
      putSession(qc, v);
      if (open) void navigate(`/sessions/${id}`);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy('');
    }
  };
  // ширины колонок задаёт строка заголовка (table-layout: fixed): действие — своей колонкой постоянной ширины, папка
  // режется многоточием; узкой таблице папка уходит строкой под имя, а «Ходов» прячется (Sessions.module.css)
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.colStatus}>{t('Статус')}</th>
            <th scope="col">{t('Название')}</th>
            <th scope="col" className={styles.colTags}>{t('Пространство и теги')}</th>
            <th scope="col" className={styles.colDir}>{t('Папка')}</th>
            <th scope="col" className={cx(styles.num, styles.colNum)}>{t('Ходов')}</th>
            <th scope="col" className={styles.colWhen}>{t('Активность')}</th>
            <th scope="col" className={styles.colAct}><span className={styles.sr}>{t('Действия')}</span></th>
          </tr>
        </thead>
        {groups.map((g) => (
        <tbody key={g.key}>
          {/* подпись группы — строкой таблицы: ширины колонок общие для всех проектов. Ячейки — по колонкам: объединённая
              ячейка поверх колонок, которые узкая таблица прячет, сбила бы их ширины */}
          {g.label && (
            <tr className={styles.groupRow}>
              <th scope="rowgroup" colSpan={3} title={g.title}>
                {g.space ? <Link to={`/spaces/${encodeURIComponent(g.space)}`}>{g.label}</Link> : g.label}
                <span className={styles.count}>{g.sessions.length}</span>
              </th>
              <td className={styles.colDir} />
              <td className={styles.colNum} />
              <td className={styles.colWhen} />
              <td />
            </tr>
          )}
          {g.sessions.map((s) => {
            const update = canUpdateState(s);
            const dir = tildePath(s.cwd, home);
            const ask = askNote(s);
            return (
              <tr key={s.id} className={cx(!s.live && styles.ended, RENAME_HOST)}>
                <td><span className={cx(styles.status, styles[sessionTone(s)])} title={sessionExitTitle(s) || undefined}><span className={styles.dot} aria-hidden="true" /><span className={styles.statusText}>{sessionStatusLabel(s)}</span></span></td>
                <td className={styles.name}>
                  <SessionName s={s} to={`/sessions/${s.id}`} title={s.name} />
                  {/* имя по умолчанию — та же папка: второй строкой её не повторяем */}
                  {(baseName(s.cwd) !== s.name || s.branch) && <span className={styles.nameDir} title={dir}>{[baseName(s.cwd) !== s.name && baseName(s.cwd), s.branch].filter(Boolean).join(' · ')}</span>}
                  {/* на чём остановилась: живая спрашивает, завершённая — закончилась на вопросе (видно и после перезапуска) */}
                  {ask && <span className={styles.ask} title={ask}>{ask}</span>}
                  {/* пометка и её действие — рядом: «Обновить состояние» нужно только такой сессии */}
                  {s.statePending && (
                    <span className={styles.pending}>
                      {t('состояние не обновлено: приложение закрыли')}
                      {update.ok && (
                        <button type="button" className="btn small" disabled={busy === s.id} title={update.why} onClick={() => void run(s.id, () => updateSessionState(s.id), false)}>
                          {t('Обновить состояние')}
                        </button>
                      )}
                    </span>
                  )}
                </td>
                <td>
                  <span className={styles.tagList}>
                    {s.space && <SpaceBadge slug={s.space} link />}
                    {s.chips.filter((c) => c.state !== 'removed').map((c) => <TagBadge key={c.slug} slug={c.slug} kind="knowledge" />)}
                  </span>
                </td>
                <td className={cx(styles.dir, styles.colDir)} title={[dir, s.branch && t('ветка {branch}', { branch: s.branch })].filter(Boolean).join('\n')}>
                  {baseName(s.cwd)}
                  {s.branch && <span className={styles.branch}>{s.branch}</span>}
                </td>
                <td className={cx(styles.num, styles.colNum)}>{s.turns}</td>
                <td className={cx(styles.when, styles.colWhen)}>{s.status === 'working' ? t('сейчас') : feedTime(s.lastActivityAt)}</td>
                <td className={styles.act}>
                  {s.live ? (
                    <Link to={`/sessions/${s.id}`}>{t('Открыть')}</Link>
                  ) : (
                    <button type="button" className="btn small" disabled={busy === s.id} title={s.resumable ? t('Тот же разговор (claude --resume) с текущими пространством и тегами') : t('Новый разговор в той же папке')} onClick={() => void run(s.id, () => cont.resume(s.id), true)}>
                      {t('Продолжить')}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        ))}
      </table>
      {cont.dialog}
    </div>
  );
}
