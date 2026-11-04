// Страница «Пространства» (/spaces, /spaces/<slug>): фича или проект, над которыми идут сессии и запуски. Слева —
// список с поиском и новым пространством над ним; справа — пространство: шапка с действиями (новая сессия, сессия в
// папке пространства, удалить), вкладки «Карта» (CLAUDE.md), «Состояние» (STATE.md), «Документы», «Контекст» (что
// уходит модели) и «Настройки» (заголовок, папки); сессии и запуски пространства — колонкой справа или ниже.
// Каждое открытие страницы (переход, в том числе на тот же адрес) перечитывает список и пространство с сервера.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, matchPath, useBlocker, useLocation, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SpaceDetail, SpaceDoc } from '@server/api-types';
import {
  addSpaceDoc, api, ApiError, createSpace, deleteSpace, deleteSpaceDoc, errorText, fetchSpace, fetchSpaceContext, fetchSpaceDoc, keys, saveSpace, saveSpaceDoc, useConfig,
  useFeature, useSpaces,
} from '../../api';
import { Badge } from '../../components/Badge';
import { useConfirm } from '../../components/ConfirmDialog';
import { PickDirButton } from '../../components/PickDirButton';
import { readBase64 } from '../../components/readBase64';
import { useToast } from '../../components/Toast';
import { useMemoryState } from '../../components/useMemoryState';
import { feedTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import {
  dirLines, docLine, fieldCount, filterSpaces, itemsCount, MAP_PLACEHOLDER, newSpaceBody, SPACE_DIRTY_TEXT, SPACE_MAP_WARN, SPACE_SLUG_RE, SPACE_STATE_MAX, spaceDeleteText,
  spaceFormOf, spaceItems, spaceLabel, spaceMetaLine, spacePatch, spacePreview, spacesNoneText, spaceSnapshot, stateByText, type SpaceForm,
} from '../../lib/spaces';
import styles from './Spaces.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

type Msg = { cls: string; text: string };
const NO_MSG: Msg = { cls: 'msg', text: '' };
const EMPTY_FORM: SpaceForm = { title: '', map: '', state: '', dirs: '', cwd: '' };
type NewSpace = { open: boolean; slug: string; title: string; gist: string; dirs: string; cwd?: string };
const NEW_CLOSED: NewSpace = { open: false, slug: '', title: '', gist: '', dirs: '', cwd: '' };
type Tab = 'map' | 'state' | 'docs' | 'context' | 'settings';
const TABS: [Tab, string][] = [['map', t('Карта')], ['state', t('Состояние')], ['docs', t('Документы')], ['context', t('Контекст')], ['settings', t('Настройки')]];

const spacePath = (slug?: string) => (slug ? `/spaces/${encodeURIComponent(slug)}` : '/spaces');

export function SpacesScreen() {
  const { slug } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { askConfirm } = useConfirm();
  const sessionsOn = useFeature('sessions');
  const spacesQuery = useSpaces(true);

  // как у «Знаний»: поиск, форма нового и вкладка переживают уход с экрана и возврат
  const [query, setQuery] = useMemoryState('spaces.search', '');
  const [ns, setNs] = useMemoryState<NewSpace>('spaces.new', NEW_CLOSED);
  const [tab, setTab] = useMemoryState<Tab>('spaces.tab', 'map');
  const [newMsg, setNewMsg] = useState<Msg>(NO_MSG);
  const [focusNew, setFocusNew] = useState(0);
  const slugInput = useRef<HTMLInputElement>(null);

  /** Открытое пространство с сервера, поля формы и снимок полей на момент загрузки/сохранения. */
  const [space, setSpace] = useState<SpaceDetail | null>(null);
  const [form, setForm] = useState<SpaceForm>(EMPTY_FORM);
  const [saved, setSaved] = useState('');
  const [msg, setMsg] = useState<Msg>(NO_MSG);
  const [conflict, setConflict] = useState(false);
  const [editorErr, setEditorErr] = useState('');
  const seq = useRef(0);

  const cur = useRef({ space, form, saved });
  cur.current = { space, form, saved };
  /** Во вкладке «Документы» открыт документ с несохранённым текстом: уход со страницы и на другое пространство спросит. */
  const docDirty = useRef(false);
  const dirtyNow = () => Boolean(cur.current.space) && (spaceSnapshot(cur.current.form) !== cur.current.saved || docDirty.current);
  const dirty = Boolean(space) && spaceSnapshot(form) !== saved;

  const listErr = spacesQuery.isError ? errorText(spacesQuery.error) : '';
  const loaded = spacesQuery.isError || spacesQuery.data !== undefined;
  const list = spacesQuery.isError ? [] : spacesQuery.data?.spaces ?? [];
  const { shown, count } = filterSpaces(list, query);

  // уход на другое пространство или к списку с несохранёнными правками — спросить
  const blocker = useBlocker(({ nextLocation }) => {
    if (!dirtyNow()) return false;
    const m = matchPath('/spaces/:slug?', nextLocation.pathname);
    return !m || m.params.slug !== cur.current.space!.slug;
  });
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void askConfirm(SPACE_DIRTY_TEXT, { ok: t('Перейти') }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker.state]);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyNow()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  /** Пространство с сервера в форму и снимок полей: по нему — «есть несохранённое». */
  const fill = (s: SpaceDetail) => {
    const f = spaceFormOf(s);
    const snap = spaceSnapshot(f);
    cur.current = { space: s, form: f, saved: snap };
    setSpace(s);
    setForm(f);
    setSaved(snap);
    setConflict(false);
  };

  const load = (target: string, my = ++seq.current) =>
    fetchSpace(target).then(
      (s) => {
        if (my === seq.current) fill(s);
      },
      (err) => {
        if (my !== seq.current) return;
        cur.current = { ...cur.current, space: null };
        setSpace(null);
        setEditorErr(err instanceof ApiError && err.status === 404 ? t('Пространства {slug} нет', { slug: target }) : errorText(err));
      },
    );

  // открытие страницы: список и пространство перечитываются при каждом переходе (location.key)
  useEffect(() => {
    setEditorErr('');
    void spacesQuery.refetch({ cancelRefetch: false });
    if (!slug) {
      seq.current++;
      cur.current = { ...cur.current, space: null };
      setSpace(null);
      return;
    }
    setMsg(NO_MSG);
    void load(slug);
  }, [location.key]);

  const setNewOpen = (open: boolean) => {
    if (open) {
      setNs((v) => ({ ...v, open: true }));
      setFocusNew((n) => n + 1);
    } else {
      setNs(NEW_CLOSED);
      setNewMsg(NO_MSG);
    }
  };
  useEffect(() => {
    if (focusNew) slugInput.current?.focus();
  }, [focusNew]);
  // без пространств форма открывается сама — после каждой загрузки списка
  useEffect(() => {
    if (spacesQuery.data && !spacesQuery.isError && !spacesQuery.data.spaces.length && !ns.open) setNewOpen(true);
  }, [spacesQuery.dataUpdatedAt]);

  const go = (s?: string) => {
    const path = spacePath(s);
    navigate(path, { replace: path === location.pathname });
  };

  const create = async (ev: FormEvent) => {
    ev.preventDefault();
    setNewMsg(NO_MSG);
    const body = newSpaceBody(ns.slug, ns.title, ns.gist, ns.dirs, ns.cwd ?? '');
    if (!body) return;
    if (!SPACE_SLUG_RE.test(body.slug)) return setNewMsg({ cls: 'msg err', text: t('Слаг пространства: строчные латинские буквы, цифры и дефис') });
    // занятый слаг: суть и папки молча не пропадут — сервер ответит 409, а здесь скажем сразу
    if (list.some((x) => x.slug === body.slug)) return setNewMsg({ cls: 'msg err', text: t('Пространство {slug} уже есть: открой его в списке', { slug: body.slug }) });
    try {
      await createSpace(body);
      setNewOpen(false);
      void qc.invalidateQueries({ queryKey: keys.spaces });
      go(body.slug);
    } catch (err) {
      setNewMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  const save = async (ev?: FormEvent) => {
    ev?.preventDefault();
    const s = cur.current.space;
    if (!s) return;
    const patch = spacePatch(cur.current.form, s);
    if (!Object.keys(patch).length) return;
    setMsg({ cls: 'msg', text: t('Сохраняю…') });
    const my = seq.current;
    try {
      await saveSpace(s.slug, patch);
      if (my !== seq.current) return;
      await load(s.slug, my);
      setMsg({ cls: 'msg', text: t('Сохранено') });
      void qc.invalidateQueries({ queryKey: keys.spaces });
    } catch (err) {
      if (my !== seq.current) return;
      setConflict(err instanceof ApiError && err.status === 409);
      setMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  /** Конфликт: карту или состояние переписали снаружи — взять версию с диска (правка пропадёт). */
  const reload = async () => {
    const s = cur.current.space;
    if (!s) return;
    if (dirtyNow() && !(await askConfirm(t('Взять версию с диска? Твои несохранённые правки пропадут.'), { ok: t('Перечитать') }))) return;
    setMsg(NO_MSG);
    await load(s.slug);
  };

  const remove = async () => {
    const s = cur.current.space;
    if (!s) return;
    if (!(await askConfirm(spaceDeleteText(s.slug), { ok: t('Удалить'), danger: true }))) return;
    try {
      await deleteSpace(s.slug);
      cur.current = { ...cur.current, space: null };
      setSpace(null);
      void qc.invalidateQueries({ queryKey: keys.spaces });
      go();
    } catch (err) {
      setMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  const edit = (field: keyof SpaceForm, value: string) => setForm((f) => ({ ...f, [field]: value }));
  const spacesMsg = editorErr || listErr;

  return (
    <div className={styles.viewSpaces}>
      <header className="view-head">
        <div>
          <h1>{t('Пространства')}</h1>
          <p className="muted">{t('Фича или проект, над которыми идут сессии и запуски: своя карта (CLAUDE.md), документы и состояние «где мы сейчас». Выбери пространство при старте сессии или запуска — агент получит карту памятью, как CLAUDE.md репозитория')}</p>
        </div>
      </header>
      <div className={styles.layout}>
        <aside className={styles.side}>
          <div className={styles.sideHead}>
            <h3>{t('Все пространства')} <span className={styles.count}>{loaded ? count : ''}</span></h3>
            <button type="button" className={cx('btn small', ns.open && styles.on)} aria-expanded={ns.open} aria-controls="space-new" onClick={() => setNewOpen(!ns.open)}>
              {t('+ Новое пространство')}
            </button>
          </div>
          <form id="space-new" className={cx('form', styles.newForm)} hidden={!ns.open} onSubmit={(e) => void create(e)} onKeyDown={(e) => { if (e.key === 'Escape') setNewOpen(false); }}>
            <div className={styles.newRow}>
              <label>
                <span>{t('Слаг')}</span>
                <input
                  ref={slugInput}
                  name="slug"
                  placeholder="press-alert"
                  autoComplete="off"
                  spellCheck={false}
                  pattern="[a-z0-9][a-z0-9\-]{0,63}"
                  title={t('Строчные латинские буквы, цифры и дефис')}
                  required
                  value={ns.slug}
                  onChange={(e) => setNs((v) => ({ ...v, slug: e.target.value }))}
                />
              </label>
              <label>
                <span>{t('Заголовок')}</span>
                <input name="title" placeholder={t('Пуш-тревога')} autoComplete="off" value={ns.title} onChange={(e) => setNs((v) => ({ ...v, title: e.target.value }))} />
              </label>
            </div>
            <label>
              <span title={t('Одна строка в начале карты: что за фича и зачем. Карту дополнишь после создания')}>{t('Суть')}</span>
              <input name="gist" placeholder={t('Пуш о тревоге на Android и iOS, бэкенд отправки')} autoComplete="off" value={ns.gist} onChange={(e) => setNs((v) => ({ ...v, gist: e.target.value }))} />
            </label>
            <label>
              <span title={t('Где идёт работа: её подставят формы сессии и запуска при выборе пространства. Можно не задавать — тогда подставится папка последней сессии или запуска в нём')}>{t('Рабочая папка')}</span>
              <div className="path-field">
                <input name="cwd" placeholder="/Users/me/code/android" autoComplete="off" spellCheck={false} value={ns.cwd ?? ''} onChange={(e) => setNs((v) => ({ ...v, cwd: e.target.value }))} />
                <PickDirButton prompt={t('Рабочая папка пространства')} start={() => ns.cwd ?? ''} onPick={(p) => setNs((v) => ({ ...v, cwd: p }))} />
              </div>
            </label>
            <div className={styles.dirs}>
              <label htmlFor="space-new-dirs" className="field-label" title={t('Репозитории и папки фичи, по одному на строку: сессии и этапы получат их на чтение, а карта — список «Где что»')}>{t('Папки')}</label>
              <PickDirButton
                className="btn small pick-dir"
                prompt={t('Выбери папку пространства')}
                title={t('Выбрать папку в Finder — путь добавится новой строкой')}
                start={() => dirLines(ns.dirs).at(-1) ?? ''}
                onPick={(p) => setNs((v) => (dirLines(v.dirs).includes(p) ? v : { ...v, dirs: [...dirLines(v.dirs), p].join('\n') }))}
              >{t('+ Добавить папку…')}</PickDirButton>
              <textarea id="space-new-dirs" name="dirs" rows={2} spellCheck={false} placeholder="/Users/me/code/android" value={ns.dirs} onChange={(e) => setNs((v) => ({ ...v, dirs: e.target.value }))} />
            </div>
            <div className="row">
              <button type="submit" className="btn">{t('Завести пространство')}</button>
              <button type="button" className="btn ghost" onClick={() => setNewOpen(false)}>{t('Отмена')}</button>
              <span className={newMsg.cls}>{newMsg.text}</span>
            </div>
          </form>
          <p className={cx('msg err', styles.listMsg)}>{spacesMsg}</p>
          <input
            className={styles.search}
            type="search"
            placeholder={t('Поиск: слаг, заголовок, состояние')}
            autoComplete="off"
            spellCheck={false}
            title={t('Все слова должны найтись в слаге, заголовке или начале состояния. Esc — очистить')}
            hidden={loaded && !list.length}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) setQuery(''); }}
          />
          <ul className={styles.list}>
            {loaded && (shown.length
              ? shown.map((s) => (
                <li key={s.slug} className={cx(s.slug === space?.slug && styles.active)} onClick={() => go(s.slug)}>
                  <span className={styles.name}><span className={styles.slugMark}>◇</span>{spaceLabel(s)}{s.title && <span className={styles.slugSub}>{s.slug}</span>}</span>
                  <span className={cx(styles.sub, styles.preview)}>{spacePreview(s)}</span>
                  <span className={cx(styles.sub, styles.meta)}>{spaceMetaLine(s)}{s.migratedFrom ? ` · ${t('из тега задачи')}` : ''}</span>
                </li>
              ))
              : <li className={cx(styles.none, 'muted small')}>{spacesNoneText(list.length)}</li>)}
          </ul>
        </aside>
        <div className={styles.main}>
          {space ? (
            <SpaceEditor
              space={space}
              form={form}
              tab={tab}
              setTab={setTab}
              edit={edit}
              dirty={dirty}
              msg={msg}
              conflict={conflict}
              sessionsOn={sessionsOn}
              onSave={() => void save()}
              onReload={() => void reload()}
              onRemove={() => void remove()}
              onDocs={(docs) => setSpace((s) => (s ? { ...s, docs } : s))}
              onDocDirty={(d) => (docDirty.current = d)}
            />
          ) : (
            <p className={cx(styles.empty, 'muted')}>{t('Выбери пространство в списке — откроются его карта, состояние, документы и все его сессии и запуски. Новое — кнопкой «+ Новое пространство»; его можно вписать и прямо в форме сессии или запуска.')}</p>
          )}
        </div>
      </div>
    </div>
  );
}

type EditorProps = {
  space: SpaceDetail;
  form: SpaceForm;
  tab: Tab;
  setTab: (t: Tab) => void;
  edit: (field: keyof SpaceForm, value: string) => void;
  dirty: boolean;
  msg: Msg;
  conflict: boolean;
  sessionsOn: boolean;
  onSave: () => void;
  onReload: () => void;
  onRemove: () => void;
  onDocs: (docs: SpaceDoc[]) => void;
  onDocDirty: (dirty: boolean) => void;
};

function SpaceEditor({ space: s, form, tab, setTab, edit, dirty, msg, conflict, sessionsOn, onSave, onReload, onRemove, onDocs, onDocDirty }: EditorProps) {
  const home = useConfig().data?.home;
  const reveal = useFeature('reveal');
  const toast = useToast();
  const items = spaceItems(s.sessions, s.runs);
  const mapLong = form.map.length > SPACE_MAP_WARN;
  // папка «Новой сессии»: рабочая папка пространства, иначе папка его последней сессии или запуска (считает сервер;
  // «Сессия в папке» пространства не в счёт)
  const workdir = s.workdir;
  return (
    <div className={styles.editorGrid}>
      <section className={cx('panel', styles.editor)}>
        {/* не <form>: во вкладке «Документы» своя форма нового документа, а вложенные формы браузер отправил бы сам */}
        <div
          className={cx('form', styles.editorForm)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault();
              onSave();
            }
          }}
        >
          <div className={styles.head}>
            <div className={styles.titles}>
              <h2>{s.title || s.slug}</h2>
              <div className={styles.headMeta}>
                <span className="mono">{s.slug}</span>
                {reveal ? (
                  <button type="button" className={styles.dirBtn} title={t('Показать в Finder: {path}', { path: s.dir })} onClick={() => void api('POST', '/api/reveal', { path: s.dir }).catch((err: unknown) => toast(errorText(err)))}>
                    {tildePath(s.dir, home)}
                  </button>
                ) : <span className="mono" title={s.dir}>{tildePath(s.dir, home)}</span>}
                {s.migratedFrom && <span title={t('Перенесено из тега задачи {tag}: его папка осталась на месте', { tag: s.migratedFrom.tag })}>{t('из тега задачи')}</span>}
              </div>
            </div>
            <span className="row push">
              {sessionsOn && (
                <>
                  <Link
                    className="btn small"
                    to={`/sessions?space=${encodeURIComponent(s.slug)}${workdir ? `&cwd=${encodeURIComponent(workdir.path)}` : ''}`}
                    title={t('Новая сессия Claude Code в терминале в этом пространстве: карта — памятью, состояние и документы — в контексте') + (workdir ? `\n${t('Папка: {path}', { path: workdir.path })}` : '')}
                  >{t('Новая сессия')}</Link>
                  <Link className="btn small ghost" to={`/sessions?space=${encodeURIComponent(s.slug)}&cwd=${encodeURIComponent(s.dir)}`} title={t('Сессия в самой папке пространства: Claude правит карту и документы как обычный проект, ты подтверждаешь правки')}>{t('Сессия в папке')}</Link>
                </>
              )}
              <button type="button" className="btn small ghost danger" onClick={onRemove}>{t('Удалить')}</button>
              <button type="button" className="btn primary" disabled={!dirty} title={t('Сохранить карту, состояние и настройки (⌘S)')} onClick={onSave}>{t('Сохранить')}</button>
            </span>
          </div>
          {(msg.text || conflict) && (
            <div className={styles.msgRow}>
              <span className={msg.cls}>{msg.text}</span>
              {conflict && <button type="button" className="btn small" onClick={onReload}>{t('Перечитать с диска')}</button>}
            </div>
          )}
          <div className="tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={cx('tab', tab === id && 'active')} onClick={() => setTab(id)}>
                {label}
                {id === 'docs' && s.docs.length > 0 && <span className={styles.tabCount}>{s.docs.length}</span>}
              </button>
            ))}
          </div>
          {tab === 'map' && (
            <div className={styles.tabBody}>
              <p className={cx('muted small', styles.hint)}>{t('CLAUDE.md пространства — карта: суть, где что, куда за чем ходить, договорённости. Claude Code загружает её памятью в каждую сессию и этап пространства, как CLAUDE.md репозитория. Держи её короткой: подробности — в документы, их агент откроет сам')}</p>
              <textarea name="map" className={styles.mono} rows={18} spellCheck={false} placeholder={MAP_PLACEHOLDER} value={form.map} onChange={(e) => edit('map', e.target.value)} />
              <div className={styles.fieldFoot}>
                <span className={cx('small', mapLong ? 'warn' : 'muted')}>{mapLong ? t('Карта длинная: она уходит в каждый запрос модели — вынеси подробности в документы') : t('Карту правишь ты; агент её не меняет — только сессия в папке пространства с твоим подтверждением')}</span>
                <span className="muted small mono">{fieldCount(form.map)}</span>
              </div>
            </div>
          )}
          {tab === 'state' && (
            <div className={styles.tabBody}>
              <p className={cx('muted small', styles.hint)}>{stateByText(s)}</p>
              <textarea name="state" className={styles.mono} rows={14} spellCheck={false} placeholder={t('Суть · Где код · Ключевые решения · Что осталось · Где читать подробнее')} value={form.state} onChange={(e) => edit('state', e.target.value)} />
              <div className={styles.fieldFoot}>
                <span className={cx('small', form.state.length > SPACE_STATE_MAX ? 'warn' : 'muted')}>
                  {form.state.length > SPACE_STATE_MAX
                    ? t('Длиннее {n} знаков — обрежется при сохранении', { n: SPACE_STATE_MAX })
                    : t('«Где мы сейчас»: его переписывает короткая сессия после сессии терминала и запуска «готово» в пространстве; правка руками доживёт до следующей такой записи. Модели оно идёт как данные, а не как инструкции')}
                </span>
                <span className="muted small mono">{fieldCount(form.state)}</span>
              </div>
            </div>
          )}
          <DocsTab key={s.slug} space={s} onDocs={onDocs} onDirty={onDocDirty} hidden={tab !== 'docs'} />
          {tab === 'context' && <ContextTab slug={s.slug} version={`${s.updatedAt}|${s.mapMtimeMs ?? 0}|${s.stateMtimeMs ?? 0}`} />}
          {tab === 'settings' && (
            <div className={styles.tabBody}>
              <label><span>{t('Заголовок')}</span><input name="title" autoComplete="off" value={form.title} onChange={(e) => edit('title', e.target.value)} /></label>
              <label>
                <span title={t('Где идёт работа: её подставят формы сессии и запуска при выборе пространства. Пусто — папка последней сессии или запуска в нём')}>{t('Рабочая папка')}</span>
                <div className="path-field">
                  <input name="cwd" autoComplete="off" spellCheck={false} placeholder={workdir && workdir.from !== 'space' ? workdir.path : '/Users/me/code/android'} value={form.cwd} onChange={(e) => edit('cwd', e.target.value)} />
                  <PickDirButton prompt={t('Рабочая папка пространства')} start={() => form.cwd} onPick={(p) => edit('cwd', p)} />
                </div>
                <span className="muted small">{form.cwd.trim() ? t('Формы сессии и запуска подставят её при выборе пространства') : workdir ? t('Не задана: формы подставят папку последней работы — {path}', { path: tildePath(workdir.path, home) }) : t('Не задана, работы в пространстве ещё не было: формы оставят свою папку')}</span>
              </label>
              <div className={styles.dirs}>
                <label htmlFor="space-dirs" className="field-label" title={t('Абсолютные пути к папкам или файлам, по одному на строку: сессии и этапы пространства получат их на чтение (--add-dir с запретом записи; в запуске — доп. директориями). Несуществующие пропускаются')}>{t('Папки (только чтение)')}</label>
                <PickDirButton
                  className="btn small pick-dir"
                  prompt={t('Выбери папку пространства')}
                  title={t('Выбрать папку в Finder — путь добавится новой строкой')}
                  start={() => dirLines(form.dirs).at(-1) ?? ''}
                  onPick={(p) => {
                    const lines = dirLines(form.dirs);
                    if (!lines.includes(p)) edit('dirs', [...lines, p].join('\n'));
                  }}
                >{t('+ Добавить папку…')}</PickDirButton>
                <textarea id="space-dirs" name="dirs" rows={4} className={styles.mono} spellCheck={false} placeholder="/Users/me/code/api" value={form.dirs} onChange={(e) => edit('dirs', e.target.value)} />
              </div>
              <p className="muted small">{t('Папка пространства: {dir}. Запись в неё у сессий закрыта (документ пишется инструментом space_write с твоим подтверждением), у этапов запуска — тоже.', { dir: tildePath(s.dir, home) })}</p>
            </div>
          )}
        </div>
      </section>
      <aside className={styles.activity} aria-label={t('Сессии и запуски пространства')}>
        <h3>{t('Сессии и запуски')} <span className="muted small">{itemsCount(s.sessions.length, s.runs.length)}</span></h3>
        {items.length ? (
          <ul className={styles.items}>
            {items.map((i) =>
              i.kind === 'session' ? (
                <li key={`s${i.s.id}`}>
                  <Link to={`/sessions/${i.s.id}`} className={cx(styles.item, i.s.live && styles.live)} title={i.s.cwd}>
                    <span className={cx(styles.dot, i.s.live && (i.s.status === 'waiting' ? styles.wait : styles.on))} aria-hidden="true" />
                    <span className={styles.itemMain}>
                      <span className={styles.itemTitle}>{i.s.name}</span>
                      <span className={styles.itemSub}>{[t('сессия'), i.s.live ? (i.s.status === 'waiting' ? t('ждёт тебя') : t('идёт')) : feedTime(i.s.lastActivityAt), i.s.legacy ? t('по тегу задачи') : ''].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className={styles.itemIcon} aria-hidden="true">›_</span>
                  </Link>
                </li>
              ) : (
                <li key={`r${i.r.id}`}>
                  <Link to={`/run/${i.r.id}`} className={styles.item} title={i.r.input}>
                    <span className={styles.itemMain}>
                      <span className={styles.itemTitle}>{i.r.title || i.r.flow}</span>
                      <span className={styles.itemSub}>{[i.r.title ? i.r.flow : '', feedTime(i.r.finishedAt ?? i.r.startedAt), i.r.legacy ? t('по тегу задачи') : ''].filter(Boolean).join(' · ')}</span>
                    </span>
                    <Badge status={i.r.status} />
                  </Link>
                </li>
              ),
            )}
          </ul>
        ) : (
          <p className="muted small">{t('Сессий и запусков в этом пространстве ещё не было.')}</p>
        )}
      </aside>
    </div>
  );
}

