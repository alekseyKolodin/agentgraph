// Страница «Сессии» /sessions (макет Sessions): новая сессия — папка, теги, «Дополнительно» (название, модель, режим
// разрешений, саммари при выходе) и «Открыть терминал»; ниже — все сессии таблицей, живые сверху.
// ?tags=a,b — форма открыта с этими тегами (кнопка «Открыть сессию с тегом» на странице тега).
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionPermissionMode, SessionView, TagKind } from '@server/api-types';
import { ApiError, errorText, fetchTag, keys, useConfig, useFeature, useRecentDirs, useTags } from '../../api';
import { createSession, sessionKeys, useSessions } from '../../api/sessions';
import { TagBadge } from '../../components/Badge';
import { PickDirButton } from '../../components/PickDirButton';
import { TagInput } from '../../components/TagInput';
import { baseName, feedTime } from '../../lib/format';
import { MODELS } from '../../lib/flow/tools';
import { t } from '../../lib/i18n';
import { recentChips, TAG_SLUG_ERROR, TAG_SLUG_RE } from '../../lib/run-form';
import { sessionStatusLabel, sessionTone } from '../../lib/sessions';
import { LS } from '../../lib/storage';
import { tildePath } from './icons';
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
  const preset = (params.get('tags') ?? '').split(',').map((s) => s.trim()).filter((s) => TAG_SLUG_RE.test(s));
  const sessions = list.data?.sessions ?? [];
  const [open, setOpen] = useState<boolean | null>(null);
  const formOpen = open ?? (preset.length > 0 || (list.isSuccess && !sessions.length));
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
          <p className="muted">{t('Обычная сессия Claude Code в терминале — без flow, но с контекстом тегов.')}</p>
        </div>
        <button type="button" className="btn" aria-expanded={formOpen} aria-controls="new-session" onClick={() => setOpen(!formOpen)}>
          {t('Новая сессия')}
        </button>
      </div>
      {formOpen && <NewSession preset={preset} onCancel={() => setOpen(false)} full={list.data ? live >= list.data.max : false} max={list.data?.max ?? 0} />}
      <section className={styles.all} aria-label={t('Все сессии')}>
        <h2>{t('Все сессии')} <span className={styles.count}>{sessions.length}</span></h2>
        {list.error && <p className="msg err">{errorText(list.error)}</p>}
        {sessions.length > 0 ? <SessionTable sessions={sessions} /> : list.isSuccess && <p className="muted small">{t('Сессий ещё не было: открой первую формой выше.')}</p>}
      </section>
    </div>
  );
}

type Msg = { text: string; tone: '' | 'err' };

function NewSession({ preset, onCancel, full, max }: { preset: string[]; onCancel: () => void; full: boolean; max: number }) {
  const config = useConfig().data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const recent = recentChips(useRecentDirs(useFeature('recent-dirs')).data ?? []);
  const tagList = useTags(true).data?.tags ?? [];
  const [cwd, setCwd] = useState(() => LS.raw(CWD_KEY) || LS.raw('agentgraph.cwd') || config?.defaultCwd || '');
  const [tags, setTags] = useState<string[]>(preset);
  const [tagText, setTagText] = useState('');
  const [kinds, setKinds] = useState<Map<string, TagKind>>(new Map());
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<SessionPermissionMode | ''>('');
  const [saveTag, setSaveTag] = useState(true);
  const [msg, setMsg] = useState<Msg>({ text: '', tone: '' });
  const [busy, setBusy] = useState(false);
  const kindOf = (slug: string): TagKind => kinds.get(slug) ?? tagList.find((x) => x.slug === slug)?.kind ?? 'task';

  const addTag = (raw: string) => {
    const slug = raw.trim();
    if (!slug) return;
    if (!TAG_SLUG_RE.test(slug)) return setMsg({ text: TAG_SLUG_ERROR, tone: 'err' });
    setTagText('');
    setMsg({ text: '', tone: '' });
    if (tags.includes(slug)) return;
    setTags((list) => [...list, slug]);
    // вид тега — для чипа; нового тега ещё нет: заведётся тегом задачи
    fetchTag(slug).then(
      (r) => setKinds((m) => new Map(m).set(slug, r.kind)),
      (err: unknown) => setMsg(err instanceof ApiError && err.status === 404 ? { text: t('{slug}: новый тег — заведётся тегом задачи', { slug }), tone: '' } : { text: errorText(err), tone: 'err' }),
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
        tags: tagText.trim() && TAG_SLUG_RE.test(tagText.trim()) && !tags.includes(tagText.trim()) ? [...tags, tagText.trim()] : tags,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(model ? { model } : {}),
        ...(mode ? { permissionMode: mode } : {}),
        saveTag,
        cols: Math.max(80, Math.floor((window.innerWidth - 380) / 8)),
        rows: Math.max(24, Math.floor((window.innerHeight - 190) / 17)),
      });
      LS.setRaw(CWD_KEY, s.cwd);
      qc.setQueryData(sessionKeys.one(s.id), s);
      void qc.invalidateQueries({ queryKey: sessionKeys.list, exact: true });
      void qc.invalidateQueries({ queryKey: keys.tags });
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
      <div className={styles.tags}>
        <TagInput
          label={t('Теги')}
          listId="new-session-tags"
          options={tagList.filter((x) => !tags.includes(x.slug))}
          placeholder={t('впиши тег или новый слаг и нажми Enter')}
          text={tagText}
          onText={setTagText}
          onAdd={addTag}
          tags={tags}
          kindOf={kindOf}
          onRemove={(slug) => setTags((list) => list.filter((x) => x !== slug))}
          removeTitle={t('Убрать тег')}
        />
        <p className="muted small">{t('Теги задач: их заметки и саммари уходят в начало сессии. Теги знаний: строка в контексте, полный текст — по запросу. Новый слаг станет тегом задачи. Можно и без тегов.')}</p>
      </div>
      <details className={styles.more}>
        <summary>{t('Дополнительно')}</summary>
        <div className={styles.moreBody}>
          <label>
            <span>{t('Название')}</span>
            <input name="name" placeholder={tags.join(' · ') || baseName(cwd) || t('по тегам или папке')} value={name} onChange={(e) => setName(e.target.value)} />
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
          <input type="checkbox" checked={saveTag} onChange={(e) => setSaveTag(e.target.checked)} />
          <span>
            <span>{t('Обновлять саммари тегов задач при выходе')}</span>
            <span className="muted small">{t('Короткая сессия haiku на каждый тег задачи, как после запуска flow. Можно и вручную — кнопкой в сессии.')}</span>
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
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('Статус')}</th>
            <th scope="col">{t('Название')}</th>
            <th scope="col">{t('Теги')}</th>
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
              <td className={styles.name}><Link to={`/sessions/${s.id}`} title={s.name}>{s.name}</Link></td>
              <td><span className={styles.tagList}>{s.chips.filter((c) => c.state !== 'removed').map((c) => <TagBadge key={c.slug} slug={c.slug} kind={c.kind} />)}</span></td>
              <td className={styles.dir} title={tildePath(s.cwd, home)}>{baseName(s.cwd)}</td>
              <td className={styles.num}>{s.turns}</td>
              <td className={styles.when}>{s.status === 'working' ? t('сейчас') : feedTime(s.lastActivityAt)}</td>
              <td className={styles.act}><Link to={`/sessions/${s.id}`}>{t('Открыть')}</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
