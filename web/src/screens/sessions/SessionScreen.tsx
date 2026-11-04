// Экран сессии терминала /sessions/:id (макеты Main и Ended): шапка — назад, название с правкой, статус, папка,
// «Обновить состояние», «Завершить» или «Продолжить», меню (перезапуск, удаление); строка контекста — чип пространства
// (смена и снятие, в том числе у завершённой — со следующим «Продолжить») и чипы тегов знаний со снятием и «+ тег»;
// выбранное на ходу помечено «придёт со следующим шагом», справа — состояние пространства; терминал на всю оставшуюся
// высоту; подвал с подсказкой и версией claude. Состояние приходит потоком WebSocket терминала.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionSpaceChip, SessionTagChip, SessionView } from '@server/api-types';
import { api, ApiError, errorText, keys, useConfig, useFeature, useSpaces, useTags } from '../../api';
import { ModelPreview } from '../../components/ModelPreview';
import { SpacePicker } from '../../components/SpacePicker';
import {
  continueSession, deleteSession, endSession, fetchSession, putSession, renameSession, restartSession, sessionKeys, setSessionSpace, setSessionTags, updateSessionState,
} from '../../api/sessions';
import { useConfirm } from '../../components/ConfirmDialog';
import { TagField } from '../../components/TagInput';
import { useToast } from '../../components/Toast';
import { clock } from '../../lib/format';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import { TAG_SLUG_ERROR, TAG_SLUG_RE } from '../../lib/run-form';
import { canUpdateState, chipHint, pendingNote, sessionStatusLabel, sessionTone, spaceChipHint, stateNote } from '../../lib/sessions';
import { SPACE_SLUG_ERROR, SPACE_SLUG_RE } from '../../lib/spaces';
import { SELECT_KEY, SessionTerminal } from './SessionTerminal';
import { ICON } from './icons';
import styles from './Session.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');

export function SessionScreen() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: sessionKeys.one(id), queryFn: () => fetchSession(id) });
  if (q.error) {
    return (
      <div className="empty">
        <h1>{q.error instanceof ApiError && q.error.status === 404 ? t('Сессия не найдена') : t('Сессия не открылась')}</h1>
        <p className="muted">{errorText(q.error)}</p>
        <Link to="/sessions">{t('← Все сессии')}</Link>
      </div>
    );
  }
  if (!q.data) return null;
  // другая сессия — новое состояние экрана (правка названия, скрытая карточка) и новый терминал
  return <Session key={q.data.id} s={q.data} />;
}

/** Действия сессии: каждое отдаёт свежее состояние сессии; пока идёт одно, остальные кнопки ждут. */
function useActions(s: SessionView, setS: (v: SessionView) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { askConfirm } = useConfirm();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<SessionView>) => {
    setBusy(true);
    try {
      setS(await fn());
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    end: () => run(() => endSession(s.id)),
    resume: () => run(() => continueSession(s.id)),
    restart: () => run(() => restartSession(s.id)),
    state: () => run(() => updateSessionState(s.id)),
    remove: async () => {
      if (!(await askConfirm(t('Удалить сессию «{name}» из agentgraph? Журнал ходов и перетащенные файлы удалятся; транскрипт Claude останется.', { name: s.name }), { ok: t('Удалить'), danger: true }))) return;
      try {
        await deleteSession(s.id);
        qc.removeQueries({ queryKey: sessionKeys.one(s.id) });
        void qc.invalidateQueries({ queryKey: sessionKeys.list, exact: true });
        void navigate('/sessions');
      } catch (err) {
        toast(errorText(err));
      }
    },
  };
}

