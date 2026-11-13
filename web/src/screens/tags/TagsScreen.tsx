// Страница «Знания» (/tags, /tags/<slug>; порт ui/tags.js): список тегов знаний с поиском, новый тег над списком,
// редактор тега — заголовок, описание, режим «целиком», заметки (знание), пути, вложения; крупный редактор справа.
// Этапы блоков с knowledge и сессии получают строку тега, полный текст — по запросу (src/tags.ts). Теги задач заменили
// пространства (страница «Пространства»). Каждое открытие страницы перечитывает список и тег с сервера.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, matchPath, useBlocker, useLocation, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TagDetail } from '@server/api-types';
import {
  addTagAttachment, ApiError, createTag, deleteTag, deleteTagAttachment, errorText, fetchTag, keys, saveTag, useFeature, useTags,
} from '../../api';
import { TagBadge } from '../../components/Badge';
import { useConfirm } from '../../components/ConfirmDialog';
import { PickDirButton } from '../../components/PickDirButton';
import { readBase64 } from '../../components/readBase64';
import { useMemoryState } from '../../components/useMemoryState';
import { t } from '../../lib/i18n';
import {
  filterTags, newTagBody, TAG_DESCRIPTION_HINT, TAG_DESCRIPTION_LABEL, TAG_DESCRIPTION_MAX, tagDirLines, TAG_DIRTY_TEXT, TAG_FOCUS_MONO, TAG_INLINE_HINT, TAG_INLINE_LABEL,
  TAG_NOTES_LABEL, tagDeleteText, tagFocusCount, tagFocusField, tagFocusLabel, tagFormOf, tagMetaLine, tagNotesHint, tagPatch, tagPreview, tagsNoneText, tagSnapshot,
  type TagField, type TagForm,
} from '../../lib/tags';
import styles from './Tags.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

type Msg = { cls: string; text: string };
const NO_MSG: Msg = { cls: 'msg', text: '' };
const EMPTY_FORM: TagForm = { title: '', notes: '', dirs: '', description: '', inline: false };
type NewTag = { open: boolean; slug: string; title: string };
const NEW_CLOSED: NewTag = { open: false, slug: '', title: '' };

const tagPath = (slug?: string) => (slug ? `/tags/${encodeURIComponent(slug)}` : '/tags');