/** Документы: список, загрузка, новый текстовый, правка текстовых на месте, показать в Finder, удаление. */
/**
 * Документы пространства. Живёт, пока открыто это пространство (hidden — другая вкладка): открытый документ переживает
 * переключение вкладок; у другого пространства — заново (key). Несохранённый текст документа сообщается наверх (onDirty):
 * уход со страницы спросит, как о несохранённой карте.
 */
function DocsTab({ space: s, onDocs, onDirty, hidden }: { space: SpaceDetail; onDocs: (docs: SpaceDoc[]) => void; onDirty: (dirty: boolean) => void; hidden: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { askConfirm } = useConfirm();
  const reveal = useFeature('reveal');
  const fileInput = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<Msg>(NO_MSG);
  /** Открытый документ: saved — текст на диске, null — новый, ещё не записанный; base — mtimeMs для записи (0 — новый). */
  const [open, setOpen] = useState<{ name: string; text: string; saved: string | null; base: number } | null>(null);
  const [newName, setNewName] = useState('');
  const dirty = Boolean(open && (open.saved === null || open.text !== open.saved));
  useEffect(() => onDirty(dirty), [dirty]);
  useEffect(() => () => onDirty(false), []);

  const refresh = (docs: SpaceDoc[]) => {
    onDocs(docs);
    void qc.invalidateQueries({ queryKey: keys.spaces });
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    const errors: string[] = [];
    for (const file of files) {
      setMsg({ cls: 'msg', text: t('Загружаю {name}…', { name: file.name }) });
      try {
        refresh((await addSpaceDoc(s.slug, file.name, await readBase64(file))).docs);
      } catch (err) {
        errors.push(errorText(err));
      }
    }
    setMsg(errors.length ? { cls: 'msg err', text: errors.join('; ') } : { cls: 'msg', text: t('Документы добавлены') });
  };

  const openDoc = async (name: string) => {
    if (dirty && !(await askConfirm(t('В документе есть несохранённые правки. Открыть другой?'), { ok: t('Открыть') }))) return;
    try {
      const d = await fetchSpaceDoc(s.slug, name);
      setOpen({ name: d.name, text: d.text, saved: d.text, base: d.mtimeMs });
      setMsg(NO_MSG);
    } catch (err) {
      toast(errorText(err));
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim().replace(/\.md$/i, '') + '.md';
    if (!newName.trim()) return;
    if (s.docs.some((d) => d.name === name)) return void openDoc(name);
    setOpen({ name, text: '', saved: null, base: 0 });
    setNewName('');
  };

  const save = async () => {
    if (!open) return;
    try {
      const d = await saveSpaceDoc(s.slug, open.name, open.text, open.base);
      setOpen({ ...open, saved: d.text, base: d.mtimeMs });
      setMsg({ cls: 'msg', text: t('Сохранено') });
      const fresh = await fetchSpace(s.slug);
      refresh(fresh.docs);
    } catch (err) {
      setMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  const remove = async (name: string) => {
    if (!(await askConfirm(t('Удалить документ {name}?', { name }), { ok: t('Удалить'), danger: true }))) return;
    try {
      refresh((await deleteSpaceDoc(s.slug, name)).docs);
      if (open?.name === name) setOpen(null);
    } catch (err) {
      toast(errorText(err));
    }
  };

  return (
    <div className={styles.tabBody} hidden={hidden}>
      <p className={cx('muted small', styles.hint)}>{t('Спеки, решения, заметки, макеты. В контекст идёт только список с заголовками «# …» — файл агент открывает сам, когда нужен. Сессия может записать .md или .txt инструментом space_write, спросив тебя')}</p>
      <div className={styles.docsBar}>
        <button type="button" className="btn small" title={t('Картинки, PDF и текстовые файлы: до 10 МБ каждый, до 25 МБ вместе, до 30 файлов')} onClick={() => fileInput.current?.click()}>{t('+ Загрузить файлы…')}</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <form className={styles.newDoc} onSubmit={create}>
          <input name="doc" placeholder={t('новый документ: decisions')} autoComplete="off" spellCheck={false} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button type="submit" className="btn small" disabled={!newName.trim()}>{t('Создать')}</button>
        </form>
        <span className={msg.cls}>{msg.text}</span>
      </div>
      {s.docs.length ? (
        <ul className={styles.docs}>
          {s.docs.map((d) => (
            <li key={d.name} className={cx(open?.name === d.name && styles.active)}>
              <span className={styles.docName}>{d.name}</span>
              <span className={styles.docSub}>{docLine(d)}</span>
              <span className={styles.docActs}>
                {d.text && <button type="button" className="btn small ghost" onClick={() => void openDoc(d.name)}>{t('Открыть')}</button>}
                {reveal && <button type="button" className="btn small ghost" title={t('Показать в Finder')} onClick={() => void api('POST', '/api/reveal', { path: `${s.dir}/docs/${d.name}` }).catch((err: unknown) => toast(errorText(err)))}>{t('В Finder')}</button>}
                <button type="button" className="btn small ghost danger" onClick={() => void remove(d.name)}>×</button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{t('Документов пока нет.')}</p>}
      {open && (
        <div className={styles.docEditor}>
          <div className={styles.docEditorHead}>
            <span className="mono">{open.name}</span>
            <span className="row push">
              <button type="button" className="btn small primary" disabled={!dirty} onClick={() => void save()}>{t('Сохранить документ')}</button>
              <button
                type="button"
                className="btn small ghost"
                onClick={async () => {
                  if (dirty && !(await askConfirm(t('Закрыть без сохранения?'), { ok: t('Закрыть') }))) return;
                  setOpen(null);
                }}
              >{t('Закрыть')}</button>
            </span>
          </div>
          <textarea className={styles.mono} rows={16} spellCheck={false} value={open.text} onChange={(e) => setOpen({ ...open, text: e.target.value })} />
        </div>
      )}
    </div>
  );
}

/** Что пространство даёт модели: тот же текст, что у настоящей доставки, папки и карта; токены — на странице «Контекст». */
function ContextTab({ slug, version }: { slug: string; version: string }) {
  const home = useConfig().data?.home;
  const q = useQuery({ queryKey: ['spaces', slug, 'context', version], queryFn: () => fetchSpaceContext(slug) });
  if (q.error) return <p className="msg err">{errorText(q.error)}</p>;
  const c = q.data;
  if (!c) return <p className="muted small">{t('Собираю…')}</p>;
  return (
    <div className={styles.tabBody}>
      {c.warnings.map((w) => <p key={w} className="warn small">{w}</p>)}
      <div className={styles.ctxRow}>
        <span className="field-label">{t('Памятью (CLAUDE.md)')}</span>
        <span className="small">{c.map.exists ? t('{path} — {n} знаков, в каждом запросе', { path: tildePath(c.map.path, home), n: c.map.chars }) : t('карты нет — в память ничего не идёт')}</span>
        <Link className="btn small" to={`/context?space=${encodeURIComponent(slug)}`} title={t('Листинг Claude Code со страницы «Контекст»: карта пространства среди файлов памяти, с токенами')}>{t('Токены в «Контексте»')}</Link>
      </div>
      <div className={styles.ctxRow}>
        <span className="field-label">{t('На чтение')}</span>
        <span className={cx('small mono', styles.ctxDirs)}>{c.readDirs.map((d) => tildePath(d, home)).join('\n')}</span>
      </div>
      <details className={styles.ctxBlock} open>
        <summary>{t('Сессия терминала — в начале разговора (хук SessionStart)')} <span className="muted small mono">{t('{n} знаков', { n: c.session.length })}</span></summary>
        <pre>{c.session}</pre>
      </details>
      <details className={styles.ctxBlock}>
        <summary>{t('Этап запуска — в конце промпта каждого этапа')} <span className="muted small mono">{t('{n} знаков', { n: c.phase.length })}</span></summary>
        <pre>{c.phase}</pre>
      </details>
    </div>
  );
}