function Session({ s }: { s: SessionView }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const setS = (v: SessionView) => putSession(qc, v);
  // Claude открыл сессию инструментом session_new: она уже в списке, переход — по клику на всплывашку
  const opened = (v: SessionView) => {
    qc.setQueryData(sessionKeys.one(v.id), v);
    void qc.invalidateQueries({ queryKey: sessionKeys.list, exact: true });
    toast(t('Claude открыл сессию «{name}» — нажми, чтобы перейти', { name: v.name }), () => void navigate(`/sessions/${encodeURIComponent(v.id)}`));
  };
  const home = useConfig().data?.home;
  const act = useActions(s, setS);
  const [screenOnly, setScreenOnly] = useState(false);
  // сессию продолжили — следующее завершение снова покажет карточку
  useEffect(() => {
    if (s.live) setScreenOnly(false);
  }, [s.live]);
  // состояние пространства записано (выход, «Обновить состояние»), пока экран открыт: «Модель получит» и список
  // пространств — заново. Прошлая запись, с которой экран открыли, — не повод (Session смонтирован по id сессии)
  const stateAt = s.stateUpdate?.ok ? s.stateUpdate.at : '';
  const seenStateAt = useRef(stateAt);
  useEffect(() => {
    if (!stateAt || stateAt === seenStateAt.current) return;
    seenStateAt.current = stateAt;
    void qc.invalidateQueries({ queryKey: keys.spaces });
  }, [stateAt]);
  const tone = sessionTone(s);
  const update = canUpdateState(s);
  return (
    <div className={styles.screen}>
      <header className={styles.head}>
        <Link to="/sessions" className={styles.back} title={t('Все сессии')}>{ICON.back}{t('Сессии')}</Link>
        <Title s={s} onSaved={setS} />
        <span className={cx(styles.status, styles[tone], s.status === 'working' && styles.pulse)}>
          <span className={styles.dot} aria-hidden="true" />
          {sessionStatusLabel(s)}
        </span>
        <Cwd path={s.cwd} />
        <span className={styles.spacer} />
        <div className={styles.actions}>
          {!s.live && (
            <button type="button" className="btn primary" disabled={act.busy} title={s.resumable ? t('Тот же разговор (claude --resume) с текущими пространством и тегами и пересчитанными папками') : t('Новый разговор в той же папке: в прошлом не было ни одного сообщения')} onClick={() => void act.resume()}>
              {t('Продолжить')}
            </button>
          )}
          {update.show && (
            <button type="button" className="btn" disabled={act.busy || !update.ok} title={update.why} onClick={() => void act.state()}>
              {ICON.refresh}{t('Обновить состояние')}
            </button>
          )}
          {s.live && (
            <button type="button" className="btn" disabled={act.busy} title={t('Завершить claude (SIGHUP): разговор сохранится в транскрипте')} onClick={() => void act.end()}>
              {ICON.stop}{t('Завершить')}
            </button>
          )}
          <Menu s={s} act={act} />
        </div>
      </header>
      <TagRow s={s} onSaved={setS} />
      <SessionModelPreview s={s} />
      <section className={styles.termSection} aria-label={t('Терминал сессии')}>
        <SessionTerminal
          id={s.id}
          live={s.live}
          onState={setS}
          onOpened={opened}
          overlay={!s.live && !screenOnly && <Ended s={s} act={act} onHide={() => setScreenOnly(true)} />}
        />
      </section>
      <footer className={styles.foot}>
        {s.live
          ? [t('Ctrl-C дважды — выйти из Claude'), t('Shift+Enter — новая строка'), t('{key}+мышь — выделение терминала', { key: SELECT_KEY }), t('перезагрузка страницы сессию не прерывает'), ...(s.claudeVersion ? [`claude ${s.claudeVersion}`] : [])].join(' · ')
          : s.transcriptPath
            ? <>{t('Транскрипт:')} <span className="mono">{tildePath(s.transcriptPath, home)}</span></>
            : t('Транскрипта нет: не было ни одного сообщения')}
      </footer>
    </div>
  );
}

