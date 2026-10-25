// Страница «Теги» (/tags, /tags/<slug>; порт ui/tags.js): список тегов задач и знаний с поиском, новый тег над списком,
// редактор тега — заголовок, саммари, заметки (промпт тега), пути, вложения, запуски с тегом; крупный редактор справа.
// Всё, кроме запусков, подставляется в задачу каждого запуска с тегом (src/tags.ts). Каждое открытие страницы (переход,
// в том числе на тот же адрес) перечитывает список и тег с сервера, как openTags в старом UI.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, matchPath, useBlocker, useLocation, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { TagDetail, TagKind } from '@server/api-types';
import {
  addTagAttachment, ApiError, createTag, deleteTag, deleteTagAttachment, errorText, fetchTag, keys, saveTag, useFeature, useTags,
} from '../../api';
import { Badge, TagBadge } from '../../components/Badge';
import { useConfirm } from '../../components/ConfirmDialog';
import { PickDirButton } from '../../components/PickDirButton';
import { readBase64 } from '../../components/readBase64';
import { useMemoryState } from '../../components/useMemoryState';
import { when } from '../../lib/format';
import {
  filterTags, newTagBody, TAG_DESCRIPTION_HINT, TAG_DESCRIPTION_LABEL, TAG_DESCRIPTION_MAX, tagDirLines, TAG_DIRTY_TEXT, TAG_FOCUS_MONO, TAG_INLINE_HINT, TAG_INLINE_LABEL,
  tagDeleteText, tagFocusCount, tagFocusField, tagFocusLabel, tagFormOf, tagMetaLine, tagNotesHint, tagNotesLabel, tagPatch, tagPreview, tagsNoneText, tagSnapshot,
  type TagField, type TagForm,
} from '../../lib/tags';
import styles from './Tags.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

type Msg = { cls: string; text: string };
const NO_MSG: Msg = { cls: 'msg', text: '' };
const EMPTY_FORM: TagForm = { title: '', summary: '', notes: '', dirs: '', description: '', inline: false };
type NewTag = { open: boolean; slug: string; title: string; kind: TagKind };
const NEW_CLOSED: NewTag = { open: false, slug: '', title: '', kind: 'task' };

const tagPath = (slug?: string) => (slug ? `/tags/${encodeURIComponent(slug)}` : '/tags');

