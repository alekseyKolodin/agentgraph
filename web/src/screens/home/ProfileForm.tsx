// «Кто я» в «Подключениях»: по профилю источники рутин отличают «обращено ко мне» и свои сообщения (SPEC 3.3).
// Пустое при первом открытии сервер заполняет сам (glab, gh, git config, Jira) — такие строки помечены; ввод руками пометку снимает.
import { useEffect, useState, type FormEvent } from 'react';
import type { Profile, ProfileResponse } from '@server/api-types';
import { api, errorText } from '../../api';
import { t } from '../../lib/i18n';
import styles from './Dash.module.css';

type Key = keyof Profile;
type Msg = { text: string; tone: '' | 'ok' | 'err' };

const join = (v: string[] | string | undefined) => (Array.isArray(v) ? v.join(', ') : v ?? '');

export function ProfileForm() {
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [msg, setMsg] = useState<Msg>({ text: '', tone: '' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api<ProfileResponse>('GET', '/api/settings/profile').then(setData, (err) => setMsg({ text: errorText(err), tone: 'err' }));
  }, []);

  const FIELDS: { key: Key; label: string; hint: string; placeholder?: string }[] = [
    { key: 'names', label: t('Имена'), hint: t('Как тебя подписывают в чатах и встречах; несколько — через запятую'), placeholder: t('Иван Петров, Иван') },
    { key: 'emails', label: t('Почты'), hint: t('Через запятую') },
    { key: 'gitlab', label: t('Логин GitLab'), hint: t('Берётся из glab') },
    { key: 'github', label: t('Логин GitHub'), hint: t('Берётся из gh') },
    { key: 'slackUserId', label: t('Id в Slack'), hint: t('В Slack: профиль → ⋮ → «Копировать ID участника»; начинается с U или W'), placeholder: 'U01ABCDEF' },
    { key: 'jiraEmail', label: t('Почта Jira'), hint: t('Берётся из подключения Jira') },
  ];

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = e.currentTarget.elements as unknown as Record<Key, HTMLInputElement>;
    const body = Object.fromEntries(FIELDS.map(({ key }) => [key, f[key].value]));
    try {
      setData(await api<ProfileResponse>('PUT', '/api/settings/profile', body));
      setVersion((v) => v + 1);
      setMsg({ text: t('сохранено'), tone: 'ok' });
    } catch (err) {
      setMsg({ text: errorText(err), tone: 'err' });
    }
  };

  if (!data) return <p className="muted small">{msg.text || t('Загружаю…')}</p>;
  return (
    <form key={version} className="form" onSubmit={save}>
      {FIELDS.map(({ key, label, hint, placeholder }) => (
        <label key={key} title={hint}>
          <span>
            {label}
            {data.auto.includes(key) && <span className="muted small" title={t('Заполнено само; правка оставит твоё значение')}> · {t('заполнено само')}</span>}
          </span>
          <input name={key} defaultValue={join(data.profile[key])} placeholder={placeholder} autoComplete="off" spellCheck={false} />
        </label>
      ))}
      <p className="muted small">{t('Пустые строки agentgraph заполняет сам из glab, gh, git config и Jira. Введённое руками не перетирается.')}</p>
      <div className="row">
        <button type="submit" className="btn primary">{t('Сохранить')}</button>
        <span className={`msg${msg.tone ? ` ${msg.tone}` : ''}`}>{msg.text}</span>
      </div>
    </form>
  );
}
