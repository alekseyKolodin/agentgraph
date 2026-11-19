// Вкладка «Правка» экрана flow: схема (граф, поля этапов, правка с ИИ — Builder) или текст YAML. Вид переключается
// сегментом; в YAML нет несохранённых правок схемы — переход туда с ними спрашивает.
import { useConfirm } from '../../components/ConfirmDialog';
import { t } from '../../lib/i18n';
import { Builder } from './Builder';
import { flowState, set, useFlowStore, type EditView } from './store';
import { YamlView } from './YamlView';
import styles from './Flow.module.css';

const VIEWS: readonly (readonly [EditView, string])[] = [['scheme', 'Схема'], ['yaml', 'YAML']];

export function EditTab({ hidden }: { hidden: boolean }) {
  const st = useFlowStore();
  const { askConfirm } = useConfirm();
  const pick = async (view: EditView) => {
    if (view === flowState.editView) return;
    if (view === 'yaml' && flowState.dirty && !(await askConfirm(t('В схеме есть несохранённые изменения, в YAML их не будет. Перейти?'), { ok: t('Перейти') }))) return;
    set({ editView: view });
  };
  return (
    <section hidden={hidden} className={styles.editTab}>
      <div className={styles.editViews} role="group" aria-label={t('Вид')}>
        {VIEWS.map(([id, label]) => (
          <button key={id} type="button" className={st.editView === id ? styles.on : undefined} aria-pressed={st.editView === id} onClick={() => void pick(id)}>{t(label)}</button>
        ))}
      </div>
      <Builder hidden={st.editView !== 'scheme'} />
      <YamlView hidden={st.editView !== 'yaml'} />
    </section>
  );
}