export function TagsScreen() {
  const { slug } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { askConfirm } = useConfirm();
  const sessions = useFeature('sessions');
  const tagsQuery = useTags(true);

  // как DOM старой страницы: поиск и форма нового тега переживают уход с экрана и возврат
  const [query, setQuery] = useMemoryState('tags.search', '');
  const [nt, setNt] = useMemoryState<NewTag>('tags.new', NEW_CLOSED);
  const [newMsg, setNewMsg] = useState<Msg>(NO_MSG);
  const [focusNew, setFocusNew] = useState(0);
  const slugInput = useRef<HTMLInputElement>(null);

  /** Открытый тег с сервера, поля формы и снимок полей на момент загрузки/сохранения: по нему — «есть несохранённое». */
  const [tag, setTag] = useState<TagDetail | null>(null);
  const [form, setForm] = useState<TagForm>(EMPTY_FORM);
  const [saved, setSaved] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [msg, setMsg] = useState<Msg>(NO_MSG);
  const [editorErr, setEditorErr] = useState('');
  /** Поле, которое отражает крупный редактор справа; null — панель пуста. */
  const [focus, setFocus] = useState<TagField | null>(null);
  const seq = useRef(0);
  const dirsRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // для обработчиков вне рендера (уход со страницы, ответы после await): текущее без ожидания перерисовки
  const cur = useRef({ tag, form, saved, focus });
  cur.current = { tag, form, saved, focus };
  const dirtyNow = () => Boolean(cur.current.tag) && tagSnapshot(cur.current.form) !== cur.current.saved;
  const dirty = Boolean(tag) && tagSnapshot(form) !== saved;

  const listErr = tagsQuery.isError ? errorText(tagsQuery.error) : '';
  const loaded = tagsQuery.isError || tagsQuery.data !== undefined;
  const list = tagsQuery.isError ? [] : tagsQuery.data?.tags ?? [];
  const { shown, count } = filterTags(list, query);

  // уход на другой тег или к списку с несохранёнными правками — спросить (на другие экраны старый UI уходил без вопроса)
  const blocker = useBlocker(({ nextLocation }) => {
    if (!dirtyNow()) return false;
    const m = matchPath('/tags/:slug?', nextLocation.pathname);
    return Boolean(m) && m!.params.slug !== cur.current.tag!.slug;
  });
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void askConfirm(TAG_DIRTY_TEXT, { ok: t('Перейти') }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
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

  /** Тег с сервера в форму. После сохранения того же тега крупный редактор остаётся на том же поле. */
  const fill = (t: TagDetail) => {
    const keep = cur.current.tag?.slug === t.slug ? cur.current.focus ?? undefined : undefined;
    const f = tagFormOf(t);
    const snap = tagSnapshot(f);
    cur.current = { tag: t, form: f, saved: snap, focus: tagFocusField(keep) };
    setTag(t);
    setForm(f);
    setSaved(snap);
    setFiles(t.attachments || []);
    setFocus(tagFocusField(keep));
  };

  const closeEditor = () => {
    cur.current = { ...cur.current, tag: null, focus: null };
    setTag(null);
    setFocus(null);
  };

  // открытие страницы: список и тег перечитываются при каждом переходе (location.key), как openTags
  useEffect(() => {
    setEditorErr('');
    void tagsQuery.refetch({ cancelRefetch: false });
    if (!slug) {
      seq.current++;
      closeEditor();
      return;
    }
    const my = ++seq.current;
    setMsg(NO_MSG);
    fetchTag(slug).then(
      (t) => {
        if (my === seq.current) fill(t);
      },
      (err) => {
        if (my !== seq.current) return;
        closeEditor();
        // старая ссылка на тег задачи: он стал пространством с тем же слагом — туда и ведём
        if (err instanceof ApiError && err.code === 'moved_to_space') return void navigate(`/spaces/${slug}`, { replace: true });
        setEditorErr(err instanceof ApiError && err.status === 404 ? t('Тега {slug} нет', { slug }) : errorText(err));
      },
    );
  }, [location.key]);

  /** Форма нового тега над списком: по кнопке «+ Новый тег»; без тегов открыта сразу. */
  const setNewOpen = (open: boolean) => {
    if (open) {
      setNt((v) => ({ ...v, open: true }));
      setFocusNew((n) => n + 1);
    } else {
      setNt(NEW_CLOSED);
      setNewMsg(NO_MSG);
    }
  };
  useEffect(() => {
    if (focusNew) slugInput.current?.focus();
  }, [focusNew]);
  // без тегов форма открывается сама — после каждой загрузки списка, как renderTagList
  useEffect(() => {
    if (tagsQuery.data && !tagsQuery.isError && !tagsQuery.data.tags.length && !nt.open) setNewOpen(true);
  }, [tagsQuery.dataUpdatedAt]);

  /** Переход на тег или к списку; тот же адрес — без новой записи в истории. */
  const go = (s?: string) => {
    const path = tagPath(s);
    navigate(path, { replace: path === location.pathname });
  };

  const create = async (ev: FormEvent) => {
    ev.preventDefault();
    setNewMsg(NO_MSG);
    const body = newTagBody(nt.slug, nt.title);
    if (!body) return;
    try {
      await createTag(body);
      setNewOpen(false);
      void qc.invalidateQueries({ queryKey: keys.tags });
      go(body.slug);
    } catch (err) {
      setNewMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const tg = cur.current.tag;
    if (!tg) return;
    setMsg({ cls: 'msg', text: t('Сохраняю…') });
    // пока шёл запрос, могли перейти к другому тегу: его форму ответом не перетираем
    const my = seq.current;
    try {
      const next = await saveTag(tg.slug, tagPatch(cur.current.form, tg));
      if (my === seq.current) {
        fill(next);
        setMsg({ cls: 'msg', text: t('Сохранено') });
      }
      await qc.invalidateQueries({ queryKey: keys.tags });
    } catch (err) {
      if (my === seq.current) setMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  const remove = async () => {
    const tg = cur.current.tag;
    if (!tg) return;
    if (!(await askConfirm(tagDeleteText(tg.slug), { ok: t('Удалить'), danger: true }))) return;
    try {
      await deleteTag(tg.slug);
      closeEditor();
      void qc.invalidateQueries({ queryKey: keys.tags });
      go();
    } catch (err) {
      setMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  /** Вложения тега грузятся сразу на сервер по одному: лимиты и типы проверяет он же, что и у вложений запуска. */
  const upload = async (list: File[]) => {
    const tg = cur.current.tag;
    if (!tg || !list.length) return;
    const errors: string[] = [];
    let names: string[] | null = null;
    for (const file of list) {
      setMsg({ cls: 'msg', text: t('Загружаю {name}…', { name: file.name }) });
      try {
        names = (await addTagAttachment(tg.slug, file.name, await readBase64(file))).attachments;
      } catch (err) {
        errors.push(errorText(err));
      }
    }
    if (names && cur.current.tag === tg) setFiles(names);
    setMsg(errors.length ? { cls: 'msg err', text: errors.join('; ') } : { cls: 'msg', text: t('Вложения добавлены') });
  };

  const detach = async (name: string) => {
    const tg = cur.current.tag;
    if (!tg) return;
    try {
      const r = await deleteTagAttachment(tg.slug, name);
      if (cur.current.tag === tg) setFiles(r.attachments);
    } catch (err) {
      setMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  const edit = (field: Exclude<keyof TagForm, 'inline'>, value: string) => setForm((f) => ({ ...f, [field]: value }));
  const tagsMsg = editorErr || listErr;
  const src = (field: TagField) => cx(focus === field && styles.focusedSrc);
  const focusValue = focus ? form[focus] : '';

  return (
    <div className={styles.viewTags}>
      <header className="view-head">
        <div>
          <h1>{t('Знания')}</h1>
          <p className="muted">{t('Теги знаний: правила и справка, которые нужны многим задачам (фронтенд, бэкенд, QA). Этапы блоков с knowledge и сессии получают строку с описанием, полный текст — инструментом knowledge_read. Фичи и проекты живут в «Пространствах»')}</p>
        </div>
      </header>
      <div className={styles.tagsLayout}>
        {/* список тегов — главное на странице; новый тег — компактной формой над списком по кнопке */}
        <aside className={styles.tagsSide}>
          <div className={styles.tagsHead}>
            <h3>{t('Все теги знаний')} <span className={styles.tagsCount}>{loaded ? count : ''}</span></h3>
            <button
              type="button"
              className={cx('btn small', styles.btnTagNew, nt.open && styles.on)}
              aria-expanded={nt.open}
              aria-controls="tag-new"
              onClick={() => setNewOpen(!nt.open)}
            >{t('+ Новый тег')}</button>
          </div>
          <form
            id="tag-new"
            className={cx('form', styles.tagNew)}
            hidden={!nt.open}
            onSubmit={(e) => void create(e)}
            onKeyDown={(e) => { if (e.key === 'Escape') setNewOpen(false); }}
          >
            <div className={styles.tagNewRow}>
              <label>
                <span>{t('Слаг')}</span>
                <input
                  ref={slugInput}
                  name="slug"
                  placeholder="qa-rules"
                  autoComplete="off"
                  spellCheck={false}
                  pattern="[a-z0-9][a-z0-9\-]{0,63}"
                  title={t('Строчные латинские буквы, цифры и дефис')}
                  required
                  value={nt.slug}
                  onChange={(e) => setNt((v) => ({ ...v, slug: e.target.value }))}
                />
              </label>
              <label>
                <span>{t('Заголовок')}</span>
                <input name="title" placeholder={t('Правила QA')} autoComplete="off" value={nt.title} onChange={(e) => setNt((v) => ({ ...v, title: e.target.value }))} />
              </label>
            </div>
            <div className="row">
              <button type="submit" className="btn">{t('Завести тег')}</button>
              <button type="button" className="btn ghost" onClick={() => setNewOpen(false)}>{t('Отмена')}</button>
              <span className={newMsg.cls}>{newMsg.text}</span>
            </div>
          </form>
          <p className={cx('msg err', styles.tagsMsg)}>{tagsMsg}</p>
          <input
            className={styles.tagsSearch}
            type="search"
            placeholder={t('Поиск: слаг, заголовок, описание')}
            autoComplete="off"
            spellCheck={false}
            title={t('Все слова должны найтись в слаге, заголовке или описании. Esc — очистить')}
            hidden={loaded && !list.length}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) setQuery(''); }}
          />
          <ul className={cx(styles.list, styles.tagsList)}>
            {loaded && (shown.length
              ? shown.map((t) => (
                <li key={t.slug} className={cx(t.slug === tag?.slug && styles.active)} onClick={() => go(t.slug)}>
                  <span className={styles.name}><TagBadge slug={t.slug} />{` ${t.title || ''}`}</span>
                  <span className={cx(styles.sub, styles.preview)}>{tagPreview(t)}</span>
                  <span className={cx(styles.sub, styles.meta)}>{tagMetaLine(t)}</span>
                </li>
              ))
              : <li className={cx(styles.tagsNone, 'muted small')}>{tagsNoneText(list.length)}</li>)}
          </ul>
        </aside>
        <div className={styles.tagsMain}>
          {tag ? (
            <section className={cx('panel', styles.tagEditor)}>
              <form className={cx('form', styles.tagForm)} onSubmit={(e) => void save(e)}>
                <div className={styles.tagEditorHead}>
                  <h2 className="mono"><TagBadge slug={tag.slug} />{' '}<span className="muted small">{t('знания')}</span></h2>
                  <span className="row push">
                    <span className={msg.cls}>{msg.text}</span>
                    {sessions && (
                      <Link className="btn small" to={`/sessions?tags=${encodeURIComponent(tag.slug)}`} title={t('Новая сессия Claude Code в терминале с этим тегом')}>{t('Открыть сессию с тегом')}</Link>
                    )}
                    <button type="button" className="btn small ghost danger" onClick={() => void remove()}>{t('Удалить тег')}</button>
                    <button type="submit" className="btn primary">{t('Сохранить')}</button>
                  </span>
                </div>
                <label><span>{t('Заголовок')}</span><input name="title" autoComplete="off" value={form.title} onChange={(e) => edit('title', e.target.value)} /></label>
                {/* описание — строка в промпте каждого этапа блока, полный текст этап берёт инструментом knowledge_read;
                    чекбокс inline возвращает старое поведение — заметки целиком в каждом промпте */}
                <label>
                  <span title={TAG_DESCRIPTION_HINT}>{TAG_DESCRIPTION_LABEL}</span>
                  <input
                    name="description"
                    autoComplete="off"
                    maxLength={TAG_DESCRIPTION_MAX}
                    placeholder={t('Правила проверки и тест-кейсы: открывай перед тестированием')}
                    title={TAG_DESCRIPTION_HINT}
                    value={form.description}
                    onChange={(e) => edit('description', e.target.value)}
                  />
                </label>
                <label className="row" title={TAG_INLINE_HINT}>
                  <input type="checkbox" name="inline" checked={form.inline} onChange={(e) => setForm((f) => ({ ...f, inline: e.target.checked }))} />
                  <span>{TAG_INLINE_LABEL}</span>
                </label>
                <label>
                  <span title={tagNotesHint(form.inline)}>{TAG_NOTES_LABEL}</span>
                  <textarea name="notes" rows={4} className={src('notes')} value={form.notes} onFocus={() => setFocus('notes')} onChange={(e) => edit('notes', e.target.value)} />
                </label>
                <div className={styles.tagPaths}>
                  <label htmlFor="tag-dirs" className="field-label" title={t('Абсолютные пути к папкам или файлам, по одному на строку: этапы запусков с тегом получат их доп. директориями. У файла этапам открывается вся его папка, а этапы с Edit и Write могут в неё писать — указывай узкие папки. Несуществующие пути пропускаются')}>{t('Пути')}</label>
                  <PickDirButton
                    className="btn small pick-dir"
                    prompt={t('Выбери папку для тега')}
                    title={t('Выбрать папку в Finder — путь добавится новой строкой')}
                    start={() => tagDirLines(cur.current.form.dirs).at(-1) ?? ''}
                    onPick={(p) => {
                      const lines = tagDirLines(cur.current.form.dirs);
                      if (!lines.includes(p)) edit('dirs', [...lines, p].join('\n'));
                    }}
                    onSettled={() => dirsRef.current?.focus()}
                  >{t('+ Добавить папку…')}</PickDirButton>
                  <textarea
                    ref={dirsRef}
                    id="tag-dirs"
                    name="dirs"
                    rows={3}
                    spellCheck={false}
                    placeholder="/Users/me/projects/specs"
                    className={src('dirs')}
                    value={form.dirs}
                    onFocus={() => setFocus('dirs')}
                    onChange={(e) => edit('dirs', e.target.value)}
                  />
                </div>
                <div className={styles.tagAttach}>
                  <div className={styles.tagAttachHead}>
                    <span className="field-label">{t('Вложения')}</span>
                    <button type="button" className="btn small" title={t('Картинки, PDF и текстовые файлы: до 10 файлов, до 10 МБ каждый, до 25 МБ вместе')} onClick={() => fileInput.current?.click()}>{t('+ Добавить файлы…')}</button>
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => {
                        void upload([...(e.target.files ?? [])]);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  <div className="chips">
                    {files.map((name) => (
                      <span key={name} className="chip attach-chip">{name}<button type="button" className="attach-x" title={t('Удалить вложение тега')} onClick={() => void detach(name)}>×</button></span>
                    ))}
                  </div>
                </div>
              </form>
            </section>
          ) : (
            <p className={cx(styles.tagEmpty, 'muted')}>{t('Выбери тег в списке — откроются его описание, заметки, пути и вложения. Новый тег — кнопкой «+ Новый тег»; к блоку flow тег подключают полем knowledge, к запуску и сессии — в их формах.')}</p>
          )}
        </div>
        {/* крупный редактор поля тега, в котором стоит фокус; виден только при широком контейнере (Tags.module.css) */}
        <aside className={cx('big-editor', styles.tagFocus, !focus && 'empty-pane')}>
          <div className="focus-head">
            <div className="focus-titles">
              <div className="focus-ctx">{focus && tag ? `#${tag.slug}` : ''}</div>
              <div className="focus-label">{focus && tag ? tagFocusLabel(focus) : t('Крупный редактор')}</div>
            </div>
            <span className="muted small">{focus ? tagFocusCount(focusValue) : ''}</span>
          </div>
          <textarea
            className={cx('big-editor-text', focus && TAG_FOCUS_MONO.includes(focus) && 'mono')}
            spellCheck={false}
            disabled={!focus}
            placeholder={focus === 'dirs' ? '/Users/me/projects/specs' : ''}
            value={focusValue}
            onChange={(e) => { if (focus) edit(focus, e.target.value); }}
          />
          <p className={cx(styles.bigEditorEmpty, 'muted small')}>{t('Выбери тег слева')}</p>
        </aside>
      </div>
    </div>
  );
}
