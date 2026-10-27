// Экран сессии терминала /sessions/:id (макеты Main и Ended): шапка — назад, название с правкой, статус, папка,
// «Завершить»; строка тегов — чипы со снятием и «+ тег», тег на ходу помечен «придёт со следующим шагом»; терминал на
// всю оставшуюся высоту; подвал с подсказкой и версией claude. Состояние приходит потоком WebSocket терминала.
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionTagChip, SessionView } from '@server/api-types';
import { api, ApiError, errorText, keys, useConfig, useFeature, useTags } from '../../api';
import { endSession, fetchSession, putSession, renameSession, sessionKeys, setSessionTags } from '../../api/sessions';
import { TagField } from '../../components/TagInput';
import { useToast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { TAG_SLUG_ERROR, TAG_SLUG_RE } from '../../lib/run-form';
import { chipHint, pendingNote, sessionStatusLabel, sessionTone } from '../../lib/sessions';
import { SessionTerminal } from './SessionTerminal';
import { ICON, tildePath } from './icons';
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

function Session({ s }: { s: SessionView }) {
  const qc = useQueryClient();
  const setS = (v: SessionView) => putSession(qc, v);
  const toast = useToast();
  const home = useConfig().data?.home;
  const [ending, setEnding] = useState(false);
  const [screenOnly, setScreenOnly] = useState(false);
  const end = async () => {
    setEnding(true);
    try {
      setS(await endSession(s.id));
    } catch (err) {
      toast(errorText(err));
    } finally {
      setEnding(false);
    }
  };
  const tone = sessionTone(s);
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
          {s.live && (
            <button type="button" className="btn" disabled={ending} title={t('Завершить claude (SIGHUP): разговор сохранится в транскрипте')} onClick={() => void end()}>
              {ICON.stop}{t('Завершить')}
            </button>
          )}
        </div>
      </header>
      <TagRow s={s} onSaved={setS} />
      <section className={styles.termSection} aria-label={t('Терминал сессии')}>
        <SessionTerminal
          id={s.id}
          live={s.live}
          onState={setS}
          overlay={!s.live && !screenOnly && <Ended s={s} onHide={() => setScreenOnly(true)} />}
        />
      </section>
      <footer className={styles.foot}>
        {s.live
          ? [t('Ctrl-C дважды — выйти из Claude'), t('Shift+Enter — новая строка'), t('перезагрузка страницы сессию не прерывает'), ...(s.claudeVersion ? [`claude ${s.claudeVersion}`] : [])].join(' · ')
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

/** Строка тегов: чипы (снятый — зачёркнут, пока снятие не дошло), «+ тег», что ещё не дошло до модели. */
function TagRow({ s, onSaved }: { s: SessionView; onSaved: (v: SessionView) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const options = useTags(true).data?.tags ?? [];
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const put = async (tags: string[]) => {
    setBusy(true);
    try {
      onSaved(await setSessionTags(s.id, tags));
      // новый слаг сервер завёл тегом задачи: подсказки и страница «Теги» — заново
      void qc.invalidateQueries({ queryKey: keys.tags });
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const add = (raw: string) => {
    const slug = raw.trim();
    if (!slug || busy) return;
    if (!TAG_SLUG_RE.test(slug)) return toast(TAG_SLUG_ERROR);
    setText('');
    if (!s.tags.includes(slug)) void put([...s.tags, slug]);
  };
  // до SessionStart теги придут все сразу: строка «дойдёт со следующим шагом» тут ни к чему
  const note = s.live && s.status !== 'starting' ? pendingNote(s.chips) : '';
  return (
    <div className={styles.tags}>
      <span className={styles.tagsLabel}>{t('Теги')}</span>
      {s.chips.map((c) => <Chip key={c.slug} c={c} onRemove={s.live && c.state !== 'removed' ? () => void put(s.tags.filter((x) => x !== c.slug)) : undefined} />)}
      {!s.chips.length && <span className={styles.none}>{t('без тегов')}</span>}
      {s.live && (
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
      )}
      {note && <p className={styles.note}>{ICON.clock}{note}</p>}
      {s.delivery === 'trust' && <p className={cx(styles.note, styles.warn)}>{t('Claude спрашивает в терминале, доверяешь ли ты этой папке: пока не ответишь, теги не придут.')}</p>}
      {s.delivery === 'missing' && (
        <p className={cx(styles.note, styles.warn)} title={t('agentgraph передаёт теги хуками Claude Code. Их выключают настройки disableAllHooks и allowedHttpHookUrls, а HTTP-хуки не доходят через прокси, если 127.0.0.1 не в NO_PROXY.')}>
          {t('Теги не доставлены: хук SessionStart не сработал. Возможные причины — прокси, disableAllHooks или allowedHttpHookUrls в настройках Claude Code.')}
        </p>
      )}
    </div>
  );
}

function Chip({ c, onRemove }: { c: SessionTagChip; onRemove?: () => void }) {
  const hint = chipHint(c);
  return (
    <span
      className={cx(styles.chip, styles[c.kind], c.state !== 'on' && styles[c.state])}
      title={[c.kind === 'knowledge' ? t('Тег знаний: строка в контексте, полный текст — инструментом knowledge_read') : t('Тег задачи: заметки и саммари фичи в начале сессии'), hint].filter(Boolean).join('\n')}
    >
      {c.state !== 'on' && ICON.clock}
      {c.kind === 'knowledge' && ICON.book}
      {c.slug}
      {onRemove && <button type="button" className={styles.chipX} aria-label={t('Снять тег {slug}', { slug: c.slug })} onClick={onRemove}>{ICON.x}</button>}
    </span>
  );
}

/** Карточка поверх последнего экрана завершённой сессии. */
function Ended({ s, onHide }: { s: SessionView; onHide: () => void }) {
  const code = s.exitCode ?? '?';
  const text =
    s.outcome === 'untrusted'
      ? t('Claude вышел, не начав сессию: доверие к папке не принято. Теги не доставлялись.')
      : s.outcome === 'failed'
        ? t('claude завершился с кодом {code}, не начав сессию: причина — в выводе терминала.', { code })
        : t('Claude вышел, код {code}.', { code });
  return (
    <div className={styles.overlay}>
      <div className={styles.endCard} role="status">
        <h2>{s.outcome === 'untrusted' ? t('Папка не доверена') : t('Сессия завершена')}</h2>
        <p className="muted">{text}</p>
        <div className="row">
          <button type="button" className="btn" onClick={onHide}>{t('Посмотреть экран')}</button>
        </div>
      </div>
    </div>
  );
}