export function TagsScreen() {
  const { slug } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { askConfirm } = useConfirm();
  const kinds = useFeature('tag-kinds');
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
  const dirtyNow = () => Boolean(cur.current.tag) && tagSnapshot(cur.current.form, cur.current.tag!.kind) !== cur.current.saved;
  const dirty = Boolean(tag) && tagSnapshot(form, tag!.kind) !== saved;

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
    void askConfirm(TAG_DIRTY_TEXT, { ok: 'Перейти' }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
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
    const snap = tagSnapshot(f, t.kind);
    cur.current = { tag: t, form: f, saved: snap, focus: tagFocusField(keep, t.kind) };
    setTag(t);
    setForm(f);
    setSaved(snap);
    setFiles(t.attachments || []);
    setFocus(tagFocusField(keep, t.kind));
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
        setEditorErr(err instanceof ApiError && err.status === 404 ? `Тега ${slug} нет` : errorText(err));
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
    const body = newTagBody(nt.slug, nt.title, nt.kind, kinds);
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
    const t = cur.current.tag;
    if (!t) return;
    setMsg({ cls: 'msg', text: 'Сохраняю…' });
    // пока шёл запрос, могли перейти к другому тегу: его форму ответом не перетираем
    const my = seq.current;
    try {
      const next = await saveTag(t.slug, tagPatch(cur.current.form, t));
      if (my === seq.current) {
        fill(next);
        setMsg({ cls: 'msg', text: 'Сохранено' });
      }
      await qc.invalidateQueries({ queryKey: keys.tags });
    } catch (err) {
      if (my === seq.current) setMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  const remove = async () => {
    const t = cur.current.tag;
    if (!t) return;
    if (!(await askConfirm(tagDeleteText(t.slug), { ok: 'Удалить', danger: true }))) return;
    try {
      await deleteTag(t.slug);
      closeEditor();
      void qc.invalidateQueries({ queryKey: keys.tags });
      go();
    } catch (err) {
      setMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  /** Вложения тега грузятся сразу на сервер по одному: лимиты и типы проверяет он же, что и у вложений запуска. */
  const upload = async (list: File[]) => {
    const t = cur.current.tag;
    if (!t || !list.length) return;
    const errors: string[] = [];
    let names: string[] | null = null;
    for (const file of list) {
      setMsg({ cls: 'msg', text: `Загружаю ${file.name}…` });
      try {
        names = (await addTagAttachment(t.slug, file.name, await readBase64(file))).attachments;
      } catch (err) {
        errors.push(errorText(err));
      }
    }
    if (names && cur.current.tag === t) setFiles(names);
    setMsg(errors.length ? { cls: 'msg err', text: errors.join('; ') } : { cls: 'msg', text: 'Вложения добавлены' });
  };

  const detach = async (name: string) => {
    const t = cur.current.tag;
    if (!t) return;
    try {
      const r = await deleteTagAttachment(t.slug, name);
      if (cur.current.tag === t) setFiles(r.attachments);
    } catch (err) {
      setMsg({ cls: 'msg err', text: errorText(err) });
    }
  };

  const edit = (field: Exclude<keyof TagForm, 'inline'>, value: string) => setForm((f) => ({ ...f, [field]: value }));
  const knows = tag?.kind === 'knowledge';
  const tagsMsg = editorErr || listErr;
  const src = (field: TagField) => cx(focus === field && styles.focusedSrc);
  const focusValue = focus ? form[focus] : '';

  return (
    <div className={styles.viewTags}>
      <header className="view-head">
        <div>
          <h1>Теги</h1>
          <p className="muted">Тег — фича, над которой идут несколько запусков. Его саммари, заметки, пути и вложения подставляются в задачу каждого запуска с этим тегом</p>
        </div>
      </header>
      <div className={styles.tagsLayout}>
        {/* список тегов — главное на странице; новый тег — компактной формой над списком по кнопке */}
        <aside className={styles.tagsSide}>
          <div className={styles.tagsHead}>
            <h3>Все теги <span className={styles.tagsCount}>{loaded ? count : ''}</span></h3>
            <button
              type="button"
              className={cx('btn small', styles.btnTagNew, nt.open && styles.on)}
              aria-expanded={nt.open}
              aria-controls="tag-new"
              onClick={() => setNewOpen(!nt.open)}
            >+ Новый тег</button>
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
                <span>Слаг</span>
                <input
                  ref={slugInput}
                  name="slug"
                  placeholder="loyalty-card"
                  autoComplete="off"
                  spellCheck={false}
                  pattern="[a-z0-9][a-z0-9\-]{0,63}"
                  title="Строчные латинские буквы, цифры и дефис"
                  required
                  value={nt.slug}
                  onChange={(e) => setNt((v) => ({ ...v, slug: e.target.value }))}
                />
              </label>
              <label>
                <span>Заголовок</span>
                <input name="title" placeholder="Карта лояльности" autoComplete="off" value={nt.title} onChange={(e) => setNt((v) => ({ ...v, title: e.target.value }))} />
              </label>
            </div>
            {kinds && (
              <div className={styles.tagKind}>
                <span className={styles.tagKindLabel} title="Тег задачи — саммари фичи между запусками, встаёт в начало задачи. Тег знаний — что должны знать этапы блока (фронтенд, бэкенд, QA): в промпт этапов блоков с полем knowledge идёт строка с описанием, а заметки, пути и вложения этап запрашивает инструментом knowledge_read (или получает целиком, если включить «всегда вставлять»). Вид после создания не меняется">Вид</span>
                <div className={styles.seg}>
                  <label><input type="radio" name="kind" value="task" checked={nt.kind === 'task'} onChange={() => setNt((v) => ({ ...v, kind: 'task' }))} /><span>Задача</span></label>
                  <label><input type="radio" name="kind" value="knowledge" checked={nt.kind === 'knowledge'} onChange={() => setNt((v) => ({ ...v, kind: 'knowledge' }))} /><span>Область знаний</span></label>
                </div>
              </div>
            )}
            <div className="row">
              <button type="submit" className="btn">Завести тег</button>
              <button type="button" className="btn ghost" onClick={() => setNewOpen(false)}>Отмена</button>
              <span className={newMsg.cls}>{newMsg.text}</span>
            </div>
          </form>
          <p className={cx('msg err', styles.tagsMsg)}>{tagsMsg}</p>
          <input
            className={styles.tagsSearch}
            type="search"
            placeholder="Поиск: слаг, заголовок, саммари"
            autoComplete="off"
            spellCheck={false}
            title="Все слова должны найтись в слаге, заголовке или превью саммари/заметок. Esc — очистить"
            hidden={loaded && !list.length}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) setQuery(''); }}
          />
          <ul className={cx(styles.list, styles.tagsList)}>
            {loaded && (shown.length
              ? shown.map((t) => (
                <li key={t.slug} className={cx(t.slug === tag?.slug && styles.active)} onClick={() => go(t.slug)}>
                  <span className={styles.name}><TagBadge slug={t.slug} kind={t.kind} />{` ${t.title || ''}`}</span>
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
                  <h2 className="mono"><TagBadge slug={tag.slug} kind={tag.kind} />{' '}<span className="muted small">{knows ? 'область знаний' : 'тег задачи'}</span></h2>
                  <span className="row push">
                    <span className={msg.cls}>{msg.text}</span>
                    <button type="button" className="btn small ghost danger" onClick={() => void remove()}>Удалить тег</button>
                    <button type="submit" className="btn primary">Сохранить</button>
                  </span>
                </div>
                <label><span>Заголовок</span><input name="title" autoComplete="off" value={form.title} onChange={(e) => edit('title', e.target.value)} /></label>
                {/* у тега знаний: описание — строка в промпте каждого этапа блока, полный текст этап берёт инструментом knowledge_read;
                    чекбокс inline возвращает старое поведение — заметки целиком в каждом промпте */}
                {knows && (
                  <>
                    <label>
                      <span title={TAG_DESCRIPTION_HINT}>{TAG_DESCRIPTION_LABEL}</span>
                      <input
                        name="description"
                        autoComplete="off"
                        maxLength={TAG_DESCRIPTION_MAX}
                        placeholder="Правила проверки и тест-кейсы: открывай перед тестированием"
                        title={TAG_DESCRIPTION_HINT}
                        value={form.description}
                        onChange={(e) => edit('description', e.target.value)}
                      />
                    </label>
                    <label className="row" title={TAG_INLINE_HINT}>
                      <input type="checkbox" name="inline" checked={form.inline} onChange={(e) => setForm((f) => ({ ...f, inline: e.target.checked }))} />
                      <span>{TAG_INLINE_LABEL}</span>
                    </label>
                  </>
                )}
                {/* у тега знаний нет саммари и запусков: его знание — заметки, пути и вложения */}
                {!knows && (
                  <label>
                    <span title="Текущее состояние фичи. Его переписывает короткая сессия после каждого запуска «готово» с галочкой — правка руками доживёт до следующего такого запуска">Саммари</span>
                    <textarea name="summary" rows={10} spellCheck={false} className={src('summary')} value={form.summary} onFocus={() => setFocus('summary')} onChange={(e) => edit('summary', e.target.value)} />
                  </label>
                )}
                <label>
                  <span title={tagNotesHint(tag.kind, form.inline)}>{tagNotesLabel(tag.kind)}</span>
                  <textarea name="notes" rows={4} className={src('notes')} value={form.notes} onFocus={() => setFocus('notes')} onChange={(e) => edit('notes', e.target.value)} />
                </label>
                <div className={styles.tagPaths}>
                  <label htmlFor="tag-dirs" className="field-label" title="Абсолютные пути к папкам или файлам, по одному на строку: этапы запусков с тегом получат их доп. директориями. У файла этапам открывается вся его папка, а этапы с Edit и Write могут в неё писать — указывай узкие папки. Несуществующие пути пропускаются">Пути</label>
                  <PickDirButton
                    className="btn small pick-dir"
                    prompt="Выбери папку для тега"
                    title="Выбрать папку в Finder — путь добавится новой строкой"
                    start={() => tagDirLines(cur.current.form.dirs).at(-1) ?? ''}
                    onPick={(p) => {
                      const lines = tagDirLines(cur.current.form.dirs);
                      if (!lines.includes(p)) edit('dirs', [...lines, p].join('\n'));
                    }}
                    onSettled={() => dirsRef.current?.focus()}
                  >+ Добавить папку…</PickDirButton>
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
                    <span className="field-label">Вложения</span>
                    <button type="button" className="btn small" title="Картинки, PDF и текстовые файлы: до 10 файлов, до 10 МБ каждый, до 25 МБ вместе" onClick={() => fileInput.current?.click()}>+ Добавить файлы…</button>
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
                      <span key={name} className="chip attach-chip">{name}<button type="button" className="attach-x" title="Удалить вложение тега" onClick={() => void detach(name)}>×</button></span>
                    ))}
                  </div>
                </div>
                {!knows && (
                  <div className={styles.tagRuns}>
                    {tag.runs.length
                      ? <>
                        <span className="muted">Запуски с обновлением саммари:</span>
                        {tag.runs.map((r) => (
                          <Link key={r.id} to={`/run/${r.id}`} title={when(r.finishedAt)}>{`${r.flow} `}<Badge status={r.status} /></Link>
                        ))}
                      </>
                      : <span className="muted">Саммари ещё ни разу не обновлялось запуском</span>}
                  </div>
                )}
              </form>
            </section>
          ) : (
            <p className={cx(styles.tagEmpty, 'muted')}>Выбери тег в списке — откроются его саммари, заметки, пути и вложения. Новый тег — кнопкой «+ Новый тег»; тег можно указать и прямо в форме запуска.</p>
          )}
        </div>
        {/* крупный редактор поля тега, в котором стоит фокус; виден только при широком контейнере (Tags.module.css) */}
        <aside className={cx('big-editor', styles.tagFocus, !focus && 'empty-pane')}>
          <div className="focus-head">
            <div className="focus-titles">
              <div className="focus-ctx">{focus && tag ? `#${tag.slug}` : ''}</div>
              <div className="focus-label">{focus && tag ? tagFocusLabel(focus, tag.kind) : 'Крупный редактор'}</div>
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
          <p className={cx(styles.bigEditorEmpty, 'muted small')}>Выбери тег слева</p>
        </aside>
      </div>
    </div>
  );
}
