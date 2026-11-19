// Помощник раздела «Рутины» на «Новой рутине» (docs/ASSISTANTS.md §1): общий компонент помощника с адресом раздела.
// Он сам находит или подключает источник, проверяет его, подбирает или собирает flow, заполняет форму ниже и проверяет
// правило на истории. Чего он сделать не может (ввести ключ, включить рутину) — остаётся человеку: под лентой ссылки.
import { Link } from 'react-router';
import type { AssistantStep } from '@server/assistant-types';
import type { RoutineAssistantDraft, RoutineSpec } from '@server/routines/types';
import { AssistantPanel } from '../../components/assistant/AssistantPanel';
import { t } from '../../lib/i18n';
import { connectNeedHref } from '../../lib/routines/compose';
import styles from './ComposeBox.module.css';

export const ROUTINE_ASSISTANT = '/api/routines/assistant';
/** Модель помощника раздела «Рутины»: выбор человека запоминается в браузере ('' — по умолчанию). */
const MODEL_KEY = 'agentgraph.assistantModel.routines';

type Props = {
  chatId: string | null;
  onChatId: (id: string | null) => void;
  appliedRev: number;
  /** Помощник заполнил черновик: форма берёт его целиком (один раз на результат). */
  onDraft: (draft: RoutineAssistantDraft, rev: number) => void;
  /** Помощник подключил источник или собрал flow: форма перечитывает списки. */
  onAct: (steps: AssistantStep[]) => void;
  /** Уходим подключать недостающий источник: форма сохраняет черновик сейчас. */
  onConnect: () => void;
  /** Форма, как её видит человек сейчас (правило из шагов ниже): помощник правит её, а не свой прошлый черновик. Пустая — undefined. */
  form: () => RoutineSpec | undefined;
};

export function RoutineAssistant({ chatId, onChatId, appliedRev, onDraft, onAct, onConnect, form }: Props) {
  return (
    <AssistantPanel<RoutineAssistantDraft>
      base={ROUTINE_ASSISTANT}
      modelKey={MODEL_KEY}
      title={t('Помощник: опиши, что рутина должна делать')}
      placeholder={t('Например: через Slack в Claude каждые 30 минут смотри канал #mr-review; если у меня просят ревью — запусти ревью MR')}
      intro={t('Помощник сам найдёт или подключит источник, проверит, что он отдаёт нужное, подберёт или соберёт flow, заполнит форму ниже и проверит правило на последних записях. Каждый его шаг и стоимость видны в ленте. Рутину он не включает — это делаешь ты.')}
      chatId={chatId}
      onChatId={onChatId}
      appliedRev={appliedRev}
      onResult={onDraft}
      onAct={onAct}
      extra={() => {
        const spec = form();
        return spec ? { form: spec } : undefined;
      }}
      footer={(v) => {
        const needs = v.result?.needs;
        if (!needs?.source && !needs?.flow) return null;
        return (
          <>
            {needs.source && (
              <div className={styles.need}>
                <span>
                  <b>{t('Этот источник подключаешь ты.')}</b> {t('Подключи: {what}', { what: needs.source.description })}
                </span>
                <div>
                  <Link className="btn small" to={connectNeedHref(needs.source)} onClick={onConnect}>
                    {t('Подключить сервис')}
                  </Link>{' '}
                  <span className={styles.saved}>{t('Черновик сохранён на сервере и вернётся после подключения.')}</span>
                </div>
              </div>
            )}
            {needs.flow && (
              <div className={styles.need}>
                <span>
                  <b>{t('Подходящего flow нет.')}</b> {t('Попроси помощника собрать его или выбери готовый ниже: {what}', { what: needs.flow })}
                </span>
              </div>
            )}
          </>
        );
      }}
    />
  );
}