/** Название с правкой на месте: Enter — сохранить, Esc — отменить. */
function Title({ s, onSaved }: { s: SessionView; onSaved: (v: SessionView) => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const toast = useToast();
  const save = async (name: string) => {
    setEdit(null);
    if (!name.trim() || name.trim() === s.name) return;
    try {
      onSaved(await renameSession(s.id, name));
    } catch (err) {
      toast(errorText(err));
    }
  };
  if (edit !== null) {
    return (
      <input
        className={styles.rename}
        aria-label={t('Название сессии')}
        autoFocus
        value={edit}
        onChange={(e) => setEdit(e.target.value)}
        onBlur={() => void save(edit)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save(edit);
          if (e.key === 'Escape') setEdit(null);
        }}
      />
    );
  }
  return (
    <div className={styles.title}>
      <h1 title={s.name}>{s.name}</h1>
      <button type="button" className={styles.iconBtn} aria-label={t('Переименовать сессию')} title={t('Переименовать')} onClick={() => setEdit(s.name)}>{ICON.pencil}</button>
    </div>
  );
}

/** Папка сессии: клик показывает её в Finder, если сервер умеет. */
function Cwd({ path }: { path: string }) {
  const reveal = useFeature('reveal');
  const home = useConfig().data?.home;
  const toast = useToast();
  const label = tildePath(path, home);
  if (!reveal) return <span className={styles.cwd} title={path}>{ICON.folder}{label}</span>;
  return (
    <button
      type="button"
      className={styles.cwd}
      title={t('Показать в Finder: {path}', { path })}
      onClick={() => void api('POST', '/api/reveal', { path }).catch((err: unknown) => toast(errorText(err)))}
    >
      {ICON.folder}{label}
    </button>
  );
}

/**
 * «Модель получит» для пространства и тегов знаний сессии — то, что придёт хуком SessionStart нового процесса claude
 * («Продолжить», «Перезапустить»). Удалённые теги хук пропускает — превью тоже.
 */
function SessionModelPreview({ s }: { s: SessionView }) {
  const spacesQuery = useSpaces(useFeature('spaces'));
  const tagList = useTags(true).data?.tags;
  const tags = tagList ? s.tags.filter((x) => tagList.some((t) => t.slug === x)) : [];
  return <ModelPreview className={styles.modelPreview} space={s.space ?? ''} missing={s.spaceChip?.missing} tags={tags} where="session" cwd={s.cwd} options={spacesQuery.data?.spaces ?? []} loaded={!spacesQuery.isPending && Boolean(tagList)} />;
}

/**
 * Строка контекста: чип пространства (смена — выбором «+ пространство», снятие — ×) и чипы тегов знаний (снятый —
 * зачёркнут, пока снятие не дошло), «+ тег», что ещё не дошло до модели. У завершённой сессии пространство и знания тоже
 * правятся: их получит «Продолжить».
 */
