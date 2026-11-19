// Шаг «Как отвечать» для «Сервиса через Claude»: один пишущий инструмент сервиса и шаблон его аргументов (config.reply).
// Используется при подключении (ConnectSource) и для уже подключённого источника (редактор рутины).
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { McpServiceView, SourceView } from '@server/routines/types';
import { errorText } from '../../api';
import { routineKeys, saveSource, useMcpTools } from '../../api/routines';
import { t } from '../../lib/i18n';
import { DEFAULT_REPLY_ARGS, parseReply } from '../../lib/routines/reply';
import type { ReplyChoice } from '../../lib/routines/spec';
import { cx } from './parts';
import styles from './Routines.module.css';

/**
 * «Как отвечать» (необязательно): один пишущий инструмент сервиса и шаблон его аргументов. Чтение источника пишущих
 * инструментов не получает; этот — единственный, который рутина вызовет на запись. Когда он сработает, решает режим ответа
 * рутины (mode).
 */
/** Когда уйдёт сообщение — по режиму ответа рутины; у экрана подключения рутины ещё нет, режим не известен. */
function whenSent(mode: ReplyChoice | undefined): string {
  if (mode === 'draft') return t('Ответ уходит без модели и только после твоей проверки.');
  if (mode === 'auto') return t('Ответ уходит без модели и сразу, без твоей проверки: так настроена эта рутина.');
  if (mode === 'off') return t('У этой рутины ответ выключен: пока не включишь, ничего не уйдёт.');
  return t('Ответ уходит без модели. Когда — после твоей проверки или сразу — решает режим ответа в самой рутине.');
}

export function ReplyStep({ services, chosen, tool, args, parsed, mode, onTool, onArgs }: { services: McpServiceView[]; chosen: string[]; tool: string; args: string; parsed: ReturnType<typeof parseReply> | undefined; mode?: ReplyChoice; onTool: (v: string) => void; onArgs: (v: string) => void }) {
  // отвечать удобнее там же, откуда читаем: выбранные сервисы — первыми
  const withWrite = services.filter((s) => s.status === 'connected' && s.writeTools.length).sort((a, b) => Number(chosen.includes(b.server)) - Number(chosen.includes(a.server)));
  const picked = withWrite.flatMap((s) => s.writeTools.map((x) => ({ s, x }))).find((r) => r.x.name === tool);
  // после «Обновить список» выбранного инструмента может не быть: select показал бы «Не отвечать», а выбор остался бы невидимым
  useEffect(() => {
    if (tool && services.length && !picked) onTool('');
  }, [tool, services.length, picked]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={styles.field} role="group" aria-label={t('Как отвечать')}>
      <span className={styles.lbl}>{t('Как отвечать')} · {t('необязательно')}</span>
      <span className={styles.hint}>
        {t('Чтобы рутина могла ответить в тред, откуда пришла запись, выбери один инструмент сервиса, который отправляет сообщение. Это единственный инструмент, которым рутина может что-то записать: читать им нельзя, а источник выше только читает.')} {whenSent(mode)}
      </span>
      <select className={styles.slot} aria-label={t('Инструмент ответа')} value={tool} onChange={(e) => onTool(e.target.value)}>
        <option value="">{t('Не отвечать из источника')}</option>
        {withWrite.map((s) => (
          <optgroup key={s.server} label={s.title}>
            {s.writeTools.map((x) => (
              <option key={x.name} value={x.name}>{x.tool}</option>
            ))}
          </optgroup>
        ))}
      </select>
      {!withWrite.length && <span className={styles.hint}>{t('У подключённых сервисов нет инструментов отправки — отвечать можно будет из flow.')}</span>}
      {tool && (
        <>
          {picked?.x.description && <span className={styles.hint}>{picked.x.description}</span>}
          <span className={styles.warn}>{t('Инструмент меняет данные: рутина будет отправлять сообщения от твоего имени в {service}.', { service: picked?.s.title ?? tool })}</span>
          <label className={styles.field}>
            <span className={styles.lbl}>{t('Что передать инструменту')}</span>
            <textarea className={cx(styles.inp, styles.mono)} rows={5} spellCheck={false} value={args} onChange={(e) => onArgs(e.target.value)} />
          </label>
          <span className={styles.hint}>
            {t('JSON с аргументами инструмента — имена бери из его описания. {{channel}} — канал записи, {{thread}} — её тред (если записи не в треде, аргумент не передаётся и сообщение уйдёт в канал), {{text}} — текст ответа. Вместо {{channel}} можно вписать фиксированный канал.')}
          </span>
          {parsed && !parsed.ok && <span className={styles.err}>{parsed.error}</span>}
          {parsed?.ok && <span className={styles.mono}>{t('Будет вызвано')}: {tool.split('__').slice(2).join('__')} {JSON.stringify(parsed.reply.args)}</span>}
        </>
      )}
    </div>
  );
}

/** Ответ для уже подключённого источника (из редактора рутины): тот же шаг «Как отвечать», сохраняется в тот же источник без пересборки скрипта. */
export function SourceReplyPanel({ source, mode, onClose }: { source: SourceView; mode?: ReplyChoice; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useMcpTools();
  const [tool, setTool] = useState('');
  const [args, setArgs] = useState(DEFAULT_REPLY_ARGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const parsed = tool ? parseReply(tool, args) : undefined;
  const services = q.data?.services ?? [];
  const chosen = services.filter((s) => (source.spec.config.tools as string[] | undefined)?.some((n) => n.startsWith(`mcp__${s.server.replace(/[^\w-]+/g, '_')}__`))).map((s) => s.server);
  const save = async () => {
    if (!parsed?.ok) return;
    setBusy(true);
    setError('');
    try {
      await saveSource(source.slug, { ...source.spec, config: { ...source.spec.config, reply: parsed.reply } });
      await qc.invalidateQueries({ queryKey: routineKeys.all });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div className={styles.field}>
      {q.isPending && <span className="muted small">{t('Смотрю, что подключено к Claude… (несколько секунд)')}</span>}
      {q.isError && <span className={styles.err}>{t('Список сервисов не загрузился: {error}', { error: errorText(q.error) })}</span>}
      {q.data && <ReplyStep services={services} chosen={chosen} tool={tool} args={args} parsed={parsed} mode={mode} onTool={setTool} onArgs={setArgs} />}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !parsed?.ok} title={tool && !parsed?.ok ? parsed?.error : t('Сохранить ответ в источнике «{title}»', { title: source.spec.title })} onClick={() => void save()}>{t('Сохранить ответ')}</button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>{t('Отмена')}</button>
      </div>
      {error && <span className={styles.err}>{error}</span>}
    </div>
  );
}
