// Страница «Сессии» /sessions (макет Sessions): новая сессия — папка, пространство, теги знаний, «Дополнительно»
// (название, модель, режим разрешений, состояние при выходе) и «Открыть терминал»; ниже — все сессии таблицей, живые
// сверху. ?space=x — форма открыта с этим пространством (кнопка «Новая сессия» на странице пространства), &cwd= — и с
// папкой («Сессия в папке»); ?tags=a,b — с этими тегами знаний (кнопка на странице тега).
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionPermissionMode, SessionView } from '@server/api-types';
import { ApiError, errorText, fetchTag, keys, useConfig, useFeature, useRecentDirs, useSpaces, useTags } from '../../api';
import { continueSession, createSession, putSession, sessionKeys, updateSessionState, useSessions } from '../../api/sessions';
import { useToast } from '../../components/Toast';
import { SpaceBadge, TagBadge } from '../../components/Badge';
import { PickDirButton } from '../../components/PickDirButton';
import { SpaceField } from '../../components/SpaceField';
import { TagInput } from '../../components/TagInput';
import { baseName, feedTime } from '../../lib/format';
import { MODELS } from '../../lib/flow/tools';
import { t } from '../../lib/i18n';
import { tildePath } from '../../lib/paths';
import { recentChips, TAG_SLUG_ERROR, TAG_SLUG_RE } from '../../lib/run-form';
import { canUpdateState, sessionStatusLabel, sessionTone } from '../../lib/sessions';
import { SPACE_SLUG_RE } from '../../lib/spaces';
import { LS } from '../../lib/storage';
import styles from './Sessions.module.css';

const cx = (...list: (string | false | null | undefined)[]) => list.filter(Boolean).join(' ');
/** Папка последней сессии: форма открывается с ней. */
const CWD_KEY = 'agentgraph.sessionCwd';
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
  const formOpen = open ?? (preset.tags.length > 0 || Boolean(preset.space) || (list.isSuccess && !sessions.length));
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
        <h2>{t('Все сессии')} <span className={styles.count}>{sessions.length}</span></h2>
        {list.error && <p className="msg err">{errorText(list.error)}</p>}
        {sessions.length > 0 ? <SessionTable sessions={sessions} /> : list.isSuccess && <p className="muted small">{t('Сессий ещё не было: открой первую формой выше.')}</p>}
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
  const spaceList = useSpaces(useFeature('spaces')).data?.spaces ?? [];
  const [cwd, setCwd] = useState(() => preset.cwd || LS.raw(CWD_KEY) || LS.raw('agentgraph.cwd') || config?.defaultCwd || '');
  const [space, setSpace] = useState(preset.space);
  const [tags, setTags] = useState<string[]>(preset.tags);
  const [tagText, setTagText] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<SessionPermissionMode | ''>('');
  const [saveState, setSaveState] = useState(true);
  const [msg, setMsg] = useState<Msg>({ text: '', tone: '' });
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    setMsg({ text: t('Открываю терминал…'), tone: '' });
    try {
      // примерный размер терминала по окну: claude перерисуется под него при подключении
      const s = await createSession({
        cwd: cwd.trim(),
        ...(space.trim() ? { space: space.trim() } : {}),
        tags,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(model ? { model } : {}),
        ...(mode ? { permissionMode: mode } : {}),
        saveState,
        cols: Math.max(80, Math.floor((window.innerWidth - 380) / 8)),
        rows: Math.max(24, Math.floor((window.innerHeight - 190) / 17)),
      });
      LS.setRaw(CWD_KEY, s.cwd);
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
      <label>
        <span>{t('Папка')}</span>
        <div className="path-field">
          <input name="cwd" placeholder="/path/to/repo" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          <PickDirButton prompt={t('Папка сессии Claude')} start={() => cwd} onPick={setCwd} />
        </div>
      </label>
      {recent.length > 0 && (
        <div className={cx('chips', styles.recent)}>
          <span className="muted small">{t('Недавние:')}</span>
          {recent.map((d) => (
            <button key={d.path} type="button" className={cx('chip', d.path === cwd.trim() && 'on')} title={d.path} onClick={() => setCwd(d.path)}>{d.label}</button>
          ))}
        </div>
      )}
      <SpaceField listId="new-session-spaces" className={styles.tags} value={space} onChange={setSpace} options={spaceList} />
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

function SessionTable({ sessions }: { sessions: SessionView[] }) {
  const home = useConfig().data?.home;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const run = async (id: string, fn: () => Promise<SessionView>, open: boolean) => {
    setBusy(id);
    try {
      putSession(qc, await fn());
      if (open) void navigate(`/sessions/${id}`);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy('');
    }
  };
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('Статус')}</th>
            <th scope="col">{t('Название')}</th>
            <th scope="col">{t('Пространство и теги')}</th>
            <th scope="col">{t('Папка')}</th>
            <th scope="col" className={styles.num}>{t('Ходов')}</th>
            <th scope="col">{t('Активность')}</th>
            <th scope="col"><span className={styles.sr}>{t('Действия')}</span></th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} className={s.live ? '' : styles.ended}>
              <td><span className={cx(styles.status, styles[sessionTone(s)])}><span className={styles.dot} aria-hidden="true" />{sessionStatusLabel(s)}</span></td>
              <td className={styles.name}>
                <Link to={`/sessions/${s.id}`} title={s.name}>{s.name}</Link>
                {s.statePending && <span className={styles.pending}>{t('состояние не обновлено: приложение закрыли')}</span>}
              </td>
              <td>
                <span className={styles.tagList}>
                  {s.space && <SpaceBadge slug={s.space} link />}
                  {s.chips.filter((c) => c.state !== 'removed').map((c) => <TagBadge key={c.slug} slug={c.slug} kind="knowledge" />)}
                </span>
              </td>
              <td className={styles.dir} title={tildePath(s.cwd, home)}>{baseName(s.cwd)}</td>
              <td className={styles.num}>{s.turns}</td>
              <td className={styles.when}>{s.status === 'working' ? t('сейчас') : feedTime(s.lastActivityAt)}</td>
              <td className={styles.act}>
                {s.live ? (
                  <Link to={`/sessions/${s.id}`}>{t('Открыть')}</Link>
                ) : (
                  <span className={styles.acts}>
                    {s.statePending && canUpdateState(s).ok && (
                      <button type="button" className="btn small" disabled={busy === s.id} onClick={() => void run(s.id, () => updateSessionState(s.id), false)}>{t('Обновить состояние')}</button>
                    )}
                    <button type="button" className="btn small" disabled={busy === s.id} title={s.resumable ? t('Тот же разговор (claude --resume) с текущими пространством и тегами') : t('Новый разговор в той же папке')} onClick={() => void run(s.id, () => continueSession(s.id), true)}>
                      {t('Продолжить')}
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