function TagRow({ s, onSaved }: { s: SessionView; onSaved: (v: SessionView) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const options = useTags(true).data?.tags ?? [];
  const spacesOn = useFeature('spaces');
  const spaces = useSpaces(spacesOn).data?.spaces ?? [];
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (fn: () => Promise<SessionView>) => {
    setBusy(true);
    try {
      onSaved(await fn());
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const put = (tags: string[]) => void save(() => setSessionTags(s.id, tags));
  // выбор с клавиатуры размонтирует поле (появится чип), снятие — чип (появится поле): фокус переходит на новое
  const refocus = useRef<'chip' | 'picker' | null>(null);
  useEffect(() => {
    const want = refocus.current;
    if (!want) return;
    refocus.current = null;
    (want === 'chip' ? document.querySelector<HTMLElement>('[data-space-chip] a') : document.getElementById('session-space-input'))?.focus();
  }, [s.space, s.spaceChip?.state]);
  // снятие мышью фокус не переносит: поле выбора открыло бы список по onFocus
  const putSpace = (space: string | null, keyboard = true) =>
    void save(async () => {
      refocus.current = space ? 'chip' : keyboard ? 'picker' : null;
      const v = await setSessionSpace(s.id, space);
      // новый слаг сервер завёл пустым пространством: подсказки и страница «Пространства» — заново
      void qc.invalidateQueries({ queryKey: keys.spaces });
      return v;
    });
  const add = (raw: string) => {
    const slug = raw.trim();
    if (!slug || busy) return;
    if (!TAG_SLUG_RE.test(slug)) return toast(TAG_SLUG_ERROR);
    setText('');
    if (!s.tags.includes(slug)) put([...s.tags, slug]);
  };
  const addSpace = (raw: string) => {
    const slug = raw.trim();
    if (!slug || busy) return;
    if (!SPACE_SLUG_RE.test(slug)) return toast(SPACE_SLUG_ERROR);
    if (slug !== s.space) putSpace(slug);
  };
  // до SessionStart всё придёт сразу: строка «дойдёт со следующим шагом» тут ни к чему
  const note = s.live && s.status !== 'starting' ? pendingNote([...(s.spaceChip && s.spaceChip.state !== 'on' ? [s.spaceChip] : []), ...s.chips]) : '';
  const removable = s.spaceChip && s.spaceChip.state !== 'removed';
  return (
    <div className={styles.tags}>
      {spacesOn && (
        <>
          <span className={styles.tagsLabel}>{t('Пространство')}</span>
          {s.spaceChip && <SpaceChip c={s.spaceChip} live={s.live} onRemove={removable ? (keyboard) => putSpace(null, keyboard) : undefined} />}
          {(!s.space || s.spaceChip?.state === 'removed') && (
            <span title={s.live ? t('Раздел пространства придёт со следующим шагом; карту в память — «Перезапустить» в меню ⋯') : t('Пространство получит «Продолжить»')}>
              <SpacePicker id="session-space" compact inputClassName={styles.addTag} label={t('Выбрать пространство')} placeholder={t('+ пространство')} value="" onChange={addSpace} options={spaces} />
            </span>
          )}
          <span className={styles.sep} aria-hidden="true" />
        </>
      )}
      <span className={styles.tagsLabel}>{t('Знания')}</span>
      {s.chips.map((c) => <Chip key={c.slug} c={c} onRemove={c.state !== 'removed' ? () => put(s.tags.filter((x) => x !== c.slug)) : undefined} />)}
      {!s.chips.length && <span className={styles.none}>{t('без тегов')}</span>}
      <TagField
        listId="session-tag-list"
        options={options.filter((o) => !s.tags.includes(o.slug))}
        text={text}
        onText={setText}
        onAdd={add}
        className={styles.addTag}
        aria-label={t('Добавить тег')}
        placeholder={t('+ тег')}
      />
      <span className={styles.spacer} />
      <StateNote s={s} />
      {note && <p className={styles.note}>{ICON.clock}{note}</p>}
      {s.delivery === 'trust' && <p className={cx(styles.note, styles.warn)}>{t('Claude спрашивает в терминале, доверяешь ли ты этой папке: пока не ответишь, контекст agentgraph не придёт.')}</p>}
      {s.delivery === 'missing' && (
        <p className={cx(styles.note, styles.warn)} title={t('agentgraph передаёт контекст хуками Claude Code. Их выключают настройки disableAllHooks и allowedHttpHookUrls, а HTTP-хуки не доходят через прокси, если 127.0.0.1 не в NO_PROXY.')}>
          {t('Контекст не доставлен: хук SessionStart не сработал. Возможные причины — прокси, disableAllHooks или allowedHttpHookUrls в настройках Claude Code.')}
        </p>
      )}
    </div>
  );
}

/** Справа в строке контекста: когда состояние пространства обновлялось, идёт ли сейчас, ошибка. */
function StateNote({ s }: { s: SessionView }) {
  const note = stateNote(s);
  if (!note) return null;
  return (
    <span className={cx(styles.summary, note.tone && styles[note.tone])} title={note.title}>
      {note.tone === 'ok' && <span className={styles.okDot} aria-hidden="true" />}
      {note.text}
    </span>
  );
}

function Chip({ c, onRemove }: { c: SessionTagChip; onRemove?: () => void }) {
  const hint = chipHint(c);
  return (
    <span
      className={cx(styles.chip, styles.knowledge, c.state !== 'on' && styles[c.state])}
      title={[t('Тег знаний: строка в контексте, полный текст — инструментом knowledge_read'), hint].filter(Boolean).join('\n')}
    >
      {c.state !== 'on' && ICON.clock}
      {ICON.book}
      {c.slug}
      {onRemove && <button type="button" className={styles.chipX} aria-label={t('Снять тег {slug}', { slug: c.slug })} onClick={onRemove}>{ICON.x}</button>}
    </span>
  );
}

/** Чип пространства: слаг — ссылка на его страницу; ещё не дошло — пунктир с часами; удалено — приглушён. */
function SpaceChip({ c, live, onRemove }: { c: SessionSpaceChip; live: boolean; onRemove?: (keyboard: boolean) => void }) {
  return (
    <span data-space-chip className={cx(styles.chip, styles.space, c.state !== 'on' && styles[c.state], c.missing && styles.removed)} title={spaceChipHint(c, live)}>
      {c.state !== 'on' && ICON.clock}
      <Link to={`/spaces/${encodeURIComponent(c.slug)}`} className={styles.chipLink}>◇ {c.slug}</Link>
      {onRemove && <button type="button" className={styles.chipX} aria-label={t('Снять пространство {slug}', { slug: c.slug })} onClick={(e) => onRemove(e.detail === 0)}>{ICON.x}</button>}
    </span>
  );
}

type Actions = ReturnType<typeof useActions>;

/** «⋯»: редкие действия — перезапуск живой сессии с пересчитанными папками пространства и тегов, удаление завершённой. */
function Menu({ s, act }: { s: SessionView; act: Actions }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // клик мимо и Esc закрывают, фокус — на первый пункт (как меню flow)
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const onClick = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const pick = (fn: () => unknown) => () => {
    setOpen(false);
    void fn();
  };
  return (
    <div className="menu-wrap">
      <button ref={btn} type="button" className="btn icon-more" aria-haspopup="menu" aria-expanded={open} aria-label={t('Ещё действия с сессией')} title={t('Ещё действия с сессией')} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      <div ref={box} className="menu" role="menu" hidden={!open}>
        {s.live ? (
          <button type="button" className="menu-item" role="menuitem" disabled={act.busy} title={t('claude перезапустится тем же разговором (--resume): карта пространства, выбранного на ходу, придёт памятью, а папки пространства и тегов станут доступны без вопросов')} onClick={pick(act.restart)}>
            {t('Перезапустить')}
          </button>
        ) : (
          <button type="button" className="menu-item danger" role="menuitem" title={t('Удалить запись сессии: журнал ходов и перетащенные файлы; транскрипт Claude останется')} onClick={pick(act.remove)}>
            {t('Удалить сессию…')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Карточка поверх последнего экрана завершённой сессии: что случилось, что с саммари, «Продолжить». */
function Ended({ s, act, onHide }: { s: SessionView; act: Actions; onHide: () => void }) {
  const code = s.exitCode ?? '?';
  const text =
    s.outcome === 'untrusted'
      ? t('Claude вышел, не начав сессию: доверие к папке не принято. Контекст agentgraph не доставлялся.')
      : s.outcome === 'failed'
        ? t('claude завершился с кодом {code}, не начав сессию: причина — в выводе терминала.', { code })
        : t('Claude вышел, код {code}.', { code });
  const note = stateNote(s);
  const update = canUpdateState(s);
  return (
    <div className={styles.overlay}>
      <div className={styles.endCard} role="status">
        <h2>{s.outcome === 'untrusted' ? t('Папка не доверена') : t('Сессия завершена')}</h2>
        <p className="muted">{text}{note ? ` ${note.text}` : ''}</p>
        <div className="row">
          <button type="button" className="btn primary" disabled={act.busy} onClick={() => void act.resume()}>{t('Продолжить')}</button>
          {update.show && <button type="button" className="btn" disabled={act.busy || !update.ok} title={update.why} onClick={() => void act.state()}>{t('Обновить состояние')}</button>}
          <button type="button" className="btn ghost" onClick={onHide}>{t('Посмотреть экран')}</button>
        </div>
        <p className={styles.hint}>
          {s.resumable
            ? t('«Продолжить» откроет тот же разговор (claude --resume) с текущими пространством и тегами и пересчитанными папками.')
            : t('«Продолжить» откроет новый разговор в той же папке: в этом не было ни одного сообщения.')}
        </p>
      </div>
    </div>
  );
}
